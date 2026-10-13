/** Audited tenant-scoped Purchasing Organisation definition — SCR-017 / D-092. */
import { and, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { recordChange } from '../../platform/change';
import { withTenant, type Tx } from '../../platform/db/client';
import { markActivityComplete } from '../../platform/tenancy';
import { changeDocument } from '../../platform/tables/audit-trail';
import { purchasingOrg as purchasingOrgTable } from './schema';

const PURCHASING_ORG_ACTIVITY = 'CFG.PROC.PURORG.DEFINE';
const PURCHASING_ORG_OBJECT_CLASS = 'purchasing_org';

const tenantKeySchema = z.string().regex(/^[A-Za-z0-9]{2,4}$/);
const purchasingOrgCodeSchema = z.string().trim().regex(/^[A-Z0-9]{2,10}$/);
const optionalReasonSchema = z
  .string()
  .trim()
  .max(500)
  .optional()
  .transform((value) => value || undefined);

/** OX08 owns only the immutable organisation code and its required name. */
export const purchasingOrgDefinitionValuesSchema = z
  .object({
    name: z.string().trim().min(1).max(160),
  })
  .strict();

export const purchasingOrgMaintenanceModeSchema = z.enum(['CREATE', 'CHANGE']);

/** Tenant and actor are service inputs; a future protected action must derive both from its session. */
export const purchasingOrgMaintenanceInputSchema = z
  .object({
    client: tenantKeySchema,
    changedBy: z.string().trim().min(1).max(60),
    mode: purchasingOrgMaintenanceModeSchema,
    purchasingOrg: purchasingOrgCodeSchema,
    expectedVersion: z.number().int().nonnegative(),
    reason: optionalReasonSchema,
    values: purchasingOrgDefinitionValuesSchema,
  })
  .strict();

export const purchasingOrgDeactivationInputSchema = z
  .object({
    client: tenantKeySchema,
    changedBy: z.string().trim().min(1).max(60),
    purchasingOrg: purchasingOrgCodeSchema,
    expectedVersion: z.number().int().nonnegative(),
    reason: optionalReasonSchema,
  })
  .strict();

const purchasingOrgVersionInputSchema = z
  .object({
    client: tenantKeySchema,
    purchasingOrg: purchasingOrgCodeSchema,
  })
  .strict();

export type PurchasingOrgDefinitionValuesInput = z.input<typeof purchasingOrgDefinitionValuesSchema>;
export type PurchasingOrgDefinitionValues = z.output<typeof purchasingOrgDefinitionValuesSchema>;
export type PurchasingOrgMaintenanceMode = z.infer<typeof purchasingOrgMaintenanceModeSchema>;
export type PurchasingOrgMaintenanceInput = z.input<typeof purchasingOrgMaintenanceInputSchema>;
export type PurchasingOrgDeactivationInput = z.input<typeof purchasingOrgDeactivationInputSchema>;

type PurchasingOrgRow = typeof purchasingOrgTable.$inferSelect;
type PurchasingOrgDefinitionFields = Pick<PurchasingOrgRow, 'name'>;
type PurchasingOrgAuditFields = PurchasingOrgDefinitionFields & Pick<PurchasingOrgRow, 'isActive'>;

const DEFINITION_FIELDS: Array<keyof PurchasingOrgDefinitionFields> = ['name'];
const FIELD_LABELS: Record<string, string> = {
  purchasingOrg: 'Purchasing Organisation code',
  name: 'Name',
  isActive: 'Active',
};

export class PurchasingOrgMaintenanceError extends Error {
  readonly code = 'CAIRN_CONFIG';

  constructor(
    message: string,
    readonly remedy = 'Review the Purchasing Organisation definition and try again.',
  ) {
    super(message);
    this.name = 'PurchasingOrgMaintenanceError';
  }
}

function definitionFields(values: PurchasingOrgDefinitionValues): PurchasingOrgDefinitionFields {
  return { name: values.name };
}

function auditSnapshot(code: string, fields: PurchasingOrgAuditFields) {
  // Company Code and Plant links belong to their separate assignment activities.
  return { purchasingOrg: code, name: fields.name, isActive: fields.isActive };
}

function sameDefinition(before: PurchasingOrgRow, after: PurchasingOrgDefinitionFields): boolean {
  return DEFINITION_FIELDS.every((field) => before[field] === after[field]);
}

function purchasingOrgWhere(client: string, code: string) {
  return and(
    eq(purchasingOrgTable.client, client),
    eq(purchasingOrgTable.purchasingOrg, code),
  );
}

/** Existing Purchasing Organisation rows have no integer version column; use their audit count. */
async function purchasingOrgAuditVersion(tx: Tx, client: string, code: string): Promise<number> {
  const [row] = await tx
    .select({ version: sql<number>`count(*)::int` })
    .from(changeDocument)
    .where(
      and(
        eq(changeDocument.client, client),
        eq(changeDocument.objectClass, PURCHASING_ORG_OBJECT_CLASS),
        eq(changeDocument.objectKey, code),
      ),
    );

  return row?.version ?? 0;
}

/** Read the optimistic change-document-count version for an existing tenant Purchasing Organisation. */
export async function getPurchasingOrgDefinitionVersion(client: string, code: string): Promise<number> {
  const parsed = purchasingOrgVersionInputSchema.safeParse({ client, purchasingOrg: code });
  if (!parsed.success) {
    throw new PurchasingOrgMaintenanceError(
      parsed.error.issues[0]?.message ?? 'Purchasing Organisation key is invalid.',
      'Check the tenant and Purchasing Organisation code.',
    );
  }

  return withTenant(parsed.data.client, (tx) =>
    purchasingOrgAuditVersion(tx, parsed.data.client, parsed.data.purchasingOrg),
  );
}

async function lockPurchasingOrg(tx: Tx, client: string, code: string): Promise<void> {
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${`${client}/purchasing_org/${code}`}, 0))`,
  );
}

function invalidInput(error: z.ZodError): PurchasingOrgMaintenanceError {
  return new PurchasingOrgMaintenanceError(
    error.issues[0]?.message ?? 'Purchasing Organisation definition is invalid.',
    'Correct the indicated value and submit the definition again.',
  );
}

function staleVersion(code: string): PurchasingOrgMaintenanceError {
  return new PurchasingOrgMaintenanceError(
    `Purchasing Organisation ${code} changed after it was opened.`,
    'Reload the current definition before saving your changes.',
  );
}

/** Create one unassigned organisation or change its name; its code is immutable after creation. */
export async function savePurchasingOrgDefinition(raw: PurchasingOrgMaintenanceInput) {
  const parsed = purchasingOrgMaintenanceInputSchema.safeParse(raw);
  if (!parsed.success) throw invalidInput(parsed.error);

  const { client, changedBy, mode, purchasingOrg: code, expectedVersion, reason, values } = parsed.data;
  const fields = definitionFields(values);

  return withTenant(client, async (tx) => {
    // Serialize first-time duplicate attempts, for which no row can be locked yet.
    await lockPurchasingOrg(tx, client, code);
    const [current] = await tx
      .select()
      .from(purchasingOrgTable)
      .where(purchasingOrgWhere(client, code))
      .for('update');
    const version = await purchasingOrgAuditVersion(tx, client, code);

    if (mode === 'CREATE') {
      if (current) {
        throw new PurchasingOrgMaintenanceError(
          `Purchasing Organisation ${code} already exists.`,
          'Choose an unused code. Create never changes an existing definition, including an inactive one.',
        );
      }
      if (expectedVersion !== 0 || version !== 0) throw staleVersion(code);

      await tx.insert(purchasingOrgTable).values({
        client,
        purchasingOrg: code,
        ...fields,
        companyCode: null,
        isActive: true,
        createdBy: changedBy,
      });

      const changeId = await recordChange(tx, {
        client,
        objectClass: PURCHASING_ORG_OBJECT_CLASS,
        objectKey: code,
        changeType: 'CREATE',
        changedBy,
        transactionCode: PURCHASING_ORG_ACTIVITY,
        reason,
        after: auditSnapshot(code, { ...fields, isActive: true }),
        securityRelevantFields: ['isActive'],
        fieldLabels: FIELD_LABELS,
      });
      if (!changeId) {
        throw new PurchasingOrgMaintenanceError(
          'Purchasing Organisation creation could not be recorded in change history.',
          'Retry the definition. If the problem continues, contact an administrator.',
        );
      }

      await markActivityComplete(tx, client, PURCHASING_ORG_ACTIVITY, changedBy);
      return {
        purchasingOrg: code,
        created: true as const,
        changed: true as const,
        isActive: true,
        version: version + 1,
      };
    }

    if (!current) {
      throw new PurchasingOrgMaintenanceError(
        `Purchasing Organisation ${code} does not exist in this tenant.`,
        'Return to the Purchasing Organisation list and choose an existing definition to change.',
      );
    }
    if (expectedVersion !== version) throw staleVersion(code);

    if (sameDefinition(current, fields)) {
      await markActivityComplete(tx, client, PURCHASING_ORG_ACTIVITY, changedBy);
      return {
        purchasingOrg: code,
        created: false as const,
        changed: false as const,
        isActive: current.isActive,
        version,
      };
    }

    await tx
      .update(purchasingOrgTable)
      .set({ name: fields.name, changedBy, changedAt: new Date() })
      .where(purchasingOrgWhere(client, code));

    const changeId = await recordChange(tx, {
      client,
      objectClass: PURCHASING_ORG_OBJECT_CLASS,
      objectKey: code,
      changeType: 'CHANGE',
      changedBy,
      transactionCode: PURCHASING_ORG_ACTIVITY,
      reason,
      before: auditSnapshot(code, current),
      after: auditSnapshot(code, { ...fields, isActive: current.isActive }),
      securityRelevantFields: ['isActive'],
      fieldLabels: FIELD_LABELS,
    });
    if (!changeId) {
      throw new PurchasingOrgMaintenanceError(
        'Purchasing Organisation changes could not be recorded in change history.',
        'Retry the definition. If the problem continues, contact an administrator.',
      );
    }

    await markActivityComplete(tx, client, PURCHASING_ORG_ACTIVITY, changedBy);
    return {
      purchasingOrg: code,
      created: false as const,
      changed: true as const,
      isActive: current.isActive,
      version: version + 1,
    };
  });
}

/** Soft-deactivate while retaining the organisation, assignments, supplier data and history. */
export async function deactivatePurchasingOrg(raw: PurchasingOrgDeactivationInput) {
  const parsed = purchasingOrgDeactivationInputSchema.safeParse(raw);
  if (!parsed.success) throw invalidInput(parsed.error);

  const { client, changedBy, purchasingOrg: code, expectedVersion, reason } = parsed.data;
  return withTenant(client, async (tx) => {
    await lockPurchasingOrg(tx, client, code);
    const [current] = await tx
      .select()
      .from(purchasingOrgTable)
      .where(purchasingOrgWhere(client, code))
      .for('update');
    if (!current) {
      throw new PurchasingOrgMaintenanceError(
        `Purchasing Organisation ${code} does not exist in this tenant.`,
        'Return to the Purchasing Organisation list and choose an existing definition to deactivate.',
      );
    }

    const version = await purchasingOrgAuditVersion(tx, client, code);
    if (expectedVersion !== version) throw staleVersion(code);
    if (!current.isActive) {
      await markActivityComplete(tx, client, PURCHASING_ORG_ACTIVITY, changedBy);
      return { purchasingOrg: code, changed: false as const, isActive: false, version };
    }

    await tx
      .update(purchasingOrgTable)
      .set({ isActive: false, changedBy, changedAt: new Date() })
      .where(purchasingOrgWhere(client, code));

    const changeId = await recordChange(tx, {
      client,
      objectClass: PURCHASING_ORG_OBJECT_CLASS,
      objectKey: code,
      changeType: 'CHANGE',
      changedBy,
      transactionCode: PURCHASING_ORG_ACTIVITY,
      reason,
      before: auditSnapshot(code, current),
      after: auditSnapshot(code, { name: current.name, isActive: false }),
      securityRelevantFields: ['isActive'],
      fieldLabels: FIELD_LABELS,
    });
    if (!changeId) {
      throw new PurchasingOrgMaintenanceError(
        'Purchasing Organisation deactivation could not be recorded in change history.',
        'Retry deactivation. If the problem continues, contact an administrator.',
      );
    }

    await markActivityComplete(tx, client, PURCHASING_ORG_ACTIVITY, changedBy);
    return { purchasingOrg: code, changed: true as const, isActive: false, version: version + 1 };
  });
}
