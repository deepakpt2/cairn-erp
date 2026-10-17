import { z } from 'zod';
import { and, asc, count, eq, inArray } from 'drizzle-orm';

import { withTenant } from '../../platform/db/client';
import { recordChange } from '../../platform/change';
import { markActivityComplete } from '../../platform/tenancy';
import { configActivityStatus } from '../../platform/tables/registry';
import { country as countryReference } from '../../platform/tables/reference';
import { journalEntryLine } from '../finance/schema';
import { taxCode } from './schema';

/**
 * FTXP Define Tax Codes for Sales and Purchases — the read side (SCR-035 stage 1).
 *
 * There is no tax-code table yet: the activity row has routed at an empty route since
 * the seed, journal lines carry a tax code as free text, and nothing has ever defined
 * what the codes mean. This module exists before the table for the same reason the
 * earlier readers do: the screen has to render what a write will be judged against —
 * the countries a code may be defined for, and where the codes are already used.
 *
 * Two package hedges the owner settled shape what it answers (R-85). The code is up to
 * four characters within a country (the journal line's own width), not the package's
 * two; and the condition/account-key values the package calls KTOSL and Account Key
 * are kept as the operator-entered data they are — tenant values in house-named
 * columns, checked for shape and nothing more, since no condition master exists here
 * for them to be checked against.
 *
 * The usage count reads journal lines, which store the code without its country: a
 * code used anywhere in the tenant counts against deleting it under any country, and
 * the count says so. That is conservative in the right direction — the alternative
 * would let a used code vanish because its lines were posted under another flag.
 */
export const ACTIVITY = 'CFG.FIN.TAXCODE.DEFINE';

export interface TaxCodeRow {
  country: string;
  taxCode: string;
  name: string;
  taxType: string;
  /** Percentage, 0–100, as stored (numeric at two fractional digits). */
  ratePercent: string;
  accountKey: string | null;
  /** Journal lines in this tenant carrying the code, under any country. */
  usedByLines: number;
}

export interface CountryChoice {
  code: string;
  name: string;
}

/** Every tax code the tenant holds, beside the lines that already carry each code. */
export async function listTaxCodes(client: string): Promise<TaxCodeRow[]> {
  return withTenant(client, async (tx) => {
    const [codes, usage] = await Promise.all([
      tx
        .select({
          country: taxCode.country,
          taxCode: taxCode.taxCode,
          name: taxCode.name,
          taxType: taxCode.taxType,
          ratePercent: taxCode.ratePercent,
          accountKey: taxCode.accountKey,
        })
        .from(taxCode)
        .where(eq(taxCode.client, client))
        .orderBy(asc(taxCode.country), asc(taxCode.taxCode)),
      tx
        .select({ taxCode: journalEntryLine.taxCode, lines: count() })
        .from(journalEntryLine)
        .where(eq(journalEntryLine.client, client))
        .groupBy(journalEntryLine.taxCode),
    ]);

    const usedBy = new Map(
      usage.filter((row) => row.taxCode !== null).map((row) => [row.taxCode as string, Number(row.lines)]),
    );

    return codes.map((row) => ({
      country: row.country.trim(),
      taxCode: row.taxCode,
      name: row.name,
      taxType: row.taxType,
      ratePercent: row.ratePercent,
      accountKey: row.accountKey,
      usedByLines: usedBy.get(row.taxCode) ?? 0,
    }));
  });
}

/** The countries a tax code may be defined for: the country master, in full. */
export async function listCountryChoices(client: string): Promise<CountryChoice[]> {
  return withTenant(client, async (tx) => {
    const rows = await tx
      .select({ code: countryReference.code, name: countryReference.name })
      .from(countryReference)
      .orderBy(asc(countryReference.code));
    return rows.map((row) => ({ code: row.code.trim(), name: row.name }));
  });
}

export const OBJECT_CLASS = 'tax_code';
const PREREQUISITES = ['CFG.ORG.COMPANYCODE.DEFINE'] as const;

