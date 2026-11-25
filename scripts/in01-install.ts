/**
 * The India UAT installer — `--until`, `--reset-demo`, and the credentials list.
 *
 * Split from the existing `demo:provision` deliberately: the demo dataset is a Gulf biscuit
 * company provisioned automatically at deployment, while this installs one named company for a
 * tester to work through a guide, on a database someone has chosen, with a person deciding how
 * far to go. They share the phase-ledger idea, not the trigger.
 *
 * Usage:
 *
 *   npx tsx scripts/in01-install.ts --until=phase2
 *   npx tsx scripts/in01-install.ts --until=phase1
 *   npx tsx scripts/in01-install.ts --until=phase0
 *   npx tsx scripts/in01-install.ts --until=phase2 --reset-demo IN01 --confirm IN01
 *
 * `--until` defaults to `phase2`, which is the master-data state the UAT guide's Phase 0–2
 * steps end at. Phase 3 transactions are not installed here at all; a later `--with-transactions`
 * mode is the place for them.
 *
 * Exit codes: 0 when the requested phase completed; 1 when the run was refused or failed.
 */
import { basename } from 'node:path';

import { closeDb } from '../src/platform/db/client';
import { validateTarget } from '../src/platform/db/target-guard';
import { loadFixtures, resolveScenario, type FixtureSet } from '../src/platform/tenancy/in01-fixtures';
import { buildPhase0, type Phase0Result, type Phase1Result } from '../src/platform/tenancy/in01-phase0';
import { applyPasswords, buildPhase1, listIn01Accounts } from '../src/platform/tenancy/in01-phase1';
import { buildPhase2, type Phase2Result } from '../src/platform/tenancy/in01-phase2';
import {
  In01ResetError,
  claimInstallation,
  installationRecordExists,
  judgeReset,
  performReset,
} from '../src/platform/tenancy/in01-reset';
import {
  DEFAULT_CREDENTIALS_DIR,
  DEMO_CREDENTIALS_FILENAME,
  generateDemoPassword,
  writeDemoCredentials,
} from '../src/platform/tenancy/demo-credentials';
import { renderIn01CredentialReport, type In01CredentialRow } from '../src/platform/tenancy/in01-credentials';

/** Databases this installer must never write to, on top of every connection's own guard. */
const PROHIBITED_DATABASES = new Set([
  'cairn_b210',
  'cairn_hr_accept',
  'cairn_demo',
  'cairn_acceptance',
  'cairn_integration',
]);

/**
 * The month the UAT guide is written against: November 2026, period 8 of FY2026-27.
 *
 * Chosen because it is inside the April-to-March year, follows the annual stock-take season a
 * fabricator runs before Diwali, and is far enough from the year end that the close in Phase 4
 * has room. The guide's tables use these dates.
 */
const DEFAULT_ANCHOR = '2026-11-15';

export type PhaseName = 'phase0' | 'phase1' | 'phase2';
const PHASES: PhaseName[] = ['phase0', 'phase1', 'phase2'];

export interface ParsedArgs {
  until: PhaseName;
  reset: { enabled: boolean; companyCode: string | null; confirm: string | null };
  country: string;
  company: string;
  anchor: string | null;
}

export function parseArgs(argv: string[]): ParsedArgs {
  const args: ParsedArgs = {
    until: 'phase2',
    reset: { enabled: false, companyCode: null, confirm: null },
    country: 'IN',
    company: 'IN01',
    anchor: null,
  };

  for (let index = 0; index < argv.length; index++) {
    const token = argv[index]!;
    const value = (prefix: string) => token.slice(prefix.length);

    if (token.startsWith('--until=')) {
      const phase = value('--until=').toLowerCase() as PhaseName;
      if (!PHASES.includes(phase)) {
        throw new Error(`--until must be one of ${PHASES.join(', ')}; got "${phase}".`);
      }
      args.until = phase;
    } else if (token === '--until') {
      const phase = (argv[++index] ?? '').toLowerCase() as PhaseName;
      if (!PHASES.includes(phase)) {
        throw new Error(`--until must be one of ${PHASES.join(', ')}; got "${phase}".`);
      }
      args.until = phase;
    } else if (token.startsWith('--reset-demo=')) {
      args.reset = { ...args.reset, enabled: true, companyCode: value('--reset-demo=') };
    } else if (token === '--reset-demo') {
      args.reset = { ...args.reset, enabled: true, companyCode: argv[++index] ?? null };
    } else if (token.startsWith('--confirm=')) {
      args.reset = { ...args.reset, confirm: value('--confirm=') };
    } else if (token === '--confirm') {
      args.reset = { ...args.reset, confirm: argv[++index] ?? null };
    } else if (token.startsWith('--country=')) {
      args.country = value('--country=');
    } else if (token.startsWith('--company=')) {
      args.company = value('--company=');
    } else if (token.startsWith('--anchor=')) {
      args.anchor = value('--anchor=');
    } else if (token === '--with-transactions') {
      throw new Error(
        '--with-transactions is not implemented. Phases 0 to 2 are the master-data install; '
        + 'the transactional dataset is a separate piece of work (see 02-gap-list.md D4).',
      );
    } else if (token.startsWith('--')) {
      throw new Error(`Unknown option ${token}.`);
    }
  }

  return args;
}

