import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { changeHistory } from '../src/platform/change';
import { withTenant } from '../src/platform/db/client';
import {
  PAY_COMPONENT_CAPABILITY,
  PAY_COMPONENT_CONFIG_OBJECT_CLASS,
  PAY_COMPONENT_OBJECT_CLASS,
  changePayComponent,
  definePayComponent,
  getPayComponent,
  listAccountsForSide,
  listCostCentresForMapping,
  listPayComponents,
  savePayComponentMapping,
} from '../src/modules/people/pay-components';
import { createTenant, destroyTenant, type TestTenant } from './helpers';

/**
 * The pay structure — 9195's `pay_component` and `pay_component_config`, and the service
 * `/config/pay-components` calls.
 *
 * Nothing is mocked. A component is defined and mapped through the same functions the screen calls, and every
 * claim is read back from the tenant afterwards. Six things carry the weight of the slice:
 *
 *   1. the kind decides the sides, and the sides are the whole of what §15.2's posting example says a
 *      component's mapping must express — an earning debits, a deduction credits, a contribution or a
 *      provision does both, and a mapping that answers to another kind of entry is refused;
 *   2. the accounts are the tenant's own chart's: existence, openness for posting and account type are
 *      checked against `gl_account` rather than asserted here, which is why this slice can be firm about a
 *      mapping without inventing a financial rule;
 *   3. a cost object is followed and never invented — an expense account whose master sets
 *      `requires_cost_object` cannot be mapped to NONE, a FIXED centre has to stand in its area today, and
 *      ASSIGNMENT carries no centre of its own;
 *   4. nothing is deleted: the runtime role has no DELETE on either table, so a component is retired and a
 *      mapping corrected, which is a privilege question and is tested against the database with a live attempt;
 *   5. the checks in the migration hold against a writer that bypasses the service, including the pin that
 *      ties the net-pay effect to the kind;
 *   6. a tenant sees only its own structure, and the same code in two tenants is two components.
 *
 * No amount appears anywhere, because no amount is this slice's business: calculation, deduction rules, runs,
 * results and their postings stay unbuilt (D-013, R-11, DV-001).
 */
const ACTOR = 'pay.admin';
const AREA = 'A000';

const EARNING = 'BASIC';
const GROSS_DEBIT = '590100';
const GROSS_DEBIT_FREE = '590200';
const NET_CREDIT = '290100';
const BLOCKED_CREDIT = '290200';
const ASSET = '190100';

let tenant: TestTenant;
let other: TestTenant;
let chart = '';

beforeAll(async () => {
  tenant = await createTenant('people-9195');
  other = await createTenant('people-9195-b');
  await withTenant(tenant.client, async (tx) => {
    const [row] = (await tx.execute(
      sql`select chart_of_accounts as chart from chart_of_accounts where client = ${tenant.client} limit 1`,
    )) as unknown as Array<{ chart: string }>;
    chart = row!.chart;
    await tx.execute(sql`
      insert into cost_center (client, controlling_area, cost_center, valid_from, valid_to, name, category, company_code, is_posting_locked, created_by)
      values (${tenant.client}, ${AREA}, 'CC100', '2020-01-01', '9999-12-31', 'Standing centre', 'PRODUCTION', '1000', false, ${ACTOR}),
             (${tenant.client}, ${AREA}, 'CC900', '2020-01-01', '2024-12-31', 'Expired centre', 'PRODUCTION', '1000', false, ${ACTOR})
      on conflict do nothing`);
    await tx.execute(sql`
      insert into gl_account (client, chart_of_accounts, account_number, name, account_type,
                               is_balance_sheet, is_open_item_managed, reconciliation_type,
                               requires_cost_object, is_tax_relevant, is_blocked_posting, is_blocked_creation,
                               account_group, gl_account_type, language_key, sort_key, created_by)
      select ${tenant.client}, ${chart}, v.n, v.d, v.t, v.bs, v.open, null, v.cost, false, v.blocked, false,
             'GENL', v.kind, 'EN', v.sort, ${ACTOR}
        from (values
          ('590100', 'Payroll expense',       'EXPENSE',   false, false, true,  false, 'PL_STATEMENT',  '950'),
          ('590200', 'Unrestricted expense',  'EXPENSE',   false, false, false, false, 'PL_STATEMENT',  '951'),
          ('290100', 'Payroll payable',       'LIABILITY', true,  true,  false, false, 'BALANCE_SHEET', '952'),
          ('290200', 'Blocked payable',       'LIABILITY', true,  true,  false, true,  'BALANCE_SHEET', '953'),
          ('190100', 'Cash at bank',          'ASSET',     true,  false, false, false, 'BALANCE_SHEET', '954')
        ) as v(n, d, t, bs, open, cost, blocked, kind, sort)
      on conflict (client, chart_of_accounts, account_number) do update set
        name = excluded.name,
        account_type = excluded.account_type,
        is_balance_sheet = excluded.is_balance_sheet,
        requires_cost_object = excluded.requires_cost_object,
        is_blocked_posting = excluded.is_blocked_posting,
        gl_account_type = excluded.gl_account_type,
        changed_by = excluded.created_by,
        changed_at = now()`);
  });
  await withTenant(other.client, async (tx) => {
    await tx.execute(sql`
      insert into cost_center (client, controlling_area, cost_center, valid_from, valid_to, name, category, company_code, is_posting_locked, created_by)
      values (${other.client}, ${AREA}, 'CC100', '2020-01-01', '9999-12-31', 'Their centre', 'PRODUCTION', '1000', false, ${ACTOR})
      on conflict do nothing`);
  });
}, 180_000);

