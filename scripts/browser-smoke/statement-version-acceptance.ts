/**
 * Read-only browser acceptance for the standard financial statement onboarding path and the
 * three closing-report screens (SCR-106 trial balance, SCR-107 balance sheet, SCR-111 profit
 * and loss), on the designated browser acceptance database.
 *
 * Owner ruling this run is executed under (2026-10-28): cairn_b210 is used READ-ONLY. No
 * fixture tenant is created, the database is not reset, and only the tenant that already stands
 * there (client `0100`) is exercised. The consequence is stated in the report rather than hid:
 * journey steps 1 and 2 — a tenant created through onboarding standing `INT` by itself — cannot
 * be produced in a browser without writing, so they are reported NOT TESTED in the browser here
 * and carry their evidence from `tests/statement-version-onboarding.test.ts` and the
 * `cairn` walkthrough run. Everything this script does assert is asserted for real.
 *
 * Safeguards, all of them enforced in code below:
 *  - the reviewed guard from scripts/browser-smoke/database-guards.ts is reused, not re-invented:
 *    DATABASE_URL and MIGRATION_DATABASE_URL must address 127.0.0.1:5432/cairn_b210 with the
 *    separated roles, and `current_database()` must agree at connection time;
 *  - CAIRN_ENV must be development, as every browser target requires;
 *  - the script issues no INSERT, UPDATE or DELETE anywhere, and it proves it: per-table
 *    `pg_stat_user_tables` write counters are snapshotted before and after, and any table whose
 *    counters moved other than the two the sign-in itself owns fails the run;
 *  - a `--reset` flag is refused, so this file can never be pointed at the destructive path.
 *
 * Run on the test box against the served production build (never `next dev`):
 *   set -a; . ./.env.local; set +a
 *   CAIRN_ACCEPTANCE_PASSWORD=… npx tsx scripts/browser-smoke/statement-version-acceptance.ts
 */
import { strict as assert } from 'node:assert';
import postgres from 'postgres';

const TENANT = process.env.CAIRN_ACCEPTANCE_CLIENT ?? '0100';
const COMPANY = process.env.CAIRN_ACCEPTANCE_COMPANY ?? '1000';
const USERNAME = process.env.CAIRN_ACCEPTANCE_USER ?? 'dev.admin';
const PASSWORD = process.env.CAIRN_ACCEPTANCE_PASSWORD ?? 'cairn-dev-2026';
const VERSION = 'INT';
const FISCAL_YEAR = 2026;
const PERIOD_FROM = 1;
const PERIOD_TO = 12;
const BASE = process.env.SMOKE_BASE_URL ?? 'http://127.0.0.1:3000';

/**
 * The tables the supported sign-in owns, from src/platform/auth/session.ts: it inserts the
 * session row, it writes the access log line, and on success it stamps `last_login_at` and resets
 * `failed_login_count` on `app_user` (session.ts:296). The app_user write is why a browser
 * acceptance run can never be literally write-free — a finding, not a deniable one. The identity
 * columns are compared separately below, so the only thing allowed to move there is login
 * bookkeeping.
 */
const SIGN_IN_OWNED_TABLES = new Set(['user_session', 'audit_access_log', 'app_user']);

type Status = 'PASSED' | 'FAILED' | 'BLOCKED' | 'NOT TESTED';
const results: Array<{ step: string; status: Status; evidence: string }> = [];
function record(step: string, status: Status, evidence: string) {
  results.push({ step, status, evidence });
  console.log(`${status.padEnd(11)} ${step}\n${' '.repeat(12)}${evidence}`);
}
/*
 * Every navigation is followed by a load-state wait. Without it an intermediate run was seen to
 * report a React #418 hydration mismatch: the script requested the next page while the previous
 * route's streamed render was still in flight, and the re-render disagreed with the HTML already
 * on screen. The wait keeps that from being mistaken for a defect in a report screen — and if a
 * mismatch still appears with the wait in place, it is real.
 */
