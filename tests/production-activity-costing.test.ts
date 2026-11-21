import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';

import { withTenant } from '../src/platform/db/client';
import { defineRange } from '../src/platform/numbering';
import { saveMaterialView } from '../src/modules/inventory/materials';
import { createProductionOrder, releaseProductionOrder } from '../src/modules/inventory/production-orders';
import { createMaterialBom, saveBomItemCategory, saveBomUsage } from '../src/modules/production/material-bom';
import { saveOrderTypeParameter } from '../src/modules/production/order-type-parameters';
import { checkProductionVersion, createProductionVersion } from '../src/modules/production/production-version';
import {
  createRouting, saveRoutingControlKey, saveRoutingStandardValueKey, saveRoutingTaskListType, saveRoutingUsage,
} from '../src/modules/production/routing';
import { insertOrderOperationSnapshot, resolveOrderOperationSnapshot } from '../src/modules/production/order-operation-snapshot';
import { enterTimeTicketForProvisioning as enterTimeTicket } from '../src/modules/production/time-ticket';
import { createWorkCenter, saveWorkCenterCategory, changeWorkCenter } from '../src/modules/production/work-center';
import { cancelConfirmation } from '../src/modules/production/confirmation-cancel';
import {
  costConfirmation, listUncostedConfirmations, previewConfirmationCost, processUncostedConfirmations,
} from '../src/modules/production/activity-costing';
import { getProductionOrderCostReport } from './helpers/cost-report-authorized';
import { saveAccountDetermination, AccountDeterminationError } from '../src/modules/foundation/account-determination';
import { closeDb, createTenant, destroyTenant } from './helpers';
import { createProductionActor, refreshActorPlants } from './helpers/production-actor';

/**
 * Activity costing of confirmations — actual quantity valued at a configured plan rate.
 *
 * Real services, real posting: a confirmation is saved, its activity quantity is valued at the work center's
 * configured plan rate and posted to the order against the sender cost center, and every assertion reads the
 * journal, the cost row and the order cost report back.
 */
const ACTOR = 'ACT_COST_CLERK';
const PLANT = '1000';
const POSTED_ON = '2026-10-24'; // fiscal period 10 of 2026

const clients: string[] = [];
afterAll(async () => {
  for (const client of clients) await destroyTenant(client);
  await closeDb();
});

interface Place {
  client: string;
  area: string;
  currency: string;
  order: string;
  version: number;
  authorization: { userId: string; sessionId: string };
  key: () => string;
}

const LABOR_RATE = { fixed: '10.00', variable: '5.50' };

