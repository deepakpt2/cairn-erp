/**
 * Activity costing of production confirmations — actual quantity valued at a configured plan rate.
 *
 * What this is, said exactly. A confirmed activity quantity (hours of a confirmation parameter) is valued at the
 * PLAN activity rate that the work centre's costing line names (cost centre, activity type, plan version, and the
 * parameter the line values), for the fiscal period of the confirmation's posting date. The rate is the plan rate
 * (fixed + variable price, per price unit) — it is NOT an actual-rate calculation, and every row says so
 * (`rate_basis = PLAN_RATE_AT_ACTUAL_QUANTITY`). The amount is
 *
 *     quantity × unit conversion × (fixed + variable) ÷ price unit        rounded ONCE to the currency's decimals
 *
 * calculated exactly in integers; the stored quantity, unit, rate, price unit, sender and posting reference are
 * the evidence. The posting is one balanced journal in the company currency: debit the order, credit the sender
 * cost centre, both on the account the tenant names for posting event PRODUCTION_ACTIVITY (an internal
 * activity-allocation account, so it nets to zero in the document and is not new external expense).
 *
 * Nothing is invented. A missing costing line, activity type, cost centre, plan rate (or a zero one), unit
 * conversion, company/currency match or account determination is an actionable, recorded exception
 * (`FAILED`, or `NOT_CONFIGURED` where the work centre configures no actual valuation at all) — never a zero rate,
 * never a default account. The confirmation itself is saved first and is never refused for a costing problem; the
 * row is the recoverable exception, and `costConfirmation` is idempotent: a POSTED row is never posted again,
 * and the order-wide confirmation lock serialises a retry against the original.
 *
 * Cancellation reverses the ORIGINAL journal (`reverseJournalEntry` mirrors the stored amounts, not today's rate)
 * exactly once, in the same transaction as the cancellation. Confirmations that predate this feature have no
 * cost row: they are listed, previewed and posted only on an explicit, authorised action — never back-posted by
 * a migration.
 */
import { sql } from 'drizzle-orm';

import { type Tx, withTenant } from '../../platform/db/client';
import { acquireLock } from '../../platform/lock';
import { PostingError, postJournalEntry, reverseJournalEntry } from '../../platform/posting';
import { divideRound } from '../../platform/posting/decimal';
import { MoneyError, moneyFor } from '../../platform/posting/money';
import { derivePosition } from '../../platform/periods';
import {
  type ServiceAuthorityContext, refusePlantOutsideScopeInTx, verifyServiceAuthorityInTx,
} from '../../platform/auth/service-authority';
import { recordChange } from '../../platform/change';

export const ACTIVITY_COST_EVENT = 'PRODUCTION_ACTIVITY';
export const ACTIVITY_COST_RATE_BASIS = 'PLAN_RATE_AT_ACTUAL_QUANTITY';
export const ACTIVITY_COST_BASIS_LABEL = 'Actual quantity valued at a configured plan rate (not an actual-rate calculation)';
export const ACTIVITY_COST_DOCUMENT_TYPE = 'SA';
export const ACTIVITY_COST_LOCK = 'PRODUCTION_ORDER';
export const WORK_CENTER_ROUTE = '/production/work-centers';
export const ACCOUNT_DETERMINATION_ROUTE = '/config/account-determination';

export type ActivityCostStatus = 'POSTED' | 'FAILED' | 'NOT_CONFIGURED' | 'REVERSED' | 'CANCELLED';

export class ActivityCostError extends Error {
  readonly remedy?: string;
  constructor(message: string, remedy?: string) {
    super(message);
    this.name = 'ActivityCostError';
    this.remedy = remedy;
  }
}

export interface ActivityCostEvidence {
  confirmationNumber: string;
  parameter: string;
  orderNumber: string;
  status: ActivityCostStatus;
  quantity: string;
  unit: string;
  workCenter: string | null;
  plant: string | null;
  controllingArea: string | null;
  costCenter: string | null;
  activityType: string | null;
  activityUnit: string | null;
  activityQuantity: string | null;
  rateBasis: string | null;
  planVersion: string | null;
  rateYear: number | null;
  ratePeriod: number | null;
  fixedPrice: string | null;
  variablePrice: string | null;
  priceUnit: number | null;
  amount: string | null;
  currency: string | null;
  postingDate: string | null;
  journalDocument: string | null;
  journalYear: number | null;
  reversalDocument: string | null;
  reversalYear: number | null;
  message: string | null;
  remedy: string | null;
}

interface Valuation {
  companyCode: string;
  chart: string;
  currency: string;
  controllingArea: string;
  costCenter: string;
  activityType: string;
  activityUnit: string;
  activityQuantity: bigint; // scale 6
  planVersion: string;
  rateYear: number;
  ratePeriod: number;
  fixedPrice: string;
  variablePrice: string;
  priceUnit: number;
  amountUnits: bigint;
  scale: number;
  account: string;
  postingDate: string;
}

type Valued =
  | { ok: true; value: Valuation }
  | { ok: false; status: 'FAILED' | 'NOT_CONFIGURED'; message: string; remedy: string };

const bad = (message: string, remedy: string): Valued => ({ ok: false, status: 'FAILED', message, remedy });

