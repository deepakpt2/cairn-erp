/**
 * CSV / PDF exports for the finance reports. Each adapter reads the screen's own query string and calls
 * the service the screen calls, so the export is the figures on screen — never a second calculation.
 */
import { ReportExportError, type ReportAdapter, type ReportDoc, type ReportColumn, type ReportSection, fmt, need, num } from '../output/report-export';
import { calculateTrialBalance, TRIAL_BALANCE_CAPABILITY, listStatementVersions, type TrialBalanceSelection } from './trial-balance';
import { calculateBalanceSheet, BALANCE_SHEET_CAPABILITY, DEFAULT_SUMMARY_LEVEL, type BalanceSheetSelection } from './balance-sheet';
import { calculateProfitLoss, PROFIT_LOSS_CAPABILITY } from './profit-loss';
import { getVendorBalances, VENDOR_BALANCE_CAPABILITY } from './vendor-balances';
import { getCustomerBalances, CUSTOMER_BALANCE_CAPABILITY } from './customer-balances';
import { getVendorAgeing, VENDOR_AGEING_CAPABILITY } from './vendor-ageing';
import { getJournalItems, JOURNAL_ITEMS_CAPABILITY, JOURNAL_ITEMS_CAP } from './journal-items';
import { getGlBalanceReport, GL_BALANCE_CAPABILITY } from './gl-balances';
import { calculateCashflow, CASHFLOW_CAPABILITY, CASHFLOW_LEDGER, CASHFLOW_METHOD_LABELS, type CashflowSelection } from './cash-flow';
import {
  calculateConsolidatedStatements, CONSOLIDATED_STATEMENTS_CAPABILITY, SECTION_LABELS, STATEMENT_SECTIONS,
  type ConsolidatedStatementsSelection,
} from './consolidated-statements';
import { getConsolidationWorkbench, listConsolidationAreas } from './consolidation-workbench';
import { ASSET_REPORT_CAPABILITY, assetHistoryCsv, getAssetHistorySheet, type AssetHistoryRow } from './asset-history';
import { GRIR_RECLASS_CAPABILITY, getGrIrRun, grIrCsv } from './grir-reclass';
import { csvToReport } from '../output/csv-report';
import { getCustomerAgeing, CUSTOMER_AGEING_CAPABILITY } from './customer-ageing';

const L: ReportColumn = { label: '' };
const R = (label: string): ReportColumn => ({ label, align: 'right' });
const C = (label: string): ReportColumn => ({ ...L, label });

async function statementSelection(client: string, q: URLSearchParams): Promise<TrialBalanceSelection> {
  const versions = await listStatementVersions(client);
  return {
    companyCode: need(q, 'companyCode'),
    statementVersion: q.get('statementVersion') || versions[0]?.version || '',
    fiscalYear: Number(q.get('fiscalYear') ?? new Date().getFullYear()),
    periodFrom: Number(q.get('periodFrom') ?? 1),
    periodTo: Number(q.get('periodTo') ?? 12),
    includeSpecialPeriods: q.get('includeSpecialPeriods') === 'true',
    comparisonFiscalYear: num(q, 'comparisonFiscalYear'),
    comparisonPeriodFrom: num(q, 'comparisonPeriodFrom'),
    comparisonPeriodTo: num(q, 'comparisonPeriodTo'),
    outputCurrency: q.get('outputCurrency')?.toUpperCase() || undefined,
    ledger: '0L',
  } as TrialBalanceSelection;
}

const indent = (depth: number, text: string) => `${'   '.repeat(depth)}${text}`;

