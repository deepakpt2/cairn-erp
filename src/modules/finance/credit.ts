/**
 * Customer credit management (SCR-103 / FIN.CREDIT.MAINTAIN, FD32).
 *
 * One credit record per customer and credit control area on the
 * canonical partner and area masters, with an append-only field
 * audit. Exposure derives at read time from open FI-AR items
 * across the companies of the area — never double-counted, never
 * silently bypassed: the credit-check evaluation blocks on a
 * missing record, a manual hold, an expired or zero limit, or an
 * exceeded limit, and warns at the area's configured threshold.
 */

export const CREDIT_CAPABILITY = 'FIN.CREDIT.MAINTAIN';

export const CREDIT_DECISIONS = ['OK', 'WARN', 'BLOCK'] as const;
export type CreditDecision = (typeof CREDIT_DECISIONS)[number];

export const CREDIT_BLOCK_REASONS = [
  'NO_CREDIT_RECORD', 'MANUAL_HOLD', 'LIMIT_EXPIRED', 'ZERO_LIMIT', 'LIMIT_EXCEEDED',
] as const;

export interface CustomerCreditView {
  customer: string;
  customerName: string;
  creditControlArea: string;
  creditLimit: number;
  creditCurrency: string;
  riskCategory: string;
  representativeGroup: string | null;
  validTo: string | null;
  limitExpired: boolean;
  customerCreditGroup: string | null;
  isBlocked: boolean;
  blockReason: string | null;
  exposure: number;
  openReceivables: number;
  availableCredit: number;
  utilizationPercent: number | null;
  version: number;
  updatedBy: string | null;
  updatedAt: string | null;
}

export interface CreditCheckResult {
  decision: CreditDecision;
  reason: string;
  exposure: number;
  creditLimit: number | null;
  availableCredit: number | null;
  utilizationPercent: number | null;
  /** The rate the judged amount was translated at, and the date that rate took effect. */
  rateUsed: string | null;
  rateDate: string | null;
  /** The judged amount in the area currency; zero when the check judges no new amount. */
  judgedAmount: number;
}

export interface CreditAuditView {
  auditId: string;
  field: string;
  previousValue: string | null;
  newValue: string | null;
  changedBy: string;
  changeReason: string;
  changedAt: string;
}

export class CreditError extends Error {
  remedy?: string;

  constructor(message: string, remedy?: string) {
    super(message);
    this.name = 'CreditError';
    this.remedy = remedy;
  }
}

import { sql } from 'drizzle-orm';
import { withTenant } from '@/platform/db/client';
import { MONEY_SCALE, fromScaled, toScaled } from '@/platform/posting/decimal';
import { moneyFor } from '@/platform/posting/money';
import {
  ExchangeRateLookupError, translateAmount, requireExchangeRate,
} from '@/modules/finance/exchange-rate-lookup';
import { enqueue } from '@/platform/job/queue';
import { creatorOf } from '@/platform/notification/creator';
import { notifyOn } from '@/platform/notification/notify';
import { FANOUT_JOB } from '@/platform/notification/jobs/fanout';
// The exposure basis is stated by the product document as open orders plus open deliveries plus open
// receivables. The receivable half is this module's own ledger read; the sales halves can only be counted by
// the module that owns those documents, so the ladder asks the owner instead of reading its tables (§5.1).
import { openSalesCommitmentBuckets } from '@/modules/sales/exposure';

type Tx = Parameters<Parameters<typeof withTenant>[1]>[0];

function fail(message: string, remedy?: string): never {
  throw new CreditError(message, remedy);
}

function newAuditId(): string {
  return `CA${Date.now().toString(36).toUpperCase()}${Math.floor(Math.random() * 46656).toString(36).toUpperCase().padStart(3, '0')}`.slice(0, 24);
}

const todayUtc = () => new Date().toISOString().slice(0, 10);

/**
 * The rate type a credit check translates at.
 *
 * AVERAGE, the same rate the exposure monitor uses for its reporting-currency conversion (`rateType`
 * below) and the same one the ledger uses when it carries a foreign document into the local currency.
 * A credit check is a comparison against a limit that was itself written in local terms, so it must use
 * the rate the limit's own book already stands at; a spot or buying/selling rate would judge the same
 * order differently on different days and could never be reconciled to the receivable it later becomes.
 *
 * The date that selects the rate is the **document's own date** — the order's order date, or the
 * delivery's posting date — not today's. The comparison then matches the basis it is compared against:
 * exposure is `amount_local` as the ledger carried it, every line translated at its own posting date,
 * so translating the judged amount at its document date compares like with like. Re-judging an old
 * order therefore restates it at its own rate instead of inventing a gain or loss the documents never
 * posted.
 */
export const CREDIT_CHECK_RATE_TYPE = 'AVERAGE';

/**
 * How old an AVERAGE rate may be before a credit check refuses to use it, in days.
 *
 * 45 is the default: a rate older than a quarter is not a rate the limit can be judged against, and a
 * stale row silently accepted is how an exposure slowly stops meaning anything. Configured per tenant in
 * `client_settings.flags` (`CREDIT_MAX_RATE_AGE_DAYS`), the same no-migration path the self-service
 * password switch uses; absent means the 45-day default stands.
 */
export const CREDIT_MAX_RATE_AGE_DAYS = 45;
export const CREDIT_MAX_RATE_AGE_FLAG = 'CREDIT_MAX_RATE_AGE_DAYS';

/** The configured maximum age, in days. Absent or unusable means the default. */
async function maxRateAgeDays(tx: Tx, client: string): Promise<number> {
  const rows = await tx.execute(sql`
    select flags from client_settings where client = ${client} limit 1
  `);
  const flags = (rows as unknown as Array<{ flags: Record<string, unknown> | null }>)[0]?.flags ?? {};
  const configured = Number(flags[CREDIT_MAX_RATE_AGE_FLAG]);
  return Number.isInteger(configured) && configured > 0 ? configured : CREDIT_MAX_RATE_AGE_DAYS;
}

interface AreaRow { credit_control_area: string; currency: string; warning_threshold_percent: number; is_active: boolean }

async function loadArea(tx: Tx, client: string, area: string): Promise<AreaRow> {
  const rows = await tx.execute(sql`
    select credit_control_area, currency, warning_threshold_percent, is_active
    from credit_control_area where client = ${client} and credit_control_area = ${area}
  `);
  const row = (rows as unknown as AreaRow[])[0];
  if (!row) fail(`Credit control area ${area} does not stand configured.`, 'Configure the credit control area first.');
  if (!row.is_active) fail(`Credit control area ${area} stands inactive.`);
  return row;
}

async function assertPartner(tx: Tx, client: string, customer: string): Promise<string> {
  const rows = await tx.execute(sql`
    select name from business_partner where client = ${client} and partner_number = ${customer}
  `);
  const row = (rows as unknown as Array<{ name: string }>)[0];
  if (!row) fail(`Customer ${customer} does not stand in this tenant.`, 'Create the customer master first.');
  return row.name;
}

/**
 * Refuse when a company assigned to the area keeps its books in a currency other than the area's.
 *
 * Exposure sums `amount_local`, which is each line's company local currency, and compares it with a
 * limit stated in the area's currency. That is only the same unit when the two agree. Every supported
 * path makes them agree — the standard structure writes the area's currency from the company's, and the
 * setup service refuses a second company whose currency differs (`createCreditControlAreaSetup`) — but
 * nothing at the database level enforces it, so an out-of-band assignment could still create the
 * mismatch. Refusing by name beats summing two currencies and calling the result an exposure, and it
 * beats assuming the invariant holds.
 */
async function refuseAreaCurrencyMismatch(
  tx: Tx, client: string, area: string, areaCurrency: string,
): Promise<void> {
  const rows = await tx.execute(sql`
    select c.company_code, c.currency
    from company_code c
    where c.client = ${client} and c.credit_control_area = ${area}
      and c.currency <> ${areaCurrency}
    order by c.company_code
  `);
  const mismatched = rows as unknown as Array<{ company_code: string; currency: string }>;
  if (mismatched.length === 0) return;
  const named = mismatched.map((r) => `${r.company_code} (${r.currency})`).join(', ');
  fail(
    `Credit control area ${area} stands in ${areaCurrency}, but company ${mismatched.length === 1 ? 'code' : 'codes'} ${named} keep their books in another currency, so their local exposure cannot be added to a limit in ${areaCurrency}.`,
    `Move the mismatched company to a credit control area in its own currency, or correct the assignment, then retry. Amounts are never summed across currencies.`,
  );
}

async function exposureIn(tx: Tx, client: string, customer: string, area: string): Promise<bigint> {
  const rows = await tx.execute(sql`
    select coalesce(sum(case when l.debit_credit = 'S' then l.amount_local else -l.amount_local end), 0)::text as exposure
    from journal_entry_line l
    join journal_entry e
      on e.client = l.client and e.document_number = l.document_number and e.fiscal_year = l.fiscal_year
    join company_code c
      on c.client = e.client and c.company_code = e.company_code and c.credit_control_area = ${area}
    where l.client = ${client} and l.business_partner = ${customer}
      and e.status = 'POSTED' and l.clearing_document is null
  `);
  return toScaled((rows as unknown as Array<{ exposure: string }>)[0]?.exposure ?? '0');
}