const Q_SCALE = 3;
const WORK = 6; // activity quantity working scale
const RATE_SCALE = 4; // prices carry at most their stored decimals; four is exact for numeric(11,2) and any 4-dp widening

function scaledText(value: unknown, scale: number): bigint {
  const text = String(value ?? '0').trim();
  const negative = text.startsWith('-');
  const [whole = '0', fraction = ''] = (negative ? text.slice(1) : text).split('.');
  const padded = (fraction + '0'.repeat(scale)).slice(0, scale);
  const n = BigInt(whole || '0') * 10n ** BigInt(scale) + BigInt(padded || '0');
  return negative ? -n : n;
}

function shownScaled(value: bigint, scale: number): string {
  const negative = value < 0n;
  const abs = negative ? -value : value;
  const text = abs.toString().padStart(scale + 1, '0');
  const whole = text.slice(0, text.length - scale);
  const fraction = text.slice(text.length - scale);
  return `${negative ? '-' : ''}${whole}${scale > 0 ? `.${fraction}` : ''}`;
}

/**
 * Exact conversion factor between two units of the global unit master, as a fraction (to-activity-unit per unit).
 * Same unit → 1/1. A different dimension, an unseeded unit or an unknown one is refused, never assumed equal.
 */
export async function unitFactor(tx: Tx, from: string, to: string): Promise<{ numerator: bigint; denominator: bigint } | string> {
  const a = from.trim();
  const b = to.trim();
  if (a === b) return { numerator: 1n, denominator: 1n };
  const rows = await tx.execute(sql`
    select code, dimension, numerator, denominator, exponent, is_base_unit from unit_of_measure where code in (${a}, ${b})
  `) as unknown as Array<{ code: string; dimension: string; numerator: number; denominator: number; exponent: number; is_base_unit: boolean }>;
  const f = rows.find((row) => row.code === a);
  const t = rows.find((row) => row.code === b);
  if (!f || !t) return `Unit ${!f ? a : b} is not a unit of measure.`;
  if (f.dimension !== t.dimension) return `Unit ${a} (${f.dimension}) and unit ${b} (${t.dimension}) are not of the same dimension, so no conversion applies.`;
  for (const u of [f, t]) {
    if (!u.is_base_unit && u.numerator === 1 && u.denominator === 1 && u.exponent === 0) {
      return `Unit ${u.code} carries no conversion factor to the base unit of ${u.dimension}.`;
    }
  }
  const pow = (e: number) => 10n ** BigInt(Math.abs(e));
  let numerator = BigInt(f.numerator) * BigInt(t.denominator);
  let denominator = BigInt(f.denominator) * BigInt(t.numerator);
  if (f.exponent >= 0) numerator *= pow(f.exponent); else denominator *= pow(f.exponent);
  if (t.exponent >= 0) denominator *= pow(t.exponent); else numerator *= pow(t.exponent);
  return { numerator, denominator };
}

interface Confirmation {
  confirmationNumber: string;
  orderNumber: string;
  plant: string;
  workCenter: string | null;
  workCenterPlant: string | null;
  postingDate: string;
  level: string;
}