export const trialBalanceExport: ReportAdapter = {
  code: 'trial-balance', route: '/finance/trial-balance', capability: TRIAL_BALANCE_CAPABILITY,
  async build(client, q, authorization) {
    const r = await calculateTrialBalance({ client, selection: await statementSelection(client, q), authorization });
    const comp = r.comparisonFiscalYear !== null;
    const columns = [C('Node / account'), C('Description'), R('Debit'), R('Credit'), R('Balance'), ...(comp ? [R(`Balance ${r.comparisonFiscalYear}`), R('Variance'), R('Var %')] : [])];
    const rows: string[][] = [];
    for (const n of r.nodes) {
      rows.push([indent(n.depth, n.node), n.description, fmt(n.debitTurnover), fmt(n.creditTurnover), fmt(n.balance),
        ...(comp ? [fmt(n.comparativeBalance), fmt(n.variance), fmt(n.variancePercent)] : [])]);
      for (const a of n.accounts) {
        rows.push([indent(n.depth + 1, a.accountNumber), a.accountName, fmt(a.debitTurnover), fmt(a.creditTurnover), fmt(a.balance),
          ...(comp ? [fmt(a.comparativeBalance), '', ''] : [])]);
      }
    }
    for (const a of r.unassigned) {
      rows.push([`Unassigned ${a.accountNumber}`, a.accountName, fmt(a.debitTurnover), fmt(a.creditTurnover), fmt(a.balance), ...(comp ? [fmt(a.comparativeBalance), '', ''] : [])]);
    }
    const totals = ['Total', '', fmt(r.totalDebitTurnover), fmt(r.totalCreditTurnover), '', ...(comp ? ['', '', ''] : [])];
    return {
      title: 'Trial balance',
      subtitle: [`Company ${r.companyCode} · chart ${r.chartOfAccounts} · version ${r.statementVersion}`,
        `Fiscal year ${r.fiscalYear}, periods ${r.periodFrom}-${r.periodTo} · currency ${r.currency}`, ...r.warnings],
      sections: [{ columns, rows, totals }],
      fileStem: `trial-balance-${r.companyCode}-${r.fiscalYear}-${r.periodFrom}-${r.periodTo}`,
    } satisfies ReportDoc;
  },
};

export const balanceSheetExport: ReportAdapter = {
  code: 'balance-sheet', route: '/finance/balance-sheet', capability: BALANCE_SHEET_CAPABILITY,
  async build(client, q, authorization) {
    const base = await statementSelection(client, q);
    const selection: BalanceSheetSelection = {
      ...base, calculationType: (q.get('calculationType') as BalanceSheetSelection['calculationType']) || 'COMBINED',
      summaryLevel: Number(q.get('summaryLevel') ?? DEFAULT_SUMMARY_LEVEL),
    };
    const r = await calculateBalanceSheet({ client, selection, authorization });
    const comp = r.comparisonFiscalYear !== null;
    const columns = [C('Node / account'), C('Description'), R('Opening'), R('Movement'), R('Closing'), ...(comp ? [R(`Closing ${r.comparisonFiscalYear}`), R('Variance')] : [])];
    const rows: string[][] = [];
    for (const n of r.nodes) {
      rows.push([indent(n.depth, n.node), n.description, fmt(n.openingBalance), fmt(n.balance - n.openingBalance), fmt(n.balance), ...(comp ? [fmt(n.comparativeBalance), fmt(n.variance)] : [])]);
      for (const a of n.accounts) {
        rows.push([indent(n.depth + 1, a.accountNumber), a.accountName, fmt(a.openingBalance), fmt(a.balance - a.openingBalance), fmt(a.balance), ...(comp ? [fmt(a.comparativeBalance), ''] : [])]);
      }
    }
    const totals = r.currentYearResult === null ? undefined : ['Current-year result', '', '', '', fmt(r.currentYearResult), ...(comp ? ['', ''] : [])];
    return {
      title: 'Balance sheet',
      subtitle: [`Company ${r.companyCode} · chart ${r.chartOfAccounts} · version ${r.statementVersion}`,
        `Fiscal year ${r.fiscalYear}, periods ${r.periodFrom}-${r.periodTo} · currency ${r.currency}`, ...r.warnings],
      sections: [{ columns, rows, totals }],
      fileStem: `balance-sheet-${r.companyCode}-${r.fiscalYear}-${r.periodTo}`,
    };
  },
};

