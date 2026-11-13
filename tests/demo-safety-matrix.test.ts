/**
 * What happens when the run does not finish.
 *
 * Provisioning takes minutes and touches a database nobody has backed up yet, so
 * the question that matters is not what it does when it works but what it does when
 * it is stopped: killed mid-phase, restarted by a deployment that runs twice,
 * pointed at a database that already holds somebody's books, or run against a
 * volume that belongs to another environment.
 *
 * This file holds that matrix and keeps it honest. Each row names the phase, what
 * the phase puts in the database, how a resumed run recognises that it already did
 * the work, and the piece of source that guarantees it — so a row cannot survive a
 * refactor that removed the mechanism it describes. The guards around the matrix
 * are asserted the same way, against the file that implements them rather than
 * against a description of them.
 *
 * The credential file's own permissions and ownership are tested in
 * `tests/demo-credentials.test.ts`; this file is about the run, not the file it
 * leaves behind.
 */

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';

import { withTenant } from '../src/platform/db/client';
import { DEMO_IDENTITY } from '../src/platform/tenancy/demo-organisation';
import {
  DEMO_ADVISORY_LOCK_KEY,
  DEMO_CLAIM_LOCK_KEY,
  DEMO_PHASE_PLAN,
} from '../src/platform/tenancy/demo-provisioning';

const CLIENT = DEMO_IDENTITY.clientKey;

const provisioning = readFileSync('src/platform/tenancy/demo-provisioning.ts', 'utf8');
const provisioner = readFileSync('scripts/demo-provision.ts', 'utf8');
const credentials = readFileSync('src/platform/tenancy/demo-credentials.ts', 'utf8');
const compose = readFileSync('docker-compose.yml', 'utf8');
const dockerfile = readFileSync('Dockerfile', 'utf8');
const migration = readFileSync('drizzle/9273_demo_installation.sql', 'utf8');

function phaseModule(name: string): string {
  return readFileSync(`src/platform/tenancy/demo-${name}.ts`, 'utf8');
}

interface RestartRow {
  phase: string;
  /** What the phase puts in the database. */
  writes: string;
  /** How a run that resumes inside this phase knows the work is already done. */
  resumesBy: string;
  /** Substrings of `scripts/demo-provision.ts` that implement it, so this row cannot outlive them. */
  guaranteedBy: readonly string[];
}

/**
 * The nine phases, and how each one behaves when the run is stopped inside it.
 *
 * A phase is a unit of resumption, not a unit of tidiness. The organisation and the
 * people are split because the second takes minutes and opens administrator
 * sessions: a run that dies there continues with the accounts that are missing
 * rather than rebuilding the company they hang from.
 */