async function valuate(
  tx: Tx, client: string, c: Confirmation, activity: { parameter: string; quantity: string; unit: string },
): Promise<Valued> {
  const [plantRow] = await tx.execute(sql`
    select company_code from plant where client = ${client} and plant = ${c.plant}
  `) as unknown as Array<{ company_code: string | null }>;
  const companyCode = plantRow?.company_code?.trim() ?? '';
  if (!companyCode) return bad(`Plant ${c.plant} has no company code, so the activity has no company to post in.`, 'Assign the plant to a company code.');
  if (!c.workCenter || !c.workCenterPlant) {
    return { ok: false, status: 'NOT_CONFIGURED', message: 'The confirmation names no work center, so no costing line applies.', remedy: `Confirm an operation that has a work center (${WORK_CENTER_ROUTE}).` };
  }

  const lines = await tx.execute(sql`
    select line_number, controlling_area, cost_center, activity_type, parameter, rate_basis, plan_version
      from work_center_costing
     where client = ${client} and plant = ${c.workCenterPlant} and work_center = ${c.workCenter}
       and valid_from <= ${c.postingDate}::date and valid_to >= ${c.postingDate}::date
     order by line_number
  `) as unknown as Array<{
    line_number: number; controlling_area: string; cost_center: string; activity_type: string | null;
    parameter: string | null; rate_basis: string | null; plan_version: string | null;
  }>;
  const valued = lines.filter((line) => line.rate_basis !== null);
  if (valued.length === 0) {
    return {
      ok: false, status: 'NOT_CONFIGURED',
      message: `Work center ${c.workCenter} (plant ${c.workCenterPlant}) has no costing line valid on ${c.postingDate} that values actual activity. Nothing was costed.`,
      remedy: `Give a costing line of the work center a parameter, the rate basis PLAN_RATE and a plan version at ${WORK_CENTER_ROUTE}; then post the cost from the confirmation.`,
    };
  }
  const mine = valued.filter((line) => line.parameter === activity.parameter);
  if (mine.length === 0) {
    return bad(
      `No costing line of work center ${c.workCenter} values parameter ${activity.parameter} on ${c.postingDate}. The parameters are not combined and none was guessed.`,
      `Add a costing line for parameter ${activity.parameter} at ${WORK_CENTER_ROUTE}.`,
    );
  }
  if (mine.length > 1) {
    return bad(
      `Work center ${c.workCenter} has ${mine.length} costing lines valuing parameter ${activity.parameter} on ${c.postingDate} (lines ${mine.map((line) => line.line_number).join(', ')}). None was chosen.`,
      `Keep one valid line per parameter at ${WORK_CENTER_ROUTE}.`,
    );
  }
  const line = mine[0]!;
  const area = line.controlling_area.trim();
  const costCenter = line.cost_center.trim();
  const activityType = (line.activity_type ?? '').trim();
  const planVersion = (line.plan_version ?? '').trim();

  const [center] = await tx.execute(sql`
    select company_code, is_posting_locked from cost_center
     where client = ${client} and controlling_area = ${area} and cost_center = ${costCenter}
       and valid_from <= ${c.postingDate}::date and valid_to >= ${c.postingDate}::date
  `) as unknown as Array<{ company_code: string; is_posting_locked: boolean }>;
  if (!center) return bad(`Sender cost center ${costCenter} (area ${area}) is not valid on ${c.postingDate}.`, 'Correct the costing line or the cost center validity.');
  if (center.is_posting_locked) return bad(`Sender cost center ${costCenter} is locked for posting.`, 'Unlock the cost center, then post the cost from the confirmation.');
  if (center.company_code.trim() !== companyCode) {
    return bad(
      `Sender cost center ${costCenter} belongs to company ${center.company_code.trim()}, the order's plant to ${companyCode}. A cross-company allocation is not assumed.`,
      'Use a sender cost center of the plant\'s company.',
    );
  }
  const [type] = await tx.execute(sql`
    select activity_unit, is_posting_locked from activity_type
     where client = ${client} and controlling_area = ${area} and activity_type = ${activityType}
       and valid_from <= ${c.postingDate}::date and valid_to >= ${c.postingDate}::date
  `) as unknown as Array<{ activity_unit: string; is_posting_locked: boolean }>;
  if (!type) return bad(`Activity type ${activityType} (area ${area}) is not valid on ${c.postingDate}.`, 'Maintain the activity type, or correct the costing line.');
  if (type.is_posting_locked) return bad(`Activity type ${activityType} is locked for posting.`, 'Unlock the activity type, then post the cost from the confirmation.');

  const factor = await unitFactor(tx, activity.unit, type.activity_unit);
  if (typeof factor === 'string') {
    return bad(`Unit mismatch: the confirmation counts ${activity.unit}, activity type ${activityType} is priced per ${type.activity_unit.trim()}. ${factor}`, 'Confirm in the activity unit, or correct the activity type unit.');
  }

  const [areaRow] = await tx.execute(sql`
    select currency, fiscal_year_variant from controlling_area where client = ${client} and controlling_area = ${area}
  `) as unknown as Array<{ currency: string; fiscal_year_variant: string }>;
  if (!areaRow) return bad(`Controlling area ${area} does not stand.`, 'Correct the costing line.');
  const [company] = await tx.execute(sql`
    select chart_of_accounts, currency from company_code where client = ${client} and company_code = ${companyCode}
  `) as unknown as Array<{ chart_of_accounts: string | null; currency: string }>;
  if (!company?.chart_of_accounts) return bad(`Company ${companyCode} has no chart of accounts.`, 'Assign a chart of accounts to the company.');
  if (company.currency.trim() !== areaRow.currency.trim()) {
    return bad(`Controlling area ${area} is in ${areaRow.currency.trim()}, company ${companyCode} in ${company.currency.trim()}. No exchange rate is assumed.`, 'Use a controlling area in the company currency.');
  }
  const position = await derivePosition(tx, client, areaRow.fiscal_year_variant.trim(), c.postingDate);

  const [rate] = await tx.execute(sql`
    select fixed_price::text as fixed_price, variable_price::text as variable_price, price_unit
      from activity_rate
     where client = ${client} and controlling_area = ${area} and plan_version = ${planVersion}
       and fiscal_year = ${position.fiscalYear} and period = ${position.period}
       and cost_center = ${costCenter} and activity_type = ${activityType}
  `) as unknown as Array<{ fixed_price: string; variable_price: string; price_unit: number }>;
  if (!rate) {
    return bad(
      `No plan rate for cost center ${costCenter}, activity type ${activityType}, plan version ${planVersion}, period ${position.period}/${position.fiscalYear}.`,
      'Plan the activity price (KP26 / KSPI) for that period, or correct the plan version on the costing line.',
    );
  }
  const fixed = scaledText(rate.fixed_price, RATE_SCALE);
  const variable = scaledText(rate.variable_price, RATE_SCALE);
  const total = fixed + variable;
  if (total <= 0n) return bad('The plan rate is zero. A zero rate is not assumed to be right.', 'Plan a positive activity price, or remove the costing line\'s rate basis.');
  const priceUnit = BigInt(Number(rate.price_unit));
  if (priceUnit < 1n) return bad('The plan rate carries no price unit.', 'Correct the activity price.');

  const [determination] = await tx.execute(sql`
    select gl_account from account_determination
     where client = ${client} and chart_of_accounts = ${company.chart_of_accounts.trim()} and event = ${ACTIVITY_COST_EVENT}
       and valuation_class = '' and general_modifier = ''
  `) as unknown as Array<{ gl_account: string }>;
  if (!determination) {
    return bad(
      `No account is determined for posting event ${ACTIVITY_COST_EVENT} in chart ${company.chart_of_accounts.trim()}.`,
      `Name the activity-allocation account at ${ACCOUNT_DETERMINATION_ROUTE}; no account is invented.`,
    );
  }

  const currency = company.currency.trim();
  let money;
  try {
    money = await moneyFor(tx, currency);
  } catch (error) {
    if (error instanceof MoneyError) return bad(error.message, error.remedy ?? 'Maintain the currency.');
    throw error;
  }
  const quantity = scaledText(activity.quantity, Q_SCALE);
  // activity quantity (scale 6, exact conversion fraction, rounded once for the evidence)
  const activityQuantity = divideRound(quantity * factor.numerator * 10n ** BigInt(WORK - Q_SCALE), factor.denominator);
  // amount: exact in one expression, rounded once to the currency
  const amountUnits = divideRound(
    quantity * factor.numerator * total * 10n ** BigInt(money.scale),
    factor.denominator * priceUnit * 10n ** BigInt(Q_SCALE + RATE_SCALE),
  );
  if (amountUnits <= 0n) {
    return bad(`The valued amount rounds to zero in ${currency}. Nothing was posted.`, 'Confirm a larger quantity, or raise the price unit precision of the plan rate.');
  }
  return {
    ok: true,
    value: {
      companyCode, chart: company.chart_of_accounts.trim(), currency, controllingArea: area, costCenter, activityType,
      activityUnit: type.activity_unit.trim(), activityQuantity, planVersion, rateYear: position.fiscalYear,
      ratePeriod: position.period, fixedPrice: shownScaled(fixed, RATE_SCALE), variablePrice: shownScaled(variable, RATE_SCALE),
      priceUnit: Number(priceUnit), amountUnits, scale: money.scale, account: determination.gl_account.trim(), postingDate: c.postingDate,
    },
  };
}

