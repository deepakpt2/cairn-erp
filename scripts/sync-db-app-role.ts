/** Align the managed runtime role with deployment configuration and the
 * least-privilege central-account ACLs. No business-table writes.
 */
import postgres from 'postgres';
import { pathToFileURL } from 'node:url';
import { isProtected } from '../src/platform/db/target-guard';

export class CredentialConfigError extends Error {}

/** These tables are created at different points in the migration sequence. */
export const CENTRAL_AUTH_TABLES = ['app_user', 'user_session', 'password_reset_token'] as const;

export function credentialSettings(applicationURL?: string, ownerURL?: string) {
  if (!applicationURL || !ownerURL) throw new CredentialConfigError('DATABASE_URL and MIGRATION_DATABASE_URL must both be set explicitly.');
  let app: URL; let owner: URL;
  try { app = new URL(applicationURL); owner = new URL(ownerURL); }
  catch { throw new CredentialConfigError('Database connection URL is invalid; values are withheld.'); }
  if (![app, owner].every((url) => ['postgres:', 'postgresql:'].includes(url.protocol))) throw new CredentialConfigError('Both URLs must use PostgreSQL.');
  if (decodeURIComponent(app.username) !== 'cairn_app') throw new CredentialConfigError('The managed application role must be cairn_app.');
  if (decodeURIComponent(owner.username) === 'cairn_app') throw new CredentialConfigError('Use a separate owner connection for credential synchronization.');
  const password = decodeURIComponent(app.password);
  if (!password) throw new CredentialConfigError('The managed application password must not be empty. Set CAIRN_APP_DB_PASSWORD or ensure DATABASE_URL contains a non-empty password.');
  if (!app.pathname || app.pathname === '/' || app.pathname !== owner.pathname) throw new CredentialConfigError('Application and owner URLs must name the same database.');
  return { applicationURL, ownerURL, password };
}

