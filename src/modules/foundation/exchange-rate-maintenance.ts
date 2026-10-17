import { z } from 'zod';
import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';

import { withTenant } from '../../platform/db/client';
import { recordChange } from '../../platform/change';
import { markActivityComplete } from '../../platform/tenancy';
import { configActivityStatus } from '../../platform/tables/registry';
import { currency as currencyReference } from '../../platform/tables/reference';
import { exchangeRate } from './schema';

/**
 * OB08 Maintain Exchange Rates — the read side (SCR-034 stage 1).
 *
 * The exchange_rate table has existed since the first schema, written once by the standard
 * package's builder and read by nothing: the posting engine carries the rate on the journal
 * itself, so this table is the reference a configurator maintains and a future lookup reads.
 * This module exists before the writes for the same reason the OBBP reader does: the screen
 * has to render what the tenant holds before it is worth writing to.
 *
 * Two package hedges the owner settled shape what the screen must say. The rate types are
 * the product's own — BUYING, SELLING, AVERAGE — because reference keywords live in search
 * aliases and never in codes or the database; and the translation ratios the package
 * attributes to TCURF arrive with stage 2 as columns of their own, so the rate a row
 * effectively carries is rate × ratioTo / ratioFrom, computed where the row is read.
 */
export const ACTIVITY = 'CFG.FIN.EXRATE.MAINTAIN';

export const RATE_TYPES = ['AVERAGE', 'BUYING', 'SELLING'] as const;
export type RateType = (typeof RATE_TYPES)[number];

export interface ExchangeRateRow {
  rateType: string;
  fromCurrency: string;
  toCurrency: string;
  /** ISO date (YYYY-MM-DD): the rate is effective from this date until a newer one. */
  validFrom: string;
  /** As entered: 1 unit of fromCurrency = rate units of toCurrency. */
  rate: string;
  /** The unit count the From side of the quote is stated for; at least 1. */
  ratioFrom: number;
  /** The unit count the To side of the quote is stated for; at least 1. */
  ratioTo: number;
  /** rate × ratioTo / ratioFrom, at the stored precision: what a posting would use. */
  effectiveRate: string;
}

export interface CurrencyChoice {
  code: string;
  name: string;
}

/** Every rate the tenant holds, newest validity first within each type and pair. */
export async function listExchangeRates(client: string): Promise<ExchangeRateRow[]> {
  return withTenant(client, async (tx) => {
    const rows = await tx
      .select({
        rateType: exchangeRate.rateType,
        fromCurrency: exchangeRate.fromCurrency,
        toCurrency: exchangeRate.toCurrency,
        validFrom: exchangeRate.validFrom,
        rate: exchangeRate.rate,
        ratioFrom: exchangeRate.ratioFrom,
        ratioTo: exchangeRate.ratioTo,
        // Computed by the database, not by a JavaScript float: a rate is money, and the
        // stored precision is eighteen digits a double cannot hold.
        effectiveRate: sql<string>`(${exchangeRate.rate} * ${exchangeRate.ratioTo} / ${exchangeRate.ratioFrom})::numeric(18, 8)`,
      })
      .from(exchangeRate)
      .where(eq(exchangeRate.client, client))
      .orderBy(
        asc(exchangeRate.rateType),
        asc(exchangeRate.fromCurrency),
        asc(exchangeRate.toCurrency),
        desc(exchangeRate.validFrom),
      );
    return rows.map((row) => ({ ...row, validFrom: String(row.validFrom) }));
  });
}

/** The currencies a rate may translate between: the active rows of the currency master. */
export async function listCurrencyChoices(client: string): Promise<CurrencyChoice[]> {
  return withTenant(client, async (tx) => {
    const rows = await tx
      .select({ code: currencyReference.code, name: currencyReference.name })
      .from(currencyReference)
      .where(eq(currencyReference.isActive, true))
      .orderBy(asc(currencyReference.code));
    return rows.map((row) => ({ code: row.code.trim(), name: row.name }));
  });
}

export const OBJECT_CLASS = 'exchange_rate';
const PREREQUISITES = ['CFG.ORG.COMPANYCODE.DEFINE'] as const;

