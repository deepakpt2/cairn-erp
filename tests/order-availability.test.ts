import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { withTenant } from '../src/platform/db/client';
import { saveMaterialView } from '../src/modules/inventory/materials';
import { createProductionOrder, releaseProductionOrder } from '../src/modules/inventory/production-orders';
import { mrpController } from '../src/modules/inventory/schema';
import { defineRange } from '../src/platform/numbering';
import {
  assignCheckingGroup,
  listAvailabilityCheck,
  saveCheckingGroup,
  saveCheckingRule,
  saveScopeOfCheck,
  type ScopeOfCheckRow,
} from '../src/modules/production/availability-check';
import { saveCheckingControl, listCheckingControls } from '../src/modules/production/checking-control';
import { createMaterialBom, saveBomItemCategory, saveBomUsage } from '../src/modules/production/material-bom';
import {
  ORDER_AVAILABILITY_ELEMENTS_CAPABILITY,
  ORDER_AVAILABILITY_ORDER_CAPABILITY,
  OrderAvailabilityError,
  checkOrderAvailability,
  holdsOrderAvailabilityAuthority,
  orderAvailabilityRefusal,
  type OrderAvailabilityResult,
} from '../src/modules/production/order-availability';
import { stockRequirementsList } from '../src/modules/production/stock-requirements';
import { closeDb, createTenant, destroyTenant, type TestTenant } from './helpers';

/**
 * CO09 slice 1 — the read-only availability check over a production order's
 * components.
 *
 * The suite is deliberately built around one fixture order whose ten component lines
 * each stand for one answer the check is allowed to give, so every test is about the
 * answer rather than about a different world. Five behaviours are pinned hardest, because
 * they are the ones a reader of CO09 would otherwise assume:
 *
 *   - the configuration is honoured, and an absent record is refused instead of
 *     defaulted (control, its rule, the material's group, the (group × rule) scope);
 *   - a scope of check is read switch by switch, including the two narrower letters
 *     (planned orders `A` = firmed only, production orders `F` = released only) and
 *     `receipts in the past = B`, which really does stop a past receipt covering;
 *   - a requirement is never its own coverage, and the requirement being checked is
 *     named on the row it belongs to;
 *   - committed quantity and cumulated ATP are different columns, and the first one is
 *     always `null` here, because nothing is stored;
 *   - nothing is written. The last test hashes every table the check reads, plus the
 *     change documents, immediately before and immediately after one run.
 *
 * The dated component requirement and the order's bill-of-material keys are written by
 * the fixture the way planned-order conversion writes them: conversion copies the date
 * from a matching dependent requirement and records the item it came from. The chain
 * that produces that state is exercised in `dependent-requirement-conversion.test.ts`;
 * repeating it here would test that suite, not this one.
 */
const ACTOR = 'CO09_TEST';
const PLANT = 'Q90';
const TODAY = '2026-06-01';
const REQ = '2026-06-10';
const GROUP = 'ZT';
const GROUP_NOCHECK = 'ZP';
const GROUP_NOSCOPE = 'ZQ';
const RULE = 'PP';
const TYPE_ORDER = 'PP01';
const TYPE_NO_CONTROL = 'PP02';

/**
 * The MRP-consistent configuration: `includeRestrictedUse` is the scope's
 * "Include restricted-use batches" switch (`availability-check.ts` validates it, the form
 * labels it that way), and the stock/requirements list counts no such stock type. Blank
 * is therefore the only value this check can answer with, and the fixture keeps the
 * other stock-type switches in the state the ledger can honour.
 */
const SCOPE_DEFAULTS = {
  includeSafetyStock: 'X',
  includeQualityStock: 'X',
  includeBlockedStock: ' ',
  includeRestrictedUse: ' ',
  purchaseOrders: 'X',
  purchaseRequisitions: 'X',
  plannedOrders: 'X',
  productionOrders: 'X',
  dependentRequirements: 'X',
  reservations: 'X',
  receiptsInPast: ' ',
} as const;

let tenant: TestTenant;
let other: TestTenant;
let orderOne = '';
let orderTwo = '';
let orderThree = '';
let supplyReleased = '';
let supplyCreated = '';
let key = 0;

async function material(materialNumber: string, baseUnit: string, mrpType: 'REQUIREMENTS' | 'NONE', safetyStock: string) {
  await saveMaterialView({
    client: tenant.client, materialNumber, changedBy: ACTOR, expectedVersion: 0,
    reason: 'CO09 availability fixture', view: 'BASIC', description: `CO09 ${materialNumber}`,
    materialType: 'RAW', materialGroup: 'RAW', baseUnit, industrySector: 'M', barcode: '',
    grossWeight: '0', netWeight: '0', weightUnit: '', isBlocked: false,
  });
  // The MRP view is judged against the plant view's own version, which has not been
  // opened yet, so 0 is the honest expectation for a first plant-level save.
  await saveMaterialView({
    client: tenant.client, materialNumber, changedBy: ACTOR, expectedVersion: 0,
    reason: 'CO09 availability fixture', view: 'MRP', plant: PLANT,
    mrpType, mrpController: '001', procurementType: 'BUY', lotSizing: 'EXACT',
    fixedLotSize: '0', minimumLotSize: '0', maximumLotSize: '0', safetyStock, reorderPoint: '0',
    plannedDeliveryDays: 0, inHouseProductionDays: 0,
  });
}

async function run(order: string, extra: { item?: string; horizonEnd?: string } = {}): Promise<OrderAvailabilityResult> {
  return checkOrderAvailability({
    client: tenant.client,
    orderNumber: order,
    itemNumber: extra.item ?? null,
    today: TODAY,
    horizonEnd: extra.horizonEnd ?? null,
  });
}

function component(result: OrderAvailabilityResult, item: string) {
  const found = result.components.find((row) => row.itemNumber === item);
  if (!found) throw new Error(`The result carries no component item ${item}.`);
  return found;
}

async function setScope(overrides: Partial<Omit<ScopeOfCheckRow, 'checkingGroup' | 'checkingRule' | 'version'>> = {}) {
  const { scopes } = await listAvailabilityCheck(tenant.client);
  const current = scopes.find((row) => row.checkingGroup === GROUP && row.checkingRule === RULE);
  await saveScopeOfCheck({
    client: tenant.client,
    changedBy: ACTOR,
    mode: current ? 'CHANGE' : 'CREATE',
    checkingGroup: GROUP,
    checkingRule: RULE,
    ...SCOPE_DEFAULTS,
    ...overrides,
    version: current?.version ?? 0,
    reason: 'CO09 availability fixture',
  });
}

async function setControl(input: { orderType: string; businessFunction: string; noCheck: string; checkingRule: string }) {
  const { controls } = await listCheckingControls(tenant.client);
  const current = controls.find((row) => row.plant === PLANT && row.orderType === input.orderType && row.businessFunction === input.businessFunction);
  await saveCheckingControl({
    client: tenant.client,
    changedBy: ACTOR,
    mode: current ? 'CHANGE' : 'CREATE',
    plant: PLANT,
    checkOnSave: ' ',
    version: current?.version ?? 0,
    reason: 'CO09 availability fixture',
    ...input,
  });
}

async function setSafetyStock(materialNumber: string, value: string) {
  await withTenant(tenant.client, (tx) => tx.execute(sql`
    update material_plant set safety_stock = ${value}::numeric
     where client = ${tenant.client} and material_number = ${materialNumber} and plant = ${PLANT}
  `));
}

/** A fingerprint of every table this check reads, plus the change documents it must not write. */
const WATCHED_TABLES = [
  'production_order', 'production_order_component', 'mrp_dependent_requirement', 'planned_order',
  'material', 'material_plant', 'material_bom', 'material_bom_item',
  'availability_checking_group', 'availability_checking_rule', 'availability_check_scope', 'production_checking_control',
  'purchase_requisition_item', 'reservation_header', 'reservation_item', 'stock_quantity',
  'material_document', 'material_document_line', 'change_document', 'change_document_item',
];

async function fingerprint(): Promise<string> {
  return withTenant(tenant.client, async (tx) => {
    const parts: string[] = [];
    for (const table of WATCHED_TABLES) {
      const [row] = await tx.execute(sql`
        select count(*)::text as rows,
               coalesce(md5(string_agg(t::text, '|' order by t::text)), '') as digest
          from ${sql.identifier(table)} t
      `) as unknown as Array<{ rows: string; digest: string }>;
      parts.push(`${table}=${row?.rows ?? '?'}:${row?.digest ?? '?'}`);
    }
    return parts.join(';');
  });
}

