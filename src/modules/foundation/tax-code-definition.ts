import { asc, count, eq } from 'drizzle-orm';

import { withTenant } from '../../platform/db/client';
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
