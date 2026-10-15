/**
 * SCR-025 / OX19 Controlling Area ↔ Company Code assignment business functions.
 * Authorization is enforced by the protected server-action boundary; this module
 * owns tenant-scoped validation, atomic mapping changes, and audit history.
 */
import { randomUUID } from 'node:crypto';
import { and, asc, eq } from 'drizzle-orm';
import { z } from 'zod';
import { recordChange } from '../../platform/change';
import { withTenant, type Tx } from '../../platform/db/client';
import { markActivityComplete } from '../../platform/tenancy';
import { changeDocument, changeDocumentItem } from '../../platform/tables/audit-trail';
import { lockCompanyCodeOxxAssignments } from './controlling-area-company-compatibility';
import {
  chartOfAccounts,
  companyCode,
  controllingArea,
  controllingAreaCompany,
  fiscalYearVariant,
} from './schema';

const ASSIGNMENT_ACTIVITY = 'CFG.COST.CONTROLLINGAREA.ASSIGN_COMPANY';
const OBJECT_CLASS = 'controlling_area_company';
const tenantKeySchema = z.string().trim().regex(/^[A-Za-z0-9]{2,4}$/);
const controllingAreaKeySchema = z.string().trim().transform((value) => value.toUpperCase())
  .pipe(z.string().regex(/^[A-Z0-9]{4}$/, 'Controlling Area must be four alphanumeric characters.'));
// Company Code source keys preserve their exact case (OX19 does not uppercase-normalize them).
const companyCodeKeySchema = z.string().trim()
  .regex(/^[A-Za-z0-9]{4}$/, 'Company Code must be four alphanumeric characters.');

/** Only the OX19 pair is writable; tenant and actor are service-only inputs. */
export const controllingAreaCompanyAssignmentValuesSchema = z.object({
  controllingArea: controllingAreaKeySchema,
  companyCode: companyCodeKeySchema,
}).strict();

export const controllingAreaCompanyAssignmentInputSchema = controllingAreaCompanyAssignmentValuesSchema.extend({
  client: tenantKeySchema,
  changedBy: z.string().trim().min(1).max(60),
}).strict();

export type ControllingAreaCompanyAssignmentInput =
  z.input<typeof controllingAreaCompanyAssignmentInputSchema>;

export class ControllingAreaCompanyAssignmentError extends Error {
  readonly code = 'CAIRN_CONFIG';

  constructor(
    message: string,
    readonly remedy = 'Review the Controlling Area and Company Code, then try the OX19 assignment again.',
  ) {
    super(message);
    this.name = 'ControllingAreaCompanyAssignmentError';
  }
}

/**
 * Assign an existing tenant-local Company Code to an existing Controlling Area.
 * Inactive source rows are valid. A repeated pair is a no-op on mapping state but
 * still writes a durable audit event. A Company Code linked elsewhere must first
 * be unassigned; this function never performs an implicit reassignment.
 */
export async function assignCompanyCodeToControllingArea(
  raw: ControllingAreaCompanyAssignmentInput,
) {
  const parsed = controllingAreaCompanyAssignmentInputSchema.safeParse(raw);
  if (!parsed.success) throw invalidInput(parsed.error);

  return withTenant(parsed.data.client, (tx) =>
    assignCompanyCodeToControllingAreaInTransaction(tx, parsed.data),
  );
}

