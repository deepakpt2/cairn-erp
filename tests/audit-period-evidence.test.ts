/**
 * Period-close evidence pack (AUDIT.PERIOD.EVIDENCE, ITEM-21): authorization, snapshot, archive, lifecycle.
 *
 * Real database effects on the test database only. The worker is driven through the real claim / lease /
 * fence machinery (claimNext + runClaimed); crash windows are produced by reaping a live lease between the
 * artifact commit and the job's own success.
 */
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { sql } from 'drizzle-orm';
import { unzipSync } from 'fflate';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { recordChange } from '../src/platform/change';
import { withTenant, withTenantSnapshot } from '../src/platform/db/client';
import { claimNext, runClaimed } from '../src/platform/job/execute';
import { reapOrphans, requestCancel, retryRun } from '../src/platform/job/queue';
import { clearJobRegistry, registerJob } from '../src/platform/job/registry';
import { LeaseLostError } from '../src/platform/job/types';
import { neutraliseFormula } from '../src/modules/audit/period-evidence-archive';
import {
  AUDIT_PERIOD_PACK_JOB, cancelPeriodPack, cleanupExpiredPeriodPacks, downloadPeriodPack, getPeriodPackStatus,
  requestPeriodPack, runPeriodPackChunk, type PeriodPackView,
} from '../src/modules/audit/period-evidence';
import { collectEvidence, PeriodPackError } from '../src/modules/audit/period-evidence-data';
import { renderPack } from '../src/modules/audit/period-evidence-report';
import { AuditError, createAuditGrant, revokeAuditGrant } from '../src/modules/audit/workspace';
import { AUDITOR_CAPABILITIES, CONTROLLER_CAPABILITIES, createAuditActor, type AuditTestActor } from './helpers/audit-actor';
import { createTenant, destroyTenant, type TestTenant } from './helpers';

const DAY = 86_400_000;
const iso = (offsetDays: number) => new Date(Date.now() + offsetDays * DAY).toISOString().slice(0, 10);
const YEAR = Number(iso(0).slice(0, 4));
const EVIDENCE = 'AUDIT.PERIOD.EVIDENCE';
const SETUP = 'PACK_TEST';

let tenant: TestTenant;
let other: TestTenant;
let controller: AuditTestActor;
let ppv = '';
let seq = 0;

// ── Helpers ─────────────────────────────────────────────────────────────────

function useRealHandler(wrap?: (ctx: Parameters<typeof runPeriodPackChunk>[0], real: () => ReturnType<typeof runPeriodPackChunk>) => ReturnType<typeof runPeriodPackChunk>) {
  clearJobRegistry();
  registerJob({ code: AUDIT_PERIOD_PACK_JOB, chunk: (ctx) => (wrap ? wrap(ctx, () => runPeriodPackChunk(ctx)) : runPeriodPackChunk(ctx)) });
}

async function drive(heartbeatMs?: number): Promise<string[]> {
  const out: string[] = [];
  for (let i = 0; i < 10; i += 1) {
    const claimed = await claimNext('worker-intensive', ['INTENSIVE']);
    if (!claimed) break;
    out.push(await runClaimed('worker-intensive', claimed, heartbeatMs ? { heartbeatMs } : {}));
  }
  return out;
}

async function newAuditor(opts: { caps?: readonly string[]; scope?: Array<{ kind: 'COMPANY_CODE' | 'PERIOD' | 'MODULE'; value: string }>; companyScopes?: string[]; grant?: boolean } = {}) {
  const caps = opts.caps ?? [...AUDITOR_CAPABILITIES, EVIDENCE];
  const auditor = await createAuditActor(tenant.client, { capabilities: caps, companyScopes: opts.companyScopes });
  let grantId: string | null = null;
  if (opts.grant !== false) {
    const grant = await createAuditGrant({
      client: tenant.client, authorization: controller.authorization, auditorUserId: auditor.userId,
      validFrom: iso(-1), validTo: iso(30), reason: 'Period close evidence test',
      scope: opts.scope ?? [
        { kind: 'COMPANY_CODE', value: tenant.companyCode }, { kind: 'MODULE', value: 'FIN' },
        { kind: 'PERIOD', value: `${YEAR}12` }, { kind: 'PERIOD', value: `${YEAR}13` },
      ],
    });
    grantId = grant.grantId;
  }
  return { auditor, grantId };
}

const sel = (period = 12, year = YEAR, company = tenant.companyCode) => ({ companyCode: company, fiscalYear: year, postingPeriod: period });
const key = () => `test-key-${(seq += 1)}-${randomUUID().slice(0, 8)}`;
const request = (a: AuditTestActor, s = sel(), requestKey = key()) => requestPeriodPack(a.actor, { ...s, requestKey });

async function packRow(packId: string) {
  return ((await withTenant(tenant.client, (tx) => tx.execute(sql`
    select pack_id, status, error_code, byte_length, manifest_sha256, completed_at, expires_at, job_run_id, (artifact is not null) as has_artifact
      from audit_period_pack where client = ${tenant.client} and pack_id = ${packId}`))) as unknown as Array<Record<string, any>>)[0]!;
}
async function artifact(packId: string): Promise<Buffer> {
  const rows = (await withTenant(tenant.client, (tx) => tx.execute(sql`select artifact from audit_period_pack where client = ${tenant.client} and pack_id = ${packId}`))) as unknown as Array<{ artifact: Buffer }>;
  return Buffer.from(rows[0]!.artifact);
}
async function accessLog(userId: string) {
  return (await withTenant(tenant.client, (tx) => tx.execute(sql`
    select event_type, detail, grant_id, object_key from audit_access_log where client = ${tenant.client} and user_id = ${userId} order by occurred_at`))) as unknown as Array<{ event_type: string; detail: string | null; grant_id: string | null; object_key: string | null }>;
}
async function expectCode(promise: Promise<unknown>, code: string) {
  try { await promise; } catch (error) {
    expect((error as { code?: string }).code, (error as Error).message).toBe(code);
    return error as AuditError | PeriodPackError;
  }
  throw new Error(`Expected ${code}, but nothing was thrown.`);
}
/** Request, run the worker, return the finished pack id. */
async function buildPack(a: AuditTestActor, s = sel()): Promise<string> {
  useRealHandler();
  const view = await request(a, s);
  await drive();
  return view.packId;
}
function unzip(zip: Buffer) {
  const files = unzipSync(new Uint8Array(zip));
  return Object.fromEntries(Object.entries(files).map(([n, b]) => [n, Buffer.from(b)]));
}
/** A small RFC 4180 reader: proves quoted commas, quotes and newlines survive. */
function parseCsv(buf: Buffer): string[][] {
  const text = buf.toString('utf8');
  const rows: string[][] = [];
  let row: string[] = []; let field = ''; let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]!;
    if (quoted) {
      if (ch === '"') { if (text[i + 1] === '"') { field += '"'; i += 1; } else quoted = false; } else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') { row.push(field); field = ''; }
    else if (ch === '\r') { /* part of CRLF */ }
    else if (ch === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else field += ch;
  }
  return rows;
}
const table = (files: Record<string, Buffer>, name: string) => {
  const [header, ...rows] = parseCsv(files[name]!);
  return { header: header!, rows: rows.map((r) => Object.fromEntries(header!.map((h, i) => [h, r[i] ?? '']))) };
};

