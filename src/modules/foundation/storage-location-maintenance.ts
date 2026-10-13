/** Audited tenant-scoped Storage Location create/change/deactivate — SCR-016 / D-091. */
import { and, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { recordChange } from '../../platform/change';
import { withTenant, type Tx } from '../../platform/db/client';
import { markActivityComplete } from '../../platform/tenancy';
import { changeDocument } from '../../platform/tables/audit-trail';
import { plant, storageLocation as storageLocationTable } from './schema';

const STORAGE_LOCATION_ACTIVITY = 'CFG.ORG.STORAGELOC.DEFINE';
const STORAGE_LOCATION_OBJECT_CLASS = 'storage_location';

const tenantKeySchema = z.string().regex(/^[A-Za-z0-9]{2,4}$/);
const plantCodeSchema = z.string().trim().min(1).max(10);
const storageLocationCodeSchema = z.string().trim().min(1).max(10);
const optionalReasonSchema = z
  .string()
  .trim()
  .max(500)
  .optional()
  .transform((value) => value || undefined);

/** Only the approved definition fields are accepted; activity and tenant data stay separate. */
export const storageLocationDefinitionValuesSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    /** Persisted configuration only; no stock-movement behavior is implemented here. */
    allowNegativeStock: z.boolean().default(false),
  })
  .strict();

export const storageLocationMaintenanceModeSchema = z.enum(['CREATE', 'CHANGE']);

/** Tenant and actor are service inputs; the protected action derives both from its verified session. */
export const storageLocationMaintenanceInputSchema = z
  .object({
    client: tenantKeySchema,
    changedBy: z.string().trim().min(1).max(60),
    mode: storageLocationMaintenanceModeSchema,
    plant: plantCodeSchema,
    storageLocation: storageLocationCodeSchema,
    expectedVersion: z.number().int().nonnegative(),
    reason: optionalReasonSchema,
    values: storageLocationDefinitionValuesSchema,
  })
  .strict();

export const storageLocationDeactivationInputSchema = z
  .object({
    client: tenantKeySchema,
    changedBy: z.string().trim().min(1).max(60),
    plant: plantCodeSchema,
    storageLocation: storageLocationCodeSchema,
    expectedVersion: z.number().int().nonnegative(),
    reason: optionalReasonSchema,
  })
  .strict();

const storageLocationVersionInputSchema = z
  .object({
    client: tenantKeySchema,
    plant: plantCodeSchema,
    storageLocation: storageLocationCodeSchema,
  })
  .strict();

export type StorageLocationDefinitionValuesInput = z.input<typeof storageLocationDefinitionValuesSchema>;
export type StorageLocationDefinitionValues = z.output<typeof storageLocationDefinitionValuesSchema>;
export type StorageLocationMaintenanceMode = z.infer<typeof storageLocationMaintenanceModeSchema>;
export type StorageLocationMaintenanceInput = z.input<typeof storageLocationMaintenanceInputSchema>;
export type StorageLocationDeactivationInput = z.input<typeof storageLocationDeactivationInputSchema>;

export class StorageLocationMaintenanceError extends Error {
  readonly code = 'CAIRN_CONFIG';

  constructor(
    message: string,
    readonly remedy = 'Review the Storage Location definition and try again.',
  ) {
    super(message);
    this.name = 'StorageLocationMaintenanceError';
  }
}

type StorageLocationRow = typeof storageLocationTable.$inferSelect;
type StorageLocationDefinitionFields = Pick<StorageLocationRow, 'name' | 'allowNegativeStock'>;
type StorageLocationAuditFields = StorageLocationDefinitionFields & Pick<StorageLocationRow, 'isActive'>;

const DEFINITION_FIELDS: Array<keyof StorageLocationDefinitionFields> = ['name', 'allowNegativeStock'];

const FIELD_LABELS: Record<string, string> = {
  plant: 'Plant code',
  storageLocation: 'Storage Location code',
  name: 'Name',
  allowNegativeStock: 'Allow negative stock (stored configuration only)',
  isActive: 'Active',
};

