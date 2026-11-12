import { sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const requestContext = vi.hoisted(() => ({ cookie: undefined as string | undefined }));
vi.mock('next/headers', () => ({
  cookies: async () => ({ get: () => requestContext.cookie ? { value: requestContext.cookie } : undefined }),
}));
vi.mock('next/navigation', () => ({
  redirect: (path: string): never => { throw new Error(`REDIRECT:${path}`); },
}));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));

import { withTenant } from '../src/platform/db/client';
import { createTenant, defineTestRanges, destroyTenant } from './helpers';
import { defineRange } from '../src/platform/numbering';
import {
  appUser, authOrgRestriction, capability, role, roleCapability, userRole,
} from '../src/platform/tables/security';
import { createSession } from '../src/platform/auth/session';
import { hashPassword } from '../src/platform/auth/password';
import {
  INITIAL_STOCK_CAPABILITY, InitialStockError, postInitialStock,
} from '../src/modules/inventory/initial-stock';

/**
 * Movement 561 — the initial stock entry.
 *
 * The one goods movement that answers no document. What it must prove is the
 * same thing every goods movement must prove — the material document, the stock
 * balance, the valuation totals and one balanced journal are written together or
 * not at all — plus the one thing only this movement can prove: that stock can
 * be on the shelf on the day the books open, valued at the price the material
 * carries, with retained earnings on the other side and no clearing account
 * anywhere in the posting.
 */
const ACTOR = 'INV561_TEST';
let counter = 0;
const key = () => `inv561-${++counter}`;