const RESTART_MATRIX: readonly RestartRow[] = [
  {
    phase: 'A_FOUNDATION',
    writes: 'The installation record, the frozen timeline, and the client and its foundation.',
    resumesBy: 'Claimed once. Once the record stands, eligibility is never consulted again — the database is by definition no longer empty, so asking would refuse every resume.',
    guaranteedBy: ['claimDemoInstallation'],
  },
  {
    phase: 'B_ORGANISATION',
    writes: 'The company code, both plants, storage locations, the organisation and its positions, cost centres, profit centres, the internal order, and the demo roles.',
    resumesBy: 'Adoption: a structure element that already stands is adopted rather than created again.',
    guaranteedBy: ['buildDemoOrganisation'],
  },
  {
    phase: 'B_PEOPLE',
    writes: 'The nine accounts, their capability grants and their organisational restrictions.',
    resumesBy: 'Adoption, and one password: a resumed run issues a new password and resets every account to it, because the first run’s password was never stored.',
    guaranteedBy: ['buildDemoPeople', 'setEveryPassword'],
  },
  {
    phase: 'C_MASTERS',
    writes: 'Materials, partners, purchasing info records, selling prices, tax codes, bills of material, routings and production versions. No documents.',
    resumesBy: 'Idempotent by adoption: a material, partner, price, BOM or routing that already reads this way is the work, not a collision.',
    guaranteedBy: ['buildDemoMasters'],
  },
  {
    phase: 'D1_PROCUREMENT',
    writes: 'Opening balances, opening stock, purchase orders, goods receipts, supplier invoices and the first payments.',
    resumesBy: 'Request-keyed: `DEMO-OPENING-*`, `DEMO-GR-*`, `DEMO-IR-*`, `DEMO-PAY-*` and `DEMO-ISS-*`. A second post of the same key is handed the document that stands.',
    guaranteedBy: ['buildDemoProcurement'],
  },
  {
    phase: 'D2_PRODUCTION',
    writes: 'Production orders, component issues against them, confirmations and goods receipts of the finished material.',
    resumesBy: 'Request-keyed: `DEMO-PO-*`, `DEMO-GI-*`, `DEMO-CF-*`, `DEMO-GR-*` and `DEMO-SC-*`.',
    guaranteedBy: ['buildDemoProduction'],
  },
  {
    phase: 'D3_SALES',
    writes: 'Sales orders, deliveries with their goods issues, billing documents and incoming payments.',
    resumesBy: 'Request-keyed, looked up through the phase’s own `findByRequestKey` before each post.',
    guaranteedBy: ['buildDemoSales'],
  },
  {
    phase: 'D4_FINANCE',
    writes: 'Outgoing payments, monthly operating costs, the internal order and its settlement, the GR/IR reclassification, the tax returns and a dunning run.',
    resumesBy: 'Request-keyed, looked up through the phase’s own `findByRequestKey` before each post.',
    guaranteedBy: ['buildDemoFinance'],
  },
  {
    phase: 'D5_QUALITY',
    writes: 'A purchase of inspection stock, two inspection lots, their results, the usage decisions, and the 321 and 323 transfers that follow them.',
    resumesBy: 'Request-keyed: `DEMO-QM-*`, looked up through the phase’s own `findByRequestKey` before each post.',
    guaranteedBy: ['buildDemoQuality'],
  },
];