/**
 * The judged document's value in the credit control area's currency, with the rate and its date.
 *
 * The order or delivery states its value in its own document currency; the limit, the exposure and the
 * area's threshold are all in the area's currency (the company's), so the two can only be compared after
 * one is translated.
 *
 * No rate standing is a refusal, never a fallback: comparing unconverted figures is what the defect this
 * replaced did, and translating at 1 would understate a strong currency as badly. A rate older than the
 * tenant's maximum age is refused for the same reason — an ancient row is not a judgement of today's
 * commitment. The currency pair, the date and the row's own date are named in both refusals, with the
 * remedy, so an operator can maintain the rate and retry.
 *
 * The rate and its validity date are returned so the determination can record them: a blocked or released
 * document must be able to say which rate decided it.
 */
interface ConvertedAmount {
  /** Scaled at MONEY_SCALE, in the area currency. */
  units: bigint;
  /** The effective rate applied, at the ledger's 8 decimals. */
  rate: string;
  /** The rate row's `valid_from`, the date the rate took effect. Null for an identity rate. */
  rateDate: string | null;
}

async function judgedAmountInAreaCurrency(
  tx: Tx,
  client: string,
  input: { amount: string; amountCurrency: string; documentDate: string; areaCurrency: string },
): Promise<ConvertedAmount> {
  let amountUnits: bigint;
  try {
    amountUnits = toScaled(input.amount);
  } catch {
    fail('The order value is not a valid amount.');
  }
  const from = input.amountCurrency.trim().toUpperCase();
  const to = input.areaCurrency.trim().toUpperCase();
  // One currency needs no rate and therefore has no rate date to record or age to judge.
  if (from === to) return { units: amountUnits, rate: '1.00000000', rateDate: null };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.documentDate)) {
    fail(`Document date ${input.documentDate} is not a calendar date, so the rate for ${from} to ${to} cannot be selected.`,
      'Give the document a calendar date.');
  }
  let rate;
  try {
    rate = await requireExchangeRate(tx, client, from, to, input.documentDate, CREDIT_CHECK_RATE_TYPE);
  } catch (error) {
    if (error instanceof ExchangeRateLookupError) throw new CreditError(error.message, error.remedy);
    throw error;
  }
  if (rate.validFrom) {
    const ageDays = Math.round(
      (Date.parse(`${input.documentDate}T00:00:00Z`) - Date.parse(`${rate.validFrom}T00:00:00Z`)) / 86_400_000,
    );
    const limit = await maxRateAgeDays(tx, client);
    if (ageDays > limit) {
      fail(
        `The ${CREDIT_CHECK_RATE_TYPE} rate from ${from} to ${to} in force on ${input.documentDate} dates from ${rate.validFrom}, ${ageDays} days old, which exceeds the ${limit}-day maximum this tenant allows.`,
        `Maintain a ${CREDIT_CHECK_RATE_TYPE} rate for ${from} to ${to} valid on or after ${input.documentDate.slice(0, 10)} (Exchange Rates, CFG.FIN.EXRATE.MAINTAIN), then retry. A stale rate is never used to judge a credit limit.`,
      );
    }
  }
  // Rounded at the area currency's own decimals, so a KWD (3) comparison is judged in fils and a
  // two-decimal currency in cents, rather than at the ledger's storage scale.
  const targetScale = (await moneyFor(tx, to)).scale;
  const translated = translateAmount(amountUnits, MONEY_SCALE, targetScale, rate);
  return {
    units: translated * 10n ** BigInt(MONEY_SCALE - targetScale),
    rate: rate.effectiveRate,
    rateDate: rate.validFrom,
  };
}

/** One document-currency commitment bucket, and what it is worth in the area currency. */
export interface ConvertedCommitment {
  currency: string;
  /** The document date that selected the rate: the order date, or the delivery date. */
  documentDate: string;
  documents: number;
  /** The document-currency amount, exactly as the sales documents state it. */
  originalAmount: number;
  /** The effective rate applied; null when the document stands in the area's currency. */
  rate: number | null;
  /** The `valid_from` of the rate row; null when no rate was needed. */
  rateDate: string | null;
  /** The amount in the area currency. */
  convertedAmount: number;
}

/**
 * Every open sales commitment of one customer, translated into the area currency, bucket by bucket.
 *
 * Option A of the exposure-basis decision: foreign commitments are *in* the basis, converted at their own
 * document date with the same rate type, the same no-rate refusal and the same staleness rule the judged
 * amount uses. A customer's whole commitment is therefore compared with the limit in one currency, instead
 * of the foreign part being silently dropped.
 *
 * The same currency is still translated (by the identity), so a row always carries the rate and date it
 * was judged at rather than leaving a gap only foreign documents fill.
 */
async function convertedCommitments(
  tx: Tx, client: string, customer: string, areaCurrency: string, excludeSalesDocument?: string,
): Promise<{ total: bigint; buckets: ConvertedCommitment[] }> {
  const rows = await openSalesCommitmentBuckets(tx, client, excludeSalesDocument);
  const mine = rows.filter((row) => row.customer === customer);
  let total = 0n;
  const buckets: ConvertedCommitment[] = [];
  for (const row of mine) {
    const converted = await judgedAmountInAreaCurrency(tx, client, {
      amount: row.amount, amountCurrency: row.currency,
      documentDate: row.documentDate, areaCurrency,
    });
    total += converted.units;
    buckets.push({
      currency: row.currency,
      documentDate: row.documentDate,
      documents: row.documents,
      originalAmount: Number(fromScaled(toScaled(row.amount ?? '0'))),
      rate: converted.rateDate === null ? null : Number(converted.rate),
      rateDate: converted.rateDate,
      convertedAmount: Number(fromScaled(converted.units)),
    });
  }
  return { total, buckets };
}

export async function getCreditExposure(client: string, customer: string, area: string): Promise<{ exposure: number; currency: string }> {
  return withTenant(client, async (tx) => {
    const areaRow = await loadArea(tx, client, area);
    await refuseAreaCurrencyMismatch(tx, client, area, areaRow.currency);
    const exposure = await exposureIn(tx, client, customer, area);
    return { exposure: Number(fromScaled(exposure)), currency: areaRow.currency };
  });
}

interface CreditRow {
  credit_limit: string; credit_currency: string; risk_category: string;
  credit_representative_group: string | null; credit_limit_valid_to: string | null;
  customer_credit_group: string | null; is_on_hold: boolean; block_reason: string | null;
  version: number; updated_by: string | null; updated_at: Date | string | null;
}

export async function getCustomerCredit(client: string, customer: string, area: string): Promise<CustomerCreditView | null> {
  return withTenant(client, async (tx) => {
    const name = await assertPartner(tx, client, customer);
    const areaRow = await loadArea(tx, client, area);
    const rows = await tx.execute(sql`
      select * from customer_credit
      where client = ${client} and customer = ${customer} and credit_control_area = ${area}
    `);
    const record = (rows as unknown as CreditRow[])[0];
    const exposure = await exposureIn(tx, client, customer, area);
    if (!record) return null;
    const limit = toScaled(record.credit_limit);
    const available = limit - exposure;
    return {
      customer, customerName: name, creditControlArea: area,
      creditLimit: Number(fromScaled(limit)), creditCurrency: record.credit_currency,
      riskCategory: record.risk_category, representativeGroup: record.credit_representative_group,
      validTo: record.credit_limit_valid_to,
      limitExpired: Boolean(record.credit_limit_valid_to && record.credit_limit_valid_to < todayUtc()),
      customerCreditGroup: record.customer_credit_group,
      isBlocked: record.is_on_hold, blockReason: record.block_reason,
      exposure: Number(fromScaled(exposure)), openReceivables: Number(fromScaled(exposure)),
      availableCredit: Number(fromScaled(available)),
      utilizationPercent: limit === 0n ? null : Number(exposure) / Number(limit) * 100,
      version: record.version, updatedBy: record.updated_by,
      updatedAt: record.updated_at ? new Date(record.updated_at).toISOString() : null,
    };
  });
}

export interface CreditConfigView {
  areas: Array<{ code: string; currency: string; warningThresholdPercent: number }>;
  riskCategories: Array<{ code: string; name: string }>;
  representativeGroups: Array<{ code: string; name: string }>;
  creditGroups: Array<{ code: string; name: string }>;
  blockReasons: Array<{ code: string; name: string }>;
}