function definitionFields(values: StorageLocationDefinitionValues): StorageLocationDefinitionFields {
  return {
    name: values.name,
    allowNegativeStock: values.allowNegativeStock,
  };
}

function objectKey(plantCode: string, storageLocationCode: string): string {
  // Length-prefixing keeps the composite audit key unambiguous without imposing a code alphabet.
  return `${plantCode.length}:${plantCode}${storageLocationCode.length}:${storageLocationCode}`;
}

function auditSnapshot(
  plantCode: string,
  storageLocationCode: string,
  fields: StorageLocationAuditFields,
) {
  return {
    plant: plantCode,
    storageLocation: storageLocationCode,
    name: fields.name,
    allowNegativeStock: fields.allowNegativeStock,
    isActive: fields.isActive,
  };
}

function sameDefinition(before: StorageLocationRow, after: StorageLocationDefinitionFields): boolean {
  return DEFINITION_FIELDS.every((field) => before[field] === after[field]);
}

function storageLocationWhere(client: string, plantCode: string, storageLocationCode: string) {
  return and(
    eq(storageLocationTable.client, client),
    eq(storageLocationTable.plant, plantCode),
    eq(storageLocationTable.storageLocation, storageLocationCode),
  );
}

/**
 * Storage Location has no integer version column. Its per-object change-document count is
 * the optimistic token; seeded rows without maintenance history begin at version 0.
 */
async function storageLocationAuditVersion(
  tx: Tx,
  client: string,
  plantCode: string,
  storageLocationCode: string,
): Promise<number> {
  const [row] = await tx
    .select({ version: sql<number>`count(*)::int` })
    .from(changeDocument)
    .where(
      and(
        eq(changeDocument.client, client),
        eq(changeDocument.objectClass, STORAGE_LOCATION_OBJECT_CLASS),
        eq(changeDocument.objectKey, objectKey(plantCode, storageLocationCode)),
      ),
    );

  return row?.version ?? 0;
}

/** Read the optimistic change-document-count token for an existing tenant Storage Location. */
export async function getStorageLocationVersion(
  client: string,
  plantCode: string,
  storageLocationCode: string,
): Promise<number> {
  const parsed = storageLocationVersionInputSchema.safeParse({
    client,
    plant: plantCode,
    storageLocation: storageLocationCode,
  });
  if (!parsed.success) {
    throw new StorageLocationMaintenanceError(
      parsed.error.issues[0]?.message ?? 'Storage Location key is invalid.',
      'Check the tenant, Plant and Storage Location codes.',
    );
  }

  const input = parsed.data;
  return withTenant(input.client, (tx) =>
    storageLocationAuditVersion(tx, input.client, input.plant, input.storageLocation),
  );
}

