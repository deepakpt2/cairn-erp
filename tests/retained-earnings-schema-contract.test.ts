/**
 * SCR-121 / R-168 stage 2 — retained earnings schema contract.
 *
 * The indicator stands on the G/L account's chart segment
 * (migration 0121, P&L accounts only); the determination
 * stands in the standing account_determination table on the
 * RETAINED_EARNINGS event with the indicator in the
 * general-modifier slot, so OBYC and OB53 read one source.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const financeSchema = readFileSync('src/modules/finance/schema.ts', 'utf8');
const migration = readFileSync('drizzle/0121_retained_earnings_indicator.sql', 'utf8');
const determination = readFileSync('src/modules/foundation/account-determination.ts', 'utf8');
const vocabulary = readFileSync('src/modules/foundation/retained-earnings-vocabulary.ts', 'utf8');

describe('SCR-121 stage 2: retained earnings schema stands', () => {
  it('stores the one-character indicator on P&L accounts only', () => {
    expect(financeSchema).toContain("retainedEarningsIndicator: varchar('retained_earnings_indicator'");
    expect(financeSchema).toContain("'gl_account_retained_indicator_ck'");
    expect(migration).toContain('add column if not exists retained_earnings_indicator varchar(1)');
    expect(migration).toContain("gl_account_type = 'PL_STATEMENT'");
  });

  it('holds the indicator in the determination general-modifier slot', () => {
    expect(determination).toContain("event: 'RETAINED_EARNINGS'");
    expect(determination).toContain('usesGeneralModifier: true');
  });

  it('keeps the definition vocabulary client-safe and read-consistent', () => {
    expect(vocabulary).toContain("export const RETAINED_EARNINGS_ACTIVITY = 'CFG.FIN.RETAINED.DEFINE'");
    expect(vocabulary).toContain("STANDARD_RETAINED_EARNINGS_INDICATOR = 'X'");
    expect(vocabulary).not.toContain("from './schema'");
    expect(vocabulary).not.toContain('drizzle-orm');
  });
});