async function loadConfirmation(tx: Tx, client: string, confirmationNumber: string): Promise<{ confirmation: Confirmation; cancelled: boolean } | null> {
  const [row] = await tx.execute(sql`
    select c.confirmation_number, c.order_number, o.plant, c.work_center, c.work_center_plant, c.posting_date::text as posting_date,
           c.confirmation_level,
           exists (select 1 from production_confirmation_cancellation x
                    where x.client = c.client and x.confirmation_number = c.confirmation_number) as cancelled
      from production_confirmation c
      join production_order o on o.client = c.client and o.order_number = c.order_number
     where c.client = ${client} and c.confirmation_number = ${confirmationNumber}
  `) as unknown as Array<{
    confirmation_number: string; order_number: string; plant: string; work_center: string | null; work_center_plant: string | null;
    posting_date: string; confirmation_level: string; cancelled: boolean;
  }>;
  if (!row) return null;
  return {
    cancelled: row.cancelled,
    confirmation: {
      confirmationNumber: row.confirmation_number, orderNumber: row.order_number, plant: row.plant.trim(),
      workCenter: row.work_center?.trim() || null, workCenterPlant: row.work_center_plant?.trim() || null,
      postingDate: row.posting_date, level: row.confirmation_level,
    },
  };
}

async function recordException(
  tx: Tx, client: string, c: Confirmation, activity: { parameter: string; quantity: string; unit: string },
  status: 'FAILED' | 'NOT_CONFIGURED', message: string, remedy: string, by: string,
): Promise<void> {
  await tx.execute(sql`
    insert into production_confirmation_cost (
      client, confirmation_number, parameter, order_number, status, quantity, unit, plant, work_center,
      posting_date, message, remedy, attempts, created_by
    ) values (
      ${client}, ${c.confirmationNumber}, ${activity.parameter}, ${c.orderNumber}, ${status}, ${activity.quantity}, ${activity.unit},
      ${c.plant}, ${c.workCenter}, ${c.postingDate}::date, ${message.slice(0, 400)}, ${remedy.slice(0, 400)}, 1, ${by}
    )
    on conflict (client, confirmation_number, parameter) do update
      set status = excluded.status, message = excluded.message, remedy = excluded.remedy,
          attempts = production_confirmation_cost.attempts + 1, changed_by = ${by}, changed_at = now()
      where production_confirmation_cost.status in ('FAILED', 'NOT_CONFIGURED')
  `);
}

export interface CostRun {
  confirmationNumber: string;
  outcomes: Array<{ parameter: string; status: ActivityCostStatus | 'PREVIEW'; amount: string | null; currency: string | null; message: string | null; remedy: string | null; journalDocument: string | null }>;
}

