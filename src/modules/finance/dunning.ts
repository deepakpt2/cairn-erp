/**
 * Dunning programme — SCR-074 / R-122.
 *
 * A run proposes the customers whose items stand overdue as of
 * the dunning date, each item at the level its completed history
 * earns; an account without a dunning procedure stands excluded
 * with its reason. Finalization revalidates every item and
 * writes one notice per account per currency — a record, never
 * a posting. Levels advance only at finalization.
 *
 * A proposal states what stood overdue when it was made; the notice demands what stands owed now.
 * Finalization therefore recomputes each item's net collectible inside its own transaction, under
 * the company settlement lock every payment and clearing path takes, and refuses a proposal whose
 * amount no longer stands. It never writes the figure the proposal happens to carry.
 *
 * Every amount is stated in the item's **document currency**, because that is what the customer
 * owes and what the notice asks for; the local carrying amount is never presented under a foreign
 * label. An account holding items in more than one currency is proposed once per currency rather
 * than excluded or summed, since one notice speaks one currency.
 */
import { and, eq, sql } from 'drizzle-orm';

import { hasOrgAccess } from '../../platform/auth/session';
import { type ServiceAuthorityContext, verifyServiceAuthorityInTx } from '../../platform/auth/service-authority';
import { recordChange } from '../../platform/change';
import { type Tx, withTenant } from '../../platform/db/client';
import { getCompanyCode } from '../../platform/periods';
import { fromScaled, toScaled } from '../../platform/posting/decimal';
import { customerCompany } from '../foundation/customer-company-schema';
import { customerInvoice } from '../purchasing/schema';
import {
  dunningNotice, dunningRun, dunningRunAccount, dunningRunCompany, dunningRunItem,
  journalEntry, journalEntryLine,
} from './schema';
import { lockValuationSettlement } from './fx-settlement';
import {
  notValidApplicationLineSql, openItemBalances, unappliedPaymentCreditSql, validApplicationSql,
} from './open-item-netting';

export const DUNNING_CAPABILITY = 'FIN.AR.DUNNING.RUN';
const DUNNING_CLASS = 'dunning_run';

export class DunningError extends Error {
  remedy?: string;

  constructor(message: string, remedy?: string) {
    super(message);
    this.name = 'DunningError';
    this.remedy = remedy;
  }
}

const round4 = (n: number) => Math.round(n * 10000) / 10000;
const dayMs = 24 * 60 * 60 * 1000;
const daysBetween = (from: string, to: string) =>
  Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / dayMs);
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function judgeDate(label: string, value: string) {
  if (!DATE_RE.test(value)) throw new DunningError(`${label} ${value} is not a calendar date.`);
}

export interface DunningRunView {
  runDate: string;
  runId: string;
  dunningDate: string;
  postedThroughDate: string;
  status: string;
  customerFrom: string | null;
  customerTo: string | null;
  companies: string[];
  accounts: Array<{
    companyCode: string; customer: string; proposedLevel: number | null;
    currency: string; totalOverdue: string; status: string; exceptionReason: string | null;
  }>;
  items: Array<{
    companyCode: string; customer: string; documentNumber: string; fiscalYear: number; lineNumber: number;
    dueDate: string; daysOverdue: number; overdueAmount: string; currency: string;
    proposedLevel: number; status: string;
  }>;
  notices: Array<{
    noticeNumber: string; companyCode: string; customer: string;
    dunningLevel: number; currency: string; amount: string; noticeDate: string;
  }>;
}

