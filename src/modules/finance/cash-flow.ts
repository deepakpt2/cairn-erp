/**
 * Cash flow statement service (SCR-119 / FIN.RPT.CASHFLOW;
 * S_ALR_87012271/72/73 search aliases).
 *
 * Read-only statement over the posted journal in the SAP
 * three-section structure. Cash is defined by the house-bank
 * G/L accounts; every other account classifies from standing
 * configuration in precedence order — reconciliation type,
 * BSX account determination, asset-class determination,
 * account type — and anything unclassifiable stands totalled
 * and named. INDIRECT reads balance movements opening to
 * closing with the depreciation add-back; DIRECT reads the
 * offsetting lines of cash-touching documents. A
 * reconciliation check ties the three sections to the cash
 * movement and names any difference. The report posts
 * nothing and stores nothing.
 */
export * from './cash-flow-vocabulary';
import {
  CASHFLOW_LEDGER,
  type CashflowAccountClass, type CashflowLine, type CashflowResult,
  type CashflowSection, type CashflowSelection,
} from './cash-flow-vocabulary';

import { and, asc, eq, inArray, sql } from 'drizzle-orm';

import { withTenant, type Tx } from '../../platform/db/client';
import {
  accountDetermination, bankAccount,
  companyCode as foundationCompanyCode, fiscalYearPeriod, fiscalYearVariant,
} from '../foundation/schema';
import { assetClass, glAccount } from './schema';

export class CashflowError extends Error {
  remedy?: string;

  constructor(message: string, remedy?: string) {
    super(message);
    this.name = 'CashflowError';
    this.remedy = remedy;
  }
}

function fail(message: string, remedy?: string): never {
  throw new CashflowError(message, remedy);
}

/* Exact decimal helpers over amount_local (numeric 23,4). */
function toScaled(value: string | number): bigint {
  const text = String(value).trim();
  const negative = text.startsWith('-');
  const [whole, frac = ''] = text.replace(/^[+-]/, '').split('.');
  const scaled = BigInt(whole || '0') * 10000n + BigInt((frac + '0000').slice(0, 4));
  return negative ? -scaled : scaled;
}

function fromScaled(value: bigint): string {
  const negative = value < 0n;
  const abs = negative ? -value : value;
  const whole = abs / 10000n;
  const frac = String(abs % 10000n).padStart(4, '0').replace(/0+$/, '');
  return `${negative ? '-' : ''}${whole}${frac ? `.${frac}` : ''}`;
}

function sumScaled(values: string[]): string {
  return fromScaled(values.reduce((sum, value) => sum + toScaled(value), 0n));
}

function neg(value: string): string {
  return fromScaled(-toScaled(value));
}

interface CompanyContext {
  companyCode: string;
  currency: string;
  chart: string;
  classByAccount: Map<string, CashflowAccountClass>;
  accumDeprAccounts: Set<string>;
  cashAccounts: Set<string>;
}

interface CompanyDerivation {
  openingCash: string;
  closingCash: string;
  netCashChange: string;
  reconciliationDifference: string;
  /** Line amounts by line key, cash perspective: inflow +, outflow −. */
  lineAmounts: Map<string, string>;
  unclassified: Array<{ account: string; amount: string; lines: number }>;
  warnings: string[];
}

interface BalanceRow { account: string; opening: string; closing: string; movement: string; lines: number }
interface DocLineRow { documentNumber: string; account: string; debitCredit: string; amountLocal: string }

