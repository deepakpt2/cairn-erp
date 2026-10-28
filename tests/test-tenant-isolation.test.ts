import { readFileSync } from 'node:fs';
import { strict as assert } from 'node:assert';
import { afterAll, describe, expect, it } from 'vitest';

import { sql } from 'drizzle-orm';

import { withTenant } from '@/platform/db/client';
import { TARGETS } from '../scripts/browser-smoke/targets';
import { ACCEPTANCE_DATABASE_GUARDS } from '../scripts/browser-smoke/database-guards';
import { createTenant, destroyTenant, testClientId } from './helpers';

/**
 * The isolation the suite runs on, pinned.
 *
 * A whole-suite run used to fail files that had nothing wrong with them: `tests/helpers.ts` keyed a fixture
 * tenant by `hash(seed) % 1000`, two files could land on the same key, and the first one's cleanup deleted the
 * tenant out from under the other — which surfaces as `destroyTenant: tenant T474 was not deleted` at the file
 * level and, inside the file, as a fixture that vanished mid-test (`Company code 1000 is not configured`,
 * `Supplier V-IR does not exist`, foreign-key violations against the tenant table). The same file list passed
 * when run in a smaller group, which is how it was mistaken for a shared-database problem rather than a
 * shared-key one.
 */
describe('test-suite isolation', () => {
  it('never places a fixture tenant on a key the browser cohort reserves', async () => {
    const reserved = new Set<string>(TARGETS.map((target) => target.client));
    // The hash itself does reach reserved keys — 54 of the suite's 288 seeds did before this change — so the
    // claim step has to look, and the search below is what proves there is something to look for.
    let seed = '';
    for (let i = 0; i < 200_000 && seed === ''; i++) {
      const candidate = `isolation-reserve-${i}`;
      if (reserved.has(testClientId(candidate))) seed = candidate;
    }
    assert.ok(seed, 'no seed hashed into the reserved range; the loop above needs widening');
    expect(reserved.has(testClientId(seed))).toBe(true);

    const tenant = await createTenant(seed);
    try {
      expect(reserved.has(tenant.client)).toBe(false);
      expect(tenant.client).not.toBe(testClientId(seed));
    } finally {
      await destroyTenant(tenant.client);
    }
  });

  it('claims a key of its own when two seeds hash to the same tenant', async () => {
    // A pair that hashes to one key is found rather than assumed, so the case cannot rot into a no-op: 56 keys
    // were shared by two or more test files before the claim step existed.
    const seedA = 'isolation-probe-a';
    let seedB = '';
    for (let i = 0; i < 5_000_000 && seedB === ''; i++) {
      const candidate = `isolation-probe-b-${i}`;
      if (testClientId(candidate) === testClientId(seedA)) seedB = candidate;
    }
    assert.ok(seedB, 'no colliding seed was found; the hash space needs checking');
    expect(testClientId(seedA)).toBe(testClientId(seedB));
    const a = await createTenant(seedA);
    const b = await createTenant(seedB);
    try {
      assert.notEqual(b.client, a.client, 'the second tenant must not share the first one\'s key');
      // One read per tenant, because that is the point of the tenant scope: a session pointed at one fixture
      // cannot see the other's row. An earlier draft asked for both in one query and got one row back.
      const nameOf = (client: string) => withTenant(client, (tx) => tx.execute(sql`
        select name from client where client = ${client}
      `)) as unknown as Promise<Array<{ name: string }>>;
      const [nameA, nameB] = await Promise.all([nameOf(a.client), nameOf(b.client)]);
      assert.equal(nameA[0]!.name, `Test tenant ${a.client} (isolation-probe-a)`);
      assert.equal(nameB[0]!.name, `Test tenant ${b.client} (${seedB})`);
    } finally {
      await destroyTenant(a.client);
      await destroyTenant(b.client);
    }
  });

  it('keeps a fixture name inside the pattern the purge step matches', () => {
    const setup = readFileSync('tests/global-setup.ts', 'utf8');
    assert.match(setup, /name like 'Test tenant T%'/, 'the purge pattern must stay what createTenant writes');
  });

  it('refuses a whole-suite run on a database the browser cohort guards', () => {
    const setup = readFileSync('tests/global-setup.ts', 'utf8');
    assert.match(setup, /ACCEPTANCE_DATABASE_GUARDS/, 'the refusal must read the cohort\'s own registry');
    assert.match(setup, /CAIRN_ALLOW_GUARDED_TEST_DATABASE/, 'and the deliberate escape must be named');
    const guarded = new Set(
      Object.values(ACCEPTANCE_DATABASE_GUARDS)
        .map((guard) => guard?.database)
        .filter((name): name is string => typeof name === 'string'),
    );
    assert.ok(guarded.size > 0, 'the registry must name the guarded databases');
  });

  it('provisions a scratch database only where it says it may', () => {
    const script = readFileSync('scripts/test-db.ts', 'utf8');
    assert.match(script, /guarded\.has\(database\)/, 'the provisioning step must refuse a guarded database');
    assert.match(script, /CAIRN_ENV/, 'and only run in development');
    assert.match(script, /--yes/, 'and require a second word before dropping a schema');
  });
});
