/**
 * Posting flow verification against the live application.
 *
 * Posts through the same service the server action calls, then reads the result
 * back through the HTTP layer. Two things are being proved:
 *
 *   1. A balanced document posts, receives a number, and renders in the list.
 *   2. A posting to a closed period is refused, with a message that names the
 *      period and tells the user how to reopen it.
 *
 * The HTTP action wrapper itself is thin — it parses the form and calls the
 * service below — so this covers the substance.
 */
import { withTenant, closeDb } from '../src/platform/db/client';
import { postJournalEntry, PostingError } from '../src/platform/posting';
import { updatePeriodRule } from '../src/modules/foundation/services';

const BASE = process.env.SMOKE_BASE_URL ?? 'http://127.0.0.1:3000';
const CLIENT = '0100';
const ADMIN_USER = process.env.SMOKE_USER ?? 'dev.admin';
const ADMIN_PASSWORD = process.env.SMOKE_PASSWORD ?? 'cairn-dev-2026';

/**
 * Sign in and keep the cookie, exactly as the main smoke test does.
 *
 * The pages under test now require a session, so this suite signs in before it
 * reads anything back. Signing in through the real logon endpoint is the point:
 * if the session layer breaks, both suites must say so.
 */
async function signIn() {
  const response = await fetch(`${BASE}/api/auth/signin`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client: CLIENT, username: ADMIN_USER, password: ADMIN_PASSWORD }),
    redirect: 'manual',
  });
  return response.headers.getSetCookie?.().find((c) => c.startsWith('cairn_session'));
}
const fiscalYear = new Date().getUTCFullYear();

let failures = 0;
function check(name: string, condition: boolean, detail = '') {
  console.log(`  ${condition ? '\u2713' : '\u2717'} ${name}${!condition && detail ? ` — ${detail}` : ''}`);
  if (!condition) failures++;
}

