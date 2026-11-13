/**
 * Dummy-data provisioning: eligibility, claim, and the phase ledger.
 *
 * This module is the whole of the database-safety requirement. It answers one
 * question — may dummy data be written to this database — and it is deliberately
 * built so that the answer is "no" unless every part of the check ran and agreed.
 *
 * Three things are held apart on purpose:
 *
 *   - Eligibility is decided by counting rows, never by reading a marker. A marker
 *     says what a previous run intended; the tables say what is actually there.
 *   - The eligibility check and the claim happen in one transaction under one
 *     advisory lock, so two starts cannot both find the database empty.
 *   - The record of progress is global, not tenant-scoped. Eligibility requires
 *     that no tenant exist, so a record living inside a tenant could be neither
 *     written before the work nor read after an interrupted run.
 *
 * Nothing here deletes, truncates or overwrites. There is no force option, and
 * none is intended.
 */

import { randomUUID } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';

import { assertApplicationRole, db, directSql, type Tx } from '../db/client';

export const DEMO_PROVISION_OPERATION = 'DEMO_PROVISION_V1';
export const DEMO_ADVISORY_LOCK_KEY = 'cairn/demo-provisioning/run';

/**
 * A different key from the run lock, deliberately.
 *
 * Advisory session locks and advisory transaction locks share one lock space. A run
 * holding the session-level lock and then asking for the transaction-level lock on the
 * same key waits for itself, forever — which is exactly what happened when the two
 * keys were one.
 */
export const DEMO_CLAIM_LOCK_KEY = 'cairn/demo-provisioning/claim';

export type DemoInstallationStatus = 'RUNNING' | 'COMPLETED' | 'FAILED';
export type DemoPhaseStatus = 'PENDING' | 'RUNNING' | 'COMPLETED' | 'FAILED';

/**
 * Phases this build implements. Later work appends; it never reorders.
 *
 * A phase is a unit of resumption, not a unit of tidiness. The organisation and the
 * people are split because the second takes minutes and opens administrator
 * sessions: if it dies halfway, the run that follows continues with the accounts
 * that are missing rather than rebuilding the company they hang from.
 */
export const DEMO_PHASE_PLAN: readonly string[] = [
  'A_FOUNDATION', 'B_ORGANISATION', 'B_PEOPLE', 'C_MASTERS', 'D1_PROCUREMENT', 'D2_PRODUCTION',
  'D3_SALES', 'D4_FINANCE', 'D5_QUALITY',
];

export interface DemoTimeline {
  /** The date the installation was claimed. Every generated date is relative to it. */
  anchorDate: string;
  /** Posting periods the dataset may write to, oldest first, as YYYYMM. */
  openPeriods: string[];
  /** Earliest business date the dataset uses: the first day of the first open period. */
  startDate: string;
  /** Latest business date the dataset uses. */
  endDate: string;
}

/**
 * The flag is read once and interpreted strictly.
 *
 * Only an exact affirmative enables provisioning. `TRUE`, `1`, ` yes` and `on` all
 * count, because those are what a person writes in a `.env` file; anything else,
 * including an unset variable, leaves it off. A deployment that misspells the flag
 * gets an empty system, not a populated one.
 */
export function isDemoProvisioningEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = (env.ENABLE_DUMMY_DATA ?? '').trim().toLowerCase();
  return raw === 'true' || raw === '1' || raw === 'yes' || raw === 'on';
}

export interface EligibilityCensus {
  /** Tables carrying a `client` column that were examined. */
  tablesScanned: number;
  /** Those tables that already hold at least one row. */
  conflicts: string[];
}

/**
 * Count the business data in the database by looking at every tenant-owned table.
 *
 * Reference data is not counted because it carries no `client` column: countries,
 * currencies, units of measure, capabilities, configuration activities and the term
 * registry are global and are delivered by `npm run seed` before this runs. Their
 * presence is expected and is not a conflict.
 *
 * Fails closed. If the catalogue cannot be enumerated, `tablesScanned` is 0 and the
 * caller must refuse — a scan that examined nothing has established nothing.
 */
