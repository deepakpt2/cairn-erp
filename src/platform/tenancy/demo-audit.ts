/**
 * Demo phase D6_AUDIT — an external audit in progress.
 *
 * The controller grants the demo auditor time-boxed, scoped, read-only access
 * (`/audit/grants`), the auditor works under it (`/audit/workspace`) and raises a
 * finding, a note, a bookmark and two requests to management (`/audit/findings`),
 * and the controller answers one of the requests. The other stays open, so the demo
 * shows both sides: an answered request and one still waiting on management.
 *
 * Everything goes through the product's own services, as the person who would do it:
 * the grant through `createAuditGrant` under a real controller session, the findings
 * through `raiseFinding` as the auditor, the answer through `respondToFinding`.
 *
 * **Resumable by adoption and request key.** The grant carries a fixed request key,
 * which `createAuditGrant` turns into the grant id, so a resumed run is handed the
 * grant that stands. Findings are found by their subject before they are raised, and
 * a request is answered only while it is still open.
 *
 * The window runs from the installation's anchor date for 90 days. A demo installed
 * long ago therefore shows an EXPIRED grant, and the workspace says so — which is the
 * behaviour being demonstrated, not a fault.
 */
import { and, eq, sql } from 'drizzle-orm';

import { withTenant } from '../../platform/db/client';
import { appUser } from '../../platform/tables/security';
import {
  createAuditGrant,
  listFindingsRaisedBy,
  raiseFinding,
  respondToFinding,
} from '../../modules/audit/workspace';
import { DEMO_IDENTITY, DEMO_STRUCTURE } from './demo-organisation';
import { withActingUser } from './demo-people';
import type { DemoTimeline } from './demo-provisioning';

const AUDITOR = 'demo.auditor';
const CONTROLLER = 'demo.controller';

/** Fixed, so a resumed run finds the grant it already gave (request key → grant id). */
export const DEMO_AUDIT_GRANT_REQUEST_KEY = 'd6a0d1a0-0000-4000-8000-000000000001';

const GRANT_DAYS = 90;

const FINDINGS: ReadonlyArray<{
  kind: 'FINDING' | 'NOTE' | 'BOOKMARK' | 'REQUEST';
  subject: string;
  body: string;
  objectClass?: string;
  objectKey?: string;
  answer?: { status: 'ANSWERED' | 'ACCEPTED'; response: string };
}> = [
  {
    kind: 'FINDING',
    subject: 'GR/IR balance carried at period end',
    body: 'Goods received and not yet invoiced remain on the GR/IR clearing account at the last open period. Confirm the open items are timing differences, not unmatched receipts.',
  },
  {
    kind: 'NOTE',
    subject: 'Purchase-to-pay walkthrough',
    body: 'Walked one purchase from order to payment: order, goods receipt, invoice verification and outgoing payment all reconcile to the ledger.',
  },
  {
    kind: 'BOOKMARK',
    subject: 'Company code master — check change history',
    body: 'Review the change documents of the company code before relying on its settings.',
    objectClass: 'company_code',
    objectKey: DEMO_STRUCTURE.companyCode,
  },
  {
    kind: 'REQUEST',
    subject: 'Bank confirmations at period end',
    body: 'Please provide the year-end bank confirmations for every house bank account of company code 1000.',
    answer: { status: 'ANSWERED', response: 'Bank confirmations requested from both banks; copies uploaded to the engagement share.' },
  },
  {
    kind: 'REQUEST',
    subject: 'Credit limit overrides',
    body: 'Please list every credit block released in the open periods, with who released it and why.',
  },
];

export interface DemoAuditResult {
  grantId: string;
  grantStatus: string;
  findings: number;
  answered: number;
}

function addDays(day: string, days: number): string {
  const date = new Date(`${day}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

async function auditorAccount(client: string): Promise<{ userId: string; username: string }> {
  return withTenant(client, async (tx) => {
    const [row] = await tx
      .select({ id: appUser.id, username: appUser.username })
      .from(appUser)
      .where(and(eq(appUser.client, client), sql`upper(${appUser.username}) = ${AUDITOR.toUpperCase()}`))
      .limit(1);
    if (!row) throw new Error(`Demo account ${AUDITOR} was not found in tenant ${client}.`);
    return { userId: row.id, username: row.username };
  });
}

/**
 * Does the tenant lack what this phase stands on — the auditor account, or the
 * controller's authority to grant and answer? True on an installation whose people
 * phase ran under a build that predates the auditor workspace.
 */
export async function demoAuditPrerequisitesMissing(client: string = DEMO_IDENTITY.clientKey): Promise<boolean> {
  return withTenant(client, async (tx) => {
    const rows = (await tx.execute(sql`
      select
        exists (select 1 from app_user where client = ${client} and upper(username) = ${AUDITOR.toUpperCase()}) as auditor,
        (select count(*)::int from role_capability
          where client = ${client} and role_code = 'DEMO_CONTROLLER'
            and capability_code in ('AUDIT.ACCESS.GRANT', 'AUDIT.REQUEST.RESPOND')) as controller_caps
    `)) as unknown as Array<{ auditor: boolean; controller_caps: number }>;
    const row = rows[0];
    return !row?.auditor || Number(row.controller_caps) < 2;
  });
}

export async function buildDemoAudit(input: { client?: string; timeline: DemoTimeline }): Promise<DemoAuditResult> {
  const client = input.client ?? DEMO_IDENTITY.clientKey;
  const auditor = await auditorAccount(client);
  const validFrom = input.timeline.anchorDate;

  // K4 periods are calendar months, so a YYYYMM open period is also its YYYYPP.
  const grant = await withActingUser(client, CONTROLLER, (actor) => createAuditGrant({
    client,
    authorization: actor,
    auditorUserId: auditor.userId,
    validFrom,
    validTo: addDays(validFrom, GRANT_DAYS),
    scope: [
      { kind: 'COMPANY_CODE', value: DEMO_STRUCTURE.companyCode },
      ...input.timeline.openPeriods.map((period) => ({ kind: 'PERIOD', value: period })),
      ...['FIN', 'PROC', 'SALES', 'INV'].map((module) => ({ kind: 'MODULE', value: module })),
    ],
    reason: 'Statutory audit of the demo company — interim fieldwork over the open periods.',
    requestKey: DEMO_AUDIT_GRANT_REQUEST_KEY,
  }));

  const raised = new Map((await listFindingsRaisedBy(client, auditor.userId)).map((f) => [f.subject, f]));
  const actor = { client, userId: auditor.userId, username: auditor.username };
  for (const item of FINDINGS) {
    if (raised.has(item.subject)) continue;
    const finding = await raiseFinding({
      actor,
      grantId: grant.status === 'ACTIVE' ? grant.grantId : null,
      kind: item.kind,
      subject: item.subject,
      body: item.body,
      objectClass: item.objectClass ?? null,
      objectKey: item.objectKey ?? null,
    });
    raised.set(item.subject, finding);
  }

  let answered = 0;
  for (const item of FINDINGS) {
    if (!item.answer) continue;
    const finding = raised.get(item.subject);
    if (!finding) continue;
    if (finding.status !== 'OPEN') {
      answered += 1;
      continue;
    }
    await withActingUser(client, CONTROLLER, (controller) => respondToFinding({
      client,
      authorization: controller,
      findingId: finding.findingId,
      response: item.answer!.response,
      status: item.answer!.status,
    }));
    answered += 1;
  }

  return { grantId: grant.grantId, grantStatus: grant.status, findings: raised.size, answered };
}
