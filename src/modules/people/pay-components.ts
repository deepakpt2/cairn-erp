/**
 * The pay structure: what a pay component is, and the accounting mapping it carries.
 *
 * CAIRN.md §8.10 names the two tables and calls the pair "Pay structure and its GL/cost mapping"; §15.1
 * calls a component the wage-type equivalent "with their accounting mapping". This service is the only path
 * that writes either row, under CFG.PEOPLE.PAYCOMPONENT.DEFINE. It is a definition service and nothing more:
 * there is no calculation here, no basis, no formula, no rule about how much a component is worth. R-11 keeps
 * payroll simplified and DV-001 refuses to ship guessed statutory logic, so the amount arrives from somewhere
 * else — an imported payroll result or, one day, §15.3's rule engine — and what this file decides is only
 * where an amount goes when it arrives.
 *
 * **The kind decides the sides, and §15.2 is the authority.** That example has six lines: three expenses
 * charged by cost centre, and three payables. So an EARNING debits an expense account, a DEDUCTION credits a
 * payable, and an EMPLOYER_CONTRIBUTION or an EOS_PROVISION does both — and the service refuses the sides a
 * kind has no business with rather than storing a mapping that could not be posted. Net pay itself is
 * deliberately not a column: it is the run's own credit, not one component's.
 *
 * **The accounts are checked against the tenant's chart, not against a guess.** `gl_account` decides what a
 * valid mapping is here, because the repository already carries the vocabulary: the account must stand in the
 * chart being mapped, must not be blocked for posting, must be an EXPENSE account on the debit side and a
 * LIABILITY account on the credit side (its own `account_type`), and — when its own master sets
 * `requires_cost_object` — it cannot be mapped without saying where the charge goes. Those are the chart of
 * accounts' rules, applied to a new kind of caller, which is why no new financial rule is asserted here.
 *
 * **A cost object is followed, not invented.** ASSIGNMENT charges the centre the employee's assignment names
 * (9194's `position_assignment`, the row §8.10 defines as "Position → cost centre → employee"), FIXED charges
 * the centre written on the mapping row, and NONE charges nothing. A FIXED centre is a dated master, so it is
 * checked as of today rather than keyed — the same judgment `assignment.ts` makes, in the same direction: a
 * mapping is refused today because a centre stopped standing, and nothing re-checks history afterwards.
 *
 * **Both rows are retired or corrected, never removed.** `9195` grants no DELETE anywhere in the slice, which
 * is why the mapping is one row per component and chart holding both sides instead of one row per side: a
 * per-side key could not be edited out of a mistake. Retiring a component stops a new mapping and stops it
 * being offered onward; the mapping that stands is left standing, because a payroll result would cite it.
 *
 * What waits on an owner decision, and is therefore absent: deduction rules and their conditions (§15.3, the
 * jurisdiction decisions DV-001 protects), employee-level or per-period amounts, the payroll runs and result
 * lines that would read these rows, posting of any kind (D-013), effective dates on the mapping (§15.1 asks
 * for validity dates on the Assignment alone), and the special cases of bonuses, advances and reimbursements
 * that §15.1 lists with their own posting keys — the last of which this repository does not model at all.
 */
import { and, asc, eq, sql } from 'drizzle-orm';
import { z } from 'zod';

import { recordChange } from '../../platform/change';
import { type Tx, withTenant } from '../../platform/db/client';
import {
  COST_RECEIVER_CATEGORIES,
  PAY_COMPONENT_CONFIG_OBJECT_CLASS,
  PAY_COMPONENT_CAPABILITY,
  PAY_COMPONENT_OBJECT_CLASS,
  PAY_COMPONENT_ROUTE,
  PAY_COMPONENT_KINDS,
  payComponent,
  payComponentConfig,
  type CostReceiverCategory,
  type PayComponentKind,
} from './schema';

// The screen contract lives with the tables; re-exported because a reader looks at the service first.
export type { CostReceiverCategory, PayComponentKind } from './schema';

export {
  COST_RECEIVER_CATEGORIES,
  PAY_COMPONENT_CAPABILITY,
  PAY_COMPONENT_CONFIG_OBJECT_CLASS,
  PAY_COMPONENT_KINDS,
  PAY_COMPONENT_OBJECT_CLASS,
  PAY_COMPONENT_ROUTE,
} from './schema';

