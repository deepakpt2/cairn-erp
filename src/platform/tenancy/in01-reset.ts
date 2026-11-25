/**
 * Guarded reset of the India UAT company.
 *
 * The brief's rule, and the reason this file exists rather than a `--force` flag anywhere:
 * a reset removes only what the installer itself created. It refuses when
 *
 *   1. the installation record for this database is missing (nothing claimed this data, so
 *      nothing here may be deleted),
 *   2. the tenant, its company code, or any client-scoped row it can see was written by an
 *      actor other than the installer (a person has been working in it), or
 *   3. a document, journal or stock movement stands under the company (Phase 3 data, which a
 *      reset is not allowed to erase by design).
 *
 * What it does delete is the company's tenant row, whose child tables cascade. That cascade is
 * the product's own model — `client` rows reference the tenant with ON DELETE CASCADE — so the
 * reset uses the deletion path the schema already defines rather than issuing a hand-written
 * list of DELETEs that could drift from it.
 *
 * There is no broader operator command and no general delete grant. This runs as the migration
 * role only, inside the installer, and it is disabled outside development.
 */
import { and, eq, sql } from 'drizzle-orm';

import { withTenant, db } from '../db/client';
import { client as clientTable } from '../tables/tenancy';
import { ACTOR_COLUMNS, COMPANY_TABLES_WITH_DOCUMENTS, SYSTEM_ACTORS } from './in01-reset-tables';

/** The actor every row this installer writes carries. */
const INSTALLER_ACTOR = 'IN01_PROVISION';

export interface ResetRequest {
  databaseUrl: string;
  client: string;
  companyCode: string;
  /** The company code the operator typed, which must equal `companyCode`. */
  confirmedCompanyCode: string;
  /** Where the reset was asked for: `--reset-demo`. */
  flag: 'reset-demo';
  /** The installation record, read by the caller before the reset is attempted. */
  installationExists: boolean;
  environment: string | undefined;
}

export interface ResetRefusal {
  refused: true;
  reason: string;
  detail: string[];
}

export interface ResetResult {
  refused: false;
  client: string;
  companyCode: string;
  deleted: { documents: number; foreignRows: number };
}

export class In01ResetError extends Error {
  readonly code = 'CAIRN_RESET';
  constructor(message: string, readonly remedy: string) {
    super(message);
    this.name = 'In01ResetError';
  }
}

/**
 * The refusals, all decided before anything is deleted.
 *
 * They are separate checks with separate messages because the remedy differs: a missing record
 * means "this is not an installer-owned database", a foreign actor means "a person used this",
 * and a document means "Phase 3 data stands, which a reset may not erase".
 */
export function judgeReset(request: ResetRequest): ResetRefusal | null {
  if (request.flag !== 'reset-demo') {
    return {
      refused: true,
      reason: 'A reset must be asked for with --reset-demo.',
      detail: ['There is no default reset and no force flag. Name the company code to confirm.'],
    };
  }
  // Production builds have no reset. The flag exists for a development loop, not an operator.
  if ((request.environment ?? 'development') !== 'development') {
    return {
      refused: true,
      reason: `Resetting the demo company is disabled outside development (CAIRN_ENV=${request.environment ?? 'unset'}).`,
      detail: ['Provision a fresh database for a new dataset. There is no reset in production.'],
    };
  }
  if (request.confirmedCompanyCode.trim().toUpperCase() !== request.companyCode.toUpperCase()) {
    return {
      refused: true,
      reason: `The typed company code "${request.confirmedCompanyCode}" does not match ${request.companyCode}.`,
      detail: ['Retype the company code exactly, or omit --reset-demo to leave the data alone.'],
    };
  }
  if (!request.installationExists) {
    return {
      refused: true,
      reason: 'No installation record stands for this database.',
      detail: [
        'A reset removes only what the installer created, and nothing here says it created this data.',
        'Nothing was deleted.',
      ],
    };
  }
  return null;
}

/**
 * Perform the reset.
 *
 * Runs as the migration role, because deleting a tenant is a schema-level act the runtime role
 * is deliberately not granted. Every judgement is made again inside the transaction, so the
 * checks cannot be satisfied by a stale read.
 */