async function loadCompanyContext(
  tx: Tx, client: string, companyCode: string,
): Promise<CompanyContext> {
  const [company] = await tx.select().from(foundationCompanyCode).where(and(
    eq(foundationCompanyCode.client, client), eq(foundationCompanyCode.companyCode, companyCode),
  ));
  if (!company) fail(`Company code ${companyCode} does not stand.`, 'Choose a company code that stands.');
  if (!company.chartOfAccounts) {
    fail(`Company code ${companyCode} has no chart of accounts assigned.`, 'Assign a chart in the company code first.');
  }
  const chart = company.chartOfAccounts;

  /* Periods judged per the company's fiscal-year variant. */
  if (!company.fiscalYearVariant) {
    fail(`Company code ${companyCode} has no fiscal year variant assigned.`, 'Assign a fiscal year variant first.');
  }
  const [variant] = await tx.select().from(fiscalYearVariant).where(and(
    eq(fiscalYearVariant.client, client), eq(fiscalYearVariant.variant, company.fiscalYearVariant),
  ));
  if (!variant) fail(`Fiscal year variant ${company.fiscalYearVariant} of company ${companyCode} does not stand.`);

  const banks = await tx.select().from(bankAccount).where(and(
    eq(bankAccount.client, client), eq(bankAccount.companyCode, companyCode),
  ));
  const cashAccounts = new Set(banks.map((row) => row.glAccount));
  if (cashAccounts.size === 0) {
    fail(`Company code ${companyCode} has no house-bank G/L account, so cash cannot be defined for it.`,
      'Maintain a house bank account (FI12) for the company first.');
  }

  const accounts = await tx.select().from(glAccount).where(and(
    eq(glAccount.client, client), eq(glAccount.chartOfAccounts, chart),
  ));
  const determinations = await tx.select().from(accountDetermination).where(and(
    eq(accountDetermination.client, client), eq(accountDetermination.chartOfAccounts, chart),
    eq(accountDetermination.event, 'INVENTORY'),
  ));
  const inventoryAccounts = new Set(determinations.map((row) => row.glAccount));
  const assetClasses = await tx.select().from(assetClass).where(eq(assetClass.client, client));
  const fixedAccounts = new Set<string>();
  const accumDeprAccounts = new Set<string>();
  for (const row of assetClasses) {
    if (row.reconAccount) fixedAccounts.add(row.reconAccount);
    if (row.accumDeprAccount) { fixedAccounts.add(row.accumDeprAccount); accumDeprAccounts.add(row.accumDeprAccount); }
  }

  const classByAccount = new Map<string, CashflowAccountClass>();
  for (const account of accounts) {
    let klass: CashflowAccountClass;
    if (cashAccounts.has(account.accountNumber)) klass = 'CASH';
    else if (account.reconciliationType === 'CUSTOMERS') klass = 'RECEIVABLES';
    else if (account.reconciliationType === 'VENDORS') klass = 'PAYABLES';
    else if (inventoryAccounts.has(account.accountNumber)) klass = 'INVENTORY';
    else if (fixedAccounts.has(account.accountNumber)) klass = 'FIXED_ASSETS';
    else if (account.accountType === 'EQUITY' || account.accountType === 'LIABILITY') klass = 'FINANCING';
    else if (account.accountType === 'REVENUE' || account.accountType === 'EXPENSE') klass = 'OPERATING_PL';
    else klass = 'UNCLASSIFIED';
    classByAccount.set(account.accountNumber, klass);
  }
  for (const cashAccount of cashAccounts) {
    if (!classByAccount.has(cashAccount)) classByAccount.set(cashAccount, 'CASH');
  }

  return {
    companyCode, currency: company.currency, chart,
    classByAccount, accumDeprAccounts, cashAccounts,
  };
}

async function assertPeriodsStand(
  tx: Tx, client: string, companyCode: string,
  variant: string, isYearDependent: boolean, fiscalYear: number, periodFrom: number, periodTo: number,
): Promise<void> {
  const periodRows = await tx.select().from(fiscalYearPeriod).where(and(
    eq(fiscalYearPeriod.client, client), eq(fiscalYearPeriod.variant, variant),
    inArray(fiscalYearPeriod.calendarYear, isYearDependent ? [fiscalYear, 0] : [0]),
  ));
  const yearRows = periodRows.filter((row) => row.calendarYear === fiscalYear);
  const effective = yearRows.length > 0 ? yearRows : periodRows.filter((row) => row.calendarYear === 0);
  for (const period of [periodFrom, periodTo]) {
    if (!effective.some((row) => row.period === period)) {
      fail(`Period ${period} of fiscal year ${fiscalYear} is not defined by fiscal year variant ${variant} of company ${companyCode}.`,
        'Choose periods the company fiscal calendar defines.');
    }
  }
}