function databaseOf(url: string): string {
  return new URL(url).pathname.replace(/^\//, '');
}

/**
 * The run.
 *
 * Structured so that the refusal checks happen before anything is written, and so a failure in
 * one phase is reported with the phase's name rather than as an anonymous error.
 */
export async function main(argv: string[]): Promise<number> {
  let args: ParsedArgs;
  try {
    args = parseArgs(argv);
  } catch (error) {
    console.error(`India installer refused: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }

  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error('India installer refused: DATABASE_URL is not set.');
    return 1;
  }
  const database = databaseOf(databaseUrl);
  if (!/^[a-z0-9_]{1,63}$/.test(database)) {
    console.error(`India installer refused: ${database} is not a valid database name.`);
    return 1;
  }
  if (PROHIBITED_DATABASES.has(database)) {
    console.error(`India installer refused: ${database} is a protected or persistent database.`);
    return 1;
  }
  await validateTarget(database, undefined, databaseUrl);

  let fixtures: FixtureSet;
  try {
    fixtures = loadFixtures({ countryCode: args.country, companyKey: args.company });
  } catch (error) {
    console.error(`India installer refused: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }

  // ── Reset, if asked for ─────────────────────────────────────────────────────
  if (args.reset.enabled) {
    return runReset(args, fixtures);
  }

  // The scenario month. It defaults to the reference month the guide is written against, so the
  // guide and a fresh install agree on the dates even when the install runs later. An operator
  // who wants the month in progress passes --anchor; the regression suite uses an anchor whose
  // postings straddle the calendar-year boundary (January to March of an April-March year).
  const anchor = args.anchor ?? DEFAULT_ANCHOR;
  const scenario = resolveScenario({ country: fixtures.country, anchorDate: anchor });

  console.log('India UAT installer');
  console.log(`  Company             ${fixtures.company.identity.legalName} (${fixtures.company.identity.clientKey})`);
  console.log(`  Country pack        ${fixtures.country.country.code} / ${fixtures.country.country.currency}`);
  console.log(`  Fiscal year         ${fixtures.country.fiscalYear.variant} (${fixtures.country.fiscalYear.name})`);
  console.log(`  Scenario            ${scenario.label} FY${scenario.fiscalYear} period ${scenario.period} (${scenario.from} → ${scenario.to})`);
  console.log(`  Database            ${database}`);
  console.log(`  Installing until    ${args.until}`);
  console.log('');

  const passwords = generatePasswords(fixtures);
  const results: { phase0?: Phase0Result; phase1?: Phase1Result; phase2?: Phase2Result } = {};

  try {
    // Claim the ledger before the first write, so an interrupted run is recognisable and a
    // reset has a record that says this data was installer-made.
    const claim = await claimInstallation({ timeline: { scenario, phases: args.until }, completed: false });
    console.log(`  installation ledger  ${claim.installationId} (${claim.created ? 'claimed' : 'adopted'})`);

    await runPhase('phase0', async () => {
      results.phase0 = await buildPhase0({ fixtures, password: founderPassword(passwords, fixtures), scenario });
    });
    if (args.until === 'phase0') {
      await claimInstallation({ timeline: { scenario, phases: args.until }, completed: true });
      return finish(args, fixtures, passwords, results);
    }

    await runPhase('phase1', async () => {
      results.phase1 = await buildPhase1({ fixtures, passwords, scenario });
      await applyPasswords({ fixtures, passwords });
    });
    if (args.until === 'phase1') {
      await claimInstallation({ timeline: { scenario, phases: args.until }, completed: true });
      return finish(args, fixtures, passwords, results);
    }

    await runPhase('phase2', async () => {
      results.phase2 = await buildPhase2({ fixtures, scenario });
    });

    await claimInstallation({ timeline: { scenario, phases: args.until }, completed: true });
    return finish(args, fixtures, passwords, results);
  } catch (error) {
    console.error(`India install failed: ${error instanceof Error ? error.message : String(error)}`);
    if (error instanceof Error && error.stack) console.error(error.stack.split('\n').slice(1, 6).join('\n'));
    return 1;
  }
}

async function runPhase(name: string, work: () => Promise<void>): Promise<void> {
  console.log(`  ${name}: running…`);
  await work();
  console.log(`  ${name}: complete.`);
}

/** A password by username, case-insensitively: the two creation paths disagree about case. */
function lookupPassword(passwords: Map<string, string>, username: string): string | undefined {
  const exact = passwords.get(username);
  if (exact) return exact;
  const lower = username.toLowerCase();
  for (const [key, value] of passwords) if (key.toLowerCase() === lower) return value;
  return undefined;
}

/** One generated password per fixture account, in the run's memory only until it is written. */
function generatePasswords(fixtures: FixtureSet): Map<string, string> {
  const passwords = new Map<string, string>();
  for (const user of fixtures.company.users) passwords.set(user.username, generateDemoPassword());
  return passwords;
}

/** The password the tenant is created with: the administrator's own. */
function founderPassword(passwords: Map<string, string>, fixtures: FixtureSet): string {
  const username = fixtures.company.founderAccounts.administrator.username;
  const password = passwords.get(username);
  if (!password) throw new Error(`No password was generated for the founding administrator ${username}.`);
  return password;
}

async function runReset(args: ParsedArgs, fixtures: FixtureSet): Promise<number> {
  const client = fixtures.company.identity.clientKey;
  const companyCode = fixtures.company.identity.companyCode;

  if (!args.reset.companyCode) {
    console.error('India installer refused: --reset-demo needs the company code it is resetting.');
    return 1;
  }

  const exists = await installationRecordExists().catch(() => false);
  const refusal = judgeReset({
    databaseUrl: process.env.DATABASE_URL ?? '',
    client,
    companyCode,
    confirmedCompanyCode: args.reset.confirm ?? '',
    flag: 'reset-demo',
    installationExists: exists,
    environment: process.env.CAIRN_ENV,
  });

  if (refusal) {
    console.error('India installer refused the reset:');
    console.error(`  ${refusal.reason}`);
    for (const line of refusal.detail) console.error(`  ${line}`);
    return 1;
  }

  // The installation record the existing provisioner writes is what says this dataset was
  // installer-made. Read here rather than trusted from a flag.
  const installationId = await currentInstallationId();
  if (!installationId) {
    console.error('India installer refused the reset: no installation record stands for this database.');
    return 1;
  }

  // Every account a tester signs in with. The two founder accounts are passed separately: the
  // installer writes as them while it runs, so their rows are expected up to the moment the
  // installation completed and refused after it.
  const founders = new Set([
    fixtures.company.founderAccounts.platformAdmin.username.toLowerCase(),
    fixtures.company.founderAccounts.administrator.username.toLowerCase(),
  ]);
  const testerAccounts = fixtures.company.users
    .map((user) => user.username.toLowerCase())
    .filter((username) => !founders.has(username));

  try {
    const result = await performReset({
      client,
      companyCode,
      installationId,
      testerAccounts,
      founderAccounts: [...founders],
    });
    console.log(`Reset ${result.client}: the tenant and its master data were removed.`);
    console.log('Run the installer without --reset-demo to build a fresh dataset.');
    return 0;
  } catch (error) {
    if (error instanceof In01ResetError) {
      console.error('India installer refused the reset:');
      console.error(`  ${error.message}`);
      console.error(`  ${error.remedy}`);
      return 1;
    }
    throw error;
  }
}

async function currentInstallationId(): Promise<string | null> {
  const { db } = await import('../src/platform/db/client');
  const { sql } = await import('drizzle-orm');
  const rows = (await db().execute(sql`
    select installation_id as "id" from demo_installation order by started_at desc limit 1
  `)) as unknown as Array<{ id: string }>;
  return rows[0]?.id ?? null;
}

/**
 * Write the credential file and print the account list.
 *
 * The list is the deliverable the brief asks for: username, password, role, linked employee and
 * department, test-only, and written to one file at mode 0600. The same rows feed the in-app
 * view (`/platform/users/test-credentials`), which is disabled outside development.
 */
async function finish(
  args: ParsedArgs,
  fixtures: FixtureSet,
  passwords: Map<string, string>,
  results: { phase0?: Phase0Result; phase1?: Phase1Result; phase2?: Phase2Result },
): Promise<number> {
  const accounts = await listIn01Accounts(fixtures);

  // Both founder accounts are created by `createTenant` in one transaction, with ONE password:
  // the administrator's. So the platform administrator's line shows that password, not a blank.
  const founderPasswordUsername = fixtures.company.founderAccounts.administrator.username;
  const rows: In01CredentialRow[] = accounts.map((account) => ({
    username: account.username,
    // Every account has a password: the platform administrator is created by `createTenant`
    // with the tenant administrator's own generated password, not with a separate one.
    password: lookupPassword(passwords, account.username)
      ?? lookupPassword(passwords, founderPasswordUsername)
      ?? '(not issued in this run)',
    role: account.role,
    employee: account.fullName,
    personnelNumber: account.personnelNumber,
    department: account.department,
  }));

  const directory = process.env.CAIRN_DEMO_CREDENTIALS_DIR?.trim() || DEFAULT_CREDENTIALS_DIR;
  const report = renderIn01CredentialReport({
    company: fixtures.company.identity.legalName,
    clientKey: fixtures.company.identity.clientKey,
    companyCode: fixtures.company.identity.companyCode,
    loginUrl: process.env.CAIRN_DEMO_LOGIN_URL?.trim() || 'http://localhost:3000',
    accounts: rows,
    filePath: `${directory}/${DEMO_CREDENTIALS_FILENAME}`,
    generatedAt: new Date().toISOString(),
    until: args.until,
  });
  writeDemoCredentials(report, { directory });

  console.log('');
  console.log('Accounts (test-only passwords; also written to the credential file):');
  console.log('');
  const widths = {
    username: Math.max(...rows.map((row) => row.username.length), 8),
    password: Math.max(...rows.map((row) => row.password.length), 8),
    role: Math.max(...rows.map((row) => row.role.length), 4),
    department: Math.max(...rows.map((row) => row.department.length), 10),
  };
  console.log(
    `  ${'USERNAME'.padEnd(widths.username)}  ${'PASSWORD'.padEnd(widths.password)}  `
    + `${'ROLE'.padEnd(widths.role)}  ${'DEPARTMENT'.padEnd(widths.department)}  EMPLOYEE`,
  );
  for (const row of rows) {
    console.log(
      `  ${row.username.padEnd(widths.username)}  ${row.password.padEnd(widths.password)}  `
      + `${row.role.padEnd(widths.role)}  ${row.department.padEnd(widths.department)}  ${row.employee} (${row.personnelNumber ?? '-'})`,
    );
  }
  console.log('');
  console.log(`  Credential file     ${directory}/${DEMO_CREDENTIALS_FILENAME}`);
  console.log('  These passwords are TEST-ONLY. The in-app view is disabled outside development.');
  console.log('');
  console.log(`India install complete (${args.until}).`);
  if (results.phase0) {
    console.log(`  Phase 0             chart additions ${results.phase0.chartAdditions}, tax codes ${results.phase0.taxCodes}, `
      + `cost centres ${results.phase0.costCentres}, work centres ${results.phase0.workCentres}, holiday days ${results.phase0.holidayDays}`);
  }
  if (results.phase1) {
    console.log(`  Phase 1             ${results.phase1.employees} employees, ${results.phase1.positions} positions, `
      + `${results.phase1.users} users, ${results.phase1.quotas} leave quotas`);
  }
  if (results.phase2) {
    console.log(`  Phase 2             ${results.phase2.materials} materials, ${results.phase2.boms} BOMs, `
      + `${results.phase2.routings} routings, ${results.phase2.vendors} vendors, ${results.phase2.customers} customers`);
  }
  return 0;
}

if (basename(process.argv[1] ?? '') === 'in01-install.ts') {
  main(process.argv.slice(2))
    .then((code) => { process.exitCode = code; })
    .catch(async (error: unknown) => {
      console.error(`India install failed: ${error instanceof Error ? error.message : String(error)}`);
      process.exitCode = 1;
    })
    .finally(async () => { await closeDb(); });
}