const NAME_MAX = 60;
const DESC_MAX = 200;
const ACCOUNT_MAX = 10;

const upper = z.string().transform((s) => s.trim().toUpperCase());
const componentCode = upper.pipe(z.string().regex(/^([A-Z][A-Z0-9]{1,9})$/, { message: 'COMPONENT_CODE_FORMAT' }));
const accountNumber = upper.pipe(z.string().regex(/^[A-Z0-9]{1,10}$/, { message: 'ACCOUNT_FORMAT' }));
const chartCode = upper.pipe(z.string().regex(/^[A-Z0-9]{4}$/, { message: 'CHART_FORMAT' }));
const areaCode = upper.pipe(z.string().regex(/^[A-Z0-9]{4}$/, { message: 'AREA_FORMAT' }));
const centreCode = upper.pipe(z.string().regex(/^[A-Z0-9]{1,10}$/, { message: 'COST_CENTRE_FORMAT' }));
const clientField = upper.pipe(z.string().regex(/^[A-Z0-9]{2,4}$/, { message: 'CLIENT_FORMAT' }));
const kept = (max: number) =>
  z
    .string()
    .transform((s) => s.trim())
    .refine((s) => s.length > 0 && s.length <= max, { message: 'REQUIRED_TEXT' });
const optionalText = (max: number) => z.string().trim().max(max).nullable().optional();
const kindField = upper.pipe(z.enum(PAY_COMPONENT_KINDS, { message: 'KIND_VOCABULARY' }));
const receiverField = upper.pipe(z.enum(COST_RECEIVER_CATEGORIES, { message: 'RECEIVER_VOCABULARY' }));

const defineComponentInput = z.object({
  client: clientField,
  code: componentCode,
  name: kept(NAME_MAX),
  componentKind: kindField,
  description: optionalText(DESC_MAX),
  changedBy: kept(60),
});

const changeComponentInput = z.object({
  client: clientField,
  code: componentCode,
  name: kept(NAME_MAX).optional(),
  description: z.string().trim().max(DESC_MAX).nullable().optional(),
  isValid: z.boolean().optional(),
  changedBy: kept(60),
});

/**
 * One row for both sides: the key is the component within a chart, so a mapping is edited rather than
 * replaced. A change may leave the receiver category out — the row that stands answers for it — which is
 * why the shape is written twice rather than derived, and why nothing is optional that the key needs.
 */
const mappingShape = {
  client: clientField,
  componentCode,
  chartOfAccounts: chartCode,
  // `null` clears a side or a cost object; a missing key leaves the standing one alone. A form that wants
  // to remove something sends the `NONE` choice, which the action turns into null rather than a blank.
  debitAccount: accountNumber.nullish(),
  creditAccount: accountNumber.nullish(),
  controllingArea: areaCode.nullish(),
  costCenter: centreCode.nullish(),
  changedBy: kept(60),
};
const mappingInput = z.object({ ...mappingShape, costReceiverCategory: receiverField });
const changeMappingInput = z.object({ ...mappingShape, costReceiverCategory: receiverField.optional() });

export interface PayComponentMappingView {
  chartOfAccounts: string;
  debitAccount: string | null;
  debitAccountName: string | null;
  creditAccount: string | null;
  creditAccountName: string | null;
  costReceiverCategory: CostReceiverCategory;
  controllingArea: string | null;
  costCenter: string | null;
  costCenterName: string | null;
  createdBy: string;
  changedBy: string | null;
}

export interface PayComponentView {
  code: string;
  name: string;
  componentKind: PayComponentKind;
  affectsNetPay: boolean;
  description: string | null;
  isValid: boolean;
  mappings: PayComponentMappingView[];
  createdBy: string;
  changedBy: string | null;
}

export interface PayComponentRow {
  code: string;
  name: string;
  componentKind: PayComponentKind;
  affectsNetPay: boolean;
  isValid: boolean;
  mappings: number;
  createdBy: string;
  changedBy: string | null;
}