export const profitLossExport: ReportAdapter = {
  code: 'profit-loss', route: '/finance/profit-loss', capability: PROFIT_LOSS_CAPABILITY,
  async build(client, q, authorization) {
    const base = await statementSelection(client, q);
    const selection: BalanceSheetSelection = { ...base, calculationType: 'COMBINED', summaryLevel: Number(q.get('summaryLevel') ?? DEFAULT_SUMMARY_LEVEL) };
    const r = await calculateProfitLoss({ client, selection, authorization });
    const comp = r.comparisonFiscalYear !== null;
    const columns = [C('Node / account'), C('Description'), R('Period movement'), R('Year to date'), ...(comp ? [R(`Movement ${r.comparisonFiscalYear}`), R('Variance'), R('Var %')] : [])];
    const rows: string[][] = [];
    for (const n of r.nodes) {
      rows.push([indent(n.depth, n.node), n.description, fmt(n.periodMovement), fmt(n.yearToDateMovement), ...(comp ? [fmt(n.comparativeMovement), fmt(n.variance), fmt(n.variancePercent)] : [])]);
      for (const a of n.accounts) {
        rows.push([indent(n.depth + 1, a.accountNumber), a.accountName, fmt(a.periodMovement), fmt(a.yearToDateMovement), ...(comp ? [fmt(a.comparativeMovement), '', ''] : [])]);
      }
    }
    const totals = r.currentYearResult === null ? undefined : ['Result', '', '', fmt(r.currentYearResult), ...(comp ? ['', '', ''] : [])];
    return {
      title: 'Profit and loss statement',
      subtitle: [`Company ${r.companyCode} · chart ${r.chartOfAccounts} · version ${r.statementVersion}`,
        `Fiscal year ${r.fiscalYear}, periods ${r.periodFrom}-${r.periodTo} · currency ${r.currency}`, ...r.warnings],
      sections: [{ columns, rows, totals }],
      fileStem: `profit-loss-${r.companyCode}-${r.fiscalYear}-${r.periodTo}`,
    };
  },
};

function balanceSections(view: { periods: Array<{ period: number; special: boolean; opening: number; debitTurnover: number; creditTurnover: number; closing: number; itemCount: number }>; yearDebit: number; yearCredit: number; yearClosing: number; items: Array<{ documentNumber: string; fiscalYear: number; lineNumber: number; postingDate: string; documentType: string; debitCredit: string; documentAmount: string; documentCurrency: string; localAmount: string; clearingDocument: string | null; clearingDate: string | null }>; selectedPeriod: number | null }, currency: string): ReportSection[] {
  const sections: ReportSection[] = [{
    heading: `Balances by period (${currency})`,
    columns: [C('Period'), R('Opening'), R('Debit'), R('Credit'), R('Closing'), R('Items')],
    rows: view.periods.map((p) => [`${p.period}${p.special ? ' (special)' : ''}`, fmt(p.opening), fmt(p.debitTurnover), fmt(p.creditTurnover), fmt(p.closing), String(p.itemCount)]),
    totals: ['Year', '', fmt(view.yearDebit), fmt(view.yearCredit), fmt(view.yearClosing), ''],
  }];
  if (view.items.length > 0) {
    sections.push({
      heading: view.selectedPeriod === null ? 'Line items' : `Line items, period ${view.selectedPeriod}`,
      columns: [C('Document'), C('Year'), R('Line'), C('Posted'), C('Type'), C('D/C'), R('Amount'), C('Cur'), R('Local'), C('Cleared by'), C('Cleared')],
      rows: view.items.map((i) => [i.documentNumber, String(i.fiscalYear), String(i.lineNumber), i.postingDate, i.documentType, i.debitCredit, fmt(i.documentAmount), i.documentCurrency, fmt(i.localAmount), i.clearingDocument ?? '', i.clearingDate ?? '']),
    });
  }
  return sections;
}

function balanceQuery(q: URLSearchParams) {
  return {
    companyCode: need(q, 'companyCode'),
    fiscalYear: Number(q.get('fiscalYear') ?? new Date().getFullYear()),
    displayCurrency: q.get('displayCurrency') || undefined,
    periodFrom: num(q, 'periodFrom'),
    periodTo: num(q, 'periodTo'),
    specialPeriods: q.get('specialPeriods') === 'on',
    selectedPeriod: num(q, 'period'),
  };
}

