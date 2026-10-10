/** One browser target per invocation; each owns a disposable, guarded fixture. */
import { strict as assert } from 'node:assert';
import { mkdir } from 'node:fs/promises';
import { TARGETS, FIXTURE_NAME, RUN_TIMEOUT_MS, parseBrowserCommand, isOwnedFixture, type BrowserTarget } from './browser-smoke/targets';

async function run(target: BrowserTarget) {
  assert.equal(process.env.CAIRN_ENV ?? 'development', 'development', 'Browser smoke runs only against development.');
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
          await page.getByRole('button', { name: 'Sign out', exact: true }).click();
          const protectedPath = target.id === 'foundation' ? '/finance/journal/new' : target.id === 'payment-terms' ? '/config/payment-terms' : (target.id === 'business-partners' || target.id === 'supplier-company' || target.id === 'supplier-purchasing' || target.id === 'customer-company') ? '/foundation/partners' : '/inventory/materials';
          await page.goto(`${BASE}${protectedPath}`, { waitUntil: 'domcontentloaded' });
          await page.waitForURL(/\/signin\?/);
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
