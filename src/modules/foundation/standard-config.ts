/**
 * Standard configuration package — CAIRN.md §7.3, `INTL-STD-3`
 *
 * Activatable in one action, versioned, and used as the fixture for every
 * automated test. Its purpose is not to fill screens with sample data: it is to
 * make a newly created tenant *usable* — able to post a balanced entry on the
 * first day, with a real chart of accounts and real posting periods behind it.
 *
 * Everything here is configuration, not business data. Master data (materials,
 * partners) is a separate concern and belongs to M1b's master-data screens.
 *
 * Since `INTL-STD-3` nothing in this file belongs to a company. The package used
 * to create a company code and hang a controlling area, a plant with storage
 * locations, a purchasing organisation and a sales organisation from it, which
 * meant a tenant could not exist without one legal entity already configured and
 * the workbench reported twelve configuration activities as complete that no
 * screen had been asked about. What is left is true for any company a tenant may
 * later define through its own screen: the chart of accounts and its accounts,
 * the fiscal year variant and its periods, the posting period variant and its
 * interval rules, document types, exchange rates, distribution channels,
 * divisions, purchasing groups, the supplier partner-function catalogue, material
 * types, groups and valuation classes, and payment terms.
 *
 * The enterprise structure a fixture needs now comes from
 * `src/platform/tenancy/standard-structure.ts`, which reproduces the rows this
 * file used to write and is exercised against them by
 * `tests/standard-structure-builder.test.ts`.
 */
import { and, eq } from 'drizzle-orm';
import type { Tx } from '../../platform/db/client';
import { buildPeriodRows } from '../../platform/periods';
import { recordChange } from '../../platform/change';
import { applyPaymentTermDefaults } from './payment-terms';
import {
  chartOfAccounts,
  distributionChannel,
  division,
  documentType,
  exchangeRate,
  fiscalYearPeriod,
  fiscalYearVariant,
  postingPeriodRule,
  postingPeriodVariant,
  purchasingGroup,
  supplierPartnerFunction,
} from './schema';
import { glAccount, reversalReason } from '../finance/schema';
import { glAccountGroup } from '../finance/gl-account-group-schema';
import {
  deriveGlAccountType,
  deriveIsBalanceSheet,
  isBalanceSheetAccountType,
  type ReconciliationType,
} from '../finance/gl-account-vocabulary';

// Bumped from INTL-STD-2 when the company-specific half left the package: the
// version is the object key of the package's change document, so tenants
// configured before and after the split are distinguishable in the audit trail.
export const STANDARD_PACKAGE_VERSION = 'INTL-STD-3';

/**
 * The Account Group the standard package defines for its chart (FS00).
 *
 * `account_group` is mandatory on every account and the group owns the number range, so
 * a package that defines accounts must define a group first.
 */
export const STANDARD_ACCOUNT_GROUP = 'GENL';

/** Tenant-seeded supplier partner functions; cardinality is explicit, not inferred. */
const SUPPLIER_PARTNER_FUNCTIONS = [
  { functionCode: 'ORDERING_PARTNER', displayName: 'Ordering partner', allowsMultiple: false },
  { functionCode: 'DELIVERY_PARTNER', displayName: 'Delivery partner', allowsMultiple: false },
  { functionCode: 'INVOICE_SENDER', displayName: 'Invoice sender', allowsMultiple: false },
] as const;

export interface PackageInput {
  client: string;
  /** Currency the exchange rates and the chart are built around. */
  currency: string;
  /** Tenant-local operational chart key. Defaults to CA01 for the standard package. */
  chartOfAccounts?: string;
  /** Fiscal year variant key to create. Defaults to K4 (calendar + 4 special). */
  fiscalYearVariant?: string;
  activatedBy: string;
}

export interface PackageResult {
  version: string;
  chartOfAccounts: string;
  /** The fiscal year variant the package defined, so the caller can record it. */
  fiscalYearVariant: string;
  accounts: number;
  periods: number;
  accountsReceivableAccount: string;
  accountsPayableAccount: string;
}

