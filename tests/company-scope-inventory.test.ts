/**
 * Company-scope authorization for inventory reads (adversarial): material document display and list.
 * Inventory is keyed by plant; a plant belongs to one company. Two companies (A 1000, B 2000), a plant that
 * names no company, a second tenant, and actors who hold the capability but not the company, no scope, no
 * capability, or a Plant scope. A capability alone must never reach another company's stock movements.
 */
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { withTenant } from '../src/platform/db/client';
import { displayMaterialDocument } from '../src/modules/inventory/material-document-display';
import { listMaterialDocuments } from '../src/modules/inventory/material-document-list';
import { changeMaterialPrice, listFuturePrices } from '../src/modules/inventory/price-change';
import { completeReservationItem, createReservation, getReservation, withdrawReservation } from '../src/modules/inventory/reservations';
import { stockOverview } from '../src/modules/inventory/stock-overview';
import { getCountDocument, getCountHistory, getCountStatus, searchCountDocuments, submitCounts } from '../src/modules/inventory/physical-inventory-count';
import { getDifferenceDocument, listDifferences } from '../src/modules/inventory/physical-inventory-differences';
import { getDifferencePosting, getPostingHistory, postDifferences, validateDifferencePosting } from '../src/modules/inventory/physical-inventory-posting';
import { createRecount, getRecountSource } from '../src/modules/inventory/physical-inventory-recount';
import { listWarehouseStocks } from '../src/modules/inventory/warehouse-stocks';
import { closeDb, createTenant, destroyTenant, type TestTenant } from './helpers';
import { createFinanceActor, type FinanceActor } from './helpers/finance-actor';

const A = '1000';
const B = '2000';
const SEED = 'SCOPE_INV_SEED';
const DOC_A = '4900000001';
const DOC_B = '4900000002';
const DOC_X = '4900000003';
const DOC_N = '4900000004';
const GONE = '4999999999';
const CAPS = ['INV.DISPLAY', 'INV.MATERIALDOC.LIST', 'INV.STOCK.VIEW', 'INV.STOCK.WAREHOUSE'];
const WINDOW = { postingDateFrom: '2026-04-01', postingDateTo: '2026-04-30', maxHits: 100 };

let tenant: TestTenant;
let other: TestTenant;
let client = '';
let onlyA: FinanceActor;
let onlyB: FinanceActor;
let both: FinanceActor;
let noCapability: FinanceActor;
let noScope: FinanceActor;
let plantA: FinanceActor;
let otherTenantActor: FinanceActor;

const show = (n: string, a: FinanceActor['authorization'] | undefined) => displayMaterialDocument({ client, documentNumber: n, authorization: a });
const list = (a: FinanceActor['authorization'] | undefined, selection = {}) => listMaterialDocuments({ client, selection: { ...WINDOW, ...selection }, authorization: a });
const ask = (p: Promise<unknown>) => p.then(() => 'done', (e: Error) => e.message);
const docs = (rows: Array<{ materialDocumentNumber: string }>) => [...new Set(rows.map((r) => r.materialDocumentNumber))].sort();