describe('CO09 slice 1 order availability check', () => {
  beforeAll(async () => {
    tenant = await createTenant('co09-avail');
    other = await createTenant('co09-avail-b');

    await withTenant(tenant.client, async (tx) => {
      await tx.insert(mrpController).values({
        client: tenant.client, controller: '001', name: 'Controller 001', isActive: true, createdBy: ACTOR,
      }).onConflictDoNothing();
      await tx.execute(sql`
        insert into plant (client, plant, name, company_code, country, created_by)
        values (${tenant.client}, ${PLANT}, 'Plant Q90', ${tenant.companyCode}, 'KW', ${ACTOR})
        on conflict (client, plant) do update set company_code = excluded.company_code
      `);
      await tx.execute(sql`
        insert into storage_location (client, plant, storage_location, name, is_active, created_by)
        values (${tenant.client}, ${PLANT}, 'SL90', 'Store 90', true, ${ACTOR}) on conflict do nothing
      `);
      await tx.execute(sql`
        insert into purchasing_group (client, purchasing_group, name, created_by)
        values (${tenant.client}, 'G90', 'CO09 fixture group', ${ACTOR}) on conflict do nothing
      `);
      await tx.execute(sql`
        insert into production_order_type (client, order_type, description, order_category, created_by)
        values (${tenant.client}, ${TYPE_ORDER}, 'Standard production', '10', ${ACTOR}),
               (${tenant.client}, ${TYPE_NO_CONTROL}, 'Second production type', '10', ${ACTOR})
        on conflict do nothing
      `);
      await defineRange(tx, { client: tenant.client, objectCode: 'PRODORDER', subObject: '*', prefix: 'PRD', numberLength: 7, createdBy: ACTOR });
    });

    // Materials: one per answer the check must give.
    await material('FG-CO09', 'KG', 'REQUIREMENTS', '0');
    await material('C-OK', 'KG', 'REQUIREMENTS', '0');
    await material('C-PH', 'KG', 'REQUIREMENTS', '0');
    await material('C-BULK', 'KG', 'REQUIREMENTS', '0');
    await material('C-DELL', 'KG', 'REQUIREMENTS', '0');
    await material('C-BARE', 'KG', 'REQUIREMENTS', '0');
    await material('C-NOP', 'KG', 'REQUIREMENTS', '0');
    await material('C-NOMRP', 'KG', 'NONE', '0');
    await material('C-NOGROUP', 'KG', 'REQUIREMENTS', '0');
    await material('C-NOSCOPE', 'KG', 'REQUIREMENTS', '0');
    await material('C-GNOP', 'KG', 'REQUIREMENTS', '0');
    await material('C-UOM', 'PC', 'REQUIREMENTS', '0');

    // The configuration, through the services that maintain it. A rule that no screen
    // can create is not used here.
    await saveCheckingRule({ client: tenant.client, changedBy: ACTOR, mode: 'CREATE', checkingRule: RULE, description: 'Production', version: 0, reason: 'CO09 fixture' });
    await saveCheckingGroup({ client: tenant.client, changedBy: ACTOR, mode: 'CREATE', checkingGroup: GROUP, description: 'Checked', noCheck: ' ', version: 0, reason: 'CO09 fixture' });
    await saveCheckingGroup({ client: tenant.client, changedBy: ACTOR, mode: 'CREATE', checkingGroup: GROUP_NOCHECK, description: 'Not checked', noCheck: 'X', version: 0, reason: 'CO09 fixture' });
    await saveCheckingGroup({ client: tenant.client, changedBy: ACTOR, mode: 'CREATE', checkingGroup: GROUP_NOSCOPE, description: 'No scope pair', noCheck: ' ', version: 0, reason: 'CO09 fixture' });
    await setScope();
    for (const materialNumber of ['C-OK', 'C-PH', 'C-BULK', 'C-DELL', 'C-BARE', 'C-NOMRP', 'C-UOM']) {
      const { assignments } = await listAvailabilityCheck(tenant.client);
      const current = assignments.find((row) => row.materialNumber === materialNumber && row.plant === PLANT);
      await assignCheckingGroup({
        client: tenant.client, changedBy: ACTOR, materialNumber, plant: PLANT, checkingGroup: GROUP,
        expectedVersion: current?.version ?? 0, reason: 'CO09 fixture',
      });
    }
    for (const [materialNumber, group] of [['C-GNOP', GROUP_NOCHECK], ['C-NOSCOPE', GROUP_NOSCOPE]] as const) {
      const { assignments } = await listAvailabilityCheck(tenant.client);
      const current = assignments.find((row) => row.materialNumber === materialNumber && row.plant === PLANT);
      await assignCheckingGroup({
        client: tenant.client, changedBy: ACTOR, materialNumber, plant: PLANT, checkingGroup: group,
        expectedVersion: current?.version ?? 0, reason: 'CO09 fixture',
      });
    }
    await setControl({ orderType: TYPE_ORDER, businessFunction: '1', noCheck: ' ', checkingRule: RULE });
    // PP02 is controlled only for release, which is what makes the order's status matter.
    await setControl({ orderType: TYPE_NO_CONTROL, businessFunction: '2', noCheck: ' ', checkingRule: RULE });

    // The bill of material the order's snapshot points at: the phantom, bulk and
    // deletion flags live on these items and nowhere else.
    await saveBomUsage({
      client: tenant.client, changedBy: ACTOR, usage: 'P', description: 'Production',
      productionRelevance: '.', engineeringRelevance: '.', costingRelevance: '.', salesRelevance: '.',
    });
    await saveBomItemCategory({ client: tenant.client, changedBy: ACTOR, category: 'S', description: 'Stock', materialEntry: '+', quantityEntry: '+', allowPhantom: 'X', allowBulk: 'X' });
    await createMaterialBom({
      client: tenant.client, changedBy: ACTOR, materialNumber: 'FG-CO09', plant: PLANT, usage: 'P',
      alternative: '01', baseQuantity: '1', baseUnit: 'KG', validFrom: '2026-01-01',
      items: [
        { itemNumber: '0010', itemCategory: 'S', componentMaterial: 'C-PH', quantity: '1', unit: 'KG', phantom: 'X' },
        { itemNumber: '0020', itemCategory: 'S', componentMaterial: 'C-BULK', quantity: '1', unit: 'KG', bulkMaterial: 'X' },
        { itemNumber: '0030', itemCategory: 'S', componentMaterial: 'C-DELL', quantity: '1', unit: 'KG', deletionFlag: 'X' },
        { itemNumber: '0040', itemCategory: 'S', componentMaterial: 'C-OK', quantity: '10', unit: 'KG' },
      ],
    });

    // Supply and demand for C-OK first: the order may name the planned order it was
    // converted from, and that key is a foreign key, not a note.
    await withTenant(tenant.client, async (tx) => {
      await tx.execute(sql`
        insert into stock_quantity (client, material_number, plant, storage_location, stock_type, quantity, created_by) values
          (${tenant.client}, 'C-OK', ${PLANT}, 'SL90', 'UNRESTRICTED', 2, ${ACTOR}),
          (${tenant.client}, 'C-OK', ${PLANT}, 'SL90', 'BLOCKED', 9, ${ACTOR})
      `);
      await tx.execute(sql`
        insert into purchase_requisition_item (client, requisition_number, item_number, short_text, quantity, unit,
                                               requisition_date, delivery_date, plant, purchasing_group, material_number, created_by) values
          (${tenant.client}, '900010', 1, 'future supply', 5, 'KG', '2026-05-02', '2026-06-05', ${PLANT}, 'G90', 'C-OK', ${ACTOR}),
          (${tenant.client}, '900011', 1, 'past supply', 4, 'KG', '2026-04-02', '2026-05-20', ${PLANT}, 'G90', 'C-OK', ${ACTOR})
      `);
      await tx.execute(sql`
        insert into planned_order (client, order_number, material_number, plant, quantity, unit, start_date, finish_date,
                                   firming_status, origin, request_key, created_by) values
          (${tenant.client}, 'PL-Q90-A', 'C-OK', ${PLANT}, 14, 'KG', '2026-06-15', '2026-06-18', 'FIRMED', 'MRP', ${`co09-pl-a-${key}`}, ${ACTOR}),
          (${tenant.client}, 'PL-Q90-B', 'C-OK', ${PLANT}, 10, 'KG', '2026-06-17', '2026-06-20', 'OPEN', 'MRP', ${`co09-pl-b-${key}`}, ${ACTOR}),
          (${tenant.client}, 'PL-DR-1', 'FG-CO09', ${PLANT}, 1, 'KG', '2026-06-11', '2026-06-12', 'OPEN', 'MANUAL', ${`co09-pl-c-${key}`}, ${ACTOR})
      `);
      await tx.execute(sql`
        insert into mrp_dependent_requirement (client, parent_order_number, source_material, item_number, material_number,
                                               plant, quantity, unit, requirement_date, parent_material, status, created_by) values
          (${tenant.client}, 'PL-DR-1', 'FG-CO09', '0010', 'C-OK', ${PLANT}, 6, 'KG', '2026-06-09', 'FG-CO09', 'OPEN', ${ACTOR})
      `);
      // A reservation names a movement type, and that key is a foreign key.
      await tx.execute(sql`
        insert into movement_type (client, movement_type, description, direction, reference_category, created_by)
        values (${tenant.client}, 'PROD_ISSUE_ORDER', 'Component issue for an order', 'ISSUE', 'RESERVATION', ${ACTOR})
        on conflict do nothing
      `);
      await tx.execute(sql`
        insert into reservation_header (client, reservation_number, movement_type, base_date, created_by) values
          (${tenant.client}, '910001', 'PROD_ISSUE_ORDER', '2026-06-07', ${ACTOR})
      `);
      await tx.execute(sql`
        insert into reservation_item (client, reservation_number, item_number, material_number, plant,
                                     required_quantity, unit_of_measure, created_by) values
          (${tenant.client}, '910001', 1, 'C-OK', ${PLANT}, 3, 'KG', ${ACTOR})
      `);
    });

    const supplied = (materialNumber: string, requiredQuantity: number) => ({
      materialNumber, plant: PLANT, requiredQuantity,
    });
    const created = await createProductionOrder({
      client: tenant.client, createdBy: ACTOR, materialNumber: 'FG-CO09', plant: PLANT,
      orderQuantity: 5, scheduledStart: '2026-06-02', scheduledFinish: '2026-06-20', orderType: TYPE_ORDER,
      requestKey: `co09-${++key}`,
      components: [
        supplied('C-OK', 10), supplied('C-PH', 5), supplied('C-BULK', 5), supplied('C-DELL', 5),
        supplied('C-UOM', 5), supplied('C-NOMRP', 5), supplied('C-NOGROUP', 5), supplied('C-NOSCOPE', 5),
        supplied('C-GNOP', 5), supplied('C-BARE', 1), supplied('C-OK', 4),
      ],
    });
    orderOne = created.orderNumber;
    const created2 = await createProductionOrder({
      client: tenant.client, createdBy: ACTOR, materialNumber: 'FG-CO09', plant: PLANT,
      orderQuantity: 1, scheduledStart: '2026-06-02', scheduledFinish: '2026-06-20', orderType: TYPE_NO_CONTROL,
      requestKey: `co09-${++key}`, components: [supplied('C-OK', 2)],
    });
    orderTwo = created2.orderNumber;
    const created3 = await createProductionOrder({
      client: tenant.client, createdBy: ACTOR, materialNumber: 'FG-CO09', plant: PLANT,
      orderQuantity: 1, scheduledStart: '2026-06-02', scheduledFinish: '2026-06-20', orderType: TYPE_ORDER,
      requestKey: `co09-${++key}`, components: [supplied('C-OK', 10)],
    }, { plannedOrderNumber: 'PL-DR-1' });
    orderThree = created3.orderNumber;

    const supplyA = await createProductionOrder({
      client: tenant.client, createdBy: ACTOR, materialNumber: 'C-OK', plant: PLANT,
      orderQuantity: 5, scheduledStart: '2026-06-01', scheduledFinish: '2026-06-05', orderType: TYPE_ORDER,
      requestKey: `co09-${++key}`, components: [supplied('C-NOP', 1)],
    });
    supplyReleased = supplyA.orderNumber;
    const supplyB = await createProductionOrder({
      client: tenant.client, createdBy: ACTOR, materialNumber: 'C-OK', plant: PLANT,
      orderQuantity: 5, scheduledStart: '2026-06-01', scheduledFinish: '2026-06-06', orderType: TYPE_ORDER,
      requestKey: `co09-${++key}`, components: [supplied('C-NOP', 1)],
    });
    supplyCreated = supplyB.orderNumber;
    await releaseProductionOrder({ client: tenant.client, orderNumber: supplyReleased, releasedBy: ACTOR });

    await withTenant(tenant.client, async (tx) => {
      // A bill-of-material item is flagged for deletion by a change of its own, and a
      // created item is born unflagged: the mark is applied the way the screen applies it.
      await tx.execute(sql`
        update material_bom_item set deletion_flag = 'X'
         where client = ${tenant.client} and material_number = 'FG-CO09' and plant = ${PLANT}
           and usage = 'P' and alternative = '01' and component_material = 'C-DELL'
      `);
      // The state planned-order conversion leaves behind: a dated component line that
      // names the bill-of-material item it came from, and the header's BOM keys.
      // The header's bill-of-material identity is all three keys or none, which is
      // what the check on production_order enforces.
      await tx.execute(sql`
        update production_order
           set bom_usage = 'P', bom_alternative = '01', production_version = 'V01'
         where client = ${tenant.client} and order_number = ${orderOne}
      `);
      await tx.execute(sql`
        update production_order_component set requirement_date = ${REQ}
         where client = ${tenant.client} and order_number = ${orderOne} and item_number < 110
      `);
      await tx.execute(sql`
        update production_order_component set unit_of_measure = 'KG'
         where client = ${tenant.client} and order_number = ${orderOne} and material_number = 'C-UOM'
      `);
      await tx.execute(sql`
        update production_order_component c set bom_item = b.item_number, source_material = 'FG-CO09'
         from material_bom_item b
        where c.client = ${tenant.client} and c.order_number = ${orderOne}
          and c.material_number = b.component_material and b.client = ${tenant.client}
          and b.material_number = 'FG-CO09' and b.plant = ${PLANT} and b.usage = 'P' and b.alternative = '01'
      `);
      // The other two orders consume the same component on days of their own, later than the
      // checked line, so the figures each order is answered with do not depend on who inside a
      // day the list cannot order.
      await tx.execute(sql`
        update production_order_component set requirement_date = '2026-06-12'
         where client = ${tenant.client} and order_number = ${orderTwo}
      `);
      await tx.execute(sql`
        update production_order_component set requirement_date = '2026-06-14'
         where client = ${tenant.client} and order_number = ${orderThree}
      `);

    });
  }, 120_000);

  afterAll(async () => {
    await destroyTenant(tenant.client);
    await destroyTenant(other.client);
    await closeDb();
  });

  it('answers a covered component with the elements that cover it, and no committed quantity', async () => {
    await setScope();
    const result = await run(orderOne, { item: '10' });
    const row = component(result, '10');
    // 2 stock + 4 past requisition + 5 requisition - 3 reservation + 5 + 5 orders - 6 other demand = 12
    expect(row.cumulatedAtp).toBe(12);
    expect(row.coveredQuantity).toBe(10);
    expect(row.shortageQuantity).toBe(0);
    expect(row.outcome).toBe('AVAILABLE');
    expect(row.earliestFullCoverageDate).toBe(REQ);
    expect(row.scopeKey).toBe(`${GROUP}/${RULE}`);
    expect(row.checkingGroup).toBe(GROUP);
    expect(row.checkingRule).toBe(RULE);
    // The distinction the audit asks for: a committed quantity is not stored at all,
    // so it is null on a line that is otherwise fully answered.
    expect(row.committedQuantity).toBeNull();
    expect(row.elements.some((element) => element.elementType === 'STOCK')).toBe(true);
    expect(row.elements.some((element) => element.elementType === 'PURCHASE_REQUISITION')).toBe(true);
    expect(row.elements.some((element) => element.elementType === 'RESERVATION')).toBe(true);
  });

  it('takes its dated elements from the stock/requirements list, not a second engine', async () => {
    await setScope();
    const row = component(await run(orderOne, { item: '10' }), '10');
    const list = await stockRequirementsList({
      client: tenant.client, today: TODAY, selection: { material: 'C-OK', plant: PLANT, periodSplit: 'DAILY', displayPastDue: true },
    });
    for (const element of row.elements) {
      const source = list.rows.find((r) => r.date === element.date && r.elementType === element.elementType
        && r.documentNumber === element.documentNumber && r.documentItem === element.documentItem);
      expect(source, `${element.elementType} ${element.documentNumber}`).toBeDefined();
      expect(element.quantity).toBe(Number(source!.quantity.toFixed(3)));
    }
    // A scope that counts everything keeps every element the list drew, in order.
    expect(row.elements.length).toBe(list.rows.length);
    expect(row.elements.filter((e) => e.ownDemand)).toHaveLength(1);
  });

  it('reports a shortage and the first date the counted elements cover it', async () => {
    await setScope({ receiptsInPast: 'B' });
    const row = component(await run(orderOne, { item: '10' }), '10');
    // past receipt no longer counts: 12 - 4 = 8 of 10 required
    expect(row.cumulatedAtp).toBe(8);
    expect(row.outcome).toBe('SHORT');
    expect(row.shortageQuantity).toBe(2);
    expect(row.earliestFullCoverageDate).toBe('2026-06-18');
    expect(row.warnings.join(' ')).toContain('future receipts only');
    expect(row.warnings.join(' ')).toContain('900011');
  });

  it('counts firmed planned orders only under the A switch, and none under blank', async () => {
    await setScope({ receiptsInPast: 'B', plannedOrders: 'A' });
    const firmed = component(await run(orderOne, { item: '10' }), '10');
    expect(firmed.earliestFullCoverageDate).toBe('2026-06-18'); // PL-Q90-A is FIRMED
    expect(firmed.elements.filter((e) => e.elementType === 'PLANNED_ORDER').map((e) => e.documentNumber)).toEqual(['PL-Q90-A']);

    await setScope({ receiptsInPast: 'B', plannedOrders: ' ' });
    const none = component(await run(orderOne, { item: '10' }), '10');
    expect(none.outcome).toBe('SHORT');
    expect(none.shortageQuantity).toBe(2);
    expect(none.earliestFullCoverageDate).toBeNull();
    expect(none.elements.some((e) => e.elementType === 'PLANNED_ORDER')).toBe(false);
    expect(none.message).toContain('within the elements shown');
  });

  it('counts released production orders only under the F switch', async () => {
    await setScope({ productionOrders: 'X' });
    const both = component(await run(orderOne, { item: '10' }), '10');
    expect(both.cumulatedAtp).toBe(12);
    expect(both.elements.filter((e) => e.elementType === 'PRODUCTION_ORDER').map((e) => e.documentNumber))
      .toEqual([supplyReleased, supplyCreated]); // the list orders receipts by their finish date

    await setScope({ productionOrders: 'F' });
    const releasedOnly = component(await run(orderOne, { item: '10' }), '10');
    expect(releasedOnly.cumulatedAtp).toBe(7); // the created supply order is not coverage under F
    expect(releasedOnly.shortageQuantity).toBe(3);
    expect(releasedOnly.elements.filter((e) => e.elementType === 'PRODUCTION_ORDER').map((e) => e.documentNumber))
      .toEqual([supplyReleased]);
  });

  it('never lets a requirement cover itself, and counts another order’s demand', async () => {
    await setScope();
    const own = component(await run(orderOne, { item: '10' }), '10');
    const ownRows = own.elements.filter((element) => element.ownDemand);
    expect(ownRows).toHaveLength(1);
    expect(ownRows[0]!.elementType).toBe('PRODUCTION_COMPONENT');
    expect(ownRows[0]!.documentNumber).toBe(orderOne);
    expect(own.cumulatedAtp).toBe(12);

    // Order three was converted from PL-DR-1, so that planned order's dependent
    // requirement is its own demand: it must not reduce the order's coverage twice.
    const converted = component(await run(orderThree, { item: '10' }), '10');
    // What is left for order three on 2026-06-14: 21 of supply, less the reservation of 3,
    // order one's 10 and order two's 2 — 6 units. Its own 10 units of demand are not netted
    // against it: the component line, and the dependent requirement of the planned order it
    // was converted from, are the demand being checked. Without that exclusion the balance
    // would read −10 and the shortage 20 rather than 4.
    expect(converted.cumulatedAtp).toBe(6);
    expect(converted.outcome).toBe('SHORT');
    expect(converted.shortageQuantity).toBe(4);
    expect(converted.earliestFullCoverageDate).toBe('2026-06-18');
    const ownDemand = converted.elements.filter((element) => element.ownDemand).map((element) => element.elementType);
    expect(ownDemand.sort()).toEqual(['DEPENDENT_REQUIREMENT', 'PRODUCTION_COMPONENT']);
  });

  it('excludes only the line being checked, and nets the order’s other lines against it', async () => {
    await setScope();
    // The control, taken before anything is added: item 10 is the order's only dated line
    // of C-OK, so its own 10 is left out of its own coverage exactly once — the balance is
    // 12, not the 2 that netting the same line a second time would give.
    const alone = component(await run(orderOne, { item: '10' }), '10');
    const aloneOwn = alone.elements.filter((element) => element.ownDemand);
    expect(aloneOwn).toHaveLength(1);
    expect(aloneOwn[0]!.documentItem).toBe('10');
    expect(alone.cumulatedAtp).toBe(12);
    expect(alone.coveredQuantity).toBe(10);
    expect(alone.outcome).toBe('AVAILABLE');

    // Now a second dated C-OK line on the same order: two requirements of 10 each against
    // the same 12. The check may not answer by letting each line claim the whole opening.
    await withTenant(tenant.client, async (tx) => {
      await tx.execute(sql`
        insert into production_order_component
          (client, order_number, item_number, material_number, plant, required_quantity, unit_of_measure, requirement_date, created_by)
        values (${tenant.client}, ${orderOne}, 120, 'C-OK', ${PLANT}, 10, 'KG', ${REQ}, ${ACTOR})
      `);
    });
    try {
      // Each of the two competing lines sees the other's demand and stands short by the
      // sibling's 10; neither is answered as though it were the order's only line.
      const checked = component(await run(orderOne, { item: '10' }), '10');
      const demand = checked.elements.filter((element) => element.elementType === 'PRODUCTION_COMPONENT');
      // The element list carries this order's two dated lines plus the other two orders'
      // C-OK lines: all four are shown, and only the checked one is not credited.
      expect(demand).toHaveLength(4);
      expect(demand.filter((element) => element.ownDemand)).toHaveLength(1);
      expect(demand.find((element) => element.ownDemand)?.documentItem).toBe('10');
      const fromThisOrder = demand.filter((element) => element.documentNumber === orderOne);
      expect(fromThisOrder.map((element) => element.documentItem).sort()).toEqual(['10', '120']);
      const sibling = fromThisOrder.find((element) => !element.ownDemand);
      expect(sibling?.documentItem).toBe('120');
      expect(sibling?.direction).toBe('REQUIREMENT');
      expect(sibling?.quantity).toBe(10);
      expect(checked.cumulatedAtp).toBe(2);
      expect(checked.coveredQuantity).toBe(2);
      expect(checked.shortageQuantity).toBe(8);
      expect(checked.outcome).toBe('SHORT');

      // The sibling is answered from its own exclusion, and so comes to the same figure.
      const other = component(await run(orderOne, { item: '120' }), '120');
      expect(other.cumulatedAtp).toBe(2);
      expect(other.outcome).toBe('SHORT');

      // All the order's lines at once: each line still excludes only itself, so the same
      // 12 is answered against both and the pair cannot double-count the opening.
      const both = await run(orderOne);
      let claimed = 0;
      for (const item of ['10', '120']) {
        const row = component(both, item);
        const own = row.elements.filter((element) => element.ownDemand);
        expect(own).toHaveLength(1);
        expect(own[0]!.documentItem).toBe(item);
        expect(row.outcome).toBe('SHORT');
        expect(row.cumulatedAtp).toBe(2);
        expect(row.shortageQuantity).toBe(8);
        claimed += row.coveredQuantity ?? 0;
      }
      expect(claimed).toBe(4);
      expect(claimed).toBeLessThanOrEqual(12);

      // The order's undated line is still refused before any quantity, as it was before the
      // sibling existed: the exclusion never turns an undated line into an answer.
      const undated = component(both, '110');
      expect(undated.outcome).toBe('UNDATED');
      expect(undated.cumulatedAtp).toBeNull();
      expect(undated.elements).toHaveLength(0);
    } finally {
      await withTenant(tenant.client, (tx) => tx.execute(sql`
        delete from production_order_component where client = ${tenant.client} and order_number = ${orderOne} and item_number = 120
      `));
    }
  });

  it('refuses a component line whose plant is not the order plant, before the list is asked', async () => {
    await setScope();
    const OTHER_PLANT = 'R80';
    await withTenant(tenant.client, async (tx) => {
      await tx.execute(sql`
        insert into plant (client, plant, name, company_code, country, created_by)
        values (${tenant.client}, ${OTHER_PLANT}, 'Plant R80', ${tenant.companyCode}, 'KW', ${ACTOR})
        on conflict (client, plant) do update set company_code = excluded.company_code
      `);
      // The component's own plant carries the material's plant view, so the scope of check
      // really is resolved there, and it holds 25 units of stock: the figure the wrong
      // plant would have been read from. The list itself runs at the order's plant.
      await tx.execute(sql`
        insert into material_plant (client, material_number, plant, checking_group, created_by)
        values (${tenant.client}, 'C-OK', ${OTHER_PLANT}, ${GROUP}, ${ACTOR})
        on conflict (client, material_number, plant) do update set checking_group = excluded.checking_group
      `);
      await tx.execute(sql`
        insert into stock_quantity (client, material_number, plant, stock_type, quantity, created_by)
        values (${tenant.client}, 'C-OK', ${OTHER_PLANT}, 'UNRESTRICTED', 25, ${ACTOR})
        on conflict (client, material_number, plant, storage_location, stock_type, batch_number)
          do update set quantity = excluded.quantity
      `);
      // Line 130 is C-OK at the other plant. Line 140 is a material extended only at the
      // order's plant, to show that neither plant is quietly substituted for the other.
      await tx.execute(sql`
        insert into production_order_component
          (client, order_number, item_number, material_number, plant, required_quantity, unit_of_measure, requirement_date, created_by)
        values
          (${tenant.client}, ${orderOne}, 130, 'C-OK', ${OTHER_PLANT}, 10, 'KG', ${REQ}, ${ACTOR}),
          (${tenant.client}, ${orderOne}, 140, 'C-NOP', ${OTHER_PLANT}, 4, 'KG', ${REQ}, ${ACTOR})
      `);
    });
    try {
      // The horizon ends before the check date, so any component that reached the list
      // would be answered with the list's own horizon refusal. That wording is absent
      // below, which is the proof that the line was refused before any list was called.
      const result = await run(orderOne, { item: '130', horizonEnd: '2026-05-20' });
      const cross = component(result, '130');
      expect(cross.outcome).toBe('UNSUPPORTED');
      expect(cross.message).toContain(OTHER_PLANT);
      expect(cross.message).toContain(PLANT);
      expect(cross.message ?? '').not.toContain('horizon');
      expect(cross.remedy ?? '').toContain(OTHER_PLANT);
      expect(cross.remedy ?? '').toContain(PLANT);
      expect(cross.checkingGroup).toBe(GROUP); // resolved at the component's own plant
      expect(cross.scopeKey).toBe(`${GROUP}/${RULE}`);
      expect(cross.requirementDate).toBe(REQ);
      expect(cross.cumulatedAtp).toBeNull();
      expect(cross.coveredQuantity).toBeNull();
      expect(cross.shortageQuantity).toBeNull();
      expect(cross.elements).toHaveLength(0);
      expect(result.refusedCount).toBe(1);
      expect(result.checkedCount).toBe(0);

      // A component whose material has no plant view at the component's plant is not
      // answered from the order's plant either: the refusal is the answer, not a guess.
      const unextended = component(await run(orderOne, { item: '140', horizonEnd: '2026-05-20' }), '140');
      expect(unextended.outcome).toBe('NO_GROUP');
      expect(unextended.message ?? '').not.toContain('horizon');

      // A component in the order's own plant is untouched by the new refusal, on the same
      // order that carries the cross-plant line.
      const same = component(await run(orderOne, { item: '10' }), '10');
      expect(same.outcome).toBe('AVAILABLE');
      expect(same.cumulatedAtp).toBe(12);
      expect(same.message ?? '').not.toContain(OTHER_PLANT);
    } finally {
      await withTenant(tenant.client, async (tx) => {
        await tx.execute(sql`
          delete from production_order_component
           where client = ${tenant.client} and order_number = ${orderOne} and item_number in (130, 140)
        `);
        await tx.execute(sql`delete from stock_quantity where client = ${tenant.client} and plant = ${OTHER_PLANT}`);
        await tx.execute(sql`delete from material_plant where client = ${tenant.client} and plant = ${OTHER_PLANT}`);
      });
    }
  });

  it('refuses to answer a technically complete order instead of a shortage it cannot see', async () => {
    // The availability list excludes the own demand and the dependent requirements of an order
    // that is technically complete; the ledger behind this check excludes them too. Reading the
    // remaining supply against the order that finished would publish a shortfall for demand the
    // plant stopped covering, so the refusal is the answer. The reference product's overview
    // marks such an order with a note rather than a figure, which is the reading this follows.
    await setScope();
    // Control: while the order is open the same call answers the line with a figure.
    const before = await run(orderThree);
    expect(before.checkedCount).toBe(1);
    expect(component(before, '10').requirementDate).toBe('2026-06-14');

    // A completed order resolves to the release-time checking control, which is what the delivered
    // code then answered from. The fixture keeps no control at business function 2 for this order
    // type, so one is created for the duration of this test and deleted again below rather than
    // left standing for the rest of the file.
    await setControl({ orderType: TYPE_ORDER, businessFunction: '2', noCheck: ' ', checkingRule: RULE });

    // Technical completion normally arrives through the order-change screen, which records who
    // completed the order and needs a release record to revoke it again. This check is read-only
    // and the order under test was never released, so the fixture states the persisted completion
    // directly - the pair of columns the table's own constraint binds to the status - and puts it
    // back below.
    await withTenant(tenant.client, (tx) => tx.execute(sql`
      update production_order
         set status = 'TECHNICALLY_COMPLETED', technically_completed_by = ${ACTOR}, technically_completed_at = now()
       where client = ${tenant.client} and order_number = ${orderThree}
    `));
    try {
      const result = await run(orderThree);
      // The claim first: a finished order is answered with no figure at all.
      expect(result.checkedCount).toBe(0);
      expect(result.components).toHaveLength(1);
      expect(result.components[0]!.outcome).toBe('UNSUPPORTED');
      expect(result.components[0]!.cumulatedAtp).toBeNull();
      expect(result.orderStatus).toBe('TECHNICALLY_COMPLETED');
      expect(result.businessFunction).toBe('2'); // the status still picks the release control
      expect(result.status).toBe('NOT_CHECKED');
      expect(result.configurationGap).toBe(false); // nothing is missing from the configuration
      expect(result.refusedCount).toBe(result.components.length);
      expect(result.message ?? '').toContain('technically complete');
      expect(result.message ?? '').toContain('no quantity is answered for a finished order');
      expect(result.remedy ?? '').toContain('Revoke');
      expect(result.warnings.join(' ')).toContain('and no element list is shown');
      for (const row of result.components) {
        expect(row.outcome).toBe('UNSUPPORTED');
        expect(row.cumulatedAtp).toBeNull();
        expect(row.coveredQuantity).toBeNull();
        expect(row.shortageQuantity).toBeNull();
        expect(row.elements).toHaveLength(0);      // the ledger is not displayed either
        expect(row.checkingRule).toBeNull();       // nothing was resolved for it
        expect(row.warnings.join(' ')).toContain('technically complete');
      }
    } finally {
      await withTenant(tenant.client, async (tx) => {
        await tx.execute(sql`
          update production_order
             set status = 'CREATED', technically_completed_by = null, technically_completed_at = null
           where client = ${tenant.client} and order_number = ${orderThree}
        `);
        await tx.execute(sql`
          delete from production_checking_control
           where client = ${tenant.client} and plant = ${PLANT} and order_type = ${TYPE_ORDER} and business_function = '2'
        `);
      });
    }

    // The order is answered again once the completion is revoked, with no residue of the refusal.
    const again = await run(orderThree);
    expect(again.status).not.toBe('NOT_CHECKED');
    expect(again.checkedCount).toBe(again.components.length); // every line is answerable again
    expect(again.components.every((row) => row.outcome !== 'UNSUPPORTED')).toBe(true);
    expect(again.configurationGap).toBe(false);
    expect(again.message).toBeNull();
    expect(again.warnings.join(' ')).not.toContain('technically complete');
    expect(again.components).toHaveLength(1);
    expect(component(again, '10').outcome).toBe(component(before, '10').outcome);
    expect(component(again, '10').cumulatedAtp).toBe(component(before, '10').cumulatedAtp);
  });

  it('refuses a horizon that stops before the requirement date it is asked to answer for', async () => {
    // The horizon end is a search bound on the stock/requirements list. When it stops before the
    // requirement date, the elements that answer that date are outside the bound, and a partial
    // ledger printed at the requirement date is not a verdict: a horizon of 2026-06-05 on a line
    // due 2026-06-10 counts the opening stock, two requisitions and two order receipts, and
    // answers AVAILABLE with a cumulated figure, while the same line inside the list's own
    // horizon is short.
    await setScope();
    const early = component(await run(orderOne, { item: '10', horizonEnd: '2026-06-05' }), '10');
    expect(early.outcome).toBe('UNSUPPORTED');
    expect(early.message ?? '').toContain('horizon');
    expect(early.message ?? '').toContain('2026-06-05');
    expect(early.message ?? '').toContain('2026-06-10');
    expect(early.message ?? '').toContain('before');
    expect(early.requirementDate).toBe('2026-06-10'); // the date the caller asked about is kept
    expect(early.cumulatedAtp).toBeNull();
    expect(early.coveredQuantity).toBeNull();
    expect(early.shortageQuantity).toBeNull();
    expect(early.earliestFullCoverageDate).toBeNull();
    expect(early.elements).toHaveLength(0);
    expect(early.warnings).toHaveLength(0);

    // A horizon that reaches the requirement date answers, however tight it is: the refusal is
    // about the date a figure is claimed for, not about the search being narrowed.
    const reaching = component(await run(orderOne, { item: '10', horizonEnd: '2026-06-10' }), '10');
    expect(reaching.outcome).toBe('AVAILABLE');
    expect(reaching.cumulatedAtp).toBe(12);

    // Every line of the order is refused on its own date, so the order reports nothing checked.
    const all = await run(orderOne, { horizonEnd: '2026-06-05' });
    expect(all.checkedCount).toBe(0);
    expect(all.status).toBe('NOT_CHECKED');
    expect(all.configurationGap).toBe(false);
    expect(all.components.filter((row) => row.outcome === 'UNDATED').length).toBe(1); // kept distinct
  });

  it('adds same-unit elements as they stand, with no caveat and nothing converted', async () => {
    await setScope();
    const withDocuments = component(await run(orderOne, { item: '10' }), '10');
    // Every counted row of this fixture stands in KG, the material's base unit, so the balance is
    // the list's own arithmetic: figure for figure what it was before the units were traced.
    expect(withDocuments.warnings.join(' ')).not.toContain('base unit');
    for (const element of withDocuments.elements) {
      expect(element.unit).toBe('KG');
      expect(element.convertedFrom).toBeNull();
    }

    await setScope({ purchaseRequisitions: ' ', purchaseOrders: ' ', plannedOrders: ' ', dependentRequirements: ' ' });
    const without = component(await run(orderOne, { item: '10' }), '10');
    expect(without.warnings.join(' ')).not.toContain('base unit');
    expect(without.elements.some((element) => element.elementType === 'PURCHASE_REQUISITION')).toBe(false);
    expect(typeof without.cumulatedAtp).toBe('number');

    // A refusal carries no unit warning: there is no figure for units to enter.
    const refused = component(await run(orderOne, { item: '110' }), '110');
    expect(refused.warnings).toHaveLength(0);
  });

  it('reports NOT_CHECKED when no line was answered, and keeps a configuration gap distinguishable', async () => {
    // All components refused for one reason the check can see: the header must not call a check
    // that answered nothing a partial one. The gap stays visible per component and as a warning.
    await setScope({ includeRestrictedUse: 'X' });
    const all = await run(orderOne, { item: '10' });
    expect(all.checkedCount).toBe(0);
    expect(all.refusedCount).toBe(1);
    expect(all.status).toBe('NOT_CHECKED');
    expect(all.configurationGap).toBe(false);
    expect(all.message).toBeNull(); // a component-level refusal is not an order-level one
    expect(all.warnings.join(' ')).toContain('No component of this order was answered with a figure');
    expect(all.components[0]!.outcome).toBe('UNSUPPORTED');
    expect(all.components[0]!.cumulatedAtp).toBeNull();
    expect(all.components[0]!.elements).toHaveLength(0);

    // A control that names no rule is the configuration's gap, not the operator's: same status,
    // different bucket, so the workbench can say whose problem it is.
    await setScope();
    await setControl({ orderType: TYPE_ORDER, businessFunction: '1', noCheck: ' ', checkingRule: '' });
    try {
      const gap = await run(orderOne, { item: '10' });
      expect(gap.checkedCount).toBe(0);
      expect(gap.status).toBe('NOT_CHECKED');
      expect(gap.configurationGap).toBe(true);
      expect(gap.message ?? '').toContain('names no checking rule');
      expect(gap.components[0]!.outcome).toBe('UNSUPPORTED');
      expect(gap.components[0]!.cumulatedAtp).toBeNull();
    } finally {
      await setControl({ orderType: TYPE_ORDER, businessFunction: '1', noCheck: ' ', checkingRule: RULE });
    }

    // A partly answered order keeps the partial status, with the same reason list.
    const part = await run(orderOne);
    expect(part.checkedCount).toBeGreaterThan(0);
    expect(part.refusedCount).toBeGreaterThan(0);
    expect(part.status).toBe('PARTIALLY_CHECKED');
    expect(part.configurationGap).toBe(false);
  });

  it('explains a shortfall that exceeds the line it was computed for', async () => {
    // The shortfall is the supply this line needs on top of the deficit that the demand dated
    // before it already left in the cumulated balance. That is the honest reading of a cumulated
    // availability figure, and it can exceed the required quantity: the stock here is 2.000
    // against 3.000 of reservation and 6.000 of open dependent requirement, so the balance in
    // front of the line is -7.000 before its own 10.000 is added. The number stays; the sentence
    // beside it must not let it be read as this line's unmet quantity alone.
    await setScope({ purchaseRequisitions: ' ', productionOrders: ' ' });
    const row = component(await run(orderOne, { item: '10' }), '10');
    expect(row.requiredQuantity).toBe(10);
    expect(row.cumulatedAtp).toBe(-7);
    expect(row.outcome).toBe('SHORT');
    expect(row.coveredQuantity).toBe(0);
    expect(row.shortageQuantity).toBe(17);
    expect((row.shortageQuantity ?? 0) > row.requiredQuantity).toBe(true);
    expect(row.earliestFullCoverageDate).toBeNull();
    expect(row.message ?? '').toContain('Short by 17.000');
    // The composition is stated, so the two figures cannot be mistaken for complements.
    expect(row.message ?? '').toContain('requirement of this line is 10.000');
    expect(row.message ?? '').toContain('deficit the demand dated before it');
    expect(row.coveredQuantity! + row.shortageQuantity!).not.toBe(row.requiredQuantity);

    // Control: a shortage that does not exceed the requirement keeps the terse sentence, so the
    // explanation is tied to the case and is not boilerplate on every shortfall.
    await setScope({ receiptsInPast: 'B' });
    const ordinary = component(await run(orderOne, { item: '10' }), '10');
    expect(ordinary.cumulatedAtp).toBe(8);
    expect(ordinary.shortageQuantity).toBe(2);
    expect(ordinary.coveredQuantity).toBe(8);
    expect(ordinary.message ?? '').toContain('Short by 2.000');
    expect(ordinary.message ?? '').not.toContain('deficit the demand dated before it');
    await setScope();
  });

  it('switches dependent requirements and reservations off when the scope says so', async () => {
    await setScope({ dependentRequirements: ' ' });
    const noDemand = component(await run(orderOne, { item: '10' }), '10');
    expect(noDemand.cumulatedAtp).toBe(18); // the other planned order's 6 is not counted
    expect(noDemand.elements.some((e) => e.elementType === 'DEPENDENT_REQUIREMENT')).toBe(false);
    expect(noDemand.elements.some((e) => e.elementType === 'PRODUCTION_COMPONENT')).toBe(false);

    await setScope({ reservations: ' ' });
    const noReservation = component(await run(orderOne, { item: '10' }), '10');
    expect(noReservation.cumulatedAtp).toBe(15);
    expect(noReservation.elements.some((e) => e.elementType === 'RESERVATION')).toBe(false);

    await setScope({ purchaseRequisitions: ' ' });
    const noRequisition = component(await run(orderOne, { item: '10' }), '10');
    expect(noRequisition.cumulatedAtp).toBe(3);
    expect(noRequisition.shortageQuantity).toBe(7);
    expect(noRequisition.elements.some((e) => e.elementType === 'PURCHASE_REQUISITION')).toBe(false);
  });

  it('counts safety stock as a demand only when the scope includes it', async () => {
    await setSafetyStock('C-OK', '5');
    try {
      await setScope({ includeSafetyStock: 'X' });
      const counted = component(await run(orderOne, { item: '10' }), '10');
      expect(counted.cumulatedAtp).toBe(7);
      expect(counted.outcome).toBe('SHORT');
      expect(counted.shortageQuantity).toBe(3);

      await setScope({ includeSafetyStock: ' ' });
      const ignored = component(await run(orderOne, { item: '10' }), '10');
      expect(ignored.cumulatedAtp).toBe(12);
      expect(ignored.outcome).toBe('AVAILABLE');
      expect(ignored.elements.some((e) => e.elementType === 'SAFETY_STOCK')).toBe(false);
    } finally {
      await setSafetyStock('C-OK', '0');
    }
  });

  it('refuses when no checking control stands, and says a missing record is not configured', async () => {
    const result = await run(orderTwo);
    expect(result.checkingRule).toBeNull();
    expect(result.message).toContain(`No checking control stands for plant ${PLANT}, order type ${TYPE_NO_CONTROL}, business function 1`);
    expect(result.remedy).toContain('Define Checking Control (OPJK)');
    expect(result.remedy).toContain('A missing record is not configured');
    expect(result.components.every((row) => row.outcome === 'UNSUPPORTED')).toBe(true);
    expect(result.components.every((row) => row.cumulatedAtp === null)).toBe(true);
  });

  it('answers the released order through business function 2', async () => {
    await releaseProductionOrder({ client: tenant.client, orderNumber: orderTwo, releasedBy: ACTOR });
    const result = await run(orderTwo);
    expect(result.businessFunction).toBe('2');
    expect(result.orderStatus).toBe('RELEASED');
    expect(result.checkingRule).toBe(RULE);
    expect(result.message).toBeNull();
    const row = component(result, '10');
    // 2 units on 2026-06-12, covered by what the 10 units of the first order leave there.
    expect(row.requiredQuantity).toBe(2);
    expect(row.outcome).toBe('AVAILABLE');
    expect(row.committedQuantity).toBeNull();
  });

  it('reports the no-check indicator as not checked rather than as covered', async () => {
    await setControl({ orderType: TYPE_ORDER, businessFunction: '1', noCheck: 'X', checkingRule: RULE });
    try {
      const result = await run(orderOne);
      expect(result.status).toBe('NOT_CHECKED');
      expect(result.message).toContain('marks this combination as not checked');
      expect(result.remedy).toContain('Clear the no-check indicator');
      expect(result.components.every((row) => row.outcome === 'NOT_CHECKED')).toBe(true);
      expect(result.components.every((row) => row.cumulatedAtp === null && row.shortageQuantity === null)).toBe(true);
    } finally {
      await setControl({ orderType: TYPE_ORDER, businessFunction: '1', noCheck: ' ', checkingRule: RULE });
    }
  });

  it('refuses a checking control that names no rule instead of defaulting one', async () => {
    await setControl({ orderType: TYPE_ORDER, businessFunction: '1', noCheck: ' ', checkingRule: '' });
    try {
      const result = await run(orderOne);
      expect(result.checkingRule).toBeNull();
      expect(result.message).toContain('names no checking rule');
      expect(result.remedy).toContain('A blank rule is not a default rule');
    } finally {
      await setControl({ orderType: TYPE_ORDER, businessFunction: '1', noCheck: ' ', checkingRule: RULE });
    }
  });

  it('refuses a component whose material carries no checking group', async () => {
    const row = component(await run(orderOne), '70');
    expect(row.outcome).toBe('NO_GROUP');
    expect(row.checkingGroup).toBeNull();
    expect(row.cumulatedAtp).toBeNull();
    expect(row.remedy).toContain('No group is not a default group');
  });

  it('refuses a component whose group and rule have no scope of check', async () => {
    const row = component(await run(orderOne), '80');
    expect(row.outcome).toBe('NO_SCOPE');
    expect(row.scopeKey).toBeNull();
    expect(row.message).toContain(`checking group ${GROUP_NOSCOPE}`);
    expect(row.message).toContain(`checking rule ${RULE}`);
    expect(row.remedy).toContain('No scope row is not an empty scope');
  });

  it('honours the no-check indicator on the checking group', async () => {
    const row = component(await run(orderOne), '90');
    expect(row.outcome).toBe('NOT_CHECKED');
    expect(row.message).toContain(`The checking group ${GROUP_NOCHECK} is marked as not checked`);
    expect(row.cumulatedAtp).toBeNull();
  });

  it('leaves an undated component undated rather than borrowing a date', async () => {
    const row = component(await run(orderOne), '110');
    expect(row.outcome).toBe('UNDATED');
    expect(row.requirementDate).toBeNull();
    expect(row.cumulatedAtp).toBeNull();
    expect(row.remedy).toContain('The order start, the order finish, today and the bill-of-material date are each rejected');
  });

  it('excludes phantom, bulk and deleted bill-of-material items, and says where the flags came from', async () => {
    const result = await run(orderOne);
    expect(component(result, '20').outcome).toBe('EXCLUDED');
    expect(component(result, '20').message).toContain('phantom item');
    expect(component(result, '30').outcome).toBe('EXCLUDED');
    expect(component(result, '30').message).toContain('bulk material');
    expect(component(result, '40').outcome).toBe('EXCLUDED');
    expect(component(result, '40').message).toContain('marked for deletion');
    expect(result.excludedCount).toBe(3);
    expect(result.warnings.join(' ')).toContain('only the phantom, bulk and deletion flags are read from it');
    // An excluded line is not a refusal, and it is not a shortage either.
    expect(result.refusedCount).toBe(result.components.filter((row) => row.outcome === 'UNSUPPORTED'
      || row.outcome === 'UNDATED' || row.outcome === 'NO_GROUP' || row.outcome === 'NO_SCOPE' || row.outcome === 'NOT_CHECKED').length);
  });

  it('refuses a quantity whose unit the check cannot compare', async () => {
    const row = component(await run(orderOne), '50');
    expect(row.outcome).toBe('UNSUPPORTED');
    expect(row.message).toContain('PC');
    expect(row.message).toContain('KG');
    expect(row.remedy).toContain('An unconverted comparison is not reported as an availability result');
  });

  // ── F7: the unit of every quantity that enters the cumulated balance ────────────
  // A counted element is one row of the stock/requirements list, and the list reads its
  // quantities out of seven document tables that each store a unit of their own. These four
  // cases are the whole of the question: a row already in the material's base unit is added
  // as it was (the case above), a row in another unit is converted by the conversion the
  // material carries, and a row that cannot be brought into that unit refuses the line.
  it('converts a counted element with the conversion the material carries, before cumulating it', async () => {
    await setScope();
    // C-UOM is kept in its own base unit here so that the *element* is what arrives in another
    // unit; the line-unit refusal is its own case further up.
    await withTenant(tenant.client, async (tx) => {
      await tx.execute(sql`
        update production_order_component set unit_of_measure = 'PC'
         where client = ${tenant.client} and order_number = ${orderOne} and material_number = 'C-UOM'
      `);
      await tx.execute(sql`
        insert into planned_order (client, order_number, material_number, plant, quantity, unit, start_date, finish_date,
                                   firming_status, origin, request_key, created_by) values
          (${tenant.client}, 'PL-UOM-1', 'C-UOM', ${PLANT}, 2, 'PAL', '2026-06-04', '2026-06-05',
           'FIRMED', 'MANUAL', 'co09-uom-convert', 'cairn')
      `);
      await tx.execute(sql`
        insert into material_uom_conversion (client, material_number, alternative_unit, base_unit,
                                              numerator, denominator, created_by) values
          (${tenant.client}, 'C-UOM', 'PAL', 'PC', 4, 1, 'cairn')
      `);
    });
    try {
      const row = component(await run(orderOne, { item: '50' }), '50');
      // Two pallets at 4/1 are eight pieces, which covers a requirement of five. Read as
      // "2" beside a requirement of "5" the same row would have said the line is short.
      expect(row.outcome).toBe('AVAILABLE');
      expect(row.cumulatedAtp).toBe(8);
      expect(row.coveredQuantity).toBe(5);
      expect(row.shortageQuantity).toBe(0);
      expect(row.earliestFullCoverageDate).toBe(REQ); // covered at the date it was checked for
      const planned = row.elements.find((element) => element.elementType === 'PLANNED_ORDER');
      expect(planned?.quantity).toBe(8);
      expect(planned?.unit).toBe('PC');
      expect(planned?.cumulated).toBe(8);
      expect(planned?.convertedFrom).toEqual({ quantity: 2, unit: 'PAL', factor: '4' });
      // The conversion is stated where the figure is read, not kept in the service alone.
      expect(row.warnings.join(' ')).toContain('2.000 PAL at 4 = 8.000 PC');
      expect(row.warnings.join(' ')).toContain('PL-UOM-1');
    } finally {
      await withTenant(tenant.client, async (tx) => {
        await tx.execute(sql`delete from planned_order where client = ${tenant.client} and order_number = 'PL-UOM-1'`);
        await tx.execute(sql`
          delete from material_uom_conversion
           where client = ${tenant.client} and material_number = 'C-UOM' and alternative_unit = 'PAL'
        `);
        await tx.execute(sql`
          update production_order_component set unit_of_measure = 'KG'
           where client = ${tenant.client} and order_number = ${orderOne} and material_number = 'C-UOM'
        `);
      });
    }
  });

  it('refuses a line whose counted element has no conversion, and publishes no figure and no element row', async () => {
    await setScope();
    await withTenant(tenant.client, async (tx) => {
      await tx.execute(sql`
        update production_order_component set unit_of_measure = 'PC'
         where client = ${tenant.client} and order_number = ${orderOne} and material_number = 'C-UOM'
      `);
      await tx.execute(sql`
        insert into planned_order (client, order_number, material_number, plant, quantity, unit, start_date, finish_date,
                                   firming_status, origin, request_key, created_by) values
          (${tenant.client}, 'PL-UOM-1', 'C-UOM', ${PLANT}, 2, 'PAL', '2026-06-04', '2026-06-05',
           'FIRMED', 'MANUAL', 'co09-uom-none', 'cairn')
      `);
    });
    try {
      const row = component(await run(orderOne, { item: '50' }), '50');
      expect(row.outcome).toBe('UNSUPPORTED');
      expect(row.cumulatedAtp).toBeNull();
      expect(row.coveredQuantity).toBeNull();
      expect(row.shortageQuantity).toBeNull();
      expect(row.earliestFullCoverageDate).toBeNull();
      expect(row.committedQuantity).toBeNull();
      expect(row.elements).toHaveLength(0);
      // The row that made the refusal is named with its own figure and unit, so the answer can
      // be acted on: an unnamed refusal would leave the reader hunting the list for it.
      expect(row.message).toContain('PLANNED_ORDER PL-UOM-1');
      expect(row.message).toContain('2.000 PAL');
      expect(row.message).toContain('no conversion from PAL to its base unit PC');
      expect(row.remedy).toContain('INV.STOCK.UOM');
      // A refusal states no quantity: neither a balance nor a shortage appears beside it.
      expect(row.warnings).toHaveLength(1);
      expect(row.message).not.toMatch(/cumulated (?:balance )?-?\d/);
    } finally {
      await withTenant(tenant.client, async (tx) => {
        await tx.execute(sql`delete from planned_order where client = ${tenant.client} and order_number = 'PL-UOM-1'`);
        await tx.execute(sql`
          update production_order_component set unit_of_measure = 'KG'
           where client = ${tenant.client} and order_number = ${orderOne} and material_number = 'C-UOM'
        `);
      });
    }
  });

  it('will not convert a netted receipt, because its figure is already a difference of two unit streams', async () => {
    await setScope();
    await withTenant(tenant.client, async (tx) => {
      await tx.execute(sql`
        update production_order_component set unit_of_measure = 'PC'
         where client = ${tenant.client} and order_number = ${orderOne} and material_number = 'C-UOM'
      `);
      await tx.execute(sql`
        insert into material_uom_conversion (client, material_number, alternative_unit, base_unit,
                                              numerator, denominator, created_by) values
          (${tenant.client}, 'C-UOM', 'PAL', 'PC', 4, 1, 'cairn')
      `);
      // A requisition is a netted element: the list opens it with the quantity of the orders
      // converted from it, and those stand in their own unit. Scaling the difference afterwards
      // would convert a number that is not a quantity of anything.
      await tx.execute(sql`
        insert into purchase_requisition_item (client, requisition_number, item_number, short_text, quantity, unit,
                                               requisition_date, delivery_date, plant, purchasing_group, material_number, created_by)
        values (${tenant.client}, '900050', 1, 'palletised supply', 5, 'PAL', '2026-05-02', '2026-06-06',
                ${PLANT}, 'G90', 'C-UOM', 'cairn')
      `);
    });
    try {
      const row = component(await run(orderOne, { item: '50' }), '50');
      expect(row.outcome).toBe('UNSUPPORTED');
      expect(row.cumulatedAtp).toBeNull();
      expect(row.elements).toHaveLength(0);
      expect(row.message).toContain('PURCHASE_REQUISITION 900050/1');
      expect(row.message).toContain('netted');
      // The conversion standing on the material is named as not the remedy for this one.
      expect(row.message).toContain('PAL');
      expect(row.message).toContain('PC');
    } finally {
      await withTenant(tenant.client, async (tx) => {
        await tx.execute(sql`
          delete from purchase_requisition_item
           where client = ${tenant.client} and requisition_number = '900050'
        `);
        await tx.execute(sql`
          delete from material_uom_conversion
           where client = ${tenant.client} and material_number = 'C-UOM' and alternative_unit = 'PAL'
        `);
        await tx.execute(sql`
          update production_order_component set unit_of_measure = 'KG'
           where client = ${tenant.client} and order_number = ${orderOne} and material_number = 'C-UOM'
        `);
      });
    }
  });

  it('refuses the line a foreign-unit element sits on, rather than adding it in or dropping it out', async () => {
    await setScope();
    await withTenant(tenant.client, async (tx) => {
      await tx.execute(sql`
        insert into planned_order (client, order_number, material_number, plant, quantity, unit, start_date, finish_date,
                                   firming_status, origin, request_key, created_by) values
          (${tenant.client}, 'PL-Q90-U', 'C-OK', ${PLANT}, 14, 'PAL', '2026-06-15', '2026-06-18',
           'FIRMED', 'MANUAL', 'co09-uom-poison', 'cairn')
      `);
    });
    try {
      const poisoned = component(await run(orderOne, { item: '10' }), '10');
      // Either reading of a mixed total is wrong: adding the row says 26.000, dropping it says
      // 12.000 as though the scope had no planned order to count. Both are refused.
      expect(poisoned.outcome).toBe('UNSUPPORTED');
      expect(poisoned.cumulatedAtp).toBeNull();
      expect(poisoned.elements).toHaveLength(0);
      expect(poisoned.message).toContain('PL-Q90-U');
      expect(poisoned.message).toContain('14.000 PAL');
      expect(poisoned.warnings.join(' ')).toContain('not published');

      // With the kind out of the scope there is nothing to convert, and the established
      // answer for this line returns figure for figure.
      await setScope({ plannedOrders: ' ' });
      const outside = component(await run(orderOne, { item: '10' }), '10');
      expect(outside.outcome).toBe('AVAILABLE');
      expect(outside.cumulatedAtp).toBe(12);
      expect(outside.coveredQuantity).toBe(10);
      expect(outside.shortageQuantity).toBe(0);
      expect(outside.warnings.join(' ')).not.toContain('base unit');
    } finally {
      await withTenant(tenant.client, async (tx) => {
        await tx.execute(sql`delete from planned_order where client = ${tenant.client} and order_number = 'PL-Q90-U'`);
      });
      await setScope();
    }
  });

  it('refuses a scope that splits stock by type, because the list does not', async () => {
    await setScope({ includeQualityStock: ' ' });
    const quality = component(await run(orderOne), '10');
    expect(quality.outcome).toBe('UNSUPPORTED');
    expect(quality.message).toContain('quality-inspection stock');

    await setScope({ includeBlockedStock: 'X' });
    const blocked = component(await run(orderOne), '10');
    expect(blocked.outcome).toBe('UNSUPPORTED');
    expect(blocked.message).toContain('blocked stock');

    // The third stock-type switch is "Include restricted-use batches" — the label the
    // maintaining form carries and the label the validator names. Unrestricted-use stock
    // has no inclusion switch in this scope at all, so a refusal may not name one.
    await setScope({ includeRestrictedUse: 'X' });
    const restricted = component(await run(orderOne), '10');
    expect(restricted.outcome).toBe('UNSUPPORTED');
    expect(restricted.message).toContain('restricted-use batches');
    expect(restricted.message).not.toContain('unrestricted-use stock is not included');
    expect(restricted.cumulatedAtp).toBeNull();
    expect(restricted.coveredQuantity).toBeNull();

    // A blank restricted-use switch asks for exactly what the list already counts, so it
    // is no reason to refuse; and the pair the check can answer with is answered.
    await setScope({ includeRestrictedUse: ' ' });
    const omitted = component(await run(orderOne), '10');
    expect(omitted.outcome).toBe('AVAILABLE');
    expect(omitted.message ?? '').not.toContain('restricted-use');
    expect(omitted.cumulatedAtp).toBe(12);

    await setScope();
    expect(component(await run(orderOne), '10').outcome).toBe('AVAILABLE');
  });

  it('hands the stock/requirements list’s own refusal back per component', async () => {
    await setScope();
    // The list refuses a horizon that ends before the check date, and that refusal is
    // the component's answer. No figure is invented in its place.
    const row = component(await run(orderOne, { item: '10', horizonEnd: '2026-05-20' }), '10');
    expect(row.outcome).toBe('UNSUPPORTED');
    expect(row.message).toContain('horizon');
    expect(row.cumulatedAtp).toBeNull();
    expect(row.elements).toHaveLength(0);
  });

  it('says so when only the stock element stands, and shows the gap it leaves', async () => {
    const row = component(await run(orderOne, { item: '100' }), '100');
    expect(row.requiredQuantity).toBe(1);
    expect(row.cumulatedAtp).toBe(0);
    expect(row.shortageQuantity).toBe(1);
    expect(row.outcome).toBe('SHORT');
    // Nothing the scope counts stands behind the line: only the opening balance and the
    // requirement being checked itself.
    expect(row.elements.every((element) => element.elementType === 'STOCK' || element.ownDemand)).toBe(true);
    expect(row.elements).toHaveLength(2);
    expect(row.earliestFullCoverageDate).toBeNull();
  });

  it('trims the search for a coverage date at the horizon it was given', async () => {
    await setScope({ receiptsInPast: 'B' });
    const short = component(await run(orderOne, { item: '10', horizonEnd: '2026-06-12' }), '10');
    expect(short.shortageQuantity).toBe(2);
    expect(short.earliestFullCoverageDate).toBeNull();
    // The planned receipts that would have covered it stand beyond the horizon shown.
    expect(short.elements.some((e) => e.elementType === 'PLANNED_ORDER')).toBe(false);
  });

  it('returns the same figures twice, because nothing was written', async () => {
    await setScope();
    const before = await fingerprint();
    const first = await run(orderOne);
    const second = await run(orderOne);
    const after = await fingerprint();

    expect(after).toBe(before);
    expect(first.calculatedAt).not.toBe(second.calculatedAt);
    expect({ ...first, calculatedAt: '' }).toEqual({ ...second, calculatedAt: '' });
    // The promise the screen makes about commitment, proved on the data.
    expect(first.components.every((row) => row.committedQuantity === null)).toBe(true);
    expect(first.components.filter((row) => row.cumulatedAtp !== null).length)
      .toBe(first.components.filter((row) => row.outcome === 'AVAILABLE' || row.outcome === 'SHORT' || row.outcome === 'NO_ELEMENTS').length);
  });

  it('writes no change document, no reservation and no order status', async () => {
    await setScope();
    const status = async (order: string) => withTenant(tenant.client, (tx) => tx.execute(sql`
      select status, version from production_order where client = ${tenant.client} and order_number = ${order}
    `)) as unknown as Promise<Array<{ status: string; version: number }>>;
    const before = await status(orderOne);
    await run(orderOne);
    await run(orderThree);
    expect(await status(orderOne)).toEqual(before);
    const counts = await withTenant(tenant.client, (tx) => tx.execute(sql`
      select (select count(*)::text from reservation_header where client = ${tenant.client}) as reservations,
             (select count(*)::text from material_document where client = ${tenant.client}) as documents,
             (select count(*)::text from mrp_dependent_requirement where client = ${tenant.client}) as requirements
    `)) as unknown as Array<{ reservations: string; documents: string; requirements: string }>;
    expect(counts).toEqual([{ reservations: '1', documents: '0', requirements: '1' }]);
  });

  it('keeps one tenant’s order out of another tenant’s reach', async () => {
    await expect(run(orderTwo, { item: '' })).resolves.toBeTruthy();
    await expect(checkOrderAvailability({ client: other.client, orderNumber: orderOne, today: TODAY }))
      .rejects.toThrow(/does not stand/);
    const foreign = await withTenant(other.client, (tx) => tx.execute(sql`
      select count(*)::text as rows from production_order where client = ${other.client}
    `)) as unknown as Promise<Array<{ rows: string }>>;
    expect(foreign).toEqual([{ rows: '0' }]);
  });

  it('refuses a selection that asks for something the check does not do', () => {
    expect(orderAvailabilityRefusal({})).toBeNull();
    const refusal = orderAvailabilityRefusal({ commit: '1', storageLocation: 'SL90' });
    expect(refusal).toContain('The check was not run.');
    expect(refusal).toContain('Committing a quantity is not this screen');
    expect(refusal).toContain('A storage-location level check is not this screen');
    expect(orderAvailabilityRefusal({ batch: '', rule: '' })).toBeNull();
  });

  it('needs both authorities, and reads nothing with one', () => {
    expect(holdsOrderAvailabilityAuthority([])).toBe(false);
    expect(holdsOrderAvailabilityAuthority([ORDER_AVAILABILITY_ORDER_CAPABILITY])).toBe(false);
    expect(holdsOrderAvailabilityAuthority([ORDER_AVAILABILITY_ELEMENTS_CAPABILITY])).toBe(false);
    expect(holdsOrderAvailabilityAuthority([ORDER_AVAILABILITY_ORDER_CAPABILITY, ORDER_AVAILABILITY_ELEMENTS_CAPABILITY])).toBe(true);
    expect(holdsOrderAvailabilityAuthority(['PROD.MRP.STOCKREQ', 'SOME.OTHER'])).toBe(false);
  });

  it('refuses a missing order, a bad date and an item the order does not carry', async () => {
    await expect(checkOrderAvailability({ client: tenant.client, orderNumber: '', today: TODAY }))
      .rejects.toThrow(OrderAvailabilityError);
    await expect(checkOrderAvailability({ client: tenant.client, orderNumber: '9999999', today: TODAY }))
      .rejects.toThrow(/does not stand in tenant/);
    await expect(run(orderOne, { item: '7777' })).rejects.toThrow(/no item 7777/);
    await expect(checkOrderAvailability({ client: tenant.client, orderNumber: orderOne, today: 'not-a-date' }))
      .rejects.toThrow(/not a date/);
  });
});
