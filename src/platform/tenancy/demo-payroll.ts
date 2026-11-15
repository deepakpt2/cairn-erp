/**
 * Demo phase D7_PAYROLL — payroll phase 1: everything a run will stand on, and nothing calculated.
 *
 * Pay components mapped to the payroll accounts the standard chart already carries (500000 salaries,
 * 500100 employer contributions, 500200 end-of-service expense, 240000 EOS provision, 250000
 * deductions payable), time types including an unpaid leave, two salary structures, and an
 * assignment for every demo employee but one. The one left out — the controller, Walid Farouk — is
 * there on purpose: his employee screen shows the readiness check naming why a run could not include
 * him.
 *
 * EOSPROV is defined and mapped but named by no structure: a payroll run does not calculate
 * end-of-service provisions in v1 and refuses a structure that names one.
 *
 * The amounts and rates are demonstration values chosen for a fictional company. They are not a
 * statute, a tax table or a social-insurance rate (DV-001): nothing statutory ships.
 *
 * Everything goes through the product's services with the administrator's authority, and is
 * idempotent by adoption: a component, mapping, time type or structure that already stands is
 * left alone, and assignments carry a request key (`DEMO-SAL-*`).
 */
import { and, eq } from 'drizzle-orm';

import { withTenant } from '../../platform/db/client';
import {
  definePayComponent,
  savePayComponentMapping,
} from '../../modules/people/pay-components';
import {
  assignStructure,
  defineSalaryStructure,
  getStructure,
  listStructures,
  setStructureComponent,
} from '../../modules/people/payroll-structure';
import { defineTimeType } from '../../modules/people/time-leave';
import { payComponent, payComponentConfig, timeType } from '../../modules/people/schema';
import { DEMO_ACTOR, DEMO_IDENTITY } from './demo-organisation';
import type { DemoTimeline } from './demo-provisioning';

const AUTHORITY = ['*'] as const;
const CHART = 'CA01';

const COMPONENTS = [
  { code: 'BASIC', name: 'Basic salary', kind: 'EARNING', debit: '500000', credit: null, receiver: 'ASSIGNMENT' },
  { code: 'HOUSING', name: 'Housing allowance', kind: 'EARNING', debit: '500000', credit: null, receiver: 'ASSIGNMENT' },
  { code: 'TRANSPORT', name: 'Transport allowance', kind: 'EARNING', debit: '500000', credit: null, receiver: 'ASSIGNMENT' },
  { code: 'PENSION', name: 'Employee pension contribution', kind: 'DEDUCTION', debit: null, credit: '250000', receiver: 'NONE' },
  { code: 'ERCONTRIB', name: 'Employer contribution', kind: 'EMPLOYER_CONTRIBUTION', debit: '500100', credit: '250000', receiver: 'ASSIGNMENT' },
  { code: 'EOSPROV', name: 'End of service provision', kind: 'EOS_PROVISION', debit: '500200', credit: '240000', receiver: 'ASSIGNMENT' },
] as const;

const TIME_TYPES = [
  { code: 'ANNUAL', name: 'Annual leave', reducesQuota: true, isPaid: true },
  { code: 'SICK', name: 'Sick leave', reducesQuota: false, isPaid: true },
  { code: 'UNPAID', name: 'Leave without pay', reducesQuota: false, isPaid: false },
] as const;

type Rule = { component: string; kind: 'FIXED' | 'PERCENT_OF_BASE'; value: string };

const STRUCTURES: ReadonlyArray<{ code: string; name: string; rules: Rule[] }> = [
  {
    code: 'STAFF',
    name: 'Staff',
    rules: [
      { component: 'BASIC', kind: 'PERCENT_OF_BASE', value: '100' },
      { component: 'HOUSING', kind: 'PERCENT_OF_BASE', value: '25' },
      { component: 'TRANSPORT', kind: 'FIXED', value: '40' },
      { component: 'PENSION', kind: 'PERCENT_OF_BASE', value: '5' },
      { component: 'ERCONTRIB', kind: 'PERCENT_OF_BASE', value: '11' },
    ],
  },
  {
    code: 'MGMT',
    name: 'Management',
    rules: [
      { component: 'BASIC', kind: 'PERCENT_OF_BASE', value: '100' },
      { component: 'HOUSING', kind: 'PERCENT_OF_BASE', value: '30' },
      { component: 'TRANSPORT', kind: 'FIXED', value: '120' },
      { component: 'PENSION', kind: 'PERCENT_OF_BASE', value: '5' },
      { component: 'ERCONTRIB', kind: 'PERCENT_OF_BASE', value: '11' },
    ],
  },
];

