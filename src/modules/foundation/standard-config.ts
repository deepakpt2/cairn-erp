/**
 * Standard configuration package — CAIRN.md §7.3, `INTL-STD-1`
 *
 * Activatable in one action, versioned, and used as the fixture for every
 * automated test. Its purpose is not to fill screens with sample data: it is to
 * make a newly created tenant *usable* — able to post a balanced entry on the
 * first day, with a real chart of accounts and real posting periods behind it.
 *
 * Everything here is configuration, not business data. Master data (materials,
 * partners) is a separate concern and belongs to M1b's master-data screens.
 */
import { and, eq } from 'drizzle-orm';
import type { Tx } from '../../platform/db/client';
import { buildPeriodRows } from '../../platform/periods';
import { recordChange } from '../../platform/change';
import { applyPaymentTermDefaults } from './payment-terms';
import {
  chartOfAccounts,
  companyCode,
  creditControlArea,
  controllingArea,
  controllingAreaCompany,
  distributionChannel,
  division,
  documentType,
  exchangeRate,
  fiscalYearPeriod,
  fiscalYearVariant,
  plant,
  postingPeriodRule,
  postingPeriodVariant,
  purchasingGroup,
  purchasingOrg,
  purchasingOrgPlant,
  salesArea,
  salesOrg,
  storageLocation,
} from './schema';
import { glAccount } from '../finance/schema';

export const STANDARD_PACKAGE_VERSION = 'INTL-STD-1';

export interface PackageInput {
  client: string;
  companyCode: string;
  companyName: string;
  currency: string;
  country: string;
  city?: string;
  timezone?: string;
  /** Fiscal year variant key to create. Defaults to K4 (calendar + 4 special). */
  fiscalYearVariant?: string;
  /** Local-language name of the chart of accounts. */
  activatedBy: string;
}

export interface PackageResult {
  version: string;
  chartOfAccounts: string;
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
  reconciliation?: 'VENDOR' | 'CUSTOMER' | 'ASSET' | 'MATERIAL';
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
  { number: '110000', name: 'Trade receivables', type: 'ASSET', isBalanceSheet: true, openItem: true, reconciliation: 'CUSTOMER', purpose: 'Customer reconciliation account. Its balance must equal the sum of customer open items (tie-out §16.4).' },
  { number: '110100', name: 'Intercompany receivables', type: 'ASSET', isBalanceSheet: true, openItem: true, reconciliation: 'CUSTOMER', purpose: 'Separate from trade receivables so intercompany balances are identifiable at all times (D-028).' },
  { number: '110200', name: 'Other receivables', type: 'ASSET', isBalanceSheet: true },
  { number: '120000', name: 'Raw materials inventory', type: 'ASSET', isBalanceSheet: true, reconciliation: 'MATERIAL' },
  { number: '120100', name: 'Semi-finished goods inventory', type: 'ASSET', isBalanceSheet: true, reconciliation: 'MATERIAL' },
  { number: '120200', name: 'Finished goods inventory', type: 'ASSET', isBalanceSheet: true, reconciliation: 'MATERIAL' },
  { number: '120300', name: 'Goods in transit', type: 'ASSET', isBalanceSheet: true, reconciliation: 'MATERIAL' },
  { number: '130000', name: 'Prepaid expenses', type: 'ASSET', isBalanceSheet: true },
  { number: '140000', name: 'Input tax receivable', type: 'ASSET', isBalanceSheet: true, taxRelevant: true },
  { number: '150000', name: 'Plant and machinery', type: 'ASSET', isBalanceSheet: true, reconciliation: 'ASSET' },
  { number: '150100', name: 'Accumulated depreciation — plant and machinery', type: 'ASSET', isBalanceSheet: true },
  { number: '151000', name: 'Office equipment', type: 'ASSET', isBalanceSheet: true, reconciliation: 'ASSET' },
  { number: '151100', name: 'Accumulated depreciation — office equipment', type: 'ASSET', isBalanceSheet: true },
  { number: '152000', name: 'Motor vehicles', type: 'ASSET', isBalanceSheet: true, reconciliation: 'ASSET' },
  { number: '152100', name: 'Accumulated depreciation — motor vehicles', type: 'ASSET', isBalanceSheet: true },
  { number: '160000', name: 'Intangible assets', type: 'ASSET', isBalanceSheet: true, reconciliation: 'ASSET' },