export class PayComponentError extends Error {
  readonly remedy: string;
  constructor(message: string, remedy: string) {
    super(message);
    this.name = 'PayComponentError';
    this.remedy = remedy;
  }
}

const REFUSALS: Record<string, [string, string]> = {
  COMPONENT_CODE_FORMAT: [
    `A pay component code is one to ten characters of capitals and digits, starting with a letter.`,
    `Use the code the payroll vocabulary already carries; a new component is defined here, not on the run screen that would read it.`,
  ],
  CLIENT_FORMAT: [
    `A tenant is the two-to-four-character code the session was opened with.`,
    `Open the screen from the launchpad; the tenant comes from the session, not from the form.`,
  ],
  REQUIRED_TEXT: [
    `A component name was blank or longer than ${NAME_MAX} characters.`,
    `Name it as the payroll letterhead would, up to ${NAME_MAX} characters.`,
  ],
  CHART_FORMAT: [
    `A chart of accounts is four characters.`,
    `Choose the chart from those the tenant has defined.`,
  ],
  ACCOUNT_FORMAT: [
    `A general ledger account is up to ${ACCOUNT_MAX} capitals or digits.`,
    `Choose the account from the chart being mapped — an account of another chart cannot carry this component.`,
  ],
  AREA_FORMAT: [
    `A controlling area is four characters.`,
    `Choose the area that owns the cost centre.`,
  ],
  COST_CENTRE_FORMAT: [
    `A cost centre is up to ${ACCOUNT_MAX} capitals or digits.`,
    `Choose the centre from those that stand in the area.`,
  ],
  KIND_VOCABULARY: [
    `A pay component is an earning, a deduction, an employer contribution or an end-of-service provision.`,
    `Those four are what §15.2's posting example contains. Anything else is a decision about payroll, not a component definition.`,
  ],
  RECEIVER_VOCABULARY: [
    `A debit is charged to the employee's assignment, to one fixed cost object, or to nothing.`,
    `Pick ASSIGNMENT, FIXED or NONE; the screen writes the area and centre only for FIXED.`,
  ],
  NOTHING_TO_CHANGE: [
    `No field was given, so nothing would change.`,
    `Send the name, the validity, the account or the cost object you want moved.`,
  ],
  COMPONENT_EXISTS: [
    `A pay component with that code already stands in this tenant.`,
    `Change the one that stands, or retire it and define the new one under a code nobody has used.`,
  ],
  COMPONENT_UNKNOWN: [
    `No pay component of that code stands in this tenant.`,
    `Define it here first: a mapping names a component that exists rather than one that is planned.`,
  ],
  COMPONENT_RETIRED: [
    `That pay component is retired, so no new mapping may be written for it.`,
    `Retire it back to valid if the tenant pays or owes it again, or map the component that replaced it.`,
  ],
  CHART_UNKNOWN: [
    `This tenant has no chart of accounts of that code.`,
    `Map the component within a chart the company codes it has defined actually use.`,
  ],
  MAPPING_EXISTS: [
    `That component already has a mapping in this chart.`,
    `Correct the mapping that stands: one component has one account pair per chart, so a second row would leave a posting run choosing between them.`,
  ],
  MAPPING_UNKNOWN: [
    `That component has no mapping in this chart yet.`,
    `Define it: a component with no mapping is a name with nowhere to post.`,
  ],
  ACCOUNT_OUTSIDE_CHART: [
    `That account is not part of the chart being mapped.`,
    `Choose an account of this chart — a number that exists in another chart would post into nothing.`,
  ],
  ACCOUNT_BLOCKED: [
    `That account is blocked for posting.`,
    `Unblock it in the general ledger if the tenant means payroll to move through it, or map an account that is open.`,
  ],
  ACCOUNT_TYPE_SIDE: [
    `A debit side of a pay component maps to an expense account and a credit side to a liability account.`,
    `That is what §15.2 posts: expenses charged by cost centre, payables created. Choose an account of the type the side needs.`,
  ],
  SIDE_NOT_ALLOWED: [
    `That kind of pay component has no such side.`,
    `An earning only charges an expense, a deduction only creates a payable, and a contribution or a provision does both. The kind is changed on the component, not on the mapping.`,
  ],
  SIDE_MISSING: [
    `That kind of pay component needs both of its sides mapped.`,
    `§15.2 shows the amount on each side of the entry: the expense it charges and the payable it creates.`,
  ],
  SAME_ACCOUNT_BOTH_SIDES: [
    `The same account cannot stand on both sides of one component.`,
    `An entry that debits and credits one account posts nothing; choose the expense account and the payable.`,
  ],
  COST_OBJECT_REQUIRED: [
    `That expense account requires a cost object, so the debit cannot be mapped to none.`,
    `Choose ASSIGNMENT to charge whoever the employee's assignment names, or FIXED with a centre of your own.`,
  ],
  CENTRE_NOT_STANDING: [
    `No cost centre of that code stands in that controlling area today.`,
    `A mapping has no dates of its own, so it can only be checked against the master as it stands: choose a centre in force.`,
  ],
  COST_AREA_UNKNOWN: [
    `That cost centre belongs to no controlling area the tenant has.`,
    `Choose the area that owns the centre; the pair is what a posting would charge.`,
  ],
  INVALID_INPUT: [
    `The pay structure write was not accepted.`,
    `Correct the value and submit again.`,
  ],
};