/**
 * FTXP — define the tax codes (SCR-035 stage 3).
 *
 * One write for create and change, and another for delete, in the OBBO/OB08 shape. The
 * rules the owner settled shape them (R-85).
 *
 * A code's key — country and code — **is immutable**: the screen says which of the two
 * it is doing, and a service that inferred the answer from whether the key exists would
 * turn a mistyped code on a new entry into somebody else's rate change. Renaming a code
 * means defining the new one and, where the old one should not stand, deleting it.
 *
 * A code **may be deleted only while no journal line carries it**. Journal lines store
 * the code without its country, so the count is every line in the tenant carrying the
 * code, under any country — conservative in the right direction, since the alternative
 * would let a used code vanish because its lines were posted under another flag.
 *
 * A **reason is mandatory on every write**, and each write files one change document on
 * the composite key with the rate security-relevant: a rate decides what a sale or a
 * purchase costs after tax, and a mid-year change is precisely what an auditor asks
 * about. Documents already posted keep the amounts they were posted with; a changed
 * rate governs only what is determined from then on, and the service says how many
 * lines already stand against the code so the caller can say it back.
 */
const upperCode = (max: number, message: string) =>
  z
    .string()
    .trim()
    .transform((value) => value.toUpperCase())
    .pipe(z.string().regex(new RegExp(`^[A-Z0-9]{1,${max}}$`), message));

export const taxCodeValuesSchema = z.object({
  mode: z.enum(['CREATE', 'CHANGE']),
  country: z
    .string()
    .trim()
    .transform((value) => value.toUpperCase())
    .pipe(z.string().regex(/^[A-Z]{2}$/, 'The Country is the two-letter key from the country master.')),
  taxCode: upperCode(4, 'The Tax Code is up to four letters or digits.'),
  name: z.string().trim().min(1, 'A description is required.').max(50, 'The description is at most fifty characters.'),
  taxType: upperCode(4, 'The Tax Type is up to four letters or digits.'),
  ratePercent: z
    .string()
    .trim()
    .regex(/^\d{1,3}(\.\d{1,2})?$/, 'The Tax Rate is a percentage of at most two fractional digits.')
    .refine((value) => Number(value) <= 100, 'The Tax Rate is at most 100.'),
  /** An empty account key clears it: the field is optional in the package and here. */
  accountKey: z
    .string()
    .trim()
    .transform((value) => (value === '' ? null : value.toUpperCase()))
    .pipe(z.string().regex(/^[A-Z0-9]{1,3}$/, 'The Account Key is up to three letters or digits.').nullable()),
  /**
   * The rate the screen opened against, for a change. Required rather than defaulted:
   * a caller that does not say what it saw cannot be told that somebody else moved first.
   */
  expectedRate: z.string().trim().max(10).default(''),
  reason: z.string().trim().min(1, 'A reason is required.').max(500, 'The reason is at most 500 characters.'),
});

export const taxCodeInputSchema = taxCodeValuesSchema.extend({
  client: z.string().regex(/^[A-Za-z0-9]{2,4}$/),
  changedBy: z.string().trim().min(1).max(60),
}).strict();

export type TaxCodeInput = z.input<typeof taxCodeInputSchema>;

export const taxCodeDeleteInputSchema = z.object({
  client: z.string().regex(/^[A-Za-z0-9]{2,4}$/),
  changedBy: z.string().trim().min(1).max(60),
  country: taxCodeValuesSchema.shape.country,
  taxCode: taxCodeValuesSchema.shape.taxCode,
  reason: taxCodeValuesSchema.shape.reason,
}).strict();

export type TaxCodeDeleteInput = z.input<typeof taxCodeDeleteInputSchema>;

export class TaxCodeError extends Error {
  readonly code = 'CAIRN_CONFIG';

  constructor(
    message: string,
    readonly remedy = 'Review the tax code and try again.',
  ) {
    super(message);
    this.name = 'TaxCodeError';
  }
}

export interface TaxCodeSaveResult {
  /** False when a change repeated the values already stored; nothing was written. */
  changed: boolean;
  country: string;
  taxCode: string;
  name: string;
  ratePercent: string;
  /** Journal lines in the tenant carrying the code at the moment of the write. */
  usedByLines: number;
}

/** The change-document key: the composite key, readable in the audit trail as one string. */
function objectKeyOf(country: string, code: string): string {
  return `${country}/${code}`;
}

type Tx = Parameters<Parameters<typeof withTenant>[1]>[0];

async function assertPrerequisites(tx: Tx, client: string): Promise<void> {
  const rows = await tx
    .select({ activityCode: configActivityStatus.activityCode })
    .from(configActivityStatus)
    .where(and(
      eq(configActivityStatus.client, client),
      inArray(configActivityStatus.activityCode, [...PREREQUISITES]),
      eq(configActivityStatus.status, 'COMPLETED'),
    ));
  const completed = new Set(rows.map((row) => row.activityCode));
  const missing = PREREQUISITES.filter((code) => !completed.has(code));
  if (missing.length > 0) {
    throw new TaxCodeError(
      `Tax code prerequisites are incomplete: ${missing.join(', ')}.`,
      'Define a Company Code in the configuration workbench first: a tax code exists to be posted on a book, and there is no book until then.',
    );
  }
}