describe('the demo installation, stopped part way through', () => {
  it('runs last in the operations command, so a refused installation stops the application', () => {
    // The application and the worker are gated on `migrate` completing successfully.
    // Putting the demo step anywhere but last would let the application start over a
    // database the provisioner had just refused.
    const command = dockerfile.match(/CMD \["sh", "-c", "([^"]+)"\]/)?.[1] ?? '';
    expect(command).not.toBe('');
    const steps = command.split('&&').map((step) => step.trim());
    expect(steps[steps.length - 1]).toBe('npm run demo:provision');
    expect(steps[0]).toBe('npm run db:sync-role');

    for (const service of ['app', 'worker']) {
      const block = compose.split(new RegExp(`^  ${service}:`, 'm'))[1]?.split(/\n  [a-z_]+:/)[0] ?? '';
      expect(block).toContain('condition: service_completed_successfully');
    }
  });

  it('never deletes, truncates, or offers a way to force one', () => {
    // There is no reset flag and no cleanup path. A failed installation is left for a
    // person to look at, because the alternative is a flag that erases a database on
    // the strength of a typo in an environment file.
    expect(provisioning).not.toMatch(/\bdelete from\b/i);
    expect(provisioning).not.toMatch(/\btruncate\b/i);
    expect(provisioner).not.toMatch(/\bdelete from\b/i);
    expect(provisioner).not.toMatch(/\btruncate\b/i);
    expect(provisioner).not.toMatch(/\bforce\b/i);
    expect(migration).not.toMatch(/grant[^;]*delete[^;]*demo_installation/i);
  });

  it('holds two different advisory keys, one for the whole run and one for the claim', () => {
    // Advisory session locks and advisory transaction locks share one lock space. A run
    // holding the session-level lock and then asking for the transaction-level lock on
    // the same key waits for itself, forever — which is what happened when the two were
    // one key.
    expect(DEMO_ADVISORY_LOCK_KEY).not.toBe(DEMO_CLAIM_LOCK_KEY);
    expect(provisioning).toContain('pg_try_advisory_lock');
    expect(provisioning).toContain('pg_advisory_xact_lock');
    // The run lock is taken on its own connection, before anything is written, and
    // released when the run ends — so a crashed run does not wedge the next one.
    expect(provisioner).toContain('acquireDemoProvisioningLock');
    expect(provisioner).toContain('another provisioning run already holds this installation');
  });

  it('refuses the databases that belong to something else, on top of the guard every connection passes', () => {
    expect(provisioner).toContain('PROHIBITED_DATABASES');
    expect(provisioner).toContain('validateTarget');
    for (const database of ['cairn_b210', 'cairn_hr_accept', 'cairn_demo', 'cairn_acceptance', 'cairn_integration']) {
      expect(provisioner).toContain(database);
    }
    // The name itself has to be a plausible database name before it is compared with
    // anything, so a URL that names something else entirely is refused early.
    expect(provisioner).toMatch(/is not a valid database name/);
  });

  it('fails closed when it could not survey the database', () => {
    // A scan that examined nothing has established nothing. Counting zero tables as an
    // empty database would populate the very database it failed to read.
    expect(provisioning).toContain('tablesScanned === 0');
    expect(provisioning).toContain('Refusing rather than assuming an empty database');
    expect(provisioning).toContain('demo_tenant_table_count()');
    expect(provisioning).toContain('demo_eligibility_conflicts()');
  });

  it('refuses a marker that disagrees with the data', () => {
    // Four ways a record can lie, and none of them is trusted: a record found in another
    // database, a dataset from a different build, a phase left failed, and an
    // installation marked complete while phases of the declared plan never finished.
    expect(provisioning).toContain('belongs to database');
    expect(provisioning).toContain('this build produces');
    expect(provisioning).toContain('never recovered');
    expect(provisioning).toContain('phases of the declared plan never finished');
    expect(provisioning).toContain("row.status === 'FAILED'");
  });

  it('puts the credentials where the deployment owner can read them, and says where that is', () => {
    // The file is written inside the container; the person who needs it is on the host.
    // A bind mount is the only thing that makes the two the same file.
    expect(compose).toMatch(/- \.\/credentials:\/app\/credentials/);
    expect(compose).toContain('CAIRN_DEMO_CREDENTIALS_MOUNT');
    expect(compose).toContain('CAIRN_DEMO_CREDENTIALS_UID');
    expect(compose).toContain('CAIRN_DEMO_CREDENTIALS_GID');
    // And the report names the host path, not only the container's.
    expect(credentials).toContain('On the host');
  });

  it('declares one runner for every phase of the plan, and refuses to invent one', () => {
    for (const phase of DEMO_PHASE_PLAN) {
      expect(provisioner).toContain(`${phase}: run`);
    }
    // A phase declared but not implemented stops the run rather than being skipped: a
    // dataset missing a phase is not a finished dataset.
    expect(provisioner).toContain('is declared but not implemented');
  });

  it('records a phase before it runs it, and marks it complete or failed afterwards', () => {
    // The ledger is written on the way in, not only on the way out. A phase that died
    // is found RUNNING by the next run, which is what lets it be resumed.
    const started = provisioner.indexOf('await startDemoPhase(');
    const ran = provisioner.indexOf('await run(ctx)');
    const completed = provisioner.indexOf('await completeDemoPhase(');
    expect(started).toBeGreaterThan(-1);
    expect(ran).toBeGreaterThan(started);
    expect(completed).toBeGreaterThan(ran);
    expect(provisioning).toContain("set status = 'RUNNING'");
    expect(provisioning).toContain("set status = 'COMPLETED', completed_at = now()");
    expect(provisioning).toContain("set status = 'FAILED', completed_at = now()");
    // A completed phase is never re-run, and a failed one is never resumed silently.
    expect(provisioner).toContain('claim.completed.includes(phaseCode)');
    expect(provisioner).toContain('It will not be resumed automatically');
  });

  it('states what each phase does on a resumed run, and keeps the statement next to the plan', () => {
    // The matrix is the handover: it is what someone reads deciding whether to restart a
    // container or start from a fresh volume. Keeping it here means a phase cannot be
    // added without saying what it does when it is interrupted.
    expect(RESTART_MATRIX.map((row) => row.phase)).toEqual([...DEMO_PHASE_PLAN]);
    for (const row of RESTART_MATRIX) {
      for (const guarantee of row.guaranteedBy) {
        expect(provisioner).toContain(guarantee);
      }
    }
    // The four dispositions a run can be handed, all of them stated in the code.
    expect(provisioning).toContain("disposition: 'FRESH'");
    expect(provisioning).toContain("disposition: 'RESUME'");
    expect(provisioning).toContain("disposition: 'ALREADY_COMPLETE'");
    expect(provisioning).toContain("disposition: 'REFUSE'");
  });

  it('makes every phase that posts a document request-keyed, so a resumed run cannot post twice', () => {
    // The ledger says which phases finished. It cannot say what a phase had committed
    // before it died, so each phase asks its own question: does a document carrying this
    // request key already stand?
    for (const name of ['procurement', 'production', 'sales', 'finance', 'quality']) {
      expect(phaseModule(name), `demo-${name}.ts`).toContain('requestKey');
    }
    for (const name of ['sales', 'finance', 'quality']) {
      expect(phaseModule(name), `demo-${name}.ts`).toContain('findByRequestKey');
    }
    // The keys are namespaced per phase, so two phases cannot collide on one.
    expect(phaseModule('procurement')).toContain('DEMO-OPENING-BALANCES');
    expect(phaseModule('production')).toContain('DEMO-PO-');
    expect(phaseModule('quality')).toContain('DEMO-QM-');
    // And the masters phase, which writes no documents, is idempotent by adoption.
    expect(phaseModule('masters')).toContain('idempotent by adoption');
  });

  it('leaves a completed installation alone on a second run, and rewrites only the credential file', () => {
    // The dataset is untouched. The credential file is rewritten because a deployment
    // that lost the file cannot be given the password back, but the accounts are still
    // worth listing — with the password shown as not recoverable rather than blank.
    const branch = provisioner.slice(
      provisioner.indexOf("claim.disposition === 'ALREADY_COMPLETE'"),
      provisioner.indexOf('// One password for the whole run'),
    );
    expect(branch).toContain('leaving it unchanged');
    expect(branch).toContain('password: null');
    expect(branch).toContain('return 0');
    // The database holds a fingerprint and never the password, so reading it can never
    // reveal what opens the accounts.
    expect(provisioning).toContain('password_fingerprint');
    expect(provisioning).not.toMatch(/select[^;]*\bpassword\b[^;]*from demo_installation/i);
  });
});