beforeAll(async () => {
  tenant = await createTenant('scope-inv');
  client = tenant.client;
  other = await createTenant('scope-inv-2');
  await withTenant(client, async (tx) => {
    await tx.execute(sql`
      insert into company_code (client, company_code, name, chart_of_accounts, fiscal_year_variant, posting_period_variant,
        currency, country, intercompany_clearing_account, created_by)
      select client, ${B}, 'B company', chart_of_accounts, fiscal_year_variant, posting_period_variant,
             currency, country, intercompany_clearing_account, ${SEED}
        from company_code where client = ${client} and company_code = ${A} on conflict do nothing`);
    for (const [plant, company] of [['PLA1', A], ['PLB1', B], ['PLN1', null]] as const) {
      await tx.execute(sql`insert into plant (client, plant, name, company_code, country, created_by) values (${client}, ${plant}, ${plant}, ${company}, 'US', ${SEED}) on conflict do nothing`);
    }
    await tx.execute(sql`insert into movement_type (client, movement_type, description, direction, reference_category, created_by)
      values (${client}, 'GOODS_RECEIPT_PO', 'Goods receipt', 'RECEIPT', 'PURCHASE_ORDER', ${SEED}) on conflict do nothing`);
    await tx.execute(sql`insert into material (client, material_number, description, material_type, base_unit, created_by)
      select ${client}, 'SCM1', 'Scope material', t.material_type, 'PC', ${SEED}
        from (select material_type from material_type where client = ${client} order by material_type limit 1) t on conflict do nothing`);
    for (const n of [DOC_A, DOC_B, DOC_X, DOC_N]) {
      await tx.execute(sql`insert into material_document (client, material_document_number, document_year, document_date, posting_date, header_text, status, created_by)
        values (${client}, ${n}, 2026, '2026-04-05', '2026-04-05', 'Scope doc', 'POSTED', ${SEED})`);
    }
    const line = async (doc: string, no: number, plant: string) => {
      await tx.execute(sql`insert into material_document_line (client, material_document_number, line_number, movement_type, material_number, plant,
          storage_location, stock_type, entry_quantity, entry_unit, base_quantity, base_unit, unit_price, price_unit, currency, value, created_by)
        values (${client}, ${doc}, ${no}, 'GOODS_RECEIPT_PO', 'SCM1', ${plant}, 'SL01', 'UNRESTRICTED', 1, 'PC', 1, 'PC', 10, 1, 'USD', 10, ${SEED})`);
    };
    for (const [plant, quantity] of [['PLA1', 11], ['PLB1', 22], ['PLN1', 33]] as const) {
      await tx.execute(sql`insert into stock_quantity (client, material_number, plant, storage_location, stock_type, quantity, created_by)
        values (${client}, 'SCM1', ${plant}, 'SL01', 'UNRESTRICTED', ${quantity}, ${SEED})`);
    }
    for (const plant of ['PLA1', 'PLB1']) {
      await tx.execute(sql`insert into material_valuation (client, material_number, valuation_area, valuation_class, price_control, standard_price, currency, created_by)
        select ${client}, 'SCM1', ${plant}, null, 'STANDARD', 5, c.currency, ${SEED}
          from company_code c where c.client = ${client} and c.company_code = ${A}`);
    }
    await tx.execute(sql`insert into movement_type (client, movement_type, description, direction, reference_category, created_by)
      values (${client}, 'RSV_ISSUE', 'Reservation issue', 'ISSUE', 'RESERVATION', ${SEED}) on conflict do nothing`);
    for (const [number, plant] of [['RSV00000A', 'PLA1'], ['RSV00000B', 'PLB1'], ['RSV00000X', 'PLA1']] as const) {
      await tx.execute(sql`insert into reservation_header (client, reservation_number, movement_type, base_date, created_by)
        values (${client}, ${number}, 'RSV_ISSUE', '2026-04-05', ${SEED})`);
      await tx.execute(sql`insert into reservation_item (client, reservation_number, item_number, material_number, plant, required_quantity, unit_of_measure, created_by)
        values (${client}, ${number}, 1, 'SCM1', ${plant}, 10, 'PC', ${SEED})`);
    }
    await tx.execute(sql`insert into reservation_item (client, reservation_number, item_number, material_number, plant, required_quantity, unit_of_measure, created_by)
      values (${client}, 'RSV00000X', 2, 'SCM1', 'PLB1', 10, 'PC', ${SEED})`);
    await line(DOC_A, 1, 'PLA1');
    await line(DOC_B, 1, 'PLB1');
    await line(DOC_X, 1, 'PLA1');
    await line(DOC_X, 2, 'PLB1');
    await line(DOC_N, 1, 'PLN1');
  });
  onlyA = await createFinanceActor(client, { capabilities: CAPS, companyScopes: [A] });
  onlyB = await createFinanceActor(client, { capabilities: CAPS, companyScopes: [B] });
  both = await createFinanceActor(client, { capabilities: CAPS, companyScopes: [A, B] });
  noCapability = await createFinanceActor(client, { capabilities: ['FIN.JOURNAL.DISPLAY'], companyScopes: [A, B] });
  noScope = await createFinanceActor(client, { capabilities: CAPS, companyScopes: [] });
  plantA = await createFinanceActor(client, { capabilities: CAPS, companyScopes: [A, B], plantScopes: ['PLA1'] });
  otherTenantActor = await createFinanceActor(other.client, { capabilities: CAPS });
}, 240_000);