async function journal(client: string, company: string, doc: string, fy: number, period: number, extra: { status?: string; postedAt?: string; reversalOf?: string; reversedBy?: string; origin?: string; postingDate?: string; createdBy?: string } = {}) {
  await withTenant(client, (tx) => tx.execute(sql`
    insert into journal_entry (client, document_number, display_number, fiscal_year, document_type, company_code, document_date, posting_date, posting_period,
      document_currency, local_currency, status, created_by, posted_at, reversal_of, reversed_by, origin_class, origin_key, header_text, reference)
    values (${client}, ${doc}, ${doc}, ${fy}, 'SA', ${company}, ${extra.postingDate ?? `${fy}-06-15`}, ${extra.postingDate ?? `${fy}-06-15`}, ${period}, 'USD', 'USD',
      ${extra.status ?? 'POSTED'}, ${extra.createdBy ?? 'POSTER'}, ${extra.postedAt ?? new Date().toISOString()}, ${extra.reversalOf ?? null}, ${extra.reversedBy ?? null},
      ${extra.origin ? 'payroll_run' : null}, ${extra.origin ?? null}, 'SECRET-HEADER-TEXT', 'SECRET-REFERENCE')`));
}

beforeAll(async () => {
  tenant = await createTenant('audit-period-pack');
  other = await createTenant('audit-period-pack-other');
  await withTenant(tenant.client, async (tx) => {
    for (let p = 1; p <= 12; p += 1) {
      await tx.execute(sql`insert into fiscal_year_period (client, variant, calendar_year, period, period_type, month, day, year_shift, created_by)
        values (${tenant.client}, 'K4', 0, ${p}, 'REGULAR', ${p}, 28, 0, ${SETUP}) on conflict do nothing`);
    }
    for (const p of [13, 14]) {
      await tx.execute(sql`insert into fiscal_year_period (client, variant, calendar_year, period, period_type, month, day, year_shift, created_by)
        values (${tenant.client}, 'K4', 0, ${p}, 'SPECIAL', 12, 31, 0, ${SETUP}) on conflict do nothing`);
    }
    await tx.execute(sql`delete from fiscal_year_period where client = ${tenant.client} and variant = 'K4' and period > 14`);
    await tx.execute(sql`update fiscal_year_variant set special_periods = 4 where client = ${tenant.client} and variant = 'K4'`);
    const company = (await tx.execute(sql`select posting_period_variant from company_code where client = ${tenant.client} and company_code = ${tenant.companyCode}`)) as unknown as Array<{ posting_period_variant: string }>;
    ppv = company[0]!.posting_period_variant;
    await tx.execute(sql`delete from posting_period_rule where client = ${tenant.client} and variant = ${ppv}`);
    // S, K, D, A configured; M deliberately missing.
    for (const [type, from, to, special] of [['S', 1, 12, true], ['K', 1, 11, false], ['D', 1, 12, false], ['A', 1, 12, false]] as const) {
      await tx.execute(sql`insert into posting_period_rule (client, variant, account_type, period_from, period_to, allow_special_periods, created_by)
        values (${tenant.client}, ${ppv}, ${type}, ${from}, ${to}, ${special}, ${SETUP})`);
    }
  });
  controller = await createAuditActor(tenant.client, { capabilities: [...CONTROLLER_CAPABILITIES, 'AUDIT.WORKSPACE'] });
  useRealHandler();
}, 120_000);

afterAll(async () => {
  clearJobRegistry();
  if (tenant) await destroyTenant(tenant.client);
  if (other) await destroyTenant(other.client);
}, 60_000);

// ── 1. Authorization ────────────────────────────────────────────────────────