/**
 * Chart of accounts.
 *
 * Numbering follows a widely understood structure — 1 assets, 2 liabilities and
 * equity, 3 revenue, 4 cost of sales, 5 operating expenses, 6 allocation — so an
 * accountant reads it without a legend. The accounts themselves are ours.
 */
interface AccountSpec {
  number: string;
  name: string;
  type: 'ASSET' | 'LIABILITY' | 'EQUITY' | 'REVENUE' | 'EXPENSE';
  isBalanceSheet: boolean;
  openItem?: boolean;
  reconciliation?: ReconciliationType;
  requiresCostObject?: boolean;
  taxRelevant?: boolean;
  /** A short note used by the posting trace to explain what this account is for. */
  purpose?: string;
}

const CHART_OF_ACCOUNTS: AccountSpec[] = [
  // ── 1 · Assets ────────────────────────────────────────────────────────────
  { number: '100000', name: 'Cash on hand', type: 'ASSET', isBalanceSheet: true },
  { number: '101000', name: 'Bank — current account', type: 'ASSET', isBalanceSheet: true },
  { number: '101100', name: 'Bank — foreign currency account', type: 'ASSET', isBalanceSheet: true },
  { number: '110000', name: 'Trade receivables', type: 'ASSET', isBalanceSheet: true, openItem: true, reconciliation: 'CUSTOMERS', purpose: 'Customer reconciliation account. Its balance must equal the sum of customer open items (tie-out §16.4).' },
  { number: '110100', name: 'Intercompany receivables', type: 'ASSET', isBalanceSheet: true, openItem: true, reconciliation: 'CUSTOMERS', purpose: 'Separate from trade receivables so intercompany balances are identifiable at all times (D-028).' },
  { number: '110200', name: 'Other receivables', type: 'ASSET', isBalanceSheet: true },
  { number: '120000', name: 'Raw materials inventory', type: 'ASSET', isBalanceSheet: true, reconciliation: 'MATERIAL' },
  { number: '120100', name: 'Semi-finished goods inventory', type: 'ASSET', isBalanceSheet: true, reconciliation: 'MATERIAL' },
  { number: '120200', name: 'Finished goods inventory', type: 'ASSET', isBalanceSheet: true, reconciliation: 'MATERIAL' },
  { number: '120300', name: 'Goods in transit', type: 'ASSET', isBalanceSheet: true, reconciliation: 'MATERIAL' },
  { number: '130000', name: 'Prepaid expenses', type: 'ASSET', isBalanceSheet: true },
  { number: '140000', name: 'Input tax receivable', type: 'ASSET', isBalanceSheet: true, taxRelevant: true },
  { number: '150000', name: 'Plant and machinery', type: 'ASSET', isBalanceSheet: true, reconciliation: 'ASSETS' },
  { number: '150100', name: 'Accumulated depreciation — plant and machinery', type: 'ASSET', isBalanceSheet: true },
  { number: '151000', name: 'Office equipment', type: 'ASSET', isBalanceSheet: true, reconciliation: 'ASSETS' },
  { number: '151100', name: 'Accumulated depreciation — office equipment', type: 'ASSET', isBalanceSheet: true },
  { number: '152000', name: 'Motor vehicles', type: 'ASSET', isBalanceSheet: true, reconciliation: 'ASSETS' },
  { number: '152100', name: 'Accumulated depreciation — motor vehicles', type: 'ASSET', isBalanceSheet: true },
  { number: '160000', name: 'Intangible assets', type: 'ASSET', isBalanceSheet: true, reconciliation: 'ASSETS' },

  // ── 2 · Liabilities and equity ────────────────────────────────────────────
  { number: '200000', name: 'Trade payables', type: 'LIABILITY', isBalanceSheet: true, openItem: true, reconciliation: 'VENDORS', purpose: 'Vendor reconciliation account. Its balance must equal the sum of vendor open items (tie-out §16.4).' },
  { number: '200100', name: 'Intercompany payables', type: 'LIABILITY', isBalanceSheet: true, openItem: true, reconciliation: 'VENDORS' },
  { number: '201000', name: 'Other payables', type: 'LIABILITY', isBalanceSheet: true, openItem: true },
  { number: '210000', name: 'Goods received not invoiced', type: 'LIABILITY', isBalanceSheet: true, openItem: true, purpose: 'The GR/IR clearing account. Goods receipt credits it; the supplier invoice debits it. A residual balance at period end is reclassified (FIN.GRIR.RECLASS).' },
  { number: '220000', name: 'Output tax payable', type: 'LIABILITY', isBalanceSheet: true, taxRelevant: true },
  { number: '221000', name: 'Withholding tax payable', type: 'LIABILITY', isBalanceSheet: true, taxRelevant: true },
  { number: '230000', name: 'Accrued liabilities', type: 'LIABILITY', isBalanceSheet: true, openItem: true },
  { number: '230100', name: 'Accrual — salaries and wages', type: 'LIABILITY', isBalanceSheet: true },
  { number: '230200', name: 'Accrual — utilities', type: 'LIABILITY', isBalanceSheet: true },
  { number: '240000', name: 'End of service benefit provision', type: 'LIABILITY', isBalanceSheet: true, purpose: 'Accrued periodically and charged to cost centres (R-11).' },
  { number: '250000', name: 'Payroll deductions payable', type: 'LIABILITY', isBalanceSheet: true },
  { number: '251000', name: 'Net pay payable', type: 'LIABILITY', isBalanceSheet: true },
  { number: '260000', name: 'Bank borrowings', type: 'LIABILITY', isBalanceSheet: true },
  { number: '280000', name: 'Share capital', type: 'EQUITY', isBalanceSheet: true },
  { number: '290000', name: 'Retained earnings', type: 'EQUITY', isBalanceSheet: true, purpose: 'Carried forward at year end (FIN.CLOSE.CARRYFORWARD).' },
  { number: '291000', name: 'Current year result', type: 'EQUITY', isBalanceSheet: true },

  // ── 3 · Revenue ───────────────────────────────────────────────────────────
  { number: '300000', name: 'Revenue — domestic sales', type: 'REVENUE', isBalanceSheet: false },
  { number: '300100', name: 'Revenue — export sales', type: 'REVENUE', isBalanceSheet: false },
  { number: '300200', name: 'Revenue — intercompany sales', type: 'REVENUE', isBalanceSheet: false, purpose: 'Eliminated against intercompany cost of sales at consolidation (D-028).' },
  { number: '310000', name: 'Revenue deductions — discounts', type: 'REVENUE', isBalanceSheet: false },
  { number: '310100', name: 'Revenue deductions — returns', type: 'REVENUE', isBalanceSheet: false },
  { number: '320000', name: 'Other operating income', type: 'REVENUE', isBalanceSheet: false },

  // ── 4 · Cost of sales and production ──────────────────────────────────────
  { number: '400000', name: 'Cost of goods sold', type: 'EXPENSE', isBalanceSheet: false, requiresCostObject: false, purpose: 'Debited at goods issue, credited to finished goods inventory, valued at standard cost.' },
  { number: '400100', name: 'Cost of goods sold — intercompany', type: 'EXPENSE', isBalanceSheet: false },
  { number: '410000', name: 'Raw material consumption', type: 'EXPENSE', isBalanceSheet: false, requiresCostObject: true },
  { number: '410100', name: 'Production variance', type: 'EXPENSE', isBalanceSheet: false, requiresCostObject: true, purpose: 'Where a production order settles its actual-versus-standard difference (§13.1).' },
  { number: '410200', name: 'Inventory price differences', type: 'EXPENSE', isBalanceSheet: false, purpose: 'Purchase price variance against standard price at goods receipt.' },
  { number: '410300', name: 'Scrap and rework', type: 'EXPENSE', isBalanceSheet: false, requiresCostObject: true },
  { number: '420000', name: 'Activity absorption — labour', type: 'EXPENSE', isBalanceSheet: false, requiresCostObject: true, purpose: 'Credited when a cost centre supplies labour hours to a production order (§13.1).' },
  { number: '420100', name: 'Activity absorption — machine', type: 'EXPENSE', isBalanceSheet: false, requiresCostObject: true },
  { number: '420200', name: 'Activity absorption — utilities', type: 'EXPENSE', isBalanceSheet: false, requiresCostObject: true },
  { number: '430000', name: 'Production overhead applied', type: 'EXPENSE', isBalanceSheet: false, requiresCostObject: true },
  { number: '440000', name: 'Inventory differences', type: 'EXPENSE', isBalanceSheet: false, purpose: 'Physical inventory count differences (INV.PHYINV.DIFF).' },

  // ── 5 · Operating expenses ────────────────────────────────────────────────
  { number: '500000', name: 'Salaries and wages', type: 'EXPENSE', isBalanceSheet: false, requiresCostObject: true },
  { number: '500100', name: 'Employer contributions', type: 'EXPENSE', isBalanceSheet: false, requiresCostObject: true },
  { number: '500200', name: 'End of service benefit expense', type: 'EXPENSE', isBalanceSheet: false, requiresCostObject: true },
  { number: '500300', name: 'Overtime and bonuses', type: 'EXPENSE', isBalanceSheet: false, requiresCostObject: true },
  { number: '510000', name: 'Rent expense', type: 'EXPENSE', isBalanceSheet: false, requiresCostObject: true },
  { number: '510100', name: 'Utilities expense', type: 'EXPENSE', isBalanceSheet: false, requiresCostObject: true },
  { number: '510200', name: 'Repairs and maintenance', type: 'EXPENSE', isBalanceSheet: false, requiresCostObject: true },
  { number: '520000', name: 'Depreciation expense', type: 'EXPENSE', isBalanceSheet: false, requiresCostObject: true },
  { number: '530000', name: 'Office supplies', type: 'EXPENSE', isBalanceSheet: false, requiresCostObject: true },
  { number: '530100', name: 'Communication expense', type: 'EXPENSE', isBalanceSheet: false, requiresCostObject: true },
  { number: '530200', name: 'Travel expense', type: 'EXPENSE', isBalanceSheet: false, requiresCostObject: true },
  { number: '540000', name: 'Professional fees', type: 'EXPENSE', isBalanceSheet: false, requiresCostObject: true },
  { number: '540100', name: 'Audit fees', type: 'EXPENSE', isBalanceSheet: false, requiresCostObject: true },
  { number: '550000', name: 'Insurance expense', type: 'EXPENSE', isBalanceSheet: false, requiresCostObject: true },
  { number: '560000', name: 'Bank charges', type: 'EXPENSE', isBalanceSheet: false },
  { number: '560100', name: 'Cash discount allowed', type: 'EXPENSE', isBalanceSheet: false, purpose: 'Where a customer takes a settlement discount (O2C step 10).' },
  { number: '560200', name: 'Cash discount received', type: 'REVENUE', isBalanceSheet: false, purpose: 'Where we take a settlement discount from a supplier (P2P step 11).' },
  { number: '570000', name: 'Foreign exchange gain or loss', type: 'EXPENSE', isBalanceSheet: false, purpose: 'Realised differences on clearing, and unrealised at period end (FIN.FX.VALUATE).' },
  { number: '580000', name: 'Property tax and licences', type: 'EXPENSE', isBalanceSheet: false, requiresCostObject: true },

  // ── 6 · Allocation ────────────────────────────────────────────────────────
  { number: '600000', name: 'Cost centre allocation — clearing', type: 'EXPENSE', isBalanceSheet: false, requiresCostObject: true, purpose: 'Assessment and distribution cycles post here (COST.ALLOCATION.ASSESS).' },
  { number: '610000', name: 'Assessment cost element', type: 'EXPENSE', isBalanceSheet: false, requiresCostObject: true },
  { number: '620000', name: 'Distribution cost element', type: 'EXPENSE', isBalanceSheet: false, requiresCostObject: true },
];