describe('movement 561 — initial stock entry', () => {
  let client = '';
  let actorUserId = '';
  let actorSessionId = '';
  let noPlantUserId = '';
  let noPlantSessionId = '';
  let bothCompaniesUserId = '';
  let bothCompaniesSessionId = '';

  const authorization = () => ({ userId: actorUserId, sessionId: actorSessionId });
  const post = (request: Parameters<typeof postInitialStock>[0]) =>
    postInitialStock(request, { authorization: authorization() });

  const input = (overrides: Record<string, unknown> = {}) => ({
    client,
    changedBy: ACTOR,
    postingDate: '2026-10-15',
    documentDate: '2026-10-15',
    headerText: 'Opening stock',
    requestKey: key(),
    lines: [{ materialNumber: 'OPEN-MAP', plant: '1000', storageLocation: '0001', quantity: 10 }],
    ...overrides,
  });

  const snapshot = async () => withTenant(client, async (tx) => {
    const rows = await tx.execute(sql`
      select
        (select count(*)::text from material_document where client = ${client}) as documents,
        (select count(*)::text from material_document_line where client = ${client}) as lines,
        (select count(*)::text from journal_entry where client = ${client}) as journals,
        (select quantity::text from stock_quantity where client = ${client}
          and material_number = 'OPEN-MAP' and plant = '1000' and storage_location = '0001'
          and stock_type = 'UNRESTRICTED' limit 1) as stock,
        (select total_stock_quantity::text from material_valuation where client = ${client}
          and material_number = 'OPEN-MAP' and valuation_area = '1000' limit 1) as valuation_quantity,
        (select stock_value::text from material_valuation where client = ${client}
          and material_number = 'OPEN-MAP' and valuation_area = '1000' limit 1) as valuation_value
    `) as unknown as Array<Record<string, string>>;
    return rows[0];
  });

  beforeAll(async () => {
    const tenant = await createTenant('inv561-initial-stock');
    client = tenant.client;
    await defineTestRanges(tenant, { fiscalYear: 2026 });

    await withTenant(client, async (tx) => {
      await defineRange(tx, {
        client, objectCode: 'MATDOC', subObject: '*', prefix: 'MATDOC', numberLength: 8, createdBy: ACTOR,
      });
      await tx.execute(sql`
        insert into company_code (
          client, company_code, name, chart_of_accounts, fiscal_year_variant,
          posting_period_variant, currency, country, created_by
        )
        select client, 'OPENCO', 'Another company', chart_of_accounts,
               fiscal_year_variant, posting_period_variant, currency, country, ${ACTOR}
          from company_code where client = ${client} and company_code = '1000'
        on conflict do nothing
      `);
      await tx.execute(sql`
        insert into plant (client, plant, name, company_code, country, created_by) values
          (${client}, '1000', 'Opening plant', '1000', 'KW', ${ACTOR}),
          (${client}, 'OPEN-OTHER', 'Same company, out of reach', '1000', 'KW', ${ACTOR}),
          (${client}, 'OPEN-XCO', 'Another company', 'OPENCO', 'KW', ${ACTOR})
        on conflict do nothing
      `);
      await tx.execute(sql`
        insert into storage_location (client, plant, storage_location, name, is_active, created_by) values
          (${client}, '1000', '0001', 'Main store', true, ${ACTOR}),
          (${client}, '1000', '0099', 'Closed store', false, ${ACTOR}),
          (${client}, 'OPEN-XCO', '0001', 'Main store', true, ${ACTOR})
        on conflict do nothing
      `);
      await tx.execute(sql`
        insert into material (client, material_number, description, material_type, base_unit, created_by)
        select ${client}, v.n, v.d, v.t, 'PC', ${ACTOR}
        from (values ('OPEN-MAP', 'Moving-average material', 'RAW'), ('OPEN-STD', 'Standard-priced material', 'FIN')) as v(n, d, t)
        on conflict do nothing
      `);
      await tx.execute(sql`
        insert into material_plant (client, material_number, plant, created_by) values
          (${client}, 'OPEN-MAP', '1000', ${ACTOR}),
          (${client}, 'OPEN-STD', '1000', ${ACTOR}),
          (${client}, 'OPEN-MAP', 'OPEN-XCO', ${ACTOR})
        on conflict do nothing
      `);
      await tx.execute(sql`
        insert into storage_location (client, plant, storage_location, name, is_active, created_by) values
          (${client}, 'OPEN-XCO', '0001', 'Main store', true, ${ACTOR})
        on conflict do nothing
      `);
      await tx.execute(sql`
        insert into material_valuation (client, material_number, valuation_area, valuation_class, price_control,
                                        standard_price, moving_average_price, price_unit, currency,
                                        total_stock_quantity, stock_value, created_by) values
          (${client}, 'OPEN-MAP', '1000', 'RAW_INVENTORY', 'MOVING_AVERAGE', 0, 12, 1, 'KWD', 0, 0, ${ACTOR}),
          (${client}, 'OPEN-STD', '1000', 'FINISHED_INVENTORY', 'STANDARD', 20, 0, 1, 'KWD', 0, 0, ${ACTOR}),
          (${client}, 'OPEN-MAP', 'OPEN-XCO', 'RAW_INVENTORY', 'MOVING_AVERAGE', 0, 12, 1, 'KWD', 0, 0, ${ACTOR})
        on conflict do nothing
      `);
      await tx.execute(sql`
        insert into material_period_control (client, company_code, current_fiscal_year, current_period,
                                             previous_fiscal_year, previous_period, allow_backposting, created_by)
        values (${client}, '1000', 2026, 10, 2026, 9, false, ${ACTOR}),
               (${client}, 'OPENCO', 2026, 10, 2026, 9, false, ${ACTOR})
        on conflict do nothing
      `);
      // The two accounts this movement touches: what the stock is worth, and the
      // equity it arrived with.
      await tx.execute(sql`
        insert into gl_account (client, chart_of_accounts, account_number, name, account_type,
                                is_balance_sheet, is_open_item_managed, reconciliation_type,
                                requires_cost_object, is_tax_relevant, account_group, gl_account_type,
                                created_by)
        select ${client}, c.chart_of_accounts, v.n, v.d, 'ASSET',
               true, false, null, false, false, 'GENL', 'BALANCE_SHEET', ${ACTOR}
        from (select chart_of_accounts from chart_of_accounts where client = ${client} limit 1) c
        cross join (values ('120000', 'Raw materials inventory'), ('120200', 'Finished goods inventory')) as v(n, d)
        on conflict do nothing
      `);
      await tx.execute(sql`
        insert into gl_account (client, chart_of_accounts, account_number, name, account_type,
                                is_balance_sheet, is_open_item_managed, reconciliation_type,
                                requires_cost_object, is_tax_relevant, account_group, gl_account_type,
                                created_by)
        select ${client}, c.chart_of_accounts, '290000', 'Retained earnings', 'EQUITY',
               true, false, null, false, false, 'GENL', 'BALANCE_SHEET', ${ACTOR}
        from (select chart_of_accounts from chart_of_accounts where client = ${client} limit 1) c
        on conflict do nothing
      `);
      await tx.execute(sql`
        insert into account_determination (client, chart_of_accounts, event, valuation_class, general_modifier, gl_account, created_by)
        select ${client}, c.chart_of_accounts, v.e, v.vc, v.m, v.a, ${ACTOR}
        from (select chart_of_accounts from chart_of_accounts where client = ${client} limit 1) c
        cross join (values
          ('INVENTORY', 'RAW_INVENTORY', '', '120000'),
          ('INVENTORY', 'FINISHED_INVENTORY', '', '120200'),
          ('RETAINED_EARNINGS', '', 'X', '290000')
        ) as v(e, vc, m, a)
        on conflict do nothing
      `);
    });

    await withTenant(client, async (tx) => {
      await tx.insert(capability).values({
        code: INITIAL_STOCK_CAPABILITY, module: 'INV',
        description: 'Post an initial stock entry', action: 'CREATE', isPostingRelevant: true,
      }).onConflictDoNothing();
      await tx.insert(role).values({
        client, code: 'TEST_INV561', name: 'Initial stock test',
        description: 'Temporary test authority', isSystemRole: false, isReadOnly: false, createdBy: ACTOR,
      }).onConflictDoNothing();
      await tx.insert(roleCapability).values({
        client, roleCode: 'TEST_INV561', capabilityCode: INITIAL_STOCK_CAPABILITY, createdBy: ACTOR,
      }).onConflictDoNothing();

      const createActor = async (
        username: string,
        companies: string[],
        plants: string[],
      ): Promise<{ userId: string; sessionId: string }> => {
        const userId = randomUUID();
        await tx.insert(appUser).values({
          id: userId, client, username, fullName: username,
          passwordHash: await hashPassword('InitialStockTest123!'), isActive: true, createdBy: ACTOR,
        });
        await tx.insert(userRole).values({ client, userId, roleCode: 'TEST_INV561', createdBy: ACTOR });
        await tx.insert(authOrgRestriction).values([
          ...companies.map((scopeValue) => ({
            id: randomUUID(), client, userId, scopeType: 'COMPANY_CODE', scopeValue, createdBy: ACTOR,
          })),
          ...plants.map((scopeValue) => ({
            id: randomUUID(), client, userId, scopeType: 'PLANT', scopeValue, createdBy: ACTOR,
          })),
        ]);
        await createSession(tx, { client, userId });
        const rows = await tx.execute(sql`
          select id from user_session where client = ${client} and user_id = ${userId}
          order by issued_at desc limit 1
        `) as unknown as Array<{ id: string }>;
        return { userId, sessionId: rows[0]?.id ?? '' };
      };

      const actor = await createActor('inv561.authorised', ['1000'], ['1000']);
      actorUserId = actor.userId;
      actorSessionId = actor.sessionId;
      const noPlant = await createActor('inv561.no-plant', ['1000'], []);
      noPlantUserId = noPlant.userId;
      noPlantSessionId = noPlant.sessionId;
      const both = await createActor('inv561.both', ['1000', 'OPENCO'], ['1000', 'OPEN-XCO']);
      bothCompaniesUserId = both.userId;
      bothCompaniesSessionId = both.sessionId;
    });
  });

  afterAll(async () => {
    if (client) await destroyTenant(client);
  });

  it('posts a 561 and writes the material document, the stock, the valuation and one balanced journal', async () => {
    const before = await snapshot();
    const posted = await post(input());

    expect(posted.materialDocumentNumber).toMatch(/^MATDOC-/);
    expect(posted.journalDocumentNumber).toBeTruthy();
    expect(posted.lines).toHaveLength(1);
    expect(posted.totalValue).toBe('120.00');

    const state = await withTenant(client, async (tx) => {
      const stock = await tx.execute(sql`
        select quantity::text as q from stock_quantity
        where client = ${client} and material_number = 'OPEN-MAP' and plant = '1000'
          and storage_location = '0001' and stock_type = 'UNRESTRICTED'
      `) as unknown as Array<{ q: string }>;
      const valuation = await tx.execute(sql`
        select total_stock_quantity::text as q, stock_value::text as v from material_valuation
        where client = ${client} and material_number = 'OPEN-MAP' and valuation_area = '1000'
      `) as unknown as Array<{ q: string; v: string }>;
      const journal = await tx.execute(sql`
        select jl.gl_account, jl.debit_credit, jl.amount_local::text as amount
          from journal_entry_line jl
          join journal_entry je on je.client = jl.client and je.document_number = jl.document_number
         where je.client = ${client} and je.document_number = ${posted.journalDocumentNumber}
         order by jl.line_number
      `) as unknown as Array<{ gl_account: string; debit_credit: string; amount: string }>;
      const movement = await tx.execute(sql`
        select movement_type, direction, inventory_event, offset_event, offset_modifier
          from movement_type where client = ${client} and movement_type = 'INITIAL_STOCK_ENTRY'
      `) as unknown as Array<Record<string, string>>;
      return { stock: stock[0], valuation: valuation[0], journal, movement: movement[0] };
    });

    expect(Number(state.stock?.q)).toBe(10);
    expect(Number(state.valuation?.q)).toBe(10);
    expect(Number(state.valuation?.v)).toBe(120);

    // Stock debited, retained earnings credited, and no clearing account anywhere.
    expect(state.journal).toHaveLength(2);
    expect(state.journal.find((row) => row.debit_credit === 'S')?.gl_account).toBe('120000');
    expect(state.journal.find((row) => row.debit_credit === 'H')?.gl_account).toBe('290000');
    expect(state.journal.map((row) => row.gl_account)).not.toContain('210000');

    // The movement stands configured with the events that produced those accounts.
    expect(state.movement?.direction).toBe('RECEIPT');
    expect(state.movement?.inventory_event).toBe('INVENTORY');
    expect(state.movement?.offset_event).toBe('RETAINED_EARNINGS');

    const after = await snapshot();
    expect(Number(after.documents)).toBe(Number(before.documents) + 1);
    expect(Number(after.journals)).toBe(Number(before.journals) + 1);
  });

  it('values the stock at the price the material carries — moving average here, standard there', async () => {
    const posted = await post(input({
      lines: [
        { materialNumber: 'OPEN-MAP', plant: '1000', storageLocation: '0001', quantity: 5 },
        { materialNumber: 'OPEN-STD', plant: '1000', storageLocation: '0001', quantity: 5 },
      ],
    }));
    // Twelve a piece on the moving-average material, twenty on the standard-priced one.
    expect(posted.totalValue).toBe('160.00');

    const accounts = await withTenant(client, async (tx) => {
      const rows = await tx.execute(sql`
        select jl.gl_account, jl.debit_credit, jl.amount_local::text as amount
          from journal_entry_line jl
          join journal_entry je on je.client = jl.client and je.document_number = jl.document_number
         where je.client = ${client} and je.document_number = ${posted.journalDocumentNumber}
         order by jl.line_number
      `) as unknown as Array<{ gl_account: string; debit_credit: string; amount: string }>;
      return rows;
    });
    // The raw material and the finished good have different inventory accounts.
    const debits = accounts.filter((row) => row.debit_credit === 'S').map((row) => row.gl_account);
    expect(debits.sort()).toEqual(['120000', '120200']);
  });

  it('replays a request key instead of posting the stock twice', async () => {
    const requestKey = key();
    const first = await post(input({ requestKey }));
    const before = await snapshot();
    const second = await post(input({ requestKey }));
    const after = await snapshot();

    expect(second.materialDocumentNumber).toBe(first.materialDocumentNumber);
    expect(after.documents).toBe(before.documents);
    expect(after.stock).toBe(before.stock);
  });

  it('refuses the same request key carrying different lines', async () => {
    const requestKey = key();
    await post(input({ requestKey }));
    await expect(post(input({
      requestKey,
      lines: [{ materialNumber: 'OPEN-MAP', plant: '1000', storageLocation: '0001', quantity: 99 }],
    }))).rejects.toThrow(InitialStockError);
  });

  it('refuses a closed material period and leaves nothing behind', async () => {
    const before = await snapshot();
    await expect(post(input({ postingDate: '2026-08-15', documentDate: '2026-08-15' })))
      .rejects.toThrow(/material posting period .* is closed/);
    const after = await snapshot();
    expect(after.documents).toBe(before.documents);
    expect(after.journals).toBe(before.journals);
    expect(after.stock).toBe(before.stock);
  });

  it('refuses an entry with no lines, and a line that is not a positive quantity', async () => {
    await expect(post(input({ lines: [] }))).rejects.toThrow(/No stock was entered/);
    await expect(post(input({
      lines: [{ materialNumber: 'OPEN-MAP', plant: '1000', storageLocation: '0001', quantity: 0 }],
    }))).rejects.toThrow(/must be positive/);
  });

  it('refuses a material that does not stand, and one not extended to the plant', async () => {
    await expect(post(input({
      lines: [{ materialNumber: 'OPEN-NONE', plant: '1000', storageLocation: '0001', quantity: 1 }],
    }))).rejects.toThrow(/does not exist/);
    // Attempted by the user whose reach covers the other company's plant: the
    // refusal under test is the missing plant extension, not the poster's scope.
    await expect(postInitialStock(input({
      lines: [{ materialNumber: 'OPEN-STD', plant: 'OPEN-XCO', storageLocation: '0001', quantity: 1 }],
    }), {
      authorization: { userId: bothCompaniesUserId, sessionId: bothCompaniesSessionId },
    })).rejects.toThrow(/is not extended to plant/);
  });

  it('refuses a storage location that does not stand at the plant', async () => {
    await expect(post(input({
      lines: [{ materialNumber: 'OPEN-MAP', plant: '1000', storageLocation: '0008', quantity: 1 }],
    }))).rejects.toThrow(InitialStockError);
  });

  it('denies a user with no plant restriction, and a plant outside the reach they do have', async () => {
    await expect(postInitialStock(input(), {
      authorization: { userId: noPlantUserId, sessionId: noPlantSessionId },
    })).rejects.toThrow(/not authorised/);

    await expect(postInitialStock(input({
      lines: [{ materialNumber: 'OPEN-MAP', plant: 'OPEN-OTHER', storageLocation: '0001', quantity: 1 }],
    }), { authorization: authorization() })).rejects.toThrow(/not authorised/);
  });

  it('refuses to span company codes even for a user whose reach covers both', async () => {
    await expect(postInitialStock(input({
      lines: [
        { materialNumber: 'OPEN-MAP', plant: '1000', storageLocation: '0001', quantity: 1 },
        { materialNumber: 'OPEN-MAP', plant: 'OPEN-XCO', storageLocation: '0001', quantity: 1 },
      ],
    }), {
      authorization: { userId: bothCompaniesUserId, sessionId: bothCompaniesSessionId },
    })).rejects.toThrow(/may not span company codes/);
  });

  it('refuses a forged identity', async () => {
    await expect(postInitialStock(input(), {
      authorization: { userId: actorUserId, sessionId: randomUUID() },
    })).rejects.toThrow(/not authorised/);
  });
});
