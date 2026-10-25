import { readFileSync } from 'node:fs';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { withTenant } from '../src/platform/db/client';
import { defineRange } from '../src/platform/numbering';
import { getGlBalances } from '../src/modules/finance/gl-balances';
import { getJournalDocument } from '../src/modules/finance/document-display';
import { getJournalItems } from '../src/modules/finance/journal-items';
import { calculateBalanceSheet } from '../src/modules/finance/balance-sheet';
import { calculateTrialBalance } from '../src/modules/finance/trial-balance';
import { postGoodsIssue } from '../src/modules/inventory/goods-issue';
import { displayMaterialDocument } from '../src/modules/inventory/material-document-display';
import { JOURNAL_ACCOUNTING_NOTE } from '../src/modules/inventory/material-document-accounting';
import { MaterialReversalError, reverseMaterialDocument } from '../src/modules/inventory/material-document-reversal';
import { createProductionOrder, releaseProductionOrder } from '../src/modules/inventory/production-orders';
import { getProductionOrderDisplay } from '../src/modules/production/production-order-display';
import { createTenant, destroyTenant } from './helpers';

/**
 * Accounting consistency of a journaled material document reversed by line.
 *
 * Stock and value follow the reversed line. The journal stays posted until
 * every line is reversed, then it is reversed once. A failed final reversal
 * must not leave a committed stock move or a reversed journal.
 */
const ACTOR = 'REVACC_TEST';
const PLANT = 'RA01';
const COMPANY = '1000';
const DAY = '2026-10-16';