/** Who is on which structure, and their base (KWD). 10000016 is deliberately absent. */
const ASSIGNMENTS: ReadonlyArray<{ personnelNumber: string; structure: string; base: string }> = [
  { personnelNumber: '10000001', structure: 'MGMT', base: '4200' },
  { personnelNumber: '10000002', structure: 'MGMT', base: '3100' },
  { personnelNumber: '10000003', structure: 'MGMT', base: '2600' },
  { personnelNumber: '10000004', structure: 'STAFF', base: '950' },
  { personnelNumber: '10000005', structure: 'STAFF', base: '1150' },
  { personnelNumber: '10000006', structure: 'MGMT', base: '2400' },
  { personnelNumber: '10000007', structure: 'STAFF', base: '780' },
  { personnelNumber: '10000008', structure: 'STAFF', base: '760' },
  { personnelNumber: '10000009', structure: 'STAFF', base: '1050' },
  { personnelNumber: '10000010', structure: 'MGMT', base: '2700' },
  { personnelNumber: '10000011', structure: 'STAFF', base: '1200' },
  { personnelNumber: '10000012', structure: 'MGMT', base: '2800' },
  { personnelNumber: '10000013', structure: 'STAFF', base: '980' },
  { personnelNumber: '10000014', structure: 'MGMT', base: '3000' },
  { personnelNumber: '10000015', structure: 'STAFF', base: '1300' },
];

/** The employee left without a structure, so the readiness check has something to name. */
export const DEMO_PAYROLL_UNASSIGNED = '10000016';

export interface DemoPayrollResult {
  components: number;
  mappings: number;
  timeTypes: number;
  structures: number;
  assignments: number;
}

export async function buildDemoPayroll(input: { client?: string; timeline: DemoTimeline }): Promise<DemoPayrollResult> {
  const client = input.client ?? DEMO_IDENTITY.clientKey;
  const from = input.timeline.startDate;

  const standing = await withTenant(client, async (tx) => ({
    components: new Set((await tx.select({ code: payComponent.code }).from(payComponent).where(eq(payComponent.client, client))).map((r) => r.code)),
    mappings: new Set((await tx.select({ code: payComponentConfig.componentCode }).from(payComponentConfig)
      .where(and(eq(payComponentConfig.client, client), eq(payComponentConfig.chartOfAccounts, CHART)))).map((r) => r.code)),
    timeTypes: new Set((await tx.select({ code: timeType.code }).from(timeType).where(eq(timeType.client, client))).map((r) => r.code)),
  }));

  for (const c of COMPONENTS) {
    if (!standing.components.has(c.code)) {
      await definePayComponent({ client, code: c.code, name: c.name, componentKind: c.kind, changedBy: DEMO_ACTOR }, AUTHORITY);
    }
    if (!standing.mappings.has(c.code)) {
      await savePayComponentMapping({
        client, componentCode: c.code, chartOfAccounts: CHART,
        debitAccount: c.debit, creditAccount: c.credit, costReceiverCategory: c.receiver, changedBy: DEMO_ACTOR,
      }, 'CREATE', AUTHORITY);
    }
  }

  for (const tt of TIME_TYPES) {
    if (standing.timeTypes.has(tt.code)) continue;
    await defineTimeType({
      client, code: tt.code, name: tt.name, typeKind: 'ABSENCE', reducesQuota: tt.reducesQuota, isPaid: tt.isPaid, changedBy: DEMO_ACTOR,
    }, AUTHORITY);
  }

  const structures = new Set((await listStructures(client)).map((s) => s.code));
  for (const s of STRUCTURES) {
    if (!structures.has(s.code)) {
      await defineSalaryStructure({ client, code: s.code, name: s.name, currency: DEMO_IDENTITY.currency, validFrom: from, changedBy: DEMO_ACTOR }, AUTHORITY);
    }
    const rules = new Set((await getStructure(client, s.code)).components.map((c) => c.componentCode));
    for (const r of s.rules) {
      if (rules.has(r.component)) continue;
      await setStructureComponent({
        client, structureCode: s.code, componentCode: r.component, amountKind: r.kind, amountValue: r.value, changedBy: DEMO_ACTOR,
      }, AUTHORITY);
    }
  }

  for (const a of ASSIGNMENTS) {
    await assignStructure({
      client, personnelNumber: a.personnelNumber, structureCode: a.structure, baseAmount: a.base,
      currency: DEMO_IDENTITY.currency, validFrom: from, requestKey: `DEMO-SAL-${a.personnelNumber}`, changedBy: DEMO_ACTOR,
    }, AUTHORITY);
  }

  return {
    components: COMPONENTS.length,
    mappings: COMPONENTS.length,
    timeTypes: TIME_TYPES.length,
    structures: STRUCTURES.length,
    assignments: ASSIGNMENTS.length,
  };
}
