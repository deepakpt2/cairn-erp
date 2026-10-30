/** Align the managed runtime role with deployment configuration. No business-table writes. */
import postgres from 'postgres';
import { pathToFileURL } from 'node:url';
import { isProtected } from '../src/platform/db/target-guard';

export class CredentialConfigError extends Error {}
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
    });
  } finally { await owner.end({ timeout: 5 }); }
  const app = postgres(settings.applicationURL, { max: 1, prepare: false, connect_timeout: 10, onnotice: () => {} });
  try {
    const [role] = await app<{ elevated: boolean }[]>`select (rolsuper or rolbypassrls) as elevated from pg_roles where rolname = current_user`;
    if (!role || role.elevated) throw new CredentialConfigError('The runtime connection must be restricted: NOSUPERUSER NOBYPASSRLS. Check DATABASE_URL credentials.');
  } finally { await app.end({ timeout: 5 }); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  synchronizeApplicationRole(process.env.DATABASE_URL, process.env.MIGRATION_DATABASE_URL)
    .then(() => console.log('Application database credentials synchronized and restricted login verified.'))
    .catch((error: unknown) => {
      if (error instanceof CredentialConfigError) console.error(error.message);
      else console.error('Database credential synchronization failed. Check owner credentials/permissions; use the documented in-place repair for an existing volume. Values withheld.');
      process.exitCode = 1;
    });
}