describe('journaled material-document reversal accounting', () => {
  let client = '';
  let other = '';
  let chart = '';
  let key = 0;
  const nextKey = () => `revacc-${++key}`;

  async function order(components: Array<{ materialNumber: string; requiredQuantity: number }>) {
    const draft = await createProductionOrder({
      orderType: 'PP01', client, createdBy: ACTOR,
      materialNumber: 'ACC-FG', plant: PLANT, orderQuantity: 4,
      scheduledStart: '2026-10-01', scheduledFinish: '2026-10-20',
      components: components.map((component) => ({ ...component, plant: PLANT, storageLocation: 'RA01' })),
    });
    await releaseProductionOrder({ client, orderNumber: draft.orderNumber, releasedBy: ACTOR });
    return draft.orderNumber;
  }

  async function issue(orderNumber: string, lines: Array<{ materialNumber: string; quantity: number; item: number }>) {
    return postGoodsIssue({
      client, changedBy: ACTOR, movementTypeCode: '261', postingDate: DAY, documentDate: DAY,
      lines: lines.map((line) => ({
        materialNumber: line.materialNumber, plant: PLANT, storageLocation: 'RA01',
        quantity: line.quantity, productionOrderNumber: orderNumber, productionOrderItem: line.item,
      })),
      requestKey: nextKey(),
    }, 'MIGO');
  }

  async function stock(material: string) {
    const rows = await withTenant(client, (tx) => tx.execute(sql`
      select quantity::text as quantity from stock_quantity
       where client = ${client} and material_number = ${material} and plant = ${PLANT}
    `)) as unknown as Array<{ quantity: string }>;
    return Number(rows[0]?.quantity ?? 'NaN');
  }

  async function valuation(material: string) {
    const rows = await withTenant(client, (tx) => tx.execute(sql`
      select total_stock_quantity::text as quantity, stock_value::text as value
        from material_valuation
       where client = ${client} and material_number = ${material} and valuation_area = ${PLANT}
    `)) as unknown as Array<{ quantity: string; value: string }>;
    return { quantity: Number(rows[0]?.quantity ?? 'NaN'), value: Number(rows[0]?.value ?? 'NaN') };
  }

  async function postedBalance(account: string) {
    const rows = await withTenant(client, (tx) => tx.execute(sql`
      select
        coalesce(sum(case when l.debit_credit = 'S' then l.amount_local else 0 end), 0)::text as debit,
        coalesce(sum(case when l.debit_credit = 'H' then l.amount_local else 0 end), 0)::text as credit
        from journal_entry_line l
        join journal_entry e
          on e.client = l.client and e.document_number = l.document_number and e.fiscal_year = l.fiscal_year
       where l.client = ${client} and l.gl_account = ${account} and e.status = 'POSTED'
    `)) as unknown as Array<{ debit: string; credit: string }>;
    return { debit: Number(rows[0]?.debit ?? 0), credit: Number(rows[0]?.credit ?? 0) };
  }

  async function inventoryAccount(journalNumber: string) {
    const rows = await withTenant(client, (tx) => tx.execute(sql`
      select gl_account from journal_entry_line
       where client = ${client} and document_number = ${journalNumber} and debit_credit = 'H'
       order by line_number limit 1
    `)) as unknown as Array<{ gl_account: string }>;
    return rows[0]?.gl_account ?? '';
  }

  async function trialAccount(account: string) {
    const statement = await calculateTrialBalance({
      client,
      selection: {
        companyCode: COMPANY, statementVersion: 'RA01', fiscalYear: 2026,
        periodFrom: 1, periodTo: 12, includeSpecialPeriods: false, ledger: '0L',
      },
    });
    const accounts = statement.nodes.flatMap((node) => node.accounts);
    return accounts.find((row) => row.accountNumber === account) ?? null;
  }

  beforeAll(async () => {
    client = (await createTenant('rev-acc')).client;
    other = (await createTenant('rev-acc-other')).client;
    await withTenant(client, async (tx) => {
      const charts = await tx.execute(sql`select chart_of_accounts from chart_of_accounts where client = ${client} limit 1`) as unknown as Array<{ chart_of_accounts: string }>;
      chart = charts[0]?.chart_of_accounts ?? '';
      await tx.execute(sql`
        insert into material (client, material_number, description, material_type, base_unit, created_by)
        select ${client}, v.n, v.n, v.t, 'PC', ${ACTOR}
          from (values ('ACC-FG', 'FIN'), ('ACC-B', 'RAW'), ('ACC-C', 'RAW')) as v(n, t)
        on conflict do nothing
      `);
      await tx.execute(sql`
        insert into plant (client, plant, name, company_code, country, created_by)
        values (${client}, ${PLANT}, 'Accounting reversal plant', ${COMPANY}, 'KW', ${ACTOR})
        on conflict (client, plant) do update set company_code = excluded.company_code
      `);
      await tx.execute(sql`
        insert into material_plant (
          client, material_number, plant, mrp_type, mrp_controller, procurement_type, lot_sizing,
          purchasing_group, mrp_status, created_by
        )
        select ${client}, v.n, ${PLANT}, 'REQUIREMENTS', '001', 'BUY', 'EXACT', '001', 'MAINTAINED', ${ACTOR}
          from (values ('ACC-FG'), ('ACC-B'), ('ACC-C')) as v(n)
        on conflict (client, material_number, plant) do update set mrp_status = 'MAINTAINED'
      `);
      await tx.execute(sql`
        insert into storage_location (client, plant, storage_location, name, is_active, allow_negative_stock, created_by)
        values (${client}, ${PLANT}, 'RA01', 'Accounting store', true, false, ${ACTOR})
        on conflict do nothing
      `);
      await tx.execute(sql`
        insert into material_valuation (
          client, material_number, valuation_area, valuation_class, price_control,
          standard_price, moving_average_price, price_unit, currency, total_stock_quantity, stock_value, created_by
        )
        select ${client}, v.n, ${PLANT}, v.c, v.p, 10, 10, 1, 'USD', v.q, v.q * 10, ${ACTOR}
          from (values
            ('ACC-FG', 'FINISHED_INVENTORY', 'STANDARD', 0),
            ('ACC-B', 'RAW_INVENTORY', 'MOVING_AVERAGE', 100),
            ('ACC-C', 'RAW_INVENTORY', 'MOVING_AVERAGE', 100)
          ) as v(n, c, p, q)
        on conflict do nothing
      `);
      await tx.execute(sql`
        insert into stock_quantity (client, material_number, plant, storage_location, stock_type, quantity, created_by)
        select ${client}, v.n, ${PLANT}, 'RA01', 'UNRESTRICTED', 100, ${ACTOR}
          from (values ('ACC-B'), ('ACC-C')) as v(n)
        on conflict (client, material_number, plant, storage_location, stock_type, batch_number) do update set quantity = 100
      `);
      await tx.execute(sql`
        insert into material_period_control (
          client, company_code, current_fiscal_year, current_period, previous_fiscal_year, previous_period,
          allow_backposting, created_by
        ) values (${client}, ${COMPANY}, 2026, 10, 2026, 9, true, ${ACTOR})
        on conflict (client, company_code) do update set current_fiscal_year = 2026, current_period = 10
      `);
      await tx.execute(sql`
        insert into gl_account (
          client, chart_of_accounts, account_number, name, account_type, is_balance_sheet,
          is_open_item_managed, reconciliation_type, requires_cost_object, is_tax_relevant,
          account_group, gl_account_type, created_by
        )
        select ${client}, ${chart}, v.n, v.d, v.t, v.balance, false, null, false, false, 'GENL', v.kind, ${ACTOR}
          from (values
            ('122910', 'Accounting component inventory', 'ASSET', true, 'BALANCE_SHEET'),
            ('510910', 'Accounting production consumption', 'EXPENSE', false, 'PL_STATEMENT')
          ) as v(n, d, t, balance, kind)
        on conflict do nothing
      `);
      await tx.execute(sql`
        insert into account_determination (client, chart_of_accounts, event, valuation_class, general_modifier, gl_account, created_by)
        select ${client}, ${chart}, v.e, v.vc, '', v.a, ${ACTOR}
          from (values
            ('INVENTORY', 'RAW_INVENTORY', '122910'),
            ('PRODUCTION_CONSUMPTION', 'RAW_INVENTORY', '510910')
          ) as v(e, vc, a)
        on conflict do nothing
      `);
      await tx.execute(sql`
        insert into financial_statement_version (client, version, name, chart_of_accounts, created_by)
        values (${client}, 'RA01', 'Accounting reversal', ${chart}, ${ACTOR})
        on conflict do nothing
      `);
      await tx.execute(sql`
        insert into financial_statement_node (client, version, node, description, parent_node, sequence, created_by)
        values (${client}, 'RA01', 'ASSETS', 'Assets', null, 10, ${ACTOR})
        on conflict do nothing
      `);
      await tx.execute(sql`
        insert into financial_statement_assignment (
          client, version, node, account_from, account_to, presentation_sign, created_by
        ) values (${client}, 'RA01', 'ASSETS', '100000', '999999', 'NORMAL', ${ACTOR})
        on conflict do nothing
      `);
      await defineRange(tx, { client, objectCode: 'PRODORDER', subObject: '*', prefix: 'RA', numberLength: 7, createdBy: ACTOR });
      await defineRange(tx, { client, objectCode: 'MATDOC', subObject: '*', prefix: 'RA', numberLength: 8, createdBy: ACTOR });
      await defineRange(tx, {
        client, objectCode: 'RF_BELEG', companyCode: COMPANY, subObject: 'GENERAL',
        fiscalYear: 2026, prefix: 'JA', fromNumber: 1, toNumber: 999999, createdBy: ACTOR,
      });
      await tx.execute(sql`
        insert into production_order_type (client, order_type, description, order_category, created_by)
        values (${client}, 'PP01', 'Standard production', '10', ${ACTOR})
        on conflict (client, order_type) do nothing
      `);
    });
  }, 180_000);

  afterAll(async () => {
    if (client) await destroyTenant(client);
    if (other) await destroyTenant(other);
  }, 180_000);

  it('keeps the full journal posted until the last line, then reverses it once', async () => {
    const orderNumber = await order([
      { materialNumber: 'ACC-B', requiredQuantity: 5 },
      { materialNumber: 'ACC-C', requiredQuantity: 5 },
    ]);
    const beforeB = await valuation('ACC-B');
    const beforeC = await valuation('ACC-C');
    const posted = await issue(orderNumber, [
      { materialNumber: 'ACC-B', quantity: 2, item: 10 },
      { materialNumber: 'ACC-C', quantity: 3, item: 20 },
    ]);
    expect(posted.journalDocumentNumber).toBeTruthy();
    expect(await stock('ACC-B')).toBe(98);
    expect(await stock('ACC-C')).toBe(97);
    expect(await valuation('ACC-B')).toEqual({ quantity: beforeB.quantity - 2, value: beforeB.value - 20 });
    expect(await valuation('ACC-C')).toEqual({ quantity: beforeC.quantity - 3, value: beforeC.value - 30 });

    const original = await displayMaterialDocument({ client, documentNumber: posted.materialDocumentNumber });
    expect(original.journalAccounting.state).toBe('POSTED');
    expect(original.journalAccounting.note).toBe(JOURNAL_ACCOUNTING_NOTE.posted);
    const account = await inventoryAccount(posted.journalDocumentNumber!);
    expect(account).not.toBe('');
    const afterPost = await postedBalance(account);
    expect(afterPost.credit - afterPost.debit).toBe(50);
    const statement = await trialAccount(account);
    expect(statement?.balance).toBe(-50);

    const lines = await withTenant(client, (tx) => tx.execute(sql`
      select line_number, material_number from material_document_line
       where client = ${client} and material_document_number = ${posted.materialDocumentNumber}
    `)) as unknown as Array<{ line_number: number; material_number: string }>;
    const first = lines.find((line) => line.material_number === 'ACC-B')!;
    const second = lines.find((line) => line.material_number === 'ACC-C')!;
    const requestKey = nextKey();
    const partial = await reverseMaterialDocument({
      client, changedBy: ACTOR, materialDocumentNumber: posted.materialDocumentNumber,
      lines: [Number(first.line_number)], postingDate: DAY, documentDate: DAY, requestKey,
    });
    const replay = await reverseMaterialDocument({
      client, changedBy: ACTOR, materialDocumentNumber: posted.materialDocumentNumber,
      lines: [Number(first.line_number)], postingDate: DAY, documentDate: DAY, requestKey,
    });
    expect(replay.materialDocumentNumber).toBe(partial.materialDocumentNumber);
    expect(partial.journalAccounting.state).toBe('DEFERRED');
    expect(partial.journalAccounting.note).toContain('Accounting is not reversed yet.');
    expect(await stock('ACC-B')).toBe(100);
    expect(await stock('ACC-C')).toBe(97);
    expect(await valuation('ACC-B')).toEqual(beforeB);
    expect(await valuation('ACC-C')).toEqual({ quantity: beforeC.quantity - 3, value: beforeC.value - 30 });

    const midway = await displayMaterialDocument({ client, documentNumber: posted.materialDocumentNumber });
    expect(midway.status).toBe('PARTIALLY_REVERSED');
    expect(midway.journalAccounting.state).toBe('PARTIAL');
    expect(midway.journalAccounting.note).toContain('accounting is not reversed');
    const reversalDisplay = await displayMaterialDocument({ client, documentNumber: partial.materialDocumentNumber });
    expect(reversalDisplay.journalDocumentNumber).toBeNull();
    expect(reversalDisplay.journalAccounting.state).toBe('DEFERRED');
    expect(reversalDisplay.journalAccounting.note).not.toContain('carried no value');
    const orderDisplay = await getProductionOrderDisplay(client, orderNumber);
    expect(orderDisplay?.gaps.join(' ')).toContain(JOURNAL_ACCOUNTING_NOTE.partial);

    const stillPosted = await postedBalance(account);
    expect(stillPosted.credit - stillPosted.debit).toBe(50);
    expect((await trialAccount(account))?.balance).toBe(-50);
    const mirrors = await withTenant(client, (tx) => tx.execute(sql`
      select count(*)::int as mirrors from journal_entry
       where client = ${client} and reversal_of = ${posted.journalDocumentNumber}
    `)) as unknown as Array<{ mirrors: number }>;
    expect(Number(mirrors[0]?.mirrors)).toBe(0);

    const finishedKey = nextKey();
    const finished = await reverseMaterialDocument({
      client, changedBy: ACTOR, materialDocumentNumber: posted.materialDocumentNumber,
      lines: [Number(second.line_number)], postingDate: DAY, documentDate: DAY, requestKey: finishedKey,
    });
    const finishedReplay = await reverseMaterialDocument({
      client, changedBy: ACTOR, materialDocumentNumber: posted.materialDocumentNumber,
      lines: [Number(second.line_number)], postingDate: DAY, documentDate: DAY, requestKey: finishedKey,
    });
    expect(finishedReplay.materialDocumentNumber).toBe(finished.materialDocumentNumber);
    expect(finished.journalAccounting.state).toBe('COMPLETE');
    expect(await stock('ACC-C')).toBe(100);
    expect(await valuation('ACC-C')).toEqual(beforeC);
    const completed = await displayMaterialDocument({ client, documentNumber: posted.materialDocumentNumber });
    expect(completed.status).toBe('REVERSED');
    expect(completed.journalAccounting.state).toBe('COMPLETE');
    expect(completed.journalAccounting.note).toContain('accounting reversal are complete');
    const journals = await withTenant(client, (tx) => tx.execute(sql`
      select e.document_number, e.status,
             coalesce(sum(case when l.debit_credit = 'S' then l.amount_local else -l.amount_local end), 0)::text as net
        from journal_entry e
        join journal_entry_line l
          on l.client = e.client and l.document_number = e.document_number and l.fiscal_year = e.fiscal_year
       where e.client = ${client}
         and (e.document_number = ${posted.journalDocumentNumber} or e.reversal_of = ${posted.journalDocumentNumber})
       group by e.document_number, e.status
    `)) as unknown as Array<{ document_number: string; status: string; net: string }>;
    expect(journals).toHaveLength(2);
    expect(journals.every((row) => Number(row.net) === 0)).toBe(true);
    expect(journals.find((row) => row.document_number === posted.journalDocumentNumber)?.status).toBe('REVERSED');
    expect(journals.find((row) => row.document_number === finished.journalDocumentNumber)?.status).toBe('POSTED');
    // Current balances keep the reversed original and the reversal journal, so the pair nets.
    expect((await trialAccount(account))?.balance).toBe(0);
    const gl = await getGlBalances(client, { glAccount: account, companyCode: COMPANY, fiscalYear: 2026 });
    expect(gl.yearClosing).toBe(0);
    const balanceSheet = await calculateBalanceSheet({
      client,
      selection: {
        companyCode: COMPANY, statementVersion: 'RA01', fiscalYear: 2026,
        periodFrom: 1, periodTo: 12, includeSpecialPeriods: false, ledger: '0L',
        calculationType: 'ACCUMULATED', summaryLevel: 1,
      },
    });
    const sheetRows = [
      ...balanceSheet.nodes.flatMap((node) => node.accounts),
      ...balanceSheet.unassigned,
    ];
    expect(sheetRows.find((row) => row.accountNumber === account)?.balance).toBe(0);
    const after = await getProductionOrderDisplay(client, orderNumber);
    expect(after?.gaps.join(' ')).not.toContain('accounting is not reversed');
  }, 60_000);

  it('rolls back the last line when the journal reversal cannot post', async () => {
    const orderNumber = await order([
      { materialNumber: 'ACC-B', requiredQuantity: 2 },
      { materialNumber: 'ACC-C', requiredQuantity: 2 },
    ]);
    const posted = await issue(orderNumber, [
      { materialNumber: 'ACC-B', quantity: 1, item: 10 },
      { materialNumber: 'ACC-C', quantity: 1, item: 20 },
    ]);
    const lines = await withTenant(client, (tx) => tx.execute(sql`
      select line_number, material_number from material_document_line
       where client = ${client} and material_document_number = ${posted.materialDocumentNumber}
    `)) as unknown as Array<{ line_number: number; material_number: string }>;
    const first = lines.find((line) => line.material_number === 'ACC-B')!;
    const second = lines.find((line) => line.material_number === 'ACC-C')!;
    await reverseMaterialDocument({
      client, changedBy: ACTOR, materialDocumentNumber: posted.materialDocumentNumber,
      lines: [Number(first.line_number)], postingDate: DAY, documentDate: DAY, requestKey: nextKey(),
    });
    const stockBefore = await stock('ACC-C');
    await expect(withTenant(client, (tx) => tx.execute(sql`
      update journal_entry_line
         set amount_local = amount_local + 1
       where client = ${client} and document_number = ${posted.journalDocumentNumber}
         and line_number = (
           select min(line_number) from journal_entry_line
            where client = ${client} and document_number = ${posted.journalDocumentNumber}
         )
    `))).rejects.toThrow(/does not balance/);
    await withTenant(client, (tx) => tx.execute(sql`
      update material_document
         set journal_document_number = '1000/2026/999999'
       where client = ${client} and material_document_number = ${posted.materialDocumentNumber}
    `));
    await expect(reverseMaterialDocument({
      client, changedBy: ACTOR, materialDocumentNumber: posted.materialDocumentNumber,
      lines: [Number(second.line_number)], postingDate: DAY, documentDate: DAY, requestKey: nextKey(),
    })).rejects.toThrow(/does not exist/);
    expect(await stock('ACC-C')).toBe(stockBefore);
    const status = await withTenant(client, (tx) => tx.execute(sql`
      select status, journal_document_number from material_document
       where client = ${client} and material_document_number = ${posted.materialDocumentNumber}
    `)) as unknown as Array<{ status: string; journal_document_number: string }>;
    expect(status[0]?.status).toBe('PARTIALLY_REVERSED');
    expect(status[0]?.journal_document_number).toBe('1000/2026/999999');
    const extra = await withTenant(client, (tx) => tx.execute(sql`
      select count(*)::int as docs from material_document
       where client = ${client} and reversal_of = ${posted.materialDocumentNumber}
    `)) as unknown as Array<{ docs: number }>;
    expect(Number(extra[0]?.docs)).toBe(1);
    const journal = await withTenant(client, (tx) => tx.execute(sql`
      select status from journal_entry
       where client = ${client} and document_number = ${posted.journalDocumentNumber}
    `)) as unknown as Array<{ status: string }>;
    expect(journal[0]?.status).toBe('POSTED');
    const shown = await displayMaterialDocument({ client, documentNumber: posted.materialDocumentNumber });
    expect(shown.journalAccounting.state).toBe('ABSENT');
    expect(shown.journalAccounting.note).toContain('Accounting is not reversed.');
  }, 60_000);

  it('rolls back stock and the journal when the reversal value cannot be posted', async () => {
    const orderNumber = await order([{ materialNumber: 'ACC-B', requiredQuantity: 4 }]);
    const posted = await issue(orderNumber, [{ materialNumber: 'ACC-B', quantity: 4, item: 10 }]);
    const stockBefore = await stock('ACC-B');
    await withTenant(client, (tx) => tx.execute(sql`
      delete from material_valuation
       where client = ${client} and material_number = 'ACC-B' and valuation_area = ${PLANT}
    `));
    await expect(reverseMaterialDocument({
      client, changedBy: ACTOR, materialDocumentNumber: posted.materialDocumentNumber,
      postingDate: DAY, documentDate: DAY, requestKey: nextKey(),
    })).rejects.toThrow(/has no valuation/);
    expect(await stock('ACC-B')).toBe(stockBefore);
    const status = await withTenant(client, (tx) => tx.execute(sql`
      select status from material_document
       where client = ${client} and material_document_number = ${posted.materialDocumentNumber}
    `)) as unknown as Array<{ status: string }>;
    expect(status[0]?.status).toBe('POSTED');
    const journal = await withTenant(client, (tx) => tx.execute(sql`
      select status from journal_entry
       where client = ${client} and document_number = ${posted.journalDocumentNumber}
    `)) as unknown as Array<{ status: string }>;
    expect(journal[0]?.status).toBe('POSTED');
    const docs = await withTenant(client, (tx) => tx.execute(sql`
      select count(*)::int as docs from material_document
       where client = ${client} and reversal_of = ${posted.materialDocumentNumber}
    `)) as unknown as Array<{ docs: number }>;
    expect(Number(docs[0]?.docs)).toBe(0);
    await withTenant(client, (tx) => tx.execute(sql`
      insert into material_valuation (
        client, material_number, valuation_area, valuation_class, price_control,
        standard_price, moving_average_price, price_unit, currency, total_stock_quantity, stock_value, created_by
      ) values (
        ${client}, 'ACC-B', ${PLANT}, 'RAW_INVENTORY', 'MOVING_AVERAGE',
        10, 10, 1, 'USD', ${stockBefore}, ${stockBefore * 10}, ${ACTOR}
      )
    `));
  }, 60_000);

  it('does not reverse another tenant\'s document, and the screen still requires the capability', async () => {
    const orderNumber = await order([{ materialNumber: 'ACC-C', requiredQuantity: 1 }]);
    const posted = await issue(orderNumber, [{ materialNumber: 'ACC-C', quantity: 1, item: 10 }]);
    await expect(reverseMaterialDocument({
      client: other, changedBy: ACTOR, materialDocumentNumber: posted.materialDocumentNumber,
      postingDate: DAY, documentDate: DAY, requestKey: nextKey(),
    })).rejects.toThrow(MaterialReversalError);
    const action = readFileSync('src/app/inventory/reversal/actions.ts', 'utf8');
    expect(action).toContain('REVERSE_CAPABILITY');
    expect(action).toContain('You do not hold the material document reversal capability.');
    const status = await withTenant(client, (tx) => tx.execute(sql`
      select status from material_document
       where client = ${client} and material_document_number = ${posted.materialDocumentNumber}
    `)) as unknown as Array<{ status: string }>;
    expect(status[0]?.status).toBe('POSTED');
  }, 60_000);

  it('nets the reversed journal in current balances and keeps both documents in history', async () => {
    const orderNumber = await order([{ materialNumber: 'ACC-C', requiredQuantity: 2 }]);
    const posted = await issue(orderNumber, [{ materialNumber: 'ACC-C', quantity: 2, item: 10 }]);
    const account = await inventoryAccount(posted.journalDocumentNumber!);
    const afterIssue = (await trialAccount(account))?.balance ?? 0;
    const glAfterIssue = await getGlBalances(client, { glAccount: account, companyCode: COMPANY, fiscalYear: 2026 });
    const early = await calculateTrialBalance({
      client,
      selection: {
        companyCode: COMPANY, statementVersion: 'RA01', fiscalYear: 2026,
        periodFrom: 1, periodTo: 9, includeSpecialPeriods: false, ledger: '0L',
      },
    });
    const earlyBalance = early.nodes.flatMap((node) => node.accounts).find((row) => row.accountNumber === account)?.balance ?? 0;
    expect(earlyBalance).toBe(0);

    await withTenant(client, (tx) => tx.execute(sql`
      insert into journal_entry (
        client, document_number, fiscal_year, document_type, company_code, document_date,
        posting_date, posting_period, document_currency, local_currency, status, created_by
      ) values (
        ${client}, 'RA-PARKED', 2026, 'SA', ${COMPANY}, ${DAY}, ${DAY}, 10, 'USD', 'USD', 'PARKED', ${ACTOR}
      )
    `));
    await withTenant(client, (tx) => tx.execute(sql`
      insert into journal_entry_line (
        client, document_number, fiscal_year, line_number, gl_account, company_code,
        debit_credit, amount_local, amount_document, currency
      ) values
        (${client}, 'RA-PARKED', 2026, 1, ${account}, ${COMPANY}, 'S', 77, 77, 'USD'),
        (${client}, 'RA-PARKED', 2026, 2, '510910', ${COMPANY}, 'H', 77, 77, 'USD')
    `));
    expect((await trialAccount(account))?.balance).toBe(afterIssue);
    const glInCompanyCurrency = await getGlBalances(client, {
      glAccount: account, companyCode: COMPANY, fiscalYear: 2026, currency: 'USD',
    });
    expect(glInCompanyCurrency.currency).toBe('USD');
    expect(glInCompanyCurrency.yearClosing).toBe(glAfterIssue.yearClosing);
    await expect(getGlBalances(client, {
      glAccount: account, companyCode: COMPANY, fiscalYear: 2026, currency: 'EUR',
    })).rejects.toThrow(/cannot display in EUR/);
    await expect(calculateTrialBalance({
      client,
      selection: {
        companyCode: '2000', statementVersion: 'RA01', fiscalYear: 2026,
        periodFrom: 1, periodTo: 12, includeSpecialPeriods: false, ledger: '0L',
      },
    })).rejects.toThrow(/2000/);

    const requestKey = nextKey();
    const finished = await reverseMaterialDocument({
      client, changedBy: ACTOR, materialDocumentNumber: posted.materialDocumentNumber,
      postingDate: DAY, documentDate: DAY, requestKey,
    });
    const replay = await reverseMaterialDocument({
      client, changedBy: ACTOR, materialDocumentNumber: posted.materialDocumentNumber,
      postingDate: DAY, documentDate: DAY, requestKey,
    });
    expect(replay.materialDocumentNumber).toBe(finished.materialDocumentNumber);
    await expect(reverseMaterialDocument({
      client, changedBy: ACTOR, materialDocumentNumber: posted.materialDocumentNumber,
      postingDate: DAY, documentDate: DAY, requestKey: nextKey(),
    })).rejects.toThrow(/already been cancelled/);
    expect((await trialAccount(account))?.balance).toBe(afterIssue + 20);
    const glAfter = await getGlBalances(client, { glAccount: account, companyCode: COMPANY, fiscalYear: 2026 });
    expect(glAfter.yearClosing).toBe(glAfterIssue.yearClosing + 20);

    const yearRows = await withTenant(client, (tx) => tx.execute(sql`
      select fiscal_year from journal_entry
       where client = ${client} and document_number = ${posted.journalDocumentNumber}
    `)) as unknown as Array<{ fiscal_year: number }>;
    const year = Number(yearRows[0]?.fiscal_year);
    const original = await getJournalDocument(client, {
      documentNumber: posted.journalDocumentNumber!, companyCode: COMPANY, fiscalYear: year,
    });
    const reversal = await getJournalDocument(client, {
      documentNumber: finished.journalDocumentNumber!, companyCode: COMPANY, fiscalYear: year,
    });
    expect(original.kind).toBe('FOUND');
    expect(reversal.kind).toBe('FOUND');
    if (original.kind === 'FOUND' && reversal.kind === 'FOUND') {
      expect(original.document.status).toBe('REVERSED');
      expect(original.document.flow.some((link) => link.kind === 'REVERSED_BY' && link.documentNumber === finished.journalDocumentNumber)).toBe(true);
      expect(reversal.document.status).toBe('POSTED');
      expect(reversal.document.flow.some((link) => link.kind === 'REVERSAL_OF' && link.documentNumber === posted.journalDocumentNumber)).toBe(true);
      expect(original.document.lines.map((line) => line.glAccount).sort())
        .toEqual(reversal.document.lines.map((line) => line.glAccount).sort());
    }
    const hidden = await getJournalDocument(other, {
      documentNumber: posted.journalDocumentNumber!, companyCode: COMPANY, fiscalYear: year,
    });
    expect(hidden.kind).toBe('NOT_FOUND');
    const items = await getJournalItems(client, {
      accountFrom: account, companyCodes: [COMPANY], fiscalYear: 2026, status: 'ALL',
      documentNumber: posted.journalDocumentNumber!,
    });
    expect(items.rows.length).toBeGreaterThan(0);
    expect(items.rows.every((row) => row.documentStatus === 'REVERSED')).toBe(true);
    const reversalItems = await getJournalItems(client, {
      accountFrom: account, companyCodes: [COMPANY], fiscalYear: 2026, status: 'ALL',
      documentNumber: finished.journalDocumentNumber!,
    });
    expect(reversalItems.rows.length).toBeGreaterThan(0);
    expect(reversalItems.rows.every((row) => row.documentStatus === 'POSTED')).toBe(true);
  }, 60_000);
});
