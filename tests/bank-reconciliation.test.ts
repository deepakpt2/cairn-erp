/**
 * Manual bank statement reconciliation.
 *
 * A statement is evidence, not a posting: entering, matching, finalizing, reopening and exporting must
 * never create a second journal, clear an AR/AP item or mark a payment bank-executed. The tests below
 * exercise the cycle end to end, the as-of timing bridge (including a carried cutover baseline), a bank
 * fee that only becomes matchable after the ordinary posting path, allocations and retries, integrity
 * refusals, currency precision (including 3-decimal KWD and overdraft signs), tenant/company/capability
 * isolation, shared-G/L ambiguity and reversal protection.
 */
import { sql } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';

import { withTenant } from '../src/platform/db/client';
import { postJournalEntry, type PostedJournal } from '../src/platform/posting';
import { reverseDocument } from '../src/modules/finance/document-reversal';
import {
  BANK_STATEMENT_DISPLAY_CAPABILITY,
  BankReconciliationError,
  bankReconciliationCsv,
  finalizeBankStatement,
  getBankReconciliation,
  listReconcilableBankAccounts,
  matchBankStatement,
  reopenBankStatement,
  saveBankStatement,
  unmatchBankStatement,
  type BankStatementLineInput,
  type SaveBankStatementInput,
} from '../src/modules/finance/bank-reconciliation';
import { closeDb, createTenant, defineTestRanges, destroyTenant, type TestTenant } from './helpers';
import { createFinanceActor, type FinanceActor } from './helpers/finance-actor';

interface Ctx {
  tenant: TestTenant;
  client: string;
  actor: FinanceActor;
  currency: string;
}

const tenants: TestTenant[] = [];

async function setup(
  seed: string,
  options: {
    currency?: string;
    accounts?: Array<{ house: string; account: string; gl: string }>;
  } = {},
): Promise<Ctx> {
  const currency = options.currency ?? 'USD';
  const tenant = await createTenant(seed, { currency });
  tenants.push(tenant);
  await defineTestRanges(tenant, { fiscalYear: 2026 });
  const accounts = options.accounts ?? [{ house: 'HB01', account: 'MAIN', gl: '101000' }];
  await withTenant(tenant.client, async (tx) => {
    await tx.execute(sql`
      insert into bank_master (bank_country, bank_key, name, created_by)
      values ('KW', 'NBK001', 'Test National Bank', 'BANK_RECON_TEST')
      on conflict do nothing
    `);
    for (const entry of accounts) {
      await tx.execute(sql`
        insert into house_bank (client, company_code, house_bank_key, bank_country, bank_key, created_by)
        values (${tenant.client}, '1000', ${entry.house}, 'KW', 'NBK001', 'BANK_RECON_TEST')
        on conflict do nothing
      `);
      await tx.execute(sql`
        insert into bank_account
          (client, company_code, house_bank_key, account_id, account_number, currency, gl_account, created_by)
        values (${tenant.client}, '1000', ${entry.house}, ${entry.account}, '12345678', ${currency}, ${entry.gl}, 'BANK_RECON_TEST')
        on conflict do nothing
      `);
    }
  });
  const actor = await createFinanceActor(tenant.client);
  return { tenant, client: tenant.client, actor, currency };
}

afterAll(async () => {
  for (const tenant of tenants) await destroyTenant(tenant.client);
  await closeDb();
}, 300_000);

function line(
  direction: 'IN' | 'OUT',
  amount: string,
  date: string,
  reference = '',
  description = '',
): BankStatementLineInput {
  return {
    direction,
    amount,
    valueDate: date,
    transactionDate: date,
    ...(reference ? { bankReference: reference } : {}),
    ...(description ? { description } : {}),
  };
}

function bankStatement(
  ctx: Ctx,
  input: Partial<SaveBankStatementInput> & Pick<SaveBankStatementInput, 'statementReference' | 'fromDate' | 'toDate' | 'openingBalance' | 'closingBalance' | 'lines'>,
): SaveBankStatementInput {
  return {
    client: ctx.client,
    companyCode: '1000',
    houseBankKey: 'HB01',
    accountId: 'MAIN',
    currency: ctx.currency,
    ...input,
  };
}