async function lockStorageLocation(
  tx: Tx,
  client: string,
  plantCode: string,
  storageLocationCode: string,
): Promise<void> {
  const key = `${client}/storage_location/${objectKey(plantCode, storageLocationCode)}`;
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${key}, 0))`);
}

async function requireActivePlant(tx: Tx, client: string, plantCode: string): Promise<void> {
  const [parent] = await tx
    .select({ plant: plant.plant, isActive: plant.isActive })
    .from(plant)
    .where(and(eq(plant.client, client), eq(plant.plant, plantCode)))
    .for('update');

  if (!parent) {
    throw new StorageLocationMaintenanceError(
      `Plant ${plantCode} does not exist in this tenant.`,
      'Choose an existing Plant in the signed-in tenant.',
    );
  }
  if (!parent.isActive) {
    throw new StorageLocationMaintenanceError(
      `Plant ${plantCode} is inactive.`,
      'Choose an active Plant before creating a Storage Location.',
    );
  }
}

function invalidInput(error: z.ZodError): StorageLocationMaintenanceError {
  return new StorageLocationMaintenanceError(
    error.issues[0]?.message ?? 'Storage Location input is invalid.',
    'Correct the indicated value and submit the definition again.',
  );
}

function staleVersion(plantCode: string, storageLocationCode: string): StorageLocationMaintenanceError {
  return new StorageLocationMaintenanceError(
    `Storage Location ${storageLocationCode} in Plant ${plantCode} changed after it was opened.`,
    'Reload the current Storage Location definition before saving your changes.',
  );
}

/** Create one Storage Location or maintain its approved definition fields. */
export async function saveStorageLocation(raw: StorageLocationMaintenanceInput) {
  const parsed = storageLocationMaintenanceInputSchema.safeParse(raw);
  if (!parsed.success) throw invalidInput(parsed.error);

  const {
    client,
    changedBy,
    mode,
    plant: plantCode,
    storageLocation: storageLocationCode,
    expectedVersion,
    reason,
    values,
  } = parsed.data;
  const fields = definitionFields(values);

  return withTenant(client, async (tx) => {
    // The advisory lock serializes first-time creates, for which no row can be locked yet.
    await lockStorageLocation(tx, client, plantCode, storageLocationCode);
    const [current] = await tx
      .select()
      .from(storageLocationTable)
      .where(storageLocationWhere(client, plantCode, storageLocationCode))
      .for('update');
    const version = await storageLocationAuditVersion(tx, client, plantCode, storageLocationCode);

    if (mode === 'CREATE') {
      if (current) {
        throw new StorageLocationMaintenanceError(
          `Storage Location ${storageLocationCode} already exists in Plant ${plantCode}.`,
          'Choose an unused Storage Location code. Create never changes an existing definition.',
        );
      }
      if (expectedVersion !== 0 || version !== 0) {
        throw staleVersion(plantCode, storageLocationCode);
      }

      // Company Code is not consulted: the prerequisite is an active Plant in this tenant.
      await requireActivePlant(tx, client, plantCode);
      await tx.insert(storageLocationTable).values({
        client,
        plant: plantCode,
        storageLocation: storageLocationCode,
        ...fields,
        isActive: true,
        createdBy: changedBy,
      });

      const changeId = await recordChange(tx, {
        client,
        objectClass: STORAGE_LOCATION_OBJECT_CLASS,
        objectKey: objectKey(plantCode, storageLocationCode),
        changeType: 'CREATE',
        changedBy,
        transactionCode: STORAGE_LOCATION_ACTIVITY,
        reason,
        after: auditSnapshot(plantCode, storageLocationCode, { ...fields, isActive: true }),
        securityRelevantFields: ['allowNegativeStock', 'isActive'],
        fieldLabels: FIELD_LABELS,
      });
      if (!changeId) {
        throw new StorageLocationMaintenanceError(
          'Storage Location creation could not be recorded in change history.',
          'Retry the definition. If the problem continues, contact an administrator.',
        );
      }

      await markActivityComplete(tx, client, STORAGE_LOCATION_ACTIVITY, changedBy);
      return {
        plant: plantCode,
        storageLocation: storageLocationCode,
        created: true as const,
        changed: true as const,
        isActive: true,
        version: version + 1,
      };
    }

    if (!current) {
      throw new StorageLocationMaintenanceError(
        `Storage Location ${storageLocationCode} does not exist in Plant ${plantCode} in this tenant.`,
        'Return to the Storage Location list and choose an existing definition to change.',
      );
    }
    if (expectedVersion !== version) throw staleVersion(plantCode, storageLocationCode);

    if (sameDefinition(current, fields)) {
      await markActivityComplete(tx, client, STORAGE_LOCATION_ACTIVITY, changedBy);
      return {
        plant: plantCode,
        storageLocation: storageLocationCode,
        created: false as const,
        changed: false as const,
        isActive: current.isActive,
        version,
      };
    }

    await tx
      .update(storageLocationTable)
      .set({
        ...fields,
        changedBy,
        changedAt: new Date(),
      })
      .where(storageLocationWhere(client, plantCode, storageLocationCode));

    const changeId = await recordChange(tx, {
      client,
      objectClass: STORAGE_LOCATION_OBJECT_CLASS,
      objectKey: objectKey(plantCode, storageLocationCode),
      changeType: 'CHANGE',
      changedBy,
      transactionCode: STORAGE_LOCATION_ACTIVITY,
      reason,
      before: auditSnapshot(plantCode, storageLocationCode, current),
      after: auditSnapshot(plantCode, storageLocationCode, { ...fields, isActive: current.isActive }),
      securityRelevantFields: ['allowNegativeStock', 'isActive'],
      fieldLabels: FIELD_LABELS,
    });
    if (!changeId) {
      throw new StorageLocationMaintenanceError(
        'Storage Location changes could not be recorded in change history.',
        'Retry the definition. If the problem continues, contact an administrator.',
      );
    }

    await markActivityComplete(tx, client, STORAGE_LOCATION_ACTIVITY, changedBy);
    return {
      plant: plantCode,
      storageLocation: storageLocationCode,
      created: false as const,
      changed: true as const,
      isActive: current.isActive,
      version: version + 1,
    };
  });
}

/** Non-destructively deactivate a Storage Location while retaining its row and audit history. */
export async function deactivateStorageLocation(raw: StorageLocationDeactivationInput) {
  const parsed = storageLocationDeactivationInputSchema.safeParse(raw);
  if (!parsed.success) throw invalidInput(parsed.error);

  const {
    client,
    changedBy,
    plant: plantCode,
    storageLocation: storageLocationCode,
    expectedVersion,
    reason,
  } = parsed.data;

  return withTenant(client, async (tx) => {
    await lockStorageLocation(tx, client, plantCode, storageLocationCode);
    const [current] = await tx
      .select()
      .from(storageLocationTable)
      .where(storageLocationWhere(client, plantCode, storageLocationCode))
      .for('update');
    if (!current) {
      throw new StorageLocationMaintenanceError(
        `Storage Location ${storageLocationCode} does not exist in Plant ${plantCode} in this tenant.`,
        'Return to the Storage Location list and choose an existing definition to deactivate.',
      );
    }

    const version = await storageLocationAuditVersion(tx, client, plantCode, storageLocationCode);
    if (expectedVersion !== version) throw staleVersion(plantCode, storageLocationCode);
    if (!current.isActive) {
      await markActivityComplete(tx, client, STORAGE_LOCATION_ACTIVITY, changedBy);
      return {
        plant: plantCode,
        storageLocation: storageLocationCode,
        changed: false as const,
        isActive: false,
        version,
      };
    }

    await tx
      .update(storageLocationTable)
      .set({
        isActive: false,
        changedBy,
        changedAt: new Date(),
      })
      .where(storageLocationWhere(client, plantCode, storageLocationCode));

    const changeId = await recordChange(tx, {
      client,
      objectClass: STORAGE_LOCATION_OBJECT_CLASS,
      objectKey: objectKey(plantCode, storageLocationCode),
      changeType: 'CHANGE',
      changedBy,
      transactionCode: STORAGE_LOCATION_ACTIVITY,
      reason,
      before: auditSnapshot(plantCode, storageLocationCode, current),
      after: auditSnapshot(plantCode, storageLocationCode, { ...current, isActive: false }),
      securityRelevantFields: ['isActive'],
      fieldLabels: FIELD_LABELS,
    });
    if (!changeId) {
      throw new StorageLocationMaintenanceError(
        'Storage Location deactivation could not be recorded in change history.',
        'Retry deactivation. If the problem continues, contact an administrator.',
      );
    }

    await markActivityComplete(tx, client, STORAGE_LOCATION_ACTIVITY, changedBy);
    return {
      plant: plantCode,
      storageLocation: storageLocationCode,
      changed: true as const,
      isActive: false,
      version: version + 1,
    };
  });
}