/** Same atomic operation for a caller that already owns a tenant transaction (e.g. initial package setup). */
export async function assignCompanyCodeToControllingAreaInTransaction(
  tx: Tx,
  raw: ControllingAreaCompanyAssignmentInput,
) {
  const parsed = controllingAreaCompanyAssignmentInputSchema.safeParse(raw);
  if (!parsed.success) throw invalidInput(parsed.error);
  const { client, changedBy, ...values } = parsed.data;

  await lockAssignmentResources(tx, client, values.controllingArea, values.companyCode);
  const { area, company } = await requireSourceRows(tx, client, values.controllingArea, values.companyCode);

  const [currentOwner] = await tx.select({
    controllingArea: controllingAreaCompany.controllingArea,
  }).from(controllingAreaCompany)
    .where(and(
      eq(controllingAreaCompany.client, client),
      eq(controllingAreaCompany.companyCode, values.companyCode),
    ))
    .for('update');

  if (currentOwner?.controllingArea.trim() === values.controllingArea) {
    await recordDuplicateAssignmentEvent(tx, client, changedBy, values.controllingArea, values.companyCode);
    await markActivityComplete(tx, client, ASSIGNMENT_ACTIVITY, changedBy);
    return {
      assigned: false as const,
      duplicate: true as const,
      controllingArea: values.controllingArea,
      companyCode: values.companyCode,
    };
  }
  if (currentOwner) throw alreadyAssignedElsewhere(values.companyCode, currentOwner.controllingArea.trim());

  const areaCurrency = area.currency.trim();
  const areaFiscalYearVariant = area.fiscalYearVariant.trim();
  const companyCurrency = company.currency.trim();
  if (companyCurrency !== areaCurrency) {
    throw new ControllingAreaCompanyAssignmentError(
      `Company Code ${values.companyCode} local currency ${companyCurrency} does not match Controlling Area ${values.controllingArea} currency ${areaCurrency}.`,
      'Choose a Company Code whose local currency exactly matches the Controlling Area Currency Key.',
    );
  }

  const companyFiscalYearVariant = requiredValue(
    company.fiscalYearVariant,
    `Company Code ${values.companyCode} has no Fiscal Year Variant assigned.`,
    'Assign an existing Fiscal Year Variant to the Company Code before OX19.',
  );
  if (companyFiscalYearVariant !== areaFiscalYearVariant) {
    throw new ControllingAreaCompanyAssignmentError(
      `Company Code ${values.companyCode} Fiscal Year Variant ${companyFiscalYearVariant} does not match Controlling Area ${values.controllingArea} Fiscal Year Variant ${areaFiscalYearVariant}.`,
      'Use the same Fiscal Year Variant on the Company Code and Controlling Area.',
    );
  }
  const companyChartOfAccounts = requiredValue(
    company.chartOfAccounts,
    `Company Code ${values.companyCode} has no Operational Chart of Accounts assigned.`,
    'Assign an existing Operational Chart of Accounts to the Company Code before OX19.',
  );
  await requireChartOfAccounts(tx, client, companyChartOfAccounts, values.companyCode);
  await requireFiscalYearVariant(tx, client, companyFiscalYearVariant, values.companyCode);

  const currentAssignments = await readAreaAssignments(tx, client, values.controllingArea);
  if (area.companyCodeScope === 'SINGLE' && currentAssignments.length > 0) {
    throw new ControllingAreaCompanyAssignmentError(
      `Controlling Area ${values.controllingArea} is configured for Same Company Code and already has a Company Code assignment.`,
      'Unassign the current Company Code before assigning another one, or change the Controlling Area scope through OKKP.',
    );
  }
  if (area.companyCodeScope !== 'SINGLE' && area.companyCodeScope !== 'MULTIPLE') {
    throw new ControllingAreaCompanyAssignmentError(
      `Controlling Area ${values.controllingArea} has an unsupported Company Code assignment scope.`,
      'Correct the Controlling Area scope through OKKP before assigning Company Codes.',
    );
  }

  const chartBaseline = await validateCurrentAreaAssignments(
    tx,
    client,
    values.controllingArea,
    areaCurrency,
    areaFiscalYearVariant,
    currentAssignments,
  );
  if (chartBaseline !== null && chartBaseline !== companyChartOfAccounts) {
    throw new ControllingAreaCompanyAssignmentError(
      `Company Code ${values.companyCode} Operational Chart of Accounts ${companyChartOfAccounts} does not match the current assignment baseline ${chartBaseline} for Controlling Area ${values.controllingArea}.`,
      'Use the same Operational Chart of Accounts as the Controlling Area’s current Company Code assignments. If the assignment set is empty, the first new assignment establishes the baseline.',
    );
  }

  const [created] = await tx.insert(controllingAreaCompany).values({
    client,
    controllingArea: values.controllingArea,
    companyCode: values.companyCode,
    createdBy: changedBy,
  }).onConflictDoNothing().returning({
    controllingArea: controllingAreaCompany.controllingArea,
  });

  if (!created) {
    // The advisory lock serializes Cairn OX19 writes. Keep the unique index as
    // the final guard for any other writer and record a racing duplicate too.
    const [racedOwner] = await tx.select({
      controllingArea: controllingAreaCompany.controllingArea,
    }).from(controllingAreaCompany)
      .where(and(
        eq(controllingAreaCompany.client, client),
        eq(controllingAreaCompany.companyCode, values.companyCode),
      ))
      .for('update');
    if (racedOwner?.controllingArea.trim() === values.controllingArea) {
      await recordDuplicateAssignmentEvent(tx, client, changedBy, values.controllingArea, values.companyCode);
      await markActivityComplete(tx, client, ASSIGNMENT_ACTIVITY, changedBy);
      return {
        assigned: false as const,
        duplicate: true as const,
        controllingArea: values.controllingArea,
        companyCode: values.companyCode,
      };
    }
    if (racedOwner) throw alreadyAssignedElsewhere(values.companyCode, racedOwner.controllingArea.trim());
    throw new ControllingAreaCompanyAssignmentError(
      `The Company Code ${values.companyCode} assignment could not be saved.`,
      'Reload OX19 and review the current assignments before retrying.',
    );
  }

  const changeId = await recordChange(tx, {
    client,
    objectClass: OBJECT_CLASS,
    objectKey: assignmentObjectKey(values.controllingArea, values.companyCode),
    changeType: 'CREATE',
    changedBy,
    transactionCode: ASSIGNMENT_ACTIVITY,
    after: {
      controllingArea: values.controllingArea,
      companyCode: values.companyCode,
    },
    securityRelevantFields: ['controllingArea', 'companyCode'],
    fieldLabels: ASSIGNMENT_FIELD_LABELS,
  });
  if (!changeId) {
    throw new ControllingAreaCompanyAssignmentError(
      'The Company Code assignment could not be recorded in change history.',
      'Retry the assignment. If the problem continues, contact an administrator.',
    );
  }

  await markActivityComplete(tx, client, ASSIGNMENT_ACTIVITY, changedBy);
  return {
    assigned: true as const,
    duplicate: false as const,
    controllingArea: values.controllingArea,
    companyCode: values.companyCode,
    chartOfAccounts: companyChartOfAccounts,
    fiscalYearVariant: companyFiscalYearVariant,
    currency: companyCurrency,
  };
}

