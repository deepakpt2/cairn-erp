/**
 * Retained earnings account definition (SCR-121 / R-168;
 * OB53 as a search alias only).
 *
 * Per chart of accounts, each one-character retained earnings
 * indicator names the retained earnings account its P&L
 * accounts close to at balance carryforward. The rows live in
 * the standing account determination table on the
 * RETAINED_EARNINGS event with the indicator in the
 * general-modifier slot (valuation class always blank), so
 * the OBYC catalogue and this screen maintain one source.
 * Maintenance takes a mandatory reason and writes one change
 * document; deletion refuses while a P&L account of the chart
 * carries the indicator.
 */
export * from './retained-earnings-vocabulary';
import {
  RETAINED_EARNINGS_ACTIVITY, RETAINED_EARNINGS_EVENT,
  type RetainedEarningsRow,
} from './retained-earnings-vocabulary';

import { and, eq } from 'drizzle-orm';

import { recordChange } from '../../platform/change';
import { withTenant, type Tx } from '../../platform/db/client';
import { glAccount } from '../finance/schema';
import { accountDetermination, chartOfAccounts } from './schema';

const OBJECT_CLASS = 'retained_earnings_account';

export class RetainedEarningsError extends Error {
  remedy?: string;

  constructor(message: string, remedy?: string) {
    super(message);
    this.name = 'RetainedEarningsError';
    this.remedy = remedy;
  }
}

function fail(message: string, remedy?: string): never {
  throw new RetainedEarningsError(message, remedy);
}

function judgeReason(reason: string | undefined): string {
  const trimmed = (reason ?? '').trim();
  if (!trimmed) fail('A reason is required for every change.', 'State why the configuration changes.');
  return trimmed;
}

function judgeIndicator(indicator: string): string {
  const value = indicator.trim().toUpperCase();
  if (!/^[A-Z0-9]$/.test(value)) {
    fail('The retained earnings indicator is exactly one character (A–Z or 0–9).', 'Use one character; X is the standing convention.');
  }
  return value;
}

async function judgeChart(tx: Tx, client: string, chart: string) {
  const [row] = await tx.select().from(chartOfAccounts).where(and(
    eq(chartOfAccounts.client, client), eq(chartOfAccounts.chartOfAccounts, chart),
  ));
  if (!row) fail(`Chart of accounts ${chart} does not stand.`, 'Define the chart of accounts first.');
}

async function judgeAccount(tx: Tx, client: string, chart: string, account: string) {
  const [row] = await tx.select().from(glAccount).where(and(
    eq(glAccount.client, client), eq(glAccount.chartOfAccounts, chart),
    eq(glAccount.accountNumber, account),
  ));
  if (!row) {
    fail(`G/L account ${account} does not stand in chart ${chart}.`, 'Create the retained earnings account in the chart first.');
  }
  if (row!.accountType !== 'EQUITY' || row!.glAccountType !== 'BALANCE_SHEET') {
    fail(`G/L account ${account} is a ${row!.accountType} ${row!.glAccountType} account; a retained earnings account is an EQUITY balance-sheet account.`,
      'Choose an equity balance-sheet account of the same chart.');
  }
  return row!;
}

export async function listRetainedEarnings(client: string): Promise<RetainedEarningsRow[]> {
  return withTenant(client, async (tx) => {
    const rows = await tx.select().from(accountDetermination).where(and(
      eq(accountDetermination.client, client),
      eq(accountDetermination.event, RETAINED_EARNINGS_EVENT),
      eq(accountDetermination.valuationClass, ''),
    )).orderBy(accountDetermination.chartOfAccounts, accountDetermination.generalModifier);
    const accounts = await tx.select().from(glAccount).where(eq(glAccount.client, client));
    const nameOf = new Map(accounts.map((a) => [`${a.chartOfAccounts}|${a.accountNumber}`, a.name]));
    const countOf = new Map<string, number>();
    for (const account of accounts) {
      if (account.glAccountType === 'PL_STATEMENT' && account.retainedEarningsIndicator) {
        const key = `${account.chartOfAccounts}|${account.retainedEarningsIndicator}`;
        countOf.set(key, (countOf.get(key) ?? 0) + 1);
      }
    }
    return rows.map((row) => ({
      chartOfAccounts: row.chartOfAccounts,
      indicator: row.generalModifier,
      glAccount: row.glAccount,
      accountName: nameOf.get(`${row.chartOfAccounts}|${row.glAccount}`) ?? '',
      plAccounts: countOf.get(`${row.chartOfAccounts}|${row.generalModifier}`) ?? 0,
    }));
  });
}