describe('authorization on request, worker, status and download', () => {
  it('an authorised auditor gets a QUEUED pack at once; the job carries only the pack id', async () => {
    const { auditor, grantId } = await newAuditor();
    const view = await request(auditor);
    expect(view.status).toBe('QUEUED');
    expect(view.packId).toMatch(/^[0-9a-f-]{36}$/);
    expect(view.downloadable).toBe(false);
    expect(view.limitations).toContain('UNKNOWN');
    const job = ((await withTenant(tenant.client, (tx) => tx.execute(sql`
      select j.parameters, d.queue, j.status, j.triggered_by from audit_period_pack p join job_run j on j.client = p.client and j.id = p.job_run_id
       join job_definition d on d.code = j.job_code
       where p.client = ${tenant.client} and p.pack_id = ${view.packId}`))) as unknown as Array<Record<string, any>>)[0]!;
    expect(job.parameters).toEqual({ packId: view.packId });
    expect(job.queue).toBe('INTENSIVE');
    expect(job.triggered_by).toBe(auditor.userId);
    const log = await accessLog(auditor.userId);
    expect(log.some((l) => l.event_type === 'EXPORT' && l.grant_id === grantId && l.object_key === view.packId)).toBe(true);
    await drive();
  });

  it.each([['AUDIT.WORKSPACE'], [EVIDENCE], ['AUDIT.EVIDENCE.EXPORT']])('refuses a requester missing %s, and the denial is committed', async (missing) => {
    const { auditor } = await newAuditor();
    await withTenant(tenant.client, (tx) => tx.execute(sql`delete from role_capability where client = ${tenant.client} and role_code = ${auditor.roleCode} and capability_code = ${missing}`));
    await expectCode(request(auditor), 'AUDIT_AUTHORITY');
    const log = await accessLog(auditor.userId);
    expect(log.filter((l) => l.event_type === 'CAPABILITY_DENIED').length).toBe(1);
    expect(log[0]!.detail).toContain(missing);
  });

  it('refuses a wrong company, a wrong period, a wrong module and no grant, each logged', async () => {
    const wrongCompany = await newAuditor({ scope: [{ kind: 'COMPANY_CODE', value: '2000' }, { kind: 'MODULE', value: 'FIN' }] }).catch(() => null);
    if (wrongCompany) await expectCode(request(wrongCompany.auditor), 'AUDIT_OUT_OF_SCOPE');
    const wrongPeriod = await newAuditor({ scope: [{ kind: 'COMPANY_CODE', value: tenant.companyCode }, { kind: 'MODULE', value: 'FIN' }, { kind: 'PERIOD', value: `${YEAR}11` }] });
    await expectCode(request(wrongPeriod.auditor, sel(12)), 'AUDIT_OUT_OF_SCOPE');
    const wrongModule = await newAuditor({ scope: [{ kind: 'COMPANY_CODE', value: tenant.companyCode }, { kind: 'MODULE', value: 'INV' }, { kind: 'PERIOD', value: `${YEAR}12` }] });
    await expectCode(request(wrongModule.auditor), 'AUDIT_OUT_OF_SCOPE');
    const none = await newAuditor({ grant: false });
    await expectCode(request(none.auditor), 'AUDIT_NO_GRANT');
    for (const a of [wrongPeriod.auditor, wrongModule.auditor, none.auditor]) {
      expect((await accessLog(a.userId)).some((l) => l.event_type === 'CAPABILITY_DENIED')).toBe(true);
    }
  });

  it('judges the actor\'s current organisational reach to the company code', async () => {
    const { auditor } = await newAuditor({ companyScopes: ['9999'] });
    await expectCode(request(auditor), 'AUDIT_AUTHORITY');
  });

  it('rejects an invalid year, period and request key; an undefined period of the variant', async () => {
    const { auditor } = await newAuditor();
    await expectCode(request(auditor, { companyCode: tenant.companyCode, fiscalYear: '26' as never, postingPeriod: 12 }), 'INVALID_YEAR');
    await expectCode(request(auditor, sel(0)), 'INVALID_PERIOD');
    await expectCode(request(auditor, sel(17)), 'INVALID_PERIOD');
    await expectCode(request(auditor, sel(12), 'short'), 'INVALID_REQUEST_KEY');
    // K4 defines 13 and 14 as special periods; 15 does not exist for the variant. (Grant covers 12 and 13 only.)
    const wide = await newAuditor({ scope: [{ kind: 'COMPANY_CODE', value: tenant.companyCode }, { kind: 'MODULE', value: 'FIN' }] });
    await expectCode(request(wide.auditor, sel(15)), 'PERIOD_NOT_DEFINED');
    expect((await request(wide.auditor, sel(13))).status).toBe('QUEUED');
    await drive();
  });

  it('refuses a request under a revoked or an expired grant before submission', async () => {
    const a = await newAuditor();
    await revokeAuditGrant({ client: tenant.client, authorization: controller.authorization, grantId: a.grantId!, reason: 'test' });
    await expectCode(request(a.auditor), 'AUDIT_NO_GRANT').catch(async () => undefined);
    const b = await newAuditor();
    await withTenant(tenant.client, (tx) => tx.execute(sql`update audit_grant set valid_to = current_date - 1, valid_from = current_date - 5 where client = ${tenant.client} and grant_id = ${b.grantId}`));
    const err = await expectCode(request(b.auditor), 'AUDIT_GRANT_EXPIRED');
    expect(err.message).toContain('Nothing can be read');
    expect((await accessLog(b.auditor.userId)).some((l) => l.event_type === 'CAPABILITY_DENIED')).toBe(true);
  });

  it('revoking the grant while the job is queued fails the pack closed with no artifact, and logs it', async () => {
    const { auditor, grantId } = await newAuditor();
    const view = await request(auditor);
    await revokeAuditGrant({ client: tenant.client, authorization: controller.authorization, grantId: grantId!, reason: 'test' });
    await drive();
    const row = await packRow(view.packId);
    expect(row.status).toBe('FAILED');
    expect(row.error_code).toBe('GRANT_REVOKED');
    expect(row.has_artifact).toBe(false);
    expect((await accessLog(auditor.userId)).some((l) => l.event_type === 'CAPABILITY_DENIED' && /Refused generation/.test(l.detail ?? ''))).toBe(true);
    // generic job status shows fixed words only
    const job = ((await withTenant(tenant.client, (tx) => tx.execute(sql`select error_text, parameters from job_run where client = ${tenant.client} and id = ${row.job_run_id}`))) as unknown as Array<Record<string, any>>)[0]!;
    expect(JSON.stringify(job)).not.toMatch(/journal|salary|J-OK|ALICE|SECRET/i);
    // a generic retry cannot resurrect it
    await withTenant(tenant.client, async (tx) => { await retryRun(tx, tenant.client, row.job_run_id); });
    await drive();
    const after = await packRow(view.packId);
    expect(after.status).toBe('FAILED');
    expect(after.has_artifact).toBe(false);
  });

  it('removing a role capability, or deactivating the user, fails the worker and leaks nothing', async () => {
    const a = await newAuditor();
    const v1 = await request(a.auditor);
    await withTenant(tenant.client, (tx) => tx.execute(sql`delete from role_capability where client = ${tenant.client} and role_code = ${a.auditor.roleCode} and capability_code = 'AUDIT.EVIDENCE.EXPORT'`));
    await drive();
    expect((await packRow(v1.packId)).error_code).toBe('AUTHORITY_REVOKED');
    expect((await packRow(v1.packId)).has_artifact).toBe(false);

    const b = await newAuditor();
    const v2 = await request(b.auditor);
    await withTenant(tenant.client, (tx) => tx.execute(sql`update app_user set is_active = false where client = ${tenant.client} and id = ${b.auditor.userId}`));
    await drive();
    expect((await packRow(v2.packId)).status).toBe('FAILED');
    expect((await packRow(v2.packId)).has_artifact).toBe(false);
  });

  it('is bound to the requester: another person, even with every capability, finds nothing by id', async () => {
    const a = await newAuditor();
    const packId = await buildPack(a.auditor);
    const b = await newAuditor();
    await expectCode(getPeriodPackStatus(b.auditor.actor, packId), 'AUDIT_PACK_NOT_FOUND');
    await expectCode(downloadPeriodPack(b.auditor.actor, packId), 'AUDIT_PACK_NOT_FOUND');
    await expectCode(cancelPeriodPack(b.auditor.actor, packId), 'AUDIT_PACK_NOT_FOUND');
    await expectCode(getPeriodPackStatus(a.auditor.actor, 'not-a-uuid'), 'AUDIT_PACK_NOT_FOUND');
  });

  it('refuses a download and a status read after the grant is revoked or expired, with the old id', async () => {
    const a = await newAuditor();
    const packId = await buildPack(a.auditor);
    expect((await downloadPeriodPack(a.auditor.actor, packId)).bytes.length).toBeGreaterThan(100);
    await revokeAuditGrant({ client: tenant.client, authorization: controller.authorization, grantId: a.grantId!, reason: 'test' });
    await expectCode(downloadPeriodPack(a.auditor.actor, packId), 'AUDIT_GRANT_REVOKED');
    await expectCode(getPeriodPackStatus(a.auditor.actor, packId), 'AUDIT_GRANT_REVOKED');
    const denied = (await accessLog(a.auditor.userId)).filter((l) => l.event_type === 'CAPABILITY_DENIED');
    expect(denied.length).toBeGreaterThanOrEqual(2);

    const b = await newAuditor();
    const packB = await buildPack(b.auditor);
    await withTenant(tenant.client, (tx) => tx.execute(sql`update audit_grant set valid_from = current_date - 9, valid_to = current_date - 1 where client = ${tenant.client} and grant_id = ${b.grantId}`));
    await expectCode(downloadPeriodPack(b.auditor.actor, packB), 'AUDIT_GRANT_EXPIRED');
  });
});

// ── 2. Rules and recorded changes ───────────────────────────────────────────