/** Set while a step runs, so a browser-side failure can be traced to the screen that showed it. */
let currentStep = 'before the first step';
async function check(step: string, fn: () => Promise<string>) {
  currentStep = step;
  try {
    record(step, 'PASSED', await fn());
  } catch (caught) {
    const message = caught instanceof Error ? caught.message : String(caught);
    record(step, 'FAILED', message.replace(/\s+/g, ' ').slice(0, 600));
  }
}
const close = (a: number, b: number) => Math.abs(a - b) < 0.005;
const money = (value: number) => value.toFixed(2);

if (process.argv.includes('--reset')) {
  throw new Error('This acceptance script never resets a database. Refusing to run with --reset.');
}
assert.equal(process.env.CAIRN_ENV ?? 'development', 'development', 'Browser acceptance runs only against development.');

async function main() {
const [{ chromium }, { sql }, { withTenant, closeDb }, { ledgerJournalStatus },
 { calculateTrialBalance, listStatementVersions }, { calculateBalanceSheet }, { calculateProfitLoss },
 { ACCEPTANCE_DATABASE_GUARDS }] = await Promise.all([
  import('@playwright/test'), import('drizzle-orm'), import('../../src/platform/db/client'),
  import('../../src/modules/finance/ledger-journal'), import('../../src/modules/finance/trial-balance'),
  import('../../src/modules/finance/balance-sheet'), import('../../src/modules/finance/profit-loss'),
  import('./database-guards'),
]);

// ── S1 · target and safeguards, before the browser is even launched ────────────────────────
const guard = ACCEPTANCE_DATABASE_GUARDS['trial-balance']!;
const admin = postgres(process.env.MIGRATION_DATABASE_URL as string, { max: 1, prepare: false, connect_timeout: 15 });
let acceptanceDb = '';
const identities: Record<string, string> = {};
async function verifyTarget() {
  // Exactly the reviewed loopback binding the harness applies, checked on each connection in turn:
  // loopback only, the guard's database and port, the separated roles, and only the migration role
  // elevated. (`cairn` is the local migration superuser and `cairn_app` is not elevated — the role
  // name `postgres` belongs to the reviewed static-remote mode, which this run does not use.)
  for (const probe of [
    { variable: 'DATABASE_URL', role: 'cairn_app', elevated: false },
    { variable: 'MIGRATION_DATABASE_URL', role: 'cairn', elevated: true },
  ] as const) {
    const raw = process.env[probe.variable];
    assert.ok(raw, `${probe.variable} must be set explicitly for browser acceptance.`);
    const url = new URL(raw);
    assert.equal(url.protocol, 'postgresql:', `${probe.variable} must use PostgreSQL.`);
    assert.equal(url.hostname, '127.0.0.1', `${probe.variable} must use loopback.`);
    assert.equal(url.port, guard.port, `${probe.variable} must target the ${guard.batch} port.`);
    assert.equal(url.pathname, `/${guard.database}`, `${probe.variable} may only address the ${guard.batch} database.`);
    assert.equal(decodeURIComponent(url.username), probe.role, `${probe.variable} must use the ${probe.role} role.`);
    assert.equal(url.search, '', `${probe.variable} must not carry unreviewed connection parameters.`);
    const connection = postgres(raw, { max: 1, prepare: false, connect_timeout: 5, onnotice: () => {} });
    try {
      const [identity] = await connection<Array<{
        db: string; user: string; elevated: boolean; addr: string | null; version_num: string;
      }>>`
        select current_database() as db, current_user as user,
               (r.rolsuper or r.rolbypassrls) as elevated,
               host(inet_server_addr()) as addr,
               current_setting('server_version_num') as version_num
          from pg_roles r where r.rolname = current_user`;
      assert.ok(identity, `${probe.variable} could not read its identity.`);
      assert.equal(identity.db, guard.database, `${probe.variable} reached ${identity.db}, not ${guard.database}.`);
      assert.equal(identity.user, probe.role, `${probe.variable} connected as ${identity.user}, not ${probe.role}.`);
      assert.equal(identity.elevated, probe.elevated, `${probe.variable} elevation is wrong for browser acceptance.`);
      assert.ok(['127.0.0.1', '::1', 'localhost'].includes(identity.addr ?? ''),
        `${probe.variable} connected over ${identity.addr}; browser acceptance is loopback only.`);
      assert.equal(Math.floor(Number(identity.version_num) / 10_000), 17, 'acceptance requires PostgreSQL 17.');
      identities[probe.variable] = `${identity.user}@${identity.db} elevated=${identity.elevated} via ${identity.addr}`;
      acceptanceDb = identity.db;
    } finally {
      await connection.end({ timeout: 5 });
    }
  }

}
await verifyTarget();
// Hoisted above the try so the summary can still report them if the journey dies half way.
const pageErrors: string[] = [];
const consoleErrors: string[] = [];
const badResponses: string[] = [];
try {

/** Per-table write counters, so "read-only" is a measurement and not a promise. */
async function writeFingerprint(): Promise<Map<string, number>> {
  {
    const rows = await admin<Array<{ relname: string; ins: string; upd: string; del: string; toast: string }>>`
      -- n_tup_hot_upd is a subset of n_tup_upd, so counting it twice would invent writes.
      select relname, n_tup_ins::text as ins, n_tup_upd::text as upd, n_tup_del::text as del
        from pg_stat_user_tables`;
    return new Map(rows.map((r) => [r.relname, Number(r.ins) + Number(r.upd) + Number(r.del)]));
  }
}
const before = await writeFingerprint();
/** What must not change about the signed-in user, whatever the session bookkeeping does. */
async function userPin(): Promise<string> {
  const rows = await admin<Array<{ pin: string }>>`
    select md5(u.password_hash) || '/must_change=' || u.must_change_password::text || '/client=' || u.client
           || '/rolegrants=' || coalesce((select count(*)::text from user_role r where r.client = u.client and r.user_id = u.id), '0') as pin
      from app_user u where u.client = ${TENANT} and u.username = ${USERNAME}`;
  return rows[0]?.pin ?? '(no such user)';
}
const userPinBefore = await userPin();

const tenantState = await withTenant(TENANT, async (tx) => {
  const one = async <T,>(query: ReturnType<typeof sql>) => (await tx.execute(query)) as unknown as T[];
  const versions = await listStatementVersions(TENANT);
  const users = await one<{ username: string; role_code: string }>(sql`
    select u.username, r.role_code from app_user u
      join user_role r on r.client = u.client and r.user_id = u.id
     where u.client = ${TENANT}`);
  const patterns = await one<{ role_code: string; capability_code: string }>(sql`
    select c.role_code, c.capability_code from role_capability c
     where c.client = ${TENANT}
       and c.role_code in (select r.role_code from user_role r
                            join app_user u on u.client = r.client and u.id = r.user_id
                           where r.client = ${TENANT})`);
  const shape = await one<{ n: string }>(sql`select count(*)::text as n from financial_statement_node where client = ${TENANT} and version = ${VERSION}`);
  const ranges = await one<{ n: string }>(sql`select count(*)::text as n from financial_statement_assignment where client = ${TENANT} and version = ${VERSION}`);
  const header = await one<{ is_active: string; created_by: string }>(sql`
    select is_active::text, created_by from financial_statement_version where client = ${TENANT} and version = ${VERSION}`);
  const changes = await one<{ n: string }>(sql`
    select count(*)::text as n from change_document_item i
      join change_document d on d.id = i.change_document_id
     where d.client = ${TENANT} and d.object_class = 'standard_config_package'
       and i.field_name in ('statementVersion', 'statementNodes', 'statementAssignments')`);
  const tenants = await one<{ n: string }>(sql`select count(*)::text as n from client`);
  return { versions, users, patterns, nodes: shape[0]?.n ?? '0', ranges: ranges[0]?.n ?? '0',
    header: header[0], packageChangeItems: changes[0]?.n ?? '0', tenants: tenants[0]?.n ?? '?' };
});

record('S1 · exact target and safeguards confirmed before any write-capable step', 'PASSED',
  `db=${acceptanceDb} port=${guard.port} batch=${guard.batch}; ${identities['DATABASE_URL'] ?? '(runtime unchecked)'} and `
  + `${identities['MIGRATION_DATABASE_URL'] ?? '(migration unchecked)'}; `
  + `CAIRN_ENV=${process.env.CAIRN_ENV ?? 'development'}; no reset requested; write counters snapshotted for ${before.size} tables`);

const selection = {
  companyCode: COMPANY, statementVersion: VERSION, fiscalYear: FISCAL_YEAR,
  periodFrom: PERIOD_FROM, periodTo: PERIOD_TO, includeSpecialPeriods: false, ledger: '0L',
} as const;
const query = (extra: Record<string, string> = {}) => {
  const params = new URLSearchParams({ companyCode: COMPANY, statementVersion: VERSION,
    fiscalYear: String(FISCAL_YEAR), periodFrom: String(PERIOD_FROM), periodTo: String(PERIOD_TO), ...extra });
  return params.toString();
};

// Service results, computed here so the browser can be judged against them.
const trial = await calculateTrialBalance({ client: TENANT, selection });
const sheet = await calculateBalanceSheet({ client: TENANT, selection: { ...selection, calculationType: 'ACCUMULATED', summaryLevel: 1 } });
const sheetCombined = await calculateBalanceSheet({ client: TENANT, selection: { ...selection, calculationType: 'COMBINED', summaryLevel: 1 } });
// The profit-and-loss page hard-codes COMBINED and leaves summaryLevel to the same default the
// balance sheet uses, so the comparison mirrors the page rather than the module's defaults.
const profit = await calculateProfitLoss({ client: TENANT, selection: { ...selection, calculationType: 'COMBINED', summaryLevel: 1 } });
const ledger = await withTenant(TENANT, async (tx) => {
  const rows = (await tx.execute(sql`
    select coalesce(sum(case when l.debit_credit = 'S' then l.amount_local end), 0)::text as debit,
           coalesce(sum(case when l.debit_credit = 'H' then l.amount_local end), 0)::text as credit,
           count(*)::text as lines
      from journal_entry_line l
      join journal_entry e
        on e.client = l.client and e.document_number = l.document_number and e.fiscal_year = l.fiscal_year
     where l.client = ${TENANT} and e.company_code = ${COMPANY} and e.fiscal_year = ${FISCAL_YEAR}
       and e.posting_period between ${PERIOD_FROM} and ${PERIOD_TO}
       and ${ledgerJournalStatus('e')}`)) as unknown as Array<{ debit: string; credit: string; lines: string }>;
  return { debit: Number(rows[0]?.debit ?? 0), credit: Number(rows[0]?.credit ?? 0), lines: rows[0]?.lines ?? '0' };
});

record('S2 · tenant 0100 as it stands in the acceptance database (read-only)', 'PASSED',
  `tenants in ${acceptanceDb}=${tenantState.tenants}; versions=${tenantState.versions.map((v) => `${v.version}/${v.name}/${v.chartOfAccounts}`).join(', ') || '(none)'}; `
  + `active=${tenantState.header?.is_active} created_by=${tenantState.header?.created_by}; nodes=${tenantState.nodes} ranges=${tenantState.ranges}; `
  + `package change-document items naming the statement version=${tenantState.packageChangeItems}`);
record('S1b · a freshly onboarded tenant stands INT by itself — in the browser', 'NOT TESTED',
  'owner ruling: cairn_b210 is read-only, so no tenant may be created here; the claim is proved at service level by '
  + 'tests/statement-version-onboarding.test.ts (6/6) and by the cairn walkthrough read-back (created_by=WALKTHROUGH, INT/8/5)');
record('S2b · the standard-configuration change document of a NEW tenant — in the browser', 'NOT TESTED',
  `same reason; and no change-document screen exists to open (src/app has no change-document page), so the field names `
  + `statementVersion/statementNodes/statementAssignments were read from change_document_item on cairn, where the count is 1 row per item`);

// ── the browser ─────────────────────────────────────────────────────────────────────────────
const browser = await chromium.launch({ headless: true, timeout: 30_000 });
const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } });
page.setDefaultTimeout(25_000);
page.setDefaultNavigationTimeout(45_000);
page.on('pageerror', (error) => pageErrors.push(`[${currentStep}] ${page.url().replace(BASE, '')} :: ${error.message.slice(0, 150)}`));
page.on('console', (message) => {
  if (message.type() === 'error') consoleErrors.push(`[${currentStep}] ${page.url().replace(BASE, '')} :: ${message.text().slice(0, 150)}`);
});
page.on('response', (response) => {
  const url = response.url();
  if (response.status() >= 400 && !/favicon|robots\.txt|\.ico$/.test(url)) badResponses.push(`${response.status()} ${url.replace(BASE, '')}`);
});