function refusal(key: string, detail?: string): never {
  const [message, remedy] = REFUSALS[key] ?? [
    `The pay structure write was not accepted (${key}).`,
    `Correct the value and submit again.`,
  ];
  throw new PayComponentError(detail ? `${message} ${detail}` : message, remedy);
}

function parse<T extends z.ZodTypeAny>(schema: T, input: unknown): z.infer<T> {
  const parsed = schema.safeParse(input);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    refusal(first?.code === 'custom' ? String(first.message) : (first?.message ?? 'INVALID_INPUT'));
  }
  return parsed.data;
}

/** The sides §15.2 gives each kind. Kept in one place so the screen and the write cannot disagree. */
const SIDES: Record<PayComponentKind, { debit: boolean; credit: boolean }> = {
  EARNING: { debit: true, credit: false },
  DEDUCTION: { debit: false, credit: true },
  EMPLOYER_CONTRIBUTION: { debit: true, credit: true },
  EOS_PROVISION: { debit: true, credit: true },
};

/**
 * The account's own master decides whether the mapping may stand: it has to be in the chart, be open for
 * posting, and be of the type the side needs. One read per side, so the answers come from the same snapshot
 * the insert writes into.
 */
async function accountForSide(
  tx: Tx,
  client: string,
  chart: string,
  account: string,
  side: 'DEBIT' | 'CREDIT',
): Promise<{ accountNumber: string; name: string; requiresCostObject: boolean }> {
  const rows = (await tx.execute(sql`
    select account_number, name, account_type, is_blocked_posting, requires_cost_object
      from public.gl_account
     where client = ${client} and chart_of_accounts = ${chart} and account_number = ${account}
     limit 1`)) as unknown as Array<{
    account_number: string;
    name: string;
    account_type: string;
    is_blocked_posting: boolean;
    requires_cost_object: boolean;
  }>;
  const row = rows[0];
  if (!row) refusal('ACCOUNT_OUTSIDE_CHART', `${account} is not in chart ${chart}.`);
  if (row.is_blocked_posting) refusal('ACCOUNT_BLOCKED', `${account} is blocked for posting.`);
  const wanted = side === 'DEBIT' ? 'EXPENSE' : 'LIABILITY';
  if (row.account_type !== wanted) refusal('ACCOUNT_TYPE_SIDE', `${account} is ${row.account_type}, not ${wanted}.`);
  return { accountNumber: row.account_number, name: row.name, requiresCostObject: row.requires_cost_object };
}

/** The centre a FIXED mapping charges, as of today — the dated-master rule 9194 applies to an assignment. */
async function centreStandingToday(tx: Tx, client: string, area: string, centre: string): Promise<{ name: string }> {
  const rows = (await tx.execute(sql`
    select name
      from public.cost_center
     where client = ${client} and controlling_area = ${area} and cost_center = ${centre}
       and valid_from <= current_date and valid_to >= current_date
     order by valid_from desc
     limit 1`)) as unknown as Array<{ name: string }>;
  const row = rows[0];
  if (!row) refusal('CENTRE_NOT_STANDING', `${area} / ${centre}.`);
  return { name: row.name };
}

