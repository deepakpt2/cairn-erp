import { sql } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';

import { withTenant } from '../src/platform/db/client';
import {
  checkVendorEvaluation,
  listVendorEvaluation,
  saveManualScore,
} from '../src/modules/purchasing/vendor-evaluation';
import { createTenant, destroyTenant } from './helpers';

const ACTOR = 'SCR165_EVAL';
const PERIOD = { periodFrom: '2026-10-01', periodTo: '2026-10-31' };

describe('SCR-165 vendor evaluation', () => {
  let client = '';
  let other = '';

  afterAll(async () => {
    if (client) await destroyTenant(client);
    if (other) await destroyTenant(other);
  });

  it('calculates posted history, stores only a manual score, and does not treat a missing score as zero', async () => {
    const tenant = await createTenant('scr165-vendor-evaluation');
    client = tenant.client;
    other = (await createTenant('scr165-vendor-evaluation-other')).client;
    await withTenant(client, async (tx) => {
      await tx.execute(sql`
        insert into purchasing_org (client, purchasing_org, name, company_code, created_by)
        values
          (${client}, '1000', 'Central', ${tenant.companyCode}, ${ACTOR}),
          (${client}, '2000', 'Other', ${tenant.companyCode}, ${ACTOR})
        on conflict do nothing
      `);
      await tx.execute(sql`
        insert into purchasing_group (client, purchasing_group, name, created_by)
        values (${client}, '001', 'Buyer', ${ACTOR})
        on conflict do nothing
      `);
      await tx.execute(sql`
        insert into business_partner (client, partner_number, category, name, general_status, created_by)
        values
          (${client}, 'V-EVAL', 'ORGANIZATION', 'Evaluated supplier', 'CREATED', ${ACTOR}),
          (${client}, 'V-BLOCK', 'ORGANIZATION', 'Blocked supplier', 'CREATED', ${ACTOR}),
          (${client}, 'V-INC', 'ORGANIZATION', 'Incomplete supplier', 'CREATED', ${ACTOR}),
          (${client}, 'V-NONE', 'ORGANIZATION', 'Unscoped supplier', 'CREATED', ${ACTOR}),
          (${client}, 'V-ZERO', 'ORGANIZATION', 'Zero expected', 'CREATED', ${ACTOR})
      `);
      await tx.execute(sql`
        insert into bp_role (client, partner_number, role_code, created_by)
        values
          (${client}, 'V-EVAL', 'SUPPLIER', ${ACTOR}),
          (${client}, 'V-BLOCK', 'SUPPLIER', ${ACTOR}),
          (${client}, 'V-INC', 'SUPPLIER', ${ACTOR}),
          (${client}, 'V-NONE', 'SUPPLIER', ${ACTOR}),
          (${client}, 'V-ZERO', 'SUPPLIER', ${ACTOR})
      `);
      await tx.execute(sql`
        insert into supplier_purchasing_org
          (client, partner_number, role_code, purchasing_org, order_currency, purchasing_status, is_blocked, created_by)
        values
          (${client}, 'V-EVAL', 'SUPPLIER', '1000', ${tenant.currency}, 'MAINTAINED', false, ${ACTOR}),
          (${client}, 'V-BLOCK', 'SUPPLIER', '1000', ${tenant.currency}, 'MAINTAINED', true, ${ACTOR}),
          (${client}, 'V-INC', 'SUPPLIER', '1000', ${tenant.currency}, 'INCOMPLETE', false, ${ACTOR}),
          (${client}, 'V-ZERO', 'SUPPLIER', '1000', ${tenant.currency}, 'MAINTAINED', false, ${ACTOR})
      `);
      await tx.execute(sql`
        insert into vendor_evaluation_criterion
          (client, criterion_code, description, method, evidence, score_min, score_max, weight, created_by)
        values
          (${client}, 'PRICE', 'Price', 'AUTOMATIC', 'PRICE', 0, 100, 25, ${ACTOR}),
          (${client}, 'DELIVERY', 'Delivery', 'AUTOMATIC', 'DELIVERY', 0, 100, 25, ${ACTOR}),
          (${client}, 'QUALITY', 'Quality', 'MANUAL', 'NONE', 0, 100, 25, ${ACTOR}),
          (${client}, 'SERVICE', 'Service', 'MANUAL', 'NONE', 0, 100, 25, ${ACTOR})
      `);
      await tx.execute(sql`
        insert into material (client, material_number, description, material_type, base_unit, created_by)
        select ${client}, 'MAT-EVAL', 'Evaluated material', t.material_type, u.code, ${ACTOR}
        from (select material_type from material_type where client = ${client} order by material_type limit 1) t
        cross join (select code from unit_of_measure order by code limit 1) u
      `);
      const [unit] = await tx.execute(sql`select base_unit from material where client = ${client} and material_number = 'MAT-EVAL'`) as unknown as Array<{ base_unit: string }>;
      await tx.execute(sql`
        insert into purchase_order
          (client, order_number, supplier_number, purchasing_org, purchasing_group, company_code, currency, document_date, created_by)
        values
          (${client}, 'PO-EVAL1', 'V-EVAL', '1000', '001', ${tenant.companyCode}, ${tenant.currency}, '2026-10-01', ${ACTOR}),
          (${client}, 'PO-OTHER', 'V-EVAL', '2000', '001', ${tenant.companyCode}, ${tenant.currency}, '2026-10-01', ${ACTOR}),
          (${client}, 'PO-ZERO', 'V-ZERO', '1000', '001', ${tenant.companyCode}, ${tenant.currency}, '2026-10-01', ${ACTOR})
      `);
      await tx.execute(sql`
        insert into purchase_order_item
          (client, order_number, item_number, material_number, short_text, quantity, unit, net_price, price_unit, net_value, plant, created_by)
        values
          (${client}, 'PO-EVAL1', 10, 'MAT-EVAL', 'On time and late', 10, ${unit.base_unit}, 10, 1, 100, '1000', ${ACTOR}),
          (${client}, 'PO-EVAL1', 20, 'MAT-EVAL', 'No schedule', 2, ${unit.base_unit}, 10, 1, 20, '1000', ${ACTOR}),
          (${client}, 'PO-EVAL1', 30, 'MAT-EVAL', 'Reversed', 8, ${unit.base_unit}, 10, 1, 80, '1000', ${ACTOR}),
          (${client}, 'PO-OTHER', 10, 'MAT-EVAL', 'Other org', 1, ${unit.base_unit}, 10, 1, 10, '1000', ${ACTOR}),
          (${client}, 'PO-ZERO', 10, 'MAT-EVAL', 'Zero', 1, ${unit.base_unit}, 0, 1, 0, '1000', ${ACTOR})
      `);
      await tx.execute(sql`
        insert into purchase_order_schedule_line
          (client, order_number, item_number, line_number, delivery_date, quantity, created_by)
        values
          (${client}, 'PO-EVAL1', 10, 1, '2026-10-10', 10, ${ACTOR}),
          (${client}, 'PO-EVAL1', 30, 1, '2026-10-10', 8, ${ACTOR})
      `);
      await tx.execute(sql`
        insert into movement_type (client, movement_type, description, direction, reference_category, created_by) values
          (${client}, 'GOODS_RECEIPT_PO', 'Goods receipt for purchase order', 'RECEIPT', 'PURCHASE_ORDER', ${ACTOR}),
          (${client}, 'RECEIPT_REVERSAL', 'Reversal of a goods receipt', 'REVERSAL', 'MATERIAL_DOCUMENT', ${ACTOR})
        on conflict do nothing
      `);
      await tx.execute(sql`
        insert into material_document
          (client, material_document_number, document_year, document_date, posting_date, status, reversal_of, reversed_by, created_by)
        values
          (${client}, '5000000101', 2026, '2026-10-10', '2026-10-10', 'POSTED', null, null, ${ACTOR}),
          (${client}, '5000000102', 2026, '2026-10-20', '2026-10-20', 'POSTED', null, null, ${ACTOR}),
          (${client}, '5000000103', 2026, '2026-10-12', '2026-10-12', 'POSTED', null, null, ${ACTOR}),
          (${client}, '5000000104', 2026, '2026-10-11', '2026-10-11', 'REVERSED', null, '5000000105', ${ACTOR}),
          (${client}, '5000000105', 2026, '2026-10-15', '2026-10-15', 'POSTED', '5000000104', null, ${ACTOR}),
          (${client}, '5000000106', 2026, '2026-10-09', '2026-10-09', 'REVERSED', null, '5000000107', ${ACTOR}),
          (${client}, '5000000107', 2026, '2026-11-01', '2026-11-01', 'POSTED', '5000000106', null, ${ACTOR}),
          (${client}, '5000000108', 2026, '2026-09-15', '2026-09-15', 'POSTED', null, null, ${ACTOR})
      `);
      await tx.execute(sql`
        insert into material_document_line (
          client, material_document_number, line_number, movement_type, material_number, plant,
          stock_type, entry_quantity, entry_unit, base_quantity, base_unit, unit_price, price_unit, value,
          purchase_order_number, purchase_order_item, reversal_of_document, reversal_of_line, created_by
        ) values
          (${client}, '5000000101', 1, 'GOODS_RECEIPT_PO', 'MAT-EVAL', '1000', 'UNRESTRICTED', 6, ${unit.base_unit}, 6, ${unit.base_unit}, 10, 1, 60, 'PO-EVAL1', 10, null, null, ${ACTOR}),
          (${client}, '5000000102', 1, 'GOODS_RECEIPT_PO', 'MAT-EVAL', '1000', 'UNRESTRICTED', 4, ${unit.base_unit}, 4, ${unit.base_unit}, 10, 1, 40, 'PO-EVAL1', 10, null, null, ${ACTOR}),
          (${client}, '5000000103', 1, 'GOODS_RECEIPT_PO', 'MAT-EVAL', '1000', 'UNRESTRICTED', 2, ${unit.base_unit}, 2, ${unit.base_unit}, 10, 1, 20, 'PO-EVAL1', 20, null, null, ${ACTOR}),
          (${client}, '5000000104', 1, 'GOODS_RECEIPT_PO', 'MAT-EVAL', '1000', 'UNRESTRICTED', 5, ${unit.base_unit}, 5, ${unit.base_unit}, 10, 1, 50, 'PO-EVAL1', 30, null, null, ${ACTOR}),
          (${client}, '5000000105', 1, 'RECEIPT_REVERSAL', 'MAT-EVAL', '1000', 'UNRESTRICTED', 5, ${unit.base_unit}, 5, ${unit.base_unit}, 10, 1, 50, 'PO-EVAL1', 30, '5000000104', 1, ${ACTOR}),
          (${client}, '5000000106', 1, 'GOODS_RECEIPT_PO', 'MAT-EVAL', '1000', 'UNRESTRICTED', 3, ${unit.base_unit}, 3, ${unit.base_unit}, 10, 1, 30, 'PO-EVAL1', 30, null, null, ${ACTOR}),
          (${client}, '5000000107', 1, 'RECEIPT_REVERSAL', 'MAT-EVAL', '1000', 'UNRESTRICTED', 3, ${unit.base_unit}, 3, ${unit.base_unit}, 10, 1, 30, 'PO-EVAL1', 30, '5000000106', 1, ${ACTOR}),
          (${client}, '5000000108', 1, 'GOODS_RECEIPT_PO', 'MAT-EVAL', '1000', 'UNRESTRICTED', 100, ${unit.base_unit}, 100, ${unit.base_unit}, 10, 1, 1000, 'PO-EVAL1', 10, null, null, ${ACTOR})
      `);
      await tx.execute(sql`
        insert into supplier_invoice (
          client, invoice_number, fiscal_year, category, supplier_number, company_code, purchase_order_number,
          invoice_date, posting_date, supplier_reference, currency, gross_amount, status, created_by
        ) values
          (${client}, 'VI-EVAL1', 2026, 'INVOICE', 'V-EVAL', ${tenant.companyCode}, 'PO-EVAL1', '2026-10-15', '2026-10-15', 'REF-EVAL1', ${tenant.currency}, 110, 'POSTED', ${ACTOR}),
          (${client}, 'VI-EVAL2', 2026, 'INVOICE', 'V-EVAL', ${tenant.companyCode}, 'PO-EVAL1', '2026-10-16', '2026-10-16', 'REF-EVAL2', ${tenant.currency}, 50, 'POSTED', ${ACTOR}),
          (${client}, 'VI-EVAL3', 2026, 'CREDIT_MEMO', 'V-EVAL', ${tenant.companyCode}, 'PO-EVAL1', '2026-10-17', '2026-10-17', 'REF-EVAL3', ${tenant.currency}, 40, 'POSTED', ${ACTOR}),
          (${client}, 'VI-EVAL4', 2026, 'INVOICE', 'V-EVAL', ${tenant.companyCode}, 'PO-EVAL1', '2026-10-18', '2026-10-18', 'REF-EVAL4', ${tenant.currency}, 80, 'CANCELLED', ${ACTOR}),
          (${client}, 'VI-EVAL5', 2026, 'INVOICE', 'V-EVAL', ${tenant.companyCode}, 'PO-EVAL1', '2026-09-30', '2026-09-30', 'REF-EVAL5', ${tenant.currency}, 1, 'POSTED', ${ACTOR}),
          (${client}, 'VI-ORG2', 2026, 'INVOICE', 'V-EVAL', ${tenant.companyCode}, 'PO-OTHER', '2026-10-18', '2026-10-18', 'REF-ORG2', ${tenant.currency}, 100, 'POSTED', ${ACTOR}),
          (${client}, 'VI-ZERO', 2026, 'INVOICE', 'V-ZERO', ${tenant.companyCode}, 'PO-ZERO', '2026-10-18', '2026-10-18', 'REF-ZERO', ${tenant.currency}, 10, 'POSTED', ${ACTOR})
      `);
      await tx.execute(sql`
        insert into supplier_invoice_item (
          client, invoice_number, line_number, purchase_order_number, purchase_order_item, quantity, unit, net_amount, expected_amount, created_by
        ) values
          (${client}, 'VI-EVAL1', 1, 'PO-EVAL1', 10, 1, ${unit.base_unit}, 110, 100, ${ACTOR}),
          (${client}, 'VI-EVAL2', 1, 'PO-EVAL1', 10, 1, ${unit.base_unit}, 50, 50, ${ACTOR}),
          (${client}, 'VI-EVAL3', 1, 'PO-EVAL1', 10, 1, ${unit.base_unit}, 40, 20, ${ACTOR}),
          (${client}, 'VI-EVAL4', 1, 'PO-EVAL1', 10, 1, ${unit.base_unit}, 80, 10, ${ACTOR}),
          (${client}, 'VI-EVAL5', 1, 'PO-EVAL1', 10, 1, ${unit.base_unit}, 1, 999, ${ACTOR}),
          (${client}, 'VI-ORG2', 1, 'PO-OTHER', 10, 1, ${unit.base_unit}, 100, 10, ${ACTOR}),
          (${client}, 'VI-ZERO', 1, 'PO-ZERO', 10, 1, ${unit.base_unit}, 10, 0, ${ACTOR})
      `);
    });

    const before = await counts(client);
    const shown = await listVendorEvaluation(client, { supplier: 'v-eval', purchasingOrg: '1000', ...PERIOD });
    expect(shown.asOfDate).toBe('2026-10-31');
    expect(shown.blocked).toBe(false);
    expect(scoreOf(shown, 'PRICE')).toBe('93.33');
    expect(scoreOf(shown, 'DELIVERY')).toBe('69.23');
    expect(scoreOf(shown, 'QUALITY')).toBeNull();
    expect(scoreOf(shown, 'SERVICE')).toBeNull();
    expect(shown.overallScore).toBeNull();
    expect(shown.weightTotal).toBe('100.00');
    expect(shown.message).toMatch(/not zero/);
    expect(shown.criteria.find((row) => row.criterionCode === 'PRICE')?.evidenceNote).toMatch(/cancelled invoice is not evidence/i);

    const checked = await checkVendorEvaluation(client, { supplier: 'V-EVAL', purchasingOrg: '1000', ...PERIOD });
    expect(checked.overallScore).toBeNull();
    expect(checked.message).toMatch(/Nothing was written/);
    expect(await counts(client)).toEqual(before);

    const emptyPeriod = await listVendorEvaluation(client, {
      supplier: 'V-EVAL', purchasingOrg: '1000', periodFrom: '2025-01-01', periodTo: '2025-01-31',
    });
    expect(scoreOf(emptyPeriod, 'PRICE')).toBeNull();
    expect(scoreOf(emptyPeriod, 'DELIVERY')).toBeNull();
    expect(emptyPeriod.overallScore).toBeNull();

    const zero = await listVendorEvaluation(client, { supplier: 'V-ZERO', purchasingOrg: '1000', ...PERIOD });
    expect(scoreOf(zero, 'PRICE')).toBeNull();

    const quality = await saveManualScore({
      client, changedBy: ACTOR, supplier: 'V-EVAL', purchasingOrg: '1000', ...PERIOD,
      criterionCode: 'QUALITY', score: '80', reason: 'Accepted the lot', requestKey: 've-quality-1',
    });
    expect(quality).toEqual({ wrote: true, criterionCode: 'QUALITY', score: '80.00', version: 1 });
    const afterQuality = await listVendorEvaluation(client, { supplier: 'V-EVAL', purchasingOrg: '1000', ...PERIOD });
    expect(afterQuality.overallScore).toBeNull();
    expect(scoreOf(afterQuality, 'QUALITY')).toBe('80.00');

    const changesBeforeReplay = (await counts(client)).changes;
    const replay = await saveManualScore({
      client, changedBy: ACTOR, supplier: 'V-EVAL', purchasingOrg: '1000', ...PERIOD,
      criterionCode: 'QUALITY', score: '80.00', reason: 'Accepted the lot', requestKey: 've-quality-1',
    });
    expect(replay.wrote).toBe(false);
    expect((await counts(client)).changes).toBe(changesBeforeReplay);

    const service = await saveManualScore({
      client, changedBy: ACTOR, supplier: 'V-EVAL', purchasingOrg: '1000', ...PERIOD,
      criterionCode: 'SERVICE', score: '70', reason: 'Answered the claim', requestKey: 've-service-1',
    });
    expect(service.wrote).toBe(true);
    const complete = await listVendorEvaluation(client, { supplier: 'V-EVAL', purchasingOrg: '1000', ...PERIOD });
    expect(complete.overallScore).toBe('78.14');
    expect(complete.scored).toBe(4);

    await expect(saveManualScore({
      client, changedBy: ACTOR, supplier: 'V-EVAL', purchasingOrg: '1000', ...PERIOD,
      criterionCode: 'QUALITY', score: '82', reason: 'A different score', requestKey: 've-quality-1',
    })).rejects.toThrow(/different assessment/);
    await expect(saveManualScore({
      client, changedBy: ACTOR, supplier: 'V-EVAL', purchasingOrg: '1000', ...PERIOD,
      criterionCode: 'PRICE', score: '50', reason: 'Not automatic', requestKey: 've-price-1',
    })).rejects.toThrow(/automatic/);
    await expect(saveManualScore({
      client, changedBy: ACTOR, supplier: 'V-EVAL', purchasingOrg: '1000', ...PERIOD,
      criterionCode: 'SERVICE', score: '71', reason: 'Stale', requestKey: 've-service-2', expectedVersion: 4,
    })).rejects.toThrow(/changed since it was read/);
    await expect(saveManualScore({
      client, changedBy: ACTOR, supplier: 'V-BLOCK', purchasingOrg: '1000', ...PERIOD,
      criterionCode: 'QUALITY', score: '10', reason: 'Blocked', requestKey: 've-block-1',
    })).rejects.toThrow(/blocked/);

    const blocked = await listVendorEvaluation(client, { supplier: 'V-BLOCK', purchasingOrg: '1000', ...PERIOD });
    expect(blocked.blocked).toBe(true);
    expect(blocked.supplierName).toBe('Blocked supplier');
    await expect(listVendorEvaluation(client, { supplier: 'V-INC', purchasingOrg: '1000', ...PERIOD })).rejects.toThrow(/not available/);
    await expect(listVendorEvaluation(client, { supplier: 'V-NONE', purchasingOrg: '1000', ...PERIOD })).rejects.toThrow(/not available/);
    await expect(listVendorEvaluation(client, {
      supplier: 'V-EVAL', purchasingOrg: '1000', ...PERIOD, asOf: '2026-10-15',
    })).rejects.toThrow(/period end/);
    await expect(listVendorEvaluation(client, {
      supplier: 'V-EVAL', purchasingOrg: '1000', ...PERIOD, companyCode: tenant.companyCode,
    })).rejects.toThrow(/company-code/);
    await expect(checkVendorEvaluation(client, {
      supplier: 'V-EVAL', purchasingOrg: '1000', ...PERIOD, material: 'MAT-EVAL',
    })).rejects.toThrow(/material scope/);
    await expect(saveManualScore({
      client, changedBy: ACTOR, supplier: 'V-EVAL', purchasingOrg: '1000', ...PERIOD,
      criterionCode: 'QUALITY', score: '80', reason: 'Weight', requestKey: 've-weight-1',
      named: { weight: '50', purchaseOrder: 'PO-EVAL1', subCriterion: 'PACK', evaluationRun: '1', overallScore: '90', status: 'FINAL' },
    })).rejects.toThrow(/weight|purchasing document|sub-criterion|run|derived|status/i);

    const hidden = await withTenant(other, async (tx) => {
      const [row] = await tx.execute(sql`select count(*)::int as n from vendor_evaluation_assessment`) as unknown as Array<{ n: number }>;
      return row.n;
    });
    expect(hidden).toBe(0);
    const after = await counts(client);
    expect(after.journals).toBe(before.journals);
    expect(after.documents).toBe(before.documents);
    expect(after.invoices).toBe(before.invoices);
    expect(after.assessments).toBe(2);
    expect(after.changes).toBe(before.changes + 2);
  });
});

function scoreOf(evaluation: Awaited<ReturnType<typeof listVendorEvaluation>>, code: string): string | null {
  return evaluation.criteria.find((row) => row.criterionCode === code)?.score ?? null;
}

async function counts(client: string) {
  return withTenant(client, async (tx) => {
    const [assessments] = await tx.execute(sql`select count(*)::int as n from vendor_evaluation_assessment where client = ${client}`) as unknown as Array<{ n: number }>;
    const [changes] = await tx.execute(sql`select count(*)::int as n from change_document where client = ${client} and object_class = 'vendor_evaluation_assessment'`) as unknown as Array<{ n: number }>;
    const [documents] = await tx.execute(sql`select count(*)::int as n from material_document where client = ${client}`) as unknown as Array<{ n: number }>;
    const [invoices] = await tx.execute(sql`select count(*)::int as n from supplier_invoice where client = ${client}`) as unknown as Array<{ n: number }>;
    const [journals] = await tx.execute(sql`select count(*)::int as n from journal_entry where client = ${client}`) as unknown as Array<{ n: number }>;
    return { assessments: assessments.n, changes: changes.n, documents: documents.n, invoices: invoices.n, journals: journals.n };
  });
}

function unused(error: VendorEvaluationError) {
  return error;
}