export const vendorBalancesExport: ReportAdapter = {
  code: 'vendor-balances', route: '/finance/vendor-balances', capability: VENDOR_BALANCE_CAPABILITY,
  async build(client, q, authorization) {
    const supplier = need(q, 'supplier').toUpperCase();
    const view = await getVendorBalances(client, { supplier, authorization, ...balanceQuery(q) });
    return {
      title: 'Vendor balances',
      subtitle: [`Supplier ${view.supplier} · company ${view.companyCode} · fiscal year ${view.fiscalYear}`],
      sections: balanceSections(view, view.currency),
      fileStem: `vendor-balances-${view.supplier}-${view.companyCode}-${view.fiscalYear}`,
    };
  },
};

export const customerBalancesExport: ReportAdapter = {
  code: 'customer-balances', route: '/finance/customer-balances', capability: CUSTOMER_BALANCE_CAPABILITY,
  async build(client, q, authorization) {
    const customer = need(q, 'customer').toUpperCase();
    const view = await getCustomerBalances(client, { customer, authorization, ...balanceQuery(q) });
    return {
      title: 'Customer balances',
      subtitle: [`Customer ${view.customer} · company ${view.companyCode} · fiscal year ${view.fiscalYear}`],
      sections: balanceSections(view, view.currency),
      fileStem: `customer-balances-${view.customer}-${view.companyCode}-${view.fiscalYear}`,
    };
  },
};

export const vendorAgeingExport: ReportAdapter = {
  code: 'vendor-ageing', route: '/finance/vendor-ageing', capability: VENDOR_AGEING_CAPABILITY,
  async build(client, q, authorization) {
    const companyCode = (q.get('companyCode') ?? q.get('companyFrom') ?? '').toUpperCase() || need(q, 'companyCode');
    const keyDate = q.get('keyDate') || new Date().toISOString().slice(0, 10);
    const view = await getVendorAgeing(client, { authorization,
      companyCode, keyDate,
      supplierFrom: q.get('supplierFrom')?.toUpperCase() || undefined,
      supplierTo: q.get('supplierTo')?.toUpperCase() || undefined,
      thresholds: [Number(q.get('bucket1') ?? 30), Number(q.get('bucket2') ?? 60), Number(q.get('bucket3') ?? 90)],
      includeSpecialGl: q.get('includeSpecialGl') === 'on',
    });
    const [a, b, c] = view.thresholds;
    const labels = ['Not yet due', `1-${a} days`, `${a + 1}-${b} days`, `${b + 1}-${c} days`, `Over ${c} days`];
    return {
      title: 'Vendor ageing',
      subtitle: [`Company ${view.companyCode} · key date ${view.keyDate} · currency ${view.currency}`],
      sections: [
        {
          heading: 'By supplier',
          columns: [C('Supplier'), C('Name'), R('Items'), ...labels.map(R), R('Total')],
          rows: view.suppliers.map((s) => [s.supplier, s.supplierName, String(s.itemCount), ...s.buckets.map((x) => fmt(x)), fmt(s.total)]),
          totals: ['Total', '', '', ...view.totals.map((x) => fmt(x)), fmt(view.grandTotal)],
        },
        {
          heading: 'Open items',
          columns: [C('Supplier'), C('Document'), C('Year'), R('Line'), C('Type'), C('Posted'), C('Due'), R('Days over'), C('Bucket'), R('Original'), R('Remaining'), C('Cur')],
          rows: view.items.map((i) => [i.supplier, i.documentNumber, String(i.fiscalYear), String(i.lineNumber), i.documentType, i.postingDate, i.dueDate, String(i.daysOverdue), labels[i.bucket], fmt(i.documentAmount), fmt(i.signed), i.currency]),
        },
      ],
      fileStem: `vendor-ageing-${view.companyCode}-${view.keyDate}`,
    };
  },
};