describe('period rules and recorded changes', () => {
  it('shows five rows, a missing rule as UNKNOWN/NOT_CONFIGURED, and no change documents as an empty, UNKNOWN history', async () => {
    const { auditor } = await newAuditor();
    const files = unzip(await artifact(await buildPack(auditor)));
    const rules = table(files, 'period-rules.csv');
    expect(rules.rows.map((r) => r.account_type)).toEqual(['S', 'K', 'D', 'A', 'M']);
    const m = rules.rows.find((r) => r.account_type === 'M')!;
    expect(m.rule_status).toBe('UNKNOWN/NOT_CONFIGURED');
    expect(m.current_engine_decision).toBe('UNKNOWN/NOT_CONFIGURED');
    expect(m.current_engine_decision).not.toMatch(/closed/i);
    const k = rules.rows.find((r) => r.account_type === 'K')!;
    expect(k.period_to).toBe('11');
    expect(k.current_engine_decision).toBe('NOT_ALLOWED_AT_SNAPSHOT'); // period 12 outside K 1..11
    expect(rules.rows.find((r) => r.account_type === 'S')!.current_engine_decision).toBe('ALLOWED_AT_SNAPSHOT');
    expect(rules.rows.every((r) => r.decision_basis === 'CURRENT_ENGINE_AT_SNAPSHOT_NOT_HISTORICAL' && r.variant_basis === 'CURRENT_ASSIGNMENT_AT_SNAPSHOT')).toBe(true);
    expect(table(files, 'period-rule-changes.csv').rows).toHaveLength(0);
    const summary = Object.fromEntries(table(files, 'summary.csv').rows.map((r) => [r.key, r.value]));
    expect(summary.rule_change_history_completeness).toBe('UNKNOWN');
    expect(summary.period_closure_event).toBe('UNKNOWN / not recorded');
    expect(summary.posting_time_authority).toBe('UNKNOWN / not recorded');
    expect(summary.period_rules_not_configured).toBe('M');
  });

  it('lists raw rule changes (actor, transaction, reason, field, old/new), the assignment change separately, and never synthesises CLOSE/REOPEN', async () => {
    await withTenant(tenant.client, async (tx) => {
      await recordChange(tx, { client: tenant.client, objectClass: 'posting_period_rule', objectKey: `${ppv}/K`, changeType: 'CHANGE', changedBy: 'CTRL_ONE',
        transactionCode: 'FIN.CLOSE.PERIOD', reason: 'Vendor close, e.g. "late" invoices', before: { periodFrom: 1, periodTo: 12, allowSpecialPeriods: false }, after: { periodFrom: 1, periodTo: 11, allowSpecialPeriods: false } });
      await recordChange(tx, { client: tenant.client, objectClass: 'posting_period_rule', objectKey: `${ppv}/D`, changeType: 'CHANGE', changedBy: 'CTRL_TWO',
        transactionCode: 'FIN.CLOSE.PERIOD', before: { periodTo: 12 }, after: { periodTo: 10 } });
      await recordChange(tx, { client: tenant.client, objectClass: 'posting_period_rule', objectKey: 'ZZZZ/K', changeType: 'CHANGE', changedBy: 'ELSEWHERE',
        transactionCode: 'FIN.CLOSE.PERIOD', before: { periodTo: 1 }, after: { periodTo: 2 } });
      await recordChange(tx, { client: tenant.client, objectClass: 'company_code', objectKey: tenant.companyCode, changeType: 'CHANGE', changedBy: 'CTRL_ONE',
        transactionCode: 'CFG.FIN.PPV.ASSIGN', reason: 'Reassigned', before: { postingPeriodVariant: 'OLD1' }, after: { postingPeriodVariant: ppv, postedDocuments: 7 } });
    });
    await withTenant(other.client, (tx) => recordChange(tx, { client: other.client, objectClass: 'posting_period_rule', objectKey: `${ppv}/S`, changeType: 'CHANGE', changedBy: 'OTHER_TENANT',
      transactionCode: 'FIN.CLOSE.PERIOD', before: { periodTo: 1 }, after: { periodTo: 2 } }));
    const { auditor } = await newAuditor();
    const files = unzip(await artifact(await buildPack(auditor)));
    const changes = table(files, 'period-rule-changes.csv');
    const rule = changes.rows.filter((r) => r.source === 'POSTING_PERIOD_RULE');
    expect(rule.map((r) => r.changed_by)).toEqual(expect.arrayContaining(['CTRL_ONE', 'CTRL_TWO']));
    expect(rule.some((r) => r.changed_by === 'ELSEWHERE' || r.changed_by === 'OTHER_TENANT')).toBe(false);
    const kTo = rule.find((r) => r.account_type === 'K' && r.field === 'periodTo')!;
    expect([kTo.old_value, kTo.new_value, kTo.transaction_code, kTo.reason]).toEqual(['12', '11', 'FIN.CLOSE.PERIOD', 'Vendor close, e.g. "late" invoices']);
    expect(rule.find((r) => r.account_type === 'D')!.reason).toBe('');
    expect(rule.every((r) => r.source_variant_basis === 'CURRENT_ASSIGNMENT_SHARED_VARIANT_NOT_PROVEN_HISTORICAL')).toBe(true);
    const assignment = changes.rows.filter((r) => r.source === 'COMPANY_VARIANT_ASSIGNMENT');
    expect(assignment).toHaveLength(1);
    expect([assignment[0]!.field, assignment[0]!.old_value, assignment[0]!.new_value]).toEqual(['postingPeriodVariant', 'OLD1', ppv]);
    expect(changes.rows.some((r) => r.field === 'postedDocuments')).toBe(false);
    const all = files['period-rule-changes.csv']!.toString('utf8') + files['summary.csv']!.toString('utf8');
    expect(all).not.toMatch(/\bREOPEN\b|\bCLOSE_EVENT\b|closed by|reopened by/);
    const summary = Object.fromEntries(table(files, 'summary.csv').rows.map((r) => [r.key, r.value]));
    expect(summary.company_variant_assignment_change_rows).toBe('1');
    expect(summary.posting_period_variant).toBe(ppv);
    expect(summary.companies_sharing_current_posting_period_variant).toBe('1');
  });
});

// ── 3. Periods, special periods, journal ────────────────────────────────────

describe('stored posting periods, special periods and journal postings', () => {
  it('selects by stored period; PARKED excluded; reversal links kept; other period, year, company and tenant never appear', async () => {
    const c = tenant.client;
    const t0 = Date.now();
    await journal(c, tenant.companyCode, 'J-OK-1', YEAR, 12, { postedAt: new Date(t0).toISOString(), createdBy: 'ALICE' });
    await journal(c, tenant.companyCode, 'J-OK-2', YEAR, 12, { postedAt: new Date(t0 + 1000).toISOString(), status: 'REVERSED', reversedBy: 'J-REV-1' });
    await journal(c, tenant.companyCode, 'J-REV-1', YEAR, 12, { postedAt: new Date(t0 + 2000).toISOString(), reversalOf: 'J-OK-2' });
    await journal(c, tenant.companyCode, 'J-PARKED', YEAR, 12, { status: 'PARKED' });
    await journal(c, tenant.companyCode, 'J-P11', YEAR, 11);
    await journal(c, tenant.companyCode, 'J-LASTYEAR', YEAR - 1, 12);
    await journal(c, tenant.companyCode, 'J-DATE-ELSEWHERE', YEAR, 12, { postingDate: `${YEAR + 1}-02-10`, postedAt: new Date(t0 + 3000).toISOString() });
    await journal(c, tenant.companyCode, 'J-ORIGIN', YEAR, 12, { origin: 'SECRET-ORIGIN-KEY', postedAt: new Date(t0 + 4000).toISOString() });
    await journal(other.client, other.companyCode, 'J-OTHER-TENANT', YEAR, 12);
    const { auditor } = await newAuditor();
    const files = unzip(await artifact(await buildPack(auditor)));
    const j = table(files, 'journal-postings.csv');
    expect(j.rows.map((r) => r.document_number)).toEqual(['J-OK-1', 'J-OK-2', 'J-REV-1', 'J-DATE-ELSEWHERE', 'J-ORIGIN']);
    expect(j.rows.find((r) => r.document_number === 'J-OK-2')!.status).toBe('REVERSED');
    expect(j.rows.find((r) => r.document_number === 'J-OK-2')!.reversed_by).toBe('J-REV-1');
    expect(j.rows.find((r) => r.document_number === 'J-REV-1')!.reversal_of).toBe('J-OK-2');
    expect(j.rows.find((r) => r.document_number === 'J-OK-1')!.created_by).toBe('ALICE');
    expect(j.rows.every((r) => r.period_kind === 'REGULAR' && r.authority_proof === 'UNKNOWN / not recorded')).toBe(true);
    const everything = Object.values(files).map((b) => b.toString('utf8')).join('\n');
    expect(everything).not.toMatch(/SECRET-ORIGIN-KEY|SECRET-HEADER-TEXT|SECRET-REFERENCE|J-OTHER-TENANT|J-PARKED/);
  });

  it('labels 13 special only because the fiscal year variant says so, from the stored period', async () => {
    await journal(tenant.client, tenant.companyCode, 'J-SPECIAL-13', YEAR, 13, { postingDate: `${YEAR}-12-31` });
    const { auditor } = await newAuditor();
    const files = unzip(await artifact(await buildPack(auditor, sel(13))));
    const j = table(files, 'journal-postings.csv');
    expect(j.rows.map((r) => r.document_number)).toEqual(['J-SPECIAL-13']);
    expect(j.rows[0]!.period_kind).toBe('SPECIAL');
    const rules = table(files, 'period-rules.csv');
    // S allows special periods and 13 > 12: the engine says not allowed because 13 is outside 1..12.
    expect(rules.rows.find((r) => r.account_type === 'S')!.current_engine_decision).toBe('NOT_ALLOWED_AT_SNAPSHOT');
    expect(rules.rows.find((r) => r.account_type === 'K')!.engine_reason).toMatch(/Special period 13/);
  });

  it('a non-calendar, year-dependent variant: period 13 is REGULAR and 14 is SPECIAL there; no date is guessed', async () => {
    await withTenant(tenant.client, async (tx) => {
      await tx.execute(sql`insert into fiscal_year_variant (client, variant, name, is_calendar_year, regular_periods, special_periods, is_year_dependent, created_by)
        values (${tenant.client}, 'NC', 'Apr start, 13 periods', false, 13, 1, true, ${SETUP}) on conflict do nothing`);
      for (let p = 1; p <= 13; p += 1) {
        const month = ((p + 2) % 12) + 1;
        await tx.execute(sql`insert into fiscal_year_period (client, variant, calendar_year, period, period_type, month, day, year_shift, created_by)
          values (${tenant.client}, 'NC', ${YEAR}, ${p}, 'REGULAR', ${month}, 28, ${p >= 10 ? 1 : 0}, ${SETUP}) on conflict do nothing`);
      }
      await tx.execute(sql`insert into fiscal_year_period (client, variant, calendar_year, period, period_type, month, day, year_shift, created_by)
        values (${tenant.client}, 'NC', ${YEAR}, 14, 'SPECIAL', 3, 31, 1, ${SETUP}) on conflict do nothing`);
      await tx.execute(sql`update company_code set fiscal_year_variant = 'NC' where client = ${tenant.client} and company_code = ${tenant.companyCode}`);
    });
    try {
      await journal(tenant.client, tenant.companyCode, 'J-NC-13', YEAR, 13, { postingDate: `${YEAR + 1}-04-02` });
      await journal(tenant.client, tenant.companyCode, 'J-NC-14', YEAR, 14, { postingDate: `${YEAR + 1}-03-31` });
      const wide = await newAuditor({ scope: [{ kind: 'COMPANY_CODE', value: tenant.companyCode }, { kind: 'MODULE', value: 'FIN' }] });
      const f13 = unzip(await artifact(await buildPack(wide.auditor, sel(13))));
      expect(table(f13, 'journal-postings.csv').rows.map((r) => [r.document_number, r.period_kind]).sort()).toEqual([['J-NC-13', 'REGULAR'], ['J-SPECIAL-13', 'REGULAR']]);
      const f14 = unzip(await artifact(await buildPack(wide.auditor, sel(14))));
      expect(table(f14, 'journal-postings.csv').rows.map((r) => [r.document_number, r.period_kind])).toEqual([['J-NC-14', 'SPECIAL']]);
      expect(Object.fromEntries(table(f14, 'summary.csv').rows.map((r) => [r.key, r.value])).fiscal_year_variant).toBe('NC');
      // year-dependent: another fiscal year has no rows, so period 13 is not defined for it
      await expectCode(request(wide.auditor, sel(13, YEAR + 1)), 'PERIOD_NOT_DEFINED');
    } finally {
      await withTenant(tenant.client, (tx) => tx.execute(sql`update company_code set fiscal_year_variant = 'K4' where client = ${tenant.client} and company_code = ${tenant.companyCode}`));
    }
  });
});