export async function listCreditConfig(client: string): Promise<CreditConfigView> {
  return withTenant(client, async (tx) => {
    const areas = await tx.execute(sql`
      select credit_control_area as code, currency, warning_threshold_percent from credit_control_area
      where client = ${client} and is_active = true order by credit_control_area
    `);
    const pick = async (table: string, code: string) => {
      const rows = await tx.execute(sql.raw(`select ${code} as code, name from ${table} where client = '${client.replaceAll("'", "''")}' and is_active = true order by ${code}`));
      return rows as unknown as Array<{ code: string; name: string }>;
    };
    return {
      areas: (areas as unknown as Array<{ code: string; currency: string; warning_threshold_percent: number }>).map((a) => ({
        code: a.code, currency: a.currency, warningThresholdPercent: Number(a.warning_threshold_percent),
      })),
      riskCategories: await pick('credit_risk_category', 'risk_category'),
      representativeGroups: await pick('credit_representative_group', 'group_code'),
      creditGroups: await pick('customer_credit_group', 'group_code'),
      blockReasons: await pick('credit_block_reason', 'reason_code'),
    };
  });
}

async function assertConfig(tx: Tx, client: string, table: string, column: string, value: string, label: string): Promise<void> {
  const rows = await tx.execute(sql.raw(
    `select 1 as ok from ${table} where client = '${client.replaceAll("'", "''")}' and ${column} = '${value.replaceAll("'", "''")}' and is_active = true`,
  ));
  if ((rows as unknown as unknown[]).length === 0) {
    fail(`${label} ${value} does not stand active in configuration.`, `Configure the ${label.toLowerCase()} first.`);
  }
}

export async function saveCustomerCredit(input: {
  client: string; changedBy: string; customer: string; creditControlArea: string;
  creditLimit: string; riskCategory: string;
  representativeGroup?: string; validTo?: string; customerCreditGroup?: string;
  isBlocked: boolean; blockReason?: string;
  changeReason: string; expectedVersion?: number;
}): Promise<CustomerCreditView> {
  const { client, changedBy } = input;
  const customer = input.customer.trim();
  const area = input.creditControlArea.trim();
  if (!customer) fail('A customer is required.');
  if (!area) fail('A credit control area is required.');
  if (!input.changeReason.trim()) fail('A change reason is mandatory for every credit change.', 'State why the credit data changes.');
  const limit = (() => { try { return toScaled(input.creditLimit || '0'); } catch { return fail('The credit limit is not a valid amount.'); } })();
  if (limit < 0n) fail('The credit limit cannot be negative.');
  if (input.validTo && !/^\d{4}-\d{2}-\d{2}$/.test(input.validTo)) fail('The limit valid-to date is invalid.');

  await withTenant(client, async (tx) => {
    await assertPartner(tx, client, customer);
    const areaRow = await loadArea(tx, client, area);
    const decimalsRows = await tx.execute(sql`
      select decimal_places from currency where code = ${areaRow.currency}
    `);
    const decimals = Number((decimalsRows as unknown as Array<{ decimal_places: number }>)[0]?.decimal_places ?? 2);
    const quantum = 10n ** BigInt(Math.max(0, 4 - decimals));
    if (limit % quantum !== 0n) {
      fail(`The credit limit exceeds the precision of ${areaRow.currency} (${decimals} decimal places).`);
    }
    await assertConfig(tx, client, 'credit_risk_category', 'risk_category', input.riskCategory, 'Risk category');
    if (input.representativeGroup) {
      await assertConfig(tx, client, 'credit_representative_group', 'group_code', input.representativeGroup, 'Representative group');
    }
    if (input.customerCreditGroup) {
      await assertConfig(tx, client, 'customer_credit_group', 'group_code', input.customerCreditGroup, 'Customer credit group');
    }
    if (input.isBlocked) {
      if (!input.blockReason) fail('A block reason is required when a manual credit hold is applied.');
      await assertConfig(tx, client, 'credit_block_reason', 'reason_code', input.blockReason, 'Block reason');
    }

    const existingRows = await tx.execute(sql`
      select * from customer_credit where client = ${client} and customer = ${customer} and credit_control_area = ${area}
    `);
    const existing = (existingRows as unknown as CreditRow[])[0];
    if (existing && input.expectedVersion !== undefined && input.expectedVersion !== existing.version) {
      fail(`This credit record changed since it was loaded (version ${existing.version}).`,
        'Reload the record and re-apply your change.');
    }

    const next = {
      credit_limit: fromScaled(limit), credit_currency: areaRow.currency,
      risk_category: input.riskCategory,
      credit_representative_group: input.representativeGroup || null,
      credit_limit_valid_to: input.validTo || null,
      customer_credit_group: input.customerCreditGroup || null,
      is_on_hold: input.isBlocked,
      block_reason: input.isBlocked ? (input.blockReason ?? null) : null,
    };
    const audit = async (field: string, previous: string | null, value: string | null) => {
      if (previous === value) return;
      await tx.execute(sql`
        insert into credit_change_audit
          (client, audit_id, customer, credit_control_area, field, previous_value, new_value, changed_by, change_reason)
        values (${client}, ${newAuditId()}, ${customer}, ${area}, ${field}, ${previous}, ${value}, ${changedBy}, ${input.changeReason.trim()})
      `);
    };

    if (!existing) {
      await tx.execute(sql`
        insert into customer_credit
          (client, customer, credit_control_area, credit_limit, credit_currency, risk_category,
           credit_representative_group, credit_limit_valid_to, customer_credit_group, is_on_hold, block_reason, created_by)
        values (${client}, ${customer}, ${area}, ${next.credit_limit}, ${next.credit_currency}, ${next.risk_category},
                ${next.credit_representative_group}, ${next.credit_limit_valid_to}, ${next.customer_credit_group},
                ${next.is_on_hold}, ${next.block_reason}, ${changedBy})
      `);
      await audit('credit_limit', null, next.credit_limit);
      await audit('credit_currency', null, next.credit_currency);
      await audit('risk_category', null, next.risk_category);
      await audit('credit_representative_group', null, next.credit_representative_group);
      await audit('credit_limit_valid_to', null, next.credit_limit_valid_to);
      await audit('customer_credit_group', null, next.customer_credit_group);
      await audit('is_on_hold', null, String(next.is_on_hold));
      await audit('block_reason', null, next.block_reason);
    } else {
      const updated = await tx.execute(sql`
        update customer_credit set
          credit_limit = ${next.credit_limit}, risk_category = ${next.risk_category},
          credit_representative_group = ${next.credit_representative_group},
          credit_limit_valid_to = ${next.credit_limit_valid_to},
          customer_credit_group = ${next.customer_credit_group},
          is_on_hold = ${next.is_on_hold}, block_reason = ${next.block_reason},
          version = version + 1, updated_by = ${changedBy}, updated_at = now()
        where client = ${client} and customer = ${customer} and credit_control_area = ${area}
          and version = ${existing.version}
        returning version
      `);
      if ((updated as unknown as unknown[]).length === 0) {
        fail('This credit record changed concurrently.', 'Reload the record and re-apply your change.');
      }
      await audit('credit_limit', fromScaled(toScaled(existing.credit_limit)), next.credit_limit);
      await audit('risk_category', existing.risk_category, next.risk_category);
      await audit('credit_representative_group', existing.credit_representative_group, next.credit_representative_group);
      await audit('credit_limit_valid_to', existing.credit_limit_valid_to, next.credit_limit_valid_to);
      await audit('customer_credit_group', existing.customer_credit_group, next.customer_credit_group);
      await audit('is_on_hold', String(existing.is_on_hold), String(next.is_on_hold));
      await audit('block_reason', existing.block_reason, next.block_reason);
    }
  });

  const view = await getCustomerCredit(client, customer, area);
  if (!view) fail('The credit record could not be reloaded.');
  return view;
}

export async function listCreditAudit(client: string, customer: string, area: string): Promise<CreditAuditView[]> {
  return withTenant(client, async (tx) => {
    const rows = await tx.execute(sql`
      select * from credit_change_audit
      where client = ${client} and customer = ${customer} and credit_control_area = ${area}
      order by changed_at desc, audit_id desc limit 200
    `);
    return (rows as unknown as Array<Record<string, unknown>>).map((r) => ({
      auditId: String(r.audit_id), field: String(r.field),
      previousValue: (r.previous_value as string) ?? null, newValue: (r.new_value as string) ?? null,
      changedBy: String(r.changed_by), changeReason: String(r.change_reason),
      changedAt: new Date(r.changed_at as string).toISOString(),
    }));
  });
}

export interface CreditCheckInput {
  client: string; customer: string; creditControlArea: string; amount?: string;
  /**
   * The currency `amount` stands in, and the document date that selects its rate. Required whenever
   * `amount` is given and its currency differs from the area's: the amount is translated into the area
   * currency before it is compared, and no rate standing is a refusal. Omit both for a check with no
   * new amount (the exposure alone).
   */
  amountCurrency?: string;
  documentDate?: string;
  /** The sales document being judged, kept out of the basis it is being judged against. */
  excludeSalesDocument?: string;
}

export async function evaluateCreditCheck(input: CreditCheckInput): Promise<CreditCheckResult> {
  return withTenant(input.client, (tx) => evaluateCreditCheckIn(tx, input));
}