export const customerAgeingExport: ReportAdapter = {
  code: 'customer-ageing', route: '/finance/customer-ageing', capability: CUSTOMER_AGEING_CAPABILITY,
  async build(client, q, authorization) {
    const companyCode = need(q, 'companyCode');
    const keyDate = q.get('keyDate') || new Date().toISOString().slice(0, 10);
    const view = await getCustomerAgeing(client, { authorization,
      companyCode, keyDate,
      customerFrom: q.get('customerFrom')?.toUpperCase() || undefined,
      customerTo: q.get('customerTo')?.toUpperCase() || undefined,
      thresholds: [Number(q.get('bucket1') ?? 30), Number(q.get('bucket2') ?? 60), Number(q.get('bucket3') ?? 90)],
    });
    const [a, b, c] = view.thresholds;
    const labels = ['Not yet due', `1-${a} days`, `${a + 1}-${b} days`, `${b + 1}-${c} days`, `Over ${c} days`];
    return {
      title: 'Customer ageing',
      subtitle: [`Company ${view.companyCode} · key date ${view.keyDate} · currency ${view.currency}`],
      sections: [
        {
          heading: 'By customer',
          columns: [C('Customer'), C('Name'), R('Items'), ...labels.map(R), R('Total')],
          rows: view.customers.map((s) => [s.customer, s.customerName, String(s.itemCount), ...s.buckets.map((x) => fmt(x)), fmt(s.total)]),
          totals: ['Total', '', '', ...view.totals.map((x) => fmt(x)), fmt(view.grandTotal)],
        },
        {
          heading: 'Open items',
          columns: [C('Customer'), C('Document'), C('Year'), R('Line'), C('Type'), C('Posted'), C('Due'), R('Days over'), C('Bucket'), R('Original'), R('Remaining'), C('Cur')],
          rows: view.items.map((i) => [i.customer, i.documentNumber, String(i.fiscalYear), String(i.lineNumber), i.documentType, i.postingDate, i.dueDate, String(i.daysOverdue), labels[i.bucket], fmt(i.documentAmount), fmt(i.signed), i.currency]),
        },
      ],
      fileStem: `customer-ageing-${view.companyCode}-${view.keyDate}`,
    };
  },
};

export const journalItemsExport: ReportAdapter = {
  code: 'gl-line-items', route: '/finance/journal/items', capability: JOURNAL_ITEMS_CAPABILITY,
  async build(client, q, authorization) {
    const result = await getJournalItems(client, { authorization,
      accountFrom: need(q, 'accountFrom'),
      accountTo: q.get('accountTo') || undefined,
      companyCodes: (q.get('companyCodes') ?? '').split(',').map((c) => c.trim()).filter(Boolean),
      fiscalYear: num(q, 'fiscalYear'),
      postingPeriod: num(q, 'postingPeriod'),
      postingDateFrom: q.get('postingDateFrom') || undefined,
      postingDateTo: q.get('postingDateTo') || undefined,
      documentNumber: q.get('documentNumber') || undefined,
      documentType: q.get('documentType') || undefined,
      status: q.get('status') === 'OPEN' || q.get('status') === 'CLEARED' ? (q.get('status') as 'OPEN' | 'CLEARED') : 'ALL',
      profitCenter: q.get('profitCenter') || undefined,
      costCenter: q.get('costCenter') || undefined,
      reference: q.get('reference') || undefined,
      maxHits: num(q, 'maxHits'),
      page: 1,
      pageSize: JOURNAL_ITEMS_CAP,
    });
    return {
      title: 'G/L line items',
      subtitle: [`Accounts ${q.get('accountFrom')}${q.get('accountTo') ? `-${q.get('accountTo')}` : ''}`, `${result.rows.length} of ${result.total} item(s)${result.truncated ? ` (truncated at ${result.cap})` : ''}`],
      sections: [
        {
          columns: [C('Company'), C('Account'), C('Document'), C('Year'), R('Line'), C('Posted'), C('Type'), C('D/C'), R('Amount'), C('Cur'), R('Local'), C('Cost ctr'), C('Profit ctr'), C('Tax'), C('Partner'), C('Reference'), C('Text'), C('Status')],
          rows: result.rows.map((i) => [i.companyCode, i.glAccount, i.documentNumber, String(i.fiscalYear), String(i.lineNumber), i.postingDate, i.documentType, i.debitCredit, fmt(i.amountDocument), i.currency, fmt(i.amountLocal), i.costCenter ?? '', i.profitCenter ?? '', i.taxCode ?? '', i.businessPartner ?? '', i.reference ?? '', i.lineText ?? '', i.itemStatus ?? '']),
        },
        {
          heading: 'Subtotals by account',
          columns: [C('Company'), C('Account'), C('Cur'), R('Debit'), R('Credit'), C('Local cur'), R('Debit local'), R('Credit local')],
          rows: result.subtotals.map((s) => [s.companyCode, s.glAccount, s.currency, fmt(s.debitDocument), fmt(s.creditDocument), s.localCurrency, fmt(s.debitLocal), fmt(s.creditLocal)]),
        },
      ],
      fileStem: `gl-line-items-${q.get('accountFrom')}`,
    };
  },
};

