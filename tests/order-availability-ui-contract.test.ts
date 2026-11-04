import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { t } from '../src/platform/i18n';

/** CO09 Slice 2 screen contract: read is separate from exact-grant commit/reset actions. */
describe('order-availability screen contract (CO09 Slice 2)', () => {
  const page = readFileSync('src/app/production/order-availability/page.tsx', 'utf8');
  const shell = readFileSync('src/app/production/order-availability/OrderAvailabilityWorkbench.tsx', 'utf8');

  it('keeps the check separate from exact-grant commit and reset actions', () => {
    expect(page).toContain('requireSession(ORDER_AVAILABILITY_ROUTE)');
    expect(page).toContain('holdsOrderAvailabilityAuthority(session.user.capabilities)');
    expect(page).toContain('orderAvailabilityRefusal(');
    expect(page).toContain('checkOrderAvailability(');
    expect(page).toContain('OrderAvailabilityError');
    expect(shell).toContain("from './actions'");
    const actions = readFileSync('src/app/production/order-availability/actions.ts', 'utf8');
    expect(actions).toContain('requireCapability(PRODUCTION_ORDER_AVAILABILITY_COMMIT_CAPABILITY)');
    expect(actions).toContain('requireCapability(PRODUCTION_ORDER_AVAILABILITY_RESET_CAPABILITY)');
    expect(actions).toContain('commitOrderComponentAvailability(');
    expect(actions).toContain('resetOrderComponentAvailability(');
    expect(shell).not.toMatch(/<form[^>]*method=["']post/);
    expect(page).not.toMatch(/recordChange|saveCheckingControl|saveScopeOfCheck|postGoods|releaseProductionOrder/);
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

  it('keeps stored commitment separate from cumulated ATP and exposes component actions', () => {
    expect(shell).toContain('data-co09-committed={row.committedQuantity === null ?');
    expect(shell).toContain("t('co09.committed')");
    expect(shell).toContain("t('co09.cumulatedAtp')");
    expect(shell).toContain('data-co09-commit-form={row.itemNumber}');
    expect(shell).toContain('data-co09-reset-form={row.itemNumber}');
    expect(shell).toContain('data-co09-committed-cell');
    expect(shell).not.toMatch(/committedQuantity\s*\?\??\s*0/);
  });

  it('offers explicit per-component commit and reset actions, without posting or reserving', () => {
    const buttons = shell.match(/<button[\s\S]*?<\/button>/g) ?? [];
    expect(buttons).toHaveLength(2);
    expect(buttons[0]).toContain('data-co09-check');
    expect(shell).toContain('commitAvailabilityAction');
    expect(shell).toContain('resetAvailabilityAction');
    expect(shell).toContain('name="reason"');
    expect(shell).not.toMatch(/Reserve physical|Post goods|Release order|Commit quantity/);
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
    expect(module).toContain('no claim of exact parity is');
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