async function postBank(
  ctx: Ctx,
  input: { amount: string; direction: 'IN' | 'OUT'; date: string; text: string },
): Promise<PostedJournal> {
  const other = '400000';
  return withTenant(ctx.client, (tx) => postJournalEntry(tx, {
    client: ctx.client,
    companyCode: '1000',
    documentType: 'SA',
    documentDate: input.date,
    postingDate: input.date,
    fiscalYear: 2026,
    postingPeriod: Number(input.date.slice(5, 7)),
    currency: ctx.currency,
    localCurrency: ctx.currency,
    headerText: input.text,
    postedBy: 'BANK_RECON_TEST',
    precision: 'CURRENCY',
    lines: input.direction === 'IN'
      ? [
        { glAccount: '101000', debitCredit: 'S', amount: input.amount },
        { glAccount: other, debitCredit: 'H', amount: input.amount },
      ]
      : [
        { glAccount: other, debitCredit: 'S', amount: input.amount },
        { glAccount: '101000', debitCredit: 'H', amount: input.amount },
      ],
  }));
}

function bankLine(direction: 'IN' | 'OUT'): number {
  return direction === 'IN' ? 1 : 2;
}

function allocation(
  statementLineId: string,
  posted: PostedJournal,
  direction: 'IN' | 'OUT',
  amount: string,
) {
  return {
    statementLineId,
    ledgerDocumentNumber: posted.documentNumber,
    ledgerFiscalYear: posted.fiscalYear,
    ledgerLineNumber: bankLine(direction),
    amount,
  };
}

async function save(ctx: Ctx, input: SaveBankStatementInput) {
  return saveBankStatement(input, { authorization: ctx.actor.authorization });
}

async function view(ctx: Ctx, statementId?: string, accountId = 'MAIN') {
  return getBankReconciliation({
    client: ctx.client,
    companyCode: '1000',
    houseBankKey: 'HB01',
    accountId,
    ...(statementId ? { statementId } : {}),
  }, { authorization: ctx.actor.authorization });
}

async function match(ctx: Ctx, statementId: string, allocations: ReturnType<typeof allocation>[], requestKey?: string) {
  return matchBankStatement({
    client: ctx.client,
    statementId,
    allocations,
    ...(requestKey ? { requestKey } : {}),
  }, { authorization: ctx.actor.authorization });
}

async function journalCount(ctx: Ctx): Promise<number> {
  return withTenant(ctx.client, async (tx) => {
    const rows = await tx.execute(sql`
      select count(*)::int as n from journal_entry where client = ${ctx.client}
    `) as unknown as Array<{ n: number }>;
    return rows[0]!.n;
  });
}

