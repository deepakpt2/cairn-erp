import { asc, eq } from 'drizzle-orm';

import { withTenant } from '../../platform/db/client';
import { companyCode, employeeToleranceGroup } from './schema';

/**
 * OBA4 Define Employee Tolerance Groups — the read side (SCR-039 stage 1).
 *
 * This activity differs from the define-screens beside it in one structural
 * way: nothing is delivered. There is no package set of tolerance groups —
 * a tenant that has never opened this screen has no ceilings at all, and
 * until journal posting learns to read these rows (later work, stated
 * openly on the screen), the configuration decides nothing at runtime.
 *
 * The contract the owner settled (R-88): the key is (company code, group),
 * and both parts may be blank as deliberate stored values — a blank company
 * code is the tenant-wide scope standing under every company code of the
 * tenant, and a blank group key is the default group of its scope, the
 * baseline for users with no explicit assignment. Where a company code is
 * named it must stand in the tenant. The limits are exact decimals; zero
 * in any of them is a stored meaning — that check imposes no ceiling —
 * and the line-item ceiling is judged against the document ceiling only
 * when both stand non-zero. Removal is deferred whole: groups become
 * deletable when user assignment exists to be checked, so this stage (and
 * the write stage behind it) offers create and change only.
 */
export const ACTIVITY = 'CFG.FIN.TOLERANCE.DEFINE';

export interface EmployeeToleranceGroupRow {
  /** '' = the tenant-wide scope standing under every company code. */
  companyCode: string;
  /** '' = the default group of its scope. */
  groupKey: string;
  maxDocumentAmount: string;
  maxLineAmount: string;
  maxCashDiscountPercent: string;
  paymentDiffRevenueAmount: string;
  paymentDiffExpenseAmount: string;
  paymentDiffRevenuePercent: string;
  paymentDiffExpensePercent: string;
}

export interface CompanyChoice {
  companyCode: string;
  name: string;
}

/** Every tolerance group the tenant holds, scope by scope, in key order. */
export async function listEmployeeToleranceGroups(client: string): Promise<EmployeeToleranceGroupRow[]> {
  return withTenant(client, async (tx) => {
    const rows = await tx
      .select()
      .from(employeeToleranceGroup)
      .where(eq(employeeToleranceGroup.client, client))
      .orderBy(asc(employeeToleranceGroup.companyCode), asc(employeeToleranceGroup.groupKey));

    return rows.map((row) => ({
      companyCode: row.companyCode,
      groupKey: row.groupKey,
      maxDocumentAmount: row.maxDocumentAmount,
      maxLineAmount: row.maxLineAmount,
      maxCashDiscountPercent: row.maxCashDiscountPercent,
      paymentDiffRevenueAmount: row.paymentDiffRevenueAmount,
      paymentDiffExpenseAmount: row.paymentDiffExpenseAmount,
      paymentDiffRevenuePercent: row.paymentDiffRevenuePercent,
      paymentDiffExpensePercent: row.paymentDiffExpensePercent,
    }));
  });
}

/**
 * The company codes the tenant has defined — the value help for the scope a
 * group belongs to, and (behind the blank scope) the list a named code is
 * judged against on write.
 */
export async function listToleranceCompanies(client: string): Promise<CompanyChoice[]> {
  return withTenant(client, async (tx) => {
    const rows = await tx
      .select({ companyCode: companyCode.companyCode, name: companyCode.name })
      .from(companyCode)
      .where(eq(companyCode.client, client))
      .orderBy(asc(companyCode.companyCode));
    return rows;
  });
}