async function loadRunView(tx: Tx, client: string, runDate: string, runId: string): Promise<DunningRunView | null> {
  const [run] = await tx.select().from(dunningRun).where(and(
    eq(dunningRun.client, client), eq(dunningRun.runDate, runDate), eq(dunningRun.runId, runId),
  ));
  if (!run) return null;
  const companies = await tx.select().from(dunningRunCompany).where(and(
    eq(dunningRunCompany.client, client), eq(dunningRunCompany.runDate, runDate), eq(dunningRunCompany.runId, runId),
  ));
  const accounts = await tx.select().from(dunningRunAccount).where(and(
    eq(dunningRunAccount.client, client), eq(dunningRunAccount.runDate, runDate), eq(dunningRunAccount.runId, runId),
  ));
  const items = await tx.select().from(dunningRunItem).where(and(
    eq(dunningRunItem.client, client), eq(dunningRunItem.runDate, runDate), eq(dunningRunItem.runId, runId),
  ));
  const notices = await tx.select().from(dunningNotice).where(and(
    eq(dunningNotice.client, client), eq(dunningNotice.runDate, runDate), eq(dunningNotice.runId, runId),
  ));
  return {
    runDate: run.runDate, runId: run.runId, dunningDate: run.dunningDate,
    postedThroughDate: run.postedThroughDate, status: run.status,
    customerFrom: run.customerFrom, customerTo: run.customerTo,
    companies: companies.map((c) => c.companyCode),
    accounts: accounts.map((a) => ({
      companyCode: a.companyCode, customer: a.customer, proposedLevel: a.proposedLevel,
      currency: a.currency, totalOverdue: a.totalOverdue, status: a.status,
      exceptionReason: a.exceptionReason,
    })),
    items: items.map((i) => ({
      companyCode: i.companyCode, customer: i.customer, documentNumber: i.documentNumber,
      fiscalYear: i.fiscalYear, lineNumber: i.lineNumber, dueDate: i.dueDate,
      daysOverdue: i.daysOverdue, overdueAmount: i.overdueAmount, currency: i.currency,
      proposedLevel: i.proposedLevel, status: i.status,
    })),
    notices: notices.map((n) => ({
      noticeNumber: n.noticeNumber, companyCode: n.companyCode, customer: n.customer,
      dunningLevel: n.dunningLevel, currency: n.currency, amount: n.amount, noticeDate: n.noticeDate,
    })),
  };
}

export async function getDunningRun(client: string, runDate: string, runId: string): Promise<DunningRunView | null> {
  return withTenant(client, (tx) => loadRunView(tx, client, runDate, runId));
}

export async function listDunningRuns(client: string): Promise<DunningRunView[]> {
  return withTenant(client, async (tx) => {
    const runs = await tx.select().from(dunningRun).where(eq(dunningRun.client, client))
      .orderBy(dunningRun.runDate, dunningRun.runId);
    const views: DunningRunView[] = [];
    for (const run of runs) {
      const view = await loadRunView(tx, client, run.runDate, run.runId);
      if (view) views.push(view);
    }
    return views;
  });
}

interface OverdueItem {
  companyCode: string; customer: string; documentNumber: string; fiscalYear: number; lineNumber: number;
  dueDate: string; daysOverdue: number; amount: string; currency: string;
}