/** Define a pay component. The kind is chosen here and never again: it decides the mapping's sides. */
export async function definePayComponent(input: unknown): Promise<PayComponentView> {
  const parsed = parse(defineComponentInput, input);
  await withTenant(parsed.client, async (tx) => {
    const [standing] = await tx
      .select()
      .from(payComponent)
      .where(and(eq(payComponent.client, parsed.client), eq(payComponent.code, parsed.code)))
      .limit(1);
    if (standing) refusal('COMPONENT_EXISTS', parsed.code);
    await tx.insert(payComponent).values({
      client: parsed.client,
      code: parsed.code,
      name: parsed.name,
      componentKind: parsed.componentKind,
      // Pinned by a check to the kind; asked for here so a reader sees where the answer comes from.
      affectsNetPay: parsed.componentKind === 'EARNING' || parsed.componentKind === 'DEDUCTION',
      description: parsed.description ?? null,
      isValid: true,
      createdBy: parsed.changedBy,
    });
    await recordChange(tx, {
      client: parsed.client,
      objectClass: PAY_COMPONENT_OBJECT_CLASS,
      objectKey: parsed.code,
      changeType: 'CREATE',
      changedBy: parsed.changedBy,
      after: { code: parsed.code, name: parsed.name, kind: parsed.componentKind },
    });
    return undefined;
  });
  return getPayComponent(parsed.client, parsed.code);
}

/** Rename, re-describe or retire a component. Nothing here changes its kind, and no row is removed. */
export async function changePayComponent(input: unknown): Promise<PayComponentView> {
  const parsed = parse(changeComponentInput, input);
  await withTenant(parsed.client, async (tx) => {
    const [standing] = await tx
      .select()
      .from(payComponent)
      .where(and(eq(payComponent.client, parsed.client), eq(payComponent.code, parsed.code)))
      .limit(1);
    if (!standing) refusal('COMPONENT_UNKNOWN', parsed.code);
    const patch: { name?: string; description?: string | null; isValid?: boolean } = {};
    if (parsed.name !== undefined) patch.name = parsed.name;
    if (parsed.description !== undefined) patch.description = parsed.description;
    if (parsed.isValid !== undefined) patch.isValid = parsed.isValid;
    if (Object.keys(patch).length === 0) refusal('NOTHING_TO_CHANGE');
    await tx
      .update(payComponent)
      .set({ ...patch, changedBy: parsed.changedBy, changedAt: new Date() })
      .where(and(eq(payComponent.client, parsed.client), eq(payComponent.code, parsed.code)));
    await recordChange(tx, {
      client: parsed.client,
      objectClass: PAY_COMPONENT_OBJECT_CLASS,
      objectKey: parsed.code,
      changeType: 'CHANGE',
      changedBy: parsed.changedBy,
      before: { name: standing!.name, isValid: standing!.isValid },
      after: patch,
    });
    return undefined;
  });
  return getPayComponent(parsed.client, parsed.code);
}

/**
 * Write or correct a component's mapping within one chart. The kind decides which sides must stand, the
 * account's own master decides whether it may be used at all, and `requires_cost_object` decides whether a
 * debit has to say where it goes.
 */
