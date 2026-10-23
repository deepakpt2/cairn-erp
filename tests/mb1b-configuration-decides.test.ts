import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { withTenant } from '../src/platform/db/client';
import { defineRange } from '../src/platform/numbering';
import {
  TransferPostingError,
  postTransfer,
  reverseTransfer,
  validateTransfer,
  type PostTransferInput,
} from '../src/modules/inventory/transfer-posting';
import { createTenant, defineTestRanges, destroyTenant } from './helpers';

/**
 * SCR-146 — the movement catalogue decides, and the service obeys it.
 *
 * Every test here changes a row of `movement_type` and then asks the posting service for its
 * answer. If a rule still lived in TypeScript, changing the row would change nothing and the test
 * would fail; that is the point. The numbers 311/301/321 appear as input aliases and nothing else.
 *
 * The other half of §16 is here too: a reused request key wearing a different payload is refused,
 * and `validateTransfer` answers without posting a single row.
 */
describe('SCR-146 movement configuration decides the transfer', () => {
  const ACTOR = 'SCR146_CONFIG_TEST';
  const DAY = '2026-10-15';
  const VALUATION_CLASS = 'RAW_INVENTORY';
  let client = '';
  let tenant: Awaited<ReturnType<typeof createTenant>>;
  let key = 0;

  const nextKey = () => `scr146-${++key}`;

  const transfer = (overrides: Partial<PostTransferInput>): PostTransferInput => ({
    client,
    changedBy: ACTOR,
    movementTypeCode: '311',
    materialNumber: 'MAT-CFG',
    quantity: 10,
    issuingPlant: '1000',
    issuingStorageLocation: '0001',
    receivingPlant: '1000',
    receivingStorageLocation: '0002',
    postingDate: DAY,
    documentDate: DAY,
    requestKey: nextKey(),
    ...overrides,
  });

  async function countDocuments(): Promise<number> {
    return withTenant(client, async (tx) => {
      const rows = await tx.execute(sql`
        select count(*)::int as n from material_document where client = ${client}
      `) as unknown as Array<{ n: number }>;
      return Number(rows[0].n);
    });
  }

  async function countJournals(): Promise<number> {
    return withTenant(client, async (tx) => {
      const rows = await tx.execute(sql`
        select count(*)::int as n from journal_entry where client = ${client}
      `) as unknown as Array<{ n: number }>;
      return Number(rows[0].n);
    });
  }

  async function stock(plant: string, location: string, type = 'UNRESTRICTED'): Promise<number> {
    return withTenant(client, async (tx) => {
      const rows = await tx.execute(sql`
        select quantity from stock_quantity
        where client = ${client} and material_number = 'MAT-CFG' and plant = ${plant}
          and storage_location = ${location} and stock_type = ${type}
      `) as unknown as Array<{ quantity: string }>;
      return rows[0] ? Number(rows[0].quantity) : 0;
    });
  }

  /** Change one rule on one movement, the way a tenant would through configuration. */
  async function configure(movementType: string, patch: Record<string, unknown>): Promise<void> {
    // One statement, so the row never rests in a half-changed state the checks would refuse.
    const assignments = Object.entries(patch).map(([column, value]) => sql`${sql.raw(column)} = ${value}`);
    await withTenant(client, async (tx) => {
      await tx.execute(sql`
        update movement_type set ${sql.join(assignments, sql`, `)}
        where client = ${client} and movement_type = ${movementType}
      `);
    });
  }

  /** Ask for a refusal and hand back its words, failing loudly when the call succeeds. */
  async function refusal(action: () => Promise<unknown>): Promise<string> {
    try {
      await action();
    } catch (caught) {
      expect(caught).toBeInstanceOf(TransferPostingError);
      return (caught as TransferPostingError).message;
    }
    throw new Error('expected a refusal, and the call succeeded');
  }

  beforeAll(async () => {
    tenant = await createTenant('scr146-mb1b-rules');
    client = tenant.client;
    await defineTestRanges(tenant, { fiscalYear: 2026 });
    await withTenant(client, async (tx) => {
      await defineRange(tx, {
        client, objectCode: 'MATDOC', subObject: '*', prefix: '', numberLength: 10, createdBy: ACTOR,
      });
      await tx.execute(sql`
        insert into plant (client, plant, name, company_code, country, created_by) values
          (${client}, '2000', 'Plant Two', '1000', 'KW', ${ACTOR})
        on conflict do nothing
      `);
      await tx.execute(sql`
        insert into storage_location (client, plant, storage_location, name, allow_negative_stock, is_active, created_by) values
          (${client}, '1000', '0001', 'Main store', false, true, ${ACTOR}),
          (${client}, '1000', '0002', 'Second store', false, true, ${ACTOR}),
          (${client}, '2000', '0001', 'Plant two store', false, true, ${ACTOR})
        on conflict (client, plant, storage_location) do update set
          allow_negative_stock = excluded.allow_negative_stock, is_active = excluded.is_active
      `);
      await tx.execute(sql`
        insert into material (client, material_number, description, material_type, base_unit, created_by)
        select ${client}, 'MAT-CFG', 'Configuration material', 'RAW', 'PC', ${ACTOR}
        on conflict do nothing
      `);
      await tx.execute(sql`
        insert into material_plant (client, material_number, plant, created_by) values
          (${client}, 'MAT-CFG', '1000', ${ACTOR}), (${client}, 'MAT-CFG', '2000', ${ACTOR})
        on conflict do nothing
      `);
      await tx.execute(sql`
        insert into material_valuation (client, material_number, valuation_area, valuation_class, price_control,
                                        standard_price, moving_average_price, price_unit, currency,
                                        total_stock_quantity, stock_value, created_by) values
          (${client}, 'MAT-CFG', '1000', ${VALUATION_CLASS}, 'MOVING_AVERAGE', 0, 10, 1, ${tenant.currency}, 100, 1000, ${ACTOR}),
          (${client}, 'MAT-CFG', '2000', ${VALUATION_CLASS}, 'STANDARD', 20, 0, 1, ${tenant.currency}, 0, 0, ${ACTOR})
        on conflict do nothing
      `);
      await tx.execute(sql`
        insert into account_determination (client, chart_of_accounts, event, valuation_class, general_modifier, gl_account, created_by) values
          (${client}, 'CA01', 'INVENTORY', ${VALUATION_CLASS}, '', '120000', ${ACTOR}),
          (${client}, 'CA01', 'PRICE_DIFFERENCE', ${VALUATION_CLASS}, '', '300000', ${ACTOR})
        on conflict do nothing
      `);
      await tx.execute(sql`
        insert into material_period_control (client, company_code, current_fiscal_year, current_period,
                                             previous_fiscal_year, previous_period, allow_backposting, created_by)
        values (${client}, '1000', 2026, 10, 2026, 9, true, ${ACTOR})
        on conflict (client, company_code) do update set
          current_fiscal_year = 2026, current_period = 10,
          previous_fiscal_year = 2026, previous_period = 9, allow_backposting = true
      `);
      await tx.execute(sql`
        insert into stock_quantity (client, material_number, plant, storage_location, stock_type, quantity, created_by) values
          (${client}, 'MAT-CFG', '1000', '0001', 'UNRESTRICTED', 100, ${ACTOR}),
          (${client}, 'MAT-CFG', '1000', '0001', 'QUALITY', 40, ${ACTOR}),
          (${client}, 'MAT-CFG', '1000', '0002', 'UNRESTRICTED', 0, ${ACTOR})
        on conflict do nothing
      `);
    });

    // The catalogue is seeded by the posting itself; one dry run lays the six rows down.
    await validateTransfer({ ...transfer({}), movementTypeCode: '311' });
  });

  afterAll(async () => {
    await destroyTenant(client);
  });

  it('reads the permitted dimensions from the row, not from the movement number', async () => {
    // 311 is delivered as a move inside one plant. Configuration is changed to say otherwise —
    // and the service follows the table, which no hardcoded rule could do.
    await configure('TRANSFER_SLOC', { plant_rule: 'DIFFERENT', location_rule: 'ANY' });
    try {
      const heldBefore = await stock('2000', '0001');
      const posted = await postTransfer(transfer({
        movementTypeCode: '311',
        issuingPlant: '1000', issuingStorageLocation: '0001',
        receivingPlant: '2000', receivingStorageLocation: '0001',
        quantity: 5,
      }));
      expect(posted.lines[0].plant).toBe('1000');
      expect(posted.lines[1].plant).toBe('2000');

      // With DIFFERENT configured, the same-plant move is now the one refused — by name.
      const words = await refusal(() => postTransfer(transfer({ movementTypeCode: '311', quantity: 5 })));
      expect(words).toMatch(/moves between plants, and the configuration says so/);
    } finally {
      await configure('TRANSFER_SLOC', { plant_rule: 'SAME', location_rule: 'DIFFERENT' });
    }
  });

  it('refuses a two-step movement by name and posts nothing', async () => {
    const before = await countDocuments();
    for (const code of ['303', '313', '315']) {
      const words = await refusal(() => postTransfer(transfer({ movementTypeCode: code })));
      expect(words).toMatch(/two-step transfer/);
    }
    expect(await countDocuments(), 'no document was posted by a refused two-step').toBe(before);

    // The same refusal stands when the *row* says two-step, whatever the number. A two-step
    // movement cannot claim a one-step kind — the database says so — so both columns move.
    await configure('TRANSFER_SLOC', { movement_kind: 'TWO_STEP', is_two_step: true });
    try {
      const words = await refusal(() => postTransfer(transfer({ movementTypeCode: '311' })));
      expect(words).toMatch(/configured as a two-step transfer/);
    } finally {
      await configure('TRANSFER_SLOC', { movement_kind: 'STORAGE_LOCATION', is_two_step: false });
    }
  });

  it('refuses a requirement canon has no master for, naming the master', async () => {
    await configure('TRANSFER_SLOC', { requires_batch: true });
    try {
      const words = await refusal(() => postTransfer(transfer({ movementTypeCode: '311' })));
      expect(words).toMatch(/requires a batch/);
      expect(words).not.toMatch(/no batch master/);
    } finally {
      await configure('TRANSFER_SLOC', { requires_batch: false });
    }
    // Once the requirement is cleared the same request posts — the refusal came from the row.
    const posted = await postTransfer(transfer({ movementTypeCode: '311', quantity: 3 }));
    expect(posted.status).toBe('POSTED');
  });

  it('posts a journal only where the configuration says value moves', async () => {
    // 301 is delivered valuation-relevant, and the receiving plant is standard-priced at a
    // different rate, so a journal is expected — the fixture is the control.
    const before = await countJournals();
    const withValue = await postTransfer(transfer({
      movementTypeCode: '301', issuingPlant: '1000', receivingPlant: '2000',
      issuingStorageLocation: '0001', receivingStorageLocation: '0001', quantity: 2,
    }));
    expect(withValue.journalDocumentNumber, 'the configured plant transfer journals').toBeTruthy();
    expect(await countJournals()).toBe(before + 1);

    // Turn valuation off on the row. The same movement, the same prices, no journal.
    await configure('TRANSFER_PLANT', { valuation_relevant: false });
    try {
      const flat = await postTransfer(transfer({
        movementTypeCode: '301', issuingPlant: '1000', receivingPlant: '2000',
        issuingStorageLocation: '0001', receivingStorageLocation: '0001', quantity: 2,
      }));
      expect(flat.journalDocumentNumber, 'a movement configured as not valuation-relevant journals nothing').toBeNull();
      // The document still describes what moved — but the valuation area is untouched.
      const moved = await withTenant(client, async (tx) => {
        const rows = await tx.execute(sql`
          select total_stock_quantity from material_valuation
          where client = ${client} and material_number = 'MAT-CFG' and valuation_area = '2000'
        `) as unknown as Array<{ total_stock_quantity: string }>;
        return Number(rows[0].total_stock_quantity);
      });
      expect(moved, 'the receiving valuation area did not move').toBe(2);
      expect(await countJournals()).toBe(before + 1);
    } finally {
      await configure('TRANSFER_PLANT', { valuation_relevant: true });
    }
  });

  it('refuses a reused request key whose payload differs, and replays an identical one', async () => {
    const requestKey = nextKey();
    const first = await postTransfer(transfer({ requestKey, quantity: 4 }));
    const before = await countDocuments();

    const words = await refusal(() => postTransfer(transfer({ requestKey, quantity: 9 })));
    expect(words).toMatch(/already posted .* and this is a different posting/);
    expect(await countDocuments(), 'the second posting never happened').toBe(before);

    const replayed = await postTransfer(transfer({ requestKey, quantity: 4 }));
    expect(replayed.materialDocumentNumber).toBe(first.materialDocumentNumber);
  });

  it('keeps the external reference with the document', async () => {
    const posted = await postTransfer(transfer({
      movementTypeCode: '311', quantity: 1, externalReference: 'TO-4471',
    }));
    expect(posted.externalReference).toBe('TO-4471');
  });

  it('reverses a valueless transfer without moving any value', async () => {
    // 311 configured as DIFFERENT carries stock between plants but no value (its row is not
    // valuation-relevant). The reversal must not decide otherwise because the plants differ —
    // that was the defect the browser run found.
    await configure('TRANSFER_SLOC', { plant_rule: 'DIFFERENT', location_rule: 'ANY' });
    try {
      const heldBefore = await stock('2000', '0001');
      const posted = await postTransfer(transfer({
        movementTypeCode: '311',
        issuingPlant: '1000', issuingStorageLocation: '0001',
        receivingPlant: '2000', receivingStorageLocation: '0001',
        quantity: 7,
      }));
      expect(Number(posted.lines[0].value)).toBe(0);
      const before = await withTenant(client, async (tx) => {
        const rows = await tx.execute(sql`
          select valuation_area, total_stock_quantity, stock_value from material_valuation
          where client = ${client} and material_number = 'MAT-CFG' order by valuation_area
        `) as unknown as Array<{ valuation_area: string; total_stock_quantity: string; stock_value: string }>;
        return rows.map((r) => `${r.valuation_area}:${r.total_stock_quantity}:${r.stock_value}`).join('|');
      });

      const reversal = await reverseTransfer({
        client, changedBy: ACTOR, materialDocumentNumber: posted.materialDocumentNumber,
        postingDate: DAY, documentDate: DAY, requestKey: nextKey(),
      });
      expect(reversal.reversalOf).toBe(posted.materialDocumentNumber);

      const after = await withTenant(client, async (tx) => {
        const rows = await tx.execute(sql`
          select valuation_area, total_stock_quantity, stock_value from material_valuation
          where client = ${client} and material_number = 'MAT-CFG' order by valuation_area
        `) as unknown as Array<{ valuation_area: string; total_stock_quantity: string; stock_value: string }>;
        return rows.map((r) => `${r.valuation_area}:${r.total_stock_quantity}:${r.stock_value}`).join('|');
      });
      expect(after, 'a valueless transfer reverses without touching a valuation area').toBe(before);
      expect(await stock('2000', '0001'), 'and the stock came back').toBe(heldBefore);
    } finally {
      await configure('TRANSFER_SLOC', { plant_rule: 'SAME', location_rule: 'DIFFERENT' });
    }
  });

  it('validates without posting, and refuses exactly what a posting would refuse', async () => {
    const documents = await countDocuments();
    const journals = await countJournals();
    const held = await stock('1000', '0001');

    const answer = await validateTransfer({
      ...transfer({ movementTypeCode: '321', quantity: 6 }),
      issuingStorageLocation: '0001', receivingStorageLocation: '0001',
      movementTypeCode: '321',
    });
    expect(answer.accepted).toBe(true);
    expect(answer.base).toEqual({ quantity: 6, unit: 'PC' });
    expect(answer.from.stockType).toBe('QUALITY');
    expect(answer.to.stockType).toBe('UNRESTRICTED');
    expect(answer.stock.onHand).toBe(40);
    expect(answer.stock.after).toBe(34);
    expect(answer.value.moves, 'a stock-type move changes no value').toBe(false);
    expect(answer.notes.join(' ')).toMatch(/No valuation change/);

    const posts = await countDocuments();
    const journalsAfter = await countJournals();
    const stockAfter = await stock('1000', '0001');
    expect(posts, 'validation posted nothing').toBe(documents);
    expect(journalsAfter).toBe(journals);
    expect(stockAfter, 'validation moved nothing').toBe(held);

    // A dry run raises the same words a posting would, from the same preflight.
    const words = await refusal(() => validateTransfer({
      ...transfer({ movementTypeCode: '311', quantity: 100_000 }),
    }));
    expect(words).toMatch(/short of the 100000\.000 to move/);
  });
});
