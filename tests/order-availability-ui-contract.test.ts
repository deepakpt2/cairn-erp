import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { t } from '../src/platform/i18n';

/**
 * CO09 slice 1's screen contract.
 *
 * The figures are proved in `order-availability.test.ts`. What this file holds the
 * screen to is what a *screen* is allowed to claim about them: every state the check
 * can return has a state of its own; the committed column says it is not stored; the
 * only action is the read itself; and no label promises an availability the slice
 * cannot give. The copy is checked against the catalogue at runtime, so a key that is
 * only present in the screen and not in the locale layer fails here.
 */
describe('order-availability screen contract (CO09 slice 1)', () => {
  const page = readFileSync('src/app/production/order-availability/page.tsx', 'utf8');
  const shell = readFileSync('src/app/production/order-availability/OrderAvailabilityWorkbench.tsx', 'utf8');

  it('runs the read-only service and refuses before it', () => {
    expect(page).toContain('requireSession(ORDER_AVAILABILITY_ROUTE)');
    expect(page).toContain('holdsOrderAvailabilityAuthority(session.user.capabilities)');
    expect(page).toContain('orderAvailabilityRefusal(');
    expect(page).toContain('checkOrderAvailability(');
    expect(page).toContain('OrderAvailabilityError');
    // A check has no action module: nothing to commit, nothing to replay.
    expect(page).not.toMatch(/from '\.\/actions'|createServerAction|useActionState/);
    expect(page).not.toMatch(/recordChange|saveCheckingControl|saveScopeOfCheck|postGoods|releaseProductionOrder/);
    expect(shell).not.toMatch(/<form[^>]*method=["']post/);
  });

  it('shows every state the service can return, by name', () => {
    for (const state of ['authz-failure', 'initial', 'loading', 'no-elements']) {
      expect(shell, state).toContain(`data-co09-state="${state}"`);
    }
    // The four states a result chooses between are chosen in the markup, not guessed.
    for (const state of ['unsupported', 'service-error', 'not-checked', 'incomplete-config']) {
      expect(shell, state).toContain(`'${state}'`);
    }
    expect(shell.match(/data-co09-state=/g)?.length).toBeGreaterThanOrEqual(6);
    // The result is never a single verdict word that could be read as a promise.
    expect(shell).toContain('data-co09-outcome={row.outcome}');
    expect(shell).toContain('data-co09-component={row.itemNumber}');
    expect(shell).toContain('disabled={pending}');
    expect(shell).toContain('aria-busy={pending || undefined}');
    expect(shell).not.toMatch(/role="status"[^>]*>All components are available/);
  });

  it('keeps a committed quantity visibly separate from the cumulation', () => {
    expect(shell).toContain('data-co09-committed="not-stored"');
    expect(shell).toContain("t('co09.committed')");
    expect(shell).toContain("t('co09.cumulatedAtp')");
    expect(shell).toContain("t('co09.notStored')");
    expect(shell).not.toMatch(/data-co09-committed="\d/);
    expect(shell).not.toMatch(/committedQuantity\s*\?\??\s*0/);
  });

  it('offers no control that could be read as taking a quantity', () => {
    const buttons = shell.match(/<button[\s\S]*?<\/button>/g) ?? [];
    expect(buttons).toHaveLength(1);
    expect(buttons[0]).toContain('type="submit"');
    expect(buttons[0]).toContain('data-co09-check');
    expect(shell).not.toMatch(/name=["'](commit|reserve|post|release|reset-availability|missingParts)["']/);
    expect(shell).not.toMatch(/Save|Reserve|Post goods|Release order|Commit quantity/);
    // The two ways out of the screen are links to the screens that own the data.
    expect(shell).toContain('/production/stock-requirements?material=');
    expect(shell).toContain('/production/production-order-display');
  });

  it('renders the refusal list from the module, not from a paraphrase', () => {
    expect(page).toContain('ORDER_AVAILABILITY_GAPS.map(');
    expect(page).toContain('data-co09-refusals');
    expect(page).toContain('data-co09-gaps');
    // No screen may promise the reference product's parity; the module says what it is.
    for (const source of [shell, page]) {
      expect(source).not.toMatch(/parity with (the )?(reference|vendor|original) (product|system)/i);
      expect(source).not.toMatch(/full CO09 parity|equivalent to (the )?(reference|vendor)/i);
    }
    const module = readFileSync('src/modules/production/order-availability.ts', 'utf8');
    expect(module).toContain('no claim of parity is');
    expect(module).not.toMatch(/This is full CO09 parity|equivalent to the reference product CO09/);
  });

  it('resolves its copy through the locale catalogue', () => {
    const keys = new Set<string>();
    for (const source of [page, shell]) {
      for (const match of source.matchAll(/t\('(co09\.[A-Za-z0-9.]+)'/g)) keys.add(match[1]!);
    }
    // The two families of keys are named from the data the service returns.
    for (const status of ['CREATED', 'RELEASED', 'TECHNICALLY_COMPLETED']) keys.add(`co09.status.${status}`);
    for (const outcome of ['AVAILABLE', 'SHORT', 'NO_ELEMENTS', 'UNDATED', 'EXCLUDED', 'NOT_CHECKED', 'NO_GROUP', 'NO_SCOPE', 'UNSUPPORTED']) {
      keys.add(`co09.outcome.${outcome}`);
    }
    expect(keys.size).toBeGreaterThan(60);
    for (const key of [...keys].sort()) {
      const text = t(key);
      expect(text, `${key} is missing from the catalogue`).not.toBe(key);
      expect(text.length, key).toBeGreaterThan(0);
    }
    // The header of the screen names the check, the alias, and both authorities.
    expect(page).toContain('ORDER_AVAILABILITY_ALIAS');
    expect(page).toContain('ORDER_AVAILABILITY_ORDER_CAPABILITY} + {');
  });

  it('is registered as a built screen that only reads', () => {
    const catalog = readFileSync('src/ui/shell/screen-catalog.ts', 'utf8');
    const entry = catalog.slice(catalog.indexOf('"/production/order-availability"'));
    expect(entry).toContain('code: "PROD.ORDER.DISPLAY"');
    expect(entry).toContain('family: "planning"');
    expect(entry).toContain('accepts: ["order"]');
    const links = readFileSync('src/ui/shell/screen-links.ts', 'utf8');
    expect(links.match(/'\/production\/order-availability',/g)?.length).toBeGreaterThanOrEqual(2);
  });
});
