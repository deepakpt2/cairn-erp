import { asc } from 'drizzle-orm';

import { withTenant } from '../../platform/db/client';
import { bankMaster, country as countryReference } from '../../platform/tables/reference';

/**
 * Bank master — the read side (SCR-036 stage 1).
 *
 * House banks (FI12, SCR-037) name a bank by country and key and display its name,
 * city and SWIFT code as facts they do not own. In the reference product those facts
 * live in a global bank master keyed by bank country and bank key; this product has
 * reference tables for countries, currencies and units, but nothing for banks, so a
 * house bank created today would have to carry the bank's name as tenant data typed
 * at it — wrong in every tenant after the first, and unverifiable in all of them.
 * The owner settled that the master comes first, as its own SCR (R-86), and that
 * FI12 waits a round rather than typing around the gap.
 *
 * The master is global: one row per bank, shared by every tenant, like the country
 * master it keys against. That choice has two stated consequences. It is gated by a
 * capability (CFG.FIN.BANK.DEFINE) rather than a configuration activity, because
 * shared reference data is not one tenant's configuration progress and completing
 * it must mark nothing in any workbench. And its writes audit through
 * created_by/updated_by columns rather than change documents, because change
 * history is filed per tenant and a global row has no tenant to file it under.
 * Deletion is refused while any tenant's house bank names the entry.
 *
 * Stage 1 published the screen against an honestly empty list; stage 2 created
 * the table (migration 0044) and the read below is real from that commit on.
 */
export const CAPABILITY = 'CFG.FIN.BANK.DEFINE';
export const OBJECT_CLASS = 'bank_master';

export interface BankRow {
  /** Bank country — a code of the country master, half the key. */
  bankCountry: string;
  /** Bank key within the country — the national bank identifier, half the key. */
  bankKey: string;
  name: string;
  city: string | null;
  /** SWIFT/BIC, 8 or 11 characters, where one is recorded. */
  swift: string | null;
}

export interface BankCountryChoice {
  code: string;
  name: string;
}

/**
 * Every bank the master holds, by country then key. The table is global — the
 * tenant context only borrows the connection; no row is any tenant's.
 */
export async function listBanks(client: string): Promise<BankRow[]> {
  return withTenant(client, async (tx) => {
    const rows = await tx
      .select({
        bankCountry: bankMaster.bankCountry,
        bankKey: bankMaster.bankKey,
        name: bankMaster.name,
        city: bankMaster.city,
        swift: bankMaster.swift,
      })
      .from(bankMaster)
      .orderBy(asc(bankMaster.bankCountry), asc(bankMaster.bankKey));
    return rows.map((row) => ({ ...row, bankCountry: row.bankCountry.trim() }));
  });
}

/** The countries a bank may be keyed under — the country master, read as-is. */
export async function listBankCountryChoices(client: string): Promise<BankCountryChoice[]> {
  return withTenant(client, async (tx) => {
    const rows = await tx
      .select({ code: countryReference.code, name: countryReference.name })
      .from(countryReference)
      .orderBy(asc(countryReference.code));
    return rows.map((row) => ({ code: row.code.trim(), name: row.name }));
  });
}