export async function savePayComponentMapping(input: unknown, mode: 'CREATE' | 'CHANGE'): Promise<PayComponentMappingView> {
  const parsed = parse(mode === 'CREATE' ? mappingInput : changeMappingInput, input);
  await withTenant(parsed.client, async (tx) => {
    const [component] = await tx
      .select()
      .from(payComponent)
      .where(and(eq(payComponent.client, parsed.client), eq(payComponent.code, parsed.componentCode)))
      .limit(1);
    if (!component) refusal('COMPONENT_UNKNOWN', parsed.componentCode);
    if (mode === 'CREATE' && !component!.isValid) refusal('COMPONENT_RETIRED', parsed.componentCode);

    const [chart] = (await tx.execute(sql`
      select chart_of_accounts
        from public.chart_of_accounts
       where client = ${parsed.client} and chart_of_accounts = ${parsed.chartOfAccounts}
       limit 1`)) as unknown as Array<{ chart_of_accounts: string }>;
    if (!chart) refusal('CHART_UNKNOWN', parsed.chartOfAccounts);

    const [existing] = await tx
      .select()
      .from(payComponentConfig)
      .where(
        and(
          eq(payComponentConfig.client, parsed.client),
          eq(payComponentConfig.componentCode, parsed.componentCode),
          eq(payComponentConfig.chartOfAccounts, parsed.chartOfAccounts),
        ),
      )
      .limit(1);
    if (mode === 'CREATE' && existing) refusal('MAPPING_EXISTS', `${parsed.componentCode} in ${parsed.chartOfAccounts}.`);
    if (mode === 'CHANGE' && !existing) refusal('MAPPING_UNKNOWN', `${parsed.componentCode} in ${parsed.chartOfAccounts}.`);

    const said = <T extends string>(given: T | null | undefined, standing: string | null): string | null =>
      given === undefined ? standing : given;
    const debit = said(parsed.debitAccount, existing?.debitAccount ?? null);
    const credit = said(parsed.creditAccount, existing?.creditAccount ?? null);
    const receiver = (parsed.costReceiverCategory ?? existing?.costReceiverCategory ?? 'NONE') as CostReceiverCategory;
    const area = said(parsed.controllingArea, existing?.controllingArea ?? null);
    const centre = said(parsed.costCenter, existing?.costCenter ?? null);

    const sides = SIDES[component!.componentKind as PayComponentKind];
    if (debit && !sides.debit) refusal('SIDE_NOT_ALLOWED', `${component!.componentKind} has no debit side.`);
    if (credit && !sides.credit) refusal('SIDE_NOT_ALLOWED', `${component!.componentKind} has no credit side.`);
    if (sides.debit && !debit) refusal('SIDE_MISSING', `${component!.componentKind} charges an expense, so the debit account is required.`);
    if (sides.credit && !credit) refusal('SIDE_MISSING', `${component!.componentKind} creates a payable, so the credit account is required.`);
    if (debit && credit && debit === credit) refusal('SAME_ACCOUNT_BOTH_SIDES');

    let requiresCostObject = false;
    if (debit) requiresCostObject = (await accountForSide(tx, parsed.client, parsed.chartOfAccounts, debit, 'DEBIT')).requiresCostObject;
    if (credit) await accountForSide(tx, parsed.client, parsed.chartOfAccounts, credit, 'CREDIT');

    if (debit && requiresCostObject && receiver === 'NONE') refusal('COST_OBJECT_REQUIRED', debit);
    // Only a fixed centre is named on the row, and only while the category says FIXED. An operator who moves
    // a mapping from FIXED to ASSIGNMENT is not leaving a centre behind — the assignment is the answer now —
    // so the pair is dropped rather than inherited, while naming a centre beside a category that takes none is
    // a half-written mapping and is refused.
    if (receiver !== 'FIXED' && (parsed.controllingArea || parsed.costCenter)) {
      refusal('RECEIVER_VOCABULARY', `${receiver} takes no area and no centre of its own.`);
    }
    const costArea = receiver === 'FIXED' ? area : null;
    const costCentre = receiver === 'FIXED' ? centre : null;
    if (receiver === 'FIXED') {
      if (!costArea || !costCentre) refusal('RECEIVER_VOCABULARY', 'FIXED needs the controlling area and the centre to charge.');
      else await centreStandingToday(tx, parsed.client, costArea, costCentre);
    }

    const values = {
      debitAccount: debit,
      creditAccount: credit,
      costReceiverCategory: receiver,
      controllingArea: costArea,
      costCenter: costCentre,
      changedBy: parsed.changedBy,
      changedAt: new Date(),
    };
    if (existing) {
      await tx
        .update(payComponentConfig)
        .set(values)
        .where(
          and(
            eq(payComponentConfig.client, parsed.client),
            eq(payComponentConfig.componentCode, parsed.componentCode),
            eq(payComponentConfig.chartOfAccounts, parsed.chartOfAccounts),
          ),
        );
    } else {
      await tx.insert(payComponentConfig).values({
        client: parsed.client,
        componentCode: parsed.componentCode,
        chartOfAccounts: parsed.chartOfAccounts,
        ...values,
        createdBy: parsed.changedBy,
      });
    }
    await recordChange(tx, {
      client: parsed.client,
      objectClass: PAY_COMPONENT_CONFIG_OBJECT_CLASS,
      objectKey: `${parsed.chartOfAccounts}/${parsed.componentCode}`,
      changeType: mode === 'CREATE' ? 'CREATE' : 'CHANGE',
      changedBy: parsed.changedBy,
      before: existing
        ? {
            debitAccount: existing.debitAccount,
            creditAccount: existing.creditAccount,
            costReceiverCategory: existing.costReceiverCategory,
            costCenter: existing.costCenter,
          }
        : undefined,
      after: {
        debitAccount: values.debitAccount,
        creditAccount: values.creditAccount,
        costReceiverCategory: values.costReceiverCategory,
        costCenter: values.costCenter,
      },
    });
    return undefined;
  });
  const detail = await getPayComponent(parsed.client, parsed.componentCode);
  const mapping = detail.mappings.find((row) => row.chartOfAccounts === parsed.chartOfAccounts);
  if (!mapping) refusal('MAPPING_UNKNOWN', `${parsed.componentCode} in ${parsed.chartOfAccounts}.`);
  return mapping;
}

