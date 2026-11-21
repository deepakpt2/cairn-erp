/**
 * MRP exception monitor — MD06, PROD.MRP.EXCEPTION. Read-only.
 *
 * The collection MD04 does not make: for one plant, scan the materials MRP actually plans, ask the
 * stock/requirements list (MD04) about each, and list the ones that carry an exception, most urgent first,
 * each drilling back to MD04. **The arithmetic is MD04's and stays there**: this reads `exceptionCounts`
 * and the rows `stockRequirementsList` returns, and never recomputes a shortage, a safety stock breach or a
 * past-due element. If the monitor and MD04 ever disagreed about one material, a planner would stop trusting
 * both.
 *
 * The population is the MRP run's: a material with MRP type REQUIREMENTS or REORDER. NONE and a blank type
 * are not planned, so they are not listed — and are counted, so the monitor's population is never a
 * mystery. The scan is bounded (default 50 materials, ceiling 500, refused above it rather than clamped)
 * and says how many materials it did not reach, in the terms the MRP run uses for its foreground limit.
 * Two layers of truncation are carried: how many materials were scanned, and whether any one material's
 * own list was cut.
 *
 * Plant scope only: MD04 refuses an MRP area (the plant is the planning scope), so the monitor does too.
 * Recomputed on every execution — no MRP list is stored. Nothing is planned, proposed or written.
 *
 * Authority: `PROD.MRP.EXCEPTION`, judged here before any MRP data is read, with the signed-in user's
 * Plant scope over the plant.
 */
import { sql } from 'drizzle-orm';

import { type ServiceAuthorityContext, verifyServiceAuthorityInTx } from '../../platform/auth/service-authority';
import { hasOrgAccess } from '../../platform/auth/session';
import { purchasingActor, reachablePlantsInTx } from '../../platform/auth/scope-actor';
import { withTenant } from '../../platform/db/client';
import {
  type ExceptionCode, StockRequirementsError, stockRequirementsListForProvisioning,
} from './stock-requirements';

export const MRP_EXCEPTION_CAPABILITY = 'PROD.MRP.EXCEPTION';
export const MRP_EXCEPTION_ROUTE = '/production/mrp-exception-monitor';
export const MRP_EXCEPTION_ALIAS = 'MD06';
/** Materials scanned when the caller names no limit. */
export const MRP_EXCEPTION_DEFAULT_LIMIT = 50;
/** The most materials one scan may be asked for. Above it is refused, so no caller asks for a whole plant unseen. */
export const MRP_EXCEPTION_LIMIT_CEILING = 500;
/** The stock/requirements list's own page, so a material's list is cut only where MD04 cuts it. */
const STOCK_REQUIREMENTS_PATH = '/production/stock-requirements';

export const EXCEPTION_CODES = ['SHORTAGE', 'SAFETY_BREACH', 'PAST_DUE'] as const;
const URGENCY: Record<ExceptionCode, number> = { SHORTAGE: 0, SAFETY_BREACH: 1, PAST_DUE: 2 };

export class MrpExceptionError extends Error {
  readonly remedy?: string;
  constructor(message: string, remedy?: string) {
    super(message);
    this.name = 'MrpExceptionError';
    this.remedy = remedy;
  }
}

function fail(message: string, remedy?: string): never {
  throw new MrpExceptionError(message, remedy);
}

export interface MrpExceptionSelection {
  materialFrom?: string;
  materialTo?: string;
  mrpType?: 'REQUIREMENTS' | 'REORDER';
  horizonEnd?: string;
  exceptions?: ReadonlyArray<ExceptionCode>;
  /** Accepted only to be refused: the plant is the planning scope. */
  mrpArea?: string;
}

export interface MrpExceptionMaterial {
  materialNumber: string;
  materialDescription: string;
  baseUnit: string;
  mrpType: string | null;
  /** The first date of the material's most urgent exception, for ordering the worklist. */
  firstExceptionDate: string | null;
  /** The lowest projected balance the material reaches in the list. */
  lowestBalance: number | null;
  closingBalance: number;
  safetyStock: number;
  counts: Record<ExceptionCode, number>;
  /** The most urgent exception the material carries. */
  worst: ExceptionCode;
  /** True when this material's own MD04 list was cut. */
  listTruncated: boolean;
  warnings: string[];
}