  // ── 2 · Liabilities and equity ────────────────────────────────────────────
  { number: '200000', name: 'Trade payables', type: 'LIABILITY', isBalanceSheet: true, openItem: true, reconciliation: 'VENDOR', purpose: 'Vendor reconciliation account. Its balance must equal the sum of vendor open items (tie-out §16.4).' },
  { number: '200100', name: 'Intercompany payables', type: 'LIABILITY', isBalanceSheet: true, openItem: true, reconciliation: 'VENDOR' },
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
  { code: 'SA', name: 'General journal entry', rangeObject: 'JOURNAL_ENTRY', rangeSub: 'GENERAL', accountTypes: 'S' },
  { code: 'KR', name: 'Vendor invoice', rangeObject: 'JOURNAL_ENTRY', rangeSub: 'GENERAL', accountTypes: 'SK', requiresReference: true },
  { code: 'KZ', name: 'Vendor payment', rangeObject: 'JOURNAL_ENTRY', rangeSub: 'GENERAL', accountTypes: 'SK' },
  { code: 'DR', name: 'Customer invoice', rangeObject: 'JOURNAL_ENTRY', rangeSub: 'GENERAL', accountTypes: 'SD', requiresReference: true },
  { code: 'DZ', name: 'Customer payment', rangeObject: 'JOURNAL_ENTRY', rangeSub: 'GENERAL', accountTypes: 'SD' },
  { code: 'AB', name: 'Accounting document', rangeObject: 'JOURNAL_ENTRY', rangeSub: 'GENERAL', accountTypes: 'S' },
  { code: 'AF', name: 'Depreciation run', rangeObject: 'JOURNAL_ENTRY', rangeSub: 'GENERAL', accountTypes: 'SA' },
  { code: 'WE', name: 'Goods receipt', rangeObject: 'JOURNAL_ENTRY', rangeSub: 'GENERAL', accountTypes: 'SM' },
  { code: 'WA', name: 'Goods issue', rangeObject: 'JOURNAL_ENTRY', rangeSub: 'GENERAL', accountTypes: 'SM' },
  { code: 'RV', name: 'Billing document', rangeObject: 'JOURNAL_ENTRY', rangeSub: 'GENERAL', accountTypes: 'SD' },
  { code: 'PR', name: 'Payroll posting', rangeObject: 'JOURNAL_ENTRY', rangeSub: 'GENERAL', accountTypes: 'S' },
];