export async function getPayComponent(clientInput: string, codeValue: string): Promise<PayComponentView> {
  const client = parse(clientField, clientInput);
  const code = parse(componentCode, codeValue);
  return withTenant(client, async (tx) => {
    const [row] = await tx
      .select()
      .from(payComponent)
      .where(and(eq(payComponent.client, client), eq(payComponent.code, code)))
      .limit(1);
    if (!row) refusal('COMPONENT_UNKNOWN', code);
    const mappings = await mappingViews(tx, client, code);
    return {
      code: row.code,
      name: row.name,
      componentKind: row.componentKind as PayComponentKind,
      affectsNetPay: row.affectsNetPay,
      description: row.description ?? null,
      isValid: row.isValid,
      mappings,
      createdBy: row.createdBy,
      changedBy: row.changedBy ?? null,
    };
  });
}

/** One read for the mapping rows of a component; the names beside the numbers are read with them. */
async function mappingViews(tx: Tx, client: string, componentCodeValue: string): Promise<PayComponentMappingView[]> {
  const rows = await tx
    .select()
    .from(payComponentConfig)
    .where(
      and(
        eq(payComponentConfig.client, client),
        eq(payComponentConfig.componentCode, componentCodeValue),
      ),
    )
    .orderBy(asc(payComponentConfig.chartOfAccounts));
  const accountRows = (await tx.execute(sql`
    select chart_of_accounts as chart, account_number as account, name
      from public.gl_account
     where client = ${client}`)) as unknown as Array<{ chart: string; account: string; name: string }>;
  const centreRows = (await tx.execute(sql`
    select controlling_area as area, cost_center as centre, name
      from public.cost_center
     where client = ${client} and valid_from <= current_date and valid_to >= current_date`)) as unknown as Array<{
    area: string;
    centre: string;
    name: string;
  }>;
  const accountNames = new Map(accountRows.map((row) => [`${row.chart}/${row.account}`, row.name]));
  const centreNames = new Map(centreRows.map((row) => [`${row.area}/${row.centre}`, row.name]));
  return rows.map((row) => ({
    chartOfAccounts: row.chartOfAccounts,
    debitAccount: row.debitAccount,
    debitAccountName: row.debitAccount ? accountNames.get(`${row.chartOfAccounts}/${row.debitAccount}`) ?? null : null,
    creditAccount: row.creditAccount,
    creditAccountName: row.creditAccount ? accountNames.get(`${row.chartOfAccounts}/${row.creditAccount}`) ?? null : null,
    costReceiverCategory: row.costReceiverCategory as CostReceiverCategory,
    controllingArea: row.controllingArea,
    costCenter: row.costCenter,
    costCenterName:
      row.controllingArea && row.costCenter ? centreNames.get(`${row.controllingArea}/${row.costCenter}`) ?? null : null,
    createdBy: row.createdBy,
    changedBy: row.changedBy ?? null,
  }));
}