// ── 4. Close tasks ──────────────────────────────────────────────────────────

describe('closing tasks', () => {
  async function seedList(listId: string, period: number, status: string) {
    await withTenant(tenant.client, async (tx) => {
      await tx.execute(sql`insert into closing_task_list (client, company_code, task_list_id, fiscal_year, posting_period, description, status, created_by)
        values (${tenant.client}, ${tenant.companyCode}, ${listId}, ${YEAR}, ${period}, 'List', ${status}, 'CLOSER')`);
      await tx.execute(sql`insert into closing_task_instance (client, company_code, task_list_id, fiscal_year, posting_period, task_id, task_name, handler_code, status, sequence, owner, requires_signoff, evidence_ref, signed_off_by, signed_off_at, created_by)
        values (${tenant.client}, ${tenant.companyCode}, ${listId}, ${YEAR}, ${period}, 'T10', 'Check, "quoted"', 'MANUAL_CONFIRMATION', 'ERROR', 1, 'OWNER1', true, 'DOC-REF-1', 'SIGNER', now(), 'CLOSER')`);
      await tx.execute(sql`insert into closing_execution_log (client, execution_id, company_code, task_list_id, fiscal_year, posting_period, task_id, attempt, mode, status, initiated_by, result_summary, error_details)
        values (${tenant.client}, ${`EX-${listId}`.slice(0, 24)}, ${tenant.companyCode}, ${listId}, ${YEAR}, ${period}, 'T10', 1, 'FOREGROUND', 'FAILED', 'CLOSER', 'failed once', 'SECRET-STACK-TRACE')`);
      await tx.execute(sql`insert into closing_task_event (client, event_id, company_code, task_list_id, fiscal_year, posting_period, task_id, event_type, actor, reason)
        values (${tenant.client}, ${`EV-${listId}`.slice(0, 24)}, ${tenant.companyCode}, ${listId}, ${YEAR}, ${period}, null, ${status === 'FINALIZED' ? 'FINALIZED' : 'RELEASED'}, 'CLOSER', 'because')`);
    });
  }

  it('reports no task list as such; then finalized and multiple lists accurately, never as period closure; nothing is changed', async () => {
    const { auditor } = await newAuditor();
    const none = unzip(await artifact(await buildPack(auditor)));
    const s0 = Object.fromEntries(table(none, 'summary.csv').rows.map((r) => [r.key, [r.value, r.basis]]));
    expect(s0.close_task_lists).toEqual(['0', 'NO_TASK_LIST_FOR_SELECTION']);
    expect(table(none, 'close-tasks.csv').rows).toHaveLength(0);
    expect(none['limitations.txt']!.toString()).toContain('no closing task list exists');

    await seedList('FIN_CLOSE', 12, 'FINALIZED');
    await seedList('SECOND', 12, 'RELEASED');
    await seedList('OTHER_PERIOD', 11, 'FINALIZED');
    const before = await withTenant(tenant.client, async (tx) => ((await tx.execute(sql`select
      (select count(*) from journal_entry where client = ${tenant.client})::int j, (select count(*) from posting_period_rule where client = ${tenant.client})::int r,
      (select count(*) from closing_task_list where client = ${tenant.client})::int l, (select count(*) from change_document where client = ${tenant.client})::int c`)) as unknown as Array<Record<string, number>>)[0]!);
    const view = await request(auditor);
    await drive();
    expect((await packRow(view.packId)).status).toBe('COMPLETED');
    const after = await withTenant(tenant.client, async (tx) => ((await tx.execute(sql`select
      (select count(*) from journal_entry where client = ${tenant.client})::int j, (select count(*) from posting_period_rule where client = ${tenant.client})::int r,
      (select count(*) from closing_task_list where client = ${tenant.client})::int l, (select count(*) from change_document where client = ${tenant.client})::int c`)) as unknown as Array<Record<string, number>>)[0]!);
    expect(after).toEqual(before);

    const files = unzip(await artifact(view.packId));
    const tasks = table(files, 'close-tasks.csv');
    const lists = tasks.rows.filter((r) => r.record_type === 'TASK_LIST');
    expect(lists.map((r) => [r.task_list_id, r.status])).toEqual([['FIN_CLOSE', 'FINALIZED'], ['SECOND', 'RELEASED']]);
    expect(lists[0]!.note).toContain('does not close the posting period');
    const task = tasks.rows.find((r) => r.record_type === 'TASK' && r.task_list_id === 'FIN_CLOSE')!;
    expect([task.status, task.owner_or_initiator, task.signed_off_by, task.evidence_or_generated_ref, task.name_or_execution_id]).toEqual(['ERROR', 'OWNER1', 'SIGNER', 'DOC-REF-1', 'Check, "quoted"']);
    const exec = tasks.rows.find((r) => r.record_type === 'EXECUTION' && r.task_list_id === 'FIN_CLOSE')!;
    expect(exec.status).toBe('FAILED');
    expect(exec.note).toContain('error details exist and are not exported');
    expect(files['close-tasks.csv']!.toString()).not.toContain('SECRET-STACK-TRACE');
    expect(files['close-tasks.csv']!.toString()).not.toContain('OTHER_PERIOD');
    const events = table(files, 'close-events.csv');
    expect(events.rows.map((r) => r.event_type).sort()).toEqual(['FINALIZED', 'RELEASED']);
    expect(events.rows.find((r) => r.event_type === 'FINALIZED')!.note).toContain('does not close the posting period');
  });
});