export async function synchronizeApplicationRole(applicationURL?: string, ownerURL?: string) {
  const settings = credentialSettings(applicationURL, ownerURL);

  // Both URLs name the same database (already checked by credentialSettings).
  // Validate targets without connecting as the app role — this script creates
  // the app role, so it cannot verify database identity through app credentials
  // before the role exists. Use isProtected() to refuse protected databases.
  const appDbName = new URL(settings.applicationURL).pathname.replace(/^\//, '');
  const ownerDbName = new URL(settings.ownerURL).pathname.replace(/^\//, '');
  if (isProtected(appDbName) || isProtected(ownerDbName)) {
    throw new CredentialConfigError(`Database "${appDbName}" is protected and cannot be targeted by credential synchronization.`);
  }

  const owner = postgres(settings.ownerURL, { max: 1, prepare: false, connect_timeout: 10, onnotice: () => {} });
  try {
    await owner.begin(async (tx) => {
      const [admin] = await tx<{ manage: boolean }[]>`select (rolsuper or rolcreaterole) as manage from pg_roles where rolname = current_user`;
      if (!admin?.manage) throw new CredentialConfigError('The owner connection must be allowed to manage the application role. Check MIGRATION_DATABASE_URL credentials.');
      const existing = await tx`select 1 from pg_roles where rolname = 'cairn_app'`;
      const command = `${existing.length ? 'ALTER' : 'CREATE'} ROLE cairn_app LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOINHERIT PASSWORD %L`;
      // PostgreSQL formats/escapes the literal. DDL cannot bind a password parameter directly.
      const [ddl] = await tx<{ statement: string }[]>`select pg_catalog.format(${command}::text, ${settings.password}::text) as statement`;
      await tx.unsafe(ddl.statement);

      // Keep the deployment login self-contained: no inherited/SET ROLE access,
      // and only the database/schema connection rights the application needs.
      const memberships = await tx<{ role_name: string }[]>`
        select granted.rolname as role_name
          from pg_auth_members m
          join pg_roles member on member.oid = m.member
          join pg_roles granted on granted.oid = m.roleid
         where member.rolname = 'cairn_app'
         order by granted.rolname
      `;
      for (const membership of memberships) {
        const [revoke] = await tx<{ statement: string }[]>`
          select pg_catalog.format('REVOKE %I FROM cairn_app', ${membership.role_name}::text) as statement
        `;
        await tx.unsafe(revoke.statement);
      }

      const [connectGrant] = await tx<{ statement: string }[]>`
        select pg_catalog.format('GRANT CONNECT ON DATABASE %I TO cairn_app', current_database()) as statement
      `;
      await tx.unsafe(connectGrant.statement);
      await tx.unsafe('GRANT USAGE ON SCHEMA public TO cairn_app');
      await tx.unsafe('REVOKE CREATE ON SCHEMA public FROM cairn_app');

      // The operations container invokes this once before migrations (to ensure
      // the login exists) and once after migrations (to repair/verify ACLs).
      // Conditional discovery lets the pre-migration call safely skip tables
      // not yet created. It also repairs an existing volume in place without
      // replaying or rewriting a schema migration.
      for (const table of CENTRAL_AUTH_TABLES) {
        const [relation] = await tx<{ present: boolean }[]>`
          select to_regclass(${`public.${table}`}::text) is not null as present
        `;
        if (!relation?.present) continue;
        // The names come only from the fixed constant above, never from input.
        await tx.unsafe(`REVOKE ALL PRIVILEGES ON TABLE public.${table} FROM cairn_app`);
        await tx.unsafe(`GRANT SELECT, INSERT, UPDATE ON TABLE public.${table} TO cairn_app`);
      }
    });
  } finally { await owner.end({ timeout: 5 }); }

  const app = postgres(settings.applicationURL, { max: 1, prepare: false, connect_timeout: 10, onnotice: () => {} });
  try {
    const [role] = await app<{
      role: string;
      database: string;
      superuser: boolean;
      bypassrls: boolean;
      inherit: boolean;
      connect: boolean;
      schema_usage: boolean;
      schema_create: boolean;
      memberships: number;
    }[]>`
      select current_user as role, current_database() as database,
             r.rolsuper as superuser, r.rolbypassrls as bypassrls, r.rolinherit as inherit,
             has_database_privilege(current_user, current_database(), 'CONNECT') as connect,
             has_schema_privilege(current_user, 'public', 'USAGE') as schema_usage,
             has_schema_privilege(current_user, 'public', 'CREATE') as schema_create,
             (select count(*) from pg_auth_members m
               join pg_roles member on member.oid = m.member
              where member.rolname = current_user) as memberships
        from pg_roles r where r.rolname = current_user
    `;
    if (!role || role.role !== 'cairn_app' || role.database !== appDbName
        || role.superuser || role.bypassrls || role.inherit || !role.connect
        || !role.schema_usage || role.schema_create || Number(role.memberships) !== 0) {
      throw new CredentialConfigError('The runtime connection must be restricted to the expected cairn_app login and schema/database rights. Check database role configuration.');
    }

    const grants = await app<{
      relname: string;
      can_select: boolean;
      can_insert: boolean;
      can_update: boolean;
      can_delete: boolean;
      can_truncate: boolean;
      can_references: boolean;
      can_trigger: boolean;
    }[]>`
      select c.relname,
             has_table_privilege(current_user, c.oid, 'SELECT') as can_select,
             has_table_privilege(current_user, c.oid, 'INSERT') as can_insert,
             has_table_privilege(current_user, c.oid, 'UPDATE') as can_update,
             has_table_privilege(current_user, c.oid, 'DELETE') as can_delete,
             has_table_privilege(current_user, c.oid, 'TRUNCATE') as can_truncate,
             has_table_privilege(current_user, c.oid, 'REFERENCES') as can_references,
             has_table_privilege(current_user, c.oid, 'TRIGGER') as can_trigger
        from pg_class c
        join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'public' and c.relname = any(${[...CENTRAL_AUTH_TABLES]})
         and c.relkind in ('r', 'p')
    `;
    for (const table of grants) {
      if (!table.can_select || !table.can_insert || !table.can_update
          || table.can_delete || table.can_truncate || table.can_references || table.can_trigger) {
        throw new CredentialConfigError(`Runtime table privileges are not least-privilege for ${table.relname}.`);
      }
    }
  } finally { await app.end({ timeout: 5 }); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  synchronizeApplicationRole(process.env.DATABASE_URL, process.env.MIGRATION_DATABASE_URL)
    .then(() => console.log('Application credentials, central-auth table grants, and restricted runtime role verified.'))
    .catch((error: unknown) => {
      if (error instanceof CredentialConfigError) console.error(error.message);
      else console.error('Database role synchronization failed. Check owner credentials/permissions and migration order; values withheld.');
      process.exitCode = 1;
    });
}