export async function censusDemoEligibility(tx: Tx): Promise<EligibilityCensus> {
  // Both functions are SECURITY DEFINER and take no arguments. They have to be:
  // this runs as `cairn_app`, inside row-level security, with no tenant set — which
  // is the state being verified. A direct `select exists (...)` here returns false
  // for a table full of another tenant's rows, so the check would pass a database
  // that is not remotely empty.
  const scanned = await tx.execute(
    sql`select demo_tenant_table_count() as count`,
  ) as unknown as Array<{ count: number }>;
  const conflicts = await tx.execute(
    sql`select conflicting_table from demo_eligibility_conflicts()`,
  ) as unknown as Array<{ conflicting_table: string }>;

  return {
    tablesScanned: scanned[0]?.count ?? 0,
    conflicts: conflicts.map((row) => row.conflicting_table),
  };
}

export type DemoClaim =
  | { disposition: 'FRESH'; installationId: string; resumeFrom: string | null }
  | { disposition: 'RESUME'; installationId: string; resumeFrom: string | null; completed: string[] }
  | { disposition: 'ALREADY_COMPLETE'; installationId: string }
  | { disposition: 'REFUSE'; reason: string; detail: string[] };

interface InstallationRow {
  installation_id: string;
  operation: string;
  database_name: string;
  status: DemoInstallationStatus;
  timeline: DemoTimeline;
  payload: Record<string, unknown>;
  started_at: Date;
  updated_at: Date;
  completed_at: Date | null;
}

interface PhaseRow {
  phase_code: string;
  status: DemoPhaseStatus;
  attempt: number;
}

/**
 * Decide what this run should do, and record the decision before any data is written.
 *
 * Eligibility is only consulted when no installation exists. Once one does, the
 * database is by definition no longer empty, so asking again would refuse every
 * resume — the record, verified against the data, is what governs from then on.
 */