export const glBalancesExport: ReportAdapter = {
  code: 'gl-balances', route: '/finance/journal/balances', capability: GL_BALANCE_CAPABILITY,
  async build(client, q, authorization) {
    const view = await getGlBalanceReport(client, { authorization,
      companyCodes: (q.get('reportCompanies') ?? '').split(',').map((c) => c.trim()).filter(Boolean),
      outputCurrency: q.get('outputCurrency')?.toUpperCase() || undefined,
      accountFrom: q.get('accountFrom') ?? '',
      accountTo: q.get('accountTo') ?? '',
      fiscalYear: Number(q.get('reportFiscalYear') ?? new Date().getFullYear()),
      periodFrom: Number(q.get('periodFrom') ?? 1),
      periodTo: Number(q.get('periodTo') ?? 12),
      includeSpecialPeriods: q.get('reportSpecialPeriods') === '1',
      ledger: '0L',
    });
    return {
      title: 'G/L account balances',
      subtitle: [`Ledger ${view.ledger} · fiscal year ${view.fiscalYear}, periods ${view.periodFrom}-${view.periodTo}`, ...view.warnings],
      sections: [
        {
          columns: [C('Company'), C('Account'), C('Name'), C('Group'), C('Cur'), R('Opening'), R('Debit'), R('Credit'), R('Net change'), R('Closing')],
          rows: view.rows.map((r) => [r.companyCode, r.glAccount, r.accountName, r.accountGroup, r.currency, fmt(r.openingBalance), fmt(r.debitTurnover), fmt(r.creditTurnover), fmt(r.netChange), fmt(r.closingBalance)]),
        },
        {
          heading: 'Subtotals by account group',
          columns: [C('Company'), C('Group'), C('Cur'), R('Accounts'), R('Debit'), R('Credit'), R('Net change'), R('Closing')],
          rows: view.subtotals.map((s) => [s.companyCode, s.accountGroup, s.currency, String(s.accountCount), fmt(s.debitTurnover), fmt(s.creditTurnover), fmt(s.netChange), fmt(s.closingBalance)]),
        },
      ],
      fileStem: `gl-balances-${view.fiscalYear}-${view.periodFrom}-${view.periodTo}`,
    };
  },
};