async function selectOverdueItems(
  tx: Tx, client: string, input: {
    companies: string[]; dunningDate: string; postedThrough: string;
    customerFrom?: string; customerTo?: string;
  },
): Promise<OverdueItem[]> {
  const invoices = new Map<string, string | null>();
  for (const inv of await tx.select().from(customerInvoice).where(eq(customerInvoice.client, client))) {
    invoices.set(inv.invoiceNumber, inv.dueDate);
  }
  const items: OverdueItem[] = [];
  for (const companyCode of input.companies) {
    const rows = await tx.select({
      documentNumber: journalEntryLine.documentNumber,
      fiscalYear: journalEntryLine.fiscalYear,
      lineNumber: journalEntryLine.lineNumber,
      customer: journalEntryLine.businessPartner,
      debitCredit: journalEntryLine.debitCredit,
      amount: journalEntryLine.amountDocument,
      // The amount basis is **now**, not the posting cutoff. Finalization recomputes the same
      // figure through `openItemBalances`, which reads every posted application regardless of its
      // posting date; a proposal that stopped at the cutoff would charge an advance the notice
      // cannot honour, and would never match — re-proposing on the same cutoff would reproduce
      // the stale figure. These two calls pass no `asOf` for exactly that reason, so the two
      // paths read one expression. The cutoff still decides *which* items are in scope (below).
      valid: validApplicationSql('document'),
      paymentCredit: unappliedPaymentCreditSql('document'),
      currency: journalEntryLine.currency,
      postingDate: journalEntry.postingDate,
      originClass: journalEntry.originClass,
      originKey: journalEntry.originKey,
      clearingDate: journalEntryLine.clearingDate,
    }).from(journalEntryLine)
      .innerJoin(journalEntry, and(
        eq(journalEntry.client, journalEntryLine.client),
        eq(journalEntry.documentNumber, journalEntryLine.documentNumber),
        eq(journalEntry.fiscalYear, journalEntryLine.fiscalYear),
      ))
      .where(and(
        eq(journalEntryLine.client, client),
        eq(journalEntryLine.companyCode, companyCode),
        eq(journalEntry.status, 'POSTED'),
        // A reversal mirror is the undoing of the original, never an obligation of its own.
        sql`${journalEntry.reversalOf} is null`,
        sql`${journalEntryLine.businessPartner} is not null`,
        // The source line is netted below; an application line must not be dunned beside it.
        notValidApplicationLineSql(input.postedThrough, { keepResetOffsets: false }),
      ));
    for (const r of rows) {
      const customer = r.customer!;
      if (input.customerFrom && customer < input.customerFrom) continue;
      if (input.customerTo && customer > input.customerTo) continue;
      if (r.debitCredit !== 'S') continue;
      if (r.postingDate > input.postedThrough) continue;
      if (r.clearingDate && r.clearingDate <= input.dunningDate) continue;
      // The collectible amount is the open liability after valid applications, less
      // unapplied payment credits. An unapplied advance is not netted.
      const liabilityUnits = toScaled(r.amount) - toScaled(String(r.valid ?? '0'));
      if (liabilityUnits < 0n) {
        throw new DunningError(
          `Journal line ${r.documentNumber}/${r.fiscalYear}/${r.lineNumber} stands at ${fromScaled(liabilityUnits)} ${r.currency} after valid applications; they exceed the item.`,
          'Investigate the applications on this item before dunning it.',
        );
      }
      const collectibleUnits = liabilityUnits - toScaled(String(r.paymentCredit ?? '0'));
      if (collectibleUnits <= 0n) continue;
      const amount = fromScaled(collectibleUnits);
      const dueDate = r.originClass === 'customer_invoice' && r.originKey
        ? (invoices.get(r.originKey) ?? r.postingDate)
        : r.postingDate;
      const overdue = daysBetween(dueDate, input.dunningDate);
      if (overdue <= 0) continue;
      items.push({
        companyCode, customer, documentNumber: r.documentNumber, fiscalYear: r.fiscalYear,
        lineNumber: r.lineNumber, dueDate, daysOverdue: overdue,
        amount, currency: r.currency,
      });
    }
  }
  items.sort((a, b) => a.companyCode.localeCompare(b.companyCode) || a.customer.localeCompare(b.customer)
    || a.dueDate.localeCompare(b.dueDate) || a.documentNumber.localeCompare(b.documentNumber));
  return items;
}

/** The last completed level an item earned, from completed runs' item rows. */
async function lastCompletedLevel(
  tx: Tx, client: string, item: { documentNumber: string; fiscalYear: number; lineNumber: number },
): Promise<number> {
  const rows = await tx.select({ level: dunningRunItem.proposedLevel })
    .from(dunningRunItem)
    .innerJoin(dunningRun, and(
      eq(dunningRun.client, dunningRunItem.client),
      eq(dunningRun.runDate, dunningRunItem.runDate),
      eq(dunningRun.runId, dunningRunItem.runId),
    ))
    .where(and(
      eq(dunningRunItem.client, client),
      eq(dunningRunItem.documentNumber, item.documentNumber),
      eq(dunningRunItem.fiscalYear, item.fiscalYear),
      eq(dunningRunItem.lineNumber, item.lineNumber),
      eq(dunningRun.status, 'COMPLETED'),
      eq(dunningRunItem.status, 'COMPLETED'),
    ));
  return rows.reduce((max, r) => Math.max(max, r.level), 0);
}

