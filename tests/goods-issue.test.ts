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
import { defineTestRanges, createTenant, destroyTenant } from './helpers';
import { defineRange } from '../src/platform/numbering';
import {
  appUser, authOrgRestriction, capability, role, roleCapability, userRole,
} from '../src/platform/tables/security';
import { createSession, encodeSessionCookie } from '../src/platform/auth/session';
import { hashPassword } from '../src/platform/auth/password';
import { AuthzError } from '../src/platform/auth/current';
import { createReservation, getReservation } from '../src/modules/inventory/reservations';
import {
  GOODS_ISSUE_CAPABILITY,
  GoodsIssueError,
  postGoodsIssue,
} from '../src/modules/inventory/goods-issue';
import { postGoodsIssueAction } from '../src/app/inventory/goods-issue/actions';
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
  let actorUserId = '';
  let actorSessionId = '';
  let actorToken = '';
  let noPlantUserId = '';
  let noPlantToken = '';

  const authorization = () => ({ userId: actorUserId, sessionId: actorSessionId });
  const postIssue = (request: Parameters<typeof postGoodsIssue>[0]) =>
    postGoodsIssue(request, 'MB1A', { authorization: authorization() });

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

  const actionForm = (plant: string, requestKey: string, extras: Record<string, string> = {}) => {
    const form = new FormData();
    const values = {
      movementTypeCode: '201', postingDate: '2026-10-15', documentDate: '2026-10-15',
      headerText: 'Organisation auth test', requestKey,
      'material-1': 'GI-MAT', 'plant-1': plant, 'sloc-1': '0001',
      'quantity-1': '1', 'costCenter-1': 'CC1100',
      ...extras,
    };
    for (const [name, value] of Object.entries(values)) form.set(name, value);
    return form;
  };

  const postingSnapshot = async (targetClient = client) => withTenant(targetClient, async (tx) => {
    const rows = await tx.execute(sql`
      select
        (select count(*)::text from material_document where client = ${targetClient}) as documents,
        (select count(*)::text from material_document_line where client = ${targetClient}) as lines,
        (select count(*)::text from journal_entry where client = ${targetClient}) as journals,
        (select count(*)::text from change_document where client = ${targetClient}) as changes,
        (select quantity::text from stock_quantity where client = ${targetClient}
          and material_number = 'GI-MAT' and plant = '1000' and storage_location = '0001'
          and stock_type = 'UNRESTRICTED' limit 1) as stock,
        (select total_stock_quantity::text from material_valuation where client = ${targetClient}
          and material_number = 'GI-MAT' and valuation_area = '1000' limit 1) as valuation_quantity,
        (select stock_value::text from material_valuation where client = ${targetClient}
          and material_number = 'GI-MAT' and valuation_area = '1000' limit 1) as valuation_value
    `) as unknown as Array<Record<string, string>>;
    return rows[0];
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
        insert into company_code (
          client, company_code, name, chart_of_accounts, fiscal_year_variant,
          posting_period_variant, currency, country, created_by
        )
        select client, 'GI2000', 'Other goods-issue company', chart_of_accounts,
               fiscal_year_variant, posting_period_variant, currency, country, ${ACTOR}
          from company_code where client = ${client} and company_code = '1000'
        on conflict do nothing
      `);
      await tx.execute(sql`
        insert into plant (client, plant, name, company_code, country, created_by) values
          (${client}, '1000', 'Issue plant', '1000', 'KW', ${ACTOR}),
          (${client}, 'GI-SAME', 'Same-company unassigned plant', '1000', 'KW', ${ACTOR}),
          (${client}, 'GI-OTHER', 'Different-company plant', 'GI2000', 'KW', ${ACTOR}),
          (${client}, 'GI-NOCO', 'Plant without company assignment', null, 'KW', ${ACTOR})
        on conflict do nothing
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
        select ${client}, v.n, v.d, 'RAW', 'PC', ${ACTOR}
        from (values ('GI-MAT', 'Issued material'), ('GI-SCRAP', 'Scrapped material')) as v(n, d)
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

    await withTenant(client, async (tx) => {
      await tx.insert(capability).values({
        code: GOODS_ISSUE_CAPABILITY, module: 'INV',
        description: 'Post goods issue for organisational-authorisation test', action: 'POST',
      }).onConflictDoNothing();
      await tx.insert(role).values({
        client, code: 'TEST_GI_ORG', name: 'Goods issue authorisation test',
        description: 'Temporary test authority', isSystemRole: false, isReadOnly: false, createdBy: ACTOR,
      }).onConflictDoNothing();
      await tx.insert(roleCapability).values({
        client, roleCode: 'TEST_GI_ORG', capabilityCode: GOODS_ISSUE_CAPABILITY, createdBy: ACTOR,
      }).onConflictDoNothing();

      const createActor = async (username: string, plantScope: boolean) => {
        const userId = randomUUID();
        await tx.insert(appUser).values({
          id: userId, client, username, fullName: username,
          passwordHash: await hashPassword('GoodsIssueAuthTest123!'), isActive: true, createdBy: ACTOR,
        });
        await tx.insert(userRole).values({
          client, userId, roleCode: 'TEST_GI_ORG', createdBy: ACTOR,
        });
        await tx.insert(authOrgRestriction).values([
          { id: randomUUID(), client, userId, scopeType: 'COMPANY_CODE', scopeValue: '1000', createdBy: ACTOR },
          ...(plantScope ? [{ id: randomUUID(), client, userId, scopeType: 'PLANT', scopeValue: '1000', createdBy: ACTOR }] : []),
        ]);
        const session = await createSession(tx, { client, userId });
        const rows = await tx.execute(sql`
          select id from user_session where client = ${client} and user_id = ${userId}
          order by issued_at desc limit 1
        `) as unknown as Array<{ id: string }>;
        return { userId, sessionId: rows[0].id, token: session.token };
      };

      const actor = await createActor('scr136.authorised', true);
      actorUserId = actor.userId;
      actorSessionId = actor.sessionId;
      actorToken = actor.token;
      const noPlantActor = await createActor('scr136.no-plant', false);
      noPlantUserId = noPlantActor.userId;
      noPlantToken = noPlantActor.token;
    });
  });

  afterAll(async () => {
    if (client) await destroyTenant(client);
  });

  it('posts a 201 and writes a material document, the journal, the stock and the valuation', async () => {
    const posted = await postIssue(input());
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
    const posted = await postIssue(input({
      movementTypeCode: '551',
      lines: [line({ materialNumber: 'GI-SCRAP', quantity: 5, costCenter: undefined })],
    }));
    expect(posted.movementCode).toBe('551');
    expect(posted.totalValue).toBe('100.00');
    expect(posted.lines[0].costCenter).toBeNull();
  });

  it('refuses a scrapping that names a cost centre', async () => {
    const error = await postIssue(input({
      movementTypeCode: '551',
      lines: [line({ materialNumber: 'GI-SCRAP', quantity: 1, costCenter: 'CC1100' })],
    })).catch((e: unknown) => e);
    expect((error as GoodsIssueError).message).toMatch(/carries no account assignment, and a cost centre was named/);
  });

  it('refuses 261 on MB1A and names the screen that posts it (SCR-139)', async () => {
    // The movement is delivered now, but MIGO is its screen: one screen per movement keeps
    // the MIGO action/reference matrix the single place a movement is selected.
    const error = await postIssue(input({ movementTypeCode: '261' })).catch((e: unknown) => e);
    expect((error as GoodsIssueError).message).toMatch(/Movement 261 is posted from MIGO, not from this screen/);
    expect((error as GoodsIssueError).remedy).toMatch(/MIGO/);
  });

  it('refuses a counter movement and names MBST', async () => {
    for (const code of ['202', '552', '262']) {
      const error = await postIssue(input({ movementTypeCode: code })).catch((e: unknown) => e);
      expect((error as GoodsIssueError).message).toMatch(/is a reversal, not an issue/);
      expect((error as GoodsIssueError).remedy).toMatch(/MBST/);
    }
  });

  it('judges stock on the location’s own terms', async () => {
    const error = await postIssue(input({ lines: [line({ quantity: 500 })] })).catch((e: unknown) => e);
    expect((error as GoodsIssueError).message).toMatch(/carries [0-9.]+ PC of GI-MAT, and 500\.000 was entered/);
    expect((error as GoodsIssueError).remedy).toMatch(/allow negative stock/);

    // The open store permits the negative, and takes it.
    const posted = await postIssue(input({ lines: [line({ storageLocation: '0002', quantity: 3 })] }));
    expect(posted.materialDocumentNumber).toBeTruthy();
  });

  it('refuses a closed material period', async () => {
    const error = await postIssue(input({ postingDate: '2026-05-15' })).catch((e: unknown) => e);
    expect((error as GoodsIssueError).message).toMatch(/posting period 2026\/5 is closed/);
  });

  it('judges the cost centre: missing, locked, and valid', async () => {
    const missing = await postIssue(input({
      lines: [line({ costCenter: undefined })],
    })).catch((e: unknown) => e);
    expect((missing as GoodsIssueError).message).toMatch(/charges a cost centre, and none was named/);

    const locked = await postIssue(input({
      lines: [line({ costCenter: 'CC1200' })],
    })).catch((e: unknown) => e);
    expect((locked as GoodsIssueError).message).toMatch(/locked for postings/);

    const foreign = await postIssue(input({
      lines: [line({ costCenter: 'CC9999' })],
    })).catch((e: unknown) => e);
    expect((foreign as GoodsIssueError).message).toMatch(/does not stand in company code 1000/);
  });

  it('refuses an unknown material, a blocked location and a batch', async () => {
    await expect(postIssue(input({ lines: [line({ materialNumber: 'NOPE' })] })))
      .rejects.toThrow(/Material NOPE does not exist/);
    await expect(postIssue(input({ lines: [line({ storageLocation: '0099' })] })))
      .rejects.toThrow(/is blocked/);
    const batch = await postIssue(input({ lines: [line({ batch: 'B001' })] })).catch((e: unknown) => e);
    expect((batch as GoodsIssueError).message).toMatch(/is not batch-managed/);
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

    const posted = await postIssue(input({
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
    const error = await postIssue(input({
      lines: [line({
        materialNumber: 'GI-SCRAP', quantity: 5, costCenter: 'CC1100',
        reservationNumber: reservation.reservationNumber, reservationItem: 10,
      })],
    })).catch((e: unknown) => e);
    expect((error as Error).message).toMatch(/exceeds the 2\.000 still open/);
  });

  it('replays a request key instead of posting twice', async () => {
    const request = input();
    const first = await postIssue(request);
    const second = await postIssue(request);
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
    await postIssue(input({ lines: [line({ quantity: 1, costCenter: 'CC1200' })] })).catch(() => {});
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

  it('keeps another tenant’s stock and documents out of reach at the service boundary', async () => {
    const other = await createTenant('scr136-other');
    try {
      const before = await postingSnapshot(other.client);
      const error = await postIssue({
        client: other.client, changedBy: ACTOR, movementTypeCode: '201',
        postingDate: '2026-10-15', documentDate: '2026-10-15', requestKey: key(),
        lines: [line()],
      }).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(AuthzError);
      expect((error as Error).message).not.toContain(other.client);
      expect(await postingSnapshot(other.client)).toEqual(before);
      expect(GOODS_ISSUE_CAPABILITY).toBe('INV.GI.POST');
    } finally {
      await destroyTenant(other.client);
    }
  });

  it('denies unauthenticated requests at the real goods-issue action', async () => {
    const before = await postingSnapshot();
    const previousCookie = requestContext.cookie;
    requestContext.cookie = undefined;
    try {
      await expect(postGoodsIssueAction(
        { ok: false, message: '' },
        actionForm('1000', 'scr136-unauthenticated'),
      )).rejects.toThrow('REDIRECT:/signin');
    } finally {
      requestContext.cookie = previousCookie;
    }
    expect(await postingSnapshot()).toEqual(before);
  });

  it('allows the session-assigned company and plant through the real action and service', async () => {
    const previousCookie = requestContext.cookie;
    requestContext.cookie = encodeSessionCookie(client, actorToken);
    try {
      const result = await postGoodsIssueAction(
        { ok: false, message: '' },
        actionForm('1000', 'scr136-org-authorised', {
          client: 'EVIL', companyCode: 'GI2000', userId: 'FORGED.USER', changedBy: 'FORGED.ACTOR',
        }),
      );
      expect(result.ok).toBe(true);
      expect(result.document?.companyCode).toBe('1000');
    } finally {
      requestContext.cookie = previousCookie;
    }
  });

  it('denies a same-company plant that is not assigned, without any partial posting', async () => {
    const before = await postingSnapshot();
    const previousCookie = requestContext.cookie;
    requestContext.cookie = encodeSessionCookie(client, actorToken);
    try {
      const result = await postGoodsIssueAction(
        { ok: false, message: '' },
        actionForm('GI-SAME', 'scr136-org-same-company-denied', { companyCode: '1000' }),
      );
      expect(result.ok).toBe(false);
      expect(result.message).toBe('You are not authorised to post this goods issue.');
      expect(result.message).not.toContain('GI-SAME');
    } finally {
      requestContext.cookie = previousCookie;
    }
    expect(await postingSnapshot()).toEqual(before);
  });

  it('denies a plant assigned to a different company, without any partial posting', async () => {
    const before = await postingSnapshot();
    const previousCookie = requestContext.cookie;
    requestContext.cookie = encodeSessionCookie(client, actorToken);
    try {
      const result = await postGoodsIssueAction(
        { ok: false, message: '' },
        actionForm('GI-OTHER', 'scr136-org-different-company-denied', { companyCode: '1000' }),
      );
      expect(result.ok).toBe(false);
      expect(result.message).toBe('You are not authorised to post this goods issue.');
      expect(result.message).not.toContain('GI-OTHER');
    } finally {
      requestContext.cookie = previousCookie;
    }
    expect(await postingSnapshot()).toEqual(before);
  });

  it('denies missing user-plant assignment and missing persisted plant-company assignment', async () => {
    const before = await postingSnapshot();
    const previousCookie = requestContext.cookie;
    requestContext.cookie = encodeSessionCookie(client, noPlantToken);
    try {
      const noUserPlant = await postGoodsIssueAction(
        { ok: false, message: '' },
        actionForm('1000', 'scr136-org-missing-user-plant'),
      );
      expect(noUserPlant.ok).toBe(false);
      expect(noUserPlant.message).toBe('You are not authorised to post this goods issue.');

      requestContext.cookie = encodeSessionCookie(client, actorToken);
      const noPersistedCompany = await postGoodsIssueAction(
        { ok: false, message: '' },
        actionForm('GI-NOCO', 'scr136-org-missing-plant-company'),
      );
      expect(noPersistedCompany.ok).toBe(false);
      expect(noPersistedCompany.message).toBe('You are not authorised to post this goods issue.');
      expect(noPersistedCompany.message).not.toContain('GI-NOCO');
    } finally {
      requestContext.cookie = previousCookie;
    }
    expect(await postingSnapshot()).toEqual(before);
  });

  it('does not let forged client/company/plant fields reach another tenant’s plant', async () => {
    const other = await createTenant('scr136-org-foreign');
    try {
      await withTenant(other.client, (tx) => tx.execute(sql`
        insert into plant (client, plant, name, company_code, country, created_by)
        values (${other.client}, 'GI-FOREIGN', 'Foreign-only plant', '1000', 'KW', ${ACTOR})
        on conflict do nothing
      `));
      const beforeHome = await postingSnapshot();
      const beforeOther = await postingSnapshot(other.client);
      const previousCookie = requestContext.cookie;
      requestContext.cookie = encodeSessionCookie(client, actorToken);
      try {
        const result = await postGoodsIssueAction(
          { ok: false, message: '' },
          actionForm('GI-FOREIGN', 'scr136-org-cross-client', {
            client: other.client, companyCode: '1000', userId: noPlantUserId,
          }),
        );
        expect(result.ok).toBe(false);
        expect(result.message).toBe('You are not authorised to post this goods issue.');
        expect(result.message).not.toContain(other.client);
        expect(await postingSnapshot()).toEqual(beforeHome);
        expect(await postingSnapshot(other.client)).toEqual(beforeOther);
      } finally {
        requestContext.cookie = previousCookie;
      }
    } finally {
      await destroyTenant(other.client);
    }
  });

  it('refuses a direct MB1A service call without authenticated session context', async () => {
    const before = await postingSnapshot();
    const error = await postGoodsIssue(input({ requestKey: 'scr136-org-service-no-session' }))
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(AuthzError);
    expect((error as Error).message).toBe('You are not authorised to post this goods issue.');
    expect(await postingSnapshot()).toEqual(before);
  });
});