export const cashFlowExport: ReportAdapter = {
  code: 'cash-flow', route: '/finance/cash-flow', capability: CASHFLOW_CAPABILITY,
  async build(client, q, authorization) {
    const companyCodes = (q.get('companies') ?? '').split(',').map((c) => c.trim().toUpperCase()).filter(Boolean);
    if (companyCodes.length === 0) throw new ReportExportError('Company codes are required for this export.', 'Run the report on screen first; the export uses the same selection.');
    const selection: CashflowSelection = {
      companyCodes,
      fiscalYear: Number(q.get('fiscalYear')) || new Date().getFullYear(),
      periodFrom: Number(q.get('periodFrom')) || 1,
      periodTo: Number(q.get('periodTo')) || 12,
      method: (q.get('method') ?? '').toUpperCase() === 'DIRECT' ? 'DIRECT' : 'INDIRECT',
      ledger: CASHFLOW_LEDGER,
      comparative: q.get('comparative') === '1',
    };
    const r = await calculateCashflow({ client, selection, authorization });
    const total = r.totalsComparable && r.companies.length > 1;
    const columns = [C('Line'), ...r.companies.map((c) => R(`${c.companyCode} (${c.currency})`)), ...(total ? [R('Total')] : []), ...(selection.comparative ? [R('Previous year')] : [])];
    const width = columns.length;
    const pad = (cells: string[]) => [...cells, ...Array(Math.max(0, width - cells.length)).fill('')];
    const rows: string[][] = [];
    for (const section of r.sections) {
      rows.push(pad([section.title.toUpperCase()]));
      for (const line of section.lines) {
        rows.push([
          line.kind === 'DETAIL' ? `   ${line.label}` : line.label,
          ...r.companies.map((c) => fmt(line.amountsByCompany[c.companyCode])),
          ...(total ? [fmt(line.total)] : []),
          ...(selection.comparative ? [fmt(line.comparativeTotal)] : []),
        ]);
      }
    }
    const sections: ReportSection[] = [{ columns, rows }];
    sections.push({
      heading: 'Cash reconciliation',
      columns: [C('Item'), R('Amount')],
      rows: [['Opening cash', fmt(r.openingCash)], ['Net change', fmt(r.netCashChange)], ['Closing cash', fmt(r.closingCash)], ['Reconciliation difference', fmt(r.reconciliationDifference)]],
    });
    if (r.unclassified.length > 0) {
      sections.push({
        heading: 'Unclassified accounts',
        columns: [C('Company'), C('Account'), R('Amount'), R('Lines')],
        rows: r.unclassified.map((u) => [u.companyCode, u.account, fmt(u.amount), String(u.lines)]),
      });
    }
    return {
      title: 'Cash flow statement',
      subtitle: [`${CASHFLOW_METHOD_LABELS[selection.method]} · companies ${companyCodes.join(', ')}`, `Fiscal year ${selection.fiscalYear}, periods ${selection.periodFrom}-${selection.periodTo} · ledger ${selection.ledger}`, ...r.warnings],
      sections,
      fileStem: `cash-flow-${companyCodes.join('-')}-${selection.fiscalYear}-${selection.periodTo}`,
    };
  },
};

export const consolidatedStatementsExport: ReportAdapter = {
  code: 'consolidated-statements', route: '/finance/consolidated-statements', capability: CONSOLIDATED_STATEMENTS_CAPABILITY,
  async build(client, q, authorization) {
    const get = (name: string) => (q.get(name) ?? '').trim();
    const areas = await listConsolidationAreas(client, authorization);
    const area = get('area').toUpperCase() || areas.find((a) => a.status === 'ACTIVE')?.area || areas[0]?.area || '';
    const workbench = area ? await getConsolidationWorkbench(client, area, authorization) : null;
    const selection: ConsolidatedStatementsSelection = {
      area,
      group: get('group').toUpperCase() || workbench?.groups[0]?.group || '',
      version: get('version').toUpperCase() || workbench?.versions[0]?.version || '',
      fiscalYear: Number(get('fiscalYear')) || new Date().getFullYear(),
      period: Number(get('period')) || 12,
      view: get('view').toUpperCase() === 'INCOME_STATEMENT' ? 'INCOME_STATEMENT' : 'BALANCE_SHEET',
      unit: get('unit').toUpperCase(),
      comparative: get('comparative') === '1',
    };
    if (!selection.area || !selection.group || !selection.version) {
      throw new ReportExportError('A consolidation area, group and version are required.', 'Run the report on screen first; the export uses the same selection.');
    }
    const r = await calculateConsolidatedStatements({ client, selection, authorization });
    const columns = [C('FS item'), C('Title'), C('Section'), ...r.units.map((u) => R(u.unit)), R('Group total'), R('Period movement'), ...(selection.comparative ? [R('Previous year')] : [])];
    const width = columns.length;
    const rows: string[][] = [];
    for (const section of STATEMENT_SECTIONS) {
      const own = r.rows.filter((x) => x.section === section);
      if (own.length === 0) continue;
      for (const x of own) {
        rows.push([x.groupAccount, x.title, SECTION_LABELS[section], ...r.units.map((u) => fmt(x.unitAmounts[u.unit])), fmt(x.groupTotal), fmt(x.periodMovement), ...(selection.comparative ? [fmt(x.comparativeTotal)] : [])]);
      }
      const total = r.sectionTotals.find((t) => t.section === section);
      const line = Array(width).fill('') as string[];
      line[0] = `Total ${SECTION_LABELS[section]}`;
      line[3 + r.units.length] = fmt(total?.total);
      rows.push(line);
    }
    return {
      title: selection.view === 'INCOME_STATEMENT' ? 'Consolidated income statement' : 'Consolidated balance sheet',
      subtitle: [
        `Area ${selection.area} (${r.areaTitle}) · group ${selection.group} · version ${selection.version}`,
        `Chart ${r.consChart} · fiscal year ${selection.fiscalYear} · ${r.periodLabel}`,
        `Balance check ${fmt(r.balanceCheck)} · unmapped journal lines ${r.unmapped.lines} (${fmt(r.unmapped.amount)})`,
        ...r.warnings,
      ],
      sections: [{ columns, rows }],
      fileStem: `consolidated-${selection.view === 'INCOME_STATEMENT' ? 'income' : 'balance'}-${selection.group}-${selection.fiscalYear}-${selection.period}`,
    };
  },
};