async function main() {
  console.log(`\nPosting flow, tenant ${CLIENT}, fiscal year ${fiscalYear}\n`);

  const cookie = await signIn();
  check('signed in through the logon screen', !!cookie, 'no session cookie issued');
  const auth = cookie ? { headers: { cookie } } : {};

  // ── 1 · Post a balanced document ──────────────────────────────────────────
  console.log('Post a balanced entry');
  const posted = await withTenant(CLIENT, (tx) =>
    postJournalEntry(tx, {
      client: CLIENT,
      companyCode: '1000',
      documentType: 'SA',
      documentDate: `${fiscalYear}-04-12`,
      postingDate: `${fiscalYear}-04-12`,
      fiscalYear,
      postingPeriod: 4,
      currency: 'USD',
      localCurrency: 'USD',
      headerText: 'Smoke test — office supplies',
      reference: 'SMOKE-001',
      postedBy: 'SMOKE',
      transactionCode: 'FIN.JOURNAL.POST',
      lines: [
        { glAccount: '530000', debitCredit: 'S', amount: '1250.0000', costCenter: 'CC-1000', lineText: 'Office supplies' },
        { glAccount: '200000', debitCredit: 'H', amount: '1250.0000', lineText: 'Payable' },
      ],
    }),
  );
  check('document posted', posted.displayNumber.length > 0);
  check('readable number format', /^JE-\d{4}-\d{6}$/.test(posted.displayNumber), posted.displayNumber);
  check('debits equal credits', posted.debitTotal === posted.creditTotal);

  // ── 2 · It renders in the list ────────────────────────────────────────────
  console.log('\nRead it back through the application');
  const list = await fetch(`${BASE}/finance/journal`, auth).then((r) => r.text());
  check('document appears in the journal list', list.includes(posted.displayNumber));
  check('header text rendered', list.includes('Smoke test'));

  const detail = await fetch(
    `${BASE}/finance/journal?document=${encodeURIComponent(posted.documentNumber)}`,
    auth,
  ).then((r) => r.text());
  check('document detail opens', detail.includes(posted.displayNumber));
  check('both lines rendered', detail.includes('530000') && detail.includes('200000'));
  check('cost centre rendered', detail.includes('CC-1000'));
  check('debit/credit labels rendered', detail.includes('Debit') && detail.includes('Credit'));

  // ── 3 · An unbalanced document is refused ─────────────────────────────────
  console.log('\nRefuse an unbalanced entry');
  const unbalanced = (await withTenant(CLIENT, (tx) =>
    postJournalEntry(tx, {
      client: CLIENT,
      companyCode: '1000',
      documentType: 'SA',
      documentDate: `${fiscalYear}-04-12`,
      postingDate: `${fiscalYear}-04-12`,
      fiscalYear,
      postingPeriod: 4,
      currency: 'USD',
      localCurrency: 'USD',
      postedBy: 'SMOKE',
      lines: [
        { glAccount: '530000', debitCredit: 'S', amount: '100.0000' },
        { glAccount: '200000', debitCredit: 'H', amount: '90.0000' },
      ],
    }),
  ).catch((e) => e)) as PostingError;

  check('refused', unbalanced instanceof PostingError);
  check('difference stated', unbalanced.message?.includes('10.0000') ?? false, unbalanced.message);
  check('remedy given', (unbalanced.remedy?.length ?? 0) > 0);

  // ── 4 · Close a period, then try to post into it ──────────────────────────
  console.log('\nClose a period and attempt to post into it');
  await updatePeriodRule({
    client: CLIENT,
    variant: 'C001',
    accountType: 'S',
    periodFrom: 5,
    periodTo: 12,
    allowSpecialPeriods: true,
    changedBy: 'SMOKE',
  });

  const closed = (await withTenant(CLIENT, (tx) =>
    postJournalEntry(tx, {
      client: CLIENT,
      companyCode: '1000',
      documentType: 'SA',
      documentDate: `${fiscalYear}-02-10`,
      postingDate: `${fiscalYear}-02-10`,
      fiscalYear,
      postingPeriod: 2,
      currency: 'USD',
      localCurrency: 'USD',
      postedBy: 'SMOKE',
      lines: [
        { glAccount: '530000', debitCredit: 'S', amount: '50.0000' },
        { glAccount: '200000', debitCredit: 'H', amount: '50.0000' },
      ],
    }),
  ).catch((e) => e)) as PostingError;

  check('posting to a closed period is refused', closed instanceof PostingError);
  check('the period is named', closed.message?.includes('Period 2') ?? false, closed.message);
  check('the open range is stated', closed.message?.includes('5 to 12') ?? false, closed.message);
  check('remedy names the screen', closed.remedy?.includes('FIN.CLOSE.PERIOD') ?? false);

  // Reopen, because leaving the shared development tenant half-closed would be rude.
  await updatePeriodRule({
    client: CLIENT,
    variant: 'C001',
    accountType: 'S',
    periodFrom: 1,
    periodTo: 12,
    allowSpecialPeriods: true,
    changedBy: 'SMOKE',
  });
  console.log('  (period range restored)');

  // ── 5 · The change was recorded ───────────────────────────────────────────
  console.log('\nConfiguration change is auditable');
  const { changeHistory } = await import('../src/platform/change');
  const history = await withTenant(CLIENT, (tx) =>
    changeHistory(tx, CLIENT, 'posting_period_rule', 'C001/S'),
  );
  check('period rule changes recorded', history.length >= 2);
  const withFields = history.find((h) => h.items.length > 0);
  check('field-level detail captured', (withFields?.items.length ?? 0) > 0);
  check(
    'flagged security relevant for the auditor',
    withFields?.items.some((i) => i.isSecurityRelevant === 'true') ?? false,
  );

  console.log(`\n${failures === 0 ? 'All checks passed.' : `${failures} check(s) FAILED.`}\n`);
  await closeDb();
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(async (error) => {
  console.error('Flow error:', error);
  await closeDb();
  process.exit(1);
});
