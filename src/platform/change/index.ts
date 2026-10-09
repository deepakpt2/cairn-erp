/**
 * Change documents — engine E14, CAIRN.md §5.2, §16.3
 *
 * Field-level before/after history for master data and configuration. This is
 * what makes two things possible that an auditor will always ask for:
 *
 *   - "Show me the vendor master as it was on the posting date, not as it is now."
 *   - "Who changed this bank account, when, and from what?"
 *
 * A change that alters nothing writes nothing. Noise in a change log is worse
 * than no change log, because it hides the entries that matter.
 */
import type { Tx } from '../db/client';
import { changeDocument, changeDocumentItem } from '../tables/audit-trail';

export interface RecordChangeInput {
  client: string;
  /** Business object class, e.g. 'gl_account', 'company_code', 'condition_record'. */
  objectClass: string;
  /** Business key of the changed object. */
  objectKey: string;
  changeType: 'CREATE' | 'CHANGE' | 'BLOCK' | 'UNBLOCK' | 'REVERSE';
  changedBy: string;
  transactionCode?: string;
  reason?: string;
  effectiveFrom?: Date;
  /** State before the change. Omit for CREATE. */
  before?: Record<string, unknown>;
  /** State after the change. Omit for a pure block/unblock flag change. */
  after?: Record<string, unknown>;
  /** Human labels for field names, so the viewer reads well. */
  fieldLabels?: Record<string, string>;
  /** Fields whose change is security-relevant and flagged for the auditor (§16.3). */
  securityRelevantFields?: string[];
  /** Fields to ignore — technical columns nobody wants to see in a change log. */
  ignoredFields?: string[];
}

const DEFAULT_IGNORED = [
  'changedAt',
  'changedBy',
  'createdAt',
  'createdBy',
  'changed_at',
  'changed_by',
  'created_at',
  'created_by',
];

/**
 * Record a change. Returns the change document id, or null when nothing actually
 * differs — in which case no row is written at all.
 */
export async function recordChange(
  tx: Tx,
  input: RecordChangeInput,
): Promise<string | null> {
  const ignored = new Set([...DEFAULT_IGNORED, ...(input.ignoredFields ?? [])]);
  const securityRelevant = new Set(input.securityRelevantFields ?? []);

  const items: Array<{ field: string; oldValue: string | null; newValue: string | null }> = [];

  if (input.changeType === 'CREATE') {
    const after = input.after ?? {};
    for (const [field, value] of Object.entries(after)) {
      if (ignored.has(field)) continue;
      if (value === undefined || value === null) continue;
      items.push({ field, oldValue: null, newValue: serialize(value) });
    }
  } else {
    const before = input.before ?? {};
    const after = input.after ?? {};
    const fields = new Set([...Object.keys(before), ...Object.keys(after)]);
    for (const field of fields) {
      if (ignored.has(field)) continue;
      const oldValue = serialize(before[field]);
      const newValue = serialize(after[field]);
      if (oldValue === newValue) continue;
      items.push({ field, oldValue, newValue });
    }
  }

  if (items.length === 0) return null;

  const id = crypto.randomUUID();
  await tx.insert(changeDocument).values({
    id,
    client: input.client,
    objectClass: input.objectClass,
    objectKey: input.objectKey,
    changeType: input.changeType,
    transactionCode: input.transactionCode,
    reason: input.reason,
    changedBy: input.changedBy,
    effectiveFrom: input.effectiveFrom,
  });

  await tx.insert(changeDocumentItem).values(
    items.map((item) => ({
      id: crypto.randomUUID(),
      changeDocumentId: id,
      client: input.client,
      fieldName: item.field,
      fieldLabel: input.fieldLabels?.[item.field] ?? humanize(item.field),
      oldValue: item.oldValue,
      newValue: item.newValue,
      isSecurityRelevant: securityRelevant.has(item.field) ? 'true' : 'false',
    })),
  );

  return id;
}

/**
 * History for one object, newest first — what the "change log" button shows on
 * every master record (§19.1).
 */
export async function changeHistory(
  tx: Tx,
  client: string,
  objectClass: string,
  objectKey: string,
  limit = 100,
) {
  const documents = await tx.query.changeDocument.findMany({
    where: (t, { and, eq }) =>
      and(eq(t.client, client), eq(t.objectClass, objectClass), eq(t.objectKey, objectKey)),
    orderBy: (t, { desc }) => [desc(t.changedAt)],
    limit,
  });

  const result = [];
  for (const doc of documents) {
    const items = await tx.query.changeDocumentItem.findMany({
      where: (t, { and, eq }) => and(eq(t.client, client), eq(t.changeDocumentId, doc.id)),
    });
    result.push({ ...doc, items });
  }
  return result;
}

function serialize(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

function humanize(field: string): string {
  return field
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/_/g, ' ')
    .replace(/^./, (c) => c.toUpperCase());
}
