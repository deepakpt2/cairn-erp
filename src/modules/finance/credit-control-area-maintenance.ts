/**
 * Capability-protected entry point for first-time credit-control setup.
 *
 * This workflow may create an area and make an initial Company Code assignment. It never edits an
 * existing area's financial attributes, replaces a Company Code mapping, or deactivates a record.
 * Reads and writes are tenant-scoped; the area and mapping plus both audit records commit together.
 */
import { and, asc, eq, isNull, sql } from 'drizzle-orm';
import { z } from 'zod';

import { recordChange } from '@/platform/change';
import { CREDIT_CONTROL_AREA_ACTIVITY } from '@/modules/finance/credit-control-area-contract';
import { withTenant } from '@/platform/db/client';
import { markActivityComplete } from '@/platform/tenancy';
import { currency as currencyReference } from '@/platform/tables/reference';
import { companyCode, creditControlArea } from '@/modules/foundation/schema';

export { CREDIT_CONTROL_AREA_CAPABILITY } from '@/platform/auth/capability-policy';
export { CREDIT_CONTROL_AREA_ACTIVITY, CREDIT_CONTROL_AREA_DEFAULTS } from '@/modules/finance/credit-control-area-contract';

export const creditControlAreaSetupValuesSchema = z.object({
  creditControlArea: z.string().trim().regex(/^[A-Za-z0-9]{4}$/, 'Use a four-character credit control area code.')
    .transform((value) => value.toUpperCase()),
  name: z.string().trim().min(1, 'Enter a name.').max(160, 'The name must be 160 characters or fewer.'),
  companyCode: z.string().trim().min(1).max(10).transform((value) => value.toUpperCase()),
  warningThresholdPercent: z.number().int().min(0).max(100),
  reason: z.string().trim().min(3, 'Give a short reason for the setup.').max(500),
}).strict();

const inputSchema = creditControlAreaSetupValuesSchema.extend({
  client: z.string().regex(/^[A-Za-z0-9]{2,4}$/),
  changedBy: z.string().trim().min(1).max(60),
}).strict();

export type CreditControlAreaSetupInput = z.input<typeof inputSchema>;
export type CreditControlAreaSetupValues = z.output<typeof creditControlAreaSetupValuesSchema>;

export class CreditControlAreaMaintenanceError extends Error {
  readonly code = 'CAIRN_CCA_SETUP';
  constructor(message: string, readonly remedy = 'Review the credit control area and Company Code, then try again.') {
    super(message);
    this.name = 'CreditControlAreaMaintenanceError';
  }
}

/** A safe tenant-scoped read model for the setup screen. */
export async function listCreditControlAreaSetup(client: string) {
  return withTenant(client, async (tx) => {
    const [areas, companies] = await Promise.all([
      tx.select({
        creditControlArea: creditControlArea.creditControlArea,
        name: creditControlArea.name,
        currency: creditControlArea.currency,
        warningThresholdPercent: creditControlArea.warningThresholdPercent,
        isActive: creditControlArea.isActive,
      }).from(creditControlArea).where(eq(creditControlArea.client, client)).orderBy(asc(creditControlArea.creditControlArea)),
      tx.select({
        companyCode: companyCode.companyCode,
        name: companyCode.name,
        currency: companyCode.currency,
        creditControlArea: companyCode.creditControlArea,
        isActive: companyCode.isActive,
      }).from(companyCode).where(eq(companyCode.client, client)).orderBy(asc(companyCode.companyCode)),
    ]);
    return {
      areas,
      companies,
      availableCompanies: companies.filter((company) => company.isActive && company.creditControlArea === null),
    };
  });
}

/**
 * Create the CCA if it is new, then make its first Company Code assignment.
 * Existing CCA data is never changed, and a Company Code already assigned elsewhere is never reassigned.
 * Exact retries are idempotent and do not create duplicate change documents.
 */