export async function claimDemoInstallation(input: {
  database: string;
  timeline: DemoTimeline;
  operation?: string;
  phasePlan?: readonly string[];
}): Promise<DemoClaim> {
  await assertApplicationRole();
  const operation = input.operation ?? DEMO_PROVISION_OPERATION;
  const phasePlan = input.phasePlan ?? DEMO_PHASE_PLAN;

  return db().transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${DEMO_CLAIM_LOCK_KEY}, 0))`);

    const existing = await tx.execute(
      sql`select installation_id, operation, database_name, status, timeline, payload,
                 started_at, updated_at, completed_at
            from demo_installation
            for update`,
    ) as unknown as InstallationRow[];
    const row = existing[0];

    if (!row) {
      const census = await censusDemoEligibility(tx);
      if (census.tablesScanned === 0) {
        return {
          disposition: 'REFUSE',
          reason: 'The database could not be surveyed, so its eligibility was not established.',
          detail: ['No tenant-owned tables were found to examine. Refusing rather than assuming an empty database.'],
        } satisfies DemoClaim;
      }
      if (census.conflicts.length > 0) {
        return {
          disposition: 'REFUSE',
          reason: 'This database already contains business data, so dummy-data installation was refused.',
          detail: [
            `${census.conflicts.length} of ${census.tablesScanned} tenant-owned tables already hold rows: ${census.conflicts.slice(0, 20).join(', ')}${census.conflicts.length > 20 ? ', …' : ''}.`,
            'Nothing was written, modified or deleted. Existing business data always takes precedence over the dummy-data flag.',
            'To provision a demo, point the deployment at a genuinely fresh database or volume.',
          ],
        } satisfies DemoClaim;
      }

      const installationId = randomUUID();
      await tx.execute(sql`
        insert into demo_installation
          (installation_id, operation, database_name, status, timeline, payload)
        values (${installationId}, ${operation}, ${input.database}, 'RUNNING',
                ${JSON.stringify(input.timeline)}::jsonb, '{}'::jsonb)
      `);
      for (const phaseCode of phasePlan) {
        await tx.execute(sql`
          insert into demo_installation_phase (installation_id, phase_code, status)
          values (${installationId}, ${phaseCode}, 'PENDING')
        `);
      }
      return {
        disposition: 'FRESH',
        installationId,
        resumeFrom: phasePlan[0] ?? null,
      } satisfies DemoClaim;
    }

    if (row.database_name !== input.database) {
      return {
        disposition: 'REFUSE',
        reason: `The installation record belongs to database ${row.database_name}, not ${input.database}.`,
        detail: ['A marker found in one database says nothing about another. Refusing rather than resuming across them.'],
      } satisfies DemoClaim;
    }
    if (row.operation !== operation) {
      return {
        disposition: 'REFUSE',
        reason: `This database holds a demo dataset from build ${row.operation}; this build produces ${operation}.`,
        detail: ['A different dataset is not a continuation of this one, and the two must not be mixed.'],
      } satisfies DemoClaim;
    }
    if (row.status === 'FAILED') {
      return {
        disposition: 'REFUSE',
        reason: 'A previous dummy-data installation failed and was never recovered.',
        detail: ['The partial dataset was left exactly as it was found. Recover it deliberately, or start from a fresh database.'],
      } satisfies DemoClaim;
    }

    const phases = await tx.execute(sql`
      select phase_code, status, attempt
        from demo_installation_phase
       where installation_id = ${row.installation_id}
       order by phase_code
    `) as unknown as PhaseRow[];

    if (row.status === 'COMPLETED') {
      const missing = phasePlan.filter((code) => !phases.some((p) => p.phase_code === code && p.status === 'COMPLETED'));
      if (missing.length > 0) {
        return {
          disposition: 'REFUSE',
          reason: 'The installation is marked complete but phases of the declared plan never finished.',
          detail: [`Recorded as complete, yet never completed: ${missing.join(', ')}.`, 'A marker that disagrees with the data is refused, not trusted.'],
        } satisfies DemoClaim;
      }
      return { disposition: 'ALREADY_COMPLETE', installationId: row.installation_id } satisfies DemoClaim;
    }

    const failed = phases.filter((p) => p.status === 'FAILED').map((p) => p.phase_code);
    if (failed.length > 0) {
      return {
        disposition: 'REFUSE',
        reason: 'A previous run left a phase in a failed state.',
        detail: [`Failed phase(s): ${failed.join(', ')}.`, 'An interrupted installation is never resumed silently.'],
      } satisfies DemoClaim;
    }

    // A phase added by a later build, in a database claimed by an earlier one.
    for (const phaseCode of phasePlan) {
      if (!phases.some((p) => p.phase_code === phaseCode)) {
        await tx.execute(sql`
          insert into demo_installation_phase (installation_id, phase_code, status)
          values (${row.installation_id}, ${phaseCode}, 'PENDING')
        `);
      }
    }

    const completed = phases.filter((p) => p.status === 'COMPLETED').map((p) => p.phase_code);
    const resumeFrom = phasePlan.find((code) => !completed.includes(code)) ?? null;
    const stale = phases.filter((p) => p.status === 'RUNNING').map((p) => p.phase_code);
    if (stale.length > 0) {
      // The process died mid-phase. The phase is not marked failed — whether it can be
      // re-run depends on what it had already committed, which only the phase knows.
      return {
        disposition: 'RESUME',
        installationId: row.installation_id,
        resumeFrom: stale[0] ?? resumeFrom,
        completed,
      } satisfies DemoClaim;
    }
    return { disposition: 'RESUME', installationId: row.installation_id, resumeFrom, completed } satisfies DemoClaim;
  });
}

/** Mark a phase started. Idempotent: a phase already running is left running. */
export async function startDemoPhase(installationId: string, phaseCode: string): Promise<void> {
  await assertApplicationRole();
  await db().transaction(async (tx) => {
    await tx.execute(sql`
      update demo_installation_phase
         set status = 'RUNNING',
             -- The first start is attempt 1, not 2: the row is inserted with 1 and
             -- only a start that follows a RUNNING or FAILED row is a retry.
             attempt = attempt + case when status in ('RUNNING', 'FAILED') then 1 else 0 end,
             started_at = coalesce(started_at, now()),
             completed_at = null
       where installation_id = ${installationId}
         and phase_code = ${phaseCode}
         and status <> 'COMPLETED'
    `);
    await tx.execute(sql`update demo_installation set updated_at = now() where installation_id = ${installationId}`);
  });
}

/**
 * Record what a phase produced.
 *
 * `detail` is what lets the marker be verified against the data later: counts by
 * category, written by the phase that made them.
 */
export async function completeDemoPhase(
  installationId: string,
  phaseCode: string,
  detail: Record<string, unknown>,
): Promise<void> {
  await completeDemoPhases(installationId, [phaseCode], { [phaseCode]: detail });
}

export async function completeDemoPhases(
  installationId: string,
  phaseCodes: string[],
  details: Record<string, Record<string, unknown>>,
): Promise<void> {
  await assertApplicationRole();
  await db().transaction(async (tx) => {
    for (const phaseCode of phaseCodes) {
      await tx.execute(sql`
        update demo_installation_phase
           set status = 'COMPLETED', completed_at = now(),
               detail = ${JSON.stringify(details[phaseCode] ?? {})}::jsonb
         where installation_id = ${installationId}
           and phase_code = ${phaseCode}
      `);
    }
    await tx.execute(sql`update demo_installation set updated_at = now() where installation_id = ${installationId}`);
  });
}

export async function failDemoPhase(
  installationId: string,
  phaseCode: string,
  reason: string,
): Promise<void> {
  await assertApplicationRole();
  await db().transaction(async (tx) => {
    await tx.execute(sql`
      update demo_installation_phase
         set status = 'FAILED', completed_at = now(),
             detail = ${JSON.stringify({ reason })}::jsonb
       where installation_id = ${installationId}
         and phase_code = ${phaseCode}
    `);
    await tx.execute(sql`
      update demo_installation
         set status = 'FAILED', updated_at = now(), completed_at = now()
       where installation_id = ${installationId}
    `);
  });
}

/**
 * Close the installation once every declared phase is complete.
 *
 * Refuses to close while any phase is outstanding, so a partially built dataset can
 * never come to describe itself as finished.
 */
export async function completeDemoInstallation(
  installationId: string,
  payload: Record<string, unknown>,
): Promise<{ completed: boolean; outstanding: string[] }> {
  await assertApplicationRole();
  return db().transaction(async (tx) => {
    const phases = await tx.execute(sql`
      select phase_code from demo_installation_phase
       where installation_id = ${installationId}
         and status <> 'COMPLETED'
       order by phase_code
    `) as unknown as PhaseRow[];
    const outstanding = phases.map((p) => p.phase_code);
    if (outstanding.length > 0) return { completed: false, outstanding };
    await tx.execute(sql`
      update demo_installation
         set status = 'COMPLETED', completed_at = now(), updated_at = now(),
             payload = ${JSON.stringify(payload)}::jsonb
       where installation_id = ${installationId}
    `);
    return { completed: true, outstanding: [] };
  });
}


/**
 * The calendar every generated date is measured against.
 *
 * It is computed once, when the installation is claimed, and stored. That is the
 * whole point: a run that is interrupted and resumed must place its documents in the
 * same periods as the run that began them, not in periods shifted by however many
 * days passed in between.
 *
 * Three posting periods are open, ending with the month the deployment happened. The
 * three-to-four months of history the dataset describes are carried inside them:
 * everything older arrives as opening balances posted in the first open period,
 * because a period that is closed cannot be posted to and a demo that pretends
 * otherwise is lying about its own books.
 */
export function buildDemoTimeline(now: Date = new Date()): DemoTimeline {
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth();
  const periodStart = (offset: number) => new Date(Date.UTC(year, month - offset, 1));
  const key = (d: Date) => `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
  const iso = (d: Date) => d.toISOString().slice(0, 10);

  const openPeriods = [key(periodStart(2)), key(periodStart(1)), key(periodStart(0))];
  return {
    anchorDate: iso(now),
    openPeriods,
    startDate: iso(periodStart(2)),
    endDate: iso(now),
  };
}