afterAll(async () => {
  await destroyTenant(tenant.client);
  await destroyTenant(other.client);
}, 60_000);

/** The documents of one object, read on the tenant's own connection, as every caller does. */
function history(client: string, objectClass: string, objectKey: string) {
  return withTenant(client, (tx) => changeHistory(tx, client, objectClass, objectKey));
}

function define(code: string, kind: string, name = `Component ${code}`) {
  return definePayComponent({ client: tenant.client, code, name, componentKind: kind, changedBy: ACTOR });
}

function map(componentCode: string, fields: Record<string, unknown>, mode: 'CREATE' | 'CHANGE' = 'CREATE') {
  return savePayComponentMapping(
    { client: tenant.client, componentCode, chartOfAccounts: chart, changedBy: ACTOR, ...fields },
    mode,
  );
}

describe('the pay component', () => {
  it('defines a component whose effect on net pay is pinned to its kind', async () => {
    const earning = await define(EARNING, 'EARNING');
    expect(earning).toMatchObject({ code: EARNING, componentKind: 'EARNING', affectsNetPay: true, isValid: true });
    const contribution = await define('EMPLOYER', 'EMPLOYER_CONTRIBUTION');
    expect(contribution.affectsNetPay).toBe(false);
    const deduction = await define('TAXW', 'DEDUCTION');
    expect(deduction.affectsNetPay).toBe(true);

    const listed = await listPayComponents(tenant.client);
    expect(listed.map((row) => row.code)).toEqual([EARNING, 'EMPLOYER', 'TAXW']);
    expect(listed.every((row) => row.mappings === 0)).toBe(true);

    const docs = await history(tenant.client, PAY_COMPONENT_OBJECT_CLASS, EARNING);
    expect(docs).toHaveLength(1);
    expect(docs[0]).toMatchObject({ changeType: 'CREATE', changedBy: ACTOR });
  });

  it('refuses a duplicate code and a kind the design does not have', async () => {
    await expect(define(EARNING, 'EARNING', 'A second basic pay')).rejects.toThrow(
      /already stands in this tenant/,
    );
    await expect(define('BENEFIT', 'BENEFIT')).rejects.toThrow(
      /an earning, a deduction, an employer contribution or an end-of-service provision/,
    );
    expect(await listPayComponents(tenant.client)).toHaveLength(3);
  });

  it('renames and retires a component without touching the mapping that cites it', async () => {
    await map(EARNING, { debitAccount: GROSS_DEBIT, costReceiverCategory: 'ASSIGNMENT' });
    const retired = await changePayComponent({
      client: tenant.client,
      code: EARNING,
      name: 'Basic salary',
      isValid: false,
      changedBy: ACTOR,
    });
    expect(retired).toMatchObject({ name: 'Basic salary', isValid: false });
    expect(retired.mappings).toHaveLength(1);
    expect(retired.mappings[0]).toMatchObject({ debitAccount: GROSS_DEBIT, costCenter: null });

    await expect(
      map(EARNING, { debitAccount: GROSS_DEBIT_FREE, costReceiverCategory: 'NONE' }),
    ).rejects.toThrow(/is retired, so no new mapping may be written for it/);
    // A correction of the standing mapping is still allowed: a wrong account is wrong whether or not the
    // component is offered onward, and leaving it unfixable would strand the entry it belongs to.
    const corrected = await map(EARNING, { debitAccount: GROSS_DEBIT_FREE }, 'CHANGE');
    expect(corrected.debitAccount).toBe(GROSS_DEBIT_FREE);
    expect(corrected.debitAccountName).toBe('Unrestricted expense');
    await changePayComponent({ client: tenant.client, code: EARNING, isValid: true, changedBy: ACTOR });

    await expect(
      changePayComponent({ client: tenant.client, code: EARNING, changedBy: ACTOR }),
    ).rejects.toThrow(/No field was given, so nothing would change/);
  });

  it('keeps a component the tenant has not created out of reach', async () => {
    await expect(getPayComponent(other.client, EARNING)).rejects.toThrow(/No pay component of that code/);
    await expect(
      savePayComponentMapping(
        {
          client: other.client,
          componentCode: EARNING,
          chartOfAccounts: await firstChart(other.client),
          debitAccount: '510100',
          costReceiverCategory: 'NONE',
          changedBy: ACTOR,
        },
        'CREATE',
      ),
    ).rejects.toThrow(/No pay component of that code/);
    const own = await definePayComponent({
      client: other.client,
      code: EARNING,
      name: 'Their basic pay',
      componentKind: 'EARNING',
      changedBy: ACTOR,
    });
    expect(own.name).toBe('Their basic pay');
    expect(await listPayComponents(other.client)).toHaveLength(1);
    expect(await listPayComponents(tenant.client)).toHaveLength(3);
  });
});

