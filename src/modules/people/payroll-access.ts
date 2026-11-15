/**
 * Who may call a payroll service, judged by the service itself (payroll phase 5).
 *
 * Every payroll service takes a `PayrollAccess`, in one of two forms:
 *
 * - `{ authorization }` — a signed-in session, which is what every screen and action passes. The
 *   session is verified in the service's own transaction (`verifyServiceAuthorityInTx`): it must be
 *   live, hold one of the capabilities the service names, and carry the explicit Company Code scope
 *   the judged services require. Its restrictions decide which company codes it reaches.
 * - a capability list — the in-process form the people module has always used, for a trusted caller
 *   with no session (the demo provisioner, the service tests). It is judged for the capability only;
 *   it carries no Company Code restriction.
 *
 * Nothing at all is refused: a service called with no access names the capability it needs.
 */
import { hasCapability } from '../../platform/auth/session';
import { hasOrgAccess, type OrgRestriction } from '../../platform/auth/session';
import { type ServiceAuthorityContext, verifyServiceAuthorityInTx } from '../../platform/auth/service-authority';
import type { Tx } from '../../platform/db/client';

export type PayrollAccess = readonly string[] | { authorization: ServiceAuthorityContext | undefined };

export interface PayrollGrant {
  /** The session's restrictions, or null for a trusted in-process caller (no Company Code limit). */
  restrictions: OrgRestriction[] | null;
}

export type Refuse = (code: string, message: string, remedy?: string) => never;

/**
 * Judge the caller for any one of `capabilities`. Refuses (through the service's own `refuse`, so
 * the error class and code are the service's) when the caller holds none of them.
 */
export async function judgePayrollAccess(
  tx: Tx,
  client: string,
  access: PayrollAccess | undefined,
  capabilities: readonly string[],
  refuse: Refuse,
  code = 'PAYROLL_AUTHORITY',
): Promise<PayrollGrant> {
  const named = capabilities.join(' or ');
  if (access === undefined) {
    refuse(code, `This payroll service needs a signed-in user holding ${named}.`, `Sign in and ask an administrator for ${named}.`);
  }
  if (Array.isArray(access)) {
    if (!capabilities.some((c) => hasCapability([...access], c))) {
      refuse(code, `You do not hold ${named}.`, `Ask an administrator for ${named}. Payroll authority is granted to no role by default.`);
    }
    return { restrictions: null };
  }
  const { authorization } = access as { authorization: ServiceAuthorityContext | undefined };
  let first: { message: string; remedy: string } | null = null;
  for (const capability of capabilities) {
    const verdict = await verifyServiceAuthorityInTx(tx, client, authorization, capability, { requirePlantScope: false });
    if (verdict.ok) return { restrictions: verdict.restrictions };
    first ??= verdict.refusal;
  }
  if (first!.message.startsWith('You do not hold the authority')) {
    refuse(code, `You do not hold ${named}.`, `Ask an administrator for ${named}. Payroll authority is granted to no role by default.`);
  }
  refuse(code, `${first!.message} This payroll service needs ${named}.`, first!.remedy);
}

/** Does the grant reach this company code? A trusted in-process caller reaches every one. */
export function reachesCompany(grant: PayrollGrant, companyCode: string): boolean {
  return grant.restrictions === null || hasOrgAccess(grant.restrictions, 'COMPANY_CODE', companyCode);
}

/** Refuse when the grant does not reach the company code, naming it. */
export function assertCompanyScope(grant: PayrollGrant, companyCode: string, refuse: Refuse): void {
  if (!reachesCompany(grant, companyCode)) {
    refuse(
      'COMPANY_SCOPE',
      `Your Company Code scope does not cover company code ${companyCode}.`,
      'Ask an administrator to extend your Company Code scope, then repeat the action.',
    );
  }
}