afterAll(async () => {
  if (client) await destroyTenant(client);
  if (other) await destroyTenant(other.client);
  await closeDb();
}, 240_000);

describe('material document display', () => {
  it("shows a document only when every plant on it is in the session's scope", async () => {
    expect((await show(DOC_A, onlyA.authorization)).lines).toHaveLength(1);
    expect((await show(DOC_B, onlyB.authorization)).lines).toHaveLength(1);
    expect((await show(DOC_X, both.authorization)).lines).toHaveLength(2);
    expect((await show(DOC_A, plantA.authorization)).lines).toHaveLength(1);
  });

  it("answers another company's document, a mixed one and a plant outside the Plant scope as a missing one", async () => {
    const mask = (m: string, n: string) => m.replaceAll(n, '#');
    const missing = mask(await ask(show(GONE, onlyA.authorization)), GONE);
    expect(missing).toMatch(/does not exist/);
    for (const [n, a] of [[DOC_B, onlyA], [DOC_X, onlyA], [DOC_A, onlyB], [DOC_N, both], [DOC_B, plantA]] as const) {
      expect(mask(await ask(show(n, a.authorization)), n)).toBe(missing);
    }
  });

  it('refuses no session, no capability, no scope and another tenant', async () => {
    for (const a of [undefined, noCapability.authorization, noScope.authorization, otherTenantActor.authorization]) {
      const message = await ask(show(DOC_A, a));
      expect(message).not.toBe('done');
      expect(message).not.toMatch(/does not exist/);
    }
  });
});

describe('material document list', () => {
  it('lists only lines of plants the session may reach', async () => {
    expect(docs((await list(onlyA.authorization)).rows)).toEqual([DOC_A, DOC_X]);
    expect(docs((await list(onlyB.authorization)).rows)).toEqual([DOC_B, DOC_X]);
    expect(docs((await list(both.authorization)).rows)).toEqual([DOC_A, DOC_B, DOC_X]);
    expect(docs((await list(plantA.authorization)).rows)).toEqual([DOC_A, DOC_X]);
    // A document that mixes two companies shows only the reachable line.
    expect((await list(onlyA.authorization)).rows.filter((r) => r.materialDocumentNumber === DOC_X)).toHaveLength(1);
  });

  it('never lists a plant that names no company, and refuses an out-of-reach plant selection as unknown', async () => {
    expect(await ask(list(both.authorization, { plantFrom: 'PLN1', plantTo: 'PLN1' }))).toMatch(/does not stand/);
    expect(docs((await list(both.authorization)).rows)).not.toContain(DOC_N);
    const foreign = await ask(list(onlyA.authorization, { plantFrom: 'PLB1', plantTo: 'PLB1' }));
    const missing = await ask(list(onlyA.authorization, { plantFrom: 'PLZ9', plantTo: 'PLZ9' }));
    expect(foreign.replaceAll('PLB1', '#')).toBe(missing.replaceAll('PLZ9', '#'));
  });

  it('refuses no session, no capability, no scope and another tenant', async () => {
    for (const a of [undefined, noCapability.authorization, noScope.authorization, otherTenantActor.authorization]) {
      expect(await ask(list(a))).not.toBe('done');
    }
  });
});

