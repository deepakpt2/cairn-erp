import { z } from 'zod';
import { and, asc, eq, sql } from 'drizzle-orm';

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
 * the table (migration 0044); stage 3 (below) maintains it.
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

/**
 * Maintaining the bank master (SCR-036 stage 3).
 *
 * One write for create and change, another for delete, in the shape the
 * configuration writers take — with three ruled differences (R-86), stated
 * rather than smoothed over. There is no prerequisite and no activity to
 * complete: shared reference data is no tenant's configuration progress.
 * There are no change documents: history files per tenant and a global row
 * has none to file under, so the audit is the actor columns — created_by on
 * creation, changed_by and changed_at on change. And there is no reason
 * field: the reason on a configuration write exists to be filed on its
 * change document, and a write that files nothing has nowhere honest to
 * keep one, so this screen does not ask.
 *
 * The key — bank country and bank key — is immutable, as every registry key
 * in this product is: renaming a bank means defining the new entry and, where
 * the old one should not stand, deleting it. A bank may be deleted only
 * while no house bank names it; house banks are tenant rows (SCR-037), so
 * the count covers every tenant, the way the tax code's usage count covers
 * every country.
 */

export const bankValuesSchema = z.object({
  mode: z.enum(['CREATE', 'CHANGE']),
  bankCountry: z
    .string()
    .trim()
    .transform((value) => value.toUpperCase())
    .pipe(z.string().regex(/^[A-Z]{2}$/, 'The Bank Country is the two-letter key from the country master.')),
  bankKey: z
    .string()
    .trim()
    .transform((value) => value.toUpperCase())
    .pipe(z.string().regex(/^[A-Z0-9]{1,15}$/, 'The Bank Key is up to fifteen letters or digits.')),
  name: z.string().trim().min(1, 'A bank name is required.').max(60, 'The bank name is at most sixty characters.'),
  /** An empty city or SWIFT clears it: both are optional on a bank. */
  city: z
    .string()
    .trim()
    .max(35, 'The city is at most thirty-five characters.')
    .transform((value) => (value === '' ? null : value)),
  swift: z
    .string()
    .trim()
    .transform((value) => (value === '' ? null : value.toUpperCase()))
    .pipe(
      z
        .string()
        .regex(
          /^[A-Z]{4}[A-Z]{2}[A-Z0-9]{2}([A-Z0-9]{3})?$/,
          'The SWIFT code is a BIC: eight or eleven characters — bank, country, location, and optionally branch.',
        )
        .nullable(),
    ),
});

export const bankInputSchema = bankValuesSchema.extend({
  client: z.string().regex(/^[A-Za-z0-9]{2,4}$/),
  changedBy: z.string().trim().min(1).max(60),
}).strict();

export type BankInput = z.input<typeof bankInputSchema>;

export const bankDeleteInputSchema = z.object({
  client: z.string().regex(/^[A-Za-z0-9]{2,4}$/),
  changedBy: z.string().trim().min(1).max(60),
  bankCountry: bankValuesSchema.shape.bankCountry,
  bankKey: bankValuesSchema.shape.bankKey,
}).strict();

export type BankDeleteInput = z.input<typeof bankDeleteInputSchema>;

export class BankMasterError extends Error {
  readonly code = 'CAIRN_CONFIG';

  constructor(
    message: string,
    readonly remedy = 'Review the bank and try again.',
  ) {
    super(message);
    this.name = 'BankMasterError';
  }
}

export interface BankSaveResult {
  /** False when a change repeated the values already stored; nothing was written. */
  changed: boolean;
  bankCountry: string;
  bankKey: string;
  name: string;
}

type Tx = Parameters<Parameters<typeof withTenant>[1]>[0];

/**
 * House banks naming this entry, across every tenant — the deletion guard.
 * The house-bank table arrives with SCR-037; until it exists nothing can name
 * a bank, which the information schema answers directly rather than the code
 * assuming either way.
 */
async function countHouseBankReferences(tx: Tx, bankCountry: string, bankKey: string): Promise<number> {
  const presence = (await tx.execute(
    sql`select to_regclass('public.house_bank') is not null as present`,
  )) as unknown as Array<{ present: boolean }>;
  if (!presence[0]?.present) return 0;
  const rows = (await tx.execute(
    sql`select count(*)::int as n from house_bank where bank_country = ${bankCountry} and bank_key = ${bankKey}`,
  )) as unknown as Array<{ n: number }>;
  return rows[0]?.n ?? 0;
}

