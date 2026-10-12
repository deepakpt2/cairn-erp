/** Create-only Company Code definition — assignments remain separate under CAIRN.md §6.2. */
import { z } from 'zod';
import { and, eq, sql } from 'drizzle-orm';
import { withTenant } from '../../platform/db/client';
import { recordChange } from '../../platform/change';
import { markActivityComplete } from '../../platform/tenancy';
import { country as countryReference, currency as currencyReference } from '../../platform/tables/reference';
import { companyCode } from './schema';

/** Definition fields only: CoA/FYV/PPV are intentionally not accepted here. */
export const companyCodeDefinitionValuesSchema = z.object({
  companyCode: z.string().trim().min(1).max(10),
  name: z.string().trim().min(1).max(160),
  country: z.string().trim().regex(/^[A-Za-z]{2}$/).transform((value) => value.toUpperCase()),
  currency: z.string().trim().regex(/^[A-Za-z]{3}$/).transform((value) => value.toUpperCase()),
  city: z.string().trim().max(80).optional().transform((value) => value || undefined),
  taxRegistrationNumber: z.string().trim().max(40).optional().transform((value) => value || undefined),
});

export const companyCodeDefinitionInputSchema = companyCodeDefinitionValuesSchema.extend({
  client: z.string().regex(/^[A-Za-z0-9]{2,4}$/),
  changedBy: z.string().trim().min(1).max(60),
}).strict();

export type CompanyCodeDefinitionValues = z.output<typeof companyCodeDefinitionValuesSchema>;
export type CompanyCodeDefinitionInput = z.input<typeof companyCodeDefinitionInputSchema>;

export class CompanyCodeDefinitionError extends Error {
  readonly code = 'CAIRN_CONFIG';
  constructor(message: string, readonly remedy = 'Review the Company Code definition and try again.') {
    super(message);
    this.name = 'CompanyCodeDefinitionError';
  }
}

/** Defines one Company Code; duplicate codes are refused, never updated or assigned here. */
export async function defineCompanyCode(raw: CompanyCodeDefinitionInput) {
  const parsed = companyCodeDefinitionInputSchema.safeParse(raw);
  if (!parsed.success) {
    throw new CompanyCodeDefinitionError(
      parsed.error.issues[0]?.message ?? 'Company Code definition is invalid.',
      'Correct the indicated value and submit the definition again.',
    );
  }

  const { client, changedBy, ...values } = parsed.data;
  return withTenant(client, async (tx) => {
    // Serialize duplicate attempts for one tenant/code; this path never updates a row.
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${`${client}/company_code/${values.companyCode}`}, 0))`,
    );

    const [existing] = await tx
      .select({ companyCode: companyCode.companyCode })
      .from(companyCode)
      .where(and(eq(companyCode.client, client), eq(companyCode.companyCode, values.companyCode)))
      .limit(1);
    if (existing) {
      throw new CompanyCodeDefinitionError(
        `Company code ${values.companyCode} already exists.`,
        'Choose an unused code. The define action never changes an existing Company Code or its assignments.',
      );
    }

    const [country] = await tx
      .select({ code: countryReference.code })
      .from(countryReference)
      .where(eq(countryReference.code, values.country))
      .limit(1);
    if (!country) {
      throw new CompanyCodeDefinitionError(
        `Country ${values.country} is not in the reference catalogue.`,
        'Choose a supported country from the country reference list.',
      );
    }

    const [currency] = await tx
      .select({ code: currencyReference.code })
      .from(currencyReference)
      .where(and(eq(currencyReference.code, values.currency), eq(currencyReference.isActive, true)))
      .limit(1);
    if (!currency) {
      throw new CompanyCodeDefinitionError(
        `Currency ${values.currency} is not active in the reference catalogue.`,
        'Choose an active currency from the currency reference list.',
      );
    }

    await tx.insert(companyCode).values({
      client,
      companyCode: values.companyCode,
      name: values.name,
      chartOfAccounts: null,
      fiscalYearVariant: null,
      postingPeriodVariant: null,
      country: values.country,
      currency: values.currency,
      city: values.city,
      taxRegistrationNumber: values.taxRegistrationNumber,
      createdBy: changedBy,
    });

    await recordChange(tx, {
      client,
      objectClass: 'company_code',
      objectKey: values.companyCode,
      changeType: 'CREATE',
      changedBy,
      transactionCode: 'CFG.ORG.COMPANYCODE.DEFINE',
      after: {
        companyCode: values.companyCode,
        name: values.name,
        country: values.country,
        currency: values.currency,
        city: values.city,
        taxRegistrationNumber: values.taxRegistrationNumber,
      },
      securityRelevantFields: ['country', 'currency'],
    });
    await markActivityComplete(tx, client, 'CFG.ORG.COMPANYCODE.DEFINE', changedBy);
    return { created: true as const, companyCode: values.companyCode };
  });
}