export async function proposeDunningRun(input: {
  client: string; changedBy: string;
  runDate: string; runId: string; dunningDate: string; postedThrough: string;
  companyCodes: string[]; customerFrom?: string; customerTo?: string;
}, options: { authorization?: ServiceAuthorityContext } = {}): Promise<DunningRunView> {
  judgeDate('Run date', input.runDate);
  judgeDate('Dunning date', input.dunningDate);
  judgeDate('Documents posted up to', input.postedThrough);
  if (!input.runId || input.runId.length > 6) {
    throw new DunningError('The identification stands at one to six characters.', 'Give the run a short identification.');
  }
  if (input.postedThrough > input.dunningDate) {
    throw new DunningError(
      `Documents posted up to ${input.postedThrough} stands after the dunning date ${input.dunningDate}.`,
      'The posting cutoff cannot stand after the dunning date.',
    );
  }
  if (input.companyCodes.length === 0) {
    throw new DunningError('Name at least one company code.', 'Restrict the run to the companies it may process.');
  }
  return withTenant(input.client, async (tx) => {
    // A dunning run reads what the company's customers owe and, when it is
    // finalized, writes a notice against every one of them. That is a company's
    // business, so the run is proposed by somebody: a session that stands, the
    // authority to dun, and a Company Code reach covering every company the run
    // will look at.
    const authority = await verifyServiceAuthorityInTx(
      tx, input.client, options.authorization, DUNNING_CAPABILITY, { requirePlantScope: false },
    );
    if (!authority.ok) throw new DunningError(authority.refusal.message, authority.refusal.remedy);
    for (const companyCode of input.companyCodes) {
      if (!hasOrgAccess(authority.restrictions, 'COMPANY_CODE', companyCode)) {
        throw new DunningError(
          `Your Company Code scope does not cover company code ${companyCode}.`,
          'Ask an administrator to extend your Company Code scope, then repeat the action.',
        );
      }
    }

    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`${input.client}/dunning`}, 0))`);
    const [existing] = await tx.select().from(dunningRun).where(and(
      eq(dunningRun.client, input.client), eq(dunningRun.runDate, input.runDate), eq(dunningRun.runId, input.runId),
    ));
    if (existing) {
      throw new DunningError(
        `Run ${input.runId} of ${input.runDate} already stands with status ${existing.status}.`,
        'A rerun stands as a new run identity; completed runs are never overwritten.',
      );
    }
    for (const companyCode of input.companyCodes) {
      const company = await getCompanyCode(tx, input.client, companyCode);
      if (!company) throw new DunningError(`Company code ${companyCode} does not stand configured.`);
    }

    await tx.insert(dunningRun).values({
      client: input.client, runDate: input.runDate, runId: input.runId,
      dunningDate: input.dunningDate, postedThroughDate: input.postedThrough,
      accountType: 'CUSTOMER', status: 'PARAMETERS',
      customerFrom: input.customerFrom ?? null, customerTo: input.customerTo ?? null,
      createdBy: input.changedBy,
    });
    for (const companyCode of input.companyCodes) {
      await tx.insert(dunningRunCompany).values({
        client: input.client, runDate: input.runDate, runId: input.runId,
        companyCode, createdBy: input.changedBy,
      });
    }

    const overdue = await selectOverdueItems(tx, input.client, {
      companies: input.companyCodes, dunningDate: input.dunningDate,
      postedThrough: input.postedThrough,
      customerFrom: input.customerFrom, customerTo: input.customerTo,
    });

    // Group by customer first, so the dunning procedure is judged once, then split by currency
    // within it: a notice states one currency, so an account with items in more than one currency
    // is proposed once per currency rather than excluded wholesale.
    const byCustomer = new Map<string, OverdueItem[]>();
    for (const item of overdue) {
      const key = `${item.companyCode}|${item.customer}`;
      byCustomer.set(key, [...(byCustomer.get(key) ?? []), item]);
    }

    let accountRows = 0;
    for (const [key, customerItems] of byCustomer) {
      const [companyCode, customer] = key.split('|');
      const [extension] = await tx.select().from(customerCompany).where(and(
        eq(customerCompany.client, input.client),
        eq(customerCompany.partnerNumber, customer),
        eq(customerCompany.companyCode, companyCode),
      ));
      const currencies = [...new Set(customerItems.map((i) => i.currency))].sort();
      if (!extension || !extension.dunningProcedure) {
        // The account is excluded for a reason that does not depend on currency; one row per
        // currency keeps every row's currency the currency of the items it stands for.
        for (const currency of currencies) {
          accountRows += 1;
          await tx.insert(dunningRunAccount).values({
            client: input.client, runDate: input.runDate, runId: input.runId,
            companyCode, customer, currency, proposedLevel: null,
            totalOverdue: '0', status: 'EXCLUDED',
            exceptionReason: !extension
              ? `Customer ${customer} does not stand extended to company ${companyCode}.`
              : `Customer ${customer} carries no dunning procedure in company ${companyCode}.`,
            createdBy: input.changedBy,
          });
        }
        continue;
      }
      for (const currency of currencies) {
        const accountItems = customerItems.filter((i) => i.currency === currency);
        let accountLevel = 1;
        let total = 0;
        const levelled: Array<{ item: OverdueItem; level: number }> = [];
        for (const item of accountItems) {
          const level = (await lastCompletedLevel(tx, input.client, item)) + 1;
          accountLevel = Math.max(accountLevel, level);
          total = round4(total + Number(item.amount));
          levelled.push({ item, level });
        }
        accountRows += 1;
        await tx.insert(dunningRunAccount).values({
          client: input.client, runDate: input.runDate, runId: input.runId,
          companyCode, customer, proposedLevel: accountLevel,
          currency, totalOverdue: String(total),
          status: 'PROPOSED', exceptionReason: null, createdBy: input.changedBy,
        });
        for (const { item, level } of levelled) {
          await tx.insert(dunningRunItem).values({
            client: input.client, runDate: input.runDate, runId: input.runId,
            companyCode, customer, documentNumber: item.documentNumber,
            fiscalYear: item.fiscalYear, lineNumber: item.lineNumber,
            dueDate: item.dueDate, daysOverdue: item.daysOverdue,
            overdueAmount: item.amount, currency: item.currency,
            proposedLevel: level, status: 'PROPOSED', createdBy: input.changedBy,
          });
        }
      }
    }

    await tx.update(dunningRun).set({ status: 'PROPOSED', changedBy: input.changedBy }).where(and(
      eq(dunningRun.client, input.client), eq(dunningRun.runDate, input.runDate), eq(dunningRun.runId, input.runId),
    ));
    await recordChange(tx, {
      client: input.client, objectClass: DUNNING_CLASS,
      objectKey: `${input.runDate}/${input.runId}`,
      changeType: 'CREATE', changedBy: input.changedBy, transactionCode: DUNNING_CAPABILITY,
      after: {
        dunningDate: input.dunningDate, postedThrough: input.postedThrough,
        companies: input.companyCodes.join(','), accounts: accountRows,
      },
    });

    const view = await loadRunView(tx, input.client, input.runDate, input.runId);
    return view!;
  });
}

export async function excludeDunningAccount(input: {
  client: string; changedBy: string;
  runDate: string; runId: string; companyCode: string; customer: string;
}): Promise<DunningRunView> {
  return withTenant(input.client, async (tx) => {
    const [run] = await tx.select().from(dunningRun).where(and(
      eq(dunningRun.client, input.client), eq(dunningRun.runDate, input.runDate), eq(dunningRun.runId, input.runId),
    ));
    if (!run) throw new DunningError(`Run ${input.runId} of ${input.runDate} does not stand.`);
    if (run.status !== 'PROPOSED') {
      throw new DunningError(`Run ${input.runId} of ${input.runDate} stands ${run.status}; its proposal can no longer change.`);
    }
    // An account may stand proposed once per currency; excluding it excludes every one of them.
    const accounts = await tx.select().from(dunningRunAccount).where(and(
      eq(dunningRunAccount.client, input.client), eq(dunningRunAccount.runDate, input.runDate),
      eq(dunningRunAccount.runId, input.runId), eq(dunningRunAccount.companyCode, input.companyCode),
      eq(dunningRunAccount.customer, input.customer),
    ));
    if (!accounts.some((a) => a.status === 'PROPOSED')) {
      throw new DunningError(`Account ${input.customer} in company ${input.companyCode} does not stand proposed on this run.`);
    }
    await tx.update(dunningRunAccount).set({
      status: 'EXCLUDED', changedBy: input.changedBy,
      exceptionReason: `Excluded by ${input.changedBy} before finalization.`,
    }).where(and(
      eq(dunningRunAccount.client, input.client), eq(dunningRunAccount.runDate, input.runDate),
      eq(dunningRunAccount.runId, input.runId), eq(dunningRunAccount.companyCode, input.companyCode),
      eq(dunningRunAccount.customer, input.customer),
    ));
    await tx.update(dunningRunItem).set({ status: 'EXCLUDED', changedBy: input.changedBy }).where(and(
      eq(dunningRunItem.client, input.client), eq(dunningRunItem.runDate, input.runDate),
      eq(dunningRunItem.runId, input.runId), eq(dunningRunItem.companyCode, input.companyCode),
      eq(dunningRunItem.customer, input.customer),
    ));
    await recordChange(tx, {
      client: input.client, objectClass: DUNNING_CLASS,
      objectKey: `${input.runDate}/${input.runId}`,
      changeType: 'CHANGE', changedBy: input.changedBy, transactionCode: DUNNING_CAPABILITY,
      after: { excludedAccount: `${input.companyCode}/${input.customer}` },
    });
    const view = await loadRunView(tx, input.client, input.runDate, input.runId);
    return view!;
  });
}

export async function finalizeDunningRun(input: {
  client: string; changedBy: string;
  runDate: string; runId: string; confirmed: boolean;
}, options: { authorization?: ServiceAuthorityContext } = {}): Promise<DunningRunView> {
  if (!input.confirmed) {
    throw new DunningError('The dunning run stands unconfirmed.', 'Tick the confirmation, then finalize the run.');
  }
  return withTenant(input.client, async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`${input.client}/dunning`}, 0))`);
    const [run] = await tx.select().from(dunningRun).where(and(
      eq(dunningRun.client, input.client), eq(dunningRun.runDate, input.runDate), eq(dunningRun.runId, input.runId),
    ));
    if (!run) throw new DunningError(`Run ${input.runId} of ${input.runDate} does not stand.`);
    if (run.status === 'COMPLETED') {
      // Duplicate-safe: the standing notices are the result; nothing is written twice.
      const view = await loadRunView(tx, input.client, input.runDate, input.runId);
      return view!;
    }
    if (run.status !== 'PROPOSED') {
      throw new DunningError(`Run ${input.runId} of ${input.runDate} stands ${run.status}; only a proposed run finalizes.`);
    }

    // Finalizing writes the notice, and levels advance only here. The run carries
    // the company codes it was proposed for, and the actor's reach has to cover
    // every one of them - not merely the company the first account happens to be in.
    const authority = await verifyServiceAuthorityInTx(
      tx, input.client, options.authorization, DUNNING_CAPABILITY, { requirePlantScope: false },
    );
    if (!authority.ok) throw new DunningError(authority.refusal.message, authority.refusal.remedy);
    const runCompanies = await tx.select().from(dunningRunCompany).where(and(
      eq(dunningRunCompany.client, input.client),
      eq(dunningRunCompany.runDate, input.runDate),
      eq(dunningRunCompany.runId, input.runId),
    ));
    for (const row of runCompanies) {
      if (!hasOrgAccess(authority.restrictions, 'COMPANY_CODE', row.companyCode)) {
        throw new DunningError(
          `Your Company Code scope does not cover company code ${row.companyCode}.`,
          'Ask an administrator to extend your Company Code scope, then repeat the action.',
        );
      }
    }

    // The notice demands what the customer owes now, so serialize with every settlement path that
    // could still move an item after the proposal was made. Companies are taken in a stable order,
    // as the payment run does, so two finalizations covering the same companies cannot deadlock.
    for (const companyCode of [...new Set(runCompanies.map((row) => row.companyCode))].sort()) {
      await lockValuationSettlement(tx, input.client, companyCode);
    }

    const view = await loadRunView(tx, input.client, input.runDate, input.runId);
    const proposedItems = view!.items.filter((i) => i.status === 'PROPOSED');
    // Recompute every proposed item's net collectible from its standing journal line, inside this
    // transaction. An advance or payment applied after the proposal leaves the original line open,
    // so the line still existing proves nothing about the amount: the recomputed figure is what the
    // notice may state, and a proposal that no longer matches it is refused.
    //
    // The recompute reads the item's state *now*, through the same helper the proposal reads, which
    // is why an unchanged ledger always agrees (the proposal's own cutoff governs which items are
    // in scope and how far they are overdue, not how much is owed).
    //
    // The whole run is judged before anything is written: an all-or-nothing finalization means a run
    // either issues every notice or none, never a half-issued set. So every stale item is collected
    // and reported together, rather than the first one hiding the rest.
    const collectibleByAccount = new Map<string, bigint>();
    const stale: string[] = [];
    const integrity: string[] = [];
    const itemLabel = (item: { documentNumber: string; lineNumber: number }) =>
      `Document ${item.documentNumber} line ${item.lineNumber}`;
    for (const item of proposedItems) {
      const [line] = await tx.select().from(journalEntryLine).where(and(
        eq(journalEntryLine.client, input.client),
        eq(journalEntryLine.documentNumber, item.documentNumber),
        eq(journalEntryLine.fiscalYear, item.fiscalYear),
        eq(journalEntryLine.lineNumber, item.lineNumber),
      ));
      if (!line || line.clearingDocument) {
        stale.push(`${itemLabel(item)} no longer stands open; the proposal is stale.`);
        continue;
      }
      const [journal] = await tx.select().from(journalEntry).where(and(
        eq(journalEntry.client, input.client),
        eq(journalEntry.documentNumber, item.documentNumber),
        eq(journalEntry.fiscalYear, item.fiscalYear),
      ));
      if (!journal || journal.status !== 'POSTED') {
        stale.push(`${itemLabel(item)} does not stand posted; the proposal is stale.`);
        continue;
      }
      const balances = await openItemBalances(tx, input.client, {
        documentNumber: item.documentNumber, companyCode: line.companyCode,
        businessPartner: line.businessPartner!, glAccount: line.glAccount,
        currency: line.currency, debitCredit: line.debitCredit,
      });
      const liability = toScaled(line.amountDocument) - balances.liability.document;
      if (liability < 0n) {
        // Not a dunning judgement: applications summing beyond the line itself mean the ledger no
        // longer proves the position. Every settlement path refuses this at posting time
        // (`incoming-payment.ts:390`, `gl-clearing.ts:498`), so reaching it here means an
        // application was written by something other than a settlement — an integrity fault to
        // investigate, not a reason to cancel and re-propose.
        integrity.push(
          `${itemLabel(item)} carries applications of ${fromScaled(-liability)} ${item.currency} beyond its amount.`,
        );
        continue;
      }
      const net = liability - balances.paymentCredit.document;
      if (net <= 0n) {
        stale.push(
          `${itemLabel(item)} stands fully covered by applications and unapplied payment credits since the proposal was made; the proposal is stale.`,
        );
        continue;
      }
      if (net !== toScaled(item.overdueAmount)) {
        stale.push(
          `${itemLabel(item)} stands open at ${fromScaled(net)} ${item.currency} since the proposal was made, not the ${item.overdueAmount} ${item.currency} it states; the proposal is stale.`,
        );
        continue;
      }
      const key = `${item.companyCode}|${item.customer}|${item.currency}`;
      collectibleByAccount.set(key, (collectibleByAccount.get(key) ?? 0n) + net);
    }

    if (integrity.length > 0) {
      throw new DunningError(
        `Run ${input.runId} of ${input.runDate} cannot finalize: a data-integrity fault means the ledger no longer proves the collectible position. ${integrity.join(' ')}`,
        'This is not a stale proposal: applications exceeding the line they settle are written only by something other than a settlement, since every settlement path refuses them at posting time. Investigate the applications on these items. Nothing has been written.',
      );
    }
    if (stale.length > 0) {
      throw new DunningError(
        `Run ${input.runId} of ${input.runDate} cannot finalize: ${stale.length} proposed item(s) stand stale. ${stale.join(' ')}`,
        'Cancel this run and propose a new run identity. Nothing has been written.',
      );
    }

    for (const account of view!.accounts.filter((a) => a.status === 'PROPOSED')) {
      // The notice states the sum of what its items stand at now, not the total the proposal carries.
      const amount = collectibleByAccount.get(`${account.companyCode}|${account.customer}|${account.currency}`);
      if (amount === undefined) {
        throw new DunningError(
          `Account ${account.customer} in company ${account.companyCode} no longer stands owed in ${account.currency}; the proposal is stale.`,
          'Cancel this run and propose a new run identity.',
        );
      }
      await tx.insert(dunningNotice).values({
        client: input.client,
        noticeNumber: `${input.runId}-${input.runDate}-${account.companyCode}-${account.customer}-${account.currency}`,
        runDate: input.runDate, runId: input.runId,
        companyCode: account.companyCode, customer: account.customer,
        dunningLevel: account.proposedLevel!, currency: account.currency,
        amount: fromScaled(amount), noticeDate: run.dunningDate,
        createdBy: input.changedBy,
      });
      // The account row carries the same figure the notice does, so the proposal the operator
      // reviews and the notice that was written never disagree after a finalized run.
      await tx.update(dunningRunAccount).set({
        status: 'COMPLETED', totalOverdue: fromScaled(amount), changedBy: input.changedBy,
      }).where(and(
        eq(dunningRunAccount.client, input.client), eq(dunningRunAccount.runDate, input.runDate),
        eq(dunningRunAccount.runId, input.runId), eq(dunningRunAccount.companyCode, account.companyCode),
        eq(dunningRunAccount.customer, account.customer), eq(dunningRunAccount.currency, account.currency),
      ));
    }
    await tx.update(dunningRunItem).set({ status: 'COMPLETED', changedBy: input.changedBy }).where(and(
      eq(dunningRunItem.client, input.client), eq(dunningRunItem.runDate, input.runDate),
      eq(dunningRunItem.runId, input.runId), eq(dunningRunItem.status, 'PROPOSED'),
    ));
    await tx.update(dunningRun).set({ status: 'COMPLETED', changedBy: input.changedBy }).where(and(
      eq(dunningRun.client, input.client), eq(dunningRun.runDate, input.runDate), eq(dunningRun.runId, input.runId),
    ));
    await recordChange(tx, {
      client: input.client, objectClass: DUNNING_CLASS,
      objectKey: `${input.runDate}/${input.runId}`,
      changeType: 'CHANGE', changedBy: input.changedBy, transactionCode: DUNNING_CAPABILITY,
      after: { finalized: 'COMPLETED', notices: view!.accounts.filter((a) => a.status === 'PROPOSED').length },
    });

    const done = await loadRunView(tx, input.client, input.runDate, input.runId);
    return done!;
  });
}