export interface MrpExceptionResult {
  plant: string;
  today: string;
  selection: {
    materialFrom: string | null; materialTo: string | null; mrpType: string | null;
    horizonEnd: string | null; exceptions: string[] | null;
  };
  /** What the monitor looked at, so the population is not a mystery. */
  population: {
    scanned: number; matched: number;
    /** NONE and blank MRP type together: not planned, not listed. */
    excludedNoMrpType: number; excludedNone: number; excludedBlank: number;
    capped: boolean; notScanned: number;
    /** Materials whose list could not be calculated at all (named in `warnings`). */
    failed: number;
    limit: number;
  };
  /** True when the scan stopped at the limit before reaching every planned material. */
  truncated: boolean;
  /** Sums of each exception code over the listed materials. */
  totals: Record<ExceptionCode, number>;
  materials: MrpExceptionMaterial[];
  /** The bound, any material that failed, and every warning MD04 raised, where they cannot be missed. */
  warnings: string[];
  elapsedMs: number;
  /** The MD04 page for a material, with the material and plant already filled in. */
  drillDown: (materialNumber: string) => string;
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function checkDate(value: string, label: string): string {
  const parsed = ISO_DATE.test(value) ? new Date(`${value}T00:00:00Z`) : null;
  if (!parsed || Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
    fail(`${label} ${value} is not a calendar date.`, 'Use the format YYYY-MM-DD.');
  }
  return value;
}

export function drillDownFor(materialNumber: string, plant: string, horizonEnd?: string | null): string {
  const query = new URLSearchParams({ material: materialNumber, plant });
  if (horizonEnd) query.set('horizonEnd', horizonEnd);
  return `${STOCK_REQUIREMENTS_PATH}?${query.toString()}`;
}

export async function mrpExceptionMonitor(
  input: {
    client: string;
    today: string;
    plant: string;
    selection?: MrpExceptionSelection;
    /** Materials to scan. Default 50, ceiling 500. */
    limit?: number;
  },
  options: { authorization?: ServiceAuthorityContext } = {},
): Promise<MrpExceptionResult> {
  const started = Date.now();
  const plant = String(input.plant ?? '').trim().toUpperCase();
  const s = input.selection ?? {};
  const materialFrom = (s.materialFrom ?? '').trim().toUpperCase();
  const materialTo = (s.materialTo ?? '').trim().toUpperCase();
  const horizonEnd = (s.horizonEnd ?? '').trim();
  const mrpType = s.mrpType ?? null;
  const wanted = s.exceptions && s.exceptions.length > 0 ? [...new Set(s.exceptions)] : null;
  const limit = input.limit ?? MRP_EXCEPTION_DEFAULT_LIMIT;

  // Authority first, then every refusal, then the first read of planning data.
  const population = await withTenant(input.client, async (tx) => {
    const verdict = await verifyServiceAuthorityInTx(tx, input.client, options.authorization, MRP_EXCEPTION_CAPABILITY, { requirePlantScope: true });
    if (!verdict.ok) {
      fail(
        verdict.refusal.message.startsWith('You do not hold the authority') ? `You do not hold ${MRP_EXCEPTION_CAPABILITY}.` : verdict.refusal.message,
        verdict.refusal.remedy,
      );
    }
    if (!plant) fail('A plant is required.', 'The monitor is of one plant.');
    if (!hasOrgAccess(verdict.restrictions, 'PLANT', plant)) {
      fail(`Your Plant scope does not cover plant ${plant}.`, 'Ask an administrator to extend your Plant scope, then run the monitor again.');
    }
    // The plant's company must also be inside the explicit Company Code scope.
    const companyActor = await purchasingActor(tx, input.client, options.authorization, [MRP_EXCEPTION_CAPABILITY], (m, r) => new MrpExceptionError(m, r));
    if (!(await reachablePlantsInTx(tx, input.client, companyActor)).includes(plant)) {
      fail(`Plant ${plant} does not stand.`, 'Choose a plant that exists.');
    }
    if ((s.mrpArea ?? '').trim()) {
      fail(`The MRP area ${s.mrpArea!.trim()} does not stand.`, 'Decentralised planning is not carried; the plant is the planning scope.');
    }
    if (!Number.isInteger(limit) || limit < 1) fail('The number of materials to scan must be a positive whole number.', `Enter a number from 1 to ${MRP_EXCEPTION_LIMIT_CEILING}.`);
    if (limit > MRP_EXCEPTION_LIMIT_CEILING) {
      fail(`A scan of ${limit} materials is above the ceiling of ${MRP_EXCEPTION_LIMIT_CEILING}.`, `Ask for at most ${MRP_EXCEPTION_LIMIT_CEILING}, or narrow the material range and scan in steps.`);
    }
    if (materialFrom && materialTo && materialFrom > materialTo) {
      fail(`Material from ${materialFrom} is later than material to ${materialTo}.`, 'Put the lower material number first.');
    }
    checkDate(input.today, 'Today');
    if (horizonEnd) {
      checkDate(horizonEnd, 'Planning horizon end');
      if (horizonEnd < input.today) fail('The planning horizon ends in the past.', 'Set the horizon end on or after today.');
    }
    if (wanted) {
      for (const code of wanted) {
        if (!(EXCEPTION_CODES as readonly string[]).includes(code)) fail(`The exception ${code} does not stand.`, `Choose from ${EXCEPTION_CODES.join(', ')}.`);
      }
    }
    if (mrpType && mrpType !== 'REQUIREMENTS' && mrpType !== 'REORDER') {
      fail(`MRP type ${mrpType} is not one MRP plans.`, 'Choose REQUIREMENTS or REORDER; a material of type NONE is not planned.');
    }
    const [stands] = (await tx.execute(sql`select 1 as hit from plant where client = ${input.client} and plant = ${plant} limit 1`)) as unknown as Array<{ hit: number }>;
    if (!stands) fail(`Plant ${plant} does not stand.`, 'Choose a plant that exists.');

    const rows = (await tx.execute(sql`
      select material_number, mrp_type from material_plant
       where client = ${input.client} and plant = ${plant}
         and (${materialFrom || null}::varchar is null or material_number >= ${materialFrom || null})
         and (${materialTo || null}::varchar is null or material_number <= ${materialTo || null})
       order by material_number
    `)) as unknown as Array<{ material_number: string; mrp_type: string | null }>;
    const planned = rows.filter((r) => (r.mrp_type === 'REQUIREMENTS' || r.mrp_type === 'REORDER') && (!mrpType || r.mrp_type === mrpType));
    return {
      candidates: planned.map((r) => r.material_number),
      excludedNone: rows.filter((r) => r.mrp_type === 'NONE').length,
      excludedBlank: rows.filter((r) => r.mrp_type === null || String(r.mrp_type).trim() === '').length,
    };
  });

  const toScan = population.candidates.slice(0, limit);
  const notScanned = population.candidates.length - toScan.length;
  const warnings: string[] = [];
  if (notScanned > 0) {
    // The shape the MRP run records for its foreground limit: bound the work, and say it was bounded.
    warnings.push(`${notScanned} material${notScanned === 1 ? ' was' : 's were'} not scanned. The scan limit is ${limit}.`);
  }

  const materials: MrpExceptionMaterial[] = [];
  let failed = 0;
  for (const materialNumber of toScan) {
    let list;
    try {
      list = await stockRequirementsListForProvisioning({
        client: input.client, today: input.today,
        selection: { material: materialNumber, plant, ...(horizonEnd ? { horizonEnd } : {}) },
      });
    } catch (error) {
      if (!(error instanceof StockRequirementsError)) throw error;
      failed += 1;
      warnings.push(`${materialNumber} could not be listed and was skipped: ${error.message}`);
      continue;
    }
    const counts = list.exceptionCounts;
    const present = EXCEPTION_CODES.filter((code) => counts[code] > 0);
    if (present.length === 0) continue;
    if (wanted && !present.some((code) => wanted.includes(code))) continue;
    const worst = present.reduce((a, b) => (URGENCY[a] <= URGENCY[b] ? a : b));
    const dates = list.rows.filter((r) => r.exceptions.includes(worst)).map((r) => r.date).sort();
    const balances = list.rows.map((r) => r.projectedBalance);
    materials.push({
      materialNumber: list.material, materialDescription: list.materialDescription, baseUnit: list.baseUnit, mrpType: list.mrpType,
      firstExceptionDate: dates[0] ?? null,
      lowestBalance: balances.length > 0 ? Math.min(...balances) : null,
      closingBalance: list.closingBalance, safetyStock: list.safetyStock,
      counts: { ...counts }, worst, listTruncated: list.truncated, warnings: list.warnings,
    });
  }

  // Most urgent first, and within a code the exception that bites soonest.
  materials.sort((a, b) => (URGENCY[a.worst] - URGENCY[b.worst])
    || ((a.firstExceptionDate ?? '9999-12-31') < (b.firstExceptionDate ?? '9999-12-31') ? -1 : (a.firstExceptionDate ?? '9999-12-31') > (b.firstExceptionDate ?? '9999-12-31') ? 1 : 0)
    || (a.materialNumber < b.materialNumber ? -1 : 1));

  const totals: Record<ExceptionCode, number> = { SHORTAGE: 0, SAFETY_BREACH: 0, PAST_DUE: 0 };
  for (const m of materials) for (const code of EXCEPTION_CODES) totals[code] += m.counts[code];
  for (const m of materials) {
    if (m.listTruncated) warnings.push(`${m.materialNumber}: its own stock/requirements list was truncated, so its exception counts may be incomplete.`);
  }

  return {
    plant, today: input.today,
    selection: {
      materialFrom: materialFrom || null, materialTo: materialTo || null, mrpType, horizonEnd: horizonEnd || null,
      exceptions: wanted ? [...wanted] : null,
    },
    population: {
      scanned: toScan.length, matched: materials.length,
      excludedNoMrpType: population.excludedNone + population.excludedBlank,
      excludedNone: population.excludedNone, excludedBlank: population.excludedBlank,
      capped: notScanned > 0, notScanned, failed, limit,
    },
    truncated: notScanned > 0,
    totals, materials, warnings,
    elapsedMs: Date.now() - started,
    drillDown: (materialNumber: string) => drillDownFor(materialNumber, plant, horizonEnd || null),
  };
}