describe('the accounting mapping', () => {
  it('writes the sides the kind allows and refuses the ones it does not', async () => {
    await define('TAXDED', 'DEDUCTION');
    await expect(map('TAXDED', { debitAccount: GROSS_DEBIT, creditAccount: NET_CREDIT, costReceiverCategory: 'NONE' })).rejects.toThrow(
      /has no debit side/,
    );
    await expect(map('TAXDED', { debitAccount: GROSS_DEBIT, costReceiverCategory: 'NONE' })).rejects.toThrow(
      /has no debit side/,
    );
    await expect(map('TAXDED', { costReceiverCategory: 'NONE' })).rejects.toThrow(/creates a payable, so the credit account is required/);
    const deduction = await map('TAXDED', { creditAccount: NET_CREDIT, costReceiverCategory: 'NONE' });
    expect(deduction).toMatchObject({ debitAccount: null, creditAccount: NET_CREDIT, costReceiverCategory: 'NONE' });

    await expect(map(EARNING, { creditAccount: NET_CREDIT, costReceiverCategory: 'NONE' }, 'CHANGE')).rejects.toThrow(
      /has no credit side/,
    );
    await expect(map('EMPLOYER', { debitAccount: GROSS_DEBIT, costReceiverCategory: 'ASSIGNMENT' })).rejects.toThrow(
      /creates a payable, so the credit account is required/,
    );
  });

  it('takes its accounts from the chart, open and of the type the side needs', async () => {
    await expect(map('EMPLOYER', { debitAccount: '999999', creditAccount: NET_CREDIT, costReceiverCategory: 'ASSIGNMENT' })).rejects.toThrow(
      /is not part of the chart being mapped/,
    );
    await expect(map('EMPLOYER', { debitAccount: GROSS_DEBIT, creditAccount: BLOCKED_CREDIT, costReceiverCategory: 'ASSIGNMENT' })).rejects.toThrow(
      /is blocked for posting/,
    );
    await expect(map('EMPLOYER', { debitAccount: NET_CREDIT, creditAccount: GROSS_DEBIT, costReceiverCategory: 'ASSIGNMENT' })).rejects.toThrow(
      /not EXPENSE/,
    );
    await expect(map('EMPLOYER', { debitAccount: GROSS_DEBIT, creditAccount: ASSET, costReceiverCategory: 'ASSIGNMENT' })).rejects.toThrow(
      /not LIABILITY/,
    );
    await expect(map('EMPLOYER', { debitAccount: GROSS_DEBIT, creditAccount: GROSS_DEBIT, costReceiverCategory: 'ASSIGNMENT' })).rejects.toThrow(
      /The same account cannot stand on both sides/,
    );
    const both = await map('EMPLOYER', {
      debitAccount: GROSS_DEBIT,
      creditAccount: NET_CREDIT,
      costReceiverCategory: 'ASSIGNMENT',
    });
    expect(both).toMatchObject({ debitAccount: GROSS_DEBIT, creditAccount: NET_CREDIT, costReceiverCategory: 'ASSIGNMENT' });
    await expect(map('EMPLOYER', { debitAccount: GROSS_DEBIT, creditAccount: NET_CREDIT, costReceiverCategory: 'ASSIGNMENT' })).rejects.toThrow(
      /already has a mapping in this chart/,
    );
  });

  it('charges what the expense account demands and nothing it does not', async () => {
    // 510100 requires a cost object, so a mapping of it cannot charge nothing.
    await expect(
      map('TAXDED', { creditAccount: NET_CREDIT, debitAccount: GROSS_DEBIT, costReceiverCategory: 'NONE' }, 'CHANGE'),
    ).rejects.toThrow(/has no debit side/);
    await expect(
      savePayComponentMapping(
        {
          client: tenant.client,
          componentCode: 'EMPLOYER',
          chartOfAccounts: chart,
          debitAccount: GROSS_DEBIT,
          creditAccount: NET_CREDIT,
          costReceiverCategory: 'NONE',
          changedBy: ACTOR,
        },
        'CHANGE',
      ),
    ).rejects.toThrow(/requires a cost object, so the debit cannot be mapped to none/);

    // 510200 does not demand one, so NONE stands for it.
    const relaxed = await map('EMPLOYER', { debitAccount: GROSS_DEBIT_FREE, costReceiverCategory: 'NONE' }, 'CHANGE');
    expect(relaxed).toMatchObject({ debitAccount: GROSS_DEBIT_FREE, costReceiverCategory: 'NONE', controllingArea: null });

    await expect(
      map('EMPLOYER', { debitAccount: GROSS_DEBIT, costReceiverCategory: 'FIXED', controllingArea: AREA, costCenter: 'CC900' }, 'CHANGE'),
    ).rejects.toThrow(/No cost centre of that code stands in that controlling area today/);
    const fixed = await map(
      'EMPLOYER',
      { debitAccount: GROSS_DEBIT, costReceiverCategory: 'FIXED', controllingArea: AREA, costCenter: 'CC100' },
      'CHANGE',
    );
    expect(fixed).toMatchObject({ costReceiverCategory: 'FIXED', controllingArea: AREA, costCenter: 'CC100' });
    expect(fixed.costCenterName).toBe('Standing centre');

    // ASSIGNMENT names no centre — the employee's assignment is the answer, read at posting time.
    const assigned = await map('EMPLOYER', { costReceiverCategory: 'ASSIGNMENT' }, 'CHANGE');
    expect(assigned).toMatchObject({ costReceiverCategory: 'ASSIGNMENT', controllingArea: null, costCenter: null });
  });

  it('lists what the screen may offer, and only that', async () => {
    const debits = await listAccountsForSide(tenant.client, chart, 'DEBIT');
    const debitCodes = debits.map((row) => row.accountNumber);
    expect(debitCodes).toContain(GROSS_DEBIT);
    expect(debitCodes).toContain(GROSS_DEBIT_FREE);
    for (const absent of [NET_CREDIT, BLOCKED_CREDIT, ASSET]) expect(debitCodes).not.toContain(absent);
    expect(debits.find((row) => row.accountNumber === GROSS_DEBIT)?.requiresCostObject).toBe(true);
    const credits = await listAccountsForSide(tenant.client, chart, 'CREDIT');
    expect(credits.map((row) => row.accountNumber)).toContain(NET_CREDIT);
    expect(credits.map((row) => row.accountNumber)).not.toContain(BLOCKED_CREDIT);
    const centres = await listCostCentresForMapping(tenant.client);
    expect(centres.map((row) => row.costCenter)).toEqual(['CC100']);
  });

  it('documents a correction with both sides of the change', async () => {
    const before = await getPayComponent(tenant.client, 'EMPLOYER');
    await map('EMPLOYER', { creditAccount: NET_CREDIT, costReceiverCategory: 'FIXED', controllingArea: AREA, costCenter: 'CC100' }, 'CHANGE');
    const after = await getPayComponent(tenant.client, 'EMPLOYER');
    expect(after.mappings[0]?.costReceiverCategory).toBe('FIXED');
    const docs = await history(tenant.client, PAY_COMPONENT_CONFIG_OBJECT_CLASS, `${chart}/EMPLOYER`);
    expect(docs.length).toBeGreaterThan(1);
    // `changeHistory` answers newest first, so the correction is the head of the list and the definition is
    // its tail: a reader of the screen sees what changed most recently without counting rows.
    expect(docs[0]).toMatchObject({ changeType: 'CHANGE', changedBy: ACTOR });
    expect(docs[docs.length - 1]).toMatchObject({ changeType: 'CREATE', changedBy: ACTOR });
    expect(before.mappings[0]?.costReceiverCategory).not.toBe(after.mappings[0]?.costReceiverCategory);
  });
});