export async function maintainRetainedEarnings(input: {
  client: string; changedBy: string;
  chartOfAccounts: string; indicator: string; glAccount: string;
  reason?: string;
}): Promise<RetainedEarningsRow> {
  const reason = judgeReason(input.reason);
  const chart = input.chartOfAccounts.trim().toUpperCase();
  const indicator = judgeIndicator(input.indicator);
  const account = input.glAccount.trim();
  return withTenant(input.client, async (tx) => {
    await judgeChart(tx, input.client, chart);
    const judged = await judgeAccount(tx, input.client, chart, account);
    const key = {
      client: input.client, chartOfAccounts: chart,
      event: RETAINED_EARNINGS_EVENT, valuationClass: '', generalModifier: indicator,
    };
    const [existing] = await tx.select().from(accountDetermination).where(and(
      eq(accountDetermination.client, key.client),
      eq(accountDetermination.chartOfAccounts, key.chartOfAccounts),
      eq(accountDetermination.event, key.event),
      eq(accountDetermination.valuationClass, key.valuationClass),
      eq(accountDetermination.generalModifier, key.generalModifier),
    ));
    if (existing) {
      await tx.update(accountDetermination).set({
        glAccount: account, changedBy: input.changedBy, changedAt: new Date(),
      }).where(and(
        eq(accountDetermination.client, key.client),
        eq(accountDetermination.chartOfAccounts, key.chartOfAccounts),
        eq(accountDetermination.event, key.event),
        eq(accountDetermination.valuationClass, key.valuationClass),
        eq(accountDetermination.generalModifier, key.generalModifier),
      ));
    } else {
      await tx.insert(accountDetermination).values({ ...key, glAccount: account, createdBy: input.changedBy });
    }
    await recordChange(tx, {
      client: input.client, objectClass: OBJECT_CLASS,
      objectKey: `${chart}/${indicator}`,
      changeType: existing ? 'CHANGE' : 'CREATE', reason,
      changedBy: input.changedBy, transactionCode: RETAINED_EARNINGS_ACTIVITY,
      after: { glAccount: account },
    });
    const carriers = await tx.select().from(glAccount).where(and(
      eq(glAccount.client, input.client), eq(glAccount.chartOfAccounts, chart),
      eq(glAccount.retainedEarningsIndicator, indicator),
    ));
    return {
      chartOfAccounts: chart, indicator, glAccount: account,
      accountName: judged.name, plAccounts: carriers.length,
    };
  });
}

export async function deleteRetainedEarnings(input: {
  client: string; changedBy: string;
  chartOfAccounts: string; indicator: string;
  reason?: string;
}): Promise<void> {
  const reason = judgeReason(input.reason);
  const chart = input.chartOfAccounts.trim().toUpperCase();
  const indicator = judgeIndicator(input.indicator);
  return withTenant(input.client, async (tx) => {
    const carriers = await tx.select().from(glAccount).where(and(
      eq(glAccount.client, input.client), eq(glAccount.chartOfAccounts, chart),
      eq(glAccount.retainedEarningsIndicator, indicator),
    ));
    if (carriers.length > 0) {
      fail(`Indicator ${indicator} of chart ${chart} stands on ${carriers.length} P&L account(s) (first: ${carriers[0]!.accountNumber}) and cannot be deleted.`,
        'Reassign the indicator on those accounts first, or leave the determination standing.');
    }
    const [existing] = await tx.select().from(accountDetermination).where(and(
      eq(accountDetermination.client, input.client),
      eq(accountDetermination.chartOfAccounts, chart),
      eq(accountDetermination.event, RETAINED_EARNINGS_EVENT),
      eq(accountDetermination.valuationClass, ''),
      eq(accountDetermination.generalModifier, indicator),
    ));
    if (!existing) {
      fail(`No retained earnings determination stands for indicator ${indicator} in chart ${chart}.`);
    }
    await tx.delete(accountDetermination).where(and(
      eq(accountDetermination.client, input.client),
      eq(accountDetermination.chartOfAccounts, chart),
      eq(accountDetermination.event, RETAINED_EARNINGS_EVENT),
      eq(accountDetermination.valuationClass, ''),
      eq(accountDetermination.generalModifier, indicator),
    ));
    await recordChange(tx, {
      client: input.client, objectClass: OBJECT_CLASS,
      objectKey: `${chart}/${indicator}`,
      changeType: 'DELETE', reason,
      changedBy: input.changedBy, transactionCode: RETAINED_EARNINGS_ACTIVITY,
    });
  });
}
