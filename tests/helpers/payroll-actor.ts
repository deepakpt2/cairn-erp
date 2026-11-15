/**
 * Payroll phase 1 fixtures: the authority the structure services ask for, and the ground a
 * readiness check stands on — a cost centre, an org unit and a position, pay components mapped to
 * the tenant's chart, and employees placed in the position.
 *
 * The people services take the caller's capability list (the pattern `pay-components.ts` and
 * `org-structure.ts` already use), so the "actor" here is that list and the name it writes as.
 * Everything is built through the product's own services where one exists; pay components and
 * their mappings are inserted directly, as `people-pay-components.test.ts` does, because the
 * mapping service needs a full G/L account master this suite does not care about.
 */
import { sql } from 'drizzle-orm';

import { withTenant } from '../../src/platform/db/client';
import { ASSIGNMENT_CAPABILITY, assignPosition, delimitAssignment } from '../../src/modules/people/assignment';
import { EMPLOYEE_CAPABILITY, createEmployee } from '../../src/modules/people/employee-master';
import {
  ORG_UNIT_CAPABILITY,
  POSITION_CAPABILITY,
  defineOrgUnit,
  definePosition,
} from '../../src/modules/people/org-structure';
import { SALARY_STRUCTURE_CAPABILITY } from '../../src/modules/people/payroll-structure';

export const PAYROLL_ACTOR = 'PAYROLL_TEST';
/** What the structure services are handed by a caller allowed to define and assign. */
export const PAYROLL_AUTH: readonly string[] = [SALARY_STRUCTURE_CAPABILITY];
/** A caller who may do everything people-side except payroll. */
export const NO_PAYROLL_AUTH: readonly string[] = ['PEOPLE.EMPLOYEE.CREATE', 'PEOPLE.TIME.ENTER'];

export const AREA = 'A000';
export const CENTRE = 'CC100';
/** A cost centre that only stands from 2032: an assignment to it has no standing centre today. */
export const CENTRE_LATER = 'CC300';

export interface PayrollFixture {
  client: string;
  companyCode: string;
  chart: string;
  currency: string;
  positionCode: string;
  /** EARNING, mapped. */
  basic: string;
  /** EARNING, mapped, charges the employee's own cost centre (ASSIGNMENT). */
  housing: string;
  /** DEDUCTION, never mapped — for the unmapped refusal. */
  unmapped: string;
}

let counter = 0;
const next = () => String(++counter).padStart(3, '0');

export async function buildPayrollFixture(client: string, companyCode: string): Promise<PayrollFixture> {
  const { chart, currency } = await withTenant(client, async (tx) => {
    const rows = (await tx.execute(sql`
      select chart_of_accounts, currency from company_code where client = ${client} and company_code = ${companyCode}
    `)) as unknown as Array<{ chart_of_accounts: string; currency: string }>;
    return { chart: String(rows[0]!.chart_of_accounts), currency: String(rows[0]!.currency).trim() };
  });

  await withTenant(client, async (tx) => {
    await tx.execute(sql`
      insert into cost_center (client, controlling_area, cost_center, valid_from, valid_to, name, category, company_code, is_posting_locked, created_by)
      values (${client}, ${AREA}, ${CENTRE}, '2020-01-01', '9999-12-31', 'Payroll test centre', 'PRODUCTION', ${companyCode}, false, ${PAYROLL_ACTOR}),
             (${client}, ${AREA}, ${CENTRE_LATER}, '2032-01-01', '9999-12-31', 'Future centre', 'PRODUCTION', ${companyCode}, false, ${PAYROLL_ACTOR})
      on conflict do nothing`);
    await tx.execute(sql`
      insert into pay_component (client, code, name, component_kind, affects_net_pay, is_valid, created_by) values
        (${client}, 'BASIC', 'Basic pay', 'EARNING', true, true, ${PAYROLL_ACTOR}),
        (${client}, 'HOUSING', 'Housing allowance', 'EARNING', true, true, ${PAYROLL_ACTOR}),
        (${client}, 'LOAN', 'Loan recovery', 'DEDUCTION', true, true, ${PAYROLL_ACTOR})
      on conflict do nothing`);
    // Mapped to whatever expense/liability accounts the chart holds: the readiness check asks only
    // that a mapping stands, not what it says.
    await tx.execute(sql`
      insert into pay_component_config (client, component_code, chart_of_accounts, debit_account, credit_account, cost_receiver_category, created_by)
      values (${client}, 'BASIC', ${chart}, '500000', null, 'NONE', ${PAYROLL_ACTOR}),
             (${client}, 'HOUSING', ${chart}, '500000', null, 'ASSIGNMENT', ${PAYROLL_ACTOR})
      on conflict do nothing`);
  });

  const unitCode = `PU${next()}`;
  const positionCode = `PP${next()}`;
  await defineOrgUnit({ client, code: unitCode, name: `Payroll unit ${unitCode}`, changedBy: PAYROLL_ACTOR }, [ORG_UNIT_CAPABILITY]);
  await definePosition({ client, code: positionCode, title: `Payroll position ${positionCode}`, orgUnitCode: unitCode, changedBy: PAYROLL_ACTOR }, [POSITION_CAPABILITY]);

  return { client, companyCode, chart, currency, positionCode, basic: 'BASIC', housing: 'HOUSING', unmapped: 'LOAN' };
}

let personCounter = 0;

/** A new employee; placed in the fixture position from `positionFrom` (to `positionTo`) unless null. */
export async function payrollEmployee(
  fx: PayrollFixture,
  options: { positionFrom?: string | null; positionTo?: string; costCenter?: string } = {},
): Promise<string> {
  const personnelNumber = `P${String(9700000 + ++personCounter)}${String(Date.now()).slice(-4)}`.slice(0, 20);
  await createEmployee(
    { client: fx.client, personnelNumber, fullName: `Payroll Test ${personnelNumber}`, changedBy: PAYROLL_ACTOR, requestKey: `payroll-emp-${personnelNumber}` },
    [EMPLOYEE_CAPABILITY],
  );
  const from = options.positionFrom === undefined ? '2024-01-01' : options.positionFrom;
  if (from !== null) {
    await assignPosition(
      {
        client: fx.client,
        personnelNumber,
        positionCode: fx.positionCode,
        controllingArea: AREA,
        costCenter: options.costCenter ?? CENTRE,
        validFrom: from,
        changedBy: PAYROLL_ACTOR,
      },
      [ASSIGNMENT_CAPABILITY],
    );
    if (options.positionTo) {
      await delimitAssignment(
        { client: fx.client, personnelNumber, validFrom: from, validTo: options.positionTo, changedBy: PAYROLL_ACTOR },
        [ASSIGNMENT_CAPABILITY],
      );
    }
  }
  return personnelNumber;
}

/**
 * Payroll phase 3: a signed-in actor that may post payroll. Posting asks for `PEOPLE.PAYROLL.POST`
 * (the payroll service) and `FIN.JOURNAL.POST` (the G/L posting it rides on), and Company Code reach —
 * the shape `finance-actor.ts` builds. Pass `capabilities` to prove a refusal.
 */
export const PAYROLL_POSTER_CAPABILITIES: readonly string[] = ['PEOPLE.PAYROLL.POST', 'FIN.JOURNAL.POST'];

export async function createPayrollPoster(
  client: string,
  options: { capabilities?: readonly string[]; companyScopes?: readonly string[] } = {},
) {
  const { createFinanceActor } = await import('./finance-actor');
  return createFinanceActor(client, { capabilities: options.capabilities ?? PAYROLL_POSTER_CAPABILITIES, companyScopes: options.companyScopes });
}
