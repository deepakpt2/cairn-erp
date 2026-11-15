/**
 * Auditor workspace (AUDIT.WORKSPACE) — the grant, the read-only rule, the audited
 * auditor and the working state.
 *
 * What is worth proving is not that rows can be written. It is that:
 *   - a grant is always scoped and time-boxed, and one per auditor;
 *   - reads outside the scope or after the window are refused by name, and the
 *     window's end expires the grant even though the read is refused;
 *   - while a grant is live, nothing the auditor holds can write — proven from the
 *     seeded catalogue, not from a hand-written list;
 *   - every view, search and export leaves exactly one log row, and the log has no
 *     update or delete path;
 *   - a request to management is answered by management, never by its raiser;
 *   - AUDIT.WORKSPACE still widens the six reads that relied on it before.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { withTenant } from '../src/platform/db/client';
import { effectiveGrants, patternsOf } from '../src/platform/auth/authority';
import { hasCapability } from '../src/platform/auth/pattern';
import { verifyServiceAuthorityInTx } from '../src/platform/auth/service-authority';
import {
  AUDIT_GRANT_EXCEPTIONS,
  READ_KIND_ACTIONS,
} from '../src/modules/audit/read-only';
import {
  AuditError,
  assertAuditRead,
  createAuditGrant,
  exportEvidence,
  grantCovers,
  raiseFinding,
  recordAuditView,
  respondToFinding,
  revokeAuditGrant,
  searchChangeHistory,
  type CreateAuditGrantInput,
} from '../src/modules/audit/workspace';
import {
  AUDITOR_CAPABILITIES,
  CONTROLLER_CAPABILITIES,
  createAuditActor,
  type AuditTestActor,
} from './helpers/audit-actor';
import { createTenant, destroyTenant, type TestTenant } from './helpers';

const DAY = 86_400_000;
const iso = (offsetDays: number) => new Date(Date.now() + offsetDays * DAY).toISOString().slice(0, 10);
const TODAY = iso(0);
const YEAR = TODAY.slice(0, 4);
const PERIOD = `${YEAR}${TODAY.slice(5, 7)}`;

let tenant: TestTenant;
let controller: AuditTestActor;

async function expectAuditError(promise: Promise<unknown>, code: string): Promise<AuditError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(AuditError);
    expect((error as AuditError).code).toBe(code);
    expect((error as AuditError).remedy).toBeTruthy();
    return error as AuditError;
  }
  throw new Error(`Expected AuditError ${code}, but nothing was thrown.`);
}

function grantInput(auditor: AuditTestActor, over: Partial<CreateAuditGrantInput> = {}): CreateAuditGrantInput {
  return {
    client: tenant.client,
    authorization: controller.authorization,
    auditorUserId: auditor.userId,
    validFrom: iso(-1),
    validTo: iso(30),
    scope: [
      { kind: 'COMPANY_CODE', value: tenant.companyCode },
      { kind: 'MODULE', value: 'FIN' },
      { kind: 'PERIOD', value: PERIOD },
    ],
    reason: 'Year-end statutory audit',
    ...over,
  };
}

async function newAuditor(extra: readonly string[] = []): Promise<AuditTestActor> {
  return createAuditActor(tenant.client, { capabilities: [...AUDITOR_CAPABILITIES, ...extra] });
}

async function logRows(userId: string): Promise<Array<{ event_type: string; object_type: string | null; grant_id: string | null; detail: string | null }>> {
  return (await withTenant(tenant.client, (tx) => tx.execute(sql`
    select event_type, object_type, grant_id, detail from audit_access_log
     where client = ${tenant.client} and user_id = ${userId}
     order by occurred_at
  `))) as unknown as Array<{ event_type: string; object_type: string | null; grant_id: string | null; detail: string | null }>;
}

beforeAll(async () => {
  tenant = await createTenant('audit-workspace');
  // The K4 periods the PERIOD scope rule checks against; createTenant defines the variant, not its periods.
  await withTenant(tenant.client, async (tx) => {
    for (let period = 1; period <= 12; period += 1) {
      await tx.execute(sql`
        insert into fiscal_year_period (client, variant, calendar_year, period, period_type, month, day, year_shift, created_by)
        values (${tenant.client}, 'K4', 0, ${period}, 'REGULAR', ${period}, 28, 0, 'AUDIT_TEST')
        on conflict do nothing
      `);
    }
  });
  controller = await createAuditActor(tenant.client, { capabilities: [...CONTROLLER_CAPABILITIES, 'AUDIT.WORKSPACE'] });
}, 60_000);

afterAll(async () => {
  if (tenant) await destroyTenant(tenant.client);
});

describe('the grant is scoped, time-boxed and single', () => {
  it('1. refuses a grant with no scope rows, and says why', async () => {
    const auditor = await newAuditor();
    const error = await expectAuditError(createAuditGrant(grantInput(auditor, { scope: [] })), 'AUDIT_GRANT_NO_SCOPE');
    expect(error.message).toContain('audit_grant_scope');
    expect(error.message).toMatch(/company code, period or module/);
  });

  it('2. refuses a grant with no end date', async () => {
    const auditor = await newAuditor();
    await expectAuditError(createAuditGrant(grantInput(auditor, { validTo: null })), 'AUDIT_GRANT_UNBOXED');
    await expectAuditError(createAuditGrant(grantInput(auditor, { validTo: undefined })), 'AUDIT_GRANT_UNBOXED');
  });

  it('3. refuses a grant that does not end after it starts', async () => {
    const auditor = await newAuditor();
    await expectAuditError(createAuditGrant(grantInput(auditor, { validFrom: iso(5), validTo: iso(5) })), 'AUDIT_GRANT_PERIOD');
    await expectAuditError(createAuditGrant(grantInput(auditor, { validFrom: iso(5), validTo: iso(1) })), 'AUDIT_GRANT_PERIOD');
  });

  it('refuses a period the fiscal year variant does not define, and a company code that does not exist', async () => {
    const auditor = await newAuditor();
    const period = await expectAuditError(
      createAuditGrant(grantInput(auditor, { scope: [{ kind: 'PERIOD', value: `${YEAR}17` }] })),
      'AUDIT_GRANT_PERIOD_UNKNOWN',
    );
    expect(period.message).toContain(`${YEAR}17`);
    await expectAuditError(
      createAuditGrant(grantInput(auditor, { scope: [{ kind: 'COMPANY_CODE', value: 'ZZ99' }] })),
      'AUDIT_GRANT_COMPANY',
    );
  });

  it('4. refuses a second standing grant for the same auditor', async () => {
    const auditor = await newAuditor();
    const first = await createAuditGrant(grantInput(auditor));
    expect(first.status).toBe('ACTIVE');
    const error = await expectAuditError(createAuditGrant(grantInput(auditor)), 'AUDIT_GRANT_DUPLICATE');
    expect(error.message).toContain(first.grantId);
  });

  it('is idempotent on the request key', async () => {
    const auditor = await newAuditor();
    const requestKey = crypto.randomUUID();
    const a = await createAuditGrant(grantInput(auditor, { requestKey }));
    const b = await createAuditGrant(grantInput(auditor, { requestKey }));
    expect(b.grantId).toBe(a.grantId);
  });

  it('refuses a grant from somebody who does not hold AUDIT.ACCESS.GRANT', async () => {
    const auditor = await newAuditor();
    const other = await newAuditor();
    await expectAuditError(
      createAuditGrant({ ...grantInput(auditor), authorization: other.authorization }),
      'AUDIT_AUTHORITY',
    );
  });
});

describe('reads under the grant', () => {
  it('5. allows a read inside the scope and refuses one outside it, naming what was outside', async () => {
    const auditor = await newAuditor();
    const grant = await createAuditGrant(grantInput(auditor));
    expect(grantCovers(grant, { companyCode: tenant.companyCode, module: 'FIN', period: PERIOD })).toBe(true);

    const ok = await assertAuditRead(auditor.actor, { companyCode: tenant.companyCode, module: 'FIN', period: PERIOD }, {
      route: '/finance/journal', detail: 'line items',
    });
    expect(ok.grantId).toBe(grant.grantId);

    const company = await expectAuditError(
      assertAuditRead(auditor.actor, { companyCode: '2000' }, { route: '/finance/journal', detail: 'x' }),
      'AUDIT_OUT_OF_SCOPE',
    );
    expect(company.message).toContain('company code 2000');
    const module = await expectAuditError(
      assertAuditRead(auditor.actor, { module: 'SALES' }, { route: '/sales/documents', detail: 'x' }),
      'AUDIT_OUT_OF_SCOPE',
    );
    expect(module.message).toContain('module SALES');
    const period = await expectAuditError(
      assertAuditRead(auditor.actor, { period: `${Number(YEAR) - 1}01` }, { route: '/finance/journal', detail: 'x' }),
      'AUDIT_OUT_OF_SCOPE',
    );
    expect(period.message).toContain(`period ${Number(YEAR) - 1}01`);
  });

  it('6. refuses a read after the end date, and the grant is now EXPIRED', async () => {
    const auditor = await newAuditor();
    const grant = await createAuditGrant(grantInput(auditor));
    // Time passes: the window closes while the stored status still says ACTIVE.
    await withTenant(tenant.client, (tx) => tx.execute(sql`
      update audit_grant set valid_from = ${iso(-20)}::date, valid_to = ${iso(-1)}::date
       where client = ${tenant.client} and grant_id = ${grant.grantId}
    `));
    await expectAuditError(
      assertAuditRead(auditor.actor, { module: 'FIN' }, { route: '/finance/journal', detail: 'late read' }),
      'AUDIT_GRANT_EXPIRED',
    );
    const status = (await withTenant(tenant.client, (tx) => tx.execute(sql`
      select status from audit_grant where client = ${tenant.client} and grant_id = ${grant.grantId}
    `))) as unknown as Array<{ status: string }>;
    expect(status[0]?.status).toBe('EXPIRED');
    // The refused attempt is itself logged.
    const denied = (await logRows(auditor.userId)).filter((r) => r.event_type === 'CAPABILITY_DENIED');
    expect(denied.at(-1)?.grant_id).toBe(grant.grantId);
  });

  it('7. revoking sets REVOKED, records who revoked, and the next read is refused', async () => {
    const auditor = await newAuditor();
    const grant = await createAuditGrant(grantInput(auditor));
    const revoked = await revokeAuditGrant({
      client: tenant.client, authorization: controller.authorization, grantId: grant.grantId, reason: 'Engagement ended early',
    });
    expect(revoked.status).toBe('REVOKED');
    expect(revoked.storedStatus).toBe('REVOKED');
    expect(revoked.revokedByUserId).toBe(controller.userId);
    expect(revoked.revokedAt).toBeTruthy();
    await expectAuditError(
      assertAuditRead(auditor.actor, { module: 'FIN' }, { route: '/finance/journal', detail: 'after revoke' }),
      'AUDIT_GRANT_REVOKED',
    );
    await expectAuditError(
      revokeAuditGrant({ client: tenant.client, authorization: controller.authorization, grantId: grant.grantId, reason: 'again' }),
      'AUDIT_GRANT_CLOSED',
    );
  });
});

describe('8. structurally impossible to post', () => {
  it('no capability that writes is obtainable through a live grant — driven from the seeded catalogue', async () => {
    const catalogue = (await withTenant(tenant.client, (tx) => tx.execute(sql`
      select code, action from capability order by code
    `))) as unknown as Array<{ code: string; action: string }>;
    expect(catalogue.length).toBeGreaterThan(100);

    const writes = catalogue.filter((c) => !READ_KIND_ACTIONS.includes(c.action) && !AUDIT_GRANT_EXCEPTIONS.includes(c.code));
    const postingKinds = ['POST', 'CHANGE', 'CREATE', 'APPROVE', 'CANCEL', 'REVERSE', 'CONFIRM', 'EXPORT', 'DELETE'];
    // Every posting kind the spec names that the catalogue actually uses is among the writes…
    for (const kind of postingKinds) {
      const seeded = catalogue.filter((c) => c.action === kind);
      for (const c of seeded) {
        if (AUDIT_GRANT_EXCEPTIONS.includes(c.code)) continue;
        expect(writes.map((w) => w.code)).toContain(c.code);
      }
    }
    // …and the one exception is the auditor's own export, which changes nothing in the business.
    expect([...AUDIT_GRANT_EXCEPTIONS]).toEqual(['AUDIT.EVIDENCE.EXPORT']);

    // The auditor's role holds everything: every code by name, and the broadest patterns.
    const auditor = await createAuditActor(tenant.client, {
      capabilities: [...catalogue.map((c) => c.code), 'FIN.*', 'SALES.*', 'PROC.*', 'INV.*', 'PROD.*', 'CO.*', 'AUDIT.*'],
    });
    const before = await withTenant(tenant.client, async (tx) => patternsOf(await effectiveGrants(tx, tenant.client, auditor.userId)));
    expect(hasCapability(before, 'FIN.JOURNAL.POST')).toBe(true);

    const counts = async () => (await withTenant(tenant.client, (tx) => tx.execute(sql`
      select (select count(*)::int from role_capability where client = ${tenant.client}) as role_caps,
             (select count(*)::int from user_capability where client = ${tenant.client}) as user_caps
    `))) as unknown as Array<{ role_caps: number; user_caps: number }>;
    const capsBefore = (await counts())[0];

    const grant = await createAuditGrant(grantInput(auditor));

    // Layer 1: the grant wrote no capability row anywhere.
    expect((await counts())[0]).toEqual(capsBefore);

    // Layer 2a: effectiveGrants() — what every request and can() resolve — holds no write.
    const held = await withTenant(tenant.client, async (tx) => patternsOf(await effectiveGrants(tx, tenant.client, auditor.userId)));
    for (const c of writes) {
      expect(hasCapability(held, c.code), `${c.code} (${c.action}) must not be held under a grant`).toBe(false);
    }
    // The read side survives, including the workspace itself and the export exception.
    expect(hasCapability(held, 'AUDIT.WORKSPACE')).toBe(true);
    expect(hasCapability(held, 'FIN.JOURNAL.DISPLAY')).toBe(true);
    expect(hasCapability(held, 'AUDIT.EVIDENCE.EXPORT')).toBe(true);

    // Layer 2b: the service boundary refuses every write by name, naming the grant.
    await withTenant(tenant.client, async (tx) => {
      for (const c of writes) {
        const verdict = await verifyServiceAuthorityInTx(tx, tenant.client, auditor.authorization, c.code, { requirePlantScope: false });
        expect(verdict.ok, c.code).toBe(false);
        if (!verdict.ok) expect(verdict.refusal.message).toContain(grant.grantId);
      }
    });

    // Layer 1, statically: the audit module never writes a capability row.
    const source = ['schema.ts', 'read-only.ts', 'workspace.ts']
      .map((f) => readFileSync(join(process.cwd(), 'src/modules/audit', f), 'utf8'))
      .join('\n');
    expect(source).not.toMatch(/insert\(\s*(roleCapability|userCapability)/);
    expect(source).not.toMatch(/insert into (public\.)?(role_capability|user_capability)/i);

    // Once the grant ends, the role answers in full again — the grant took nothing away permanently.
    await revokeAuditGrant({ client: tenant.client, authorization: controller.authorization, grantId: grant.grantId, reason: 'done' });
    const after = await withTenant(tenant.client, async (tx) => patternsOf(await effectiveGrants(tx, tenant.client, auditor.userId)));
    expect(hasCapability(after, 'FIN.JOURNAL.POST')).toBe(true);
  }, 120_000);
});

describe('working state', () => {
  it('9. a finding can be raised; responding to your own is refused', async () => {
    const auditor = await newAuditor();
    const grant = await createAuditGrant(grantInput(auditor));
    const finding = await raiseFinding({
      actor: auditor.actor, kind: 'FINDING', subject: 'Unreconciled GR/IR', body: 'Balance on 191100 does not clear.',
    });
    expect(finding.status).toBe('OPEN');
    expect(finding.grantId).toBe(grant.grantId);

    // The controller holds AUDIT.WORKSPACE and AUDIT.REQUEST.RESPOND, and still cannot answer their own request.
    const own = await raiseFinding({ actor: controller.actor, kind: 'REQUEST', subject: 'Own request', body: 'Please confirm.' });
    const error = await expectAuditError(
      respondToFinding({ client: tenant.client, authorization: controller.authorization, findingId: own.findingId, response: 'Yes', status: 'ANSWERED' }),
      'AUDIT_FINDING_OWN',
    );
    expect(error.message).toMatch(/raised this yourself/);
  });

  it('10. a response sets the status and records the responder', async () => {
    const auditor = await newAuditor();
    await createAuditGrant(grantInput(auditor));
    const request = await raiseFinding({
      actor: auditor.actor, kind: 'REQUEST', subject: 'Bank confirmations', body: 'Please provide the year-end bank confirmations.',
    });
    const answered = await respondToFinding({
      client: tenant.client, authorization: controller.authorization, findingId: request.findingId,
      response: 'Uploaded to the evidence share.', status: 'ANSWERED',
    });
    expect(answered.status).toBe('ANSWERED');
    expect(answered.response).toBe('Uploaded to the evidence share.');
    expect(answered.respondedByUserId).toBe(controller.userId);
    expect(answered.respondedAt).toBeTruthy();

    // The auditor cannot answer anything: they do not hold AUDIT.REQUEST.RESPOND.
    await expectAuditError(
      respondToFinding({ client: tenant.client, authorization: auditor.authorization, findingId: request.findingId, response: 'x', status: 'ACCEPTED' }),
      'AUDIT_AUTHORITY',
    );
  });

  it('a bookmark names its object', async () => {
    const auditor = await newAuditor();
    await expectAuditError(
      raiseFinding({ actor: auditor.actor, kind: 'BOOKMARK', subject: 'x', body: 'y' }),
      'AUDIT_FINDING_BOOKMARK',
    );
    const mark = await raiseFinding({
      actor: auditor.actor, kind: 'BOOKMARK', subject: 'Journal 100000001', body: 'Look again',
      objectClass: 'journal_entry', objectKey: '1000/100000001',
    });
    expect(mark.objectKey).toBe('1000/100000001');
  });
});

describe('11. the audited auditor', () => {
  it('every view, search and export writes exactly one access-log row', async () => {
    const auditor = await newAuditor();
    const grant = await createAuditGrant(grantInput(auditor));
    await raiseFinding({ actor: auditor.actor, kind: 'NOTE', subject: 'Walkthrough', body: 'Purchase-to-pay walkthrough done.' });

    let before = (await logRows(auditor.userId)).length;
    await recordAuditView(auditor.actor, '/audit/workspace', 'workspace view');
    let rows = await logRows(auditor.userId);
    expect(rows.length).toBe(before + 1);
    expect(rows.at(-1)).toMatchObject({ event_type: 'READ', object_type: '/audit/workspace', grant_id: grant.grantId });

    before = rows.length;
    await searchChangeHistory(auditor.actor, { objectClass: 'gl_account', objectKey: 'nothing', module: 'FIN' });
    rows = await logRows(auditor.userId);
    expect(rows.length).toBe(before + 1);
    expect(rows.at(-1)?.event_type).toBe('READ');
    expect(rows.at(-1)?.detail).toContain('gl_account');

    before = rows.length;
    const pack = await exportEvidence(auditor.actor);
    expect(pack.rows).toBe(1);
    expect(pack.csv).toContain('Walkthrough');
    rows = await logRows(auditor.userId);
    expect(rows.length).toBe(before + 1);
    expect(rows.at(-1)).toMatchObject({ event_type: 'EXPORT', object_type: '/audit/findings', grant_id: grant.grantId });
  });

  it('the module exposes no update or delete path for the access log', () => {
    const source = readFileSync(join(process.cwd(), 'src/modules/audit/workspace.ts'), 'utf8');
    expect(source).not.toMatch(/update\(\s*auditAccessLog/);
    expect(source).not.toMatch(/delete\(\s*auditAccessLog/);
    expect(source).not.toMatch(/(update|delete from)\s+audit_access_log/i);
  });
});

describe('12. regression: AUDIT.WORKSPACE still widens the existing reads', () => {
  const SITES: Array<[string, number]> = [
    ['src/app/inventory/materials/page.tsx', 1],
    ['src/app/foundation/partners/page.tsx', 4],
    ['src/app/foundation/partners/partner-function-actions.ts', 1],
  ];

  it('all six call sites still test AUDIT.WORKSPACE', () => {
    let total = 0;
    for (const [file, expected] of SITES) {
      const found = readFileSync(join(process.cwd(), file), 'utf8').match(/can\(\s*session\s*,\s*'AUDIT\.WORKSPACE'\s*\)/g) ?? [];
      expect(found.length, file).toBe(expected);
      total += found.length;
    }
    expect(total).toBe(6);
  });

  it('a grant holder still holds AUDIT.WORKSPACE, so those reads still widen for them', async () => {
    const auditor = await newAuditor();
    await createAuditGrant(grantInput(auditor));
    const held = await withTenant(tenant.client, async (tx) => patternsOf(await effectiveGrants(tx, tenant.client, auditor.userId)));
    expect(hasCapability(held, 'AUDIT.WORKSPACE')).toBe(true);
  });
});