async function deriveCompany(
  tx: Tx, client: string, ctx: CompanyContext,
  selection: CashflowSelection, fiscalYear: number,
): Promise<CompanyDerivation> {
  const balances = await tx.execute(sql`
    select l.gl_account as account,
           coalesce(sum(case when e.fiscal_year < ${fiscalYear}
             or (e.fiscal_year = ${fiscalYear} and e.posting_period < ${selection.periodFrom})
             then case when l.debit_credit = 'S' then l.amount_local else -l.amount_local end else 0 end), 0)::text as opening,
           coalesce(sum(case when e.fiscal_year < ${fiscalYear}
             or (e.fiscal_year = ${fiscalYear} and e.posting_period <= ${selection.periodTo})
             then case when l.debit_credit = 'S' then l.amount_local else -l.amount_local end else 0 end), 0)::text as closing,
           coalesce(sum(case when e.fiscal_year = ${fiscalYear}
             and e.posting_period between ${selection.periodFrom} and ${selection.periodTo}
             then case when l.debit_credit = 'S' then l.amount_local else -l.amount_local end else 0 end), 0)::text as movement,
           count(case when e.fiscal_year = ${fiscalYear}
             and e.posting_period between ${selection.periodFrom} and ${selection.periodTo} then 1 end)::int as lines
    from journal_entry e
    join journal_entry_line l
      on l.client = e.client and l.document_number = e.document_number and l.fiscal_year = e.fiscal_year
    where e.client = ${client} and e.company_code = ${ctx.companyCode} and e.status = 'POSTED'
    group by l.gl_account
  `) as unknown as BalanceRow[];

  const byAccount = new Map(balances.map((row) => [row.account, row]));
  const klassOf = (account: string): CashflowAccountClass => ctx.classByAccount.get(account) ?? 'UNCLASSIFIED';
  const movementOf = (rows: BalanceRow[]) => sumScaled(rows.map((row) => row.movement));

  const cashRows = balances.filter((row) => klassOf(row.account) === 'CASH');
  const openingCash = sumScaled(cashRows.map((row) => row.opening));
  const closingCash = sumScaled(cashRows.map((row) => row.closing));
  const netCashChange = fromScaled(toScaled(closingCash) - toScaled(openingCash));

  const lineAmounts = new Map<string, string>();
  const unclassified: CompanyDerivation['unclassified'] = [];
  const warnings: string[] = [];

  if (selection.method === 'INDIRECT') {
    const plMovement = movementOf(balances.filter((row) => klassOf(row.account) === 'OPERATING_PL'));
    lineAmounts.set('NET_INCOME', neg(plMovement));
    const accumMovement = movementOf(balances.filter((row) => ctx.accumDeprAccounts.has(row.account)));
    lineAmounts.set('ADD_DEPRECIATION', neg(accumMovement));
    lineAmounts.set('CHANGE_RECEIVABLES', neg(movementOf(balances.filter((row) => klassOf(row.account) === 'RECEIVABLES'))));
    lineAmounts.set('CHANGE_PAYABLES', neg(movementOf(balances.filter((row) => klassOf(row.account) === 'PAYABLES'))));
    lineAmounts.set('CHANGE_INVENTORY', neg(movementOf(balances.filter((row) => klassOf(row.account) === 'INVENTORY'))));
    lineAmounts.set('INVEST_FIXED_ASSETS', neg(movementOf(
      balances.filter((row) => klassOf(row.account) === 'FIXED_ASSETS' && !ctx.accumDeprAccounts.has(row.account)),
    )));
    lineAmounts.set('FINANCING_MOVEMENT', neg(movementOf(balances.filter((row) => klassOf(row.account) === 'FINANCING'))));
  } else {
    const docLines = await tx.execute(sql`
      select e.document_number as "documentNumber", l.gl_account as account,
             l.debit_credit as "debitCredit", l.amount_local::text as "amountLocal"
      from journal_entry e
      join journal_entry_line l
        on l.client = e.client and l.document_number = e.document_number and l.fiscal_year = e.fiscal_year
      where e.client = ${client} and e.company_code = ${ctx.companyCode} and e.status = 'POSTED'
        and e.fiscal_year = ${fiscalYear}
        and e.posting_period between ${selection.periodFrom} and ${selection.periodTo}
      order by e.document_number, l.line_number
    `) as unknown as DocLineRow[];
    const byDocument = new Map<string, DocLineRow[]>();
    for (const line of docLines) {
      const list = byDocument.get(line.documentNumber) ?? [];
      list.push(line);
      byDocument.set(line.documentNumber, list);
    }
    let multiCashDocuments = 0;
    let cashToCashDocuments = 0;
    const unclassifiedByAccount = new Map<string, { amount: string; lines: number }>();
    const directKeys: Array<[CashflowAccountClass, string]> = [
      ['RECEIVABLES', 'DIRECT_RECEIVABLES'], ['PAYABLES', 'DIRECT_PAYABLES'],
      ['INVENTORY', 'DIRECT_INVENTORY'], ['OPERATING_PL', 'DIRECT_OPERATING'],
      ['FIXED_ASSETS', 'DIRECT_FIXED_ASSETS'], ['FINANCING', 'DIRECT_FINANCING'],
    ];
    for (const [key] of directKeys.map(([, k]) => [k] as const)) lineAmounts.set(key, '0');
    for (const lines of byDocument.values()) {
      const cashLines = lines.filter((line) => klassOf(line.account) === 'CASH');
      if (cashLines.length === 0) continue;
      if (cashLines.length > 1) multiCashDocuments += 1;
      const offsets = lines.filter((line) => klassOf(line.account) !== 'CASH');
      if (offsets.length === 0) { cashToCashDocuments += 1; continue; }
      for (const line of offsets) {
        const signed = line.debitCredit === 'S' ? line.amountLocal : neg(line.amountLocal);
        const effect = neg(signed);
        const klass = klassOf(line.account);
        if (klass === 'UNCLASSIFIED') {
          const existing = unclassifiedByAccount.get(line.account) ?? { amount: '0', lines: 0 };
          existing.amount = sumScaled([existing.amount, effect]);
          existing.lines += 1;
          unclassifiedByAccount.set(line.account, existing);
          continue;
        }
        const key = directKeys.find(([k]) => k === klass)?.[1];
        if (key) lineAmounts.set(key, sumScaled([lineAmounts.get(key) ?? '0', effect]));
      }
    }
    for (const [account, row] of unclassifiedByAccount) {
      unclassified.push({ account, amount: row.amount, lines: row.lines });
    }
    if (multiCashDocuments > 0) {
      warnings.push(`${ctx.companyCode}: ${multiCashDocuments} document(s) touch more than one cash account; their offsetting lines are read once against total cash.`);
    }
    if (cashToCashDocuments > 0) {
      warnings.push(`${ctx.companyCode}: ${cashToCashDocuments} document(s) move cash between cash accounts only and stand outside the sections.`);
    }
  }

  if (selection.method === 'INDIRECT') {
    for (const row of balances.filter((r) => klassOf(r.account) === 'UNCLASSIFIED' && toScaled(r.movement) !== 0n)) {
      unclassified.push({ account: row.account, amount: row.movement, lines: row.lines });
    }
  }
  unclassified.sort((a, b) => a.account.localeCompare(b.account));
  if (unclassified.length > 0) {
    warnings.push(`${ctx.companyCode}: ${unclassified.length} account(s) classify under no standing rule and stand named as unclassified; they explain the reconciliation difference.`);
  }

  const operatingKeys = selection.method === 'INDIRECT'
    ? ['NET_INCOME', 'ADD_DEPRECIATION', 'CHANGE_RECEIVABLES', 'CHANGE_PAYABLES', 'CHANGE_INVENTORY']
    : ['DIRECT_RECEIVABLES', 'DIRECT_PAYABLES', 'DIRECT_INVENTORY', 'DIRECT_OPERATING'];
  const investingKeys = selection.method === 'INDIRECT' ? ['INVEST_FIXED_ASSETS'] : ['DIRECT_FIXED_ASSETS'];
  const financingKeys = selection.method === 'INDIRECT' ? ['FINANCING_MOVEMENT'] : ['DIRECT_FINANCING'];
  const sectionsTotal = sumScaled([
    ...operatingKeys, ...investingKeys, ...financingKeys,
  ].map((key) => lineAmounts.get(key) ?? '0'));
  lineAmounts.set('NET_OPERATING', sumScaled(operatingKeys.map((key) => lineAmounts.get(key) ?? '0')));
  lineAmounts.set('NET_INVESTING', sumScaled(investingKeys.map((key) => lineAmounts.get(key) ?? '0')));
  lineAmounts.set('NET_FINANCING', sumScaled(financingKeys.map((key) => lineAmounts.get(key) ?? '0')));

  return {
    openingCash, closingCash, netCashChange,
    reconciliationDifference: fromScaled(toScaled(netCashChange) - toScaled(sectionsTotal)),
    lineAmounts, unclassified, warnings,
  };
}