/**
 * Create a bank, or change the name, city and SWIFT of one that stands.
 *
 * Idempotent on change: repeating the stored values reports `changed: false`
 * and writes nothing at all — not even the actor columns.
 */
export async function saveBank(raw: BankInput): Promise<BankSaveResult> {
  const parsed = bankInputSchema.safeParse(raw);
  if (!parsed.success) {
    throw new BankMasterError(
      parsed.error.issues[0]?.message ?? 'The bank is not valid.',
      'Correct the indicated value and submit again.',
    );
  }

  const { client, changedBy, ...values } = parsed.data;

  return withTenant(client, async (tx) => {
    const [country] = await tx
      .select({ code: countryReference.code })
      .from(countryReference)
      .where(eq(countryReference.code, values.bankCountry))
      .limit(1);
    if (!country) {
      throw new BankMasterError(
        `Country ${values.bankCountry} is not defined in the country master.`,
        'Choose a country the master holds; a bank in a country that does not exist banks nowhere.',
      );
    }

    const [existing] = await tx
      .select()
      .from(bankMaster)
      .where(and(
        eq(bankMaster.bankCountry, values.bankCountry),
        eq(bankMaster.bankKey, values.bankKey),
      ))
      .for('update');

    if (values.mode === 'CREATE' && existing) {
      throw new BankMasterError(
        `Bank ${values.bankKey} is already defined for ${values.bankCountry}.`,
        'Change the bank that exists, or choose another bank key.',
      );
    }
    if (values.mode === 'CHANGE' && !existing) {
      throw new BankMasterError(
        `Bank ${values.bankKey} is not defined for ${values.bankCountry}.`,
        'Create the bank first; a key cannot be changed into existence, because the key is the bank.',
      );
    }

    const result: BankSaveResult = {
      changed: true,
      bankCountry: values.bankCountry,
      bankKey: values.bankKey,
      name: values.name,
    };

    if (values.mode === 'CREATE') {
      await tx.insert(bankMaster).values({
        bankCountry: values.bankCountry,
        bankKey: values.bankKey,
        name: values.name,
        city: values.city,
        swift: values.swift,
        createdBy: changedBy,
      });
      return result;
    }

    if (
      existing.name === values.name
      && existing.city === values.city
      && existing.swift === values.swift
    ) {
      return { ...result, changed: false };
    }

    await tx
      .update(bankMaster)
      .set({
        name: values.name,
        city: values.city,
        swift: values.swift,
        changedBy,
        changedAt: new Date(),
      })
      .where(and(
        eq(bankMaster.bankCountry, values.bankCountry),
        eq(bankMaster.bankKey, values.bankKey),
      ));
    return result;
  });
}

/**
 * Delete a bank, while no house bank in any tenant names it. SCR-037 makes
 * the guard real; until its table exists the guard answers zero honestly.
 */
export async function deleteBank(raw: BankDeleteInput): Promise<{ deleted: true }> {
  const parsed = bankDeleteInputSchema.safeParse(raw);
  if (!parsed.success) {
    throw new BankMasterError(
      parsed.error.issues[0]?.message ?? 'The bank deletion is not valid.',
      'Correct the indicated value and submit again.',
    );
  }

  const { client, changedBy, ...values } = parsed.data;
  void changedBy;

  return withTenant(client, async (tx) => {
    const [existing] = await tx
      .select()
      .from(bankMaster)
      .where(and(
        eq(bankMaster.bankCountry, values.bankCountry),
        eq(bankMaster.bankKey, values.bankKey),
      ))
      .for('update');
    if (!existing) {
      throw new BankMasterError(
        `Bank ${values.bankKey} is not defined for ${values.bankCountry}.`,
        'Reload the banks; the entry may already have been deleted.',
      );
    }

    const references = await countHouseBankReferences(tx, values.bankCountry, values.bankKey);
    if (references > 0) {
      throw new BankMasterError(
        `Bank ${values.bankKey} for ${values.bankCountry} is named by ${references} house bank(s) and cannot be deleted.`,
        'House banks read this entry\'s name, city and SWIFT code; repoint or delete those house banks first, so nothing is left displaying a bank that is no longer defined.',
      );
    }

    await tx
      .delete(bankMaster)
      .where(and(
        eq(bankMaster.bankCountry, values.bankCountry),
        eq(bankMaster.bankKey, values.bankKey),
      ));
    return { deleted: true as const };
  });
}