export const assetHistoryExport: ReportAdapter = {
  code: 'asset-history', route: '/finance/assets/history', capability: ASSET_REPORT_CAPABILITY,
  async build(client, q, authorization) {
    const get = (name: string) => q.get(name)?.trim() || undefined;
    const base = {
      companyCodeFrom: get('companyCodeFrom') ?? '', companyCodeTo: get('companyCodeTo'),
      assetClassFrom: get('assetClassFrom'), assetClassTo: get('assetClassTo'),
      assetNumberFrom: get('assetNumberFrom'), assetNumberTo: get('assetNumberTo'),
      fiscalYear: Number(get('fiscalYear')), depreciationArea: get('depreciationArea') ?? '01',
      reportingDate: get('reportingDate'), pageSize: 500,
    };
    const rows: AssetHistoryRow[] = [];
    for (let page = 1; ; page += 1) {
      const sheet = await getAssetHistorySheet(client, { ...base, page, authorization });
      rows.push(...sheet.rows);
      if (rows.length >= sheet.totalRows || sheet.rows.length === 0 || rows.length > 50_000) break;
    }
    return csvToReport(assetHistoryCsv(rows), {
      title: 'Asset history sheet',
      subtitle: [`Company ${base.companyCodeFrom}${base.companyCodeTo ? `-${base.companyCodeTo}` : ''} · fiscal year ${base.fiscalYear} · depreciation area ${base.depreciationArea}${base.reportingDate ? ` · reporting date ${base.reportingDate}` : ''}`],
      fileStem: `asset-history-${base.fiscalYear}`,
    });
  },
};

export const grIrExport: ReportAdapter = {
  code: 'grir-analysis', route: '/finance/grir-reclass', capability: GRIR_RECLASS_CAPABILITY,
  async build(client, q, authorization) {
    const runId = (q.get('run') ?? '').trim();
    const run = runId ? await getGrIrRun(client, runId, authorization) : null;
    if (!run) throw new ReportExportError('GR/IR run not found.', 'Open a protocol on screen first; the export uses the same run.');
    return csvToReport(grIrCsv(run), { title: 'GR/IR analysis', subtitle: [`Run ${runId}`], fileStem: `grir-analysis-${runId}` });
  },
};

export const FINANCE_REPORT_EXPORTS: ReportAdapter[] = [
  cashFlowExport, consolidatedStatementsExport, assetHistoryExport, grIrExport,
  trialBalanceExport, balanceSheetExport, profitLossExport, vendorBalancesExport, customerBalancesExport,
  vendorAgeingExport, customerAgeingExport, journalItemsExport, glBalancesExport,
];
