/**
 * Make sure the migration role `cairn_integration_migrator` exists and owns the database,
 * before any migration runs. Idempotent; no business data is touched.
 *
 * Why: `drizzle/0000_baseline.sql` is a pg_dump whose 445 objects say
 * `OWNER TO cairn_integration_migrator`, and the SECURITY DEFINER functions
 * (`job_claim_next`, `notification_deliver`, the payroll triggers) must run as that role.
 * A fresh volume gets the role from `docker/postgres/10-app-role.sh`; a volume initialised
 * before that script created it is repaired here.
 *
 * Connects as the PostgreSQL superuser named by CAIRN_DB_OWNER_USER / CAIRN_DB_OWNER_PASSWORD
 * (passed separately so the password never has to be URL-safe). Host, port and database come
 * from MIGRATION_DATABASE_URL, whose user must be cairn_integration_migrator and whose password
 * becomes the role's password. Without CAIRN_DB_OWNER_PASSWORD it does nothing (dev and test
 * databases are set up by hand; see CLAUDE.md).
 */
import postgres from 'postgres';
import { pathToFileURL } from 'node:url';
import { isProtected } from '../src/platform/db/target-guard';

export const MIGRATOR_ROLE = 'cairn_integration_migrator';
export class MigratorRoleError extends Error {}

export function migratorSettings(env: NodeJS.ProcessEnv) {
  const ownerPassword = env.CAIRN_DB_OWNER_PASSWORD;
  if (!ownerPassword) return null;
  const ownerUser = env.CAIRN_DB_OWNER_USER || 'cairn';
  if (!env.MIGRATION_DATABASE_URL) throw new MigratorRoleError('MIGRATION_DATABASE_URL must be set.');
  let url: URL;
  try { url = new URL(env.MIGRATION_DATABASE_URL); } catch { throw new MigratorRoleError('MIGRATION_DATABASE_URL is invalid; value withheld.'); }
  const user = decodeURIComponent(url.username);
  const password = decodeURIComponent(url.password);
  const database = decodeURIComponent(url.pathname.replace(/^\//, ''));
  if (user !== MIGRATOR_ROLE) throw new MigratorRoleError(`MIGRATION_DATABASE_URL must connect as ${MIGRATOR_ROLE} (the baseline assigns every object to it), not "${user}".`);
  if (!password) throw new MigratorRoleError('MIGRATION_DATABASE_URL must carry the migrator password (CAIRN_MIGRATOR_DB_PASSWORD).');
  if (!database) throw new MigratorRoleError('MIGRATION_DATABASE_URL must name a database.');
  if (ownerUser === MIGRATOR_ROLE || ownerUser === 'cairn_app') throw new MigratorRoleError('CAIRN_DB_OWNER_USER must be the PostgreSQL superuser.');
  return { host: url.hostname, port: Number(url.port || 5432), database, ownerUser, ownerPassword, password };
}

export async function ensureMigratorRole(env: NodeJS.ProcessEnv = process.env) {
  const settings = migratorSettings(env);
  if (!settings) {
    console.log('ensure-migrator-role: CAIRN_DB_OWNER_PASSWORD not set; skipped.');
    return { skipped: true as const };
  }
  if (isProtected(settings.database)) throw new MigratorRoleError(`Database "${settings.database}" is protected.`);

  const sql = postgres({
    host: settings.host, port: settings.port, database: settings.database,
    username: settings.ownerUser, password: settings.ownerPassword,
    max: 1, prepare: false, connect_timeout: 10, onnotice: () => {},
  });
  try {
    const [me] = await sql<{ superuser: boolean }[]>`select rolsuper as superuser from pg_roles where rolname = current_user`;
    if (!me?.superuser) throw new MigratorRoleError(`${settings.ownerUser} is not a superuser; it cannot create ${MIGRATOR_ROLE}.`);

    const changes: string[] = [];
    await sql.begin(async (tx) => {
      const [exists] = await tx`select 1 from pg_roles where rolname = ${MIGRATOR_ROLE}`;
      if (!exists) changes.push('role created');
      const [ddl] = await tx<{ statement: string }[]>`
        select format('%s ROLE %I LOGIN NOSUPERUSER CREATEDB CREATEROLE BYPASSRLS PASSWORD %L',
                      ${exists ? 'ALTER' : 'CREATE'}::text, ${MIGRATOR_ROLE}::text, ${settings.password}::text) as statement`;
      await tx.unsafe(ddl.statement);

      // ADMIN on cairn_app so db:sync-role (run as the migrator) can manage it on PG 16+,
      // without inheriting or assuming it.
      const [app] = await tx`select 1 from pg_roles where rolname = 'cairn_app'`;
      if (app) await tx.unsafe(`GRANT cairn_app TO ${MIGRATOR_ROLE} WITH ADMIN TRUE, INHERIT FALSE, SET FALSE`);

      const [db] = await tx<{ owner: string }[]>`
        select pg_get_userbyid(datdba) as owner from pg_database where datname = current_database()`;
      if (db.owner !== MIGRATOR_ROLE) {
        await tx.unsafe(`ALTER DATABASE "${settings.database.replace(/"/g, '""')}" OWNER TO ${MIGRATOR_ROLE}`);
        changes.push(`database owner ${db.owner} -> ${MIGRATOR_ROLE}`);
      }

      // The migrator's bookkeeping table, if a failed run as another role created it.
      const [ledger] = await tx<{ owner: string }[]>`
        select pg_get_userbyid(relowner) as owner from pg_class where oid = to_regclass('public.cairn_migration')`;
      if (ledger && ledger.owner !== MIGRATOR_ROLE) {
        await tx.unsafe(`ALTER TABLE public.cairn_migration OWNER TO ${MIGRATOR_ROLE}`);
        changes.push(`cairn_migration owner ${ledger.owner} -> ${MIGRATOR_ROLE}`);
      }

      // Anything else in public owned by another role means a schema was migrated as that role:
      // mixed ownership breaks the SECURITY DEFINER functions. Refuse rather than guess.
      const [foreign] = await tx<{ n: number }[]>`
        select count(*)::int as n from pg_class c join pg_namespace n on n.oid = c.relnamespace
         where n.nspname = 'public' and c.relkind in ('r', 'p', 'v', 'm', 'S')
           and pg_get_userbyid(c.relowner) <> ${MIGRATOR_ROLE}`;
      if (foreign.n > 0) {
        throw new MigratorRoleError(
          `${foreign.n} objects in schema public are owned by a role other than ${MIGRATOR_ROLE}. ` +
          'This database was migrated as another role; rebuild it (fresh volume) rather than mixing owners.');
      }
    });
    console.log(`ensure-migrator-role: ${changes.length ? changes.join('; ') : 'already in place'}.`);
    return { skipped: false as const, changes };
  } finally {
    await sql.end({ timeout: 5 });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  ensureMigratorRole().catch((error) => {
    console.error(`ensure-migrator-role failed: ${error instanceof MigratorRoleError ? error.message : (error as Error).message}`);
    process.exit(1);
  });
}