describe('the installation record, on a database it was built in', () => {
  /**
   * These need a database the whole installation has run in — the `cairn_dp_*`
   * disposable databases. Anywhere else they are skipped rather than passed.
   */
  async function installationStands(): Promise<boolean> {
    return withTenant(CLIENT, async (tx) => {
      const rows = (await tx.execute(sql`
        select count(*)::text as n from demo_installation_phase
         where status = 'COMPLETED' and phase_code = any(${[...DEMO_PHASE_PLAN]}::text[])
      `)) as unknown as Array<{ n: string }>;
      return Number(rows[0]?.n ?? 0) === DEMO_PHASE_PLAN.length;
    }).catch(() => false);
  }

  it('is one record, naming the database it was built in', async () => {
    if (!(await installationStands())) return;
    const rows = (await withTenant(CLIENT, async (tx) => {
      const result = await tx.execute(sql`
        select i.database_name, i.status, i.completed_at, current_database() as actual,
               (select count(*)::text from demo_installation) as total
          from demo_installation i
      `);
      return result as unknown as Array<{
        database_name: string;
        status: string;
        completed_at: string | null;
        actual: string;
        total: string;
      }>;
    })) as Array<{
      database_name: string;
      status: string;
      completed_at: string | null;
      actual: string;
      total: string;
    }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.total).toBe('1');
    // A record found in one database says nothing about another, which is why the name
    // is compared with the database the connection is actually in.
    expect(rows[0]!.database_name).toBe(rows[0]!.actual);
    expect(rows[0]!.status).toBe('COMPLETED');
    expect(rows[0]!.completed_at).not.toBeNull();
  });

  it('finished every phase on the first attempt', async () => {
    if (!(await installationStands())) return;
    // A resumed run would show a phase with `attempt` above 1. The dataset this build
    // reconciles was built by one run that did not stop.
    const rows = (await withTenant(CLIENT, async (tx) => {
      const result = await tx.execute(sql`
        select phase_code, attempt from demo_installation_phase order by phase_code
      `);
      return result as unknown as Array<{ phase_code: string; attempt: number }>;
    })) as Array<{ phase_code: string; attempt: number }>;
    expect(rows.map((row) => row.phase_code)).toEqual([...DEMO_PHASE_PLAN]);
    expect(rows.every((row) => Number(row.attempt) === 1)).toBe(true);
  });
});