const INDIRECT_LINE_DEFS: Array<{ section: CashflowSection['key']; key: string; label: string; kind: CashflowLine['kind'] }> = [
  { section: 'OPERATING', key: 'NET_INCOME', label: 'Net income for the period', kind: 'DETAIL' },
  { section: 'OPERATING', key: 'ADD_DEPRECIATION', label: 'Add back: depreciation (accumulated depreciation movement)', kind: 'DETAIL' },
  { section: 'OPERATING', key: 'CHANGE_RECEIVABLES', label: 'Change in trade receivables', kind: 'DETAIL' },
  { section: 'OPERATING', key: 'CHANGE_PAYABLES', label: 'Change in trade payables', kind: 'DETAIL' },
  { section: 'OPERATING', key: 'CHANGE_INVENTORY', label: 'Change in inventories', kind: 'DETAIL' },
  { section: 'OPERATING', key: 'NET_OPERATING', label: 'Net cash from operating activities', kind: 'TOTAL' },
  { section: 'INVESTING', key: 'INVEST_FIXED_ASSETS', label: 'Fixed asset acquisitions and disposals (net)', kind: 'DETAIL' },
  { section: 'INVESTING', key: 'NET_INVESTING', label: 'Net cash from investing activities', kind: 'TOTAL' },
  { section: 'FINANCING', key: 'FINANCING_MOVEMENT', label: 'Equity and borrowing movements', kind: 'DETAIL' },
  { section: 'FINANCING', key: 'NET_FINANCING', label: 'Net cash from financing activities', kind: 'TOTAL' },
];

