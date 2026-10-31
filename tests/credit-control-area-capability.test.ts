import { describe, expect, it } from 'vitest';

import { CREDIT_CONTROL_AREA_CAPABILITY, EXPLICIT_GRANT_ONLY_CAPABILITIES } from '../src/platform/auth/capability-policy';
import { hasCapability } from '../src/platform/auth/session';

describe('credit-control maintenance authorization boundary', () => {
  it('is registered as exact-grant-only policy', () => {
    expect(EXPLICIT_GRANT_ONLY_CAPABILITIES.has(CREDIT_CONTROL_AREA_CAPABILITY)).toBe(true);
  });

  it.each(['*', 'CFG.*', 'CFG.FIN.*', 'FIN.*', '*.*.*'])('does not let existing broad pattern %s grant the new authority', (pattern) => {
    expect(hasCapability([pattern], CREDIT_CONTROL_AREA_CAPABILITY)).toBe(false);
  });

  it('accepts an exact grant, which remains the only future assignment path', () => {
    expect(hasCapability([CREDIT_CONTROL_AREA_CAPABILITY], CREDIT_CONTROL_AREA_CAPABILITY)).toBe(true);
    expect(hasCapability(['*', CREDIT_CONTROL_AREA_CAPABILITY], CREDIT_CONTROL_AREA_CAPABILITY)).toBe(true);
  });

  it('does not change wildcard behavior for existing authorities', () => {
    expect(hasCapability(['*'], 'FIN.CREDIT.MAINTAIN')).toBe(true);
    expect(hasCapability(['CFG.FIN.*'], 'CFG.FIN.COA.DEFINE')).toBe(true);
  });
});