export async function createCreditControlAreaSetup(raw: CreditControlAreaSetupInput) {
  const parsed = inputSchema.safeParse(raw);
  if (!parsed.success) {
    throw new CreditControlAreaMaintenanceError(
      parsed.error.issues[0]?.message ?? 'The credit control area setup is invalid.',
      'Correct the indicated value and submit the setup again.',
    );
  }

  const { client, changedBy, reason, ...values } = parsed.data;
  return withTenant(client, async (tx) => {
    // Stable lock order prevents two overlapping area/company setup requests from deadlocking.
    const lockKeys = [
      `${client}/credit_control_area/${values.creditControlArea}`,
      `${client}/company_code_credit_area/${values.companyCode}`,
    ].sort();
    for (const lockKey of lockKeys) {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))`);
    }

    const [company] = await tx.select({
      companyCode: companyCode.companyCode,
      currency: companyCode.currency,
      creditControlArea: companyCode.creditControlArea,
      isActive: companyCode.isActive,
    }).from(companyCode).where(and(
      eq(companyCode.client, client),
      eq(companyCode.companyCode, values.companyCode),
    )).for('update');

    if (!company) {
      throw new CreditControlAreaMaintenanceError(
        `Company Code ${values.companyCode} does not exist in this tenant.`,
        'Choose an existing Company Code from this tenant.',
      );
    }
    if (!company.isActive) {
      throw new CreditControlAreaMaintenanceError(
        `Company Code ${values.companyCode} is inactive.`,
        'Activate the Company Code through its supported maintenance workflow before assigning credit control.',
      );
    }

    const [area] = await tx.select({
      creditControlArea: creditControlArea.creditControlArea,
      name: creditControlArea.name,
      currency: creditControlArea.currency,
      warningThresholdPercent: creditControlArea.warningThresholdPercent,
      isActive: creditControlArea.isActive,
    }).from(creditControlArea).where(and(
      eq(creditControlArea.client, client),
      eq(creditControlArea.creditControlArea, values.creditControlArea),
    )).for('update');

    if (company.creditControlArea && company.creditControlArea !== values.creditControlArea) {
      throw new CreditControlAreaMaintenanceError(
        `Company Code ${values.companyCode} is already assigned to credit control area ${company.creditControlArea}.`,
        'This setup activity does not replace an existing Company Code assignment.',
      );
    }
    if (company.creditControlArea === values.creditControlArea && !area) {
      throw new CreditControlAreaMaintenanceError(
        `Company Code ${values.companyCode} points to missing credit control area ${values.creditControlArea}.`,
        'Do not repair a financial assignment through this create path; request a separately reviewed recovery procedure.',
      );
    }

    let created = false;
    if (area) {
      const matches = area.name === values.name
        && area.currency === company.currency
        && area.warningThresholdPercent === values.warningThresholdPercent
        && area.isActive;
      if (!matches) {
        throw new CreditControlAreaMaintenanceError(
          `Credit control area ${values.creditControlArea} already exists with different or inactive settings.`,
          'This workflow never edits an existing area. Review its current financial configuration and request a separate approved change path.',
        );
      }
    } else {
      if (company.creditControlArea !== null) {
        throw new CreditControlAreaMaintenanceError(
          `Company Code ${values.companyCode} already has a credit control assignment.`,
          'This setup activity only makes an initial assignment.',
        );
      }
      const [currency] = await tx.select({ code: currencyReference.code })
        .from(currencyReference)
        .where(and(
          eq(currencyReference.code, company.currency),
          eq(currencyReference.isActive, true),
        )).limit(1);
      if (!currency) {
        throw new CreditControlAreaMaintenanceError(
          `Company Code ${values.companyCode} uses currency ${company.currency}, which is not active in the reference catalogue.`,
          'Resolve the currency reference through the supported reference-data process before defining a credit control area.',
        );
      }

      await tx.insert(creditControlArea).values({
        client,
        creditControlArea: values.creditControlArea,
        name: values.name,
        currency: company.currency,
        warningThresholdPercent: values.warningThresholdPercent,
        isActive: true,
        createdBy: changedBy,
      });
      await recordChange(tx, {
        client,
        objectClass: 'credit_control_area',
        objectKey: values.creditControlArea,
        changeType: 'CREATE',
        changedBy,
        reason,
        transactionCode: CREDIT_CONTROL_AREA_ACTIVITY,
        after: {
          creditControlArea: values.creditControlArea,
          name: values.name,
          currency: company.currency,
          warningThresholdPercent: values.warningThresholdPercent,
          isActive: true,
        },
        securityRelevantFields: ['currency', 'warningThresholdPercent', 'isActive'],
      });
      created = true;
    }

    let assigned = false;
    if (company.creditControlArea === null) {
      const updated = await tx.update(companyCode).set({
        creditControlArea: values.creditControlArea,
        changedBy,
        changedAt: new Date(),
      }).where(and(
        eq(companyCode.client, client),
        eq(companyCode.companyCode, values.companyCode),
        isNull(companyCode.creditControlArea),
        eq(companyCode.isActive, true),
      )).returning({ companyCode: companyCode.companyCode });
      if (!updated.length) {
        throw new CreditControlAreaMaintenanceError(
          `Company Code ${values.companyCode} changed while the setup was being saved.`,
          'Reload the current Company Code assignment and retry only if it is still unassigned.',
        );
      }
      await recordChange(tx, {
        client,
        objectClass: 'company_code',
        objectKey: values.companyCode,
        changeType: 'CHANGE',
        changedBy,
        reason,
        transactionCode: CREDIT_CONTROL_AREA_ACTIVITY,
        before: { creditControlArea: null },
        after: { creditControlArea: values.creditControlArea },
        securityRelevantFields: ['creditControlArea'],
      });
      assigned = true;
    }

    await markActivityComplete(tx, client, CREDIT_CONTROL_AREA_ACTIVITY, changedBy);
    return {
      creditControlArea: values.creditControlArea,
      companyCode: values.companyCode,
      currency: company.currency,
      created,
      assigned,
      unchanged: !created && !assigned,
    };
  });
}