/** The components of the tenant, with how many charts have mapped them. */
export async function listPayComponents(clientInput: string, query?: string): Promise<PayComponentRow[]> {
  const client = parse(clientField, clientInput);
  const wanted = (query ?? '').trim().toUpperCase();
  return withTenant(client, async (tx) => {
    const rows = await tx.select().from(payComponent).where(eq(payComponent.client, client)).orderBy(asc(payComponent.code));
    const mapped = (await tx.execute(sql`
      select component_code as code, count(*)::int as n
        from public.pay_component_config
       where client = ${client}
       group by 1`)) as unknown as Array<{ code: string; n: number }>;
    const counts = new Map(mapped.map((row) => [row.code, row.n]));
    return rows
      .filter((row) => wanted === '' || row.code.includes(wanted) || row.name.toUpperCase().includes(wanted))
      .map((row) => ({
        code: row.code,
        name: row.name,
        componentKind: row.componentKind as PayComponentKind,
        affectsNetPay: row.affectsNetPay,
        isValid: row.isValid,
        mappings: counts.get(row.code) ?? 0,
        createdBy: row.createdBy,
        changedBy: row.changedBy ?? null,
      }));
  });
}

/** The charts a mapping may be written into, so the screen offers real choices rather than a typed code. */
export async function listChartsForMapping(clientInput: string): Promise<Array<{ chartOfAccounts: string; name: string }>> {
  const client = parse(clientField, clientInput);
  return withTenant(client, async (tx) => {
    const rows = (await tx.execute(sql`
      select c.chart_of_accounts as chart, c.name
        from public.chart_of_accounts c
       where c.client = ${client} and c.is_active
       order by 1`)) as unknown as Array<{ chart: string; name: string }>;
    return rows.map((row) => ({ chartOfAccounts: row.chart, name: row.name }));
  });
}

/** The accounts of one chart, of the type a side needs, open for posting. */
export async function listAccountsForSide(
  clientInput: string,
  chart: string,
  side: 'DEBIT' | 'CREDIT',
): Promise<Array<{ accountNumber: string; name: string; requiresCostObject: boolean }>> {
  const client = parse(clientField, clientInput);
  const wantedChart = parse(chartCode, chart);
  const type = side === 'DEBIT' ? 'EXPENSE' : 'LIABILITY';
  return withTenant(client, async (tx) => {
    const rows = (await tx.execute(sql`
      select account_number as account, name, requires_cost_object as requires_cost_object
        from public.gl_account
       where client = ${client} and chart_of_accounts = ${wantedChart}
         and account_type = ${type} and not is_blocked_posting
       order by 1
       limit 200`)) as unknown as Array<{ account: string; name: string; requires_cost_object: boolean }>;
    return rows.map((row) => ({
      accountNumber: row.account,
      name: row.name,
      requiresCostObject: row.requires_cost_object,
    }));
  });
}

/** The area/centre pairs a FIXED mapping may charge: centres in force today, grouped by their own area. */
export async function listCostCentresForMapping(
  clientInput: string,
): Promise<Array<{ controllingArea: string; costCenter: string; name: string }>> {
  const client = parse(clientField, clientInput);
  return withTenant(client, async (tx) => {
    const rows = (await tx.execute(sql`
      select controlling_area as area, cost_center as centre, name
        from public.cost_center
       where client = ${client} and valid_from <= current_date and valid_to >= current_date and not is_posting_locked
       order by 1, 2
       limit 400`)) as unknown as Array<{ area: string; centre: string; name: string }>;
    return rows.map((row) => ({ controllingArea: row.area, costCenter: row.centre, name: row.name }));
  });
}

/** A refusal the screens can trust: only this module's own error is a refusal, anything else is a bug. */
export function isPayComponentError(error: unknown): error is PayComponentError {
  return error instanceof PayComponentError;
}

/** Any component the tenant has defined and not retired — what a later payroll screen would offer. */
export async function listOpenPayComponents(clientInput: string): Promise<PayComponentRow[]> {
  const all = await listPayComponents(clientInput);
  return all.filter((row) => row.isValid);
}