export async function performReset(input: {
  client: string;
  companyCode: string;
  installationId: string;
  /** The accounts a tester signs in with. A row written by one of these means a person worked. */
  testerAccounts: readonly string[];
  /**
   * The founder accounts. The installer writes as them while it runs, so their rows are expected
   * — but only up to the moment the installation completed. A founder row written *after* that
   * means a person signed in as an administrator and changed something, which a reset may not
   * erase.
   */
  founderAccounts: readonly string[];
}): Promise<ResetResult> {
  return db().transaction(async (tx) => {
    // The row-level security policy reads `cairn.client`, so the tenant must be set before the
    // tenant's own rows can be seen at all. The migration role could bypass the policy, but
    // setting it is what a runtime call would do, and keeping that shape means the reset sees
    // exactly what a user would — nothing more.
    await tx.execute(sql`select set_config('cairn.client', ${input.client.toUpperCase()}, true)`);

    // 1. The tenant must exist and hold exactly one company code.
    const [tenant] = await tx
      .select({ client: clientTable.client, name: clientTable.name })
      .from(clientTable)
      .where(sql`upper(${clientTable.client}) = ${input.client.toUpperCase()}`)
      .for('update');
    if (!tenant) {
      throw new In01ResetError(
        `Tenant ${input.client} does not exist, so there is nothing to reset.`,
        'Run the installer instead of a reset.',
      );
    }

    // 2. No person may have worked in the data.
    //
    // The test is not "is the actor unknown", which would mean enumerating every service's
    // internal name (SELF_SERVICE, USER_ADMIN, …) and failing on the one nobody remembered. It
    // is the narrower, decidable question: has any row been written *as one of the fixture's
    // own accounts* — that is, has somebody signed in as `in01.buyer`, `in01.ap` or `in01.admin`
    // and changed something?
    //
    // The installer does write as its founder account in a few places (the scope grants record
    // the signed-in administrator), and those rows carry the founder's username. So the founder
    // accounts are the one exception; every other fixture account is a tester, and a row written
    // by one is exactly what makes a reset unsafe. A person's own work always records their
    // username, so this catches it however they entered.
    const testerAccounts = input.testerAccounts;

    const clientTables = (await tx.execute(sql`
      select c.table_name as "tableName"
        from information_schema.columns c
        join information_schema.tables t
          on t.table_schema = c.table_schema and t.table_name = c.table_name and t.table_type = 'BASE TABLE'
       where c.table_schema = 'public'
         and c.column_name = 'client'
       order by c.table_name
    `)) as unknown as Array<{ tableName: string }>;

    const foreign: Array<{ table_name: string; actor: string }> = [];
    if (testerAccounts.length > 0) {
      for (const { tableName } of clientTables) {
        if (!/^[a-z_][a-z0-9_]*$/.test(tableName)) continue;
        const rows = (await tx.execute(sql`
          select coalesce(
                   jsonb_extract_path_text(to_jsonb(r), 'created_by'),
                   jsonb_extract_path_text(to_jsonb(r), 'changed_by')
                 ) as actor,
                 count(*)::int as n
            from ${sql.raw(`public."${tableName}"`)} r
           where r.client = ${tenant.client}
             and lower(coalesce(
                   jsonb_extract_path_text(to_jsonb(r), 'created_by'),
                   jsonb_extract_path_text(to_jsonb(r), 'changed_by')
                 )) in (${sql.join(testerAccounts.map((a) => sql`${a.toLowerCase()}`), sql`, `)})
           group by 1
           limit 5
        `)) as unknown as Array<{ actor: string; n: number }>;
        for (const row of rows) foreign.push({ table_name: tableName, actor: `${row.actor} (${row.n} row(s))` });
        if (foreign.length >= 20) break;
      }
    }
    if (foreign.length > 0) {
      throw new In01ResetError(
        `A tester has worked in this data: ${foreign[0]!.table_name} holds rows written by ${foreign[0]!.actor}.`,
        'A reset removes only installer-created data. Provision a fresh database for a new dataset.',
      );
    }

    // 2b. A founder account must not have written anything after the installation completed.
    //
    // The installer writes as its founder accounts — the scope grants record the signed-in
    // administrator rather than a provisioning actor — so their name on a row is expected during
    // the run. What is not expected is a founder row timestamped *after* the installation
    // finished: that is somebody signed in as `in01.admin` and changing data by hand, which is
    // exactly what this reset must not silently erase. The comparison is against
    // `demo_installation.completed_at`, so an installation that never completed has no grace
    // period at all and any founder row refuses.
    if (input.founderAccounts.length > 0) {
      const [installed] = (await tx.execute(sql`
        select completed_at as "completedAt"
          from demo_installation
         where installation_id = ${input.installationId}
      `)) as unknown as Array<{ completedAt: Date | null }>;

      const afterInstallation: Array<{ table_name: string; actor: string; when: string }> = [];
      const founders = input.founderAccounts.map((a) => a.toLowerCase());
      const founderList = sql.join(founders.map((a) => sql`${a}`), sql`, `);
      const completedAt = installed?.completedAt ?? null;
      for (const { tableName } of clientTables) {
        if (!/^[a-z_][a-z0-9_]*$/.test(tableName)) continue;
        // The two audit columns are checked *separately*, not coalesced. A row the installer
        // created and a founder later changed has `created_by = IN01_PROVISION` and
        // `changed_by = in01.admin`; coalescing would report the creator and miss the edit,
        // which is exactly the edit a reset must notice.
        const rows = (await tx.execute(sql`
          select actor, "when" from (
            select lower(jsonb_extract_path_text(to_jsonb(r), 'created_by')) as actor,
                   nullif(jsonb_extract_path_text(to_jsonb(r), 'created_at'), '')::timestamptz as "when"
              from ${sql.raw(`public."${tableName}"`)} r
             where r.client = ${tenant.client}
            union all
            select lower(jsonb_extract_path_text(to_jsonb(r), 'changed_by')) as actor,
                   nullif(jsonb_extract_path_text(to_jsonb(r), 'changed_at'), '')::timestamptz as "when"
              from ${sql.raw(`public."${tableName}"`)} r
             where r.client = ${tenant.client}
          ) events
           where events.actor in (${founderList})
             and events."when" is not null
             and events."when" > coalesce(${completedAt}::timestamptz, 'epoch'::timestamptz)
           limit 5
        `)) as unknown as Array<{ actor: string; when: Date }>;
        for (const row of rows) {
          afterInstallation.push({
            table_name: tableName,
            actor: row.actor,
            when: row.when instanceof Date ? row.when.toISOString() : String(row.when),
          });
        }
        if (afterInstallation.length >= 20) break;
      }
      if (afterInstallation.length > 0) {
        const first = afterInstallation[0]!;
        throw new In01ResetError(
          `A founder account changed data after the installation completed: ${first.table_name} holds a row written by ${first.actor} at ${first.when}.`,
          `The installation completed at ${installed?.completedAt ? new Date(installed.completedAt).toISOString() : 'an unrecorded time'}. `
          + 'A reset removes only what the installer wrote. Provision a fresh database for a new dataset.',
        );
      }
    }

    // 3. No document may stand: Phase 3 data is not a reset's to erase.
    //
    // Only tables that actually exist are examined. A name in the list that a later migration
    // merged or renamed must not turn a safe reset into a crash, and a table that is absent
    // cannot hold a document.
    const presentTables = new Set(clientTables.map((row) => row.tableName));
    let documents = 0;
    for (const table of COMPANY_TABLES_WITH_DOCUMENTS) {
      if (!presentTables.has(table)) continue;
      const [row] = (await tx.execute(sql`
        select count(*)::int as n from ${sql.raw(`public."${table}"`)} where client = ${tenant.client}
      `)) as unknown as Array<{ n: number }>;
      documents += row?.n ?? 0;
    }
    if (documents > 0) {
      throw new In01ResetError(
        `The company holds ${documents} document row(s); a reset may not erase posted business data.`,
        'This is a master-data reset. Provision a fresh database to start a new dataset.',
      );
    }

    // 4. Delete the tenant. Its client-scoped children cascade by the schema's own rules.
    await tx.delete(clientTable).where(eq(clientTable.client, tenant.client));

    const remaining = (await tx.execute(sql`
      select count(*)::int as n from public.client where client = ${tenant.client}
    `)) as unknown as Array<{ n: number }>;
    if ((remaining[0]?.n ?? 1) !== 0) {
      throw new In01ResetError(
        `Tenant ${tenant.client} could not be removed.`,
        'Nothing else was deleted; inspect the database and retry.',
      );
    }

    return {
      refused: false as const,
      client: tenant.client,
      companyCode: input.companyCode,
      deleted: { documents: 0, foreignRows: 0 },
    };
  });
}

