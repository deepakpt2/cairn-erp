/** One browser target per invocation; each owns a disposable, guarded fixture. */
import { strict as assert } from 'node:assert';
import { mkdir } from 'node:fs/promises';
import postgres from 'postgres';
import { TARGETS, FIXTURE_NAME, browserRunTimeoutMs, browserTimeoutMs, STATIC_ACCEPTANCE_TARGETS, parseBrowserCommand, isOwnedFixture, type BrowserTarget } from './browser-smoke/targets';
import { ACCEPTANCE_DATABASE_GUARDS, type BrowserAcceptanceDatabaseGuard } from './browser-smoke/database-guards';

function guardedConnectionUrl(
  raw: string | undefined,
  variable: string,
  role: string,
  guard: BrowserAcceptanceDatabaseGuard,
): string {
  assert.ok(raw, `${variable} must be set explicitly for ${guard.batch} browser acceptance.`);
  let url: URL;
  try { url = new URL(raw); }
  catch { throw new Error(`${variable} is not a valid PostgreSQL URL; refusing browser acceptance.`); }
  assert.equal(url.protocol, 'postgresql:', `${variable} must use PostgreSQL.`);
  assert.equal(url.hostname, '127.0.0.1', `${variable} must use loopback; remote databases are forbidden.`);
  assert.equal(url.port, guard.port, `${variable} must target the isolated ${guard.batch} port.`);
  assert.equal(url.pathname, `/${guard.database}`, `${variable} must target only the ${guard.batch} disposable database.`);
  assert.equal(decodeURIComponent(url.username), role, `${variable} must use the expected separated role.`);
  assert.ok(url.password.length > 0, `${variable} must include the isolated test password.`);
  assert.equal(url.search, '', `${variable} must not include unreviewed connection parameters.`);
  return raw;
}

/**
 * Static-database mode (D-097, owner instruction 2026-10-13).
 *
 * Browser acceptance may run against the owner-supplied static test database
 * instead of a per-batch disposable cluster. The mode is explicit
 * (`CAIRN_BROWSER_DB_MODE=static`) and restricted to reviewed targets; the
 * connection binding is derived from `CAIRN_TEST_DATABASE_URL`, so no host,
 * project reference or password is stored in the repository. What is checked:
 *
 *  - the target is on the reviewed allowlist;
 *  - the runtime and migration URLs address exactly the same host, port and
 *    database as the owner-supplied test URL;
 *  - the pooler role convention holds (runtime `cairn_app.<ref>`, migration
 *    `postgres.<ref>`, distinct roles) and no unreviewed parameters are attached;
 *  - at connection time: both roles reach the same database, the runtime role is
 *    NOT elevated, the migration role IS elevated, the server is PostgreSQL 17,
 *    not in recovery, and the schema is provisioned (all migrations recorded).
 *
 * Fixture safety is unchanged and applies in both modes: the runner may only
 * delete the reserved fixture tenant whose key, exact fixture name and
 * development flag all match (isOwnedFixture), and it refuses the run entirely
 * if the reserved key belongs to any other tenant.
 */
function staticAcceptanceUrls(target: BrowserTarget) {
  assert.ok(
    STATIC_ACCEPTANCE_TARGETS.has(target.id),
    `Browser target ${target.id} is not approved for static-database acceptance; use its disposable guard or extend the reviewed allowlist.`,
  );
  const ownerUrl = process.env.CAIRN_TEST_DATABASE_URL;
  assert.ok(ownerUrl, 'CAIRN_TEST_DATABASE_URL must name the owner-supplied static test database.');
  let owner: URL;
  try { owner = new URL(ownerUrl); }
  catch { throw new Error('CAIRN_TEST_DATABASE_URL is not a valid PostgreSQL URL; refusing browser acceptance.'); }

  const bind = (raw: string | undefined, variable: string, prefix: string) => {
    assert.ok(raw, `${variable} must be set explicitly for static-database acceptance.`);
    let url: URL;
    try { url = new URL(raw); }
    catch { throw new Error(`${variable} is not a valid PostgreSQL URL; refusing browser acceptance.`); }
    assert.equal(url.protocol, 'postgresql:', `${variable} must use PostgreSQL.`);
    assert.equal(url.host, owner.host, `${variable} must address the same host:port as CAIRN_TEST_DATABASE_URL.`);
    assert.equal(url.pathname, owner.pathname, `${variable} must address the same database as CAIRN_TEST_DATABASE_URL.`);
    assert.equal(url.search, '', `${variable} must not include unreviewed connection parameters.`);
    const user = decodeURIComponent(url.username);
    assert.ok(user === prefix || user.startsWith(`${prefix}.`), `${variable} must use the ${prefix} role (optionally pooler-qualified).`);
    assert.ok(url.password.length > 0, `${variable} must include a password.`);
    return { url, user };
  };

  const runtime = bind(process.env.DATABASE_URL, 'DATABASE_URL', 'cairn_app');
  const migration = bind(process.env.MIGRATION_DATABASE_URL, 'MIGRATION_DATABASE_URL', 'postgres');
  assert.notEqual(runtime.user, migration.user, 'Static acceptance requires separated runtime and migration roles.');
  return { owner: ownerUrl, runtime: process.env.DATABASE_URL as string, migration: process.env.MIGRATION_DATABASE_URL as string };
}