async function place(seed: string, currency = 'USD', options: { rate?: boolean; costing?: boolean } = {}): Promise<Place> {
  const tenant = await createTenant(seed, { currency });
  clients.push(tenant.client);
  const client = tenant.client;
  const actor = await createProductionActor(client);
  let counter = 0;
  const p: Place = { client, area: '', currency, order: '', version: 1, authorization: actor.authorization, key: () => `${seed}-${++counter}` };
  const auth = async () => { await refreshActorPlants(client, actor); return actor.authorization; };
  await withTenant(client, async (tx) => {
    await defineRange(tx, { client, objectCode: 'PRODORDER', subObject: '*', prefix: 'PRD', numberLength: 7, createdBy: ACTOR });
    await defineRange(tx, { client, objectCode: 'PRODCONF', subObject: '*', prefix: 'CNF', numberLength: 7, createdBy: ACTOR });
    await defineRange(tx, { client, objectCode: 'RF_BELEG', subObject: 'GENERAL', prefix: 'JE', numberLength: 6, companyCode: '1000', fiscalYear: 2026, createdBy: ACTOR });
    await tx.execute(sql`
      insert into production_order_type (client, order_type, description, order_category, created_by)
      values (${client}, 'PP01', 'Standard production', '10', ${ACTOR}) on conflict (client, order_type) do nothing
    `);
  });
  await saveOrderTypeParameter({
    client, changedBy: ACTOR, mode: 'CREATE', plant: PLANT, orderType: 'PP01', taskListType: '', productionVersionSelection: '0', version: 0,
    reason: 'Automatic selection',
  });
  for (const material of ['FG-AC', 'RM-AC']) {
    await saveMaterialView({
      client, materialNumber: material, changedBy: ACTOR, expectedVersion: 0, reason: 'AC', view: 'BASIC', description: material,
      materialType: 'RAW', materialGroup: 'RAW', baseUnit: 'PC', industrySector: 'M', barcode: '', grossWeight: '0', netWeight: '0', weightUnit: '', isBlocked: false,
    });
    await saveMaterialView({
      client, materialNumber: material, changedBy: ACTOR, expectedVersion: 0, reason: 'AC', view: 'PURCHASING', plant: PLANT, purchasingGroup: '001',
      orderUnit: 'PC', overdeliveryTolerance: '0', underdeliveryTolerance: '0', manufacturerPartNumber: '',
    });
    await saveMaterialView({
      client, materialNumber: material, changedBy: ACTOR, expectedVersion: 1, reason: 'AC', view: 'MRP', plant: PLANT, mrpType: 'REQUIREMENTS',
      mrpController: '001', procurementType: material.startsWith('FG') ? 'MAKE' : 'BUY', lotSizing: 'EXACT', fixedLotSize: '0', minimumLotSize: '0',
      maximumLotSize: '0', safetyStock: '0', reorderPoint: '0', plannedDeliveryDays: 0, inHouseProductionDays: 0,
    });
  }
  await saveBomUsage({ client, changedBy: ACTOR, usage: 'P', description: 'Production', productionRelevance: '.', engineeringRelevance: '.', costingRelevance: '.', salesRelevance: '.' });
  await saveBomItemCategory({ client, changedBy: ACTOR, category: 'S', description: 'Stock', materialEntry: '+', quantityEntry: '+' });
  await createMaterialBom({
    client, changedBy: ACTOR, materialNumber: 'FG-AC', plant: PLANT, usage: 'P', alternative: '01', baseQuantity: '1', baseUnit: 'PC', validFrom: '2020-01-01',
    items: [{ itemNumber: '0010', itemCategory: 'S', componentMaterial: 'RM-AC', quantity: '1', unit: 'PC' }],
  });
  await saveRoutingTaskListType({ client, changedBy: ACTOR, taskListType: 'N', description: 'Routing' });
  await saveRoutingUsage({ client, changedBy: ACTOR, usage: '1', description: 'Production' });
  await saveRoutingControlKey({ client, changedBy: ACTOR, controlKey: 'PP01', description: 'Confirm', confirmation: 'X' });
  await saveRoutingStandardValueKey({
    client, changedBy: ACTOR, standardValueKey: 'SV01', description: 'Labor + machine',
    parameters: [
      { parameter: 'LABOR', description: 'Labor', unit: 'HR', required: 'X' },
      { parameter: 'MACH', description: 'Machine', unit: 'HR', required: ' ' },
    ],
  });
  await saveWorkCenterCategory({ client, changedBy: ACTOR, category: 'MACH', description: 'Machine' });

  // Controlling masters: the sender cost center, the activity types and their PLAN rates.
  await withTenant(client, async (tx) => {
    const [area] = await tx.execute(sql`select controlling_area as area from controlling_area where client = ${client} limit 1`) as unknown as Array<{ area: string }>;
    p.area = area!.area.trim();
    await tx.execute(sql`
      insert into cost_center (client, controlling_area, cost_center, valid_from, valid_to, name, category, company_code, created_by)
      values (${client}, ${p.area}, 'CCSEND', '2020-01-01', '9999-12-31', 'Sender', 'PRODUCTION', '1000', ${ACTOR}) on conflict do nothing
    `);
    await tx.execute(sql`
      insert into activity_type (client, controlling_area, activity_type, valid_from, valid_to, name, activity_unit, category, price_indicator, created_by)
      values (${client}, ${p.area}, 'LAB1', '2020-01-01', '9999-12-31', 'Labour hours', 'HR', '1', '3', ${ACTOR}),
             (${client}, ${p.area}, 'MCH1', '2020-01-01', '9999-12-31', 'Machine minutes', 'MIN', '1', '3', ${ACTOR}),
             (${client}, ${p.area}, 'CNT1', '2020-01-01', '9999-12-31', 'Counted', 'PC', '1', '3', ${ACTOR})
      on conflict do nothing
    `);
    if (options.rate !== false) {
      await tx.execute(sql`
        insert into activity_rate (client, controlling_area, plan_version, fiscal_year, period, cost_center, activity_type, planned_quantity, fixed_price, variable_price, price_unit, created_by)
        values (${client}, ${p.area}, '0', 2026, 10, 'CCSEND', 'LAB1', 100, ${LABOR_RATE.fixed}, ${LABOR_RATE.variable}, 7, ${ACTOR}),
               (${client}, ${p.area}, '0', 2026, 10, 'CCSEND', 'MCH1', 100, 0.10, 0.05, 1, ${ACTOR})
      `);
    }
  });
  if (options.costing !== false) {
    await createWorkCenter({
      client, changedBy: ACTOR, plant: PLANT, workCenter: 'WC-AC', category: 'MACH', description: 'Costed assembly',
      costing: [
        { validFrom: '2020-01-01', validTo: '9999-12-31', costCenter: 'CCSEND', activityType: 'LAB1', parameter: 'LABOR', rateBasis: 'PLAN_RATE', planVersion: '0' },
        { validFrom: '2020-01-01', validTo: '9999-12-31', costCenter: 'CCSEND', activityType: 'MCH1', parameter: 'MACH', rateBasis: 'PLAN_RATE', planVersion: '0' },
      ],
    });
  } else {
    await createWorkCenter({ client, changedBy: ACTOR, plant: PLANT, workCenter: 'WC-AC', category: 'MACH', description: 'Uncosted assembly' });
  }
  await createRouting({
    client, changedBy: ACTOR, taskListType: 'N', plant: PLANT, usage: '1', routingGroup: '50000012', groupCounter: '01', baseQuantity: '1', baseUnit: 'PC', validFrom: '2020-01-01',
    assignments: [{ materialNumber: 'FG-AC' }],
    operations: [{
      operationNumber: '0010', shortText: 'Assemble', workCenter: 'WC-AC', controlKey: 'PP01', standardValueKey: 'SV01',
      values: [{ parameter: 'LABOR', quantity: '1', unit: 'HR' }, { parameter: 'MACH', quantity: '1', unit: 'HR' }],
    }],
  });
  await createProductionVersion({
    client, changedBy: ACTOR, materialNumber: 'FG-AC', plant: PLANT, productionVersion: '0001', validFrom: '2020-01-01', lotFrom: '0', lotTo: '999999', lotUnit: 'PC',
    bomUsage: 'P', bomAlternative: '01', taskListType: 'N', routingGroup: '50000012', groupCounter: '01',
  });
  await checkProductionVersion(client, 'FG-AC', PLANT, '0001', ACTOR);
  const order = await createProductionOrder({
    orderType: 'PP01', client, createdBy: ACTOR, materialNumber: 'FG-AC', plant: PLANT, orderQuantity: 10, scheduledStart: '2026-10-24', scheduledFinish: '2026-10-25',
    requestKey: `${seed}-order`, components: [{ materialNumber: 'RM-AC', plant: PLANT, requiredQuantity: 1 }],
  }, { authorization: await auth() });
  await withTenant(client, async (tx) => {
    const copied = await resolveOrderOperationSnapshot(tx, {
      client, plant: PLANT, finishDate: '2026-10-25', taskListType: 'N', routingGroup: '50000012', groupCounter: '01', productionVersion: '0001',
    });
    await insertOrderOperationSnapshot(tx, { client, orderNumber: order.orderNumber, createdBy: ACTOR, operations: copied.operations });
  });
  await releaseProductionOrder({ client, orderNumber: order.orderNumber, releasedBy: ACTOR }, { authorization: await auth() });
  p.order = order.orderNumber;
  const [stamp] = await withTenant(client, (tx) => tx.execute(sql`select version from production_order where client = ${client} and order_number = ${p.order}`)) as unknown as Array<{ version: number }>;
  p.version = Number(stamp!.version);
  return p;
}