/**
 * OB08 — maintain the exchange rates (SCR-034 stage 3).
 *
 * One write for create and change, and another for delete, in the OBBO shape. The rules
 * the owner settled shape them (R-84).
 *
 * A rate's key — type, pair and the date it takes effect — **is immutable**: the screen
 * says which of the two it is doing, and a service that inferred the answer from whether
 * the key exists would turn a mistyped pair on a new entry into somebody else's rate
 * change. Correcting a key means a new rate and, where the old one should not stand, a
 * deletion.
 *
 * A rate **may be deleted**: documents already posted keep the rate they were posted
 * with — the journal carries its own rate — so deletion affects only future lookups and
 * rewrites no history. Every write, deletion included, carries a **mandatory reason** and
 * files one change document with the rate security-relevant, because a rate decides what
 * a foreign-currency amount becomes in the books.
 *
 * Changing a rate that already stands asks for the rate the caller saw (`expectedRate`),
 * the way OB37 asks for the variant: a correction written against a stale grid would
 * otherwise overwrite a correction somebody else just made, and neither would know.
 */
const currencyCodeSchema = z
  .string()
  .trim()
  .transform((value) => value.toUpperCase())
  .pipe(z.string().regex(/^[A-Z]{3}$/, 'A currency is exactly three letters.'));

const rateValueSchema = z
  .string()
  .trim()
  .regex(/^\d{1,10}(\.\d{1,8})?$/, 'The rate is a decimal of at most ten whole and eight fractional digits.')
  .refine((value) => Number(value) > 0, 'The rate must be greater than zero.');

const ratioSchema = z.coerce
  .number()
  .int('A translation ratio is a whole number.')
  .min(1, 'A translation ratio is at least 1.')
  .max(999_999_999, 'A translation ratio is at most nine digits.');

export const exchangeRateValuesSchema = z.object({
  mode: z.enum(['CREATE', 'CHANGE']),
  rateType: z
    .string()
    .trim()
    .transform((value) => value.toUpperCase())
    .pipe(z.enum(RATE_TYPES, { message: 'The Exchange Rate Type is Average, Buying or Selling.' })),
  fromCurrency: currencyCodeSchema,
  toCurrency: currencyCodeSchema,
  validFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'The Valid From date is a calendar date (YYYY-MM-DD).'),
  rate: rateValueSchema,
  ratioFrom: ratioSchema.default(1),
  ratioTo: ratioSchema.default(1),
  /**
   * The rate the screen opened against, for a change. Required rather than defaulted:
   * a caller that does not say what it saw cannot be told that somebody else moved first.
   */
  expectedRate: z.string().trim().max(20).default(''),
  reason: z.string().trim().min(1, 'A reason is required.').max(500, 'The reason is at most 500 characters.'),
});

export const exchangeRateInputSchema = exchangeRateValuesSchema.extend({
  client: z.string().regex(/^[A-Za-z0-9]{2,4}$/),
  changedBy: z.string().trim().min(1).max(60),
}).strict();

export type ExchangeRateInput = z.input<typeof exchangeRateInputSchema>;

export const exchangeRateDeleteInputSchema = z.object({
  client: z.string().regex(/^[A-Za-z0-9]{2,4}$/),
  changedBy: z.string().trim().min(1).max(60),
  rateType: exchangeRateValuesSchema.shape.rateType,
  fromCurrency: currencyCodeSchema,
  toCurrency: currencyCodeSchema,
  validFrom: exchangeRateValuesSchema.shape.validFrom,
  reason: exchangeRateValuesSchema.shape.reason,
}).strict();

export type ExchangeRateDeleteInput = z.input<typeof exchangeRateDeleteInputSchema>;

export class ExchangeRateError extends Error {
  readonly code = 'CAIRN_CONFIG';

  constructor(
    message: string,
    readonly remedy = 'Review the exchange rate and try again.',
  ) {
    super(message);
    this.name = 'ExchangeRateError';
  }
}

export interface ExchangeRateSaveResult {
  /** False when a change repeated the rate and ratios already stored; nothing was written. */
  changed: boolean;
  rateType: string;
  fromCurrency: string;
  toCurrency: string;
  validFrom: string;
  rate: string;
  ratioFrom: number;
  ratioTo: number;
}

/** The change-document key: the composite key, readable in the audit trail as one string. */
function objectKeyOf(values: { rateType: string; fromCurrency: string; toCurrency: string; validFrom: string }): string {
  return `${values.rateType}/${values.fromCurrency}/${values.toCurrency}/${values.validFrom}`;
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
    throw new ExchangeRateError(
      `Exchange rate prerequisites are incomplete: ${missing.join(', ')}.`,
      'Define a Company Code in the configuration workbench first: an exchange rate exists to translate a book kept in one currency into another, and there is no book until then.',
    );
  }
}

