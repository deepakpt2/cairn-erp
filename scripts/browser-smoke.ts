/** One browser target per invocation; each owns a disposable, guarded fixture. */
import { strict as assert } from 'node:assert';
import { mkdir } from 'node:fs/promises';
import postgres from 'postgres';
import { TARGETS, FIXTURE_NAME, RUN_TIMEOUT_MS, parseBrowserCommand, isOwnedFixture, type BrowserTarget } from './browser-smoke/targets';
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
  if (target.id === 'payment-terms') return '/config/payment-terms';
  if (target.id === 'payment-methods') return '/config/payment-methods';
  if (target.id === 'storage-locations') return '/config/storage-locations';
  if (target.id === 'purchasing-orgs') return '/config/purchasing-orgs';
  if (target.id === 'business-partners' || target.id === 'supplier-company' || target.id === 'supplier-purchasing' || target.id === 'customer-company' || target.id === 'customer-sales-area') return '/foundation/partners';
  return '/inventory/materials';
}

async function run(target: BrowserTarget) {
  assert.equal(process.env.CAIRN_ENV ?? 'development', 'development', 'Browser smoke runs only against development.');
  const databaseGuard = ACCEPTANCE_DATABASE_GUARDS[target.id];
  if (databaseGuard) await verifyAcceptanceDatabase(databaseGuard);
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
      page.setDefaultTimeout(10_000);
      page.setDefaultNavigationTimeout(15_000);
      const errors: string[] = [];
      page.on('pageerror', (error) => errors.push(error.message));
      let timedOut = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const deadline = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          timedOut = true;
          console.error(`Browser target ${target.id} exceeded ${RUN_TIMEOUT_MS / 1000}s; closing the browser, not starting another target.`);
          void browser.close().catch(() => {});
          reject(new Error(`Browser target ${target.id} exceeded its deadline`));
        }, RUN_TIMEOUT_MS);
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