export async function cancelDunningRun(input: {
  client: string; changedBy: string; runDate: string; runId: string;
}): Promise<DunningRunView> {
  return withTenant(input.client, async (tx) => {
    const [run] = await tx.select().from(dunningRun).where(and(
      eq(dunningRun.client, input.client), eq(dunningRun.runDate, input.runDate), eq(dunningRun.runId, input.runId),
    ));
    if (!run) throw new DunningError(`Run ${input.runId} of ${input.runDate} does not stand.`);
    if (run.status === 'COMPLETED') {
      throw new DunningError(`Run ${input.runId} of ${input.runDate} stands completed; completed runs are history and cannot be cancelled.`);
    }
    await tx.update(dunningRun).set({ status: 'CANCELLED', changedBy: input.changedBy }).where(and(
      eq(dunningRun.client, input.client), eq(dunningRun.runDate, input.runDate), eq(dunningRun.runId, input.runId),
    ));
    await recordChange(tx, {
      client: input.client, objectClass: DUNNING_CLASS,
      objectKey: `${input.runDate}/${input.runId}`,
      changeType: 'CHANGE', changedBy: input.changedBy, transactionCode: DUNNING_CAPABILITY,
      after: { cancelled: 'CANCELLED' },
    });
    const view = await loadRunView(tx, input.client, input.runDate, input.runId);
    return view!;
  });
}