const DIRECT_LINE_DEFS: Array<{ section: CashflowSection['key']; key: string; label: string; kind: CashflowLine['kind'] }> = [
  { section: 'OPERATING', key: 'DIRECT_RECEIVABLES', label: 'Receipts from customers', kind: 'DETAIL' },
  { section: 'OPERATING', key: 'DIRECT_PAYABLES', label: 'Payments to suppliers', kind: 'DETAIL' },
  { section: 'OPERATING', key: 'DIRECT_INVENTORY', label: 'Payments for inventories', kind: 'DETAIL' },
  { section: 'OPERATING', key: 'DIRECT_OPERATING', label: 'Other operating receipts and payments', kind: 'DETAIL' },
  { section: 'OPERATING', key: 'NET_OPERATING', label: 'Net cash from operating activities', kind: 'TOTAL' },
  { section: 'INVESTING', key: 'DIRECT_FIXED_ASSETS', label: 'Fixed asset acquisitions and disposals', kind: 'DETAIL' },
  { section: 'INVESTING', key: 'NET_INVESTING', label: 'Net cash from investing activities', kind: 'TOTAL' },
  { section: 'FINANCING', key: 'DIRECT_FINANCING', label: 'Financing receipts and payments', kind: 'DETAIL' },
  { section: 'FINANCING', key: 'NET_FINANCING', label: 'Net cash from financing activities', kind: 'TOTAL' },
];

const SECTION_TITLES: Record<CashflowSection['key'], string> = {
  OPERATING: 'Operating Activities',
  INVESTING: 'Investing Activities',
  FINANCING: 'Financing Activities',
};

