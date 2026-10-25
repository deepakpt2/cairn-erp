import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('availability-check screen contract', () => {
  const page = readFileSync('src/app/config/availability-check/page.tsx', 'utf8');
  const form = readFileSync('src/app/config/availability-check/AvailabilityCheckForm.tsx', 'utf8');
  const actions = readFileSync('src/app/config/availability-check/actions.ts', 'utf8');

  it('gates maintenance and does not present an ATP balance', () => {
    expect(page).toContain('requireSession');
    expect(page).toContain('can(session, ACTIVITY)');
    expect(page).toContain('does not calculate ATP');
    expect(form).toContain('not assigned');
    expect(form).toContain('not an ATP balance');
    expect(form).toContain('They do not calculate ATP.');
    expect(form).toContain('X — all production orders');
    expect(form).not.toContain('created and released');
    expect(form).toContain('not checking control');
    expect(form).not.toMatch(/ATP quantity|available quantity/);
    expect(actions).toContain('requireCapability');
    expect(actions).not.toMatch(/stockRequirementsList|createProductionOrder|postGoods/);
  });
});
