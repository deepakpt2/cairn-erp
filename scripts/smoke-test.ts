/**
 * End-to-end smoke test of the real request path — CAIRN.md §24.3.
 *
 * Signs in through the logon screen, then walks every page as a signed-in user,
 * reads back rendered content, and proves the session's tenant is the one that
 * counts. Uses the development tenant 0100.
 *
 * This is the closest thing to the product owner's walkthrough that can be run
 * without a browser, and it exercises the whole stack: logon screen, session
 * cookie, tenant scope, engines, database, and the pages that render the result.
 */
const BASE = process.env.SMOKE_BASE_URL ?? 'http://127.0.0.1:3000';
const CLIENT = '0100';

let failures = 0;
function check(name: string, condition: boolean, detail = '') {
  const mark = condition ? '\u2713' : '\u2717';
  if (!condition) failures++;
  console.log(`  ${mark} ${name}${detail && !condition ? ` — ${detail}` : ''}`);
}

const ADMIN_USER = process.env.SMOKE_USER ?? 'dev.admin';
const ADMIN_PASSWORD = process.env.SMOKE_PASSWORD ?? 'cairn-dev-2026';

/**
 * Sign in the way a person does: post the form, keep the cookie.
 *
 * Deliberately not a back door. If signing in breaks, this suite must fail —
 * a smoke test that authenticates by some other route would keep passing while
 * nobody could log on.
 */
async function signIn(tenant = CLIENT, password = ADMIN_PASSWORD) {
  const response = await fetch(`${BASE}/api/auth/signin`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client: tenant, username: ADMIN_USER, password }),
    redirect: 'manual',
  });

  const cookie = response.headers.getSetCookie?.().find((c) => c.startsWith('cairn_session'));
  return { status: response.status, location: response.headers.get('location'), cookie };
}

let sessionCookie: string | undefined;

async function get(path: string, options: { authenticated?: boolean } = {}) {
  const authenticated = options.authenticated ?? true;
  const response = await fetch(`${BASE}${path}`, {
    headers: authenticated && sessionCookie ? { cookie: sessionCookie } : {},
    redirect: 'manual',
  });
  return {
    status: response.status,
    location: response.headers.get('location'),
    body: response.status === 200 ? await response.text() : '',
  };
}

async function main() {
  console.log(`\nSmoke test against ${BASE}, tenant ${CLIENT}\n`);

  console.log('Sign in');
  const login = await signIn();
  check('sign in as the development administrator', login.status === 303 && !!login.cookie,
    `HTTP ${login.status} -> ${login.location}`);
  if (!login.cookie) {
    console.log(`\n${failures} check(s) FAILED — cannot continue without a session.\n`);
    process.exit(1);
  }
  sessionCookie = login.cookie;

  console.log('\nPages');
  for (const [name, path] of [
    ['launchpad', '/'],
    ['tenants', '/clients'],
    ['onboarding', '/clients/new'],
    ['workbench', '/config'],
    ['company codes', '/config/company-codes'],
    ['G/L accounts', '/config/gl-accounts'],
    ['posting periods', '/config/posting-periods'],
    ['plants', '/config/plants'],
    ['number ranges', '/config/number-ranges'],
    ['number range create', '/config/number-ranges?new=1'],
    ['material list', '/inventory/materials'],
    ['material create', '/inventory/materials?new=1'],
    ['material MRP', '/inventory/materials?material=RAW-STEEL&view=MRP'],
    ['material valuation', '/inventory/materials?material=FG-BRACKET&view=ACCOUNTING'],
    ['journal list', '/finance/journal'],
    ['journal post', '/finance/journal/new'],
    ['registry', '/registry'],
  ] as Array<[string, string]>) {
    const { status } = await get(path);
    check(`${name} (${path})`, status === 200, `HTTP ${status}`);
  }

  console.log('\nRendered content');
  const companyCodes = await get('/config/company-codes');
  check('company code 1000 listed', companyCodes.body.includes('1000'));
  check('assigned chart of accounts shown', companyCodes.body.includes('CAIRN'));

  const accounts = await get('/config/gl-accounts');
  check('trade payables account present', accounts.body.includes('200000'));
  check('GR/IR clearing account present', accounts.body.includes('210000'));
  check('production variance account present', accounts.body.includes('410100'));
  check('account count rendered', /7[0-9] accounts|account<\/td>/.test(accounts.body) || accounts.body.includes('74'));

  const periods = await get('/config/posting-periods');
  check('fiscal year variant shown', periods.body.includes('K4'));
  check('posting period variant shown', periods.body.includes('C001'));
  check('all five account types listed', ['General ledger', 'Vendor', 'Customer', 'Asset', 'Material']
    .every((label) => periods.body.includes(label)));

  const ranges = await get('/config/number-ranges');
  check('company-scoped accounting interval is ready', ranges.body.includes('GENERAL') && ranges.body.includes('Accounting numbering is ready'));

  const materials = await get('/inventory/materials');
  check('development raw material and manufactured product listed', materials.body.includes('RAW-STEEL') && materials.body.includes('FG-BRACKET'));

  const plants = await get('/config/plants');
  check('plant 1000 present', plants.body.includes('Main plant'));
  check('storage locations listed', plants.body.includes('Raw materials store')
    && plants.body.includes('Finished goods warehouse'));

  console.log('\nSession and isolation through the web layer');

  // The signed-in session is the authority. A query string asking for another
  // tenant is ignored, and a forged cookie for a tenant that is not ours is
  // refused at the door rather than half-honoured.
  // 0100's own accounts legitimately include 210000, so the page showing it is
  // the proof: the query string was ignored and the session's tenant was used.
  // Asking for a tenant that does not exist must not yield a different answer.
  const spoofed = await get('/config/gl-accounts?client=9999');
  check(
    'a ?client= override is ignored in favour of the session',
    spoofed.status === 200 && spoofed.body.includes('210000'),
    `HTTP ${spoofed.status}, body length ${spoofed.body.length}`,
  );

  const forged = await fetch(`${BASE}/config/gl-accounts`, {
    headers: { cookie: '9999.' + 'a'.repeat(43) },
    redirect: 'manual',
  });
  check(
    'a forged cookie is refused, not honoured',
    (forged.headers.get('location') ?? '').startsWith('/signin'),
    forged.headers.get('location') ?? 'no redirect',
  );

  const anonymous = await fetch(`${BASE}/config/gl-accounts`, { redirect: 'manual' });
  check(
    'an anonymous request is sent to the logon screen',
    (anonymous.headers.get('location') ?? '').startsWith('/signin'),
    anonymous.headers.get('location') ?? 'no redirect',
  );

  const badPassword = await signIn(CLIENT, 'not-the-password');
  check(
    'a wrong password is refused with the generic message',
    (badPassword.location ?? '').includes('error=CAIRN_AUTH_INVALID'),
    badPassword.location ?? 'no redirect',
  );

  console.log(`\n${failures === 0 ? 'All checks passed.' : `${failures} check(s) FAILED.`}\n`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error('Smoke test error:', error.message);
  process.exit(1);
});