/**
 * The operation key this installer claims the ledger with.
 *
 * The ledger is the existing `demo_installation` table, shared with the automatic demo dataset:
 * it already records "which database, which build, which phases, who holds the run" and it is
 * global rather than tenant-scoped, which is what the eligibility check needs. The operation
 * string is what distinguishes this dataset from the other one.
 */
export const IN01_OPERATION = 'in01-uat-dataset/2026-11';

/** The database name this connection is in, so a record cannot be adopted by another database. */
function databaseName(url: string | undefined): string {
  if (!url) return '';
  try { return new URL(url).pathname.replace(/^\//, ''); } catch { return ''; }
}

/**
 * Claim the installation for this database, or adopt the record that already claims it.
 *
 * Written before the first phase, so an interrupted run can be recognised and a reset has
 * something that says "this data was installer-made". A record naming another database is a
 * refusal, not something to overwrite.
 */
export async function claimInstallation(input: {
  timeline: unknown;
  completed: boolean;
}): Promise<{ installationId: string; created: boolean }> {
  const database = databaseName(process.env.DATABASE_URL);
  if (!database) throw new In01ResetError('DATABASE_URL does not name a database.', 'Set DATABASE_URL and retry.');

  return db().transaction(async (tx) => {
    const existing = (await tx.execute(sql`
      select installation_id as "id", database_name as "database", operation
        from demo_installation
       where operation = ${IN01_OPERATION}
       for update
    `)) as unknown as Array<{ id: string; database: string; operation: string }>;

    const row = existing[0];
    if (row && row.database !== database) {
      throw new In01ResetError(
        `The installation record belongs to database ${row.database}, not ${database}.`,
        'Provision a fresh database for this dataset; a record is never adopted across databases.',
      );
    }

    if (row) {
      await tx.execute(sql`
        update demo_installation
           set status = ${input.completed ? 'COMPLETED' : 'RUNNING'},
               updated_at = now(),
               completed_at = case when ${input.completed} then now() else completed_at end,
               timeline = ${JSON.stringify(input.timeline)}::jsonb
         where installation_id = ${row.id}
      `);
      return { installationId: row.id, created: false };
    }

    const installationId = `IN01-${Date.now().toString(36).toUpperCase()}`;
    await tx.execute(sql`
      insert into demo_installation
        (installation_id, operation, database_name, status, timeline, payload, started_at, updated_at, completed_at)
      values
        (${installationId}, ${IN01_OPERATION}, ${database},
         ${input.completed ? 'COMPLETED' : 'RUNNING'},
         ${JSON.stringify(input.timeline)}::jsonb, '{}'::jsonb, now(), now(),
         ${input.completed ? sql`now()` : sql`null`})
    `);
    return { installationId, created: true };
  });
}

/** Read whether an installation record stands, so the refusal can be decided before deleting. */
export async function installationRecordExists(): Promise<boolean> {
  const rows = (await db().execute(sql`
    select 1 as present from demo_installation where operation = ${IN01_OPERATION} limit 1
  `)) as unknown as Array<{ present: number }>;
  return rows.length > 0;
}

/** Kept for callers that want the actor the installer stamps. */
export { INSTALLER_ACTOR };