describe('bank reconciliation — core cycle, as-of bridge and period evidence', () => {
  let ctx: Ctx;
  let mayIn: PostedJournal;
  let mayOut: PostedJournal;
  let juneIn: PostedJournal;
  let juneOut: PostedJournal;
  let mayStatementId = '';
  let juneStatementId = '';
  let julyStatementId = '';
  let augustStatementId = '';

  it('sets up a tenant with a bank account', async () => {
    ctx = await setup('bank-recon-core');
    expect(ctx.currency).toBe('USD');
  });

  it('enters, matches, finalizes and reopens a balanced statement without posting', async () => {
    mayIn = await postBank(ctx, { amount: '500.00', direction: 'IN', date: '2026-05-02', text: 'May deposit' });
    mayOut = await postBank(ctx, { amount: '200.00', direction: 'OUT', date: '2026-05-04', text: 'May withdrawal' });

    const saved = await save(ctx, bankStatement(ctx, {
      statementReference: 'STMT-MAY', fromDate: '2026-05-01', toDate: '2026-05-31',
      openingBalance: '1000.00', closingBalance: '1300.00',
      baseline: true, baselineAmount: '1000.00', baselineReason: 'Ledger stands from before the bank feed cutover.',
      lines: [line('IN', '500.00', '2026-05-02', 'DEP-1'), line('OUT', '200.00', '2026-05-04', 'WDR-1')],
    }));
    mayStatementId = saved.statementId;
    expect(saved.arithmeticValid).toBe(true);
    expect(saved.arithmeticDifference).toBe('0.00');

    const before = await view(ctx, mayStatementId);
    expect(before.bridge?.ledgerClosing).toBe('300.00');
    expect(before.bridge?.unexplainedDifference).toBe('0.00');
    expect(before.ledgerLines).toHaveLength(2);
    expect(before.bridge?.baselineAmount).toBe('1000.00');

    const [inLine, outLine] = before.statement!.lines;
    await match(ctx, mayStatementId, [
      allocation(inLine!.lineId, mayIn, 'IN', '500.00'),
      allocation(outLine!.lineId, mayOut, 'OUT', '200.00'),
    ]);

    const matched = await view(ctx, mayStatementId);
    expect(matched.statement!.lines.every((l) => l.remainingAmount === '0.00')).toBe(true);
    expect(matched.bridge?.unmatchedStatementAmount).toBe('0.00');
    expect(matched.bridge?.unmatchedLedgerAmount).toBe('0.00');

    const journalsBeforeSignOff = await journalCount(ctx);
    const finalized = await finalizeBankStatement({
      client: ctx.client, statementId: mayStatementId, confirmed: true,
    }, { authorization: ctx.actor.authorization });
    expect(finalized.snapshotId).toBeTruthy();
    expect(await journalCount(ctx)).toBe(journalsBeforeSignOff);

    const signed = await view(ctx, mayStatementId);
    expect(signed.statement?.status).toBe('FINALIZED');
    expect(signed.snapshots).toHaveLength(1);

    await reopenBankStatement({
      client: ctx.client, statementId: mayStatementId, reason: 'Bank reference corrected by the accountant.',
    }, { authorization: ctx.actor.authorization });
    const reopened = await view(ctx, mayStatementId);
    expect(reopened.statement?.status).toBe('REOPENED');
    expect(reopened.snapshots).toHaveLength(1);
    expect(reopened.changedSinceSnapshot).toBe(true);

    // Restore the signed state for the later periods; the reopen keeps the first snapshot.
    await finalizeBankStatement({
      client: ctx.client, statementId: mayStatementId, confirmed: true,
    }, { authorization: ctx.actor.authorization });
    const refinalized = await view(ctx, mayStatementId);
    expect(refinalized.snapshots).toHaveLength(2);
    expect(refinalized.statement?.status).toBe('FINALIZED');
  });

  it('explains a timing difference as of the statement date and carries the cutover baseline', async () => {
    juneIn = await postBank(ctx, { amount: '1000.00', direction: 'IN', date: '2026-06-02', text: 'June deposit' });
    juneOut = await postBank(ctx, { amount: '100.00', direction: 'OUT', date: '2026-06-05', text: 'Outstanding June payment' });

    const saved = await save(ctx, bankStatement(ctx, {
      statementReference: 'STMT-JUN', fromDate: '2026-06-01', toDate: '2026-06-30',
      openingBalance: '1300.00', closingBalance: '2300.00',
      lines: [line('IN', '1000.00', '2026-06-02', 'DEP-2')],
    }));
    juneStatementId = saved.statementId;

    const inLine = (await view(ctx, juneStatementId)).statement!.lines[0]!;
    await match(ctx, juneStatementId, [allocation(inLine.lineId, juneIn, 'IN', '1000.00')]);

    const bridged = await view(ctx, juneStatementId);
    expect(bridged.bridge?.statementClosing).toBe('2300.00');
    expect(bridged.bridge?.ledgerClosing).toBe('1200.00');
    expect(bridged.bridge?.closingDifference).toBe('1100.00');
    expect(bridged.bridge?.unmatchedStatementAmount).toBe('0.00');
    expect(bridged.bridge?.unmatchedLedgerAmount).toBe('-100.00');
    expect(bridged.bridge?.baselineAmount).toBe('1000.00');
    expect(bridged.bridge?.unexplainedDifference).toBe('0.00');
    const outstanding = bridged.ledgerLines.find((l) => l.documentNumber === juneOut.documentNumber);
    expect(outstanding?.remainingAmount).toBe('-100.00');

    // Signing off is allowed with an identified outstanding item; the difference is not forced to zero.
    await finalizeBankStatement({
      client: ctx.client, statementId: juneStatementId, confirmed: true,
    }, { authorization: ctx.actor.authorization });
    const juneSigned = await view(ctx, juneStatementId);
    expect(juneSigned.statement?.status).toBe('FINALIZED');
    expect(juneSigned.snapshots[0]?.unmatchedLedgerAmount).toBe('-100.0000');

    const july = await save(ctx, bankStatement(ctx, {
      statementReference: 'STMT-JUL', fromDate: '2026-07-01', toDate: '2026-07-31',
      openingBalance: '2300.00', closingBalance: '2200.00',
      lines: [line('OUT', '100.00', '2026-06-30', 'WDR-2')],
    }));
    julyStatementId = july.statementId;
    const julyLine = (await view(ctx, julyStatementId)).statement!.lines[0]!;
    await match(ctx, julyStatementId, [allocation(julyLine.lineId, juneOut, 'OUT', '100.00')]);

    const julyView = await view(ctx, julyStatementId);
    expect(julyView.bridge?.ledgerClosing).toBe('1200.00');
    expect(julyView.bridge?.unexplainedDifference).toBe('0.00');
    expect(julyView.priorStatementLines).toHaveLength(0);

    // The June signed snapshot is not rewritten by the later match.
    const juneSnapshot = await withTenant(ctx.client, async (tx) => {
      const rows = await tx.execute(sql`
        select ledger_closing_balance::text as ledger, unmatched_ledger_amount::text as unmatched
          from bank_reconciliation_snapshot
         where client = ${ctx.client} and statement_id = ${juneStatementId}
         order by sequence limit 1
      `) as unknown as Array<{ ledger: string; unmatched: string }>;
      return rows[0];
    });
    expect(juneSnapshot).toEqual({ ledger: '1200.0000', unmatched: '-100.0000' });
    const juneNow = await view(ctx, juneStatementId);
    expect(juneNow.changedSinceSnapshot).toBe(true);
    expect(juneNow.changeReasons.length).toBeGreaterThan(0);

    await finalizeBankStatement({
      client: ctx.client, statementId: julyStatementId, confirmed: true,
    }, { authorization: ctx.actor.authorization });
  });

  it('shows a bank fee as a statement-side exception until the ordinary posting path records it', async () => {
    const beforeJournals = await journalCount(ctx);
    const august = await save(ctx, bankStatement(ctx, {
      statementReference: 'STMT-AUG', fromDate: '2026-08-01', toDate: '2026-08-31',
      openingBalance: '2200.00', closingBalance: '2175.00',
      lines: [line('OUT', '25.00', '2026-08-06', 'FEE-1', 'Account maintenance fee')],
    }));
    augustStatementId = august.statementId;

    const feeUnmatched = await view(ctx, augustStatementId);
    expect(await journalCount(ctx)).toBe(beforeJournals); // no automatic fee posting
    expect(feeUnmatched.bridge?.unmatchedStatementAmount).toBe('-25.00');
    expect(feeUnmatched.bridge?.unexplainedDifference).toBe('0.00');
    expect(feeUnmatched.bridge?.closingDifference).toBe('975.00');

    // The fee is recorded through the existing posting path, then matched once.
    const feePosting = await postBank(ctx, {
      amount: '25.00', direction: 'OUT', date: '2026-08-06', text: 'Bank fee journal',
    });
    expect(await journalCount(ctx)).toBe(beforeJournals + 1);
    const feeLine = (await view(ctx, augustStatementId)).statement!.lines[0]!;
    await match(ctx, augustStatementId, [allocation(feeLine.lineId, feePosting, 'OUT', '25.00')]);

    const afterMatch = await view(ctx, augustStatementId);
    expect(afterMatch.bridge?.unmatchedStatementAmount).toBe('0.00');
    expect(afterMatch.bridge?.ledgerClosing).toBe('1175.00');
    expect(afterMatch.bridge?.unexplainedDifference).toBe('0.00');

    await finalizeBankStatement({
      client: ctx.client, statementId: augustStatementId, confirmed: true,
    }, { authorization: ctx.actor.authorization });
  });

  it('refuses a reversal of a matched journal and shows the match as the blocker', async () => {
    const error = await reverseDocument({
      client: ctx.client,
      authorization: ctx.actor.authorization,
      changedBy: ctx.actor.username,
      companyCode: '1000',
      documentNumber: mayIn.documentNumber,
      fiscalYear: mayIn.fiscalYear,
      reasonCode: '01',
      documentDate: '2026-09-01',
      postingDate: '2026-09-01',
      confirmed: true,
      requestKey: 'bank-recon-reverse-block',
    }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(Error);
    expect(String((error as Error).message)).toMatch(/bank reconciliation match/);

    const status = await withTenant(ctx.client, async (tx) => {
      const rows = await tx.execute(sql`
        select status from journal_entry
         where client = ${ctx.client} and document_number = ${mayIn.documentNumber} and fiscal_year = ${mayIn.fiscalYear}
      `) as unknown as Array<{ status: string }>;
      return rows[0]?.status;
    });
    expect(status).toBe('POSTED');
  });

  it('flags a backdated posting inside a signed statement as a change, not a rewrite', async () => {
    await postBank(ctx, { amount: '10.00', direction: 'IN', date: '2026-08-20', text: 'Late backdated deposit' });
    const august = await view(ctx, augustStatementId);
    expect(august.changedSinceSnapshot).toBe(true);
    expect(august.changeReasons.join(' ')).toMatch(/posted after it was finalized/);
    const signedSnapshot = august.snapshots[0]!;
    expect(signedSnapshot.ledgerClosingBalance).toBe('1175.0000');
  });

  it('refuses a continuity break and an invalid arithmetic draft', async () => {
    const broken = await save(ctx, bankStatement(ctx, {
      statementReference: 'STMT-SEP', fromDate: '2026-09-01', toDate: '2026-09-30',
      openingBalance: '9999.00', closingBalance: '9999.00', lines: [line('IN', '0.01', '2026-09-02')],
    }));
    const brokenView = await view(ctx, broken.statementId);
    expect(brokenView.issues.some((issue) => issue.code === 'CONTINUITY_BREAK')).toBe(true);
    await expect(finalizeBankStatement({
      client: ctx.client, statementId: broken.statementId, confirmed: true,
    }, { authorization: ctx.actor.authorization })).rejects.toThrow(/unexplained|does not continue|difference/i);

    const invalid = await save(ctx, bankStatement(ctx, {
      statementReference: 'STMT-BAD', fromDate: '2026-10-01', toDate: '2026-10-31',
      openingBalance: '100.00', closingBalance: '200.00', lines: [line('IN', '10.00', '2026-10-02')],
    }));
    expect(invalid.arithmeticValid).toBe(false);
    await expect(finalizeBankStatement({
      client: ctx.client, statementId: invalid.statementId, confirmed: true,
    }, { authorization: ctx.actor.authorization })).rejects.toThrow(/does not equal|does not add up/);
  });
});

describe('bank reconciliation — allocations, duplicates and concurrency', () => {
  let ctx: Ctx;
  let ledger100: PostedJournal;
  let ledger60: PostedJournal;
  let ledger40: PostedJournal;
  let ledger50a: PostedJournal;
  let ledger50b: PostedJournal;
  let ledgerConcurrent: PostedJournal;
  let statementId = '';
  let lines: Array<{ lineId: string; lineNumber: number }> = [];

  it('sets up and matches one-to-many and many-to-one allocations', async () => {
    ctx = await setup('bank-recon-alloc');
    ledger100 = await postBank(ctx, { amount: '100.00', direction: 'IN', date: '2026-05-02', text: 'L100' });
    ledger60 = await postBank(ctx, { amount: '60.00', direction: 'IN', date: '2026-05-03', text: 'L60' });
    ledger40 = await postBank(ctx, { amount: '40.00', direction: 'IN', date: '2026-05-04', text: 'L40' });
    ledger50a = await postBank(ctx, { amount: '50.00', direction: 'IN', date: '2026-05-05', text: 'L50A' });
    ledger50b = await postBank(ctx, { amount: '50.00', direction: 'IN', date: '2026-05-05', text: 'L50B' });
    ledgerConcurrent = await postBank(ctx, { amount: '100.00', direction: 'IN', date: '2026-05-06', text: 'LCONC' });

    const saved = await save(ctx, bankStatement(ctx, {
      statementReference: 'ALLOC', fromDate: '2026-05-01', toDate: '2026-05-31',
      openingBalance: '0.00', closingBalance: '300.00',
      requestKey: 'alloc-statement-1',
      lines: [
        line('IN', '60.00', '2026-05-02', 'DUP-A'),
        line('IN', '40.00', '2026-05-02', 'DUP-A'),
        line('IN', '100.00', '2026-05-03', 'ONE-TO-MANY'),
        line('IN', '50.00', '2026-05-05', 'SAME-1'),
        line('IN', '50.00', '2026-05-05', 'SAME-1'),
      ],
    }));
    statementId = saved.statementId;
    lines = (await view(ctx, statementId)).statement!.lines.map((l) => ({ lineId: l.lineId, lineNumber: l.lineNumber }));

    // Many statement lines settle one bank line.
    await match(ctx, statementId, [
      allocation(lines[0]!.lineId, ledger100, 'IN', '60.00'),
      allocation(lines[1]!.lineId, ledger100, 'IN', '40.00'),
    ]);
    // One statement line settles two bank lines.
    await match(ctx, statementId, [
      allocation(lines[2]!.lineId, ledger60, 'IN', '60.00'),
      allocation(lines[2]!.lineId, ledger40, 'IN', '40.00'),
    ]);
    // Identical legitimate transactions are not rejected.
    await match(ctx, statementId, [allocation(lines[3]!.lineId, ledger50a, 'IN', '50.00')]);
    await match(ctx, statementId, [allocation(lines[4]!.lineId, ledger50b, 'IN', '50.00')]);

    const matched = await view(ctx, statementId);
    expect(matched.statement!.lines.every((l) => l.remainingAmount === '0.00')).toBe(true);
  });

  it('refuses over-allocation and replays a retried allocation idempotently', async () => {
    await expect(match(ctx, statementId, [allocation(lines[0]!.lineId, ledger100, 'IN', '1.00')]))
      .rejects.toThrow(/exceeds/);

    // Withdraw one identical match, then retry with a request key twice.
    const viewBefore = await view(ctx, statementId);
    const active = viewBefore.statement!.lines[4]!.matches.find((m) => m.isActive)!;
    await unmatchBankStatement({
      client: ctx.client, matchId: active.matchId, reason: 'Duplicate test withdrawal',
    }, { authorization: ctx.actor.authorization });

    const first = await match(ctx, statementId, [allocation(lines[4]!.lineId, ledger50b, 'IN', '50.00')], 'retry-alloc');
    const second = await match(ctx, statementId, [allocation(lines[4]!.lineId, ledger50b, 'IN', '50.00')], 'retry-alloc');
    expect(second.matchIds).toEqual(first.matchIds);

    const history = (await view(ctx, statementId)).statement!.lines[4]!.matches;
    expect(history.some((m) => !m.isActive && m.unmatchReason === 'Duplicate test withdrawal')).toBe(true);
  });

  it('serializes concurrent matches so one ledger amount cannot be consumed twice', async () => {
    const concurrent = await save(ctx, bankStatement(ctx, {
      statementReference: 'CONC', fromDate: '2026-05-01', toDate: '2026-05-31',
      openingBalance: '0.00', closingBalance: '200.00',
      lines: [line('IN', '100.00', '2026-05-06', 'C-1'), line('IN', '100.00', '2026-05-06', 'C-2')],
    }));
    const concLines = (await view(ctx, concurrent.statementId)).statement!.lines;
    const results = await Promise.allSettled([
      match(ctx, concurrent.statementId, [allocation(concLines[0]!.lineId, ledgerConcurrent, 'IN', '100.00')]),
      match(ctx, concurrent.statementId, [allocation(concLines[1]!.lineId, ledgerConcurrent, 'IN', '100.00')]),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    expect(String(rejected.reason?.message ?? rejected.reason)).toMatch(/exceeds/);
  });

  it('prevents duplicate statement submission but replays the same request key', async () => {
    await expect(save(ctx, bankStatement(ctx, {
      statementReference: 'ALLOC', fromDate: '2026-05-01', toDate: '2026-05-31',
      openingBalance: '0.00', closingBalance: '300.00', lines: [line('IN', '1.00', '2026-05-02')],
    }))).rejects.toThrow(/already stands/);

    const first = await save(ctx, bankStatement(ctx, {
      statementReference: 'ALLOC-2', fromDate: '2026-05-01', toDate: '2026-05-31',
      openingBalance: '0.00', closingBalance: '1.00', requestKey: 'alloc-statement-2',
      lines: [line('IN', '1.00', '2026-05-02')],
    }));
    const replay = await save(ctx, bankStatement(ctx, {
      statementReference: 'ALLOC-2', fromDate: '2026-05-01', toDate: '2026-05-31',
      openingBalance: '0.00', closingBalance: '1.00', requestKey: 'alloc-statement-2',
      lines: [line('IN', '1.00', '2026-05-02')],
    }));
    expect(replay.statementId).toBe(first.statementId);
  });
});

describe('bank reconciliation — currency precision and overdraft', () => {
  let usd: Ctx;
  let kwd: Ctx;

  it('reconciles an exact 3-decimal KWD statement and refuses excess precision', async () => {
    kwd = await setup('bank-recon-kwd', { currency: 'KWD' });
    const deposit = await postBank(kwd, { amount: '1.237', direction: 'IN', date: '2026-05-02', text: 'KWD deposit' });
    const saved = await save(kwd, bankStatement(kwd, {
      statementReference: 'KWD-MAY', fromDate: '2026-05-01', toDate: '2026-05-31',
      openingBalance: '0.000', closingBalance: '1.237',
      lines: [line('IN', '1.237', '2026-05-02', 'KWD-1')],
    }));
    const kLine = (await view(kwd, saved.statementId)).statement!.lines[0]!;
    await match(kwd, saved.statementId, [allocation(kLine.lineId, deposit, 'IN', '1.237')]);
    const signed = await view(kwd, saved.statementId);
    expect(signed.bridge?.unexplainedDifference).toBe('0.000');
    expect(signed.bridge?.ledgerClosing).toBe('1.237');
    await finalizeBankStatement({
      client: kwd.client, statementId: saved.statementId, confirmed: true,
    }, { authorization: kwd.actor.authorization });

    await expect(save(kwd, bankStatement(kwd, {
      statementReference: 'KWD-PREC', fromDate: '2026-06-01', toDate: '2026-06-30',
      openingBalance: '1.237', closingBalance: '1.238', lines: [line('IN', '0.0011', '2026-06-02')],
    }))).rejects.toThrow(/decimal places/);
  });

  it('keeps signed overdraft balances and refuses a 3-decimal amount in USD', async () => {
    const out5 = await postBank(kwd, { amount: '5.000', direction: 'OUT', date: '2026-07-02', text: 'KWD fee 1' });
    const out10 = await postBank(kwd, { amount: '10.000', direction: 'OUT', date: '2026-07-03', text: 'KWD fee 2' });
    const overdraft = await save(kwd, bankStatement(kwd, {
      statementReference: 'KWD-JUL', fromDate: '2026-07-01', toDate: '2026-07-31',
      openingBalance: '1.237', closingBalance: '-13.763',
      lines: [line('OUT', '5.000', '2026-07-02', 'KWD-OUT-1'), line('OUT', '10.000', '2026-07-03', 'KWD-OUT-2')],
    }));
    const lines = (await view(kwd, overdraft.statementId)).statement!.lines;
    expect(lines.every((l) => l.signedAmount.startsWith('-'))).toBe(true);
    await match(kwd, overdraft.statementId, [
      allocation(lines[0]!.lineId, out5, 'OUT', '5.000'),
      allocation(lines[1]!.lineId, out10, 'OUT', '10.000'),
    ]);
    const signed = await view(kwd, overdraft.statementId);
    expect(signed.bridge?.statementClosing).toBe('-13.763');
    expect(signed.bridge?.ledgerClosing).toBe('-13.763');
    expect(signed.bridge?.unexplainedDifference).toBe('0.000');
    await finalizeBankStatement({
      client: kwd.client, statementId: overdraft.statementId, confirmed: true,
    }, { authorization: kwd.actor.authorization });

    usd = await setup('bank-recon-usd-precision');
    await expect(save(usd, bankStatement(usd, {
      statementReference: 'USD-PREC', fromDate: '2026-10-01', toDate: '2026-10-31',
      openingBalance: '0.00', closingBalance: '1.23', lines: [line('IN', '1.234', '2026-10-02')],
    }))).rejects.toThrow(/decimal places/);
  });
});

describe('bank reconciliation — isolation, capability and ambiguity', () => {
  let a: Ctx;
  let b: Ctx;
  let statementId = '';

  it('sets up two tenants and a statement', async () => {
    a = await setup('bank-recon-sec-a');
    b = await setup('bank-recon-sec-b');
    const posted = await postBank(b, { amount: '10.00', direction: 'IN', date: '2026-05-02', text: 'B deposit' });
    void posted;
    const saved = await save(b, bankStatement(b, {
      statementReference: 'B-MAY', fromDate: '2026-05-01', toDate: '2026-05-31',
      openingBalance: '0.00', closingBalance: '10.00', lines: [line('IN', '10.00', '2026-05-02')],
    }));
    statementId = saved.statementId;
  });

  it('refuses another tenant, another company and a missing capability without partial mutation', async () => {
    const before = await withTenant(b.client, async (tx) => {
      const rows = await tx.execute(sql`
        select count(*)::int as n from bank_statement where client = ${b.client}
      `) as unknown as Array<{ n: number }>;
      return rows[0]!.n;
    });

    await expect(getBankReconciliation({
      client: b.client, companyCode: '1000', houseBankKey: 'HB01', accountId: 'MAIN', statementId,
    }, { authorization: a.actor.authorization })).rejects.toThrow(/session|authority/);

    await expect(getBankReconciliation({
      client: a.client, companyCode: '9999', houseBankKey: 'HB01', accountId: 'MAIN',
    }, { authorization: a.actor.authorization })).rejects.toThrow(/scope|does not exist|not active/);

    const displayOnly = await createFinanceActor(a.client, {
      capabilities: [BANK_STATEMENT_DISPLAY_CAPABILITY],
    });
    await expect(saveBankStatement(bankStatement(a, {
      statementReference: 'A-NO-ENTER', fromDate: '2026-05-01', toDate: '2026-05-31',
      openingBalance: '0.00', closingBalance: '1.00', lines: [line('IN', '1.00', '2026-05-02')],
    }), { authorization: displayOnly.authorization })).rejects.toThrow(/authority|capability/);

    const after = await withTenant(b.client, async (tx) => {
      const rows = await tx.execute(sql`
        select count(*)::int as n from bank_statement where client = ${b.client}
      `) as unknown as Array<{ n: number }>;
      return rows[0]!.n;
    });
    expect(after).toBe(before);
  });

  it('refuses a shared bank G/L account instead of guessing ownership', async () => {
    const shared = await setup('bank-recon-shared', {
      accounts: [
        { house: 'HB01', account: 'MAIN', gl: '101000' },
        { house: 'HB02', account: 'SEC', gl: '101000' },
      ],
    });
    await expect(getBankReconciliation({
      client: shared.client, companyCode: '1000', houseBankKey: 'HB01', accountId: 'MAIN',
    }, { authorization: shared.actor.authorization })).rejects.toThrow(/shared by 2 bank accounts/);
    await expect(saveBankStatement(bankStatement(shared, {
      statementReference: 'SHARED-1', fromDate: '2026-05-01', toDate: '2026-05-31',
      openingBalance: '0.00', closingBalance: '1.00', lines: [line('IN', '1.00', '2026-05-02')],
    }), { authorization: shared.actor.authorization })).rejects.toThrow(/shared by 2 bank accounts/);
  });

  it('lists only the accounts inside the live Company Code scope', async () => {
    const accounts = await listReconcilableBankAccounts({
      client: a.client, authorization: a.actor.authorization,
    });
    expect(accounts.every((account) => account.companyCode === '1000')).toBe(true);
  });

  it('enforces scope again on export', async () => {
    await expect(bankReconciliationCsv({
      client: b.client, companyCode: '1000', houseBankKey: 'HB01', accountId: 'MAIN', statementId,
    }, { authorization: a.actor.authorization })).rejects.toBeInstanceOf(BankReconciliationError);
  });
});