/** Replace the work center's costing lines, at the version it stands at. */
async function reconfigure(p: Place, costing: Array<Record<string, string>>) {
  const [row] = await withTenant(p.client, (tx) => tx.execute(sql`select version from work_center where client = ${p.client} and plant = ${PLANT} and work_center = 'WC-AC'`)) as unknown as Array<{ version: number }>;
  await changeWorkCenter({
    client: p.client, changedBy: ACTOR, plant: PLANT, workCenter: 'WC-AC', category: 'MACH', description: 'Costed assembly', version: Number(row!.version), costing,
  } as never);
}

/** The accounts a tenant names for the new posting events. Never seeded. */
async function configureActivityAccount(p: Place) {
  await withTenant(p.client, async (tx) => {
    const [chart] = await tx.execute(sql`select chart_of_accounts as c from company_code where client = ${p.client} and company_code = '1000'`) as unknown as Array<{ c: string }>;
    await tx.execute(sql`
      insert into account_determination (client, chart_of_accounts, event, valuation_class, general_modifier, gl_account, created_by)
      values (${p.client}, ${chart!.c}, 'PRODUCTION_ACTIVITY', '', '', '420000', ${ACTOR}) on conflict do nothing
    `);
  });
}

async function confirm(p: Place, activities: Array<{ parameter: string; quantity: string; unit: string }>, withAuthority = true, postingDate = POSTED_ON, requestKey = p.key()) {
  const actor = withAuthority ? { authorization: p.authorization } : {};
  await withTenant(p.client, async () => undefined);
  return enterTimeTicket(p.client, {
    requestedBy: ACTOR, requestKey, orderNumber: p.order, operationNumber: '0010', confirmationType: 'PARTIAL', yieldQuantity: '1',
    postingDate, expectedVersion: p.version, activities, ...actor,
  });
}

