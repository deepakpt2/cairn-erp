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
import { stockOverview } from '../src/modules/inventory/stock-overview';
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