describe('the shape 9195 declared', () => {
  it('grants no delete on either table', async () => {
    for (const statement of [
      sql`delete from pay_component_config where client = ${tenant.client}`,
      sql`delete from pay_component where client = ${tenant.client}`,
      sql`truncate table pay_component`,
    ]) {
      await expect(withTenant(tenant.client, async (tx) => tx.execute(statement))).rejects.toThrow(/permission denied/);
    }
    expect((await getPayComponent(tenant.client, 'EMPLOYER')).code).toBe('EMPLOYER');
  });

  it('holds its checks against a writer that bypasses the service', async () => {
    await expect(
      withTenant(tenant.client, async (tx) =>
        tx.execute(sql`
          insert into pay_component (client, code, name, component_kind, affects_net_pay, created_by)
          values (${tenant.client}, 'PINNED', 'Pinned by hand', 'EARNING', false, ${ACTOR})`),
      ),
    ).rejects.toThrow(/pay_component_net_effect_ck/);
    await expect(
      withTenant(tenant.client, async (tx) =>
        tx.execute(sql`
          insert into pay_component (client, code, name, component_kind, affects_net_pay, created_by)
          values (${tenant.client}, ${EARNING}, 'Twice the same code', 'EARNING', true, ${ACTOR})`),
      ),
    ).rejects.toThrow(/pay_component_pk|duplicate key/);
    await expect(
      withTenant(tenant.client, async (tx) =>
        tx.execute(sql`
          insert into pay_component_config (client, component_code, chart_of_accounts, cost_receiver_category, created_by)
          values (${tenant.client}, 'EMPLOYER', ${chart}, 'NONE', ${ACTOR})`),
      ),
    ).rejects.toThrow(/pay_component_config_not_hollow_ck/);
    await expect(
      withTenant(tenant.client, async (tx) =>
        tx.execute(sql`
          insert into pay_component_config (client, component_code, chart_of_accounts, debit_account, credit_account, cost_receiver_category, created_by)
          values (${tenant.client}, 'EMPLOYER', ${chart}, '510100', '510100', 'NONE', ${ACTOR})`),
      ),
    ).rejects.toThrow(/pay_component_config_sides_differ_ck/);
    await expect(
      withTenant(tenant.client, async (tx) =>
        tx.execute(sql`
          insert into pay_component_config (client, component_code, chart_of_accounts, debit_account, cost_receiver_category, controlling_area, created_by)
          values (${tenant.client}, 'TAXW', ${chart}, ${GROSS_DEBIT}, 'FIXED', ${AREA}, ${ACTOR})`),
      ),
    ).rejects.toThrow(/pay_component_config_(fixed_needs_centre|cost_pair)_ck/);
    await expect(
      withTenant(tenant.client, async (tx) =>
        tx.execute(sql`
          insert into pay_component_config (client, component_code, chart_of_accounts, credit_account, cost_receiver_category, created_by)
          values (${tenant.client}, 'NOPE', ${chart}, '210100', 'NONE', ${ACTOR})`),
      ),
    ).rejects.toThrow(/pay_component_config_component_fk/);
    await expect(
      withTenant(tenant.client, async (tx) =>
        tx.execute(sql`
          insert into pay_component_config (client, component_code, chart_of_accounts, credit_account, cost_receiver_category, created_by)
          values (${tenant.client}, 'TAXW', ${chart}, '999999', 'NONE', ${ACTOR})`),
      ),
    ).rejects.toThrow(/pay_component_config_credit_account_fk/);
  });

  it('keeps the capability the screen and the service agree on', async () => {
    expect(PAY_COMPONENT_CAPABILITY).toBe('CFG.PEOPLE.PAYCOMPONENT.DEFINE');
    const [row] = (await withTenant(tenant.client, async (tx) =>
      tx.execute(sql`select code, is_posting_relevant from capability where code = ${PAY_COMPONENT_CAPABILITY}`),
    )) as unknown as Array<{ code: string; is_posting_relevant: boolean }>;
    expect(row).toMatchObject({ code: PAY_COMPONENT_CAPABILITY, is_posting_relevant: false });
    const [activity] = (await withTenant(tenant.client, async (tx) =>
      tx.execute(sql`select route_path from config_activity where code = ${PAY_COMPONENT_CAPABILITY}`),
    )) as unknown as Array<{ route_path: string | null }>;
    expect(activity?.route_path).toBe('/config/pay-components');
  });
});

async function firstChart(client: string): Promise<string> {
  const [row] = (await withTenant(client, async (tx) =>
    tx.execute(sql`select chart_of_accounts as chart from chart_of_accounts where client = ${client} limit 1`),
  )) as unknown as Array<{ chart: string }>;
  return row!.chart;
}
