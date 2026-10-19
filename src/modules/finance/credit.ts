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
    for (const record of recordRows as unknown as Array<Record<string, unknown>>) {
      const customer = String(record.customer);
      const area = String(record.credit_control_area);
      const key = `${customer}|${area}`;
      seen.add(key);
      const exposure = exposureByKey.get(key)?.exposure ?? 0n;
      const limit = toScaled(String(record.credit_limit));
      drafts.push({
        customer, customerName: String(record.customer_name), creditControlArea: area,
        companyCodes: exposureByKey.get(key)?.companies ?? [],
        creditLimit: Number(fromScaled(limit)), creditCurrency: String(record.credit_currency),
        arExposure: Number(fromScaled(exposure)), orderExposure: null, deliveryExposure: null, billingExposure: null,
        totalExposure: Number(fromScaled(exposure)),
        availableCredit: Number(fromScaled(limit - exposure)),
        utilizationPercent: limit === 0n ? null : Number(exposure) / Number(limit) * 100,
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
      drafts.push({
        customer, customerName: String((nameRows as unknown as Array<{ name: string }>)[0]?.name ?? customer),
        creditControlArea: area, companyCodes: value.companies,
        creditLimit: null, creditCurrency: areaCurrency.get(area) ?? '',
        arExposure: Number(fromScaled(value.exposure)), orderExposure: null, deliveryExposure: null, billingExposure: null,
        totalExposure: Number(fromScaled(value.exposure)), availableCredit: null, utilizationPercent: null,
        riskCategory: null, isBlocked: false, blockReason: null,
        noCreditRecord: true, limitExpired: false, conversionMissing: false, lastUpdated: null,
        exposureScaled: value.exposure, limitScaled: null,
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
    return { rows, totalCustomers, calculatedAt, reportingCurrency: filter.reportingCurrency ?? null };
  });
}

/* ------------------------------------------------------------------ */
/* Credit-blocked document release (SCR-105 / FIN.CREDIT.RELEASE)      */
/* ------------------------------------------------------------------ */

export const CREDIT_RELEASE_CAPABILITY = 'FIN.CREDIT.RELEASE';
export const CREDIT_OVERRIDE_CAPABILITY = 'FIN.CREDIT.OVERRIDE';

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

export async function checkSalesDocumentCredit(input: {
  client: string; changedBy: string; salesDocument: string; documentDate: string;
  salesOrg?: string; customer: string; creditControlArea: string;
  orderValue: string; orderCurrency: string;
}): Promise<CreditDeterminationView> {
  const document = input.salesDocument.trim();
  if (!document || document.length > 20) fail('A sales document key of at most 20 characters is required.');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.documentDate)) fail('A valid document date is required.');
  const value = (() => { try { return toScaled(input.orderValue || '0'); } catch { return fail('The order value is not a valid amount.'); } })();
  if (value < 0n) fail('The order value cannot be negative.');

  const check = await evaluateCreditCheck({
    client: input.client, customer: input.customer, creditControlArea: input.creditControlArea,
    amount: input.orderValue,
  });
  const status: DeterminationStatus = check.decision === 'BLOCK' ? 'BLOCKED' : 'PASSED';
  const determinationId = newDeterminationId();

  await withTenant(input.client, async (tx) => {
    await assertPartner(tx, input.client, input.customer);
    const previous = await currentDeterminationIn(tx, input.client, document);
    await tx.execute(sql`
      insert into credit_determination
        (client, determination_id, sales_document, document_date, sales_org, customer, credit_control_area,
         order_value, order_currency, status, reason, exposure_at_check, limit_at_check, supersedes, created_by)
      values (${input.client}, ${determinationId}, ${document}, ${input.documentDate}, ${input.salesOrg ?? null},
              ${input.customer}, ${input.creditControlArea}, ${fromScaled(value)}, ${input.orderCurrency},
              ${status}, ${check.reason}, ${check.exposure.toFixed(4)}, ${check.creditLimit?.toFixed(4) ?? null},
              ${previous?.determination_id ?? null}, ${input.changedBy})
    `);
    await recordReleaseEvent(tx, input.client, determinationId, document, 'CHECK', input.changedBy,
      check.reason, undefined, previous?.status, status);
  });

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
         released_by, released_at, is_override, approval_ref, supersedes, created_by)
      values (${client}, ${determinationId}, ${current.sales_document}, ${current.document_date}, ${current.sales_org},
              ${current.customer}, ${current.credit_control_area}, ${current.order_value}, ${current.order_currency},
              'RELEASED', ${stillBlocked ? `OVERRIDE_${check.reason}` : 'RELEASED_AFTER_CHECK'},
              ${check.exposure.toFixed(4)}, ${check.creditLimit?.toFixed(4) ?? null},
              ${changedBy}, now(), ${stillBlocked}, ${input.override?.approvalRef ?? null},
              ${current.determination_id}, ${changedBy})
    `);
    await recordReleaseEvent(tx, client, determinationId, salesDocument,
      stillBlocked ? 'OVERRIDE_RELEASE' : 'RELEASE', changedBy,
      stillBlocked ? input.override?.justification.trim() : `Fresh check: ${check.reason}`,
      input.override?.approvalRef, 'BLOCKED', 'RELEASED');
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
         order_value, order_currency, status, reason, exposure_at_check, limit_at_check, supersedes, created_by)
      values (${input.client}, ${determinationId}, ${current.sales_document}, ${current.document_date}, ${current.sales_org},
              ${current.customer}, ${current.credit_control_area}, ${current.order_value}, ${current.order_currency},
              'BLOCKED', ${reason}, ${check.exposure.toFixed(4)}, ${check.creditLimit?.toFixed(4) ?? null},
              ${current.determination_id}, ${input.changedBy})
    `);
    await recordReleaseEvent(tx, input.client, determinationId, input.salesDocument,
      'REBLOCK', input.changedBy, input.reason.trim() || `Fresh check: ${check.reason}`, undefined, 'RELEASED', 'BLOCKED');
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