// ── 5. Snapshot, limits ─────────────────────────────────────────────────────

describe('one consistent snapshot, and explicit limits', () => {
  it('a rule change and a journal committed during the read are entirely absent; the next snapshot has both', async () => {
    const s = sel(12);
    const first = await withTenantSnapshot(tenant.client, async (tx) => {
      await tx.execute(sql`select 1 from journal_entry where client = ${tenant.client} limit 1`); // fixes the snapshot
      await withTenant(tenant.client, async (tx2) => {
        await tx2.execute(sql`update posting_period_rule set period_to = 9 where client = ${tenant.client} and variant = ${ppv} and account_type = 'A'`);
        await recordChange(tx2, { client: tenant.client, objectClass: 'posting_period_rule', objectKey: `${ppv}/A`, changeType: 'CHANGE', changedBy: 'MID_READ', transactionCode: 'FIN.CLOSE.PERIOD', before: { periodTo: 12 }, after: { periodTo: 9 } });
      });
      await journal(tenant.client, tenant.companyCode, 'J-MID-READ', YEAR, 12);
      return collectEvidence(tx, tenant.client, s);
    });
    expect(first.rules.find((r) => r.accountType === 'A')!.periodTo).toBe(12);
    expect(first.ruleChanges.some((c) => c.changedBy === 'MID_READ')).toBe(false);
    expect(first.journal.some((j) => j.documentNumber === 'J-MID-READ')).toBe(false);
    const second = await withTenantSnapshot(tenant.client, (tx) => collectEvidence(tx, tenant.client, s));
    expect(second.rules.find((r) => r.accountType === 'A')!.periodTo).toBe(9);
    expect(second.ruleChanges.some((c) => c.changedBy === 'MID_READ')).toBe(true);
    expect(second.journal.some((j) => j.documentNumber === 'J-MID-READ')).toBe(true);
    expect(new Date(second.snapshotAt).getTime()).toBeGreaterThanOrEqual(new Date(first.snapshotAt).getTime());
    await withTenant(tenant.client, (tx) => tx.execute(sql`update posting_period_rule set period_to = 12 where client = ${tenant.client} and variant = ${ppv} and account_type = 'A'`));
  });

  it('over the row or byte limit fails with TOO_LARGE; nothing is truncated or published', async () => {
    await expectCode(withTenantSnapshot(tenant.client, (tx) => collectEvidence(tx, tenant.client, sel(12), { maxRows: 2 })), 'TOO_LARGE');
    const data = await withTenantSnapshot(tenant.client, (tx) => collectEvidence(tx, tenant.client, sel(12)));
    const ctx = { packId: randomUUID(), client: tenant.client, requestedBy: 'x', grantId: 'g', generatedAt: new Date().toISOString() };
    expect(() => renderPack(data, ctx, { maxUncompressedBytes: 200 })).toThrow(PeriodPackError);
    expect(() => renderPack(data, ctx, { maxZipBytes: 200 })).toThrow(/size limit/);
    expect(renderPack(data, ctx).zip.length).toBeGreaterThan(200);
  });

  it('a refusal from the data layer (a period the variant does not define) ends the pack FAILED with a code and no artifact', async () => {
    const { auditor } = await newAuditor({ scope: [{ kind: 'COMPANY_CODE', value: tenant.companyCode }, { kind: 'MODULE', value: 'FIN' }] });
    const view = await request(auditor);
    await withTenant(tenant.client, (tx) => tx.execute(sql`update audit_period_pack set posting_period = 15 where client = ${tenant.client} and pack_id = ${view.packId}`));
    await drive();
    const row = await packRow(view.packId);
    expect(row.status).toBe('FAILED');
    expect(row.error_code).toBe('PERIOD_NOT_DEFINED');
    expect(row.has_artifact).toBe(false);
  });
});

// ── 6. Archive ──────────────────────────────────────────────────────────────