/**
 * Remove the current link only. History is append-only: the original CREATE and
 * this DELETE change document remain after the mapping row has been removed.
 */
export async function unassignCompanyCodeFromControllingArea(
  raw: ControllingAreaCompanyAssignmentInput,
) {
  const parsed = controllingAreaCompanyAssignmentInputSchema.safeParse(raw);
  if (!parsed.success) throw invalidInput(parsed.error);

  const { client, changedBy, ...values } = parsed.data;
  return withTenant(client, async (tx) => {
    await lockAssignmentResources(tx, client, values.controllingArea, values.companyCode);
    await requireSourceRows(tx, client, values.controllingArea, values.companyCode);

    const [existing] = await tx.select({
      controllingArea: controllingAreaCompany.controllingArea,
      companyCode: controllingAreaCompany.companyCode,
    }).from(controllingAreaCompany)
      .where(and(
        eq(controllingAreaCompany.client, client),
        eq(controllingAreaCompany.controllingArea, values.controllingArea),
        eq(controllingAreaCompany.companyCode, values.companyCode),
      ))
      .for('update');
    if (!existing) {
      throw new ControllingAreaCompanyAssignmentError(
        `Company Code ${values.companyCode} is not assigned to Controlling Area ${values.controllingArea}.`,
        'Reload the OX19 assignment list and select a current link to unassign.',
      );
    }

    const [removed] = await tx.delete(controllingAreaCompany)
      .where(and(
        eq(controllingAreaCompany.client, client),
        eq(controllingAreaCompany.controllingArea, values.controllingArea),
        eq(controllingAreaCompany.companyCode, values.companyCode),
      ))
      .returning({ companyCode: controllingAreaCompany.companyCode });
    if (!removed) {
      throw new ControllingAreaCompanyAssignmentError(
        `Company Code ${values.companyCode} changed while its Controlling Area assignment was being removed.`,
        'Reload OX19 and review the current assignments before retrying.',
      );
    }

    const changeId = await recordChange(tx, {
      client,
      objectClass: OBJECT_CLASS,
      objectKey: assignmentObjectKey(values.controllingArea, values.companyCode),
      changeType: 'DELETE',
      changedBy,
      transactionCode: ASSIGNMENT_ACTIVITY,
      before: {
        controllingArea: existing.controllingArea.trim(),
        companyCode: existing.companyCode.trim(),
      },
      securityRelevantFields: ['controllingArea', 'companyCode'],
      fieldLabels: ASSIGNMENT_FIELD_LABELS,
    });
    if (!changeId) {
      throw new ControllingAreaCompanyAssignmentError(
        'The Company Code unassignment could not be recorded in change history.',
        'Retry the unassignment. If the problem continues, contact an administrator.',
      );
    }

    await markActivityComplete(tx, client, ASSIGNMENT_ACTIVITY, changedBy);
    return {
      unassigned: true as const,
      controllingArea: values.controllingArea,
      companyCode: values.companyCode,
    };
  });
}