/**
 * The check inside the caller's transaction, for the document save that must commit with its decision.
 * When the rate is missing or stale this throws, and the caller's transaction rolls the document back
 * with it — the document is never committed without the determination that judged it.
 */
async function evaluateCreditCheckIn(tx: Tx, input: CreditCheckInput): Promise<CreditCheckResult> {
    const areaRow = await loadArea(tx, input.client, input.creditControlArea);
    // Exposure is each line's company local currency; the limit is the area's. Verified, not assumed.
    await refuseAreaCurrencyMismatch(tx, input.client, input.creditControlArea, areaRow.currency);
    const rows = await tx.execute(sql`
      select * from customer_credit
      where client = ${input.client} and customer = ${input.customer} and credit_control_area = ${input.creditControlArea}
    `);
    const record = (rows as unknown as CreditRow[])[0];
    let exposure = await exposureIn(tx, input.client, input.customer, input.creditControlArea);
    // The un-billed half of the chain (§14.8): an order that has not gone out and a delivery that has not
    // been invoiced are both money the customer has committed to. Each bucket is translated at its own
    // document date, so a March order is judged on March's rate and not today's.
    const basis = await convertedCommitments(tx, input.client, input.customer, areaRow.currency, input.excludeSalesDocument);
    exposure += basis.total;
    // The amount under judgement is compared in the area's currency, never in its document currency:
    // a limit stated in KWD cannot be judged against a number that is a count of USD.
    let amount = 0n;
    let rateUsed: string | null = null;
    let rateDate: string | null = null;
    if (input.amount) {
      if (!input.amountCurrency) {
        fail(
          `The judged amount ${input.amount} does not state its currency, so it cannot be compared with a limit in ${areaRow.currency}.`,
          'Pass the document currency with the amount.',
        );
      }
      if (!input.documentDate) {
        fail(
          `The judged amount ${input.amount} does not state a document date, so no ${CREDIT_CHECK_RATE_TYPE} rate for ${input.amountCurrency} to ${areaRow.currency} can be selected.`,
          'Pass the document date with the amount.',
        );
      }
      const converted = await judgedAmountInAreaCurrency(tx, input.client, {
        amount: input.amount, amountCurrency: input.amountCurrency,
        documentDate: input.documentDate, areaCurrency: areaRow.currency,
      });
      amount = converted.units;
      rateUsed = converted.rate;
      rateDate = converted.rateDate;
    }
    const judgedAmount = Number(fromScaled(amount));
    if (!record) {
      return {
        decision: 'BLOCK' as const, reason: 'NO_CREDIT_RECORD',
        exposure: Number(fromScaled(exposure)), creditLimit: null, availableCredit: null, utilizationPercent: null,
        rateUsed, rateDate, judgedAmount,
      };
    }
    const limit = toScaled(record.credit_limit);
    const available = limit - exposure;
    const base = {
      exposure: Number(fromScaled(exposure)), creditLimit: Number(fromScaled(limit)),
      availableCredit: Number(fromScaled(available)),
      utilizationPercent: limit === 0n ? null : Number(exposure) / Number(limit) * 100,
      rateUsed, rateDate, judgedAmount,
    };
    if (record.is_on_hold) return { decision: 'BLOCK' as const, reason: 'MANUAL_HOLD', ...base };
    if (record.credit_limit_valid_to && record.credit_limit_valid_to < todayUtc()) {
      return { decision: 'BLOCK' as const, reason: 'LIMIT_EXPIRED', ...base };
    }
    if (limit === 0n) return { decision: 'BLOCK' as const, reason: 'ZERO_LIMIT', ...base };
    if (exposure + amount > limit) return { decision: 'BLOCK' as const, reason: 'LIMIT_EXCEEDED', ...base };
    const utilizationAfter = Number(exposure + amount) / Number(limit) * 100;
    if (utilizationAfter >= Number(areaRow.warning_threshold_percent)) {
      return { decision: 'WARN' as const, reason: 'WARNING_THRESHOLD', ...base, utilizationPercent: utilizationAfter };
    }
    return { decision: 'OK' as const, reason: 'WITHIN_LIMIT', ...base };
}

/* ------------------------------------------------------------------ */
/* Credit exposure monitor (SCR-104 / FIN.CREDIT.MONITOR, F.31)        */
/* ------------------------------------------------------------------ */

export const CREDIT_MONITOR_CAPABILITY = 'FIN.CREDIT.MONITOR';

export interface CreditMonitorFilter {
  areaFrom?: string;
  areaTo?: string;
  companyCode?: string;
  customerFrom?: string;
  customerTo?: string;
  riskCategory?: string;
  representativeGroup?: string;
  limitExceededOnly?: boolean;
  blockedOnly?: boolean;
  reportingCurrency?: string;
  rateType?: string;
}

export interface CreditMonitorRow {
  customer: string;
  customerName: string;
  creditControlArea: string;
  companyCodes: string[];
  creditLimit: number | null;
  creditCurrency: string;
  arExposure: number;
  /**
   * The standing open sales commitment in the credit basis, converted into the credit currency: open
   * order and delivery value, each document translated at its own date. Null where nothing stands.
   */
  orderExposure: number | null;
  /**
   * The same commitment broken down per document currency, with the rate and rate date used and the
   * converted figure. The converted total is never shown alone: a reader must be able to see which
   * currencies and which rates produced it.
   */
  commitmentBreakdown: ConvertedCommitment[];
  deliveryExposure: number | null;
  billingExposure: number | null;
  totalExposure: number;
  availableCredit: number | null;
  utilizationPercent: number | null;
  riskCategory: string | null;
  isBlocked: boolean;
  blockReason: string | null;
  noCreditRecord: boolean;
  limitExpired: boolean;
  conversionMissing: boolean;
  lastUpdated: string | null;
}

export interface CreditMonitorResult {
  rows: CreditMonitorRow[];
  totalCustomers: number;
  calculatedAt: string;
  reportingCurrency: string | null;
  /** The rate type every commitment and judged amount in this result was translated at. */
  rateType: string;
  /** The tenant's maximum rate age in days, so a reader can tell a fresh rate from a tolerated one. */
  maxRateAgeDays: number;
}

const PAGE_CAP = 200;
const RATE_TYPES = ['AVERAGE', 'BUYING', 'SELLING'] as const;