async function verifyStaticAcceptanceDatabase(target: BrowserTarget) {
  const { owner, runtime, migration } = staticAcceptanceUrls(target);
  const identities: Array<{ url: string; state: 'runtime' | 'migration' }> = [
    { url: runtime, state: 'runtime' },
    { url: migration, state: 'migration' },
  ];
  const seen: Array<{ database: string; role: string; elevated: boolean }> = [];
  for (const { url, state } of identities) {
    const connection = postgres(url, { max: 1, prepare: false, connect_timeout: 15, onnotice: () => {} });
    try {
      const [identity] = await connection<Array<{
        database_name: string;
        role_name: string;
        elevated: boolean;
        version_num: number;
        in_recovery: boolean;
      }>>`
        select current_database() as database_name,
               current_user as role_name,
               (r.rolsuper or r.rolbypassrls) as elevated,
               current_setting('server_version_num')::int as version_num,
               pg_is_in_recovery() as in_recovery
          from pg_roles r where r.rolname = current_user
      `;
      assert.ok(identity, `Static acceptance could not read the ${state} identity.`);
      assert.equal(identity.elevated, state === 'migration', `${state} role elevation is wrong for static acceptance.`);
      assert.equal(Math.floor(Number(identity.version_num) / 10_000), 17, 'Acceptance requires PostgreSQL 17.');
      assert.equal(identity.in_recovery, false);
      seen.push({ database: identity.database_name, role: identity.role_name, elevated: identity.elevated });
    } finally {
      await connection.end({ timeout: 5 });
    }
  }
  assert.equal(seen[0]?.database, seen[1]?.database, 'Runtime and migration URLs must reach the same database.');

  const migrationUrl = new URL(migration);
  const expectedDatabase = decodeURIComponent(migrationUrl.pathname.replace(/^\//, ''));
  const connection = postgres(migration, { max: 1, prepare: false, connect_timeout: 15, onnotice: () => {} });
  try {
    const [schema] = await connection<Array<{ applied: number }>>`
      select count(*)::int as applied from cairn_migration
    `;
    assert.ok(schema && schema.applied >= 50, `Static acceptance requires a provisioned schema (found ${schema?.applied ?? 0} recorded migrations).`);
    console.log(
      `Verified static acceptance database (owner-supplied test target, ${new URL(owner).host}${migrationUrl.pathname}; expected database ${expectedDatabase}): ` +
        `runtime ${seen[0]?.role} restricted, migration ${seen[1]?.role} elevated, ${schema.applied} migrations recorded.`,
    );
  } finally {
    await connection.end({ timeout: 5 });
  }
}

async function verifyAcceptanceDatabase(guard: BrowserAcceptanceDatabaseGuard) {
  // Reject a remote/mistargeted URL from its parsed host before opening a socket.
  const runtimeUrl = guardedConnectionUrl(process.env.DATABASE_URL, 'DATABASE_URL', 'cairn_app', guard);
  const migrationUrl = guardedConnectionUrl(process.env.MIGRATION_DATABASE_URL, 'MIGRATION_DATABASE_URL', 'cairn', guard);
  for (const [url, expectedRole, expectedElevated] of [
    [runtimeUrl, 'cairn_app', false],
    [migrationUrl, 'cairn', true],
  ] as const) {
    const connection = postgres(url, { max: 1, prepare: false, connect_timeout: 5, onnotice: () => {} });
    try {
      const [identity] = await connection<Array<{
        database_name: string;
        server_address: string | null;
        server_port: number;
        role_name: string;
        elevated: boolean;
        version_num: number;
        in_recovery: boolean;
      }>>`
        select current_database() as database_name,
               host(inet_server_addr()) as server_address,
               inet_server_port() as server_port,
               current_user as role_name,
               (r.rolsuper or r.rolbypassrls) as elevated,
               current_setting('server_version_num')::int as version_num,
               pg_is_in_recovery() as in_recovery
          from pg_roles r where r.rolname = current_user
      `;
      assert.equal(identity?.database_name, guard.database);
      assert.equal(identity?.server_address, '127.0.0.1');
      assert.equal(String(identity?.server_port), guard.port);
      assert.equal(identity?.role_name, expectedRole);
      assert.equal(identity?.elevated, expectedElevated);
      assert.equal(Math.floor(Number(identity?.version_num) / 10_000), 17, 'Acceptance requires PostgreSQL 17.');
      assert.equal(identity?.in_recovery, false);
    } finally {
      await connection.end({ timeout: 5 });
    }
  }
  console.log(`Verified ${guard.batch} database: ${guard.database} on 127.0.0.1:${guard.port}; runtime role restricted, migration role elevated.`);
}

function protectedRouteFor(target: BrowserTarget): string {
  if (target.id === 'company-code-definition' || target.id === 'company-code-coa-assignment') return '/config/company-codes';
  if (target.id === 'plant-definition' || target.id === 'plant-company-code-assignment') return '/config/plants';
  if (target.id === 'foundation') return '/finance/journal/new';
  if (target.id === 'tenant-creation') return '/config';
  if (target.id === 'controlling-area') return '/config/controlling-area';
  if (target.id === 'controlling-area-company-assignment') return '/config/controlling-area/assign-company-code';
  if (target.id === 'chart-of-accounts') return '/config/chart-of-accounts';
  if (target.id === 'gl-accounts') return '/config/gl-accounts';
  if (target.id === 'chart-of-accounts-copy') return '/config/chart-of-accounts/copy';
  if (target.id === 'fiscal-year-variant-assignment') return '/config/fiscal-year-variants/assign-company-codes';
  if (target.id === 'fiscal-year-variants') return '/config/fiscal-year-variants';
  if (target.id === 'posting-period-variants') return '/config/posting-period-variants';
  if (target.id === 'posting-period-variant-assignment') return '/config/posting-period-variants/assign-company-codes';
  if (target.id === 'exchange-rates') return '/config/exchange-rates';
  if (target.id === 'tax-codes') return '/config/tax-codes';
  if (target.id === 'banks') return '/config/banks';
  if (target.id === 'house-banks') return '/config/house-banks';
  if (target.id === 'document-types') return '/config/document-types';
  if (target.id === 'tolerance-groups') return '/config/tolerance-groups';
  if (target.id === 'account-determination') return '/config/account-determination';
  if (target.id === 'cost-centers') return '/config/cost-centers';
  if (target.id === 'cost-center-hierarchy') return '/config/cost-center-hierarchy';
  if (target.id === 'activity-types') return '/config/activity-types';
  if (target.id === 'activity-rates') return '/config/activity-rates';
  if (target.id === 'profit-centers') return '/config/profit-centers';
  if (target.id === 'profit-center-hierarchy') return '/config/profit-center-hierarchy';
  if (target.id === 'material-types') return '/config/material-types';
  if (target.id === 'material-groups') return '/config/material-groups';
  if (target.id === 'number-range-objects') return '/config/number-range-objects';
  if (target.id === 'material-number-ranges') return '/config/material-number-ranges';
  if (target.id === 'industry-sectors') return '/config/industry-sectors';
  if (target.id === 'material-deletion-flag') return '/inventory/materials';
  if (target.id === 'material-period-control') return '/config/material-period-control';
  if (target.id === 'purchase-requisitions') return '/purchasing/requisitions';
  if (target.id === 'payment-terms') return '/config/payment-terms';
  if (target.id === 'payment-methods') return '/config/payment-methods';
  if (target.id === 'storage-locations') return '/config/storage-locations';
  if (target.id === 'purchasing-orgs') return '/config/purchasing-orgs';
  if (target.id === 'purchasing-org-company-code') return '/config/purchasing-orgs/assign-company';
  if (target.id === 'purchasing-groups') return '/config/purchasing-groups';
  if (target.id === 'sales-orgs') return '/config/sales-orgs';
  if (target.id === 'sales-org-company-code') return '/config/sales-orgs/assign-company';
  if (target.id === 'sales-org-division') return '/config/sales-orgs/assign-division';
  if (target.id === 'distribution-channels') return '/config/distribution-channels';
  if (target.id === 'divisions') return '/config/divisions';
  if (target.id === 'business-partners' || target.id === 'supplier-company' || target.id === 'supplier-purchasing' || target.id === 'customer-company' || target.id === 'customer-sales-area') return '/foundation/partners';
  return '/inventory/materials';
}

async function run(target: BrowserTarget) {
  assert.equal(process.env.CAIRN_ENV ?? 'development', 'development', 'Browser smoke runs only against development.');
  const staticMode = process.env.CAIRN_BROWSER_DB_MODE === 'static';
  if (staticMode) {
    await verifyStaticAcceptanceDatabase(target);
  } else {
    const databaseGuard = ACCEPTANCE_DATABASE_GUARDS[target.id];
    if (databaseGuard) await verifyAcceptanceDatabase(databaseGuard);
  }
  const [{ chromium }, { sql }, { withTenant, closeDb }, { listTenants }, { CHECKS, onboard }] = await Promise.all([
    import('@playwright/test'), import('drizzle-orm'), import('../src/platform/db/client'),
    import('../src/platform/tenancy'), import('./browser-smoke/checks'),
  ]);
  const BASE = process.env.SMOKE_BASE_URL ?? 'http://127.0.0.1:3000';
  async function cleanup() {
    await withTenant(target.client, async (tx) => {
      await tx.execute(sql`set local statement_timeout = '10s'`);
      await tx.execute(sql`delete from client where client = ${target.client} and name = ${FIXTURE_NAME} and is_development = true`);
    });
  }
  try {
    const previous = (await listTenants()).find((tenant) => tenant.client === target.client);
    if (previous) {
      assert.equal(isOwnedFixture(target, previous), true, 'Reserved test key belongs to another tenant; refusing to change or delete it.');
      await cleanup();
    }
    const browser = await chromium.launch({ headless: true, timeout: 15_000 });
    try {
      const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
      // Contract defaults (30 s / 60 s) assume a loopback database; a reviewed
      // static-database run may raise them through the environment (D-097).
      page.setDefaultTimeout(browserTimeoutMs('CAIRN_BROWSER_PAGE_TIMEOUT_MS', 30_000));
      page.setDefaultNavigationTimeout(browserTimeoutMs('CAIRN_BROWSER_NAV_TIMEOUT_MS', 60_000));
      const errors: string[] = [];
      page.on('pageerror', (error) => errors.push(error.message));
      let timedOut = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const runTimeoutMs = browserRunTimeoutMs();
      const deadline = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          timedOut = true;
          console.error(`Browser target ${target.id} exceeded ${runTimeoutMs / 1000}s; closing the browser, not starting another target.`);
          void browser.close().catch(() => {});
          reject(new Error(`Browser target ${target.id} exceeded its deadline`));
        }, runTimeoutMs);
      });
      try {
        await Promise.race([(async () => {
          await mkdir('.arena', { recursive: true });
          console.log(`Browser target: ${target.id} (${target.label}), fixture ${target.client}`);
          const ctx = { page, base: BASE, target };
          await onboard(ctx);
          await CHECKS[target.id](ctx);
          await page.screenshot({ path: `.arena/${target.id}-review.png`, fullPage: true });
          const signOutRedirect = page.waitForURL((url) => url.pathname === '/signin', { waitUntil: 'commit' });
          await page.getByRole('button', { name: 'Sign out', exact: true }).click({ noWaitAfter: true });
          await signOutRedirect;
          await page.goto(`${BASE}${protectedRouteFor(target)}`, { waitUntil: 'commit' });
          await page.waitForURL(/\/signin\?/, { waitUntil: 'commit' });
          assert.deepEqual(errors, [], 'No browser runtime errors');
          assert.equal(timedOut, false, 'Browser target exceeded its deadline');
          console.log(`\nBrowser target ${target.id} passed; no other target was run.\n`);
        })(), deadline]);
      } catch (error) {
        console.error('Browser URL:', page.url());
        console.error('Browser errors:', errors);
        if (!timedOut && !page.isClosed()) {
          console.error('Visible page:', (await page.locator('body').innerText({ timeout: 2_000 }).catch(() => '')).slice(0, 7000));
          await page.screenshot({ path: `.arena/${target.id}-failure.png`, fullPage: true, timeout: 3_000 }).catch(() => {});
        }
        throw error;
      } finally {
        if (timer) clearTimeout(timer);
      }
    } finally {
      try { await browser.close(); }
      finally { await cleanup(); }
    }
  } finally {
    await closeDb();
  }
}

async function main() {
  const command = parseBrowserCommand(process.argv.slice(2));
  if (command.mode !== 'run') {
    console.log('Usage: npm run smoke:browser -- --target <name>');
    console.log('Default: foundation only. One fresh fixture per target; material targets require published material pages.');
    for (const target of TARGETS) console.log(`  ${target.id.padEnd(22)} ${target.label} [${target.client}]`);
    return;
  }
  await run(command.target);
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