async function requireSourceRows(tx: Tx, client: string, areaCode: string, companyCodeKey: string) {
  const [area] = await tx.select({
    controllingArea: controllingArea.controllingArea,
    companyCodeScope: controllingArea.companyCodeScope,
    currency: controllingArea.currency,
    fiscalYearVariant: controllingArea.fiscalYearVariant,
  }).from(controllingArea)
    .where(and(
      eq(controllingArea.client, client),
      eq(controllingArea.controllingArea, areaCode),
    ))
    .for('update');
  if (!area) {
    throw new ControllingAreaCompanyAssignmentError(
      `Controlling Area ${areaCode} does not exist in this tenant.`,
      'Choose an existing Controlling Area from OX19 value help, including inactive records if required.',
    );
  }

  const [company] = await tx.select({
    companyCode: companyCode.companyCode,
    chartOfAccounts: companyCode.chartOfAccounts,
    fiscalYearVariant: companyCode.fiscalYearVariant,
    currency: companyCode.currency,
  }).from(companyCode)
    .where(and(
      eq(companyCode.client, client),
      eq(companyCode.companyCode, companyCodeKey),
    ))
    .for('update');
  if (!company) {
    throw new ControllingAreaCompanyAssignmentError(
      `Company Code ${companyCodeKey} does not exist in this tenant.`,
      'Choose an existing Company Code from OX19 value help, including inactive records if required.',
    );
  }

  return { area, company };
}

async function readAreaAssignments(tx: Tx, client: string, areaCode: string) {
  return tx.select({
    companyCode: controllingAreaCompany.companyCode,
    chartOfAccounts: companyCode.chartOfAccounts,
    fiscalYearVariant: companyCode.fiscalYearVariant,
    currency: companyCode.currency,
    chartMaster: chartOfAccounts.chartOfAccounts,
    fiscalYearVariantMaster: fiscalYearVariant.variant,
  }).from(controllingAreaCompany)
    .innerJoin(companyCode, and(
      eq(companyCode.client, controllingAreaCompany.client),
      eq(companyCode.companyCode, controllingAreaCompany.companyCode),
    ))
    .leftJoin(chartOfAccounts, and(
      eq(chartOfAccounts.client, companyCode.client),
      eq(chartOfAccounts.chartOfAccounts, companyCode.chartOfAccounts),
    ))
    .leftJoin(fiscalYearVariant, and(
      eq(fiscalYearVariant.client, companyCode.client),
      eq(fiscalYearVariant.variant, companyCode.fiscalYearVariant),
    ))
    .where(and(
      eq(controllingAreaCompany.client, client),
      eq(controllingAreaCompany.controllingArea, areaCode),
    ))
    .orderBy(asc(controllingAreaCompany.companyCode));
}

async function validateCurrentAreaAssignments(
  tx: Tx,
  client: string,
  areaCode: string,
  areaCurrency: string,
  areaFiscalYearVariant: string,
  rows: Awaited<ReturnType<typeof readAreaAssignments>>,
): Promise<string | null> {
  let chartBaseline: string | null = null;
  for (const row of rows) {
    const assignedChart = normalizedValue(row.chartOfAccounts);
    if (!assignedChart || !row.chartMaster) {
      throw new ControllingAreaCompanyAssignmentError(
        `An existing Company Code assignment for Controlling Area ${areaCode} lacks a defined Operational Chart of Accounts.`,
        'Complete the Company Code Chart of Accounts assignment before adding another Company Code.',
      );
    }
    const assignedFiscalYearVariant = normalizedValue(row.fiscalYearVariant);
    if (!assignedFiscalYearVariant || !row.fiscalYearVariantMaster) {
      throw new ControllingAreaCompanyAssignmentError(
        `An existing Company Code assignment for Controlling Area ${areaCode} lacks a defined Fiscal Year Variant.`,
        'Complete the Company Code Fiscal Year Variant assignment before adding another Company Code.',
      );
    }
    if (assignedFiscalYearVariant !== areaFiscalYearVariant) {
      throw new ControllingAreaCompanyAssignmentError(
        `An existing Company Code assignment for Controlling Area ${areaCode} uses a different Fiscal Year Variant.`,
        'Correct the Company Code or Controlling Area Fiscal Year Variant before adding another Company Code.',
      );
    }
    if (row.currency.trim() !== areaCurrency) {
      throw new ControllingAreaCompanyAssignmentError(
        `An existing Company Code assignment for Controlling Area ${areaCode} uses a different local currency.`,
        'Correct the Company Code or Controlling Area Currency Key before adding another Company Code.',
      );
    }
    if (chartBaseline !== null && chartBaseline !== assignedChart) {
      throw new ControllingAreaCompanyAssignmentError(
        `Current Company Code assignments for Controlling Area ${areaCode} have inconsistent Operational Charts of Accounts.`,
        'Correct the current assignments before adding another Company Code; the CoA baseline is derived from the current assignment set.',
      );
    }
    chartBaseline = assignedChart;
  }
  return chartBaseline;
}