/**
 * Hold the provisioning lock for the whole run, not just for the claim.
 *
 * The advisory lock inside `claimDemoInstallation` is transaction-scoped: it makes the
 * eligibility check and the claim atomic, and then releases. That is not enough. Two
 * containers starting together would each claim in turn, each see the other's
 * RUNNING installation, and each decide it was resuming — which is precisely the
 * "two instances installing the same dataset" the deployment must prevent.
 *
 * This is a session-level lock on a dedicated connection, taken before anything is
 * written and released when the run ends. If the process dies the session ends and
 * PostgreSQL releases it, so a crashed run does not wedge the next one; it is only
 * ever held by a run that is alive.
 *
 * `pg_try_advisory_lock` rather than `pg_advisory_lock`: a second instance is told
 * immediately that another run holds the installation, instead of waiting for a
 * lock that will not be free until the first finishes.
 */
export interface DemoProvisioningLock {
  release(): Promise<void>;
}

export async function acquireDemoProvisioningLock(
  databaseUrl: string,
): Promise<DemoProvisioningLock | null> {
  const connection = directSql(databaseUrl);
  try {
    const rows = await connection.unsafe(
      'select pg_try_advisory_lock(hashtextextended($1, 0)) as acquired',
      [DEMO_ADVISORY_LOCK_KEY],
    ) as unknown as Array<{ acquired: boolean }>;
    if (!rows[0]?.acquired) {
      await connection.end({ timeout: 5 });
      return null;
    }
  } catch (error) {
    await connection.end({ timeout: 5 }).catch(() => undefined);
    throw error;
  }
  return {
    async release() {
      try {
        await connection.unsafe(
          'select pg_advisory_unlock(hashtextextended($1, 0))',
          [DEMO_ADVISORY_LOCK_KEY],
        );
      } finally {
        await connection.end({ timeout: 5 });
      }
    },
  };
}