async function assertCurrenciesExist(tx: Tx, fromCurrency: string, toCurrency: string): Promise<void> {
  const rows = await tx
    .select({ code: currencyReference.code, isActive: currencyReference.isActive })
    .from(currencyReference)
    .where(inArray(currencyReference.code, [fromCurrency, toCurrency]));
  const byCode = new Map(rows.map((row) => [row.code.trim(), row.isActive]));
  for (const code of [fromCurrency, toCurrency]) {
    if (!byCode.has(code)) {
      throw new ExchangeRateError(
        `Currency ${code} is not defined in the currency master.`,
        'Choose a currency the master holds; a rate for a currency that does not exist would translate nothing.',
      );
    }
    if (!byCode.get(code)) {
      throw new ExchangeRateError(
        `Currency ${code} is not active in the currency master.`,
        'Choose an active currency; a rate into a retired currency would be offered long after the currency stopped being one.',
      );
    }
  }
}

/**
 * Create an exchange rate, or change the rate and ratios of one that stands.
 *
 * Idempotent on change: repeating the stored rate and ratios reports `changed: false` and
 * writes nothing but the activity completion.
 */
export async function saveExchangeRate(raw: ExchangeRateInput): Promise<ExchangeRateSaveResult> {
  const parsed = exchangeRateInputSchema.safeParse(raw);
  if (!parsed.success) {
    throw new ExchangeRateError(
      parsed.error.issues[0]?.message ?? 'The exchange rate is not valid.',
      'Correct the indicated value and submit again.',
    );
  }

  const { client, changedBy, ...values } = parsed.data;

  if (values.fromCurrency === values.toCurrency) {
    throw new ExchangeRateError(
      `A rate from ${values.fromCurrency} to itself translates nothing.`,
      'Choose two different currencies.',
    );
  }

  return withTenant(client, async (tx) => {
    await assertPrerequisites(tx, client);
    await assertCurrenciesExist(tx, values.fromCurrency, values.toCurrency);

    const [existing] = await tx
      .select()
      .from(exchangeRate)
      .where(and(
        eq(exchangeRate.client, client),
        eq(exchangeRate.rateType, values.rateType),
        eq(exchangeRate.fromCurrency, values.fromCurrency),
        eq(exchangeRate.toCurrency, values.toCurrency),
        eq(exchangeRate.validFrom, values.validFrom),
      ))
      .for('update');

    if (values.mode === 'CREATE' && existing) {
      throw new ExchangeRateError(
        `Exchange rate ${values.rateType} ${values.fromCurrency} → ${values.toCurrency} from ${values.validFrom} is already maintained.`,
        'Change the rate that exists, or choose another Valid From date.',
      );
    }
    if (values.mode === 'CHANGE' && !existing) {
      throw new ExchangeRateError(
        `Exchange rate ${values.rateType} ${values.fromCurrency} → ${values.toCurrency} from ${values.validFrom} is not maintained.`,
        'Create the rate first; a key cannot be changed into existence, because the key is the rate.',
      );
    }

    const result: ExchangeRateSaveResult = {
      changed: true,
      rateType: values.rateType,
      fromCurrency: values.fromCurrency,
      toCurrency: values.toCurrency,
      validFrom: values.validFrom,
      rate: values.rate,
      ratioFrom: values.ratioFrom,
      ratioTo: values.ratioTo,
    };

    if (values.mode === 'CREATE') {
      await tx.insert(exchangeRate).values({
        client,
        rateType: values.rateType,
        fromCurrency: values.fromCurrency,
        toCurrency: values.toCurrency,
        validFrom: values.validFrom,
        rate: values.rate,
        ratioFrom: values.ratioFrom,
        ratioTo: values.ratioTo,
        createdBy: changedBy,
      });
      await recordChange(tx, {
        client,
        objectClass: OBJECT_CLASS,
        objectKey: objectKeyOf(values),
        changeType: 'CREATE',
        changedBy,
        transactionCode: ACTIVITY,
        reason: values.reason,
        after: {
          rateType: values.rateType,
          fromCurrency: values.fromCurrency,
          toCurrency: values.toCurrency,
          validFrom: values.validFrom,
          rate: values.rate,
          ratioFrom: values.ratioFrom,
          ratioTo: values.ratioTo,
        },
        fieldLabels: {
          rateType: 'Exchange rate type',
          fromCurrency: 'From currency',
          toCurrency: 'To currency',
          validFrom: 'Valid from',
          rate: 'Rate',
          ratioFrom: 'Ratio (from)',
          ratioTo: 'Ratio (to)',
        },
        securityRelevantFields: ['rate'],
      });
      await markActivityComplete(tx, client, ACTIVITY, changedBy);
      return result;
    }

    // CHANGE: the rate the caller saw is the guard, the way OB37's variant is. The stored
    // rate comes back at the column's precision, so both sides are compared as numbers
    // through the database's own rendering rather than as strings nobody normalized.
    if (values.expectedRate === '' || Number(existing.rate) !== Number(values.expectedRate)) {
      throw new ExchangeRateError(
        `Exchange rate ${values.rateType} ${values.fromCurrency} → ${values.toCurrency} from ${values.validFrom} changed after it was opened.`,
        `It now stands at ${existing.rate}; reload the exchange rates before changing it.`,
      );
    }

    if (
      Number(existing.rate) === Number(values.rate)
      && existing.ratioFrom === values.ratioFrom
      && existing.ratioTo === values.ratioTo
    ) {
      await markActivityComplete(tx, client, ACTIVITY, changedBy);
      return { ...result, changed: false };
    }

    await tx
      .update(exchangeRate)
      .set({
        rate: values.rate,
        ratioFrom: values.ratioFrom,
        ratioTo: values.ratioTo,
        changedBy,
        changedAt: new Date(),
      })
      .where(and(
        eq(exchangeRate.client, client),
        eq(exchangeRate.rateType, values.rateType),
        eq(exchangeRate.fromCurrency, values.fromCurrency),
        eq(exchangeRate.toCurrency, values.toCurrency),
        eq(exchangeRate.validFrom, values.validFrom),
      ));

    await recordChange(tx, {
      client,
      objectClass: OBJECT_CLASS,
      objectKey: objectKeyOf(values),
      changeType: 'CHANGE',
      changedBy,
      transactionCode: ACTIVITY,
      reason: values.reason,
      before: { rate: existing.rate, ratioFrom: existing.ratioFrom, ratioTo: existing.ratioTo },
      after: { rate: values.rate, ratioFrom: values.ratioFrom, ratioTo: values.ratioTo },
      fieldLabels: {
        rate: 'Rate',
        ratioFrom: 'Ratio (from)',
        ratioTo: 'Ratio (to)',
      },
      securityRelevantFields: ['rate'],
    });
    await markActivityComplete(tx, client, ACTIVITY, changedBy);
    return result;
  });
}