async function requireChartOfAccounts(tx: Tx, client: string, code: string, companyCodeKey: string) {
  const [chart] = await tx.select({ code: chartOfAccounts.chartOfAccounts })
    .from(chartOfAccounts)
    .where(and(
      eq(chartOfAccounts.client, client),
      eq(chartOfAccounts.chartOfAccounts, code),
    ))
    .limit(1);
  if (!chart) {
    throw new ControllingAreaCompanyAssignmentError(
      `Operational Chart of Accounts ${code} assigned to Company Code ${companyCodeKey} does not exist in this tenant.`,
      'Assign an existing tenant-local Operational Chart of Accounts before using OX19.',
    );
  }
}

async function requireFiscalYearVariant(tx: Tx, client: string, code: string, companyCodeKey: string) {
  const [variant] = await tx.select({ code: fiscalYearVariant.variant })
    .from(fiscalYearVariant)
    .where(and(
      eq(fiscalYearVariant.client, client),
      eq(fiscalYearVariant.variant, code),
    ))
    .limit(1);
  if (!variant) {
    throw new ControllingAreaCompanyAssignmentError(
      `Fiscal Year Variant ${code} assigned to Company Code ${companyCodeKey} does not exist in this tenant.`,
      'Assign an existing tenant-local Fiscal Year Variant before using OX19.',
    );
  }
}

/** `recordChange` suppresses unchanged before/after snapshots; duplicates are events, not state changes. */
async function recordDuplicateAssignmentEvent(
  tx: Tx,
  client: string,
  changedBy: string,
  areaCode: string,
  companyCodeKey: string,
) {
  const id = randomUUID();
  await tx.insert(changeDocument).values({
    id,
    client,
    objectClass: OBJECT_CLASS,
    objectKey: assignmentObjectKey(areaCode, companyCodeKey),
    changeType: 'CHANGE',
    transactionCode: ASSIGNMENT_ACTIVITY,
    reason: 'Duplicate assignment requested; the current mapping was unchanged.',
    changedBy,
  });
  await tx.insert(changeDocumentItem).values({
    id: randomUUID(),
    changeDocumentId: id,
    client,
    fieldName: 'assignmentOutcome',
    fieldLabel: 'Assignment outcome',
    oldValue: null,
    newValue: 'DUPLICATE_NO_OP',
    isSecurityRelevant: 'false',
  });
}

async function lockAssignmentResources(tx: Tx, client: string, areaCode: string, companyCodeKey: string) {
  // Company Code first, then the current and destination Controlling Area locks.
  // Source-setting updates use the same order; the area resource matches OKKP.
  await lockCompanyCodeOxxAssignments(tx, client, companyCodeKey, [areaCode]);
}

function assignmentObjectKey(areaCode: string, companyCodeKey: string) {
  return `${areaCode}/${companyCodeKey}`;
}

function normalizedValue(value: string | null | undefined) {
  const result = value?.trim();
  return result ? result : null;
}

function requiredValue(value: string | null | undefined, message: string, remedy: string) {
  const result = normalizedValue(value);
  if (!result) throw new ControllingAreaCompanyAssignmentError(message, remedy);
  return result;
}

function alreadyAssignedElsewhere(companyCodeKey: string, areaCode: string) {
  return new ControllingAreaCompanyAssignmentError(
    `Company Code ${companyCodeKey} is already assigned to Controlling Area ${areaCode}.`,
    'Unassign the Company Code from its current Controlling Area first; OX19 reassignment is two separate operations.',
  );
}

function invalidInput(error: z.ZodError): ControllingAreaCompanyAssignmentError {
  return new ControllingAreaCompanyAssignmentError(
    error.issues[0]?.message ?? 'The OX19 Company Code assignment input is invalid.',
    'Correct the indicated four-character Controlling Area or Company Code and submit again.',
  );
}

const ASSIGNMENT_FIELD_LABELS = {
  controllingArea: 'Controlling Area',
  companyCode: 'Company Code',
};