describe('stock overview and warehouse stocks', () => {
  const overview = (a: FinanceActor['authorization'] | undefined, selection = {}) =>
    stockOverview({ client, selection: { material: 'SCM1', maxHits: 100, ...selection }, authorization: a });
  const warehouse = (a: FinanceActor['authorization'] | undefined, selection = {}) =>
    listWarehouseStocks({ client, localCurrency: 'USD', selection: { materialFrom: 'SCM1', materialTo: 'SCM1', maxHits: 100, ...selection }, authorization: a });
  const plantsOf = (r: { plants: Array<{ plant: string }> }) => r.plants.map((p) => p.plant).sort();

  it('shows only the stock of plants the session may reach', async () => {
    expect(plantsOf(await overview(onlyA.authorization))).toEqual(['PLA1']);
    expect(plantsOf(await overview(onlyB.authorization))).toEqual(['PLB1']);
    expect(plantsOf(await overview(both.authorization))).toEqual(['PLA1', 'PLB1']);
    expect(plantsOf(await overview(plantA.authorization))).toEqual(['PLA1']);
    const rows = (a: FinanceActor['authorization']) => warehouse(a).then((r) => r.rows.map((x) => x.plant).sort());
    expect(await rows(onlyA.authorization)).toEqual(['PLA1']);
    expect(await rows(onlyB.authorization)).toEqual(['PLB1']);
    expect(await rows(both.authorization)).toEqual(['PLA1', 'PLB1']);
    expect(await rows(plantA.authorization)).toEqual(['PLA1']);
  });

  it('never counts the stock of a plant that names no company or of another company in totals', async () => {
    const a = await warehouse(onlyA.authorization);
    expect(a.rows.reduce((sum, r) => sum + r.unrestrictedQuantity, 0)).toBe(11);
    expect(JSON.stringify(await overview(onlyA.authorization))).not.toContain('PLB1');
  });

  it('answers a plant selection outside the reach as a plant that does not stand', async () => {
    const miss = await ask(overview(onlyA.authorization, { plantFrom: 'PLZ9', plantTo: 'PLZ9' }));
    expect((await ask(overview(onlyA.authorization, { plantFrom: 'PLB1', plantTo: 'PLB1' }))).replaceAll('PLB1', '#')).toBe(miss.replaceAll('PLZ9', '#'));
    const missW = await ask(warehouse(onlyA.authorization, { plantFrom: 'PLZ9', plantTo: 'PLZ9' }));
    expect((await ask(warehouse(onlyA.authorization, { plantFrom: 'PLN1', plantTo: 'PLN1' }))).replaceAll('PLN1', '#')).toBe(missW.replaceAll('PLZ9', '#'));
  });

  it('refuses no session, no capability, no scope and another tenant', async () => {
    for (const a of [undefined, noCapability.authorization, noScope.authorization, otherTenantActor.authorization]) {
      expect(await ask(overview(a))).not.toBe('done');
      expect(await ask(warehouse(a))).not.toBe('done');
    }
  });
});

describe('price change', () => {
  let priceA: FinanceActor;
  let priceB: FinanceActor;
  let pricePlantA: FinanceActor;
  let priceNoScope: FinanceActor;
  let priceNoCap: FinanceActor;
  let priceOtherTenant: FinanceActor;
  const PRICE = ['INV.MATERIAL.PRICECHANGE'];
  const future = (a: FinanceActor['authorization'] | undefined, company: string, plant: string) => changeMaterialPrice({
    client, changedBy: 'FORGED', authorization: a, companyCode: company, postingDate: '2099-01-01', when: 'FUTURE',
    reason: 'Scope test', requestKey: `K-${company}-${plant}-${Math.random()}`, lines: [{ materialNumber: 'SCM1', plant, price: 9, priceUnit: 1 }],
  });
  const stored = async (plant: string) => withTenant(client, async (tx) => ((await tx.execute(sql`
    select future_price::text as p, changed_by from material_valuation where client = ${client} and material_number = 'SCM1' and valuation_area = ${plant}`)) as unknown as Array<{ p: string | null; changed_by: string | null }>)[0]!);

  beforeAll(async () => {
    priceA = await createFinanceActor(client, { capabilities: PRICE, companyScopes: [A] });
    priceB = await createFinanceActor(client, { capabilities: PRICE, companyScopes: [B] });
    pricePlantA = await createFinanceActor(client, { capabilities: PRICE, companyScopes: [A, B], plantScopes: ['PLA1'] });
    priceNoScope = await createFinanceActor(client, { capabilities: PRICE, companyScopes: [] });
    priceNoCap = await createFinanceActor(client, { capabilities: ['FIN.JOURNAL.DISPLAY'], companyScopes: [A, B] });
    priceOtherTenant = await createFinanceActor(other.client, { capabilities: PRICE });
  });

  it('stores a future price for its own company and records the session user, not the supplied name', async () => {
    expect((await future(priceA.authorization, A, 'PLA1')).posted).toBe(false);
    const row = await stored('PLA1');
    expect(row.p).toBe('9.0000');
    expect(row.changed_by).toBe(priceA.username);
  });

  it("refuses another company's code and another company's plant under an in-scope code", async () => {
    expect(await ask(future(priceA.authorization, B, 'PLB1'))).toMatch(/scope|Company Code/i);
    expect(await ask(future(priceA.authorization, A, 'PLB1'))).toMatch(/does not belong to company/);
    expect(await ask(future(priceB.authorization, A, 'PLA1'))).toMatch(/scope|Company Code/i);
    expect((await stored('PLB1')).p).toBeNull();
  });

  it('refuses a plant outside the Plant scope, and answers it as a plant that does not belong', async () => {
    const message = await ask(future(pricePlantA.authorization, B, 'PLB1'));
    expect(message).toMatch(/does not belong to company/);
    expect((await stored('PLB1')).p).toBeNull();
  });

  it('refuses no session, no capability, no scope and another tenant', async () => {
    for (const a of [undefined, priceNoCap.authorization, priceNoScope.authorization, priceOtherTenant.authorization]) {
      expect(await ask(future(a, A, 'PLA1'))).not.toMatch(/^done$|does not belong/);
    }
  });

  it('lists future prices only for reachable plants', async () => {
    await withTenant(client, (tx) => tx.execute(sql`update material_valuation set future_price = 7, future_price_unit = 1, future_valid_from = '2099-01-01'
      where client = ${client} and material_number = 'SCM1' and valuation_area = 'PLB1'`));
    const plants = async (a: FinanceActor['authorization']) => (await listFuturePrices(client, a)).map((r) => r.plant).sort();
    expect(await plants(priceA.authorization)).toEqual(['PLA1']);
    expect(await plants(priceB.authorization)).toEqual(['PLB1']);
    expect(await plants(pricePlantA.authorization)).toEqual(['PLA1']);
    expect(await ask(listFuturePrices(client, undefined))).not.toBe('done');
    expect(await ask(listFuturePrices(client, priceNoScope.authorization))).not.toBe('done');
  });
});