export async function calculateCashflow(input: {
  client: string;
  selection: CashflowSelection;
}): Promise<CashflowResult> {
  const { client } = input;
  const selection: CashflowSelection = {
    companyCodes: [...new Set(input.selection.companyCodes.map((code) => code.trim().toUpperCase()).filter(Boolean))],
    fiscalYear: Number(input.selection.fiscalYear),
    periodFrom: Number(input.selection.periodFrom),
    periodTo: Number(input.selection.periodTo),
    method: input.selection.method === 'DIRECT' ? 'DIRECT' : 'INDIRECT',
    ledger: (input.selection.ledger || CASHFLOW_LEDGER).trim().toUpperCase(),
    comparative: Boolean(input.selection.comparative),
  };
  if (selection.companyCodes.length === 0) fail('At least one company code is required.', 'Select a company code.');
  if (!Number.isInteger(selection.fiscalYear) || selection.fiscalYear < 1900 || selection.fiscalYear > 2199) {
    fail('A fiscal year between 1900 and 2199 is required.');
  }
  if (!Number.isInteger(selection.periodFrom) || !Number.isInteger(selection.periodTo)
    || selection.periodFrom < 1 || selection.periodTo > 20 || selection.periodFrom > selection.periodTo) {
    fail('A period range From ≤ To within 1–20 is required.');
  }
  if (selection.ledger !== CASHFLOW_LEDGER) {
    fail(`Ledger ${selection.ledger} does not stand; the statement reads the leading ledger ${CASHFLOW_LEDGER} only.`);
  }

  return withTenant(client, async (tx) => {
    const contexts: CompanyContext[] = [];
    for (const companyCode of selection.companyCodes) {
      const ctx = await loadCompanyContext(tx, client, companyCode);
      contexts.push(ctx);
      const [company] = await tx.select().from(foundationCompanyCode).where(and(
        eq(foundationCompanyCode.client, client), eq(foundationCompanyCode.companyCode, companyCode),
      ));
      const [variant] = await tx.select().from(fiscalYearVariant).where(and(
        eq(fiscalYearVariant.client, client), eq(fiscalYearVariant.variant, company!.fiscalYearVariant!),
      ));
      await assertPeriodsStand(tx, client, companyCode, company!.fiscalYearVariant!,
        variant!.isYearDependent, selection.fiscalYear, selection.periodFrom, selection.periodTo);
    }

    const derivations = new Map<string, CompanyDerivation>();
    const warnings: string[] = [
      'Equity and non-vendor liability movements stand as financing (standing assumption of the approved contract).',
    ];
    for (const ctx of contexts) {
      const derivation = await deriveCompany(tx, client, ctx, selection, selection.fiscalYear);
      derivations.set(ctx.companyCode, derivation);
      warnings.push(...derivation.warnings);
    }

    const totalsComparable = contexts.every((ctx) => ctx.currency === contexts[0]!.currency);
    if (!totalsComparable) {
      warnings.push('The selected companies keep different local currencies; per-company columns stand and no combined total column is shown.');
    }

    const comparativeByCompany = new Map<string, CompanyDerivation>();
    if (selection.comparative) {
      for (const ctx of contexts) {
        try {
          const [company] = await tx.select().from(foundationCompanyCode).where(and(
            eq(foundationCompanyCode.client, client), eq(foundationCompanyCode.companyCode, ctx.companyCode),
          ));
          const [variant] = await tx.select().from(fiscalYearVariant).where(and(
            eq(fiscalYearVariant.client, client), eq(fiscalYearVariant.variant, company!.fiscalYearVariant!),
          ));
          await assertPeriodsStand(tx, client, ctx.companyCode, company!.fiscalYearVariant!,
            variant!.isYearDependent, selection.fiscalYear - 1, selection.periodFrom, selection.periodTo);
          comparativeByCompany.set(ctx.companyCode,
            await deriveCompany(tx, client, ctx, selection, selection.fiscalYear - 1));
        } catch {
          warnings.push(`Previous-year comparison could not be derived for company ${ctx.companyCode}; its comparison column stands blank.`);
        }
      }
    }

    const defs = selection.method === 'INDIRECT' ? INDIRECT_LINE_DEFS : DIRECT_LINE_DEFS;
    const sections: CashflowSection[] = (['OPERATING', 'INVESTING', 'FINANCING'] as const).map((key) => {
      const lines: CashflowLine[] = defs.filter((def) => def.section === key).map((def) => {
        const amountsByCompany: Record<string, string> = {};
        for (const ctx of contexts) {
          amountsByCompany[ctx.companyCode] = derivations.get(ctx.companyCode)!.lineAmounts.get(def.key) ?? '0';
        }
        return {
          key: def.key, label: def.label, amountsByCompany,
          total: totalsComparable ? sumScaled(Object.values(amountsByCompany)) : null,
          comparativeTotal: selection.comparative && totalsComparable
            ? sumScaled(contexts.map((ctx) => comparativeByCompany.get(ctx.companyCode)?.lineAmounts.get(def.key) ?? '0'))
            : null,
          kind: def.kind,
        };
      });
      const netLine = lines.find((line) => line.kind === 'TOTAL');
      return { key, title: SECTION_TITLES[key], lines, total: netLine?.total ?? null };
    });

    const totalOrNull = (pick: (d: CompanyDerivation) => string) => totalsComparable
      ? sumScaled(contexts.map((ctx) => pick(derivations.get(ctx.companyCode)!))) : null;

    return {
      selection,
      companies: contexts.map((ctx) => ({ companyCode: ctx.companyCode, currency: ctx.currency })),
      totalsComparable,
      sections,
      openingCash: totalOrNull((d) => d.openingCash),
      closingCash: totalOrNull((d) => d.closingCash),
      netCashChange: totalOrNull((d) => d.netCashChange),
      reconciliationDifference: totalOrNull((d) => d.reconciliationDifference),
      unclassified: contexts.flatMap((ctx) => derivations.get(ctx.companyCode)!.unclassified
        .map((row) => ({ companyCode: ctx.companyCode, ...row }))),
      warnings,
    };
  });
}
