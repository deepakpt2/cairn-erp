import { describe, expect, it } from 'vitest';
import { TARGETS, FIXTURE_NAME, RUN_TIMEOUT_MS, parseBrowserCommand, isOwnedFixture } from '../scripts/browser-smoke/targets';

describe('bounded browser target selection', () => {
  it('defaults to the existing foundation regression only', () => {
    expect(parseBrowserCommand([])).toEqual({ mode: 'run', target: TARGETS[0] });
  });
  it.each(TARGETS.map((target) => [target.id, target] as const))('selects %s independently', (id, target) => {
    expect(parseBrowserCommand(['--target', id])).toEqual({ mode: 'run', target });
  });
  it('accepts the equals-form flag without adding another target', () => {
    expect(parseBrowserCommand(['--target=material-mrp'])).toEqual({ mode: 'run', target: TARGETS[3] });
  });
  it.each(['help', 'list'])('supports --%s without choosing a browser run', (mode) => {
    expect(parseBrowserCommand([`--${mode}`])).toEqual({ mode });
  });
  it.each([['--all'], ['--target'], ['--target', 'foundation', '--target', 'material-basic'], ['--list', '--target', 'foundation']])('rejects combined or malformed arguments %j', (...args) => {
    expect(() => parseBrowserCommand(args)).toThrow('exactly one target');
  });
  it.each(['unknown', '', 'Foundation', '0100'])('rejects an unknown target %j', (name) => {
    expect(() => parseBrowserCommand(['--target', name])).toThrow('Unknown browser target');
  });
  it('uses distinct reserved test keys, never the development company key', () => {
    expect(new Set(TARGETS.map((target) => target.client)).size).toBe(TARGETS.length);
    for (const target of TARGETS) expect(target.client).toMatch(/^T\d{3}$/);
    expect(TARGETS.some((target) => String(target.client) === '0100')).toBe(false);
  });
  it('limits each browser target to two minutes', () => {
    expect(RUN_TIMEOUT_MS).toBe(120_000);
  });
});

describe('browser fixture ownership guard', () => {
  const target = TARGETS[0];
  const fixture = { client: target.client, name: FIXTURE_NAME, is_development: true };
  it('recognises only the exact owned fixture', () => {
    expect(isOwnedFixture(target, fixture)).toBe(true);
  });
  it('refuses a differently named tenant with the same key', () => {
    expect(isOwnedFixture(target, { ...fixture, name: 'Owner company' })).toBe(false);
  });
  it('refuses a non-development tenant', () => {
    expect(isOwnedFixture(target, { ...fixture, is_development: false })).toBe(false);
  });
  it('refuses a tenant with a different key', () => {
    expect(isOwnedFixture(target, { ...fixture, client: '0100' })).toBe(false);
  });
});