/** Journal lines in the tenant carrying the code, under any country — lines store none. */
async function countUsedLines(tx: Tx, client: string, code: string): Promise<number> {
  const [row] = await tx
    .select({ lines: count() })
    .from(journalEntryLine)
    .where(and(eq(journalEntryLine.client, client), eq(journalEntryLine.taxCode, code)));
  return row?.lines ?? 0;
}

/**
 * Create a tax code, or change the description, rate, type and account key of one
 * that stands.
 *
 * Idempotent on change: repeating the stored values reports `changed: false` and
 * writes nothing but the activity completion.
 */
export async function saveTaxCode(raw: TaxCodeInput): Promise<TaxCodeSaveResult> {
  const parsed = taxCodeInputSchema.safeParse(raw);
  if (!parsed.success) {
    throw new TaxCodeError(
      parsed.error.issues[0]?.message ?? 'The tax code is not valid.',
      'Correct the indicated value and submit again.',
    );
  }

  const { client, changedBy, ...values } = parsed.data;

  return withTenant(client, async (tx) => {
    await assertPrerequisites(tx, client);

    const [country] = await tx
      .select({ code: countryReference.code })
      .from(countryReference)
      .where(eq(countryReference.code, values.country))
      .limit(1);
    if (!country) {
      throw new TaxCodeError(
        `Country ${values.country} is not defined in the country master.`,
        'Choose a country the master holds; a tax code for a country that does not exist taxes nowhere.',
      );
    }

    const [existing] = await tx
      .select()
      .from(taxCode)
      .where(and(
        eq(taxCode.client, client),
        eq(taxCode.country, values.country),
        eq(taxCode.taxCode, values.taxCode),
      ))
      .for('update');

    if (values.mode === 'CREATE' && existing) {
      throw new TaxCodeError(
        `Tax Code ${values.taxCode} is already defined for ${values.country}.`,
        'Change the tax code that exists, or choose another code.',
      );
    }
    if (values.mode === 'CHANGE' && !existing) {
      throw new TaxCodeError(
        `Tax Code ${values.taxCode} is not defined for ${values.country}.`,
        'Create the tax code first; a key cannot be changed into existence, because the key is the code.',
      );
    }

    const usedByLines = await countUsedLines(tx, client, values.taxCode);
    const result: TaxCodeSaveResult = {
      changed: true,
      country: values.country,
      taxCode: values.taxCode,
      name: values.name,
      ratePercent: values.ratePercent,
      usedByLines,
    };

    if (values.mode === 'CREATE') {
      await tx.insert(taxCode).values({
        client,
        country: values.country,
        taxCode: values.taxCode,
        name: values.name,
        taxType: values.taxType,
        ratePercent: values.ratePercent,
        accountKey: values.accountKey,
        createdBy: changedBy,
      });
      await recordChange(tx, {
        client,
        objectClass: OBJECT_CLASS,
        objectKey: objectKeyOf(values.country, values.taxCode),
        changeType: 'CREATE',
        changedBy,
        transactionCode: ACTIVITY,
        reason: values.reason,
        after: {
          country: values.country,
          taxCode: values.taxCode,
          name: values.name,
          taxType: values.taxType,
          ratePercent: values.ratePercent,
          accountKey: values.accountKey,
        },
        fieldLabels: {
          country: 'Country',
          taxCode: 'Tax code',
          name: 'Description',
          taxType: 'Tax type (condition)',
          ratePercent: 'Tax rate %',
          accountKey: 'Account key',
        },
        securityRelevantFields: ['ratePercent'],
      });
      await markActivityComplete(tx, client, ACTIVITY, changedBy);
      return result;
    }

    // CHANGE: the rate the caller saw is the guard, the way OB08's rate is. Compared as
    // numbers at the column's precision rather than as strings nobody normalized.
    if (values.expectedRate === '' || Number(existing.ratePercent) !== Number(values.expectedRate)) {
      throw new TaxCodeError(
        `Tax Code ${values.taxCode} for ${values.country} changed after it was opened.`,
        `It now stands at ${existing.ratePercent}%; reload the tax codes before changing it.`,
      );
    }

    if (
      existing.name === values.name
      && existing.taxType === values.taxType
      && Number(existing.ratePercent) === Number(values.ratePercent)
      && existing.accountKey === values.accountKey
    ) {
      await markActivityComplete(tx, client, ACTIVITY, changedBy);
      return { ...result, changed: false };
    }

    await tx
      .update(taxCode)
      .set({
        name: values.name,
        taxType: values.taxType,
        ratePercent: values.ratePercent,
        accountKey: values.accountKey,
        changedBy,
        changedAt: new Date(),
      })
      .where(and(
        eq(taxCode.client, client),
        eq(taxCode.country, values.country),
        eq(taxCode.taxCode, values.taxCode),
      ));

    await recordChange(tx, {
      client,
      objectClass: OBJECT_CLASS,
      objectKey: objectKeyOf(values.country, values.taxCode),
      changeType: 'CHANGE',
      changedBy,
      transactionCode: ACTIVITY,
      reason: values.reason,
      before: {
        name: existing.name,
        taxType: existing.taxType,
        ratePercent: existing.ratePercent,
        accountKey: existing.accountKey,
      },
      // The usage count appears only on the after side, deliberately, the way OB37 files
      // its exposure: recordChange files the fields whose values moved, so a figure
      // repeated on both sides would be dropped and the audit trail would not say how
      // many lines already stood against the code when its rate changed. It is not a
      // field that changed; it is the context the change was made in.
      after: {
        name: values.name,
        taxType: values.taxType,
        ratePercent: values.ratePercent,
        accountKey: values.accountKey,
        usedByLines,
      },
      fieldLabels: {
        name: 'Description',
        taxType: 'Tax type (condition)',
        ratePercent: 'Tax rate %',
        accountKey: 'Account key',
        usedByLines: 'Journal lines carrying the code at the change',
      },
      securityRelevantFields: ['ratePercent'],
    });
    await markActivityComplete(tx, client, ACTIVITY, changedBy);
    return result;
  });
}