/**
 * Value and post the activity cost of ONE confirmation, inside the caller's transaction. Takes the order-wide
 * confirmation lock first, so a retry or a concurrent retry sees the committed state of the original and can
 * never post the same activity twice. `preview` values without writing anything.
 */
export async function costConfirmationInTx(
  tx: Tx, client: string, confirmationNumber: string,
  options: { by: string; authorization?: ServiceAuthorityContext; capability: string; preview?: boolean },
): Promise<CostRun> {
  const found = await loadConfirmation(tx, client, confirmationNumber);
  if (!found) throw new ActivityCostError(`Confirmation ${confirmationNumber} does not stand.`, 'Choose a confirmation of this tenant.');
  const { confirmation, cancelled } = found;
  const run: CostRun = { confirmationNumber, outcomes: [] };
  if (cancelled) {
    run.outcomes.push({ parameter: '*', status: 'CANCELLED', amount: null, currency: null, message: 'The confirmation is cancelled; nothing is costed.', remedy: null, journalDocument: null });
    return run;
  }
  if (!options.preview) {
    await acquireLock(tx, { objectCode: ACTIVITY_COST_LOCK, keys: [client, confirmation.orderNumber] }, {
      client, requestedBy: options.by, transactionCode: 'CO11N',
    });
  }
  const activities = await tx.execute(sql`
    select parameter, quantity::text as quantity, trim(unit) as unit
      from production_confirmation_activity
     where client = ${client} and confirmation_number = ${confirmationNumber} and quantity > 0
     order by parameter
  `) as unknown as Array<{ parameter: string; quantity: string; unit: string }>;
  if (activities.length === 0) return run;
  const existing = await tx.execute(sql`
    select parameter, status, journal_document, amount::text as amount, currency, message, remedy
      from production_confirmation_cost where client = ${client} and confirmation_number = ${confirmationNumber}
  `) as unknown as Array<{ parameter: string; status: ActivityCostStatus; journal_document: string | null; amount: string | null; currency: string | null; message: string | null; remedy: string | null }>;

  // Authority: the confirming (or retrying) user, with a plant reach that covers the plant.
  let authorityRefusal: { message: string; remedy: string } | null = null;
  if (!options.preview) {
    const verdict = await verifyServiceAuthorityInTx(tx, client, options.authorization, options.capability);
    if (!verdict.ok) authorityRefusal = verdict.refusal;
    else {
      const outOfScope = await refusePlantOutsideScopeInTx(tx, client, confirmation.plant, verdict.restrictions);
      if (outOfScope) authorityRefusal = outOfScope;
    }
  }

  for (const activity of activities) {
    const prior = existing.find((row) => row.parameter === activity.parameter);
    if (prior && (prior.status === 'POSTED' || prior.status === 'REVERSED' || prior.status === 'CANCELLED')) {
      run.outcomes.push({ parameter: activity.parameter, status: prior.status, amount: prior.amount, currency: prior.currency, message: 'Already costed; not posted again.', remedy: null, journalDocument: prior.journal_document });
      continue;
    }
    const valued = await valuate(tx, client, confirmation, activity);
    if (!valued.ok) {
      if (!options.preview) await recordException(tx, client, confirmation, activity, valued.status, valued.message, valued.remedy, options.by);
      run.outcomes.push({ parameter: activity.parameter, status: options.preview ? 'FAILED' : valued.status, amount: null, currency: null, message: valued.message, remedy: valued.remedy, journalDocument: null });
      continue;
    }
    // Configured and valuable, but nobody with the authority is posting: a recoverable exception, not a silent skip.
    if (authorityRefusal) {
      if (!options.preview) await recordException(tx, client, confirmation, activity, 'FAILED', authorityRefusal.message, authorityRefusal.remedy, options.by);
      run.outcomes.push({ parameter: activity.parameter, status: 'FAILED', amount: null, currency: null, message: authorityRefusal.message, remedy: authorityRefusal.remedy, journalDocument: null });
      continue;
    }
    const v = valued.value;
    const amountText = shownScaled(v.amountUnits, v.scale);
    if (options.preview) {
      run.outcomes.push({ parameter: activity.parameter, status: 'PREVIEW', amount: amountText, currency: v.currency, message: `${ACTIVITY_COST_BASIS_LABEL}: ${activity.quantity} ${activity.unit} × ${v.fixedPrice} + ${v.variablePrice} per ${v.priceUnit} ${v.activityUnit}, plan ${v.planVersion} ${v.ratePeriod}/${v.rateYear}, sender ${v.costCenter}.`, remedy: null, journalDocument: null });
      continue;
    }
    try {
      // A savepoint: a posting that is refused (closed period, blocked account) must not poison this transaction.
      const posted = await tx.transaction(async (savepoint) => {
        const sp = savepoint as unknown as Tx;
        const company = (await sp.execute(sql`select fiscal_year_variant from company_code where client = ${client} and company_code = ${v.companyCode}`)) as unknown as Array<{ fiscal_year_variant: string }>;
        const position = await derivePosition(sp, client, company[0]!.fiscal_year_variant, v.postingDate);
        const text = `Activity ${activity.parameter} ${activity.quantity} ${activity.unit} · confirmation ${confirmationNumber}`.slice(0, 60);
        return postJournalEntry(sp, {
          client, companyCode: v.companyCode, documentType: ACTIVITY_COST_DOCUMENT_TYPE,
          documentDate: v.postingDate, postingDate: v.postingDate, fiscalYear: position.fiscalYear, postingPeriod: position.period,
          currency: v.currency, localCurrency: v.currency, reference: confirmationNumber, precision: 'CURRENCY',
          headerText: `Activity cost ${confirmation.orderNumber}`.slice(0, 25),
          lines: [
            { glAccount: v.account, debitCredit: 'S', amount: amountText, productionOrder: confirmation.orderNumber, plant: confirmation.plant, lineText: text },
            { glAccount: v.account, debitCredit: 'H', amount: amountText, costCenter: v.costCenter, plant: confirmation.plant, lineText: text },
          ],
          origin: { documentClass: 'production_confirmation_cost', documentKey: `${confirmationNumber}/${activity.parameter}` },
          postedBy: options.by, transactionCode: 'CO11N',
        });
      });
      await tx.execute(sql`
        insert into production_confirmation_cost (
          client, confirmation_number, parameter, order_number, status, quantity, unit, plant, work_center, controlling_area, cost_center,
          activity_type, company_code, activity_unit, activity_quantity, rate_basis, plan_version, rate_year, rate_period, fixed_price,
          variable_price, price_unit, amount, currency, posting_date, journal_document, journal_year, attempts, created_by
        ) values (
          ${client}, ${confirmationNumber}, ${activity.parameter}, ${confirmation.orderNumber}, 'POSTED', ${activity.quantity}, ${activity.unit},
          ${confirmation.plant}, ${confirmation.workCenter}, ${v.controllingArea}, ${v.costCenter}, ${v.activityType}, ${v.companyCode},
          ${v.activityUnit}, ${shownScaled(v.activityQuantity, WORK)}::numeric, ${ACTIVITY_COST_RATE_BASIS}, ${v.planVersion}, ${v.rateYear},
          ${v.ratePeriod}, ${v.fixedPrice}::numeric, ${v.variablePrice}::numeric, ${v.priceUnit}, ${amountText}::numeric, ${v.currency},
          ${v.postingDate}::date, ${posted.documentNumber}, ${posted.fiscalYear}, 1, ${options.by}
        )
        on conflict (client, confirmation_number, parameter) do update set
          status = 'POSTED', controlling_area = excluded.controlling_area, cost_center = excluded.cost_center,
          activity_type = excluded.activity_type, company_code = excluded.company_code, activity_unit = excluded.activity_unit,
          activity_quantity = excluded.activity_quantity, rate_basis = excluded.rate_basis, plan_version = excluded.plan_version,
          rate_year = excluded.rate_year, rate_period = excluded.rate_period, fixed_price = excluded.fixed_price,
          variable_price = excluded.variable_price, price_unit = excluded.price_unit, amount = excluded.amount,
          currency = excluded.currency, posting_date = excluded.posting_date, journal_document = excluded.journal_document,
          journal_year = excluded.journal_year, message = null, remedy = null,
          attempts = production_confirmation_cost.attempts + 1, changed_by = ${options.by}, changed_at = now()
        where production_confirmation_cost.status in ('FAILED', 'NOT_CONFIGURED')
      `);
      run.outcomes.push({ parameter: activity.parameter, status: 'POSTED', amount: amountText, currency: v.currency, message: ACTIVITY_COST_BASIS_LABEL, remedy: null, journalDocument: posted.documentNumber });
    } catch (error) {
      if (!(error instanceof PostingError) && !(error instanceof MoneyError)) throw error;
      const remedy = (error as { remedy?: string }).remedy ?? 'Resolve the cause, then post the cost from the confirmation.';
      await recordException(tx, client, confirmation, activity, 'FAILED', error.message, remedy, options.by);
      run.outcomes.push({ parameter: activity.parameter, status: 'FAILED', amount: null, currency: null, message: error.message, remedy, journalDocument: null });
    }
  }
  return run;
}