describe('reservations', () => {
  let rA: FinanceActor;
  let rB: FinanceActor;
  let rBoth: FinanceActor;
  let rNoScope: FinanceActor;
  let rNoCap: FinanceActor;
  let rOther: FinanceActor;
  let rPlantA: FinanceActor;
  const RSV = ['INV.RESERVATION.CREATE'];
  const withdrawn = async (n: string) => withTenant(client, async (tx) => ((await tx.execute(sql`
    select coalesce(sum(withdrawn_quantity), 0)::text as w from reservation_item where client = ${client} and reservation_number = ${n}`)) as unknown as Array<{ w: string }>)[0]!.w);
  const withdraw = (a: FinanceActor['authorization'] | undefined, n: string) => withdrawReservation({
    client, changedBy: 'FORGED', authorization: a, reservationNumber: n, itemNumber: 1, quantity: 1 });

  beforeAll(async () => {
    rA = await createFinanceActor(client, { capabilities: RSV, companyScopes: [A] });
    rB = await createFinanceActor(client, { capabilities: RSV, companyScopes: [B] });
    rBoth = await createFinanceActor(client, { capabilities: RSV, companyScopes: [A, B] });
    rNoScope = await createFinanceActor(client, { capabilities: RSV, companyScopes: [] });
    rNoCap = await createFinanceActor(client, { capabilities: ['FIN.JOURNAL.DISPLAY'], companyScopes: [A, B] });
    rOther = await createFinanceActor(other.client, { capabilities: RSV });
    rPlantA = await createFinanceActor(client, { capabilities: RSV, companyScopes: [A, B], plantScopes: ['PLA1'] });
  });

  it("shows a reservation only when every item's plant is reachable; others answer as missing", async () => {
    expect((await getReservation(client, 'RSV00000A', rA.authorization))?.items).toHaveLength(1);
    expect(await getReservation(client, 'RSV00000B', rA.authorization)).toBeNull();
    expect(await getReservation(client, 'RSV00000X', rA.authorization)).toBeNull();
    expect((await getReservation(client, 'RSV00000X', rBoth.authorization))?.items).toHaveLength(2);
    expect(await getReservation(client, 'RSV00000B', rPlantA.authorization)).toBeNull();
    expect(await getReservation(client, 'RSV99999', rA.authorization)).toBeNull();
    for (const a of [undefined, rNoCap.authorization, rNoScope.authorization, rOther.authorization]) {
      expect(await ask(getReservation(client, 'RSV00000A', a))).not.toBe('done');
    }
  });

  it('withdraws and completes only inside the reach, recording the session user', async () => {
    await withdraw(rA.authorization, 'RSV00000A');
    expect(await withdrawn('RSV00000A')).toBe('1.000');
    const by = await withTenant(client, async (tx) => ((await tx.execute(sql`select changed_by from reservation_item where client = ${client} and reservation_number = 'RSV00000A'`)) as unknown as Array<{ changed_by: string }>)[0]!.changed_by);
    expect(by).toBe(rA.username);
    const miss = await ask(withdraw(rA.authorization, 'RSV99999'));
    for (const n of ['RSV00000B', 'RSV00000X']) expect((await ask(withdraw(rA.authorization, n))).replaceAll(n, '#')).toBe(miss.replaceAll('RSV99999', '#'));
    expect(await ask(withdraw(rPlantA.authorization, 'RSV00000B'))).toMatch(/does not exist/);
    expect(await withdrawn('RSV00000B')).toBe('0.000');
    expect(await ask(completeReservationItem({ client, changedBy: 'x', authorization: rA.authorization, reservationNumber: 'RSV00000B', itemNumber: 1 }))).toMatch(/does not exist/);
    for (const a of [undefined, rNoCap.authorization, rNoScope.authorization, rOther.authorization]) {
      expect(await ask(withdraw(a, 'RSV00000A'))).not.toMatch(/^done$|does not exist/);
    }
    expect(await withdrawn('RSV00000A')).toBe('1.000');
  });

  it("refuses to create a reservation for another company's plant, as a plant that does not exist", async () => {
    const create = (a: FinanceActor['authorization'] | undefined, plant: string) => createReservation({
      client, changedBy: 'FORGED', authorization: a, movementTypeCode: '201', baseDate: '2026-04-05', costCenter: 'CC1000',
      items: [{ materialNumber: 'SCM1', plant, requiredQuantity: 1 }], requestKey: `K-${plant}-${Math.random()}`,
    });
    const miss = await ask(create(rA.authorization, 'PLZ9'));
    expect(miss).toMatch(/does not exist/);
    expect((await ask(create(rA.authorization, 'PLB1'))).replaceAll('PLB1', '#')).toBe(miss.replaceAll('PLZ9', '#'));
    expect((await ask(create(rPlantA.authorization, 'PLB1'))).replaceAll('PLB1', '#')).toBe(miss.replaceAll('PLZ9', '#'));
    for (const a of [undefined, rNoCap.authorization, rNoScope.authorization, rOther.authorization]) {
      expect(await ask(create(a, 'PLA1'))).not.toMatch(/^done$|does not exist/);
    }
    expect(await withTenant(client, async (tx) => Number(((await tx.execute(sql`select count(*)::int as n from reservation_header where client = ${client}`)) as unknown as Array<{ n: number }>)[0]!.n))).toBe(3);
  });
});

