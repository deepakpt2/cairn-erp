/** Align the managed runtime role with deployment configuration. No business-table writes. */
import postgres from 'postgres';
import { pathToFileURL } from 'node:url';

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
  if (!password) throw new CredentialConfigError('The managed application password must not be empty.');
  if (!app.pathname || app.pathname === '/' || app.pathname !== owner.pathname) throw new CredentialConfigError('Application and owner URLs must name the same database.');
  return { applicationURL, ownerURL, password };
}

export async function synchronizeApplicationRole(applicationURL?: string, ownerURL?: string) {
  const settings = credentialSettings(applicationURL, ownerURL);
  const owner = postgres(settings.ownerURL, { max: 1, prepare: false, connect_timeout: 10, onnotice: () => {} });
  try {
    await owner.begin(async (tx) => {
      const [admin] = await tx<{ manage: boolean }[]>`select (rolsuper or rolcreaterole) as manage from pg_roles where rolname = current_user`;
      if (!admin?.manage) throw new CredentialConfigError('The owner connection must be allowed to manage the application role.');
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
    if (!role || role.elevated) throw new CredentialConfigError('The runtime connection must be restricted: NOSUPERUSER NOBYPASSRLS.');
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