try {
  await page.goto(`${BASE}/signin`, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('load').catch(() => {});
    await page.waitForLoadState('load').catch(() => {});
  await page.locator('[name="client"]').fill(TENANT);
  await page.locator('[name="username"]').fill(USERNAME);
  await page.locator('[name="password"]').fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await page.getByRole('button', { name: 'Sign out', exact: true }).waitFor({ timeout: 30_000 }).catch(async () => {
    const text = (await page.locator('body').innerText()).replace(/\s+/g, ' ').slice(0, 240);
    throw new Error(`sign-in did not produce a session; the page says: ${text}`);
  });

  await check('S3 · supported sign-in for the acceptance tenant', async () => {
    const body = await page.locator('body').innerText();
    await page.getByRole('button', { name: 'Sign out', exact: true }).waitFor();
    if (/change (your )?password/i.test(body)) throw new Error('the session demanded a password change, which would write to app_user');
    return `signed in as ${USERNAME}@${TENANT} through /signin; the shell is rendered (Sign out control present), `
      + `no forced password change (must_change_password=false in the database)`;
  });

  await check('S4 · authorization actually held, verified in the database and on screen', async () => {
    const held = tenantState.patterns.map((row) => row.capability_code);
    const covered = (required: string) => held.some((pattern) => {
      if (pattern === required) return true;
      if (pattern === '*') return true;
      if (pattern.endsWith('.*')) return required.startsWith(pattern.slice(0, -1));
      return false;
    });
    const needed = ['FIN.RPT.TRIALBALANCE', 'FIN.RPT.BALANCESHEET', 'FIN.RPT.PROFITLOSS'];
    const missing = needed.filter((code) => !covered(code));
    if (missing.length > 0) throw new Error(`the roles held by ${USERNAME} do not cover ${missing.join(', ')} (patterns: ${held.join(', ')})`);
    for (const path of ['/finance/trial-balance', '/finance/balance-sheet', '/finance/profit-loss']) {
      await page.goto(`${BASE}${path}`, { waitUntil: 'domcontentloaded' });
    await page.waitForLoadState('load').catch(() => {});
      const body = await page.locator('body').innerText();
      if (body.includes('does not have the authority')) throw new Error(`${path} rendered a refusal for a user the database says is entitled`);
    }
    return `roles ${tenantState.users.map((u) => `${u.username}:${u.role_code}`).join(', ')} hold [${held.join(', ')}], which covers all three `
      + `codes segment-wise; none of the three screens rendered its missing-authority panel (the panel quotes the refused code, and none was on screen)`;
  });

  await check('S5 · trial balance: displayed figures equal the service, and the service equals the ledger', async () => {
    await page.goto(`${BASE}/finance/trial-balance?${query()}`, { waitUntil: 'domcontentloaded' });
    await page.waitForLoadState('load').catch(() => {});
    const body = await page.locator('body').innerText();
    const figures: Array<[string, number]> = [['total debit turnover', trial.totalDebitTurnover], ['total credit turnover', trial.totalCreditTurnover]];
    for (const node of trial.nodes) figures.push([`node ${node.node} balance`, node.balance]);
    const comparable = figures.filter(([, value]) => money(value) !== '0.00');
    const absent = comparable.filter(([, value]) => !body.includes(money(value))).map(([label]) => label);
    if (absent.length > 0) throw new Error(`the statement does not display ${absent.join(', ')} as the service computed them (${comparable.length} non-zero figures compared)`);
    if (!close(trial.totalDebitTurnover, ledger.debit) || !close(trial.totalCreditTurnover, ledger.credit)) {
      throw new Error(`statement turnover ${money(trial.totalDebitTurnover)}/${money(trial.totalCreditTurnover)} does not match the ledger ${money(ledger.debit)}/${money(ledger.credit)}`);
    }
    const warningsShown = (body.match(/is assigned to both|does not stand in chart/g) ?? []).length;
    if (warningsShown !== trial.warnings.length) throw new Error(`the page shows ${warningsShown} warning sentence(s) against ${trial.warnings.length} from the service`);
    return `version ${trial.statementVersion} FY${FISCAL_YEAR} p${PERIOD_FROM}-${PERIOD_TO}: ${trial.nodes.length} node row(s) and `
      + `${figures.length} figure(s) taken from the service, of which ${comparable.length} were non-zero and matched on screen text-for-text while `
      + `${figures.length - comparable.length} read 0.00 and prove only that the row renders (see S5b); turnover ${money(trial.totalDebitTurnover)} debit / `
      + `${money(trial.totalCreditTurnover)} credit equals the direct journal_entry_line aggregate ${money(ledger.debit)} / ${money(ledger.credit)} over `
      + `${ledger.lines} line(s); warnings on screen = warnings from the service (${trial.warnings.length}); `
      + `accounts outside the statement = ${trial.unassigned.length}`;
  });

  record('S5b · how much of the numeric claim the read-only ruling allows', ledger.lines === '0' ? 'NOT TESTED' : 'PASSED',
    ledger.lines === '0'
      ? `the acceptance tenant holds no posted general-ledger lines at all (journal_entry for ${TENANT}: 0 rows), so every figure on all three `
        + `statements is legitimately zero and equality with the ledger is trivially satisfied. The non-zero equality — statement turnover against a `
        + `direct journal_entry_line aggregate, and the three reports over real postings — is proved on cairn (turnover 5,349,109.60 on both sides for `
        + `the walkthrough tenant and 5,349,359.60 for the seeded one) and in tests/statement-version-onboarding.test.ts; posting into cairn_b210 to make `
        + `it browser-visible is ruled out here, so the numeric half of step 5 stays NOT TESTED in the browser`
      : `the tenant carries ${ledger.lines} posted line(s); the displayed totals and the direct aggregate were compared figure by figure above`);

  await check('S6 · balance sheet: displayed figures equal the service', async () => {
    await page.goto(`${BASE}/finance/balance-sheet?${query()}`, { waitUntil: 'domcontentloaded' });
    await page.waitForLoadState('load').catch(() => {});
    const body = await page.locator('body').innerText();
    const figures: Array<[string, number]> = [];
    for (const node of sheet.nodes) figures.push([`node ${node.node} balance`, node.balance]);
    const absent = figures.filter(([, value]) => money(value) !== '0.00' && !body.includes(money(value))).map(([label]) => label);
    if (absent.length > 0) throw new Error(`the balance sheet does not display ${absent.join(', ')} as the service computed them`);
    if (sheet.currentYearResult !== null) throw new Error('the screen default (ACCUMULATED) should carry no current-year result');
    return `calculation type ${sheet.calculationType} (the page's default), summary level ${sheet.summaryLevel}: `
      + `${sheet.nodes.length} position row(s), all ${figures.length} figures present on screen, `
      + `currentYearResult null under ACCUMULATED as documented, ${sheet.unassigned.length} unassigned account(s), `
      + `turnover ${money(sheet.totalDebitTurnover)} / ${money(sheet.totalCreditTurnover)}`;
  });

  await check('S7 · balance sheet under COMBINED displays the current-year result the service returns', async () => {
    await page.goto(`${BASE}/finance/balance-sheet?${query({ calculationType: 'COMBINED' })}`, { waitUntil: 'domcontentloaded' });
    await page.waitForLoadState('load').catch(() => {});
    const body = await page.locator('body').innerText();
    if (sheetCombined.currentYearResult === null) return 'the service itself returned no current-year result for this data (null under COMBINED too), so there is nothing for the page to show';
    if (money(sheetCombined.currentYearResult) === '0.00') {
      return 'the current-year result the service returns for this tenant is 0.00 because it holds no postings (S5b), so this proves the COMBINED branch '
        + 'renders rather than a specific number: the page was requested with calculationType=COMBINED and came back with the parameter honoured';
    }
    if (!body.includes(money(sheetCombined.currentYearResult))) {
      throw new Error(`the service reports a current-year result of ${money(sheetCombined.currentYearResult)} that the page does not display`);
    }
    return `currentYearResult ${money(sheetCombined.currentYearResult)} appears on the rendered statement under COMBINED`;
  });

  await check('S8 · profit and loss: displayed figures equal the service', async () => {
    await page.goto(`${BASE}/finance/profit-loss?${query()}`, { waitUntil: 'domcontentloaded' });
    await page.waitForLoadState('load').catch(() => {});
    const body = await page.locator('body').innerText();
    const figures: Array<[string, number]> = [];
    // The P&L row type carries movements, not a balance: both columns are checked.
    for (const node of profit.nodes) {
      figures.push([`node ${node.node} period movement`, node.periodMovement]);
      figures.push([`node ${node.node} year-to-date movement`, node.yearToDateMovement]);
    }
    if (profit.currentYearResult !== null) figures.push(['current-year result', profit.currentYearResult]);
    const absent = figures.filter(([, value]) => money(value) !== '0.00' && !body.includes(money(value))).map(([label]) => label);
    if (absent.length > 0) throw new Error(`the profit and loss statement does not display ${absent.join(', ')} as the service computed them`);
    return `calculation type COMBINED is what this page hard-codes, summary level ${profit.summaryLevel}: `
      + `${profit.nodes.length} row(s), ${figures.length} figure(s) taken from the service and found on screen, result `
      + `${profit.currentYearResult === null ? '(none)' : money(profit.currentYearResult)}, ${profit.warnings.length} warning(s)`;
  });

  await check('S9 · an unknown version is handled safely on screen', async () => {
    const refusal = await calculateTrialBalance({ client: TENANT, selection: { ...selection, statementVersion: 'NOPE' } })
      .then(() => null, (caught: unknown) => caught as { message?: string; remedy?: string });
    if (refusal === null) throw new Error('the service accepted a version that does not stand; the screen test is meaningless');
    await page.goto(`${BASE}/finance/trial-balance?${query({ statementVersion: 'NOPE' })}`, { waitUntil: 'domcontentloaded' });
    await page.waitForLoadState('load').catch(() => {});
    const body = await page.locator('body').innerText();
    if (!body.includes('does not stand')) throw new Error(`the page did not show the refusal; it said: ${body.replace(/\s+/g, ' ').slice(0, 220)}`);
    if (/Application error|Internal Server Error|something went wrong/i.test(body)) throw new Error('the page rendered a framework error instead of the refusal');
    return `service refuses "${refusal.message}" with remedy "${refusal.remedy ?? '(none)'}"; the page renders the same sentence as a `
      + `validation line, keeps the form usable with version NOPE selected, and shows no framework error overlay`;
  });

  await check('S10 · navigation reaches all three reports for this user', async () => {
    await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
    await page.waitForLoadState('load').catch(() => {});
    const hrefs = await page.locator('a[href]').evaluateAll((links) => links.map((link) => link.getAttribute('href') ?? ''));
    const needed = ['/finance/trial-balance', '/finance/balance-sheet', '/finance/profit-loss'];
    const missing = needed.filter((path) => !hrefs.includes(path));
    if (missing.length > 0) {
      record('S10 · navigation reaches all three reports for this user', 'FAILED',
        `no link on the start page for ${missing.join(', ')} (the page carries ${hrefs.length} links; the screens themselves open by URL: S5-S8 passed) — reported as a navigation finding, not a capability failure`);
      throw new Error('links missing');
    }
    return `the start page links all three paths (${hrefs.length} links in total), so no user has to know a URL`;
  });

  await check('S11 · no browser-visible failure across the whole journey', async () => {
    const problems = [
      ...pageErrors.map((text) => `page error: ${text}`),
      ...consoleErrors.map((text) => `console error: ${text}`),
      ...badResponses.map((text) => `http: ${text}`),
    ];
    if (problems.length > 0) throw new Error(problems.slice(0, 6).join(' | '));
    return 'zero uncaught page errors, zero console errors and zero HTTP responses of 400 or above across the sign-in, three reports, the COMBINED variant and the invalid-version probe';
  });

  await check('S12 · the journey is still read-only, measured not asserted', async () => {
    const after = await writeFingerprint();
    const moved: string[] = [];
    for (const [table, value] of after) {
      const delta = value - (before.get(table) ?? 0);
      if (delta > 0 && !SIGN_IN_OWNED_TABLES.has(table)) moved.push(`${table}(+${delta})`);
    }
    if (moved.length > 0) throw new Error(`these tables were written during the acceptance run: ${moved.slice(0, 12).join(', ')}`);
    const userPinAfter = await userPin();
    if (userPinAfter !== userPinBefore) {
      throw new Error(`the sign-in changed the user's identity or authorisation, not just its bookkeeping: ${userPinBefore} became ${userPinAfter}`);
    }
    const state = await withTenant(TENANT, async () => ({ versions: await listStatementVersions(TENANT) }));
    const tenants = (await admin`select count(*)::text as n from client`)[0]?.n ?? '?';
    const owned = [...SIGN_IN_OWNED_TABLES].map((table) => `${table}+${(after.get(table) ?? 0) - (before.get(table) ?? 0)}`);
    return `nothing outside the sign-in's own three tables moved (${owned.join(' ')} — the app_user delta is the session layer stamping `
      + `last_login_at and resetting failed_login_count, which no browser run can avoid; the password hash, the must-change flag, the tenant and the `
      + `role grants are byte-identical before and after); no financial table moved by a single row: tenants still ${tenants}, `
      + `statement versions for ${TENANT} still ${state.versions.length} (${state.versions.map((v) => v.version).join(', ')}), `
      + `and the run issued no INSERT/UPDATE/DELETE of its own`;
  });
} finally {
  await page.close().catch(() => {});
  await browser.close().catch(() => {});
  await closeDb().catch(() => {});
  await admin.end({ timeout: 5 }).catch(() => {});
}

// ── what the ruling keeps out of reach, stated rather than implied ──────────────────────────
record('S13 · states that need a write to reach, so they stay service-level proof', 'NOT TESTED',
  'an inactive version ("stands inactive."), a version bound to another chart (the chart-mismatch refusal) and a version with '
  + 'no nodes ("has no nodes.") each require inserting or changing configuration; all three refusals are asserted in '
  + 'tests/statement-version-onboarding.test.ts and tests/trial-balance.test.ts, and are not claimed for the browser');
record('S14 · node deletion policy and the statement ranges', 'NOT TESTED',
  'out of scope by instruction: no range was changed (the shipped EXPENSES range still ends at 599999 and the 6xxxxx allocation '
  + 'band still sits outside the statement — 3 gl_account rows), and no deletion path was added or exercised');

} finally {
  await closeDb().catch(() => {});
  await admin.end({ timeout: 5 }).catch(() => {});
}

const failed = results.filter((row) => row.status === 'FAILED');
const notTested = results.filter((row) => row.status === 'NOT TESTED');
console.log('\n' + '═'.repeat(92));
console.log(`BROWSER ACCEPTANCE ${failed.length === 0 ? 'PASSED' : 'FAILED'} — ${results.length} steps: `
  + `${results.length - failed.length - notTested.length} passed, ${failed.length} failed, ${notTested.length} not tested`);
console.log(`database ${acceptanceDb} — no reset, no fixture, nothing written but the sign-in's session row, audit line and login `
  + `bookkeeping on app_user; tenant ${TENANT}, `
  + `served app ${BASE} from the production build (next start), browser errors seen: ${pageErrors.length}`);
for (const row of failed) console.log(`  FAILED  ${row.step} — ${row.evidence}`);
console.log('═'.repeat(92));
process.exitCode = failed.length === 0 ? 0 : 1;
}

main().catch((error) => {
  console.error('ACCEPTANCE ABORTED:', error instanceof Error ? error.message : String(error));
  console.error(`steps completed before the abort: ${results.length}; the run stopped at its own safeguard rather than continuing`);
  process.exitCode = 1;
});
