/**
 * Asset history sheet — SCR-095 / R-143
 * (S_ALR_87011990 as a search alias only).
 *
 * A read-only aggregation over the canonical value records:
 * ACTIVE acquisitions and retirements by asset value date, and
 * posted depreciation per asset, area and period. Beginning
 * balances are the movements before the fiscal year, current-year
 * movements run to the reporting date, and REVERSED records never
 * count. No balance table stands behind this sheet and running it
 * writes nothing.
 *
 * Stage 1 carries the vocabulary only; the service lands in
 * stage 3 of R-143.
 */
export const ASSET_REPORT_CAPABILITY = 'FIN.ASSET.REPORT';

export class AssetHistoryError extends Error {
  remedy?: string;

  constructor(message: string, remedy?: string) {
    super(message);
    this.name = 'AssetHistoryError';
    this.remedy = remedy;
  }
}

export interface AssetHistorySelection {
  companyCodeFrom: string;
  companyCodeTo?: string;
  assetClassFrom?: string;
  assetClassTo?: string;
  assetNumberFrom?: string;
  assetNumberTo?: string;
  subNumberFrom?: string;
  subNumberTo?: string;
  fiscalYear: number;
  depreciationArea: string;
  reportingDate?: string;
  sortVersion?: string;
  layout?: string;
  page?: number;
  pageSize?: number;
}

export interface AssetHistoryRow {
  companyCode: string;
  assetClass: string;
  assetNumber: string;
  subNumber: string;
  description: string;
  status: string;
  capitalizationDate: string | null;
  currency: string;
  acquisitionBeginning: number;
  acquisitions: number;
  transfersIn: number;
  transfersOut: number;
  retirements: number;
  otherMovements: number;
  acquisitionEnding: number;
  depreciationBeginning: number;
  depreciationYear: number;
  depreciationOnRetirements: number;
  depreciationAdjustments: number;
  depreciationEnding: number;
  netBookValue: number;
}

export interface AssetHistoryTotals {
  assetClass: string | null;
  currency: string;
  acquisitionBeginning: number;
  acquisitions: number;
  retirements: number;
  acquisitionEnding: number;
  depreciationBeginning: number;
  depreciationYear: number;
  depreciationOnRetirements: number;
  depreciationEnding: number;
  netBookValue: number;
}

export interface AssetHistorySheet {
  fiscalYear: number;
  depreciationArea: string;
  reportingDate: string;
  rows: AssetHistoryRow[];
  classTotals: AssetHistoryTotals[];
  grandTotals: AssetHistoryTotals[];
  totalRows: number;
  page: number;
  pageSize: number;
  warnings: string[];
}

import { and, asc, eq, inArray } from 'drizzle-orm';

import { type Tx, withTenant } from '../../platform/db/client';
import { getVariant, periodWindows } from '../../platform/periods';
import { fiscalYearPeriod } from '../foundation/schema';
import { companyCode as companyCodeTable } from '../foundation/schema';
import {
  assetDepreciation, assetDepreciationPosting, assetRetirement, assetTransaction,
  depreciationArea, fixedAsset,
} from './schema';

const round2 = (n: number) => Math.round(n * 100) / 100;

interface CompanyWindow {
  companyCode: string;
  currency: string;
  yearStart: string;
  yearEnd: string;
  periodEnds: Map<number, string>;
}

async function companyWindow(
  tx: Tx, client: string, company: { companyCode: string; currency: string; fiscalYearVariant: string | null },
  fiscalYear: number,
): Promise<CompanyWindow> {
  if (!company.fiscalYearVariant) {
    throw new AssetHistoryError(`Company code ${company.companyCode} is not configured in this tenant.`);
  }
  const variant = await getVariant(tx, client, company.fiscalYearVariant);
  const loadPeriods = async (calendarYear: number) => {
    const rows = await tx.select().from(fiscalYearPeriod).where(and(
      eq(fiscalYearPeriod.client, client),
      eq(fiscalYearPeriod.variant, company.fiscalYearVariant!),
      eq(fiscalYearPeriod.calendarYear, calendarYear),
    ));
    return rows.filter((r) => r.periodType === 'REGULAR').sort((a, b) => a.period - b.period);
  };
  let periodRows = await loadPeriods(0);
  if (variant.isYearDependent) {
    const forYear = await loadPeriods(fiscalYear);
    if (forYear.length > 0) periodRows = forYear;
  }
  const windows = periodWindows(periodRows, fiscalYear);
  if (windows.length === 0) {
    throw new AssetHistoryError(`Fiscal year ${fiscalYear} stands undefined for company ${company.companyCode}.`);
  }
  const iso = (ms: number) => new Date(ms).toISOString().slice(0, 10);
  return {
    companyCode: company.companyCode,
    currency: company.currency.toUpperCase(),
    yearStart: iso(Math.min(...windows.map((w) => w.start))),
    yearEnd: iso(Math.max(...windows.map((w) => w.end))),
    periodEnds: new Map(windows.map((w) => [w.period, iso(w.end)])),
  };
}