export async function listCreditMonitor(client: string, filter: CreditMonitorFilter): Promise<CreditMonitorResult> {
  const calculatedAt = new Date().toISOString();
  return withTenant(client, async (tx) => {
    // Judge every supplied filter value against standing configuration.
    const areaRows = await tx.execute(sql`
      select credit_control_area, currency from credit_control_area where client = ${client} and is_active = true
    `);
    const areas = areaRows as unknown as Array<{ credit_control_area: string; currency: string }>;
    const areaCurrency = new Map(areas.map((a) => [a.credit_control_area, a.currency]));
    for (const [value, label] of [[filter.areaFrom, 'area from'], [filter.areaTo, 'area to']] as const) {
      if (value && !areaCurrency.has(value)) fail(`Credit control area ${value} (${label}) does not stand configured.`);
    }
    if (filter.riskCategory) {
      await assertConfig(tx, client, 'credit_risk_category', 'risk_category', filter.riskCategory, 'Risk category');
    }
    if (filter.representativeGroup) {
      await assertConfig(tx, client, 'credit_representative_group', 'group_code', filter.representativeGroup, 'Representative group');
    }
    if (filter.companyCode) {
      const company = await tx.execute(sql`
        select 1 as ok from company_code where client = ${client} and company_code = ${filter.companyCode}
      `);
      if ((company as unknown as unknown[]).length === 0) fail(`Company code ${filter.companyCode} does not stand.`);
    }
    if (filter.reportingCurrency) {
      const currency = await tx.execute(sql`select 1 as ok from currency where code = ${filter.reportingCurrency} and is_active = true`);
      if ((currency as unknown as unknown[]).length === 0) fail(`Reporting currency ${filter.reportingCurrency} does not stand.`);
    }
    const rateType = filter.rateType && (RATE_TYPES as readonly string[]).includes(filter.rateType) ? filter.rateType : 'AVERAGE';

    const inAreaRange = (area: string) =>
      (!filter.areaFrom || area >= filter.areaFrom) && (!filter.areaTo || area <= filter.areaTo);
    const inCustomerRange = (customer: string) =>
      (!filter.customerFrom || customer >= filter.customerFrom) && (!filter.customerTo || customer <= filter.customerTo);

    // Credit records in scope.
    const recordRows = await tx.execute(sql`
      select c.*, p.name as customer_name from customer_credit c
      join business_partner p on p.client = c.client and p.partner_number = c.customer
      where c.client = ${client}
        ${filter.areaFrom ? sql`and c.credit_control_area >= ${filter.areaFrom}` : sql``}
        ${filter.areaTo ? sql`and c.credit_control_area <= ${filter.areaTo}` : sql``}
        ${filter.customerFrom ? sql`and c.customer >= ${filter.customerFrom}` : sql``}
        ${filter.customerTo ? sql`and c.customer <= ${filter.customerTo}` : sql``}
        ${filter.riskCategory ? sql`and c.risk_category = ${filter.riskCategory}` : sql``}
        ${filter.representativeGroup ? sql`and c.credit_representative_group = ${filter.representativeGroup}` : sql``}
    `);

    // Open AR exposure aggregated per customer and area before any join.
    const exposureRows = await tx.execute(sql`
      select l.business_partner as customer, c.credit_control_area as area,
             string_agg(distinct e.company_code, ',' order by e.company_code) as companies,
             coalesce(sum(case when l.debit_credit = 'S' then l.amount_local else -l.amount_local end), 0)::text as exposure
      from journal_entry_line l
      join journal_entry e
        on e.client = l.client and e.document_number = l.document_number and e.fiscal_year = l.fiscal_year
      join company_code c
        on c.client = e.client and c.company_code = e.company_code and c.credit_control_area is not null
      where l.client = ${client} and l.business_partner is not null
        and e.status = 'POSTED' and l.clearing_document is null
        ${filter.companyCode ? sql`and e.company_code = ${filter.companyCode}` : sql``}
        ${filter.customerFrom ? sql`and l.business_partner >= ${filter.customerFrom}` : sql``}
        ${filter.customerTo ? sql`and l.business_partner <= ${filter.customerTo}` : sql``}
      group by l.business_partner, c.credit_control_area
    `);
    const exposureByKey = new Map<string, { exposure: bigint; companies: string[] }>();
    for (const row of exposureRows as unknown as Array<{ customer: string; area: string; companies: string; exposure: string }>) {
      if (!inAreaRange(row.area)) continue;
      exposureByKey.set(`${row.customer}|${row.area}`, {
        exposure: toScaled(row.exposure ?? '0'),
        companies: row.companies ? row.companies.split(',') : [],
      });
    }

    interface RowDraft extends CreditMonitorRow { exposureScaled: bigint; limitScaled: bigint | null }
    const drafts: RowDraft[] = [];
    const seen = new Set<string>();

    // The order half of the basis, converted per document currency and date. Read from the documents'
    // owner, and not caught: a broken read must fail the monitor, never quietly report a zero commitment.
    // The customer's area currency is the one its credit record names; a customer with several areas is
    // converted once per area, keyed by `customer|areaCurrency`.
    const maxAge = await maxRateAgeDays(tx, client);
    const areaCurrencyByCustomer = new Map<string, string>();
    for (const record of recordRows as unknown as Array<Record<string, unknown>>) {
      areaCurrencyByCustomer.set(String(record.customer), String(record.credit_currency));
    }
    const openBuckets = await openSalesCommitmentBuckets(tx, client);
    const convertedByCustomer = new Map<string, { total: bigint; buckets: ConvertedCommitment[] }>();
    for (const [customer, areaCurrency] of areaCurrencyByCustomer) {
      const mine = openBuckets.filter((row) => row.customer === customer);
      let total = 0n;
      const buckets: ConvertedCommitment[] = [];
      for (const row of mine) {
        const converted = await judgedAmountInAreaCurrency(tx, client, {
          amount: row.amount, amountCurrency: row.currency,
          documentDate: row.documentDate, areaCurrency,
        });
        total += converted.units;
        buckets.push({
          currency: row.currency,
          documentDate: row.documentDate,
          documents: row.documents,
          originalAmount: Number(fromScaled(toScaled(row.amount ?? '0'))),
          rate: converted.rateDate === null ? null : Number(converted.rate),
          rateDate: converted.rateDate,
          convertedAmount: Number(fromScaled(converted.units)),
        });
      }
      convertedByCustomer.set(customer, { total, buckets });
    }

    for (const record of recordRows as unknown as Array<Record<string, unknown>>) {
      const customer = String(record.customer);
      const area = String(record.credit_control_area);
      const key = `${customer}|${area}`;
      seen.add(key);
      const exposure = exposureByKey.get(key)?.exposure ?? 0n;
      const areaCurrency = String(record.credit_currency);
      const commitment = convertedByCustomer.get(customer) ?? { total: 0n, buckets: [] };
      const orderCommitment = commitment.total;
      const limit = toScaled(String(record.credit_limit));
      drafts.push({
        customer, customerName: String(record.customer_name), creditControlArea: area,
        companyCodes: exposureByKey.get(key)?.companies ?? [],
        creditLimit: Number(fromScaled(limit)), creditCurrency: areaCurrency,
        arExposure: Number(fromScaled(exposure)),
        orderExposure: Number(fromScaled(orderCommitment)),
        commitmentBreakdown: commitment.buckets,
        deliveryExposure: null, billingExposure: null,
        // The same basis the ladder compares: open receivables plus the standing open commitments.
        totalExposure: Number(fromScaled(exposure + orderCommitment)),
        availableCredit: Number(fromScaled(limit - exposure - orderCommitment)),
        utilizationPercent: limit === 0n ? null : Number(exposure + orderCommitment) / Number(limit) * 100,
        riskCategory: String(record.risk_category),
        isBlocked: Boolean(record.is_on_hold), blockReason: (record.block_reason as string) ?? null,
        noCreditRecord: false,
        limitExpired: Boolean(record.credit_limit_valid_to && String(record.credit_limit_valid_to) < todayUtc()),
        conversionMissing: false,
        lastUpdated: record.updated_at ? new Date(record.updated_at as string).toISOString() : null,
        exposureScaled: exposure, limitScaled: limit,
      });
    }
    // Customers carrying exposure without any credit record: never hidden.
    for (const [key, value] of exposureByKey) {
      if (seen.has(key)) continue;
      const [customer, area] = key.split('|');
      if (!inCustomerRange(customer)) continue;
      if (filter.riskCategory || filter.representativeGroup) continue;
      const nameRows = await tx.execute(sql`
        select name from business_partner where client = ${client} and partner_number = ${customer}
      `);
      const areaCurrencyCode = areaCurrency.get(area) ?? '';
      // A customer with exposure but no credit record still has commitments; they are converted for the
      // area it is exposed in, so hiding them behind a missing record is not possible either.
      let commitment = convertedByCustomer.get(customer);
      if (!commitment) {
        let total = 0n;
        const buckets: ConvertedCommitment[] = [];
        for (const row of openBuckets) {
          if (row.customer !== customer) continue;
          const converted = await judgedAmountInAreaCurrency(tx, client, {
            amount: row.amount, amountCurrency: row.currency,
            documentDate: row.documentDate, areaCurrency: areaCurrencyCode,
          });
          total += converted.units;
          buckets.push({
            currency: row.currency, documentDate: row.documentDate, documents: row.documents,
            originalAmount: Number(fromScaled(toScaled(row.amount ?? '0'))),
            rate: converted.rateDate === null ? null : Number(converted.rate),
            rateDate: converted.rateDate,
            convertedAmount: Number(fromScaled(converted.units)),
          });
        }
        commitment = { total, buckets };
        convertedByCustomer.set(customer, commitment);
      }
      const orderCommitment = commitment.total;
      drafts.push({
        customer, customerName: String((nameRows as unknown as Array<{ name: string }>)[0]?.name ?? customer),
        creditControlArea: area, companyCodes: value.companies,
        creditLimit: null, creditCurrency: areaCurrencyCode,
        arExposure: Number(fromScaled(value.exposure)),
        orderExposure: Number(fromScaled(orderCommitment)),
        commitmentBreakdown: commitment.buckets,
        deliveryExposure: null, billingExposure: null,
        totalExposure: Number(fromScaled(value.exposure + orderCommitment)), availableCredit: null, utilizationPercent: null,
        riskCategory: null, isBlocked: false, blockReason: null,
        noCreditRecord: true, limitExpired: false, conversionMissing: false, lastUpdated: null,
        exposureScaled: value.exposure + orderCommitment, limitScaled: null,
      });
    }

    // Optional reporting-currency conversion with the standing rates.
    if (filter.reportingCurrency) {
      for (const draft of drafts) {
        if (draft.creditCurrency === filter.reportingCurrency) continue;
        const rateRows = await tx.execute(sql`
          select rate::text as rate, ratio_from, ratio_to from exchange_rate
          where rate_type = ${rateType} and from_currency = ${draft.creditCurrency}
            and to_currency = ${filter.reportingCurrency} and valid_from <= ${todayUtc()}
          order by valid_from desc limit 1
        `);
        const rate = (rateRows as unknown as Array<{ rate: string; ratio_from: number; ratio_to: number }>)[0];
        if (!rate) { draft.conversionMissing = true; continue; }
        const factor = Number(rate.rate) * Number(rate.ratio_to) / Number(rate.ratio_from);
        draft.arExposure = draft.arExposure * factor;
        // Every component moves with the total, or the row would add up in two currencies.
        if (draft.orderExposure !== null) draft.orderExposure = draft.orderExposure * factor;
        if (draft.deliveryExposure !== null) draft.deliveryExposure = draft.deliveryExposure * factor;
        if (draft.billingExposure !== null) draft.billingExposure = draft.billingExposure * factor;
        draft.totalExposure = draft.totalExposure * factor;
        if (draft.creditLimit !== null) draft.creditLimit = draft.creditLimit * factor;
        if (draft.availableCredit !== null) draft.availableCredit = draft.availableCredit * factor;
        draft.creditCurrency = filter.reportingCurrency;
      }
    }

    const filtered = drafts.filter((draft) => {
      if (filter.blockedOnly && !draft.isBlocked) return false;
      if (filter.limitExceededOnly && !(draft.limitScaled !== null && draft.exposureScaled > draft.limitScaled)) return false;
      return true;
    });
    filtered.sort((a, b) => (b.utilizationPercent ?? -1) - (a.utilizationPercent ?? -1));
    const totalCustomers = filtered.length;
    const rows = filtered.slice(0, PAGE_CAP).map(({ exposureScaled: _e, limitScaled: _l, ...row }) => row);
    return {
      rows, totalCustomers, calculatedAt,
      reportingCurrency: filter.reportingCurrency ?? null,
      rateType,
      maxRateAgeDays: maxAge,
    };
  });
}

