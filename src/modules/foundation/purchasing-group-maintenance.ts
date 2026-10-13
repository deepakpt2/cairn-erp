/** Tenant-scoped Purchasing Group maintenance — SCR-019 overview table. */
import { and, asc, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { recordChange } from '../../platform/change';
import { withTenant, type Tx } from '../../platform/db/client';
import { markActivityComplete } from '../../platform/tenancy';
import { changeDocument } from '../../platform/tables/audit-trail';
import { purchasingGroup as purchasingGroupTable } from './schema';

const PURCHASING_GROUP_ACTIVITY = 'CFG.PROC.PURGROUP.DEFINE';
const PURCHASING_GROUP_OBJECT_CLASS = 'purchasing_group';

const tenantKeySchema = z.string().regex(/^[A-Za-z0-9]{2,4}$/);
const purchasingGroupCodeSchema = z.string().trim().toUpperCase().regex(/^[A-Z0-9]{3}$/);
const optionalReasonSchema = z
  .string()
  .trim()
  .max(500)
  .optional()
  .transform((value) => value || undefined);
const optionalText = (maximum: number) =>
  z.string().trim().max(maximum).optional().default('').transform((value) => value || null);
/** Fields visible in the table overview; organisational assignments are deliberately absent. */
export const purchasingGroupDefinitionValuesSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    telNoPurchGroup: optionalText(12),
    faxNumber: optionalText(31),
    telephone: optionalText(30),
    extension: optionalText(10),
    emailAddress: optionalText(241),
  })
  .strict();

const createChangeSchema = z.discriminatedUnion('mode', [
  z.object({
    mode: z.literal('CREATE'),
    purchasingGroup: purchasingGroupCodeSchema,
    expectedVersion: z.literal(0),
    values: purchasingGroupDefinitionValuesSchema,
  }).strict(),
  z.object({
    mode: z.literal('CHANGE'),
    purchasingGroup: purchasingGroupCodeSchema,
    expectedVersion: z.number().int().nonnegative(),
    values: purchasingGroupDefinitionValuesSchema,
  }).strict(),
  z.object({
    mode: z.literal('DELETE'),
    purchasingGroup: purchasingGroupCodeSchema,
    expectedVersion: z.number().int().nonnegative(),
  }).strict(),
]);

export const purchasingGroupChangeSetSchema = z
  .object({
    client: tenantKeySchema,
    changedBy: z.string().trim().min(1).max(60),
    reason: optionalReasonSchema,
    changes: z.array(createChangeSchema).min(1).max(100),
  })
  .strict();

const purchasingGroupVersionInputSchema = z
  .object({
    client: tenantKeySchema,
    purchasingGroup: purchasingGroupCodeSchema,
  })
  .strict();

export type PurchasingGroupDefinitionValues = z.output<typeof purchasingGroupDefinitionValuesSchema>;
export type PurchasingGroupChangeSetInput = z.input<typeof purchasingGroupChangeSetSchema>;
export type PurchasingGroupChangeOutcome = {
  purchasingGroup: string;
  mode: 'CREATE' | 'CHANGE' | 'DELETE';
  version: number;
  changed: boolean;
  values?: PurchasingGroupDefinitionValues;
};

type PurchasingGroupRow = typeof purchasingGroupTable.$inferSelect;
type PurchasingGroupDefinitionFields = Pick<
  PurchasingGroupRow,
  'name' | 'telNoPurchGroup' | 'faxNumber' | 'telephone' | 'extension' | 'emailAddress'
>;
type PurchasingGroupAuditFields = PurchasingGroupDefinitionFields & Pick<PurchasingGroupRow, 'isActive'>;

const DEFINITION_FIELDS: Array<keyof PurchasingGroupDefinitionFields> = [
  'name',
  'telNoPurchGroup',
  'faxNumber',
  'telephone',
  'extension',
  'emailAddress',
];

const FIELD_LABELS: Record<string, string> = {
  purchasingGroup: 'Purchasing Group',
  name: 'Description',
  telNoPurchGroup: 'Tel.No. Pur.Grp',
  faxNumber: 'Fax Number',
  telephone: 'Telephone',
  extension: 'Extension',
  emailAddress: 'E-Mail Address',
  isActive: 'Active',
};

export class PurchasingGroupMaintenanceError extends Error {
  readonly code = 'CAIRN_CONFIG';

  constructor(
    message: string,
    readonly remedy = 'Review the Purchasing Group entry and try again.',
  ) {
    super(message);
    this.name = 'PurchasingGroupMaintenanceError';
  }
}

function definitionFields(values: PurchasingGroupDefinitionValues): PurchasingGroupDefinitionFields {
  return {
    name: values.name,
    telNoPurchGroup: values.telNoPurchGroup,
    faxNumber: values.faxNumber,
    telephone: values.telephone,
    extension: values.extension,
    emailAddress: values.emailAddress,
  };
}

function auditSnapshot(code: string, fields: PurchasingGroupAuditFields) {
  return {
    purchasingGroup: code,
    name: fields.name,
    telNoPurchGroup: fields.telNoPurchGroup,
    faxNumber: fields.faxNumber,
    telephone: fields.telephone,
    extension: fields.extension,
    emailAddress: fields.emailAddress,
    isActive: fields.isActive,
  };
}

