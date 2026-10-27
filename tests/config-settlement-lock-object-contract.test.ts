/**
 * The name a settlement master is locked under, checked against the platform's own rule.
 *
 * `objectOf` in `src/platform/lock/enqueue.ts` decides whether a lock object is a named object.
 * Failing it is not cosmetic: `openChangeLockAction` answers the failure with display-only mode, so
 * every edit form on the screen is disabled, and the heartbeat action — which does not catch — answers
 * 500. A screen like that still loads, still renders, still refuses the unauthorised, and still stores
 * a create, because a create has no row to hold yet. Every module test passes. That is why this
 * contract is pinned in source rather than left to a click-through.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ENQUEUE = 'src/platform/lock/enqueue.ts';
const KEYS = 'src/modules/foundation/settlement-configuration-keys.ts';

/** The rule, read out of the enforcement point so this test cannot drift away from it. */
function platformRule(): RegExp {
  const source = readFileSync(ENQUEUE, 'utf8');
  const start = source.indexOf('function objectOf');
  if (start < 0) throw new Error(`${ENQUEUE} no longer holds objectOf; this test has to follow the platform.`);
  const block = source.slice(start, source.indexOf('\n}', start));
  const pattern = block.match(/\/(\^[^\n/]+)\/\.test\(object\)/);
  if (!pattern) throw new Error(`${ENQUEUE}: objectOf no longer tests its value against a literal pattern.`);
  return new RegExp(pattern[1]);
}

function sourcesUnder(dir: string, found: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) {
      sourcesUnder(path, found);
      continue;
    }
    if (path.endsWith('.ts') || path.endsWith('.tsx')) found.push(path);
  }
  return found;
}

/**
 * The three names the settlement masters are held under, as the screen and the server action
 * receive them from one place.
 */
function settlementConfigLockNames(): Array<{ field: string; value: string }> {
  const source = readFileSync(KEYS, 'utf8');
  const start = source.indexOf('SETTLEMENT_CONFIG_LOCKS = {');
  if (start < 0) throw new Error(`${KEYS} no longer declares SETTLEMENT_CONFIG_LOCKS.`);
  const block = source.slice(start, source.indexOf('}', start));
  return [...block.matchAll(/(\w+):\s*'([^']+)'/g)].map(([, field, value]) => ({ field, value }));
}

/**
 * Every lock object named directly at a call site anywhere in the application.
 *
 * Extraction is deliberately conservative: only a quoted literal handed straight to `lockObject:` or
 * to `useChangeLock` counts. A screen that picks the object in a ternary is not read here, so a
 * refusal to widen this scan is the price of keeping it a floor rather than a guess.
 */
function directlyNamedLockObjects(): string[] {
  const values = new Set<string>();
  for (const path of sourcesUnder('src')) {
    const source = readFileSync(path, 'utf8');
    for (const match of source.matchAll(/lockObject:\s*'([A-Za-z0-9_ -]{2,60})'/g)) values.add(match[1]);
    for (const match of source.matchAll(/useChangeLock\(\s*'([A-Za-z0-9_ -]{2,60})'\s*,/g)) values.add(match[1]);
  }
  return [...values];
}

describe('settlement configuration change-lock names', () => {
  it('names each settlement master the way the platform requires', () => {
    const rule = platformRule();
    const locks = settlementConfigLockNames();
    expect(locks.map((entry) => entry.field).sort()).toEqual(['orderType', 'profile', 'structure']);
    for (const { field, value } of locks) {
      expect(rule.test(value.toUpperCase()), `${field} = '${value}' is not a named object`).toBe(true);
    }
  });

  it('keeps every directly named lock object in the application legal', () => {
    const rule = platformRule();
    const values = directlyNamedLockObjects();
    expect(values.length).toBeGreaterThanOrEqual(100);
    const offenders = values.filter((value) => !rule.test(value.toUpperCase()));
    expect(offenders).toEqual([]);
  });
});