/** Cost one confirmation in its own transaction. The confirmation has already been saved; this never refuses it. */
export async function costConfirmation(
  client: string, confirmationNumber: string,
  options: { by: string; authorization?: ServiceAuthorityContext; capability: string },
): Promise<CostRun> {
  try {
    return await withTenant(client, (tx) => costConfirmationInTx(tx, client, confirmationNumber, options));
  } catch (error) {
    if (error instanceof ActivityCostError) throw error;
    // An unexpected failure (lock timeout, connection) must not leave the confirmation looking costed or silently
    // uncosted: record it as the same recoverable exception, in its own transaction, and report it.
    const message = `Activity cost could not be posted: ${error instanceof Error ? error.message : 'unexpected failure'}`.slice(0, 400);
    await withTenant(client, async (tx) => {
      const found = await loadConfirmation(tx, client, confirmationNumber);
      if (!found || found.cancelled) return;
      const activities = await tx.execute(sql`
        select parameter, quantity::text as quantity, trim(unit) as unit from production_confirmation_activity
         where client = ${client} and confirmation_number = ${confirmationNumber} and quantity > 0
      `) as unknown as Array<{ parameter: string; quantity: string; unit: string }>;
      for (const activity of activities) {
        await recordException(tx, client, found.confirmation, activity, 'FAILED', message, 'Post the cost again from the confirmation.', options.by);
      }
    });
    return {
      confirmationNumber,
      outcomes: [{ parameter: '*', status: 'FAILED', amount: null, currency: null, message, remedy: 'Post the cost again from the confirmation.', journalDocument: null }],
    };
  }
}

