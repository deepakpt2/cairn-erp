import { sql } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';

import { withTenant } from '../src/platform/db/client';
import { defineRange } from '../src/platform/numbering';
import { postCustomerInvoice } from '../src/modules/finance/customer-invoice';
import {
  cancelDunningRun, excludeDunningAccount, finalizeDunningRun, proposeDunningRun,
} from '../src/modules/finance/dunning';
import { createTenant, defineTestRanges, destroyTenant } from './helpers';

const ACTOR = 'SCR074_F150_TEST';

/**
 * SCR-074 acceptance: a dunning run proposes overdue items at the
 * level their completed history earns, excludes an account without
 * a dunning procedure by name, and finalizes duplicate-safely —
 * levels advancing only at finalization.
 */
describe('SCR-074 dunning programme (F150)', () => {
  let client = '';

  afterAll(async () => {
    if (client) await destroyTenant(client);
  });

  async function standingClient(): Promise<string> {
    if (!client) {
      const tenant = await createTenant('scr074-dunning');
      client = tenant.client;
      await defineTestRanges(tenant, { fiscalYear: 2026 });
      await withTenant(client, async (tx) => {
        await defineRange(tx, { client, objectCode: 'CUSTINV', subObject: '*', prefix: 'CI', numberLength: 7, createdBy: ACTOR });
        for (const [partner, name] of [['C10000', 'Dunned Customer'], ['C20000', 'Procedurless Customer']] as const) {
          await tx.execute(sql`
            insert into business_partner (client, partner_number, category, name, created_by)
            values (${client}, ${partner}, 'ORGANIZATION', ${name}, ${ACTOR}) on conflict do nothing
          `);
          await tx.execute(sql`
            insert into bp_role (client, partner_number, role_code, created_by)
            values (${client}, ${partner}, 'CUSTOMER', ${ACTOR}) on conflict do nothing
          `);
        }
        await tx.execute(sql`
          insert into payment_terms (client, terms_code, description, baseline_source, net_days, created_by)
          values (${client}, 'NET30', 'Net 30 days', 'DOCUMENT_DATE', 30, ${ACTOR}) on conflict do nothing
        `);
        await tx.execute(sql`
          insert into customer_company_code (
            client, partner_number, role_code, company_code, chart_of_accounts,
            reconciliation_account, payment_terms_code, dunning_procedure, created_by
          )
          values (${client}, 'C10000', 'CUSTOMER', '1000', 'CA01', '110000', 'NET30', 'DUN1', ${ACTOR})
          on conflict do nothing
        `);
        await tx.execute(sql`
          insert into customer_company_code (
            client, partner_number, role_code, company_code, chart_of_accounts,
            reconciliation_account, payment_terms_code, created_by
          )
          values (${client}, 'C20000', 'CUSTOMER', '1000', 'CA01', '110000', 'NET30', ${ACTOR})
          on conflict do nothing
        `);
        await tx.execute(sql`
          insert into tax_code (client, country, tax_code, name, tax_type, rate_percent, created_by)
          values (${client}, 'KW', 'T10', 'Output tax 10 percent', 'VAT', 10, ${ACTOR}) on conflict do nothing
        `);
        await tx.execute(sql`
          insert into account_determination (client, chart_of_accounts, event, valuation_class, general_modifier, gl_account, created_by)
          values (${client}, 'CA01', 'TAX', '', '', '240000', ${ACTOR}) on conflict do nothing
        `);
      });

      // Due 2026-10-16 (document date + NET30): 35 days overdue on 2026-11-20.
      await postCustomerInvoice({
        client, changedBy: ACTOR, customerNumber: 'C10000', companyCode: '1000',
        documentDate: '2026-09-16', postingDate: '2026-09-18',
        reference: 'DUN-INV-1', currency: 'USD', grossAmount: 550, requestKey: 'dun-inv-1',
        lines: [{ glAccount: '300000', netAmount: 500, taxCode: 'T10' }],
      });
      // Not yet due at the first dunning date.
      await postCustomerInvoice({
        client, changedBy: ACTOR, customerNumber: 'C10000', companyCode: '1000',
        documentDate: '2026-11-19', postingDate: '2026-11-19',
        reference: 'DUN-INV-2', currency: 'USD', grossAmount: 100, requestKey: 'dun-inv-2',
        lines: [{ glAccount: '300000', netAmount: 100, taxCode: '' }],
      });
      // Overdue, but the customer carries no dunning procedure.
      await postCustomerInvoice({
        client, changedBy: ACTOR, customerNumber: 'C20000', companyCode: '1000',
        documentDate: '2026-09-16', postingDate: '2026-09-18',
        reference: 'DUN-INV-3', currency: 'USD', grossAmount: 300, requestKey: 'dun-inv-3',
        lines: [{ glAccount: '300000', netAmount: 300, taxCode: '' }],
      });
    }
    return client;
  }

  const run1 = {
    runDate: '2026-11-20', runId: 'DUN001', dunningDate: '2026-11-20',
    postedThrough: '2026-11-20', companyCodes: ['1000'],
  };

  it('refuses a cutoff after the dunning date and a duplicate identity', async () => {
    const c = await standingClient();
    await expect(proposeDunningRun({
      client: c, changedBy: ACTOR, ...run1, postedThrough: '2026-11-21',
    })).rejects.toThrow('stands after the dunning date');
    await proposeDunningRun({ client: c, changedBy: ACTOR, ...run1 });
    await expect(proposeDunningRun({ client: c, changedBy: ACTOR, ...run1 }))
      .rejects.toThrow('already stands with status PROPOSED');
  });

  it('proposes overdue items at level 1 and excludes the procedur-less account by name', async () => {
    const c = await standingClient();
    const view = await proposeDunningRun({
      client: c, changedBy: ACTOR, runDate: '2026-11-20', runId: 'DUN002',
      dunningDate: '2026-11-20', postedThrough: '2026-11-20', companyCodes: ['1000'],
    });
    expect(view.status).toBe('PROPOSED');
    const proposed = view.accounts.find((a) => a.customer === 'C10000')!;
    expect(proposed.status).toBe('PROPOSED');
    expect(proposed.proposedLevel).toBe(1);
    expect(proposed.totalOverdue).toBe('550.0000');
    const excluded = view.accounts.find((a) => a.customer === 'C20000')!;
    expect(excluded.status).toBe('EXCLUDED');
    expect(excluded.exceptionReason).toContain('carries no dunning procedure');
    expect(view.items).toHaveLength(1);
    expect(view.items[0].daysOverdue).toBe(35);
    expect(view.items[0].proposedLevel).toBe(1);
  });

  it('finalizes duplicate-safely, and the next run proposes level 2', async () => {
    const c = await standingClient();
    await expect(finalizeDunningRun({
      client: c, changedBy: ACTOR, runDate: run1.runDate, runId: run1.runId, confirmed: false,
    })).rejects.toThrow('stands unconfirmed');
    const done = await finalizeDunningRun({
      client: c, changedBy: ACTOR, runDate: run1.runDate, runId: run1.runId, confirmed: true,
    });
    expect(done.status).toBe('COMPLETED');
    expect(done.notices).toHaveLength(1);
    expect(done.notices[0].dunningLevel).toBe(1);
    expect(done.notices[0].amount).toBe('550.0000');

    const again = await finalizeDunningRun({
      client: c, changedBy: ACTOR, runDate: run1.runDate, runId: run1.runId, confirmed: true,
    });
    expect(again.notices).toHaveLength(1);

    const run2 = await proposeDunningRun({
      client: c, changedBy: ACTOR, runDate: '2026-12-20', runId: 'DUN003',
      dunningDate: '2026-12-20', postedThrough: '2026-12-20', companyCodes: ['1000'],
    });
    const item = run2.items.find((i) => i.customer === 'C10000')!;
    expect(item.proposedLevel).toBe(2);
  });

  it('excludes an account before finalization and cancels a run', async () => {
    const c = await standingClient();
    const view = await excludeDunningAccount({
      client: c, changedBy: ACTOR, runDate: '2026-12-20', runId: 'DUN003',
      companyCode: '1000', customer: 'C10000',
    });
    expect(view.accounts.find((a) => a.customer === 'C10000')!.status).toBe('EXCLUDED');
    const done = await finalizeDunningRun({
      client: c, changedBy: ACTOR, runDate: '2026-12-20', runId: 'DUN003', confirmed: true,
    });
    expect(done.notices).toHaveLength(0);

    const proposed = await proposeDunningRun({
      client: c, changedBy: ACTOR, runDate: '2027-01-20', runId: 'DUN004',
      dunningDate: '2027-01-20', postedThrough: '2027-01-20', companyCodes: ['1000'],
    });
    expect(proposed.status).toBe('PROPOSED');
    const cancelled = await cancelDunningRun({
      client: c, changedBy: ACTOR, runDate: '2027-01-20', runId: 'DUN004',
    });
    expect(cancelled.status).toBe('CANCELLED');
    await expect(finalizeDunningRun({
      client: c, changedBy: ACTOR, runDate: '2027-01-20', runId: 'DUN004', confirmed: true,
    })).rejects.toThrow('stands CANCELLED');
  });
});