/* ------------------------------------------------------------------ */
/* Credit-blocked document release (SCR-105 / FIN.CREDIT.RELEASE)      */
/* ------------------------------------------------------------------ */

export const CREDIT_RELEASE_CAPABILITY = 'FIN.CREDIT.RELEASE';
export const CREDIT_OVERRIDE_CAPABILITY = 'FIN.CREDIT.OVERRIDE';

/**
 * The change-document class a sales document is recorded under. Spelled here
 * rather than imported: `sales/order` imports this module for its credit
 * check, and an import back the other way would be a cycle.
 */
const SALES_DOCUMENT_CLASS = 'sales_order';

/**
 * Who raised the fan-out run, in job_run.triggered_by.
 *
 * Not a person, for the same reason as the document release fan-out: the job
 * runtime reports a run's outcome to whoever triggered it, and the outcome of
 * a fan-out is not news. On success the people it wrote to already hold the
 * notification it just wrote.
 */
const CREDIT_ACTOR = 'CREDIT';

/**
 * Hand "who may clear this credit block" to the worker.
 *
 * The answer is a capability within a place, not a person: whoever holds
 * FIN.CREDIT.RELEASE over this credit control area and sales organisation.
 * Resolving that means loading every candidate's authority, so the transaction
 * records only what it already knows and the worker does the rest once the
 * determination is committed.
 *
 * Only a *new* block is worth a run. A determination is raised again on every
 * change to the document and on every manual recheck, and a document that was
 * blocked and still is has not told anybody anything they do not already have
 * unread in their inbox — the notification table's own deduplication would
 * swallow it, at the cost of a run and a resolution per save.
 */
async function enqueueCreditBlocked(
  tx: Tx,
  input: {
    client: string;
    salesDocument: string;
    determinationId: string;
    creditControlArea: string;
    salesOrg: string | null;
  },
): Promise<void> {
  const org: Record<string, string> = { creditControlArea: input.creditControlArea };
  if (input.salesOrg) org.salesOrg = input.salesOrg;

  await enqueue(tx, {
    client: input.client,
    jobCode: FANOUT_JOB,
    triggeredBy: CREDIT_ACTOR,
    idempotencyKey: `credit-blocked/${input.salesDocument}/${input.determinationId}`.slice(0, 120),
    parameters: {
      capability: CREDIT_RELEASE_CAPABILITY,
      org,
      kind: 'CREDIT.BLOCKED',
      objectClass: SALES_DOCUMENT_CLASS,
      objectKey: input.salesDocument,
      messageKey: 'notification.kind.CREDIT.BLOCKED',
      messageParams: { document: input.salesDocument },
    },
  });
}

export const DETERMINATION_STATUSES = ['BLOCKED', 'PASSED', 'RELEASED'] as const;
export type DeterminationStatus = (typeof DETERMINATION_STATUSES)[number];

export interface CreditDeterminationView {
  determinationId: string;
  salesDocument: string;
  documentDate: string;
  salesOrg: string | null;
  customer: string;
  customerName: string;
  creditControlArea: string;
  orderValue: number;
  orderCurrency: string;
  /** The effective rate the order value was translated at; null when judged in the area's currency. */
  rateUsed: number | null;
  /** The `valid_from` of that rate row: which rate date decided this document. */
  rateDate: string | null;
  status: DeterminationStatus;
  reason: string;
  exposureAtCheck: number;
  limitAtCheck: number | null;
  currentExposure: number;
  currentLimit: number | null;
  utilizationPercent: number | null;
  releasedBy: string | null;
  releasedAt: string | null;
  override: boolean;
  approvalRef: string | null;
  version: number;
  determinedAt: string;
}

export interface CreditReleaseFilter {
  areaFrom?: string;
  areaTo?: string;
  salesOrg?: string;
  customerFrom?: string;
  customerTo?: string;
  documentFrom?: string;
  documentTo?: string;
  representativeGroup?: string;
  dateFrom?: string;
  dateTo?: string;
  blockedOnly?: boolean;
  includeReleased?: boolean;
}

export interface ReleaseOutcome {
  salesDocument: string;
  ok: boolean;
  status: DeterminationStatus | null;
  message: string;
}

/* ------------------------------------------------------------------ */
/* Determinations and release processing                               */
/* ------------------------------------------------------------------ */

function newDeterminationId(): string {
  return `CD${Date.now().toString(36).toUpperCase()}${Math.floor(Math.random() * 46656).toString(36).toUpperCase().padStart(3, '0')}`.slice(0, 24);
}

interface DeterminationRow {
  determination_id: string; sales_document: string; document_date: string;
  sales_org: string | null; customer: string; credit_control_area: string;
  order_value: string; order_currency: string; status: DeterminationStatus; reason: string;
  exposure_at_check: string; limit_at_check: string | null;
  released_by: string | null; released_at: Date | string | null;
  is_override: boolean; approval_ref: string | null; supersedes: string | null;
  version: number; created_at: Date | string;
}

async function recordReleaseEvent(tx: Tx, client: string, determinationId: string, salesDocument: string,
  eventType: string, actor: string, reason?: string, approvalRef?: string,
  beforeStatus?: string, afterStatus?: string): Promise<void> {
  await tx.execute(sql`
    insert into credit_release_event
      (client, event_id, determination_id, sales_document, event_type, actor, reason, approval_ref, before_status, after_status)
    values (${client}, ${newDeterminationId()}, ${determinationId}, ${salesDocument}, ${eventType}, ${actor},
            ${reason ?? null}, ${approvalRef ?? null}, ${beforeStatus ?? null}, ${afterStatus ?? null})
  `);
}

async function currentDeterminationIn(tx: Tx, client: string, salesDocument: string): Promise<DeterminationRow | null> {
  const rows = await tx.execute(sql`
    select * from credit_determination
    where client = ${client} and sales_document = ${salesDocument}
    order by created_at desc, determination_id desc limit 1
  `);
  return (rows as unknown as DeterminationRow[])[0] ?? null;
}

export interface CheckSalesDocumentCreditInput {
  client: string; changedBy: string; salesDocument: string; documentDate: string;
  salesOrg?: string; customer: string; creditControlArea: string;
  orderValue: string; orderCurrency: string;
}

/**
 * The credit area the current determination of a document names, read inside the caller's
 * transaction. A changed order is re-judged in the area it already stood in, so a re-pricing does
 * not move an order to a different area and silently restate it.
 */
export async function creditAreaOfDocumentInTx(
  tx: Tx, client: string, salesDocument: string,
): Promise<string | null> {
  return (await currentDeterminationIn(tx, client, salesDocument))?.credit_control_area ?? null;
}

/**
 * Judge a sales document and record the determination inside the caller's transaction.
 *
 * This is the atomic half of the workflow: the order or delivery is written and judged in one
 * transaction, so a missing or stale exchange rate — which throws from `evaluateCreditCheckIn` —
 * rolls the document back rather than leaving it committed and unjudged. The returned view is built
 * from the values just written; it does not re-read via the monitor, which would open a second
 * transaction and cannot see inside this one.
 */