/** A read-only valuation of one confirmation — writes nothing. */
export async function previewConfirmationCost(client: string, confirmationNumber: string, by: string): Promise<CostRun> {
  return withTenant(client, (tx) => costConfirmationInTx(tx, client, confirmationNumber, { by, capability: '', preview: true }));
}

/**
 * Reverse the cost of a confirmation that is being cancelled, in the cancellation's transaction. Each POSTED row's
 * ORIGINAL journal is mirrored once (the stored amounts, never today's rate); an unposted exception is simply
 * marked CANCELLED. A closed period, or an order that has already been settled, refuses the whole cancellation.
 */
export async function reverseConfirmationCostInTx(
  tx: Tx, client: string, confirmationNumber: string, by: string, reason: string,
): Promise<{ reversed: Array<{ parameter: string; reversalDocument: string }> }> {
  const rows = await tx.execute(sql`
    select parameter, status, journal_document, journal_year, order_number
      from production_confirmation_cost where client = ${client} and confirmation_number = ${confirmationNumber}
     order by parameter
  `) as unknown as Array<{ parameter: string; status: ActivityCostStatus; journal_document: string | null; journal_year: number | null; order_number: string }>;
  const reversed: Array<{ parameter: string; reversalDocument: string }> = [];
  if (rows.length === 0) return { reversed };
  const posted = rows.filter((row) => row.status === 'POSTED');
  if (posted.length > 0) {
    const [settled] = await tx.execute(sql`
      select document_number from settlement_document where client = ${client} and order_number = ${posted[0]!.order_number} limit 1
    `) as unknown as Array<{ document_number: string }>;
    if (settled) {
      throw new ActivityCostError(
        `Order ${posted[0]!.order_number} was already settled (document ${settled.document_number}); the activity cost of confirmation ${confirmationNumber} cannot be reversed from under it.`,
        'Reverse the settlement first, then cancel the confirmation. Nothing was cancelled.',
      );
    }
  }
  const today = new Date().toISOString().slice(0, 10);
  for (const row of rows) {
    if (row.status === 'FAILED' || row.status === 'NOT_CONFIGURED') {
      await tx.execute(sql`
        update production_confirmation_cost set status = 'CANCELLED', changed_by = ${by}, changed_at = now()
         where client = ${client} and confirmation_number = ${confirmationNumber} and parameter = ${row.parameter}
      `);
      continue;
    }
    if (row.status !== 'POSTED') continue;
    let reversal: { documentNumber: string; fiscalYear: number };
    try {
      reversal = await reverseJournalEntry(tx, {
        client, documentNumber: row.journal_document!, fiscalYear: row.journal_year!, reversalDate: today,
        reason: reason.slice(0, 120), reversedBy: by, transactionCode: 'CO13',
      });
    } catch (error) {
      if (error instanceof PostingError) {
        throw new ActivityCostError(`The activity cost of confirmation ${confirmationNumber} could not be reversed: ${error.message}`, `${error.remedy ?? 'Resolve the cause.'} Nothing was cancelled.`);
      }
      throw error;
    }
    await tx.execute(sql`
      update production_confirmation_cost
         set status = 'REVERSED', reversal_document = ${reversal.documentNumber}, reversal_year = ${reversal.fiscalYear},
             changed_by = ${by}, changed_at = now()
       where client = ${client} and confirmation_number = ${confirmationNumber} and parameter = ${row.parameter} and status = 'POSTED'
    `);
    reversed.push({ parameter: row.parameter, reversalDocument: reversal.documentNumber });
  }
  await recordChange(tx, {
    client, objectClass: 'production_confirmation_cost', objectKey: confirmationNumber, changeType: 'REVERSE', changedBy: by, transactionCode: 'CO13',
    reason, after: { reversed },
  });
  return { reversed };
}

// ── Read models ────────────────────────────────────────────────────────────────────────────────

const EVIDENCE_COLUMNS = sql`
  confirmation_number, parameter, order_number, status, quantity::text as quantity, unit, work_center, plant, controlling_area,
  cost_center, activity_type, activity_unit, activity_quantity::text as activity_quantity, rate_basis, plan_version, rate_year,
  rate_period, fixed_price::text as fixed_price, variable_price::text as variable_price, price_unit, amount::text as amount,
  currency, posting_date::text as posting_date, journal_document, journal_year, reversal_document, reversal_year, message, remedy
`;