async function journalOf(p: Place, document: string) {
  return withTenant(p.client, async (tx) => tx.execute(sql`
    select l.gl_account, l.debit_credit, l.amount_local::text as amount, l.cost_center, l.production_order, j.status, j.origin_class, j.origin_key, j.reversal_of, j.reversed_by
      from journal_entry_line l join journal_entry j on j.client = l.client and j.document_number = l.document_number and j.fiscal_year = l.fiscal_year
     where l.client = ${p.client} and l.document_number = ${document} order by l.line_number
  `) as unknown as Array<Record<string, string | null>>);
}

const journalCount = async (p: Place) => withTenant(p.client, async (tx) => Number(((await tx.execute(sql`select count(*)::int as n from journal_entry where client = ${p.client}`)) as unknown as Array<{ n: number }>)[0]!.n));

describe('activity costing of confirmations', () => {
  it('values an actual quantity at the configured plan rate, posts a balanced order/sender document once, and says what it is', async () => {
    const p = await place('act-main');
    await configureActivityAccount(p);

    // A preview writes nothing — not even a cost row.
    const before = await journalCount(p);
    const ticket = await confirm(p, [{ parameter: 'LABOR', quantity: '3', unit: 'HR' }]);
    expect(ticket.activityCosts).toHaveLength(1);
    const cost = ticket.activityCosts[0]!;
    // 3 HR × (10.00 + 5.50) per 7 HR = 6.642857… → rounded once to the cent.
    expect(cost).toMatchObject({
      status: 'POSTED', parameter: 'LABOR', costCenter: 'CCSEND', activityType: 'LAB1', activityUnit: 'HR', amount: '6.6400', currency: 'USD',
      rateBasis: 'PLAN_RATE_AT_ACTUAL_QUANTITY', planVersion: '0', priceUnit: 7, rateYear: 2026, ratePeriod: 10,
    });
    expect(Number(cost.fixedPrice)).toBe(10);
    expect(Number(cost.variablePrice)).toBe(5.5);
    expect(await journalCount(p)).toBe(before + 1);

    // Balanced, traceable: the order is debited, the sender credited, on the one allocation account.
    const lines = await journalOf(p, cost.journalDocument!);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatchObject({ gl_account: '420000', debit_credit: 'S', production_order: p.order, origin_class: 'production_confirmation_cost', origin_key: `${ticket.confirmationNumber}/LABOR` });
    expect(lines[1]).toMatchObject({ gl_account: '420000', debit_credit: 'H', cost_center: 'CCSEND' });
    expect(Number(lines[0]!.amount)).toBeCloseTo(6.64, 2);
    expect(lines[0]!.amount).toBe(lines[1]!.amount);

    // The cost report includes the posted actual once, and labels the basis; nothing is added on top of the journal.
    const report = await getProductionOrderCostReport({ client: p.client, orderNumber: p.order });
    expect(report.lines.filter((line) => line.originClass === 'production_confirmation_cost' && line.debitCredit === 'S')).toHaveLength(1);
    expect(report.totals[0]).toMatchObject({ debitLocal: '6.6400', creditLocal: '0.0000', netLocal: '6.6400' });
    expect(report.activityCosts[0]).toMatchObject({ status: 'POSTED', rateBasis: 'PLAN_RATE_AT_ACTUAL_QUANTITY', journalDocument: cost.journalDocument });
    expect(report.gaps.join(' ')).toMatch(/not an actual-rate calculation/);

    // The same request replayed, and a concurrent retry, never post the cost again.
    const key = ticket.requestKey;
    const replay = await confirm(p, [{ parameter: 'LABOR', quantity: '3', unit: 'HR' }], true, POSTED_ON, key);
    expect(replay.replayed).toBe(true);
    await Promise.all([1, 2, 3].map(() => costConfirmation(p.client, ticket.confirmationNumber, { by: ACTOR, authorization: p.authorization, capability: 'PROD.CONFIRM.ENTER' })));
    expect(await journalCount(p)).toBe(before + 1);
  });

  it('converts units exactly, values several parameters separately, and refuses a unit that does not convert', async () => {
    const p = await place('act-units');
    await configureActivityAccount(p);
    // 2 HR of MACH, valued in MINUTES: 120 MIN × (0.10 + 0.05) per 1 MIN = 18.00. LABOR 1 HR = 15.50 per 7 = 2.214285… → 2.21.
    const ticket = await confirm(p, [{ parameter: 'LABOR', quantity: '1', unit: 'HR' }, { parameter: 'MACH', quantity: '2', unit: 'HR' }]);
    const byParameter = Object.fromEntries(ticket.activityCosts.map((row) => [row.parameter, row]));
    expect(byParameter.MACH).toMatchObject({ status: 'POSTED', amount: '18.0000', activityUnit: 'MIN' });
    expect(Number(byParameter.MACH!.activityQuantity)).toBe(120);
    expect(byParameter.LABOR).toMatchObject({ status: 'POSTED', amount: '2.2100' });
    expect(byParameter.MACH!.journalDocument).not.toBe(byParameter.LABOR!.journalDocument);

    // A work-center line whose activity unit is another dimension is a unit mismatch: a recorded exception, never an assumption.
    await reconfigure(p, [
        { validFrom: '2020-01-01', validTo: '9999-12-31', costCenter: 'CCSEND', activityType: 'CNT1', parameter: 'LABOR', rateBasis: 'PLAN_RATE', planVersion: '0' },
      ]);
    const mismatch = await confirm(p, [{ parameter: 'LABOR', quantity: '1', unit: 'HR' }]);
    expect(mismatch.activityCosts[0]).toMatchObject({ status: 'FAILED', parameter: 'LABOR' });
    expect(mismatch.activityCosts[0]!.message).toMatch(/Unit mismatch/);
    expect(mismatch.activityCosts[0]!.amount).toBeNull();
  });

  it('records a missing configuration, rate or account as a recoverable exception and never assumes zero', async () => {
    const p = await place('act-missing');
    // No account determination yet.
    const noAccount = await confirm(p, [{ parameter: 'LABOR', quantity: '2', unit: 'HR' }]);
    expect(noAccount.written).toBe(true); // the confirmation itself is saved
    expect(noAccount.activityCosts[0]).toMatchObject({ status: 'FAILED' });
    expect(noAccount.activityCosts[0]!.message).toMatch(/No account is determined for posting event PRODUCTION_ACTIVITY/);
    expect(noAccount.activityCosts[0]!.remedy).toMatch(/account-determination/);

    // A period with no plan rate.
    await configureActivityAccount(p);
    const noRate = await confirm(p, [{ parameter: 'LABOR', quantity: '2', unit: 'HR' }], true, '2026-11-10');
    expect(noRate.activityCosts[0]).toMatchObject({ status: 'FAILED' });
    expect(noRate.activityCosts[0]!.message).toMatch(/No plan rate/);

    // Report: both are visible as not costed.
    const report = await getProductionOrderCostReport({ client: p.client, orderNumber: p.order });
    expect(report.activityCosts.filter((row) => row.status === 'FAILED')).toHaveLength(2);
    expect(report.gaps.join(' ')).toMatch(/NOT costed/);
    expect(report.lines).toHaveLength(0);

    // Retry after the cause is fixed posts once, not twice; a confirmation of a work center with no valuation at all is NOT_CONFIGURED.
    const retried = await costConfirmation(p.client, noAccount.confirmationNumber, { by: ACTOR, authorization: p.authorization, capability: 'PROD.CONFIRM.ENTER' });
    expect(retried.outcomes[0]).toMatchObject({ status: 'POSTED', amount: '4.43' });
    const again = await costConfirmation(p.client, noAccount.confirmationNumber, { by: ACTOR, authorization: p.authorization, capability: 'PROD.CONFIRM.ENTER' });
    expect(again.outcomes[0]!.message).toMatch(/Already costed/);
    expect(await journalCount(p)).toBe(1);
  });

  it('records NOT_CONFIGURED for a work center without valuation, refuses an unauthorised post, and honours the sender and period', async () => {
    const p = await place('act-noconfig', 'USD', { costing: false });
    await configureActivityAccount(p);
    const ticket = await confirm(p, [{ parameter: 'LABOR', quantity: '1', unit: 'HR' }]);
    expect(ticket.activityCosts[0]).toMatchObject({ status: 'NOT_CONFIGURED' });
    expect(ticket.activityCosts[0]!.message).toMatch(/no costing line valid on 2026-10-24 that values actual activity/);
    expect(await journalCount(p)).toBe(0);

    // Configure it, then a user who is not signed in cannot post: a recorded exception, not a silent skip.
    await reconfigure(p, [{ validFrom: '2020-01-01', validTo: '9999-12-31', costCenter: 'CCSEND', activityType: 'LAB1', parameter: 'LABOR', rateBasis: 'PLAN_RATE', planVersion: '0' }]);
    const unauthorised = await costConfirmation(p.client, ticket.confirmationNumber, { by: ACTOR, capability: 'PROD.CONFIRM.ENTER' });
    expect(unauthorised.outcomes[0]).toMatchObject({ status: 'FAILED' });
    expect(unauthorised.outcomes[0]!.message).toMatch(/signed-in user/);
    expect(await journalCount(p)).toBe(0);

    // Closed posting period: the confirmation stays saved, the cost is a recorded, retriable exception.
    await withTenant(p.client, (tx) => tx.execute(sql`update posting_period_rule set period_from = 1, period_to = 9 where client = ${p.client}`));
    const closed = await costConfirmation(p.client, ticket.confirmationNumber, { by: ACTOR, authorization: p.authorization, capability: 'PROD.CONFIRM.ENTER' });
    expect(closed.outcomes[0]).toMatchObject({ status: 'FAILED' });
    expect(closed.outcomes[0]!.message).toMatch(/closed/i);
    expect(await journalCount(p)).toBe(0);
    await withTenant(p.client, (tx) => tx.execute(sql`update posting_period_rule set period_from = 1, period_to = 12 where client = ${p.client}`));
    const open = await costConfirmation(p.client, ticket.confirmationNumber, { by: ACTOR, authorization: p.authorization, capability: 'PROD.CONFIRM.ENTER' });
    expect(open.outcomes[0]).toMatchObject({ status: 'POSTED' });
    expect(await journalCount(p)).toBe(1);
  });

  it('reverses the original cost exactly once on cancellation, at the original amount even after the rate changed', async () => {
    const p = await place('act-cancel');
    await configureActivityAccount(p);
    const ticket = await confirm(p, [{ parameter: 'LABOR', quantity: '3', unit: 'HR' }]);
    const original = ticket.activityCosts[0]!;
    expect(original.amount).toBe('6.6400');

    // The plan rate changes afterwards; the reversal must not follow it.
    await withTenant(p.client, (tx) => tx.execute(sql`update activity_rate set variable_price = 50.00 where client = ${p.client} and activity_type = 'LAB1'`));

    const requestKey = randomUUID().slice(0, 30);
    const cancel = await cancelConfirmation(p.client, {
      requestKey, confirmationNumber: ticket.confirmationNumber, reason: 'Wrong operator', confirmed: true, authorization: p.authorization,
    });
    expect(cancel.cancellationNumber).toBeTruthy();
    const rows = await withTenant(p.client, (tx) => tx.execute(sql`
      select status, journal_document, reversal_document, amount::text as amount from production_confirmation_cost where client = ${p.client} and confirmation_number = ${ticket.confirmationNumber}
    `)) as unknown as Array<{ status: string; journal_document: string; reversal_document: string; amount: string }>;
    expect(rows[0]).toMatchObject({ status: 'REVERSED' });
    const reversal = await journalOf(p, rows[0]!.reversal_document);
    expect(reversal.map((line) => `${line.debit_credit}:${line.amount}`)).toEqual(['H:6.6400', 'S:6.6400']);
    expect(reversal[0]).toMatchObject({ reversal_of: original.journalDocument });
    const originalAfter = await journalOf(p, original.journalDocument!);
    expect(originalAfter[0]).toMatchObject({ status: 'REVERSED', reversed_by: rows[0]!.reversal_document });

    // The order's actual cost nets to zero; a retry of the same cancellation does not reverse again.
    const report = await getProductionOrderCostReport({ client: p.client, orderNumber: p.order });
    expect(report.totals[0]).toMatchObject({ netLocal: '0.0000' });
    const replay = await cancelConfirmation(p.client, { requestKey, confirmationNumber: ticket.confirmationNumber, reason: 'Wrong operator', confirmed: true, authorization: p.authorization });
    expect(replay.replayed).toBe(true);
    expect(await journalCount(p)).toBe(2);
    expect(report.activityCosts[0]).toMatchObject({ status: 'REVERSED', reversalDocument: rows[0]!.reversal_document });
  });

  it('refuses a cancellation whose cost cannot be reversed (closed period, settled order) and leaves everything as it was', async () => {
    const p = await place('act-cancel-refused');
    await configureActivityAccount(p);
    const ticket = await confirm(p, [{ parameter: 'LABOR', quantity: '3', unit: 'HR' }]);
    await withTenant(p.client, (tx) => tx.execute(sql`update posting_period_rule set period_from = 1, period_to = 1 where client = ${p.client}`));
    await expect(cancelConfirmation(p.client, {
      requestKey: randomUUID().slice(0, 30), confirmationNumber: ticket.confirmationNumber, reason: 'Late', confirmed: true, authorization: p.authorization,
    })).rejects.toThrow(/could not be reversed|closed/i);
    const state = await withTenant(p.client, (tx) => tx.execute(sql`
      select (select count(*)::int from production_confirmation_cancellation where client = ${p.client}) as cancellations,
             (select status from production_confirmation_cost where client = ${p.client} limit 1) as status
    `)) as unknown as Array<{ cancellations: number; status: string }>;
    expect(state[0]).toMatchObject({ cancellations: 0, status: 'POSTED' });
    await withTenant(p.client, (tx) => tx.execute(sql`update posting_period_rule set period_from = 1, period_to = 12 where client = ${p.client}`));
  });

  it('lists confirmations that were never costed, previews them without writing, and posts them only on an explicit run, once', async () => {
    const p = await place('act-backfill', 'USD', { costing: false });
    await configureActivityAccount(p);
    // A confirmation that predates the configuration: it is saved with no cost row at all (history is never back-posted).
    const old = { confirmationNumber: 'CNF-LEGACY1' };
    await withTenant(p.client, async (tx) => {
      await tx.execute(sql`
        insert into production_confirmation (
          client, confirmation_number, order_number, operation_number, sequence, task_list_type, routing_group, group_counter, production_version,
          work_center, work_center_plant, control_key, short_text, confirmation_type, confirmation_level, yield_quantity, scrap_quantity,
          rework_quantity, unit, posting_date, request_key, order_version, created_by
        ) values (${p.client}, ${old.confirmationNumber}, ${p.order}, '0010', '000000', 'N', '50000012', '01', '0001', 'WC-AC', ${PLANT}, 'PP01', 'Assemble',
          'PARTIAL', 'OPERATION', 1, 0, 0, 'PC', ${POSTED_ON}, 'legacy-request-1', 1, ${ACTOR})
      `);
      await tx.execute(sql`
        insert into production_confirmation_activity (client, confirmation_number, parameter, quantity, unit, created_by)
        values (${p.client}, ${old.confirmationNumber}, 'LABOR', 1, 'HR', ${ACTOR})
      `);
    });
    await reconfigure(p, [{ validFrom: '2020-01-01', validTo: '9999-12-31', costCenter: 'CCSEND', activityType: 'LAB1', parameter: 'LABOR', rateBasis: 'PLAN_RATE', planVersion: '0' }]);
    const listed = await withTenant(p.client, (tx) => listUncostedConfirmations(tx, p.client, { orderNumber: p.order }));
    expect(listed.map((row) => row.confirmationNumber)).toContain(old.confirmationNumber);

    const journals = await journalCount(p);
    const preview = await processUncostedConfirmations(p.client, { by: ACTOR, authorization: p.authorization, capability: 'PROD.ORDER.SETTLE', orderNumber: p.order, preview: true });
    expect(preview.confirmations).toBeGreaterThan(0);
    expect(preview.runs[0]!.outcomes[0]).toMatchObject({ status: 'PREVIEW', amount: '2.21' });
    expect(await journalCount(p)).toBe(journals);
    expect((await previewConfirmationCost(p.client, old.confirmationNumber, ACTOR)).outcomes[0]!.status).toBe('PREVIEW');

    const run = await processUncostedConfirmations(p.client, { by: ACTOR, authorization: p.authorization, capability: 'PROD.CONFIRM.ENTER', orderNumber: p.order, preview: false });
    expect(run.runs.flatMap((r) => r.outcomes).some((o) => o.status === 'POSTED')).toBe(true);
    const second = await processUncostedConfirmations(p.client, { by: ACTOR, authorization: p.authorization, capability: 'PROD.CONFIRM.ENTER', orderNumber: p.order, preview: false });
    expect(second.confirmations).toBe(0);
    expect(await journalCount(p)).toBe(journals + 1);
  });

  it('posts three-decimal currency amounts at the currency precision', async () => {
    const p = await place('act-kwd', 'KWD');
    await configureActivityAccount(p);
    // 1 HR × 15.50 per 7 = 2.2142857… → KWD has three decimals: 2.214, not 2.21.
    const ticket = await confirm(p, [{ parameter: 'LABOR', quantity: '1', unit: 'HR' }]);
    expect(ticket.activityCosts[0]).toMatchObject({ status: 'POSTED', amount: '2.2140', currency: 'KWD' });
    const lines = await journalOf(p, ticket.activityCosts[0]!.journalDocument!);
    expect(lines.map((line) => line.amount)).toEqual(['2.2140', '2.2140']);
  });

  it('keeps the new posting events honest: kinds are enforced and no account is seeded', async () => {
    const p = await place('act-events');
    await expect(withTenant(p.client, async (tx) => {
      const rows = await tx.execute(sql`select count(*)::int as n from account_determination where client = ${p.client} and event in ('PRODUCTION_ACTIVITY', 'PRODUCTION_WIP', 'PRODUCTION_WIP_CHANGE')`) as unknown as Array<{ n: number }>;
      if (rows[0]!.n !== 0) throw new Error('seeded');
    })).resolves.toBeUndefined();
    const chart = await withTenant(p.client, async (tx) => (await tx.execute(sql`select chart_of_accounts as c from company_code where client = ${p.client} and company_code = '1000'`) as unknown as Array<{ c: string }>)[0]!.c);
    // A balance-sheet account is not a valid activity-allocation (P&L) account; a P&L account is not a valid WIP balance account.
    const input = (event: string, account: string) => ({ client: p.client, changedBy: ACTOR, chartOfAccounts: chart, event, valuationClass: '', generalModifier: '', glAccount: account, expectedVersion: 0 }) as never;
    await expect(saveAccountDetermination(input('PRODUCTION_ACTIVITY', '120000'))).rejects.toBeInstanceOf(AccountDeterminationError);
    await expect(saveAccountDetermination(input('PRODUCTION_WIP', '410000'))).rejects.toBeInstanceOf(AccountDeterminationError);
  });
});
