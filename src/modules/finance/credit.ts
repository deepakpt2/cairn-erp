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
import { fromScaled, toScaled } from '@/platform/posting/decimal';

type Tx = Parameters<Parameters<typeof withTenant>[1]>[0];

function fail(message: string, remedy?: string): never {
  throw new CreditError(message, remedy);
}

function newAuditId(): string {
  return `CA${Date.now().toString(36).toUpperCase()}${Math.floor(Math.random() * 46656).toString(36).toUpperCase().padStart(3, '0')}`.slice(0, 24);
}

const todayUtc = () => new Date().toISOString().slice(0, 10);

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

export async function getCreditExposure(client: string, customer: string, area: string): Promise<{ exposure: number; currency: string }> {
  return withTenant(client, async (tx) => {
    const areaRow = await loadArea(tx, client, area);
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

export async function evaluateCreditCheck(input: {
  client: string; customer: string; creditControlArea: string; amount?: string;
}): Promise<CreditCheckResult> {
  const amount = input.amount ? toScaled(input.amount) : 0n;
  return withTenant(input.client, async (tx) => {
    const areaRow = await loadArea(tx, input.client, input.creditControlArea);
    const rows = await tx.execute(sql`
      select * from customer_credit
      where client = ${input.client} and customer = ${input.customer} and credit_control_area = ${input.creditControlArea}
    `);
    const record = (rows as unknown as CreditRow[])[0];
    const exposure = await exposureIn(tx, input.client, input.customer, input.creditControlArea);
    if (!record) {
      return {
        decision: 'BLOCK' as const, reason: 'NO_CREDIT_RECORD',
        exposure: Number(fromScaled(exposure)), creditLimit: null, availableCredit: null, utilizationPercent: null,
      };
    }
    const limit = toScaled(record.credit_limit);
    const available = limit - exposure;
    const base = {
      exposure: Number(fromScaled(exposure)), creditLimit: Number(fromScaled(limit)),
      availableCredit: Number(fromScaled(available)),
      utilizationPercent: limit === 0n ? null : Number(exposure) / Number(limit) * 100,
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
  });
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
  /** SD components have no canon yet: null = unavailable, never a silent zero. */
  orderExposure: number | null;
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
}