const inRange = (value: string, from?: string, to?: string) =>
  (!from || value >= from) && (!to || value <= to);

export async function getAssetHistorySheet(
  client: string, selection: AssetHistorySelection,
): Promise<AssetHistorySheet> {
  return withTenant(client, async (tx) => {
    const companies = (await tx.select().from(companyCodeTable).where(
      eq(companyCodeTable.client, client),
    )).filter((c) => inRange(c.companyCode, selection.companyCodeFrom, selection.companyCodeTo));
    if (companies.length === 0) {
      throw new AssetHistoryError(
        `No company code stands between ${selection.companyCodeFrom} and ${selection.companyCodeTo ?? selection.companyCodeFrom} in this tenant.`,
      );
    }
    const [area] = await tx.select().from(depreciationArea).where(and(
      eq(depreciationArea.client, client), eq(depreciationArea.areaCode, selection.depreciationArea),
    ));
    if (!area || !area.isActive) {
      throw new AssetHistoryError(`Depreciation area ${selection.depreciationArea} is not configured active in this tenant.`);
    }
    const windows = new Map<string, CompanyWindow>();
    for (const company of companies) {
      const w = await companyWindow(tx, client, company, selection.fiscalYear);
      if (selection.reportingDate && (selection.reportingDate < w.yearStart || selection.reportingDate > w.yearEnd)) {
        throw new AssetHistoryError(
          `Reporting date ${selection.reportingDate} lies outside fiscal year ${selection.fiscalYear} for company ${company.companyCode} (${w.yearStart} to ${w.yearEnd}).`,
          'Report within the selected fiscal year, whose end is the default cutoff.',
        );
      }
      windows.set(company.companyCode, w);
    }
    const reportingDateOf = (company: string) =>
      selection.reportingDate ?? windows.get(company)!.yearEnd;

    const companyCodes = companies.map((c) => c.companyCode);
    const assets = (await tx.select().from(fixedAsset).where(and(
      eq(fixedAsset.client, client), inArray(fixedAsset.companyCode, companyCodes),
    )).orderBy(asc(fixedAsset.companyCode), asc(fixedAsset.assetClass), asc(fixedAsset.assetNumber), asc(fixedAsset.subNumber)))
      .filter((a) =>
        inRange(a.assetClass, selection.assetClassFrom, selection.assetClassTo)
        && inRange(a.assetNumber, selection.assetNumberFrom, selection.assetNumberTo)
        && inRange(a.subNumber, selection.subNumberFrom ?? '0000', selection.subNumberTo));

    const key = (c: string, a: string, s: string) => `${c}/${a}/${s}`;
    interface Bucket {
      acqBefore: number; acqYear: number; retBefore: number; retYear: number;
      deprOnRetYear: number; deprBefore: number; deprYear: number; currencies: Set<string>;
    }
    const buckets = new Map<string, Bucket>();
    const bucket = (k: string): Bucket => {
      let b = buckets.get(k);
      if (!b) {
        b = {
          acqBefore: 0, acqYear: 0, retBefore: 0, retYear: 0,
          deprOnRetYear: 0, deprBefore: 0, deprYear: 0, currencies: new Set(),
        };
        buckets.set(k, b);
      }
      return b;
    };

    const acqRows = await tx.select({
      companyCode: assetTransaction.companyCode, assetNumber: assetTransaction.assetNumber,
      subNumber: assetTransaction.subNumber, amount: assetTransaction.amount,
      currency: assetTransaction.currency, assetValueDate: assetTransaction.assetValueDate,
    }).from(assetTransaction).where(and(
      eq(assetTransaction.client, client), inArray(assetTransaction.companyCode, companyCodes),
      eq(assetTransaction.status, 'ACTIVE'),
    ));
    for (const r of acqRows) {
      const w = windows.get(r.companyCode)!;
      const b = bucket(key(r.companyCode, r.assetNumber, r.subNumber));
      b.currencies.add(r.currency.toUpperCase());
      if (r.assetValueDate < w.yearStart) b.acqBefore += Number(r.amount);
      else if (r.assetValueDate <= reportingDateOf(r.companyCode)) b.acqYear += Number(r.amount);
    }
    const retRows = await tx.select({
      companyCode: assetRetirement.companyCode, assetNumber: assetRetirement.assetNumber,
      subNumber: assetRetirement.subNumber, value: assetRetirement.retiredAcquisitionValue,
      depr: assetRetirement.accumDepreciationReversed, assetValueDate: assetRetirement.assetValueDate,
    }).from(assetRetirement).where(and(
      eq(assetRetirement.client, client), inArray(assetRetirement.companyCode, companyCodes),
      eq(assetRetirement.status, 'ACTIVE'),
    ));
    for (const r of retRows) {
      const w = windows.get(r.companyCode)!;
      const b = bucket(key(r.companyCode, r.assetNumber, r.subNumber));
      if (r.assetValueDate < w.yearStart) b.retBefore += Number(r.value);
      else if (r.assetValueDate <= reportingDateOf(r.companyCode)) {
        b.retYear += Number(r.value);
        b.deprOnRetYear += Number(r.depr);
      }
    }
    const postingRows = await tx.select({
      companyCode: assetDepreciationPosting.companyCode, assetNumber: assetDepreciationPosting.assetNumber,
      subNumber: assetDepreciationPosting.subNumber, amount: assetDepreciationPosting.postedAmount,
      fiscalYear: assetDepreciationPosting.fiscalYear, postingPeriod: assetDepreciationPosting.postingPeriod,
    }).from(assetDepreciationPosting).where(and(
      eq(assetDepreciationPosting.client, client), inArray(assetDepreciationPosting.companyCode, companyCodes),
      eq(assetDepreciationPosting.areaCode, selection.depreciationArea),
    ));
    for (const r of postingRows) {
      const b = bucket(key(r.companyCode, r.assetNumber, r.subNumber));
      if (r.fiscalYear < selection.fiscalYear) b.deprBefore += Number(r.amount);
      else if (r.fiscalYear === selection.fiscalYear) {
        const end = windows.get(r.companyCode)!.periodEnds.get(r.postingPeriod);
        if (end && end <= reportingDateOf(r.companyCode)) b.deprYear += Number(r.amount);
      }
    }
    const areaRows = await tx.select({
      companyCode: assetDepreciation.companyCode, assetNumber: assetDepreciation.assetNumber,
      subNumber: assetDepreciation.subNumber,
    }).from(assetDepreciation).where(and(
      eq(assetDepreciation.client, client), inArray(assetDepreciation.companyCode, companyCodes),
      eq(assetDepreciation.areaCode, selection.depreciationArea),
    ));
    const withArea = new Set(areaRows.map((r) => key(r.companyCode, r.assetNumber, r.subNumber)));

    const allRows: AssetHistoryRow[] = assets.map((asset) => {
      const b = bucket(key(asset.companyCode, asset.assetNumber, asset.subNumber));
      const acquisitionBeginning = round2(b.acqBefore - b.retBefore);
      const acquisitions = round2(b.acqYear);
      const retirements = round2(b.retYear);
      const acquisitionEnding = round2(acquisitionBeginning + acquisitions - retirements);
      const depreciationBeginning = round2(b.deprBefore);
      const depreciationYear = round2(b.deprYear);
      const depreciationOnRetirements = round2(b.deprOnRetYear);
      const depreciationEnding = round2(depreciationBeginning + depreciationYear - depreciationOnRetirements);
      const currencies = [...b.currencies];
      return {
        companyCode: asset.companyCode, assetClass: asset.assetClass,
        assetNumber: asset.assetNumber, subNumber: asset.subNumber,
        description: asset.description1, status: asset.status,
        capitalizationDate: asset.capitalizationDate,
        currency: currencies.length === 1 ? currencies[0]! : (currencies.length === 0 ? windows.get(asset.companyCode)!.currency : ''),
        acquisitionBeginning, acquisitions,
        transfersIn: 0, transfersOut: 0, retirements, otherMovements: 0,
        acquisitionEnding,
        depreciationBeginning, depreciationYear, depreciationOnRetirements,
        depreciationAdjustments: 0, depreciationEnding,
        netBookValue: round2(acquisitionEnding - depreciationEnding),
      };
    });

    const sumInto = (map: Map<string, AssetHistoryTotals>, assetClass: string | null, row: AssetHistoryRow) => {
      const k = `${assetClass ?? ''}|${row.currency}`;
      let t = map.get(k);
      if (!t) {
        t = {
          assetClass, currency: row.currency,
          acquisitionBeginning: 0, acquisitions: 0, retirements: 0, acquisitionEnding: 0,
          depreciationBeginning: 0, depreciationYear: 0, depreciationOnRetirements: 0,
          depreciationEnding: 0, netBookValue: 0,
        };
        map.set(k, t);
      }
      t.acquisitionBeginning = round2(t.acquisitionBeginning + row.acquisitionBeginning);
      t.acquisitions = round2(t.acquisitions + row.acquisitions);
      t.retirements = round2(t.retirements + row.retirements);
      t.acquisitionEnding = round2(t.acquisitionEnding + row.acquisitionEnding);
      t.depreciationBeginning = round2(t.depreciationBeginning + row.depreciationBeginning);
      t.depreciationYear = round2(t.depreciationYear + row.depreciationYear);
      t.depreciationOnRetirements = round2(t.depreciationOnRetirements + row.depreciationOnRetirements);
      t.depreciationEnding = round2(t.depreciationEnding + row.depreciationEnding);
      t.netBookValue = round2(t.netBookValue + row.netBookValue);
    };
    const classMap = new Map<string, AssetHistoryTotals>();
    const grandMap = new Map<string, AssetHistoryTotals>();
    for (const row of allRows) {
      sumInto(classMap, row.assetClass, row);
      sumInto(grandMap, null, row);
    }

    const pageSize = Math.min(Math.max(selection.pageSize ?? 100, 1), 500);
    const page = Math.max(selection.page ?? 1, 1);
    const rows = allRows.slice((page - 1) * pageSize, page * pageSize);

    const warnings: string[] = [
      'Transfers and other movement classifications stand at zero: no transfer function posts yet, and the sheet invents none.',
      'Balances reconstruct from the standing value records (acquisitions and retirements from SCR-092/093, posted depreciation from SCR-094); earlier history is not reconstructed.',
    ];
    if (selection.sortVersion || selection.layout) {
      warnings.push('Sort versions and saved layouts are not yet configured; the delivered layout (class, asset, subnumber) applies.');
    }
    const withoutArea = allRows.filter((r) => !withArea.has(key(r.companyCode, r.assetNumber, r.subNumber))).length;
    if (withoutArea > 0) {
      warnings.push(`${withoutArea} asset(s) carry no parameters for area ${selection.depreciationArea}; their depreciation columns stand at zero.`);
    }
    if (grandMap.size > 1) {
      warnings.push('More than one currency stands in the selection; totals are stated per currency and never added together.');
    }

    return {
      fiscalYear: selection.fiscalYear,
      depreciationArea: selection.depreciationArea,
      reportingDate: selection.reportingDate ?? [...windows.values()][0]!.yearEnd,
      rows, classTotals: [...classMap.values()], grandTotals: [...grandMap.values()],
      totalRows: allRows.length, page, pageSize, warnings,
    };
  });
}