function evidenceOf(row: Record<string, unknown>): ActivityCostEvidence {
  const text = (value: unknown) => (value === null || value === undefined ? null : String(value).trim());
  const int = (value: unknown) => (value === null || value === undefined ? null : Number(value));
  return {
    confirmationNumber: String(row.confirmation_number), parameter: String(row.parameter), orderNumber: String(row.order_number),
    status: String(row.status) as ActivityCostStatus, quantity: String(row.quantity), unit: String(row.unit).trim(),
    workCenter: text(row.work_center), plant: text(row.plant), controllingArea: text(row.controlling_area), costCenter: text(row.cost_center),
    activityType: text(row.activity_type), activityUnit: text(row.activity_unit), activityQuantity: text(row.activity_quantity),
    rateBasis: text(row.rate_basis), planVersion: text(row.plan_version), rateYear: int(row.rate_year), ratePeriod: int(row.rate_period),
    fixedPrice: text(row.fixed_price), variablePrice: text(row.variable_price), priceUnit: int(row.price_unit), amount: text(row.amount),
    currency: text(row.currency), postingDate: text(row.posting_date), journalDocument: text(row.journal_document),
    journalYear: int(row.journal_year), reversalDocument: text(row.reversal_document), reversalYear: int(row.reversal_year),
    message: text(row.message), remedy: text(row.remedy),
  };
}

/** The cost rows of an order, for the cost report: posted actuals with their basis, and every missing or failed cost. */
export async function activityCostsOfOrder(tx: Tx, client: string, orderNumber: string): Promise<ActivityCostEvidence[]> {
  const rows = await tx.execute(sql`
    select ${EVIDENCE_COLUMNS} from production_confirmation_cost
     where client = ${client} and order_number = ${orderNumber}
     order by confirmation_number, parameter
  `) as unknown as Array<Record<string, unknown>>;
  return rows.map(evidenceOf);
}

/** The cost rows of one confirmation (the confirmation display). */
export async function activityCostsOfConfirmation(tx: Tx, client: string, confirmationNumber: string): Promise<ActivityCostEvidence[]> {
  const rows = await tx.execute(sql`
    select ${EVIDENCE_COLUMNS} from production_confirmation_cost
     where client = ${client} and confirmation_number = ${confirmationNumber}
     order by parameter
  `) as unknown as Array<Record<string, unknown>>;
  return rows.map(evidenceOf);
}

export interface UncostedConfirmation {
  confirmationNumber: string;
  orderNumber: string;
  parameter: string;
  quantity: string;
  unit: string;
  postingDate: string;
  state: 'NEVER_COSTED' | 'FAILED' | 'NOT_CONFIGURED';
}

/** Eligible confirmations with no posted cost: those that predate this feature, and the recorded exceptions. */
export async function listUncostedConfirmations(
  tx: Tx, client: string, filter: { orderNumber?: string; limit?: number },
): Promise<UncostedConfirmation[]> {
  const limit = Math.min(Math.max(filter.limit ?? 100, 1), 500);
  const order = (filter.orderNumber ?? '').trim().toUpperCase() || null;
  const rows = await tx.execute(sql`
    select c.confirmation_number, c.order_number, a.parameter, a.quantity::text as quantity, trim(a.unit) as unit,
           c.posting_date::text as posting_date, coalesce(k.status, 'NEVER_COSTED') as state
      from production_confirmation c
      join production_confirmation_activity a on a.client = c.client and a.confirmation_number = c.confirmation_number and a.quantity > 0
      left join production_confirmation_cost k
        on k.client = a.client and k.confirmation_number = a.confirmation_number and k.parameter = a.parameter
     where c.client = ${client} and c.confirmation_level = 'OPERATION'
       and (${order}::text is null or c.order_number = ${order})
       and (k.status is null or k.status in ('FAILED', 'NOT_CONFIGURED'))
       and not exists (select 1 from production_confirmation_cancellation x where x.client = c.client and x.confirmation_number = c.confirmation_number)
     order by c.posting_date, c.confirmation_number, a.parameter
     limit ${limit}
  `) as unknown as Array<{ confirmation_number: string; order_number: string; parameter: string; quantity: string; unit: string; posting_date: string; state: string }>;
  return rows.map((row) => ({
    confirmationNumber: row.confirmation_number, orderNumber: row.order_number, parameter: row.parameter, quantity: row.quantity,
    unit: row.unit, postingDate: row.posting_date, state: row.state as UncostedConfirmation['state'],
  }));
}

export interface BackfillResult {
  preview: boolean;
  confirmations: number;
  runs: CostRun[];
}

/**
 * Process eligible uncosted confirmations — an explicit, authorised action. `preview` values them and writes
 * nothing; the update posts each through the same idempotent path as a first posting, one transaction per
 * confirmation, so a repeat or a concurrent run posts nothing twice.
 */
export async function processUncostedConfirmations(
  client: string,
  options: { by: string; authorization?: ServiceAuthorityContext; capability: string; orderNumber?: string; limit?: number; preview: boolean },
): Promise<BackfillResult> {
  const listed = await withTenant(client, (tx) => listUncostedConfirmations(tx, client, { orderNumber: options.orderNumber, limit: options.limit }));
  const numbers = [...new Set(listed.map((row) => row.confirmationNumber))];
  const runs: CostRun[] = [];
  for (const number of numbers) {
    runs.push(options.preview
      ? await previewConfirmationCost(client, number, options.by)
      : await costConfirmation(client, number, options));
  }
  return { preview: options.preview, confirmations: numbers.length, runs };
}
