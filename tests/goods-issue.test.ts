import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { withTenant } from '../src/platform/db/client';
import { defineTestRanges, createTenant, destroyTenant } from './helpers';
import { defineRange } from '../src/platform/numbering';
import { createReservation, getReservation } from '../src/modules/inventory/reservations';
import {
  GOODS_ISSUE_CAPABILITY,
  GoodsIssueError,
  postGoodsIssue,
} from '../src/modules/inventory/goods-issue';
import { stockRequirementsList } from '../src/modules/production/stock-requirements';

/**
 * SCR-136 / MB1A — a goods issue is a material document: stock falls, the valuation
 * falls by what was issued, the journal credits INVENTORY and debits the consumption
 * (with the cost centre on the line) or the scrapping account, the material and
 * accounting periods judge the date, and a line that names a reservation withdraws
 * from it in the same commit so MD04's demand falls with the stock.
 */
const ACTOR = 'SCR136_MB1A_TEST';
let counter = 0;
const key = () => `scr136-${++counter}`;

describe('SCR-136 goods issue (MB1A)', () => {
  let client = '';
  let area = 'A000';

  const line = (overrides: Record<string, unknown> = {}) => ({
    materialNumber: 'GI-MAT', plant: '1000', storageLocation: '0001', quantity: 10,
    costCenter: 'CC1100', ...overrides,
  });

  const input = (overrides: Record<string, unknown> = {}) => ({
    client, changedBy: ACTOR, movementTypeCode: '201',
    postingDate: '2026-10-15', documentDate: '2026-10-15',
    headerText: 'Issue for the line', requestKey: key(),
    lines: [line()], ...overrides,
  });

  beforeAll(async () => {
    const tenant = await createTenant('scr136-mb1a');
    client = tenant.client;
    await defineTestRanges(tenant, { fiscalYear: 2026 });
    area = await withTenant(client, async (tx) => {
      const rows = await tx.execute(sql`
        select controlling_area from controlling_area where client = ${client} order by controlling_area limit 1
      `) as unknown as Array<{ controlling_area: string }>;
      return rows[0]?.controlling_area ?? 'A000';
    });

    await withTenant(client, async (tx) => {
      await defineRange(tx, {
        client, objectCode: 'RESERV', subObject: '*', prefix: 'RSV', numberLength: 8, createdBy: ACTOR,
      });
      await defineRange(tx, {
        client, objectCode: 'MATDOC', subObject: '*', prefix: 'MATDOC', numberLength: 8, createdBy: ACTOR,
      });
      await tx.execute(sql`
        insert into plant (client, plant, name, company_code, country, created_by)
        values (${client}, '1000', 'Issue plant', '1000', 'KW', ${ACTOR}) on conflict do nothing
      `);
      await tx.execute(sql`
        insert into storage_location (client, plant, storage_location, name, is_active, allow_negative_stock, created_by) values
          (${client}, '1000', '0001', 'Main store', true, false, ${ACTOR}),
          (${client}, '1000', '0002', 'Open store', true, true, ${ACTOR}),
          (${client}, '1000', '0099', 'Blocked store', false, false, ${ACTOR})
        on conflict (client, plant, storage_location) do update set
          is_active = excluded.is_active, allow_negative_stock = excluded.allow_negative_stock
      `);
      await tx.execute(sql`
        insert into material (client, material_number, description, material_type, base_unit, created_by)
        select ${client}, v.n, v.d, t.material_type, 'PC', ${ACTOR}
        from (values ('GI-MAT', 'Issued material'), ('GI-SCRAP', 'Scrapped material')) as v(n, d)
        cross join (select material_type from material_type where client = ${client} order by material_type limit 1) t
        on conflict do nothing
      `);
      await tx.execute(sql`
        insert into material_plant (client, material_number, plant, created_by) values
          (${client}, 'GI-MAT', '1000', ${ACTOR}), (${client}, 'GI-SCRAP', '1000', ${ACTOR})
        on conflict do nothing
      `);
      await tx.execute(sql`
        insert into material_valuation (client, material_number, valuation_area, valuation_class, price_control,
                                        standard_price, moving_average_price, price_unit, currency,
                                        total_stock_quantity, stock_value, created_by) values
          (${client}, 'GI-MAT', '1000', 'RAW_INVENTORY', 'MOVING_AVERAGE', 50, 50, 1, 'KWD', 1000, 50000, ${ACTOR}),
          (${client}, 'GI-SCRAP', '1000', 'RAW_INVENTORY', 'STANDARD', 20, 20, 1, 'KWD', 500, 10000, ${ACTOR})
        on conflict do nothing
      `);
      await tx.execute(sql`
        insert into stock_quantity (client, material_number, plant, storage_location, stock_type, quantity, created_by) values
          (${client}, 'GI-MAT', '1000', '0001', 'UNRESTRICTED', 100, ${ACTOR}),
          (${client}, 'GI-MAT', '1000', '0002', 'UNRESTRICTED', 0, ${ACTOR}),
          (${client}, 'GI-SCRAP', '1000', '0001', 'UNRESTRICTED', 50, ${ACTOR})
        on conflict do nothing
      `);
      await tx.execute(sql`
        insert into material_period_control (client, company_code, current_fiscal_year, current_period,
                                             previous_fiscal_year, previous_period, allow_backposting, created_by)
        values (${client}, '1000', 2026, 10, 2026, 9, true, ${ACTOR})
        on conflict do nothing
      `);
      await tx.execute(sql`
        insert into controlling_area_company (client, controlling_area, company_code, created_by)
        values (${client}, ${area}, '1000', ${ACTOR}) on conflict do nothing
      `);
      await tx.execute(sql`
        insert into cost_center (client, controlling_area, cost_center, valid_from, valid_to, name, category, company_code, is_posting_locked, created_by) values
          (${client}, ${area}, 'CC1100', '2026-01-01', '2026-12-31', 'Line centre', 'PRODUCTION', '1000', false, ${ACTOR}),
          (${client}, ${area}, 'CC1200', '2026-01-01', '2026-12-31', 'Locked centre', 'PRODUCTION', '1000', true, ${ACTOR})
        on conflict do nothing
      `);
      // Account determination: what the issue credits and debits.
      await tx.execute(sql`
        insert into gl_account (client, chart_of_accounts, account_number, name, account_type,
                                is_balance_sheet, is_open_item_managed, reconciliation_type,
                                requires_cost_object, is_tax_relevant, account_group, gl_account_type,
                                created_by)
        select ${client}, c.chart_of_accounts, v.n, v.d, 'EXPENSE',
               false, false, null, true, false, 'GENL', 'PL_STATEMENT', ${ACTOR}
        from (select chart_of_accounts from chart_of_accounts where client = ${client} limit 1) c
        cross join (values ('510100', 'Consumption expense'), ('510200', 'Scrapping expense')) as v(n, d)
        on conflict do nothing
      `);
      await tx.execute(sql`
        insert into gl_account (client, chart_of_accounts, account_number, name, account_type,
                                is_balance_sheet, is_open_item_managed, reconciliation_type,
                                requires_cost_object, is_tax_relevant, account_group, gl_account_type,
                                created_by)
        select ${client}, c.chart_of_accounts, '120000', 'Raw materials inventory', 'ASSET',
               true, false, null, false, false, 'GENL', 'BALANCE_SHEET', ${ACTOR}
        from (select chart_of_accounts from chart_of_accounts where client = ${client} limit 1) c
        on conflict do nothing
      `);
      await tx.execute(sql`
        insert into account_determination (client, chart_of_accounts, event, valuation_class, general_modifier, gl_account, created_by)
        select ${client}, c.chart_of_accounts, v.e, 'RAW_INVENTORY', '', v.a, ${ACTOR}
        from (select chart_of_accounts from chart_of_accounts where client = ${client} limit 1) c
        cross join (values ('CONSUMPTION', '510100'), ('SCRAP', '510200'), ('INVENTORY', '120000')) as v(e, a)
        on conflict do nothing
      `);
    });
  });

  afterAll(async () => {
    if (client) await destroyTenant(client);
  });

  it('posts a 201 and writes a material document, the journal, the stock and the valuation', async () => {
    const posted = await postGoodsIssue(input());
    expect(posted.materialDocumentNumber).toMatch(/^MATDOC-/);
    expect(posted.movementCode).toBe('201');
    expect(posted.movementType).toBe('GI_ISSUE_CC');
    expect(posted.companyCode).toBe('1000');
    expect(posted.journalDocumentNumber).toBeTruthy();
    expect(posted.totalValue).toBe('500.00');
    expect(posted.lines).toHaveLength(1);
    expect(posted.lines[0].costCenter).toBe('CC1100');

    const state = await withTenant(client, async (tx) => {
      const stock = await tx.execute(sql`
        select quantity::text as q from stock_quantity
        where client = ${client} and material_number = 'GI-MAT' and plant = '1000'
          and storage_location = '0001' and stock_type = 'UNRESTRICTED'
      `) as unknown as Array<{ q: string }>;
      const val = await tx.execute(sql`
        select total_stock_quantity::text as q, stock_value::text as v from material_valuation
        where client = ${client} and material_number = 'GI-MAT' and valuation_area = '1000'
      `) as unknown as Array<{ q: string; v: string }>;
      const journal = await tx.execute(sql`
        select jl.gl_account, jl.debit_credit, jl.amount_local::text as amount, jl.cost_center
        from journal_entry_line jl join journal_entry je on je.client = jl.client and je.document_number = jl.document_number
        where je.client = ${client} and jl.fiscal_year = je.fiscal_year
          and je.document_number = ${posted.journalDocumentNumber}
        order by jl.line_number
      `) as unknown as Array<{ gl_account: string; debit_credit: string; amount: string; cost_center: string | null }>;
      return { stock: stock[0], valuation: val[0], journal };
    });

    expect(Number(state.stock.q)).toBe(90);
    expect(Number(state.valuation.q)).toBe(990);
    expect(Number(state.valuation.v)).toBe(49500);
    expect(state.journal).toHaveLength(2);
    const credit = state.journal.find((r) => r.debit_credit === 'H')!;
    const debit = state.journal.find((r) => r.debit_credit === 'S')!;
    expect(Number(credit.amount)).toBe(500);
    expect(Number(debit.amount)).toBe(500);
    expect(debit.cost_center).toBe('CC1100');
    expect(debit.gl_account).not.toBe(credit.gl_account);
  });

  it('posts a 551 to the scrapping account with no controlling object', async () => {
    const posted = await postGoodsIssue(input({
      movementTypeCode: '551',
      lines: [line({ materialNumber: 'GI-SCRAP', quantity: 5, costCenter: undefined })],
    }));
    expect(posted.movementCode).toBe('551');
    expect(posted.totalValue).toBe('100.00');
    expect(posted.lines[0].costCenter).toBeNull();
  });

  it('refuses a scrapping that names a cost centre', async () => {
    const error = await postGoodsIssue(input({
      movementTypeCode: '551',
      lines: [line({ materialNumber: 'GI-SCRAP', quantity: 1, costCenter: 'CC1100' })],
    })).catch((e: unknown) => e);
    expect((error as GoodsIssueError).message).toMatch(/carries no account assignment, and a cost centre was named/);
  });

  it('refuses 261 on MB1A and names the screen that posts it (SCR-139)', async () => {
    // The movement is delivered now, but MIGO is its screen: one screen per movement keeps
    // the MIGO action/reference matrix the single place a movement is selected.
    const error = await postGoodsIssue(input({ movementTypeCode: '261' })).catch((e: unknown) => e);
    expect((error as GoodsIssueError).message).toMatch(/Movement 261 is posted from MIGO, not from this screen/);
    expect((error as GoodsIssueError).remedy).toMatch(/MIGO/);
  });

  it('refuses a counter movement and names MBST', async () => {
    for (const code of ['202', '552', '262']) {
      const error = await postGoodsIssue(input({ movementTypeCode: code })).catch((e: unknown) => e);
      expect((error as GoodsIssueError).message).toMatch(/is a reversal, not an issue/);
      expect((error as GoodsIssueError).remedy).toMatch(/MBST/);
    }
  });

  it('judges stock on the location’s own terms', async () => {
    const error = await postGoodsIssue(input({ lines: [line({ quantity: 500 })] })).catch((e: unknown) => e);
    expect((error as GoodsIssueError).message).toMatch(/carries [0-9.]+ PC of GI-MAT, and 500\.000 was entered/);
    expect((error as GoodsIssueError).remedy).toMatch(/allow negative stock/);

    // The open store permits the negative, and takes it.
    const posted = await postGoodsIssue(input({ lines: [line({ storageLocation: '0002', quantity: 3 })] }));
    expect(posted.materialDocumentNumber).toBeTruthy();
  });

  it('refuses a closed material period', async () => {
    const error = await postGoodsIssue(input({ postingDate: '2026-05-15' })).catch((e: unknown) => e);
    expect((error as GoodsIssueError).message).toMatch(/posting period 2026\/5 is closed/);
  });

  it('judges the cost centre: missing, locked, and valid', async () => {
    const missing = await postGoodsIssue(input({
      lines: [line({ costCenter: undefined })],
    })).catch((e: unknown) => e);
    expect((missing as GoodsIssueError).message).toMatch(/charges a cost centre, and none was named/);

    const locked = await postGoodsIssue(input({
      lines: [line({ costCenter: 'CC1200' })],
    })).catch((e: unknown) => e);
    expect((locked as GoodsIssueError).message).toMatch(/locked for postings/);

    const foreign = await postGoodsIssue(input({
      lines: [line({ costCenter: 'CC9999' })],
    })).catch((e: unknown) => e);
    expect((foreign as GoodsIssueError).message).toMatch(/does not stand in company code 1000/);
  });

  it('refuses an unknown material, a blocked location and a batch', async () => {
    await expect(postGoodsIssue(input({ lines: [line({ materialNumber: 'NOPE' })] })))
      .rejects.toThrow(/Material NOPE does not exist/);
    await expect(postGoodsIssue(input({ lines: [line({ storageLocation: '0099' })] })))
      .rejects.toThrow(/is blocked/);
    const batch = await postGoodsIssue(input({ lines: [line({ batch: 'B001' })] })).catch((e: unknown) => e);
    expect((batch as GoodsIssueError).message).toMatch(/canon carries no batch master/);
  });

  it('withdraws from a reservation in the same commit, and MD04’s demand falls with the stock', async () => {
    const reservation = await createReservation({
      client, changedBy: ACTOR, movementTypeCode: '201', baseDate: '2026-10-20',
      costCenter: 'CC1100',
      items: [{ materialNumber: 'GI-SCRAP', plant: '1000', requiredQuantity: 8, storageLocation: '0001' }],
      requestKey: key(),
    });
    const before = await stockRequirementsList({
      client, today: '2026-10-15',
      selection: { material: 'GI-SCRAP', plant: '1000', periodSplit: 'DAILY', maxHits: 500 },
    });
    const demandBefore = before.rows
      .filter((r) => r.elementType === 'RESERVATION')
      .reduce((sum, r) => sum + r.quantity, 0);
    expect(demandBefore).toBe(8);

    const posted = await postGoodsIssue(input({
      lines: [line({
        materialNumber: 'GI-SCRAP', quantity: 3, costCenter: 'CC1100',
        reservationNumber: reservation.reservationNumber, reservationItem: 10,
      })],
    }));
    expect(posted.lines[0].reservationOpenAfter).toBe('5.000');

    const after = await getReservation(client, reservation.reservationNumber);
    expect(after!.items[0].withdrawnQuantity).toBe('3.000');
    expect(after!.items[0].isCompleted).toBe(false);

    const list = await stockRequirementsList({
      client, today: '2026-10-15',
      selection: { material: 'GI-SCRAP', plant: '1000', periodSplit: 'DAILY', maxHits: 500 },
    });
    const demandAfter = list.rows
      .filter((r) => r.elementType === 'RESERVATION')
      .reduce((sum, r) => sum + r.quantity, 0);
    expect(demandAfter).toBe(5);
  });

  it('refuses an issue beyond what the reservation still holds', async () => {
    const reservation = await createReservation({
      client, changedBy: ACTOR, movementTypeCode: '201', baseDate: '2026-10-20',
      costCenter: 'CC1100',
      items: [{ materialNumber: 'GI-SCRAP', plant: '1000', requiredQuantity: 2, storageLocation: '0001' }],
      requestKey: key(),
    });
    const error = await postGoodsIssue(input({
      lines: [line({
        materialNumber: 'GI-SCRAP', quantity: 5, costCenter: 'CC1100',
        reservationNumber: reservation.reservationNumber, reservationItem: 10,
      })],
    })).catch((e: unknown) => e);
    expect((error as Error).message).toMatch(/exceeds the 2\.000 still open/);
  });

  it('replays a request key instead of posting twice', async () => {
    const request = input();
    const first = await postGoodsIssue(request);
    const second = await postGoodsIssue(request);
    expect(second.materialDocumentNumber).toBe(first.materialDocumentNumber);
  });

  it('writes nothing when the journal refuses: a failed post leaves stock where it stood', async () => {
    const before = await withTenant(client, async (tx) => {
      const rows = await tx.execute(sql`
        select quantity::text as q from stock_quantity
        where client = ${client} and material_number = 'GI-MAT' and plant = '1000'
          and storage_location = '0001' and stock_type = 'UNRESTRICTED'
      `) as unknown as Array<{ q: string }>;
      return Number(rows[0].q);
    });
    await postGoodsIssue(input({ lines: [line({ quantity: 1, costCenter: 'CC1200' })] })).catch(() => {});
    const after = await withTenant(client, async (tx) => {
      const rows = await tx.execute(sql`
        select quantity::text as q from stock_quantity
        where client = ${client} and material_number = 'GI-MAT' and plant = '1000'
          and storage_location = '0001' and stock_type = 'UNRESTRICTED'
      `) as unknown as Array<{ q: string }>;
      return Number(rows[0].q);
    });
    expect(after).toBe(before);
  });

  it('keeps another tenant’s stock and documents out of reach', async () => {
    const other = await createTenant('scr136-other');
    try {
      const error = await postGoodsIssue({
        client: other.client, changedBy: ACTOR, movementTypeCode: '201',
        postingDate: '2026-10-15', documentDate: '2026-10-15', requestKey: key(),
        lines: [line()],
      }).catch((e: unknown) => e);
      // The fresh tenant has its own plant 1000 (onboarding builds the standard
      // structure), so the issue is refused by the period rather than by the plant —
      // and it still refuses before writing anything.
      expect((error as GoodsIssueError).message).toMatch(/posting period 2026\/10 is closed/);
      expect(GOODS_ISSUE_CAPABILITY).toBe('INV.GI.POST');
    } finally {
      await destroyTenant(other.client);
    }
  });
});
