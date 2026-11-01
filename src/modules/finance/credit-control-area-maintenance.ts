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
import {
  hasCapability,
  hasOrgAccess,
  loadCapabilities,
  loadOrgRestrictions,
  type OrgRestriction,
} from '@/platform/auth/session';
import { CREDIT_CONTROL_AREA_CAPABILITY } from '@/platform/auth/capability-policy';
import { withTenant, type Tx } from '@/platform/db/client';
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
  authorization: z.object({
    userId: z.string().trim().min(1).max(36),
    sessionId: z.string().trim().min(1).max(36),
  }).strict(),
}).strict();

export type CreditControlAreaSetupInput = z.input<typeof inputSchema>;
export type CreditControlAreaSetupValues = z.output<typeof creditControlAreaSetupValuesSchema>;

/** Hide companies and their mapped CCAs outside a user's separate Company Code scopes. */
export function filterCreditControlAreaSetupByCompanyScope(
  data: Awaited<ReturnType<typeof listCreditControlAreaSetup>>,
  restrictions: readonly OrgRestriction[],
) {
  if (restrictions.length === 0) return data;
  const companies = data.companies.filter((company) =>
    hasOrgAccess(restrictions, 'COMPANY_CODE', company.companyCode));
  const visibleAreas = new Set(companies
    .map((company) => company.creditControlArea)
    .filter((area): area is string => area !== null));
  return {
    areas: data.areas.filter((area) => visibleAreas.has(area.creditControlArea)),
    companies,
    availableCompanies: data.availableCompanies.filter((company) =>
      hasOrgAccess(restrictions, 'COMPANY_CODE', company.companyCode)),
  };
}

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

async function requireSetupAuthority(
  tx: Tx,
  client: string,
  authorization: CreditControlAreaSetupInput['authorization'],
  requestedCompanyCode: string,
): Promise<string> {
  const sessions = await tx.execute(sql`
    select u.username
      from user_session s
      join app_user u on u.client = s.client and u.id = s.user_id
     where s.client = ${client}
       and s.id = ${authorization.sessionId}
       and s.user_id = ${authorization.userId}
       and s.revoked_at is null
       and s.expires_at > now()
       and u.is_active = true
       and u.is_locked = false
     for share of s, u
  `) as unknown as Array<{ username: string }>;
  const actor = sessions[0];
  if (!actor) {
    throw new CreditControlAreaMaintenanceError(
      'A live, active user session is required for credit control area maintenance.',
      'Sign in again and retry through the protected setup screen.',
    );
  }

  // Hold the authority rows to commit so role/capability revocation cannot race the write.
  await tx.execute(sql`
    select ur.role_code, rc.capability_code
      from user_role ur
      join role r on r.client = ur.client and r.code = ur.role_code and r.is_active = true
      join role_capability rc on rc.client = ur.client and rc.role_code = ur.role_code
     where ur.client = ${client}
       and ur.user_id = ${authorization.userId}
       and ur.valid_from <= now()
       and (ur.valid_to is null or ur.valid_to >= now())
     for share of ur, r, rc
  `);
  const capabilities = await loadCapabilities(tx, client, authorization.userId);
  if (!hasCapability(capabilities, CREDIT_CONTROL_AREA_CAPABILITY)) {
    throw new CreditControlAreaMaintenanceError(
      `This session lacks the exact authority ${CREDIT_CONTROL_AREA_CAPABILITY}.`,
      'Ask a role administrator for the exact registered capability; wildcard role patterns do not grant it.',
    );
  }

  // A scoped finance-master-data account must carry an explicit Company Code scope.
  // Lock existing rows through commit so scope revocation cannot race the assignment.
  await tx.execute(sql`
    select id from auth_org_restriction
     where client = ${client} and user_id = ${authorization.userId}
     for share
  `);
  const restrictions = await loadOrgRestrictions(tx, client, authorization.userId);
  const hasExplicitCompanyScope = restrictions.some(
    (restriction) => restriction.scopeType === 'COMPANY_CODE' && restriction.scopeValue.trim().length > 0,
  );
  if (!hasExplicitCompanyScope || !hasOrgAccess(restrictions, 'COMPANY_CODE', requestedCompanyCode)) {
    throw new CreditControlAreaMaintenanceError(
      `This account lacks an explicit Company Code scope for ${requestedCompanyCode}.`,
      'Assign the account only its approved Company Code scope through the supported user-access workflow, then retry.',
    );
  }
  return actor.username;
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

  const { client, authorization, reason, ...values } = parsed.data;
  return withTenant(client, async (tx) => {
    const changedBy = await requireSetupAuthority(tx, client, authorization, values.companyCode);

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