/** Document types and the number ranges they consume (§8.2). */
const DOCUMENT_TYPES: Array<{
  code: string;
  name: string;
  rangeObject: string;
  rangeSub: string;
  accountTypes: string;
  requiresReference?: boolean;
}> = [
  { code: 'SA', name: 'General journal entry', rangeObject: 'RF_BELEG', rangeSub: 'GENERAL', accountTypes: 'S' },
  { code: 'KR', name: 'Vendor invoice', rangeObject: 'RF_BELEG', rangeSub: 'GENERAL', accountTypes: 'SK', requiresReference: true },
  { code: 'KG', name: 'Vendor credit memo', rangeObject: 'RF_BELEG', rangeSub: 'GENERAL', accountTypes: 'SK', requiresReference: true },
  { code: 'KZ', name: 'Vendor payment', rangeObject: 'RF_BELEG', rangeSub: 'GENERAL', accountTypes: 'SK' },
  { code: 'DR', name: 'Customer invoice', rangeObject: 'RF_BELEG', rangeSub: 'GENERAL', accountTypes: 'SD', requiresReference: true },
  { code: 'DZ', name: 'Customer payment', rangeObject: 'RF_BELEG', rangeSub: 'GENERAL', accountTypes: 'SD' },
  { code: 'AB', name: 'Accounting document', rangeObject: 'RF_BELEG', rangeSub: 'GENERAL', accountTypes: 'S' },
  { code: 'AF', name: 'Depreciation run', rangeObject: 'RF_BELEG', rangeSub: 'GENERAL', accountTypes: 'SA' },
  { code: 'WE', name: 'Goods receipt', rangeObject: 'RF_BELEG', rangeSub: 'GENERAL', accountTypes: 'SM' },
  { code: 'WA', name: 'Goods issue', rangeObject: 'RF_BELEG', rangeSub: 'GENERAL', accountTypes: 'SM' },
  { code: 'RV', name: 'Billing document', rangeObject: 'RF_BELEG', rangeSub: 'GENERAL', accountTypes: 'SD' },
  { code: 'PR', name: 'Payroll posting', rangeObject: 'RF_BELEG', rangeSub: 'GENERAL', accountTypes: 'S' },
];