export async function checkSalesDocumentCreditInTx(
  tx: Tx, input: CheckSalesDocumentCreditInput,
): Promise<CreditDeterminationView> {
  const document = input.salesDocument.trim();
  if (!document || document.length > 20) fail('A sales document key of at most 20 characters is required.');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.documentDate)) fail('A valid document date is required.');
  const value = (() => { try { return toScaled(input.orderValue || '0'); } catch { return fail('The order value is not a valid amount.'); } })();
  if (value < 0n) fail('The order value cannot be negative.');

  const check = await evaluateCreditCheckIn(tx, {
    client: input.client, customer: input.customer, creditControlArea: input.creditControlArea,
    amount: input.orderValue, amountCurrency: input.orderCurrency, documentDate: input.documentDate,
    excludeSalesDocument: document,
  });
  const customerName = await assertPartner(tx, input.client, input.customer);
  const status: DeterminationStatus = check.decision === 'BLOCK' ? 'BLOCKED' : 'PASSED';
  const determinationId = newDeterminationId();

  const previous = await currentDeterminationIn(tx, input.client, document);
  await tx.execute(sql`
    insert into credit_determination
      (client, determination_id, sales_document, document_date, sales_org, customer, credit_control_area,
       order_value, order_currency, status, reason, exposure_at_check, limit_at_check,
       rate_used, rate_date, supersedes, created_by)
    values (${input.client}, ${determinationId}, ${document}, ${input.documentDate}, ${input.salesOrg ?? null},
            ${input.customer}, ${input.creditControlArea}, ${fromScaled(value)}, ${input.orderCurrency},
            ${status}, ${check.reason}, ${check.exposure.toFixed(4)}, ${check.creditLimit?.toFixed(4) ?? null},
            ${check.rateUsed}, ${check.rateDate},
            ${previous?.determination_id ?? null}, ${input.changedBy})
  `);
  await recordReleaseEvent(tx, input.client, determinationId, document, 'CHECK', input.changedBy,
    check.reason, undefined, previous?.status, status);

  // A document that was already blocked and still is has not moved. Only the
  // transition into a block is an episode worth telling people about.
  if (status === 'BLOCKED' && previous?.status !== 'BLOCKED') {
    await enqueueCreditBlocked(tx, {
      client: input.client, salesDocument: document, determinationId,
      creditControlArea: input.creditControlArea, salesOrg: input.salesOrg ?? null,
    });
  }

  const exposureAfter = check.exposure + check.judgedAmount;
  return {
    determinationId, salesDocument: document, documentDate: input.documentDate,
    salesOrg: input.salesOrg ?? null, customer: input.customer, customerName,
    creditControlArea: input.creditControlArea,
    orderValue: Number(fromScaled(value)), orderCurrency: input.orderCurrency,
    rateUsed: check.rateUsed === null ? null : Number(check.rateUsed), rateDate: check.rateDate,
    status, reason: check.reason,
    exposureAtCheck: check.exposure, limitAtCheck: check.creditLimit,
    currentExposure: exposureAfter, currentLimit: check.creditLimit,
    utilizationPercent: check.creditLimit ? exposureAfter / check.creditLimit * 100 : null,
    releasedBy: null, releasedAt: null, override: false, approvalRef: null,
    version: 1, determinedAt: new Date().toISOString(),
  };
}

export async function checkSalesDocumentCredit(
  input: CheckSalesDocumentCreditInput,
): Promise<CreditDeterminationView> {
  const document = input.salesDocument.trim();
  const determinationId = await withTenant(input.client, async (tx) =>
    (await checkSalesDocumentCreditInTx(tx, input)).determinationId);

  const rows = await listCreditDeterminations(input.client, { documentFrom: document, documentTo: document, blockedOnly: false, includeReleased: true });
  const view = rows.find((r) => r.determinationId === determinationId) ?? rows[0];
  if (!view) fail('The determination could not be reloaded.');
  return view;
}

export async function listCreditDeterminations(client: string, filter: CreditReleaseFilter): Promise<CreditDeterminationView[]> {
  // Judge the filters that name configuration.
  await withTenant(client, async (tx) => {
    if (filter.areaFrom) await loadArea(tx, client, filter.areaFrom);
    if (filter.areaTo) await loadArea(tx, client, filter.areaTo);
    if (filter.representativeGroup) {
      await assertConfig(tx, client, 'credit_representative_group', 'group_code', filter.representativeGroup, 'Representative group');
    }
  });
  const monitor = await listCreditMonitor(client, {});
  const liveByKey = new Map(monitor.rows.map((r) => [`${r.customer}|${r.creditControlArea}`, r]));

  return withTenant(client, async (tx) => {
    const rows = await tx.execute(sql`
      select d.*, p.name as customer_name from credit_determination d
      join business_partner p on p.client = d.client and p.partner_number = d.customer
      where d.client = ${client}
        and not exists (
          select 1 from credit_determination newer
          where newer.client = d.client and newer.sales_document = d.sales_document
            and (newer.created_at, newer.determination_id) > (d.created_at, d.determination_id)
        )
        ${filter.areaFrom ? sql`and d.credit_control_area >= ${filter.areaFrom}` : sql``}
        ${filter.areaTo ? sql`and d.credit_control_area <= ${filter.areaTo}` : sql``}
        ${filter.salesOrg ? sql`and d.sales_org = ${filter.salesOrg}` : sql``}
        ${filter.customerFrom ? sql`and d.customer >= ${filter.customerFrom}` : sql``}
        ${filter.customerTo ? sql`and d.customer <= ${filter.customerTo}` : sql``}
        ${filter.documentFrom ? sql`and d.sales_document >= ${filter.documentFrom}` : sql``}
        ${filter.documentTo ? sql`and d.sales_document <= ${filter.documentTo}` : sql``}
        ${filter.dateFrom ? sql`and d.document_date >= ${filter.dateFrom}` : sql``}
        ${filter.dateTo ? sql`and d.document_date <= ${filter.dateTo}` : sql``}
      order by d.document_date desc, d.sales_document
      limit 500
    `);
    let views = (rows as unknown as Array<Record<string, unknown>>).map((r) => {
      const live = liveByKey.get(`${String(r.customer)}|${String(r.credit_control_area)}`);
      const limit = r.limit_at_check !== null && r.limit_at_check !== undefined ? Number(r.limit_at_check) : null;
      const currentLimit = live?.noCreditRecord ? null : (live?.creditLimit ?? limit);
      const currentExposure = live?.totalExposure ?? Number(r.exposure_at_check);
      return {
        determinationId: String(r.determination_id), salesDocument: String(r.sales_document),
        documentDate: String(r.document_date), salesOrg: (r.sales_org as string) ?? null,
        customer: String(r.customer), customerName: String(r.customer_name),
        creditControlArea: String(r.credit_control_area),
        orderValue: Number(r.order_value), orderCurrency: String(r.order_currency),
        rateUsed: r.rate_used === null || r.rate_used === undefined ? null : Number(r.rate_used),
        rateDate: r.rate_date ? String(r.rate_date) : null,
        status: r.status as DeterminationStatus, reason: String(r.reason),
        exposureAtCheck: Number(r.exposure_at_check), limitAtCheck: limit,
        currentExposure, currentLimit,
        utilizationPercent: currentLimit ? currentExposure / currentLimit * 100 : null,
        releasedBy: (r.released_by as string) ?? null,
        releasedAt: r.released_at ? new Date(r.released_at as string).toISOString() : null,
        override: Boolean(r.is_override), approvalRef: (r.approval_ref as string) ?? null,
        version: Number(r.version), determinedAt: new Date(r.created_at as string).toISOString(),
      } satisfies CreditDeterminationView;
    });
    if (filter.representativeGroup) {
      const records = await tx.execute(sql`
        select customer, credit_control_area from customer_credit
        where client = ${client} and credit_representative_group = ${filter.representativeGroup}
      `);
      const allowed = new Set((records as unknown as Array<{ customer: string; credit_control_area: string }>)
        .map((r) => `${r.customer}|${r.credit_control_area}`));
      views = views.filter((v) => allowed.has(`${v.customer}|${v.creditControlArea}`));
    }
    // Queue semantics: blocked documents always show; released
    // only on request; passed only when blocked-only is off.
    return views.filter((v) => {
      if (v.status === 'BLOCKED') return true;
      if (v.status === 'RELEASED') return filter.includeReleased === true;
      return filter.blockedOnly === false;
    });
  });
}

async function loadCurrentOrFail(client: string, salesDocument: string): Promise<DeterminationRow> {
  return withTenant(client, async (tx) => {
    const current = await currentDeterminationIn(tx, client, salesDocument);
    if (!current) fail(`Sales document ${salesDocument} has no credit determination.`, 'Run a credit check for the document first.');
    return current;
  });
}

export async function recheckDocument(input: {
  client: string; changedBy: string; salesDocument: string;
}): Promise<CreditDeterminationView> {
  const current = await loadCurrentOrFail(input.client, input.salesDocument);
  return checkSalesDocumentCredit({
    client: input.client, changedBy: input.changedBy, salesDocument: current.sales_document,
    documentDate: current.document_date, salesOrg: current.sales_org ?? undefined,
    customer: current.customer, creditControlArea: current.credit_control_area,
    orderValue: fromScaled(toScaled(current.order_value)), orderCurrency: current.order_currency,
  });
}