describe('physical inventory (count, differences, posting, recount)', () => {
  const PHY = ['INV.PHYINV.COUNT', 'INV.PHYINV.COUNT.CORRECT', 'INV.PHYINV.DIFF.LIST', 'INV.PHYINV.DIFF.POST', 'INV.PHYINV.RECOUNT', 'INV.PHYINV.CREATE', 'INV.PHYINV.CANCEL'];
  const YEAR = 2026;
  const DA = 'PIA0000001';
  const DB = 'PIB0000001';
  const DN = 'PIN0000001';
  const DGONE = 'PIZ9999999';
  let pA: FinanceActor;
  let pB: FinanceActor;
  let pBoth: FinanceActor;
  let pNoScope: FinanceActor;
  let pNoCap: FinanceActor;
  let pOther: FinanceActor;
  let pPlantA: FinanceActor;
  const key = (d: string) => ({ documentNumber: d, fiscalYear: YEAR });
  const noOne = (a: FinanceActor) => [undefined, a.authorization];
  const counted = async (d: string) => withTenant(client, async (tx) => ((await tx.execute(sql`
    select count(*)::int as n from physical_inventory_item where client = ${client} and inventory_document_number = ${d} and counted_quantity is not null`)) as unknown as Array<{ n: number }>)[0]!.n);

  beforeAll(async () => {
    pA = await createFinanceActor(client, { capabilities: PHY, companyScopes: [A] });
    pB = await createFinanceActor(client, { capabilities: PHY, companyScopes: [B] });
    pBoth = await createFinanceActor(client, { capabilities: PHY, companyScopes: [A, B] });
    pNoScope = await createFinanceActor(client, { capabilities: PHY, companyScopes: [] });
    pNoCap = await createFinanceActor(client, { capabilities: ['FIN.JOURNAL.DISPLAY'], companyScopes: [A, B] });
    pOther = await createFinanceActor(other.client, { capabilities: PHY });
    pPlantA = await createFinanceActor(client, { capabilities: PHY, companyScopes: [A, B], plantScopes: ['PLA1'] });
    await withTenant(client, async (tx) => {
      for (const [d, plant] of [[DA, 'PLA1'], [DB, 'PLB1'], [DN, 'PLN1']] as const) {
        await tx.execute(sql`insert into physical_inventory_document (client, inventory_document_number, fiscal_year, plant, planned_count_date, created_by)
          values (${client}, ${d}, ${YEAR}, ${plant}, '2026-04-05', ${SEED}) on conflict do nothing`);
        await tx.execute(sql`insert into physical_inventory_item (client, inventory_document_number, fiscal_year, item_number, material_number, stock_type, created_by)
          values (${client}, ${d}, ${YEAR}, 10, 'SCM1', 'UNRESTRICTED', ${SEED}) on conflict do nothing`);
      }
    });
  });

  it('reads a count document only inside the reach; other companies, no-company plants and plant scope answer as missing', async () => {
    expect((await getCountDocument(client, key(DA), pA.authorization))?.documentNumber).toBe(DA);
    for (const d of [DB, DN, DGONE]) expect(await getCountDocument(client, key(d), pA.authorization)).toBeNull();
    expect(await getCountDocument(client, key(DB), pPlantA.authorization)).toBeNull();
    expect((await getCountDocument(client, key(DB), pBoth.authorization))?.documentNumber).toBe(DB);
    expect((await searchCountDocuments(client, {}, pA.authorization)).map((r) => r.documentNumber)).toEqual([DA]);
    expect((await searchCountDocuments(client, {}, pBoth.authorization)).map((r) => r.documentNumber).sort()).toEqual([DA, DB]);
    expect(await getCountHistory(client, key(DB), pA.authorization)).toEqual([]);
    expect(await getCountStatus(client, key(DB), pA.authorization)).toBeNull();
    expect(await getCountStatus(client, key(DA), pA.authorization)).not.toBeNull();
  });

  it('refuses no session, no capability, no scope and another tenant on every count read', async () => {
    for (const a of [undefined, pNoCap.authorization, pNoScope.authorization, pOther.authorization]) {
      expect(await ask(getCountDocument(client, key(DA), a))).not.toBe('done');
      expect(await ask(searchCountDocuments(client, {}, a))).not.toBe('done');
      expect(await ask(getCountHistory(client, key(DA), a))).not.toBe('done');
      expect(await ask(getCountStatus(client, key(DA), a))).not.toBe('done');
    }
  });

  it("refuses to count another company's document as a missing one and writes nothing; records the session user", async () => {
    const submit = (a: FinanceActor['authorization'] | undefined, d: string, requestKey: string) => submitCounts({
      client, changedBy: 'FORGED', authorization: a, documentNumber: d, fiscalYear: YEAR, countDate: '2026-04-05', requestKey,
      lines: [{ itemNumber: 10, quantity: 1 }],
    });
    const miss = await ask(submit(pA.authorization, DGONE, 'PI-MISS'));
    expect(miss).not.toBe('done');
    for (const d of [DB, DN]) expect((await ask(submit(pA.authorization, d, `PI-${d}`))).replaceAll(d, '#')).toBe(miss.replaceAll(DGONE, '#'));
    expect(await ask(submit(pPlantA.authorization, DB, 'PI-PLANT'))).toBe(miss.replaceAll(DGONE, DB));
    for (const a of noOne(pNoCap).concat([pNoScope.authorization, pOther.authorization])) {
      expect(await ask(submit(a, DA, 'PI-NOAUTH'))).not.toMatch(/^done$|does not exist/);
    }
    expect(await counted(DB)).toBe(0);
    expect(await counted(DN)).toBe(0);
    expect(await counted(DA)).toBe(0);
    expect(await ask(submit(pA.authorization, DA, 'PI-OK'))).toBe('done');
    const by = await withTenant(client, async (tx) => ((await tx.execute(sql`
      select counter_name, changed_by from physical_inventory_item where client = ${client} and inventory_document_number = ${DA}`)) as unknown as Array<{ counter_name: string | null; changed_by: string | null }>)[0]!);
    expect(by.changed_by).toBe(pA.username);
    expect(by.changed_by).not.toBe('FORGED');
  });

  it("answers differences, posting and recount of another company's document as a missing one", async () => {
    const sel = (plant: string, doc: string) => ({ plantFrom: plant, fiscalYear: YEAR, documentFrom: doc, documentTo: doc, differenceExists: false, includeUncounted: true });
    expect(await ask(listDifferences(client, sel('PLB1', DB), pA.authorization))).toMatch(/does not exist/);
    expect(await ask(listDifferences(client, sel('PLN1', DN), pA.authorization))).toMatch(/does not exist/);
    expect(await ask(listDifferences(client, sel('PLB1', DB), pPlantA.authorization))).toMatch(/does not exist/);
    expect((await listDifferences(client, sel('PLA1', DA), pA.authorization)).rows.length).toBeGreaterThan(0);
    expect(await getDifferenceDocument(client, key(DB), pA.authorization)).toBeNull();
    expect((await getDifferenceDocument(client, key(DA), pA.authorization))?.documentNumber).toBe(DA);

    expect(await getDifferencePosting(client, key(DB), pA.authorization)).toBeNull();
    expect(await getPostingHistory(client, key(DB), pA.authorization)).toEqual([]);
    const post = (a: FinanceActor['authorization'] | undefined, d: string, requestKey: string) => postDifferences({
      client, changedBy: 'FORGED', authorization: a, documentNumber: d, fiscalYear: YEAR, itemNumbers: [10],
      postingDate: '2026-04-05', documentDate: '2026-04-05', requestKey });
    const missPost = await ask(post(pA.authorization, DGONE, 'PP-MISS'));
    expect(missPost).toMatch(/does not exist/);
    expect((await ask(post(pA.authorization, DB, 'PP-B'))).replaceAll(DB, '#')).toBe(missPost.replaceAll(DGONE, '#'));
    expect((await ask(post(pPlantA.authorization, DB, 'PP-B2'))).replaceAll(DB, '#')).toBe(missPost.replaceAll(DGONE, '#'));
    expect(await ask(validateDifferencePosting({ client, changedBy: 'x', authorization: pA.authorization, documentNumber: DB, fiscalYear: YEAR, itemNumbers: [10], postingDate: '2026-04-05', documentDate: '2026-04-05' }))).toMatch(/does not exist/);

    expect(await getRecountSource(client, key(DB), pA.authorization)).toBeNull();
    const recount = (a: FinanceActor['authorization'] | undefined, d: string, requestKey: string) => createRecount({
      client, changedBy: 'FORGED', authorization: a, documentNumber: d, fiscalYear: YEAR, itemNumbers: [10],
      plannedRecountDate: '2026-04-06', reason: 'Check', requestKey });
    expect(await ask(recount(pA.authorization, DB, 'RC-B'))).toMatch(/does not exist/);
    expect(await ask(recount(pPlantA.authorization, DB, 'RC-B2'))).toMatch(/does not exist/);
    expect(await withTenant(client, async (tx) => ((await tx.execute(sql`select count(*)::int as n from physical_inventory_document where client = ${client}`)) as unknown as Array<{ n: number }>)[0]!.n)).toBe(3);

    for (const a of [undefined, pNoCap.authorization, pNoScope.authorization, pOther.authorization]) {
      expect(await ask(listDifferences(client, sel('PLA1', DA), a))).not.toBe('done');
      expect(await ask(getDifferenceDocument(client, key(DA), a))).not.toBe('done');
      expect(await ask(getDifferencePosting(client, key(DA), a))).not.toBe('done');
      expect(await ask(post(a, DA, 'PP-NOAUTH'))).not.toMatch(/^done$|does not exist/);
      expect(await ask(getRecountSource(client, key(DA), a))).not.toBe('done');
      expect(await ask(recount(a, DA, 'RC-NOAUTH'))).not.toMatch(/^done$|does not exist/);
    }
  });
});