/** Initial tenant-configured reversal reasons (SCR-072 / R-120); maintenance UI is a later act. */
const REVERSAL_REASONS: Array<{ code: string; description: string }> = [
  { code: '01', description: 'Reversal in current period' },
  { code: '02', description: 'Reversal in closed period' },
  { code: '03', description: 'Accrual or deferral reversal' },
  { code: '04', description: 'Duplicate or incorrect posting' },
];

export async function applyStandardPackage(
  tx: Tx,
  input: PackageInput,
): Promise<PackageResult> {
  const { client, activatedBy } = input;
  const coaKey = (input.chartOfAccounts ?? 'CA01').trim().toUpperCase();
  if (!/^[A-Z0-9]{4}$/.test(coaKey)) {
    throw new Error('Chart of Accounts key must be exactly four letters or numbers.');
  }
  const fyvKey = input.fiscalYearVariant ?? 'K4';
  // Configuration keys are four characters throughout, as users expect.
  const ppvKey = 'C001';

  /* ── Chart of accounts ───────────────────────────────────────────────────── */
  await tx
    .insert(chartOfAccounts)
    .values({
      client,
      chartOfAccounts: coaKey,
      name: 'Cairn International Standard Chart of Accounts',
      language: 'EN',
      accountNumberLength: 10,
      createdBy: activatedBy,
    })
    .onConflictDoNothing();

  const [chartDefinition] = await tx.select({
    accountNumberLength: chartOfAccounts.accountNumberLength,
    isBlocked: chartOfAccounts.isBlocked,
  }).from(chartOfAccounts)
    .where(and(eq(chartOfAccounts.client, client), eq(chartOfAccounts.chartOfAccounts, coaKey)))
    .limit(1)
    .for('share');
  if (!chartDefinition) throw new Error(`Standard Chart of Accounts ${coaKey} was not created.`);

  const existingStandardAccounts = await tx.select({ accountNumber: glAccount.accountNumber })
    .from(glAccount)
    .where(and(eq(glAccount.client, client), eq(glAccount.chartOfAccounts, coaKey)));
  const existingAccountNumbers = new Set(existingStandardAccounts.map((row) => row.accountNumber.trim()));
  const missingStandardAccounts = CHART_OF_ACCOUNTS.filter((spec) => !existingAccountNumbers.has(spec.number));
  if (chartDefinition.isBlocked && missingStandardAccounts.length > 0) {
    throw new Error(`Chart of Accounts ${coaKey} is blocked; the standard package cannot create its missing G/L accounts.`);
  }
  const overlengthStandardAccounts = CHART_OF_ACCOUNTS.filter((spec) => spec.number.length > chartDefinition.accountNumberLength);
  if (overlengthStandardAccounts.length > 0) {
    throw new Error(`Chart of Accounts ${coaKey} has a ${chartDefinition.accountNumberLength}-character limit, shorter than standard G/L account ${overlengthStandardAccounts[0].number}.`);
  }

  // The balance-sheet flag is derived from the G/L Account Type (FS00), so a spec that
  // disagrees with its own account type is a package defect, not a data choice.
  const mislabelledStandardAccounts = CHART_OF_ACCOUNTS.filter(
    (spec) => spec.isBalanceSheet !== isBalanceSheetAccountType(spec.type),
  );
  if (mislabelledStandardAccounts.length > 0) {
    const spec = mislabelledStandardAccounts[0];
    throw new Error(`Standard G/L account ${spec.number} is labelled ${spec.isBalanceSheet ? 'balance sheet' : 'profit and loss'} but its account type derives the opposite; the flag is derived from the G/L Account Type.`);
  }

  /* ── Account Group registry ───────────────────────────────────────────────── */
  // One group spanning the chart's whole account-number width is the honest standard:
  // the package's own numbers run across three leading digits for expenses and two for
  // revenue, so no narrower range describes them. A consultant defines narrower groups
  // in FS00 and re-assigns accounts in Change mode afterwards.
  await tx
    .insert(glAccountGroup)
    .values({
      client,
      chartOfAccounts: coaKey,
      accountGroup: STANDARD_ACCOUNT_GROUP,
      description: 'General ledger accounts',
      fromAccountNumber: '0'.repeat(chartDefinition.accountNumberLength),
      toAccountNumber: '9'.repeat(chartDefinition.accountNumberLength),
      createdBy: activatedBy,
    })
    .onConflictDoNothing();

  let accounts = 0;
  for (const spec of CHART_OF_ACCOUNTS) {
    const glAccountType = deriveGlAccountType(spec.type);
    await tx
      .insert(glAccount)
      .values({
        client,
        chartOfAccounts: coaKey,
        accountNumber: spec.number,
        name: spec.name,
        accountType: spec.type,
        accountGroup: STANDARD_ACCOUNT_GROUP,
        glAccountType,
        isBalanceSheet: deriveIsBalanceSheet(glAccountType),
        isOpenItemManaged: spec.openItem ?? false,
        reconciliationType: spec.reconciliation,
        requiresCostObject: spec.requiresCostObject ?? false,
        isTaxRelevant: spec.taxRelevant ?? false,
        createdBy: activatedBy,
      })
      .onConflictDoNothing();
    accounts++;
  }

  /* ── Fiscal year variant and its periods ─────────────────────────────────── */
  const fyv = {
    regularPeriods: 12,
    specialPeriods: 4,
    startMonth: 1,
    isCalendarYear: true,
    isYearDependent: false,
    // Thirty characters, because the contract's description field is thirty: the old text was 32.
    name: 'Calendar year + 4 special',
  };

  await tx
    .insert(fiscalYearVariant)
    .values({
      client,
      variant: fyvKey,
      name: fyv.name,
      regularPeriods: fyv.regularPeriods,
      specialPeriods: fyv.specialPeriods,
      isCalendarYear: fyv.isCalendarYear,
      isYearDependent: fyv.isYearDependent,
      createdBy: activatedBy,
    })
    .onConflictDoNothing();

  // Periods are derived from the variant's own parameters rather than listed by
  // hand, so a variant and its period list cannot drift apart.
  const periodRows = buildPeriodRows(fyv);
  for (const row of periodRows) {
    await tx
      .insert(fiscalYearPeriod)
      .values({
        client,
        variant: fyvKey,
        // 0: this variant's periods hold for every calendar year.
        calendarYear: 0,
        period: row.period,
        periodType: row.periodType,
        month: row.month,
        day: row.day,
        yearShift: row.yearShift,
        createdBy: activatedBy,
      })
      .onConflictDoNothing();
  }

  /* ── Posting period variant and rules ────────────────────────────────────── */
  await tx
    .insert(postingPeriodVariant)
    .values({
      client,
      variant: ppvKey,
      name: 'Standard period control',
      createdBy: activatedBy,
    })
    .onConflictDoNothing();

  // Vendor and customer periods close a month behind the general ledger, which is
  // the usual practice: it stops late supplier invoices arriving after the
  // subledger has been reported, while still letting closing entries through.
  const rules: Array<{
    accountType: 'S' | 'K' | 'D' | 'A' | 'M';
    from: number;
    to: number;
    specials: boolean;
  }> = [
    { accountType: 'S', from: 1, to: 12, specials: true },
    { accountType: 'K', from: 1, to: 12, specials: false },
    { accountType: 'D', from: 1, to: 12, specials: false },
    { accountType: 'A', from: 1, to: 12, specials: true },
    { accountType: 'M', from: 1, to: 12, specials: false },
  ];

  for (const rule of rules) {
    await tx
      .insert(postingPeriodRule)
      .values({
        client,
        variant: ppvKey,
        accountType: rule.accountType,
        periodFrom: rule.from,
        periodTo: rule.to,
        allowSpecialPeriods: rule.specials,
        yearShiftPast: 0,
        yearShiftFuture: 1,
        createdBy: activatedBy,
      })
      .onConflictDoNothing();
  }

  /* ── Purchasing groups ──────────────────────────────────────── */

  const buyerGroups: Array<{ code: string; name: string }> = [
    { code: '001', name: 'Raw materials buying' },
    { code: '002', name: 'Components and parts' },
    { code: '003', name: 'Services and indirect spend' },
    { code: '004', name: 'Capital equipment' },
  ];

  for (const group of buyerGroups) {
    await tx
      .insert(purchasingGroup)
      .values({
        client,
        purchasingGroup: group.code,
        name: group.name,
        purchasingOrg: '1000',
        createdBy: activatedBy,
      })
      .onConflictDoNothing();
  }

  /* ── Distribution channels and divisions ─────────────────────── */

  const channels: Array<{ code: string; name: string }> = [
    { code: '01', name: 'Direct sales' },
    { code: '02', name: 'Distributors' },
    { code: '03', name: 'Online' },
  ];
  for (const channel of channels) {
    await tx
      .insert(distributionChannel)
      .values({
        client,
        distributionChannel: channel.code,
        name: channel.name,
        createdBy: activatedBy,
      })
      .onConflictDoNothing();
  }

  const divisions: Array<{ code: string; name: string }> = [
    { code: '01', name: 'Manufactured goods' },
    { code: '02', name: 'Traded goods' },
    { code: '03', name: 'Services' },
  ];
  for (const div of divisions) {
    await tx
      .insert(division)
      .values({ client, division: div.code, name: div.name, createdBy: activatedBy })
      .onConflictDoNothing();
  }

  /* ── Document types ──────────────────────────────────────────────────────── */
  for (const documentTypeSpec of DOCUMENT_TYPES) {
    await tx
      .insert(documentType)
      .values({
        client,
        documentType: documentTypeSpec.code,
        name: documentTypeSpec.name,
        numberRangeObject: documentTypeSpec.rangeObject,
        numberRangeSubObject: documentTypeSpec.rangeSub,
        allowedAccountTypes: documentTypeSpec.accountTypes,
        requiresReference: documentTypeSpec.requiresReference ?? false,
        createdBy: activatedBy,
      })
      .onConflictDoNothing();
  }

  /* ── Reversal reasons ─────────────────────────────────────────────────────── */
  for (const reason of REVERSAL_REASONS) {
    await tx
      .insert(reversalReason)
      .values({
        client,
        reasonCode: reason.code,
        reasonDescription: reason.description,
        isActive: true,
        createdBy: activatedBy,
      })
      .onConflictDoNothing();
  }

  /* ── Exchange rates ──────────────────────────────────────────────────────── */
  // Only where the company code's own currency is not USD, so a USD company does
  // not carry meaningless rate rows.
  const rates: Array<{ from: string; to: string; rate: string }> = [];
  if (input.currency === 'KWD') {
    rates.push({ from: 'KWD', to: 'USD', rate: '3.25650000' });
  } else if (input.currency === 'USD') {
    rates.push({ from: 'USD', to: 'EUR', rate: '0.92000000' });
  }
  if (input.currency !== 'USD') {
    rates.push({ from: input.currency, to: 'USD', rate: '1.00000000' });
  }

  const today = new Date();
  const validFrom = `${today.getUTCFullYear()}-01-01`;

  for (const rate of rates) {
    await tx
      .insert(exchangeRate)
      .values({
        client,
        rateType: 'AVERAGE',
        fromCurrency: rate.from,
        toCurrency: rate.to,
        validFrom,
        rate: rate.rate,
        createdBy: activatedBy,
      })
      .onConflictDoNothing();
  }

  /* ── Supplier partner-function catalogue ────────────────────────────────── */
  for (const spec of SUPPLIER_PARTNER_FUNCTIONS) {
    await tx
      .insert(supplierPartnerFunction)
      .values({ client, ...spec, createdBy: activatedBy })
      .onConflictDoNothing();
  }

  /* ── Change document ─────────────────────────────────────────────────────── */
  await recordChange(tx, {
    client,
    objectClass: 'standard_config_package',
    objectKey: STANDARD_PACKAGE_VERSION,
    changeType: 'CREATE',
    changedBy: activatedBy,
    transactionCode: 'CFG.WORKBENCH',
    after: {
      version: STANDARD_PACKAGE_VERSION,
      chartOfAccounts: coaKey,
      accounts,
      fiscalYearVariant: fyvKey,
      periods: periodRows.length,
      supplierPartnerFunctions: SUPPLIER_PARTNER_FUNCTIONS.length,
    },
  });

  const { seedNumberRangeObjects } = await import('./number-ranges');
  await seedNumberRangeObjects(tx, input.client, input.activatedBy);
  const { applyMaterialDefaults } = await import('../inventory/standard-config');
  await applyMaterialDefaults(tx, input.client, input.activatedBy);
  await applyPaymentTermDefaults(tx, input.client, input.activatedBy);

  return {
    version: STANDARD_PACKAGE_VERSION,
    chartOfAccounts: coaKey,
    fiscalYearVariant: fyvKey,
    accounts,
    periods: periodRows.length,
    accountsReceivableAccount: '110000',
    accountsPayableAccount: '200000',
  };
}