/**
 * Delete a tax code, while no journal line in the tenant carries it. The deletion
 * files what was removed, so the audit trail keeps the definition after the
 * registry stops holding it.
 */
export async function deleteTaxCode(raw: TaxCodeDeleteInput): Promise<{ deleted: true }> {
  const parsed = taxCodeDeleteInputSchema.safeParse(raw);
  if (!parsed.success) {
    throw new TaxCodeError(
      parsed.error.issues[0]?.message ?? 'The tax code deletion is not valid.',
      'Correct the indicated value and submit again.',
    );
  }

  const { client, changedBy, ...values } = parsed.data;

  return withTenant(client, async (tx) => {
    await assertPrerequisites(tx, client);

    const [existing] = await tx
      .select()
      .from(taxCode)
      .where(and(
        eq(taxCode.client, client),
        eq(taxCode.country, values.country),
        eq(taxCode.taxCode, values.taxCode),
      ))
      .for('update');
    if (!existing) {
      throw new TaxCodeError(
        `Tax Code ${values.taxCode} is not defined for ${values.country}.`,
        'Reload the tax codes; the code may already have been deleted.',
      );
    }

    const usedByLines = await countUsedLines(tx, client, values.taxCode);
    if (usedByLines > 0) {
      throw new TaxCodeError(
        `Tax Code ${values.taxCode} is posted on ${usedByLines} journal line(s) and cannot be deleted.`,
        'Journal lines carry the code without its country, so the count covers every line in this tenant carrying it. A code that history names stays defined; change its rate if it should no longer apply, so what it meant remains readable.',
      );
    }

    await tx
      .delete(taxCode)
      .where(and(
        eq(taxCode.client, client),
        eq(taxCode.country, values.country),
        eq(taxCode.taxCode, values.taxCode),
      ));

    await recordChange(tx, {
      client,
      objectClass: OBJECT_CLASS,
      objectKey: objectKeyOf(values.country, values.taxCode),
      changeType: 'DELETE',
      changedBy,
      transactionCode: ACTIVITY,
      reason: values.reason,
      before: {
        name: existing.name,
        taxType: existing.taxType,
        ratePercent: existing.ratePercent,
        accountKey: existing.accountKey,
      },
      fieldLabels: {
        name: 'Description',
        taxType: 'Tax type (condition)',
        ratePercent: 'Tax rate %',
        accountKey: 'Account key',
      },
      securityRelevantFields: ['ratePercent'],
    });
    await markActivityComplete(tx, client, ACTIVITY, changedBy);
    return { deleted: true as const };
  });
}