const CSV_COLUMNS: Array<[string, (r: AssetHistoryRow) => string | number | null]> = [
  ['Company Code', (r) => r.companyCode],
  ['Asset Class', (r) => r.assetClass],
  ['Asset Number', (r) => r.assetNumber],
  ['Asset Subnumber', (r) => r.subNumber],
  ['Asset Description', (r) => r.description],
  ['Capitalization Date', (r) => r.capitalizationDate],
  ['Acquisition Value - Beginning Balance', (r) => r.acquisitionBeginning],
  ['Acquisitions', (r) => r.acquisitions],
  ['Transfers In', (r) => r.transfersIn],
  ['Transfers Out', (r) => r.transfersOut],
  ['Retirements', (r) => r.retirements],
  ['Other Acquisition Value Movements', (r) => r.otherMovements],
  ['Acquisition Value - Ending Balance', (r) => r.acquisitionEnding],
  ['Accumulated Depreciation - Beginning Balance', (r) => r.depreciationBeginning],
  ['Depreciation for the Year', (r) => r.depreciationYear],
  ['Accumulated Depreciation on Retirements', (r) => r.depreciationOnRetirements],
  ['Depreciation Adjustments', (r) => r.depreciationAdjustments],
  ['Accumulated Depreciation - Ending Balance', (r) => r.depreciationEnding],
  ['Net Book Value', (r) => r.netBookValue],
  ['Currency', (r) => r.currency],
];

export function assetHistoryCsv(rowsToExport: AssetHistoryRow[]): string {
  const esc = (v: string | number | null) => {
    const s = v === null ? '' : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [CSV_COLUMNS.map(([h]) => esc(h)).join(',')];
  for (const row of rowsToExport) {
    lines.push(CSV_COLUMNS.map(([, f]) => esc(f(row))).join(','));
  }
  return lines.join('\n') + '\n';
}