/**
 * Delete an exchange rate. Posted documents keep the rate they were posted with, so a
 * deletion rewrites no history; it removes the rate from future lookups, and the change
 * document keeps what was removed and why.
 */
export async function deleteExchangeRate(raw: ExchangeRateDeleteInput): Promise<{ deleted: true }> {
  const parsed = exchangeRateDeleteInputSchema.safeParse(raw);
  if (!parsed.success) {
    throw new ExchangeRateError(
      parsed.error.issues[0]?.message ?? 'The exchange rate deletion is not valid.',
      'Correct the indicated value and submit again.',
    );
  }

  const { client, changedBy, ...values } = parsed.data;

  return withTenant(client, async (tx) => {
    await assertPrerequisites(tx, client);

    const [existing] = await tx
      .select()
      .from(exchangeRate)
      .where(and(
        eq(exchangeRate.client, client),
        eq(exchangeRate.rateType, values.rateType),
        eq(exchangeRate.fromCurrency, values.fromCurrency),
        eq(exchangeRate.toCurrency, values.toCurrency),
        eq(exchangeRate.validFrom, values.validFrom),
      ))
      .for('update');
    if (!existing) {
      throw new ExchangeRateError(
        `Exchange rate ${values.rateType} ${values.fromCurrency} → ${values.toCurrency} from ${values.validFrom} is not maintained.`,
        'Reload the exchange rates; the rate may already have been deleted.',
      );
    }

    await tx
      .delete(exchangeRate)
      .where(and(
        eq(exchangeRate.client, client),
        eq(exchangeRate.rateType, values.rateType),
        eq(exchangeRate.fromCurrency, values.fromCurrency),
        eq(exchangeRate.toCurrency, values.toCurrency),
        eq(exchangeRate.validFrom, values.validFrom),
      ));

    await recordChange(tx, {
      client,
      objectClass: OBJECT_CLASS,
      objectKey: objectKeyOf(values),
      changeType: 'DELETE',
      changedBy,
      transactionCode: ACTIVITY,
      reason: values.reason,
      before: {
        rate: existing.rate,
        ratioFrom: existing.ratioFrom,
        ratioTo: existing.ratioTo,
      },
      fieldLabels: {
        rate: 'Rate',
        ratioFrom: 'Ratio (from)',
        ratioTo: 'Ratio (to)',
      },
      securityRelevantFields: ['rate'],
    });
    await markActivityComplete(tx, client, ACTIVITY, changedBy);
    return { deleted: true as const };
  });
}