function sameDefinition(before: PurchasingGroupRow, after: PurchasingGroupDefinitionFields): boolean {
  return DEFINITION_FIELDS.every((field) => before[field] === after[field]);
}

function purchasingGroupWhere(client: string, code: string) {
  return and(
    eq(purchasingGroupTable.client, client),
    eq(purchasingGroupTable.purchasingGroup, code),
  );
}

/** Existing seeded rows have no integer version column; their audit-document count is the optimistic token. */
async function purchasingGroupAuditVersion(tx: Tx, client: string, code: string): Promise<number> {
  const [row] = await tx
    .select({ version: sql<number>`count(*)::int` })
    .from(changeDocument)
    .where(
      and(
        eq(changeDocument.client, client),
        eq(changeDocument.objectClass, PURCHASING_GROUP_OBJECT_CLASS),
        eq(changeDocument.objectKey, code),
      ),
    );
  return row?.version ?? 0;
}

/** Load the whole tenant view with audit-backed versions; no Purchasing Organisation filter is applied. */
export async function listPurchasingGroupDefinitions(client: string) {
  return withTenant(client, async (tx) => {
    const rows = await tx
      .select()
      .from(purchasingGroupTable)
      .where(eq(purchasingGroupTable.client, client))
      .orderBy(asc(purchasingGroupTable.purchasingGroup));
    const historyRows = await tx
      .select({
        objectKey: changeDocument.objectKey,
        version: sql<number>`count(*)::int`,
      })
      .from(changeDocument)
      .where(
        and(
          eq(changeDocument.client, client),
          eq(changeDocument.objectClass, PURCHASING_GROUP_OBJECT_CLASS),
        ),
      )
      .groupBy(changeDocument.objectKey);
    const versions = new Map(historyRows.map((row) => [row.objectKey, row.version]));

    return rows.map((row) => ({
      purchasingGroup: row.purchasingGroup,
      name: row.name,
      telNoPurchGroup: row.telNoPurchGroup ?? '',
      faxNumber: row.faxNumber ?? '',
      telephone: row.telephone ?? '',
      extension: row.extension ?? '',
      emailAddress: row.emailAddress ?? '',
      version: versions.get(row.purchasingGroup) ?? 0,
    }));
  });
}

/** Read the audit-backed version for one existing or previously deleted tenant key. */
export async function getPurchasingGroupDefinitionVersion(client: string, code: string): Promise<number> {
  const parsed = purchasingGroupVersionInputSchema.safeParse({ client, purchasingGroup: code });
  if (!parsed.success) {
    throw new PurchasingGroupMaintenanceError(
      parsed.error.issues[0]?.message ?? 'Purchasing Group key is invalid.',
      'Check the tenant and three-character Purchasing Group key.',
    );
  }
  return withTenant(parsed.data.client, (tx) =>
    purchasingGroupAuditVersion(tx, parsed.data.client, parsed.data.purchasingGroup),
  );
}