describe('the archive', () => {
  it('opens as a ZIP with fixed safe names; every file hashes to the manifest; the manifest does not hash itself', async () => {
    await withTenant(tenant.client, (tx) => recordChange(tx, { client: tenant.client, objectClass: 'posting_period_rule', objectKey: `${ppv}/S`, changeType: 'CHANGE', changedBy: 'ÉMILE 日本',
      transactionCode: 'FIN.CLOSE.PERIOD', reason: '=HYPERLINK("http://evil","x"), line1\nline2 "q"', before: { periodTo: 12 }, after: { periodTo: 12, allowSpecialPeriods: true } }));
    await withTenant(tenant.client, (tx) => recordChange(tx, { client: tenant.client, objectClass: 'posting_period_rule', objectKey: `${ppv}/S`, changeType: 'CHANGE', changedBy: '  +cmd', transactionCode: '@SUM(1)',
      reason: '\t=1+1', before: { periodTo: 1 }, after: { periodTo: -5 } }));
    const { auditor } = await newAuditor();
    const packId = await buildPack(auditor);
    const zip = await artifact(packId);
    const files = unzip(zip);
    expect(Object.keys(files).sort()).toEqual(['close-events.csv', 'close-tasks.csv', 'journal-postings.csv', 'limitations.txt', 'manifest.json', 'period-rule-changes.csv', 'period-rules.csv', 'summary.csv']);
    const manifest = JSON.parse(files['manifest.json']!.toString('utf8'));
    expect(manifest.schemaVersion).toBe(1);
    expect(manifest.packId).toBe(packId);
    expect(manifest.selection).toEqual({ companyCode: tenant.companyCode, fiscalYear: YEAR, postingPeriod: 12 });
    expect(manifest.snapshotAtUtc).toMatch(/Z$/);
    expect(manifest.hashNote).toMatch(/not signatures/);
    expect(manifest.files.map((f: { name: string }) => f.name)).not.toContain('manifest.json');
    expect(manifest.files).toHaveLength(7);
    for (const f of manifest.files as Array<{ name: string; bytes: number; rows: number | null; sha256: string }>) {
      const bytes = files[f.name]!;
      expect(f.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(createHash('sha256').update(bytes).digest('hex')).toBe(f.sha256);
      expect(bytes.length).toBe(f.bytes);
      if (f.name.endsWith('.csv')) expect(f.rows).toBe(parseCsv(bytes).length - 1);
      else expect(f.rows).toBeNull();
    }
    expect(manifest.limitations.map((l: { code: string }) => l.code)).toEqual(expect.arrayContaining(['CLOSURE_EVENT_UNKNOWN', 'POSTING_AUTHORITY_UNKNOWN', 'RULES_ARE_CURRENT', 'ASSIGNMENT_HISTORY_NOT_PROVEN']));
    expect(manifest.sources.length).toBeGreaterThan(5);
    // stored hash is the manifest's hash
    expect((await packRow(packId)).manifest_sha256).toBe(createHash('sha256').update(files['manifest.json']!).digest('hex'));
    // RFC 4180 and unicode survive; formula text is neutralised
    const changes = table(files, 'period-rule-changes.csv');
    expect(changes.rows.some((r) => r.changed_by === 'ÉMILE 日本')).toBe(true);
    expect(changes.rows.some((r) => r.reason === '\'=HYPERLINK("http://evil","x"), line1\nline2 "q"')).toBe(true);
    const nasty = changes.rows.find((r) => r.transaction_code === '\'@SUM(1)')!;
    expect([nasty.changed_by, nasty.reason, nasty.new_value]).toEqual(["'  +cmd", "'\t=1+1", '-5']);
    for (const name of Object.keys(files).filter((n) => n.endsWith('.csv'))) {
      for (const row of parseCsv(files[name]!)) for (const cell of row) expect(cell).not.toMatch(/^[\s\u0000-\u001f]*[=+@]/);
    }
    expect(files['limitations.txt']!.toString()).toMatch(/UNKNOWN \/ not recorded/);
    expect(files['limitations.txt']!.toString()).not.toMatch(/was closed by|was authori[sz]ed by|no late postings/i);
  });

  it('neutraliseFormula leaves numbers and ordinary text alone', () => {
    expect(neutraliseFormula('-5')).toBe('-5');
    expect(neutraliseFormula('12.50')).toBe('12.50');
    expect(neutraliseFormula('plain-text')).toBe('plain-text');
    expect(neutraliseFormula('=A1')).toBe("'=A1");
    expect(neutraliseFormula('-1+1')).toBe("'-1+1");
    expect(neutraliseFormula(' \u0001@x')).toBe("' \u0001@x");
    expect(neutraliseFormula('\r1')).toBe("'\r1");
  });

  it('the same dataset yields identical CSV and manifest hashes (deterministic); only generated-at differs', async () => {
    const data = await withTenantSnapshot(tenant.client, (tx) => collectEvidence(tx, tenant.client, sel(12)));
    const mk = (generatedAt: string) => renderPack(data, { packId: 'pid', client: tenant.client, requestedBy: 'u', grantId: 'g', generatedAt });
    const a = mk('2026-01-01T00:00:00.000Z'); const b = mk('2026-01-01T00:00:00.000Z'); const c = mk('2026-02-02T00:00:00.000Z');
    expect(a.files).toEqual(b.files);
    expect(a.zip.equals(b.zip)).toBe(true);
    expect(a.files.find((f) => f.name === 'summary.csv')!.sha256).not.toBe(c.files.find((f) => f.name === 'summary.csv')!.sha256);
    expect(a.files.find((f) => f.name === 'journal-postings.csv')!.sha256).toBe(c.files.find((f) => f.name === 'journal-postings.csv')!.sha256);
  });

  it('expiry: a download after expires_at fails with the old id; cleanup removes the artifact and keeps the access log', async () => {
    const { auditor } = await newAuditor();
    const packId = await buildPack(auditor);
    const done = await packRow(packId);
    expect(new Date(done.expires_at).getTime() - new Date(done.completed_at).getTime()).toBeGreaterThan(29 * DAY);
    await withTenant(tenant.client, (tx) => tx.execute(sql`update audit_period_pack set expires_at = now() - interval '1 minute' where client = ${tenant.client} and pack_id = ${packId}`));
    await expectCode(downloadPeriodPack(auditor.actor, packId), 'AUDIT_PACK_UNAVAILABLE');
    const status = await getPeriodPackStatus(auditor.actor, packId);
    expect(status.status).toBe('EXPIRED');
    expect(status.downloadable).toBe(false);
    const logBefore = (await accessLog(auditor.userId)).length;
    expect(await withTenant(tenant.client, (tx) => cleanupExpiredPeriodPacks(tx, tenant.client))).toBeGreaterThanOrEqual(1);
    const row = await packRow(packId);
    expect([row.status, row.has_artifact]).toEqual(['EXPIRED', false]);
    expect((await accessLog(auditor.userId)).length).toBe(logBefore);
    await expectCode(downloadPeriodPack(auditor.actor, packId), 'AUDIT_PACK_UNAVAILABLE');
  });
});

// ── 7. Idempotency, lifecycle, crash, fencing, cancel ───────────────────────

describe('idempotent requests and a truthful lifecycle', () => {
  it('a repeated key with the same selection returns the same pack and one job; a different selection is refused; races collapse to one', async () => {
    const { auditor } = await newAuditor();
    const k = key();
    const a = await request(auditor, sel(12), k);
    const b = await request(auditor, sel(12), k);
    expect(b.packId).toBe(a.packId);
    await expectCode(request(auditor, sel(13), k), 'KEY_REUSED');
    const k2 = key();
    const [x, y, z] = await Promise.all([request(auditor, sel(12), k2), request(auditor, sel(12), k2), request(auditor, sel(12), k2)]);
    expect(new Set([x.packId, y.packId, z.packId]).size).toBe(1);
    const counts = ((await withTenant(tenant.client, (tx) => tx.execute(sql`select
      (select count(*) from audit_period_pack where client = ${tenant.client} and requester_user_id = ${auditor.userId})::int packs,
      (select count(*) from job_run j join audit_period_pack p on p.client = j.client and p.job_run_id = j.id where p.client = ${tenant.client} and p.requester_user_id = ${auditor.userId})::int jobs`))) as unknown as Array<Record<string, number>>)[0]!;
    expect(counts).toEqual({ packs: 2, jobs: 2 });
    // the same key by a different person is a different request
    const other2 = await newAuditor();
    expect((await request(other2.auditor, sel(12), k)).packId).not.toBe(a.packId);
    await drive();
  });

  it('a crash after the artifact commit and before job success recovers without a second archive', async () => {
    const { auditor } = await newAuditor();
    let calls = 0;
    useRealHandler(async (ctx, real) => {
      calls += 1;
      const result = await real();
      if (calls === 1) {
        await withTenant(tenant.client, (tx) => tx.execute(sql`update job_run set heartbeat_at = now() - interval '5 minutes' where id = ${ctx.runId}`));
        expect(await withTenant(tenant.client, (tx) => reapOrphans(tx, tenant.client, 1000))).toContain(ctx.runId);
        throw new LeaseLostError();
      }
      return result;
    });
    const view = await request(auditor);
    await drive();
    const row = await packRow(view.packId);
    expect(row.status).toBe('COMPLETED');
    const bytes = await artifact(view.packId);
    const completedAt = row.completed_at;
    await drive(); // the requeued job finds the pack complete and records success
    expect(calls).toBeGreaterThanOrEqual(2);
    const after = await packRow(view.packId);
    expect([after.status, new Date(after.completed_at).getTime()]).toEqual(['COMPLETED', new Date(completedAt).getTime()]);
    expect((await artifact(view.packId)).equals(bytes)).toBe(true);
    const job = ((await withTenant(tenant.client, (tx) => tx.execute(sql`select status from job_run where client = ${tenant.client} and id = ${row.job_run_id}`))) as unknown as Array<{ status: string }>)[0]!;
    expect(job.status).toBe('SUCCEEDED');
    useRealHandler();
  });

  it('a worker that lost its lease cannot publish; the legitimate claim publishes exactly one artifact', async () => {
    const { auditor } = await newAuditor();
    const view = await request(auditor);
    const stale = await claimNext('worker-a', ['INTENSIVE']);
    expect(stale).not.toBeNull();
    await withTenant(tenant.client, (tx) => tx.execute(sql`update job_run set heartbeat_at = now() - interval '5 minutes' where id = ${stale!.runId}`));
    expect(await withTenant(tenant.client, (tx) => reapOrphans(tx, tenant.client, 1000))).toContain(stale!.runId);
    expect(await runClaimed('worker-a', stale!)).toBe('LEASE_LOST');
    expect((await packRow(view.packId)).has_artifact).toBe(false);
    await drive();
    const row = await packRow(view.packId);
    expect([row.status, row.has_artifact]).toEqual(['COMPLETED', true]);
  });

  it('cancel while queued, a generic administrator cancel, and nothing publishable after either', async () => {
    const a = await newAuditor();
    const v1 = await request(a.auditor);
    const cancelled = await cancelPeriodPack(a.auditor.actor, v1.packId);
    expect(['QUEUED', 'CANCELLED']).toContain(cancelled.status);
    await drive();
    expect((await packRow(v1.packId)).status).toBe('CANCELLED');
    expect((await packRow(v1.packId)).has_artifact).toBe(false);
    await expectCode(cancelPeriodPack(a.auditor.actor, v1.packId), 'NOT_CANCELLABLE');
    await expectCode(downloadPeriodPack(a.auditor.actor, v1.packId), 'AUDIT_PACK_UNAVAILABLE');

    const v2 = await request(a.auditor);
    const runId = (await packRow(v2.packId)).job_run_id;
    await withTenant(tenant.client, async (tx) => { await requestCancel(tx, tenant.client, runId); });
    await drive();
    expect((await packRow(v2.packId)).status).toBe('CANCELLED');
    expect((await packRow(v2.packId)).has_artifact).toBe(false);
  });

  it('job status, progress and logs never carry report content; a finished pack shows a generic label', async () => {
    const { auditor } = await newAuditor();
    const view = await request(auditor);
    await drive();
    const row = await packRow(view.packId);
    const jobs = (await withTenant(tenant.client, (tx) => tx.execute(sql`
      select j.parameters, j.error_text, j.progress_text, j.cursor, coalesce((select string_agg(l.message || coalesce(l.context::text, ''), ' ') from job_log l where l.job_run_id = j.id), '') as logs
        from job_run j where j.client = ${tenant.client} and j.id = ${row.job_run_id}`))) as unknown as Array<Record<string, unknown>>;
    const text = JSON.stringify(jobs);
    expect(text).not.toMatch(/J-OK-1|ALICE|POSTER|SECRET|CTRL_ONE|Vendor close/);
    expect((jobs[0] as { progress_text: string }).progress_text).toBe('Evidence pack ready.');
  });
});

// ── 8. Download route and static contracts ──────────────────────────────────

describe('download route and contracts', () => {
  it('serves attachment headers, never caches, and refuses without a session, after expiry and after revocation', async () => {
    const { auditor, grantId } = await newAuditor();
    const packId = await buildPack(auditor);
    let session: unknown = null;
    vi.resetModules();
    vi.doMock('@/platform/auth/current', () => ({ getSession: async () => session }));
    const { GET } = await import('../src/app/api/audit/period-pack/[packId]/route');
    const call = () => GET(new Request('http://x/api'), { params: Promise.resolve({ packId }) });

    expect((await call()).status).toBe(401);
    session = { user: { client: tenant.client, userId: auditor.userId, username: auditor.username } };
    const ok = await call();
    expect(ok.status).toBe(200);
    expect(ok.headers.get('content-type')).toBe('application/zip');
    expect(ok.headers.get('cache-control')).toBe('private, no-store');
    expect(ok.headers.get('content-disposition')).toMatch(/^attachment; filename="period-close-evidence-[A-Za-z0-9-]+\.zip"$/);
    expect(ok.headers.get('location')).toBeNull();
    const body = Buffer.from(await ok.arrayBuffer());
    expect(Object.keys(unzip(body))).toContain('manifest.json');
    expect(body.equals(await artifact(packId))).toBe(true);

    await revokeAuditGrant({ client: tenant.client, authorization: controller.authorization, grantId: grantId!, reason: 'test' });
    const revoked = await call();
    expect(revoked.status).toBe(403);
    expect(revoked.headers.get('cache-control')).toBe('private, no-store');
    vi.doUnmock('@/platform/auth/current');
    vi.resetModules();
  });

  it('adds no screen and keeps the bytes out of server actions', () => {
    const pages = (dir: string): string[] => readdirSync(join('src/app', dir), { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? pages(join(dir, e.name)) : e.name === 'page.tsx' ? [join(dir, e.name)] : []));
    expect(pages('audit').sort()).toEqual(['audit/access-review/page.tsx', 'audit/findings/page.tsx', 'audit/grants/page.tsx', 'audit/workspace/page.tsx']);
    expect(readdirSync('src/app/api/audit/period-pack/[packId]')).toEqual(['route.ts']);
    const actions = readFileSync('src/app/audit/workspace/actions.ts', 'utf8');
    expect(actions).not.toMatch(/downloadPeriodPack|Buffer|bytes|artifact/);
    const page = readFileSync('src/app/audit/workspace/page.tsx', 'utf8');
    expect(page).toContain('PeriodPackPanel');
    expect(page).toContain("can(session, AUDIT_PERIOD_EVIDENCE_CAPABILITY)");
    const route = readFileSync('src/app/api/audit/period-pack/[packId]/route.ts', 'utf8');
    expect(route).toContain("'private, no-store'");
    expect(route).toContain('attachment; filename=');
    expect(route.replace(/\/\*[\s\S]*?\*\//, '')).not.toMatch(/redirect|signed|Location/i);
    // not an ALWAYS_VISIBLE capability
    const always = readFileSync('src/platform/auth/session.ts', 'utf8') + readFileSync('src/platform/auth/pattern.ts', 'utf8');
    expect(always).not.toContain(EVIDENCE);
  });

  it('migration shape: forced RLS, app grants without delete, unique request key, owner, capability display-only and unassigned, job on INTENSIVE', async () => {
    const info = await withTenant(tenant.client, async (tx) => ({
      rls: (await tx.execute(sql`select relrowsecurity, relforcerowsecurity, pg_get_userbyid(relowner) as owner from pg_class where oid = 'public.audit_period_pack'::regclass`)) as unknown as Array<Record<string, any>>,
      policy: (await tx.execute(sql`select count(*)::int n from pg_policies where tablename = 'audit_period_pack' and policyname = 'tenant_isolation'`)) as unknown as Array<{ n: number }>,
      grants: (await tx.execute(sql`select privilege_type from information_schema.role_table_grants where table_name = 'audit_period_pack' and grantee = 'cairn_app' order by 1`)) as unknown as Array<{ privilege_type: string }>,
      uq: (await tx.execute(sql`select indexdef from pg_indexes where tablename = 'audit_period_pack' and indexname = 'audit_period_pack_request_uq'`)) as unknown as Array<{ indexdef: string }>,
      cap: (await tx.execute(sql`select action, is_posting_relevant from capability where code = ${EVIDENCE}`)) as unknown as Array<Record<string, any>>,
      roles: (await tx.execute(sql`select count(*)::int n from role_capability where capability_code = ${EVIDENCE} and role_code not like 'TEST_AUDIT_%' and role_code <> 'DEMO_AUDITOR'`)) as unknown as Array<{ n: number }>,
      job: (await tx.execute(sql`select queue, is_scheduled from job_definition where code = ${AUDIT_PERIOD_PACK_JOB}`)) as unknown as Array<Record<string, any>>,
    }));
    expect(info.rls[0]).toMatchObject({ relrowsecurity: true, relforcerowsecurity: true, owner: 'cairn_integration_migrator' });
    expect(info.policy[0]!.n).toBe(1);
    expect(info.grants.map((g) => g.privilege_type)).toEqual(['INSERT', 'SELECT', 'UPDATE']);
    expect(info.uq[0]!.indexdef).toMatch(/UNIQUE.*\(client, requester_user_id, request_key\)/);
    expect(info.cap[0]).toMatchObject({ action: 'DISPLAY', is_posting_relevant: false });
    expect(info.roles[0]!.n).toBe(0);
    expect(info.job[0]).toMatchObject({ queue: 'INTENSIVE', is_scheduled: false });
  });

  it('tenant isolation: another tenant cannot see a pack row', async () => {
    const { auditor } = await newAuditor();
    const packId = await buildPack(auditor);
    const visible = await withTenant(other.client, (tx) => tx.execute(sql`select count(*)::int n from audit_period_pack where pack_id = ${packId}`)) as unknown as Array<{ n: number }>;
    expect(visible[0]!.n).toBe(0);
  });
});

beforeEach(() => { useRealHandler(); });
