import { describe, expect, it, vi } from 'vitest';
import type { Sql } from 'postgres';
import {
  COUNTRIES,
  CURRENCIES,
  UNITS,
  insertStandardReferenceData,
  initializeStandardReferenceData,
} from '../scripts/standard-reference-data';
import { PARTNER_BANK_PROFILE_POLICIES } from '../src/platform/security/partner-bank-profile-readiness';

function recordingClient() {
  const calls: Array<{ query: string; parameters: unknown[] }> = [];
  const unsafe = vi.fn(async (query: string, parameters: unknown[] = []) => {
    calls.push({ query, parameters });
    return [];
  });
  const client = { unsafe, begin: async (fn: (tx: unknown) => Promise<void>) => fn(client) };
  return { client: client as unknown as Sql, calls, unsafe };
}

describe('standard reference-data initialization', () => {
  it('uses project-defined country, currency, and unit catalogues', () => {
    expect(CURRENCIES).toContainEqual(['USD', 'US Dollar', 2, '$']);
    expect(CURRENCIES).toContainEqual(['KWD', 'Kuwaiti Dinar', 3, 'KD']);
    expect(COUNTRIES).toContainEqual(['KW', 'Kuwait', 'KWD']);
    expect(UNITS).toContainEqual(['KG', 'Kilogram', 'MASS', 3, true]);
    expect(UNITS).toContainEqual(['PC', 'Piece', 'COUNT', 0, true]);
  });

  it('inserts only missing defaults, so repeated runs cannot overwrite customization', async () => {
    const { client, calls } = recordingClient();
    await insertStandardReferenceData(client);
    const firstRun = calls.map((call) => call.query);
    await insertStandardReferenceData(client);

    expect(calls).toHaveLength(2 * (COUNTRIES.length + CURRENCIES.length + UNITS.length + PARTNER_BANK_PROFILE_POLICIES.length));
    expect(calls.every(({ query }) => /on conflict \([^)]*\) do nothing/i.test(query))).toBe(true);
    expect(calls.every(({ query }) => !/do update/i.test(query))).toBe(true);
    expect(calls.slice(calls.length / 2).map((call) => call.query)).toEqual(firstRun);
  });

  it('wraps initialization in one transaction', async () => {
    const { client, calls } = recordingClient();
    await initializeStandardReferenceData(client);
    expect(calls.length).toBe(COUNTRIES.length + CURRENCIES.length + UNITS.length + PARTNER_BANK_PROFILE_POLICIES.length);
  });
});