async function lockPurchasingGroup(tx: Tx, client: string, code: string): Promise<void> {
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${`${client}/purchasing_group/${code}`}, 0))`,
  );
}

function invalidInput(error: z.ZodError): PurchasingGroupMaintenanceError {
  return new PurchasingGroupMaintenanceError(
    error.issues[0]?.message ?? 'Purchasing Group change set is invalid.',
    'Correct the indicated code, description or contact field and submit again.',
  );
}

function staleVersion(code: string): PurchasingGroupMaintenanceError {
  return new PurchasingGroupMaintenanceError(
    `Purchasing Group ${code} changed after it was opened.`,
    'Reload the current Purchasing Groups overview before saving your changes.',
  );
}

function missingGroup(code: string): PurchasingGroupMaintenanceError {
  return new PurchasingGroupMaintenanceError(
    `Purchasing Group ${code} does not exist in this tenant.`,
    'Return to the Purchasing Groups overview and reload the current entries.',
  );
}

function hasSqlState(error: unknown, state: string): boolean {
  let candidate: unknown = error;
  while (candidate && typeof candidate === 'object') {
    const record = candidate as { code?: unknown; cause?: unknown };
    if (record.code === state) return true;
    candidate = record.cause;
  }
  return false;
}

/**
 * Atomically save all pending table rows. New definitions never receive a Purchasing Organisation,
 * Company Code, Plant or responsible-buyer assignment; legacy compatibility fields are untouched
 * on changes so existing purchasing consumers keep their current behaviour.
 */
export async function savePurchasingGroupChanges(raw: PurchasingGroupChangeSetInput) {
  const parsed = purchasingGroupChangeSetSchema.safeParse(raw);
  if (!parsed.success) throw invalidInput(parsed.error);

  const { client, changedBy, changes, reason } = parsed.data;
  const codes = changes.map((change) => change.purchasingGroup);
  if (new Set(codes).size !== codes.length) {
    throw new PurchasingGroupMaintenanceError(
      'A Purchasing Group key can appear only once in a save request.',
      'Save one change per three-character key, then retry.',
    );
  }

  let deletingCode: string | undefined;
  try {
    return await withTenant(client, async (tx) => {
      // Lock in key order so two multi-row saves cannot deadlock while taking the same set of keys.
      for (const code of [...codes].sort()) await lockPurchasingGroup(tx, client, code);

      const outcomes: PurchasingGroupChangeOutcome[] = [];
      let changedCount = 0;

      for (const change of changes) {
        const code = change.purchasingGroup;
        const [current] = await tx
          .select()
          .from(purchasingGroupTable)
          .where(purchasingGroupWhere(client, code))
          .for('update');
        const version = await purchasingGroupAuditVersion(tx, client, code);

        if (change.mode === 'CREATE') {
          if (current) {
            throw new PurchasingGroupMaintenanceError(
              `Purchasing Group ${code} already exists.`,
              'Choose an unused three-character key. New Entries never changes an existing row.',
            );
          }
          if (change.expectedVersion !== 0 || version !== 0) {
            throw new PurchasingGroupMaintenanceError(
              `Purchasing Group ${code} has prior change history and cannot be reused.`,
              'Choose a new key so deleted-key history remains unambiguous.',
            );
          }
          const fields = definitionFields(change.values);
          await tx.insert(purchasingGroupTable).values({
            client,
            purchasingGroup: code,
            ...fields,
            // New definitions are standalone. Do not populate the legacy scope fields.
            purchasingOrg: null,
            responsibleBuyer: null,
            isActive: true,
            createdBy: changedBy,
          });
          const changeId = await recordChange(tx, {
            client,
            objectClass: PURCHASING_GROUP_OBJECT_CLASS,
            objectKey: code,
            changeType: 'CREATE',
            changedBy,
            transactionCode: PURCHASING_GROUP_ACTIVITY,
            reason,
            after: auditSnapshot(code, { ...fields, isActive: true }),
            fieldLabels: FIELD_LABELS,
          });
          if (!changeId) {
            throw new PurchasingGroupMaintenanceError(
              'Purchasing Group creation could not be recorded in change history.',
              'Retry the save. If the problem continues, contact an administrator.',
            );
          }
          outcomes.push({ purchasingGroup: code, mode: 'CREATE', version: version + 1, changed: true, values: fields });
          changedCount++;
          continue;
        }

        if (!current) throw missingGroup(code);
        if (change.expectedVersion !== version) throw staleVersion(code);

        if (change.mode === 'CHANGE') {
          const fields = definitionFields(change.values);
          if (sameDefinition(current, fields)) {
            outcomes.push({ purchasingGroup: code, mode: 'CHANGE', version, changed: false, values: fields });
            continue;
          }

          await tx
            .update(purchasingGroupTable)
            .set({ ...fields, changedBy, changedAt: new Date() })
            .where(purchasingGroupWhere(client, code));
          const changeId = await recordChange(tx, {
            client,
            objectClass: PURCHASING_GROUP_OBJECT_CLASS,
            objectKey: code,
            changeType: 'CHANGE',
            changedBy,
            transactionCode: PURCHASING_GROUP_ACTIVITY,
            reason,
            before: auditSnapshot(code, current),
            after: auditSnapshot(code, { ...fields, isActive: current.isActive }),
            fieldLabels: FIELD_LABELS,
          });
          if (!changeId) {
            throw new PurchasingGroupMaintenanceError(
              'Purchasing Group changes could not be recorded in change history.',
              'Retry the save. If the problem continues, contact an administrator.',
            );
          }
          outcomes.push({ purchasingGroup: code, mode: 'CHANGE', version: version + 1, changed: true, values: fields });
          changedCount++;
          continue;
        }

        deletingCode = code;
        const changeId = await recordChange(tx, {
          client,
          objectClass: PURCHASING_GROUP_OBJECT_CLASS,
          objectKey: code,
          changeType: 'DELETE',
          changedBy,
          transactionCode: PURCHASING_GROUP_ACTIVITY,
          reason,
          before: auditSnapshot(code, current),
          fieldLabels: FIELD_LABELS,
        });
        if (!changeId) {
          throw new PurchasingGroupMaintenanceError(
            'Purchasing Group deletion could not be recorded in change history.',
            'Retry the delete. If the problem continues, contact an administrator.',
          );
        }
        await tx.delete(purchasingGroupTable).where(purchasingGroupWhere(client, code));
        outcomes.push({ purchasingGroup: code, mode: 'DELETE', version: version + 1, changed: true });
        changedCount++;
      }

      await markActivityComplete(tx, client, PURCHASING_GROUP_ACTIVITY, changedBy);
      return { outcomes, changedCount };
    });
  } catch (error) {
    if (deletingCode && hasSqlState(error, '23503')) {
      const code = deletingCode;
      throw new PurchasingGroupMaintenanceError(
        `Purchasing Group ${code} cannot be deleted while Material or Supplier purchasing records reference it.`,
        'Remove or replace the referencing purchasing assignments before deleting this group.',
      );
    }
    throw error;
  }
}
