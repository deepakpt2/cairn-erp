import { sql } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';

import { withTenant } from '../src/platform/db/client';
import { defineRange } from '../src/platform/numbering';
import { createOrder } from '../src/modules/purchasing/orders';

import { postGoodsReceipt } from './helpers/goods-receipt-authorized';
import { initializeMaterialPeriodControl } from '../src/modules/inventory/material-period-control';
import { postSupplierInvoice } from '../src/modules/purchasing/invoice-verification';
import {
  cancelPaymentRun, createPaymentRun, executePaymentRun, generateProposal, getPaymentRun,
} from '../src/modules/finance/payment-run';
import { createTenant, defineTestRanges, destroyTenant } from './helpers';

const ACTOR = 'SCR063_F110_TEST';

/**
 * SCR-063 acceptance: the run proposes what stands due, names its
 * exceptions, executes one balanced payment journal, clears the
 * paid line in place, and refuses every second execution.
 */
describe('SCR-063 payment run (F110)', () => {
  let client = '';

  afterAll(async () => {
    if (client) await destroyTenant(client);
  });

  async function standingClient(): Promise<string> {
    if (!client) {
      const tenant = await createTenant('scr063-payment-run');
      client = tenant.client;
      await defineTestRanges(tenant, { fiscalYear: 2026 });
      await withTenant(client, async (tx) => {
        await defineRange(tx, { client, objectCode: 'PURCHORD', subObject: 'POF', prefix: 'POF', numberLength: 7, createdBy: ACTOR });
        await defineRange(tx, { client, objectCode: 'MATDOC', subObject: '*', prefix: '', numberLength: 10, createdBy: ACTOR });
        await defineRange(tx, { client, objectCode: 'VENDINV', subObject: '*', prefix: '', numberLength: 10, createdBy: ACTOR });
        await tx.execute(sql`
          insert into purchasing_org (client, purchasing_org, name, company_code, created_by)
          values (${client}, '1000', 'Test purchasing organization', '1000', ${ACTOR}) on conflict do nothing
        `);
        await tx.execute(sql`
          insert into business_partner (client, partner_number, category, name, created_by)
          values (${client}, 'V10000', 'ORGANIZATION', 'Test Supplier', ${ACTOR}) on conflict do nothing
        `);
        await tx.execute(sql`
          insert into bp_role (client, partner_number, role_code, created_by)
          values (${client}, 'V10000', 'SUPPLIER', ${ACTOR}) on conflict do nothing
        `);
        await tx.execute(sql`
          insert into supplier_purchasing_org (client, partner_number, role_code, purchasing_org, order_currency, created_by)
          values (${client}, 'V10000', 'SUPPLIER', '1000', 'USD', ${ACTOR}) on conflict do nothing
        `);
        await tx.execute(sql`
          insert into payment_terms (client, terms_code, description, baseline_source, net_days, created_by)
          values (${client}, 'NET30', 'Net 30 days', 'DOCUMENT_DATE', 30, ${ACTOR}) on conflict do nothing
        `);
        await tx.execute(sql`
          insert into supplier_company_code (
            client, partner_number, role_code, company_code, chart_of_accounts,
            reconciliation_account, payment_terms_code, payment_methods, created_by
          )
          values (${client}, 'V10000', 'SUPPLIER', '1000', 'CA01', '200000', 'NET30', 'T', ${ACTOR})
          on conflict do nothing
        `);
        await tx.execute(sql`
          insert into payment_method (client, country, method_code, description, allowed_direction, created_by)
          values (${client}, 'KW', 'T', 'Bank transfer', 'OUTGOING', ${ACTOR}),
                 (${client}, 'KW', 'C', 'Cheque', 'OUTGOING', ${ACTOR})
          on conflict do nothing
        `);
        await tx.execute(sql`
          insert into bank_master (bank_country, bank_key, name, created_by)
          values ('KW', 'NBK001', 'Test National Bank', ${ACTOR}) on conflict do nothing
        `);
        await tx.execute(sql`
          insert into house_bank (client, company_code, house_bank_key, bank_country, bank_key, created_by)
          values (${client}, '1000', 'HB01', 'KW', 'NBK001', ${ACTOR}) on conflict do nothing
        `);
        await tx.execute(sql`
          insert into bank_account (client, company_code, house_bank_key, account_id, account_number, currency, gl_account, created_by)
          values (${client}, '1000', 'HB01', 'MAIN', '12345678', 'USD', '101000', ${ACTOR}) on conflict do nothing
        `);
        await tx.execute(sql`
          insert into material (client, material_number, description, material_type, base_unit, created_by)
          values (${client}, 'MAT-10001', 'Industrial steel plate', 'RAW', 'PC', ${ACTOR}) on conflict do nothing
        `);
        await tx.execute(sql`
          insert into material_plant (client, material_number, plant, overdelivery_tolerance, created_by)
          values (${client}, 'MAT-10001', '1000', 0, ${ACTOR}) on conflict do nothing
        `);
        await tx.execute(sql`
          insert into material_valuation (
            client, material_number, valuation_area, valuation_class, price_control,
            standard_price, moving_average_price, price_unit, currency, created_by
          )
          values (${client}, 'MAT-10001', '1000', 'RAW_INVENTORY', 'MOVING_AVERAGE', 0, 0, 1, 'USD', ${ACTOR})
          on conflict do nothing
        `);
        await tx.execute(sql`
          insert into account_determination (client, chart_of_accounts, event, valuation_class, general_modifier, gl_account, created_by)
          values (${client}, 'CA01', 'INVENTORY', 'RAW_INVENTORY', '', '120000', ${ACTOR}),
                 (${client}, 'CA01', 'GR_IR_CLEARING', '', '', '210000', ${ACTOR}),
                 (${client}, 'CA01', 'PRICE_DIFFERENCE', 'RAW_INVENTORY', '', '410200', ${ACTOR})
          on conflict do nothing
        `);
      });
      await initializeMaterialPeriodControl({
        client, changedBy: ACTOR, companyCode: '1000', fiscalYear: 2026, period: 10, reason: 'Stage 5 acceptance',
      });

      // A standing payable of 550, due 2026-11-15.
      const order = await createOrder({
        client, changedBy: ACTOR,
        supplierNumber: 'V10000', purchasingOrg: '1000', purchasingGroup: '001', companyCode: '1000', currency: '',
        items: [{
          materialNumber: 'MAT-10001', shortText: 'Industrial steel plate', quantity: 5, unit: 'PC',
          netPrice: 100, priceUnit: 1, taxCode: '', plant: '1000', storageLocation: '',
          markedForDeletion: false,
          scheduleLines: [{ deliveryDate: '2026-11-15', quantity: 5 }],
          assignments: [],
        }],
      });
      await postGoodsReceipt({
        client, changedBy: ACTOR, orderNumber: order.orderNumber,
        documentDate: '2026-10-18', postingDate: '2026-10-18',
        requestKey: 'gr-pay-1', lines: [{ itemNumber: 10, quantity: 5 }],
      });
      await postSupplierInvoice({
        client, changedBy: ACTOR, orderNumber: order.orderNumber,
        supplierReference: 'INV-PAY-1', invoiceDate: '2026-10-16', postingDate: '2026-10-18',
        grossAmount: 550, requestKey: 'iv-pay-1',
        lines: [{ itemNumber: 10, quantity: 5, netAmount: 550 }],
      });
    }
    return client;
  }

  const runParams = (patch: Partial<Parameters<typeof createPaymentRun>[0]> = {}) => ({
    client, changedBy: ACTOR,
    runDate: '2026-10-18', runId: 'RUNA',
    postingDate: '2026-11-16', documentCutoffDate: '2026-10-18', nextPaymentDate: '2026-11-16',
    companies: [{ companyCode: '1000', payingCompanyCode: '1000' }],
    methods: ['T'],
    ...patch,
  });

  it('proposes only what stands due, names exceptions, and warns on empty', async () => {
    const c = await standingClient();
    // Not yet due by the next payment date: the payable stays out.
    await createPaymentRun(runParams({ runId: 'RUNA', nextPaymentDate: '2026-11-01' }));
    const early = await generateProposal({ client: c, changedBy: ACTOR, runDate: '2026-10-18', runId: 'RUNA' });
    expect(early.proposal).toHaveLength(0);
    await cancelPaymentRun({ client: c, changedBy: ACTOR, runDate: '2026-10-18', runId: 'RUNA' });

    // Due, but the run's method does not stand for the supplier: a named exception.
    await createPaymentRun(runParams({ runId: 'RUNB', methods: ['C'] }));
    const mismatched = await generateProposal({ client: c, changedBy: ACTOR, runDate: '2026-10-18', runId: 'RUNB' });
    expect(mismatched.proposal).toHaveLength(1);
    expect(mismatched.proposal[0]).toMatchObject({ exceptionCode: 'NO_PAYMENT_METHOD', amount: '550.0000' });
    await expect(executePaymentRun({
      client: c, changedBy: ACTOR, runDate: '2026-10-18', runId: 'RUNB',
      houseBankKey: 'HB01', bankAccountId: 'MAIN',
    })).rejects.toThrow('no payable items');
    await cancelPaymentRun({ client: c, changedBy: ACTOR, runDate: '2026-10-18', runId: 'RUNB' });
  });

  it('executes one balanced payment, clears the item, and refuses a second execution', async () => {
    const c = await standingClient();
    await createPaymentRun(runParams({ runId: 'RUNC' }));
    const proposal = await generateProposal({ client: c, changedBy: ACTOR, runDate: '2026-10-18', runId: 'RUNC' });
    expect(proposal.proposal).toHaveLength(1);
    expect(proposal.proposal[0]).toMatchObject({
      accountId: 'V10000', amount: '550.0000', dueDate: '2026-11-15', paymentMethod: 'T', exceptionCode: null,
    });
    expect(proposal.payableTotal).toBe(550);

    const executed = await executePaymentRun({
      client: c, changedBy: ACTOR, runDate: '2026-10-18', runId: 'RUNC',
      houseBankKey: 'HB01', bankAccountId: 'MAIN',
    });
    expect(executed.status).toBe('EXECUTED');
    expect(executed.payments).toHaveLength(1);
    expect(executed.payments[0]).toMatchObject({ accountId: 'V10000', amount: '550.0000', houseBankKey: 'HB01' });

    const journal = await withTenant(c, (tx) => tx.execute(sql`
      select gl_account, debit_credit, amount_local from journal_entry_line
      where client = ${c} and document_number = ${executed.payments[0].journalDocumentNumber}
    `));
    const lines = journal as unknown as Array<Record<string, string>>;
    expect(lines.find((l) => l.gl_account === '200000')).toMatchObject({ debit_credit: 'S', amount_local: '550.0000' });
    expect(lines.find((l) => l.gl_account === '101000')).toMatchObject({ debit_credit: 'H', amount_local: '550.0000' });

    const cleared = await withTenant(c, (tx) => tx.execute(sql`
      select clearing_document, clearing_date from journal_entry_line
      where client = ${c} and business_partner = 'V10000' and gl_account = '200000' and debit_credit = 'H'
    `));
    const clearedRows = cleared as unknown as Array<{ clearing_document: string; clearing_date: string }>;
    expect(clearedRows[0].clearing_document).toBe(executed.payments[0].journalDocumentNumber);
    expect(String(clearedRows[0].clearing_date)).toContain('2026-11-16');

    // SCR-120: the payment document clears its own vendor line too, so
    // the paid vendor's payment never stands open downstream.
    const ownLine = await withTenant(c, (tx) => tx.execute(sql`
      select clearing_document, clearing_date from journal_entry_line
      where client = ${c} and document_number = ${executed.payments[0].journalDocumentNumber}
        and business_partner = 'V10000'
    `));
    const ownRows = ownLine as unknown as Array<{ clearing_document: string; clearing_date: string }>;
    expect(ownRows).toHaveLength(1);
    expect(ownRows[0].clearing_document).toBe(executed.payments[0].journalDocumentNumber);
    expect(String(ownRows[0].clearing_date)).toContain('2026-11-16');

    await expect(executePaymentRun({
      client: c, changedBy: ACTOR, runDate: '2026-10-18', runId: 'RUNC',
      houseBankKey: 'HB01', bankAccountId: 'MAIN',
    })).rejects.toThrow('already been executed');
    await expect(generateProposal({ client: c, changedBy: ACTOR, runDate: '2026-10-18', runId: 'RUNC' }))
      .rejects.toThrow('cannot be regenerated');
    await expect(cancelPaymentRun({ client: c, changedBy: ACTOR, runDate: '2026-10-18', runId: 'RUNC' }))
      .rejects.toThrow('cannot be cancelled');
    expect((await getPaymentRun(c, '2026-10-18', 'RUNC'))?.status).toBe('EXECUTED');
  });
});