export async function applyStandardPackage(
  tx: Tx,
  input: PackageInput,
): Promise<PackageResult> {
  const { client, activatedBy } = input;
  const coaKey = 'CAIRN';
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
      accountNumberLength: 6,
      createdBy: activatedBy,
    })
    .onConflictDoNothing();

  let accounts = 0;
  for (const spec of CHART_OF_ACCOUNTS) {
    await tx
      .insert(glAccount)
      .values({
        client,
        chartOfAccounts: coaKey,
        accountNumber: spec.number,
        name: spec.name,
        accountType: spec.type,
        isBalanceSheet: spec.isBalanceSheet,
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
    name: 'Calendar year, 4 special periods',
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
        period: row.period,
        periodType: row.periodType,
        startMonth: row.startMonth,
        startDay: row.startDay,
        endMonth: row.endMonth,
        endDay: row.endDay,
        name: row.name,
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

  /* ── Company code ────────────────────────────────────────────────────────── */
  const existingCompany = await tx
    .select()
    .from(companyCode)
    .where(and(eq(companyCode.client, client), eq(companyCode.companyCode, input.companyCode)))
    .limit(1);

  if (existingCompany.length === 0) {
    await tx.insert(companyCode).values({
      client,
      companyCode: input.companyCode,
      name: input.companyName,
      chartOfAccounts: coaKey,
      fiscalYearVariant: fyvKey,
      postingPeriodVariant: ppvKey,
      currency: input.currency,
      country: input.country,
      city: input.city ?? null,
      creditControlArea: '0001',
      intercompanyClearingAccount: '110100',
      createdBy: activatedBy,
    });
  } else {
    // Keep an existing company code in step with the package rather than
    // overwriting its identity.
    await tx
      .update(companyCode)
      .set({
        chartOfAccounts: coaKey,
        fiscalYearVariant: fyvKey,
        postingPeriodVariant: ppvKey,
        changedBy: activatedBy,
        changedAt: new Date(),
      })
      .where(and(eq(companyCode.client, client), eq(companyCode.companyCode, input.companyCode)));
  }

  /* ── Credit control area (D-029) ─────────────────────────────────────────── */
  await tx
    .insert(creditControlArea)
    .values({
      client,
      creditControlArea: '0001',
      name: 'Standard credit control area',
      currency: input.currency,
      warningThresholdPercent: 90,
      createdBy: activatedBy,
    })
    .onConflictDoNothing();

  /* ── Controlling area ────────────────────────────────────────────────────── */
  await tx
    .insert(controllingArea)
    .values({
      client,
      controllingArea: 'A000',
      name: 'Standard controlling area',
      currency: input.currency,
      fiscalYearVariant: fyvKey,
      createdBy: activatedBy,
    })
    .onConflictDoNothing();

  await tx
    .insert(controllingAreaCompany)
    .values({
      client,
      controllingArea: 'A000',
      companyCode: input.companyCode,
      createdBy: activatedBy,
    })
    .onConflictDoNothing();

  /* ── Plant and storage locations ─────────────────────────────────────────── */
  await tx
    .insert(plant)
    .values({
      client,
      plant: '1000',
      name: `${input.companyName} — Main plant`,
      companyCode: input.companyCode,
      country: input.country,
      city: input.city ?? null,
      isProductionSite: true,
      isStorageSite: true,
      defaultStorageLocation: '0001',
      createdBy: activatedBy,
    })
    .onConflictDoNothing();

  const storageLocations: Array<{ code: string; name: string }> = [
    { code: '0001', name: 'Raw materials store' },
    { code: '0002', name: 'Production floor' },
    { code: '0003', name: 'Finished goods warehouse' },
    { code: '0099', name: 'Goods receipt area' },
  ];

  for (const location of storageLocations) {
    await tx
      .insert(storageLocation)
      .values({
        client,
        plant: '1000',
        storageLocation: location.code,
        name: location.name,
        allowNegativeStock: false,
        createdBy: activatedBy,
      })
      .onConflictDoNothing();
  }

  /* ── Purchasing organisation and groups ──────────────────────────────────── */
  await tx
    .insert(purchasingOrg)
    .values({
      client,
      purchasingOrg: '1000',
      name: `${input.companyName} — Purchasing`,
      companyCode: input.companyCode,
      createdBy: activatedBy,
    })
    .onConflictDoNothing();

  await tx
    .insert(purchasingOrgPlant)
    .values({
      client,
      purchasingOrg: '1000',
      plant: '1000',
      createdBy: activatedBy,
    })
    .onConflictDoNothing();

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

  /* ── Sales organisation, channels, divisions and sales area ──────────────── */
  await tx
    .insert(salesOrg)
    .values({
      client,
      salesOrg: '1000',
      name: `${input.companyName} — Sales`,
      companyCode: input.companyCode,
      currency: input.currency,
      country: input.country,
      createdBy: activatedBy,
    })
    .onConflictDoNothing();

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
    { code: '01', name: 'Manufactured products' },
    { code: '02', name: 'Traded goods' },
    { code: '03', name: 'Services' },
  ];
  for (const div of divisions) {
    await tx
      .insert(division)
      .values({ client, division: div.code, name: div.name, createdBy: activatedBy })
      .onConflictDoNothing();
  }

  await tx
    .insert(salesArea)
    .values({
      client,
      salesOrg: '1000',
      distributionChannel: '01',
      division: '01',
      name: 'Direct sales — manufactured products',
      createdBy: activatedBy,
    })
    .onConflictDoNothing();

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
      companyCode: input.companyCode,
    },
  });

  const { applyMaterialDefaults } = await import('../inventory/standard-config');
  await applyMaterialDefaults(tx, input.client, input.activatedBy);
  await applyPaymentTermDefaults(tx, input.client, input.activatedBy);

  return {
    version: STANDARD_PACKAGE_VERSION,
    chartOfAccounts: coaKey,
    accounts,
    periods: periodRows.length,
    accountsReceivableAccount: '110000',
    accountsPayableAccount: '200000',
  };
}