/**
 * Whether a password has already been issued for this installation.
 *
 * Reading the fingerprint is safe; reading the password would not be, which is why
 * there is no function here that returns one.
 */
export async function readDemoPasswordState(installationId: string): Promise<{
  fingerprint: string | null;
  issuedAt: string | null;
}> {
  await assertApplicationRole();
  const rows = (await db().execute(sql`
    select password_fingerprint, password_issued_at
      from demo_installation
     where installation_id = ${installationId}
  `)) as unknown as Array<{ password_fingerprint: string | null; password_issued_at: Date | string | null }>;
  const row = rows[0];
  return {
    fingerprint: row?.password_fingerprint ?? null,
    issuedAt: row?.password_issued_at ? new Date(row.password_issued_at as string).toISOString() : null,
  };
}

/**
 * Record that a password was issued, without recording the password.
 *
 * Called only after the credential file has been written, so a crash between issuing
 * and delivering leaves the fingerprint null and the next run knows to issue a fresh
 * one rather than to promise a password it never handed over.
 */
export async function recordDemoPasswordIssued(
  installationId: string,
  fingerprint: string,
): Promise<void> {
  await assertApplicationRole();
  // Not guarded on `password_fingerprint is null`: a resumed installation issues a
  // fresh password, because the one the first run chose was never stored, and the
  // recorded date has to answer for the password now in the file rather than for one
  // nobody can produce.
  await db().execute(sql`
    update demo_installation
       set password_fingerprint = ${fingerprint},
           password_issued_at = now(),
           updated_at = now()
     where installation_id = ${installationId}
  `);
}

export async function readDemoInstallation(): Promise<{
  installation: InstallationRow | undefined;
  phases: PhaseRow[];
}> {
  await assertApplicationRole();
  return db().transaction(async (tx) => {
    const installation = await tx.execute(sql`
      select installation_id, operation, database_name, status, timeline, payload,
             started_at, updated_at, completed_at
        from demo_installation
    `) as unknown as InstallationRow[];
    const row = installation[0];
    const phases = row
      ? (await tx.execute(sql`
          select phase_code, status, attempt from demo_installation_phase
           where installation_id = ${row.installation_id} order by phase_code
        `) as unknown as PhaseRow[])
      : [];
    return { installation: row, phases };
  });
}