export async function releaseDocument(input: {
  client: string; changedBy: string; salesDocument: string; expectedVersion?: number;
  override?: { justification: string; approvalRef?: string }; canOverride: boolean;
}): Promise<ReleaseOutcome> {
  const { client, changedBy, salesDocument } = input;
  const current = await loadCurrentOrFail(client, salesDocument);
  if (current.status !== 'BLOCKED') {
    return { salesDocument, ok: false, status: current.status, message: `Document stands ${current.status}; only a blocked document can be released.` };
  }
  if (input.expectedVersion !== undefined && input.expectedVersion !== current.version) {
    return { salesDocument, ok: false, status: current.status, message: 'The determination changed concurrently; reload before releasing.' };
  }
  const check = await evaluateCreditCheck({
    client, customer: current.customer, creditControlArea: current.credit_control_area,
    amount: fromScaled(toScaled(current.order_value)),
    amountCurrency: current.order_currency, documentDate: current.document_date,
    excludeSalesDocument: salesDocument,
  });
  const stillBlocked = check.decision === 'BLOCK';
  if (stillBlocked && !input.override) {
    return {
      salesDocument, ok: false, status: 'BLOCKED',
      message: `The fresh credit check still blocks (${check.reason}). Release needs an authorized override with justification.`,
    };
  }
  if (stillBlocked && !input.canOverride) {
    return {
      salesDocument, ok: false, status: 'BLOCKED',
      message: 'The fresh credit check still blocks and you do not hold the override privilege.',
    };
  }
  if (stillBlocked && !input.override?.justification.trim()) {
    return { salesDocument, ok: false, status: 'BLOCKED', message: 'An override release requires a justification.' };
  }

  const determinationId = newDeterminationId();
  await withTenant(client, async (tx) => {
    const fresh = await currentDeterminationIn(tx, client, salesDocument);
    if (!fresh || fresh.determination_id !== current.determination_id) {
      throw new CreditError('The determination changed concurrently; the release was not applied.');
    }
    await tx.execute(sql`
      insert into credit_determination
        (client, determination_id, sales_document, document_date, sales_org, customer, credit_control_area,
         order_value, order_currency, status, reason, exposure_at_check, limit_at_check,
         rate_used, rate_date,
         released_by, released_at, is_override, approval_ref, supersedes, created_by)
      values (${client}, ${determinationId}, ${current.sales_document}, ${current.document_date}, ${current.sales_org},
              ${current.customer}, ${current.credit_control_area}, ${current.order_value}, ${current.order_currency},
              'RELEASED', ${stillBlocked ? `OVERRIDE_${check.reason}` : 'RELEASED_AFTER_CHECK'},
              ${check.exposure.toFixed(4)}, ${check.creditLimit?.toFixed(4) ?? null},
              ${check.rateUsed}, ${check.rateDate},
              ${changedBy}, now(), ${stillBlocked}, ${input.override?.approvalRef ?? null},
              ${current.determination_id}, ${changedBy})
    `);
    await recordReleaseEvent(tx, client, determinationId, salesDocument,
      stillBlocked ? 'OVERRIDE_RELEASE' : 'RELEASE', changedBy,
      stillBlocked ? input.override?.justification.trim() : `Fresh check: ${check.reason}`,
      input.override?.approvalRef, 'BLOCKED', 'RELEASED');

    // The block is off and the document can go out. The person waiting for
    // that is the one who raised the document — which is the mirror of the
    // block itself, which went to the people who could clear it rather than
    // to whoever wanted it. Guessing a recipient is worse than telling
    // nobody, so with no change trail nothing is sent.
    const waiting = await creatorOf(tx, client, SALES_DOCUMENT_CLASS, salesDocument);
    if (waiting) {
      await notifyOn(tx, {
        client,
        recipient: waiting,
        kind: 'CREDIT.RELEASED',
        objectClass: SALES_DOCUMENT_CLASS,
        objectKey: salesDocument,
        messageKey: 'notification.kind.CREDIT.RELEASED',
        messageParams: { document: salesDocument },
      });
    }
  });
  return {
    salesDocument, ok: true, status: 'RELEASED',
    message: stillBlocked ? 'Released by override; justification and approval recorded.' : 'Released: the fresh credit check passes.',
  };
}

export async function releaseDocumentsBulk(input: {
  client: string; changedBy: string; salesDocuments: string[];
  overrides?: Record<string, { justification: string; approvalRef?: string }>; canOverride: boolean;
}): Promise<ReleaseOutcome[]> {
  const outcomes: ReleaseOutcome[] = [];
  for (const salesDocument of input.salesDocuments) {
    try {
      outcomes.push(await releaseDocument({
        client: input.client, changedBy: input.changedBy, salesDocument,
        override: input.overrides?.[salesDocument], canOverride: input.canOverride,
      }));
    } catch (error) {
      outcomes.push({
        salesDocument, ok: false, status: null,
        message: error instanceof Error ? error.message : 'Release failed.',
      });
    }
  }
  return outcomes;
}

export async function rejectReleaseRequest(input: {
  client: string; changedBy: string; salesDocument: string; reason: string;
}): Promise<ReleaseOutcome> {
  if (!input.reason.trim()) fail('A reason is mandatory to reject a release request.');
  const current = await loadCurrentOrFail(input.client, input.salesDocument);
  if (current.status !== 'BLOCKED') {
    return { salesDocument: input.salesDocument, ok: false, status: current.status, message: `Document stands ${current.status}; there is no open release request to reject.` };
  }
  await withTenant(input.client, async (tx) => {
    await recordReleaseEvent(tx, input.client, current.determination_id, input.salesDocument,
      'REJECT', input.changedBy, input.reason.trim(), undefined, 'BLOCKED', 'BLOCKED');
  });
  return { salesDocument: input.salesDocument, ok: true, status: 'BLOCKED', message: 'Release request rejected; the document remains blocked and untouched.' };
}

export async function reblockDocument(input: {
  client: string; changedBy: string; salesDocument: string; reason: string;
}): Promise<ReleaseOutcome> {
  const current = await loadCurrentOrFail(input.client, input.salesDocument);
  if (current.status !== 'RELEASED') {
    return { salesDocument: input.salesDocument, ok: false, status: current.status, message: `Document stands ${current.status}; only a released document can be reblocked.` };
  }
  // A fresh determination always precedes a reblock.
  const check = await evaluateCreditCheck({
    client: input.client, customer: current.customer, creditControlArea: current.credit_control_area,
    amount: fromScaled(toScaled(current.order_value)),
    amountCurrency: current.order_currency, documentDate: current.document_date,
    excludeSalesDocument: input.salesDocument,
  });
  const reason = check.decision === 'BLOCK' ? check.reason : 'MANUAL_REBLOCK';
  if (check.decision !== 'BLOCK' && !input.reason.trim()) {
    return { salesDocument: input.salesDocument, ok: false, status: 'RELEASED', message: 'The fresh check passes; reblocking then requires a stated reason.' };
  }
  const determinationId = newDeterminationId();
  await withTenant(input.client, async (tx) => {
    const fresh = await currentDeterminationIn(tx, input.client, input.salesDocument);
    if (!fresh || fresh.determination_id !== current.determination_id) {
      throw new CreditError('The determination changed concurrently; the reblock was not applied.');
    }
    await tx.execute(sql`
      insert into credit_determination
        (client, determination_id, sales_document, document_date, sales_org, customer, credit_control_area,
         order_value, order_currency, status, reason, exposure_at_check, limit_at_check,
         rate_used, rate_date, supersedes, created_by)
      values (${input.client}, ${determinationId}, ${current.sales_document}, ${current.document_date}, ${current.sales_org},
              ${current.customer}, ${current.credit_control_area}, ${current.order_value}, ${current.order_currency},
              'BLOCKED', ${reason}, ${check.exposure.toFixed(4)}, ${check.creditLimit?.toFixed(4) ?? null},
              ${check.rateUsed}, ${check.rateDate},
              ${current.determination_id}, ${input.changedBy})
    `);
    await recordReleaseEvent(tx, input.client, determinationId, input.salesDocument,
      'REBLOCK', input.changedBy, input.reason.trim() || `Fresh check: ${check.reason}`, undefined, 'RELEASED', 'BLOCKED');

    // A reblock is always a new episode: the document was released, and now
    // it is not, and whoever may clear it has to be told again.
    await enqueueCreditBlocked(tx, {
      client: input.client, salesDocument: input.salesDocument, determinationId,
      creditControlArea: current.credit_control_area, salesOrg: current.sales_org,
    });
  });
  return { salesDocument: input.salesDocument, ok: true, status: 'BLOCKED', message: `Reblocked after a fresh determination (${reason}).` };
}

export async function listReleaseEvents(client: string, salesDocument: string): Promise<Array<{
  eventId: string; eventType: string; actor: string; reason: string | null;
  beforeStatus: string | null; afterStatus: string | null; createdAt: string;
}>> {
  return withTenant(client, async (tx) => {
    const rows = await tx.execute(sql`
      select event_id, event_type, actor, reason, before_status, after_status, created_at
      from credit_release_event where client = ${client} and sales_document = ${salesDocument}
      order by created_at desc, event_id desc limit 200
    `);
    return (rows as unknown as Array<Record<string, unknown>>).map((r) => ({
      eventId: String(r.event_id), eventType: String(r.event_type), actor: String(r.actor),
      reason: (r.reason as string) ?? null, beforeStatus: (r.before_status as string) ?? null,
      afterStatus: (r.after_status as string) ?? null,
      createdAt: new Date(r.created_at as string).toISOString(),
    }));
  });
}
