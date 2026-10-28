/**
 * Record types: the configuration that says what the tenant keeps about a person.
 *
 * DV-012 in CAIRN.md is the whole reason this service exists — "fixed SAP infotype numbering replaced by
 * configurable record types" — so a type is a row a tenant owns, not a table someone adds. Two rules follow
 * from that and are enforced here rather than left to goodwill:
 *
 * **Definitions are retired, not deleted.** `9193` revokes DELETE on every table of this slice and makes the
 * employee record's foreign key `restrict`, so a type any record cites cannot be removed at all. Retiring is
 * `is_valid = false`: it stops new records of that type and leaves every standing record readable, which is
 * what OBA4 established for tolerance groups (a definition with history is deactivated instead of deleted).
 *
 * **A field's kind is not renamed under values that were written in another one.** `record_field_value`
 * stores each answer in the column its field's kind selects, so changing `value_kind` beside existing values
 * would strand them in a slot the reader no longer consults. `changeRecordField` refuses that and says what
 * to do instead.
 *
 * Authorization is the screens' business (`can(session, CFG.PEOPLE.RECORDTYPE.DEFINE)` in the server
 * actions), exactly as the inspection-lot service leaves it to `/quality/lots`; a service that checked twice
 * would only make the rules harder to read.
 */
import { and, asc, count, eq, sql } from 'drizzle-orm';
import { z } from 'zod';

import { type Tx, withTenant } from '../../platform/db/client';
import { recordChange } from '../../platform/change';
import { recordField, recordType, employeeRecord, RECORD_TYPE_OBJECT_CLASS } from './schema';

// The screen contract lives in `schema.ts`; re-exported because a config screen reaches it through this service.
export { RECORD_TYPE_CAPABILITY, RECORD_TYPE_ROUTE } from './schema';

const CODE_MAX = 6;
const FIELD_CODE_MAX = 30;
const LABEL_MAX = 60;
const FIELDS_MAX = 40;

const code = z.string().transform((s) => s.trim().toUpperCase());
const text = (max: number) => z.string().transform((s) => s.trim()).refine((s) => s.length > 0 && s.length <= max, { message: 'REQUIRED_TEXT' });

const recordTypeCode = code.pipe(z.string().regex(/^[A-Z][A-Z0-9]{1,5}$/, { message: 'CODE_FORMAT' }));
const fieldCode = code.pipe(z.string().regex(/^[A-Z][A-Z0-9_]{1,29}$/, { message: 'FIELD_CODE_FORMAT' }));

const fieldInput = z.object({
  code: fieldCode,
  label: text(LABEL_MAX),
  valueKind: z.enum(['TEXT', 'NUMBER', 'DATE']),
  isRequired: z.boolean().optional().default(false),
  displayOrder: z.number().int().min(0).max(9999).optional(),
});

const defineInput = z.object({
  client: code.pipe(z.string().regex(/^[A-Z0-9]{2,4}$/, { message: 'CLIENT_FORMAT' })),
  code: recordTypeCode,
  name: text(LABEL_MAX),
  description: z.string().transform((s) => s.trim()).optional(),
  fields: z.array(fieldInput).min(1).max(FIELDS_MAX),
  changedBy: text(60),
});

const changeInput = z.object({
  client: code.pipe(z.string().regex(/^[A-Z0-9]{2,4}$/, { message: 'CLIENT_FORMAT' })),
  code: recordTypeCode,
  name: text(LABEL_MAX).optional(),
  description: z.string().transform((s) => s.trim()).nullable().optional(),
  isValid: z.boolean().optional(),
  changedBy: text(60),
});

const addFieldInput = z.object({
  client: code.pipe(z.string().regex(/^[A-Z0-9]{2,4}$/, { message: 'CLIENT_FORMAT' })),
  recordType: recordTypeCode,
  code: fieldCode,
  label: text(LABEL_MAX),
  valueKind: z.enum(['TEXT', 'NUMBER', 'DATE']),
  isRequired: z.boolean().optional().default(false),
  displayOrder: z.number().int().min(0).max(9999).optional(),
  changedBy: text(60),
});

const changeFieldInput = z.object({
  client: code.pipe(z.string().regex(/^[A-Z0-9]{2,4}$/, { message: 'CLIENT_FORMAT' })),
  recordType: recordTypeCode,
  code: fieldCode,
  label: text(LABEL_MAX).optional(),
  valueKind: z.enum(['TEXT', 'NUMBER', 'DATE']).optional(),
  isRequired: z.boolean().optional(),
  displayOrder: z.number().int().min(0).max(9999).optional(),
  changedBy: text(60),
});

export interface RecordFieldDefinition {
  code: string;
  label: string;
  valueKind: 'TEXT' | 'NUMBER' | 'DATE';
  isRequired: boolean;
  displayOrder: number;
  /** How many records already answer this field. A kind change beside any of them is refused. */
  valuesStanding: number;
}

export interface RecordTypeDefinition {
  code: string;
  name: string;
  description: string | null;
  isValid: boolean;
  recordsStanding: number;
  fields: RecordFieldDefinition[];
}

/** A refusal a reader can act on: the sentence they see, and the step that would have let it through. */
export class RecordTypeConfigError extends Error {
  readonly remedy: string;
  constructor(message: string, remedy: string) {
    super(message);
    this.name = 'RecordTypeConfigError';
    this.remedy = remedy;
  }
}

const REFUSALS: Record<string, [string, string]> = {
  CODE_FORMAT: [
    `A record type code is two to six characters, starting with a letter and written in capitals.`,
    `Use something like PERSGR or ZFAM: two to six characters, letters, digits and no spaces.`,
  ],
  FIELD_CODE_FORMAT: [
    `A field code is two to thirty characters, starting with a letter, and uses only capitals, digits and underscores.`,
    `Use the name the payroll provider uses, uppercased: STKLD, FAMGT, ZABGR.`,
  ],
  CLIENT_FORMAT: [
    `A tenant is the two-to-four-character code the session was opened with.`,
    `Open the screen from the launchpad; the tenant comes from the session, not from the form.`,
  ],
  REQUIRED_TEXT: [
    `A name or label was blank or longer than ${LABEL_MAX} characters.`,
    `Write the short name a payroll clerk would recognise, up to ${LABEL_MAX} characters.`,
  ],
  DUPLICATE_FIELD: [
    `The same field code was given twice in one definition.`,
    `List each field once; the answer to a field is one value per record, so a second row asking for it would never be read.`,
  ],
  TYPE_EXISTS: [
    `A record type with that code is already defined in this tenant.`,
    `Read the existing type and change what needs changing, or retire it and define the new one under a new code.`,
  ],
  TYPE_UNKNOWN: [
    `No record type of that code is defined in this tenant.`,
    `Define it on this screen first; a record cannot be dated against a type nobody has named.`,
  ],
  FIELD_EXISTS: [
    `That field is already part of the record type.`,
    `Change the field you mean instead of adding it again — a label or a requirement can be corrected in place.`,
  ],
  FIELD_UNKNOWN: [
    `That field is not part of the record type.`,
    `Add the field first, or pick the one you meant from the list on the screen.`,
  ],
  KIND_IN_USE: [
    `The value kind cannot be changed while records answer that field in the kind it has now.`,
    `Add a field under a new code for the new kind and let the old one stand: history keeps the kind it was written in.`,
  ],
};

function refusal(key: string, detail?: string): never {
  const [message, remedy] = REFUSALS[key] ?? [
    `The record type definition was not accepted (${key}).`,
    `Correct the value and submit again.`,
  ];
  throw new RecordTypeConfigError(detail ? `${message} ${detail}` : message, remedy);
}

function parse<T extends z.ZodTypeAny>(schema: T, input: unknown): z.infer<T> {
  const parsed = schema.safeParse(input);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    refusal(first?.code === 'custom' ? String(first.message) : (first?.message ?? 'INVALID_INPUT'));
  }
  return parsed.data;
}

async function typeRow(tx: Tx, client: string, codeValue: string) {
  const [row] = await tx.select().from(recordType).where(and(
    eq(recordType.client, client),
    eq(recordType.code, codeValue),
  )).limit(1);
  return row ?? null;
}

async function fieldsOf(tx: Tx, client: string, codeValue: string): Promise<RecordFieldDefinition[]> {
  const rows = await tx.select({
    code: recordField.code,
    label: recordField.label,
    valueKind: recordField.valueKind,
    isRequired: recordField.isRequired,
    displayOrder: recordField.displayOrder,
    valuesStanding: sql<number>`(
      select count(*)::int from public.record_field_value v
       where v.client = ${recordField.client}
         and v.record_type = ${recordField.recordType}
         and v.field_code = ${recordField.code})`.as('values_standing'),
  }).from(recordField).where(and(
    eq(recordField.client, client),
    eq(recordField.recordType, codeValue),
  )).orderBy(asc(recordField.displayOrder), asc(recordField.code));
  return rows.map((r) => ({ ...r, valueKind: r.valueKind as RecordFieldDefinition['valueKind'], valuesStanding: Number(r.valuesStanding) }));
}

/** A defined field row, ready to insert. A caller that omits the order gets the order it listed them in. */
function fieldRow(input: {
  client: string; recordType: string; code: string; label: string;
  valueKind: 'TEXT' | 'NUMBER' | 'DATE'; isRequired: boolean; displayOrder?: number; changedBy: string;
}, index: number) {
  return {
    client: input.client,
    recordType: input.recordType,
    code: input.code,
    label: input.label,
    valueKind: input.valueKind,
    isRequired: input.isRequired,
    displayOrder: input.displayOrder ?? (index + 1) * 10,
    createdBy: input.changedBy,
  };
}

/**
 * Define a record type with the fields it asks for. A repeat of the same `requestKey` is not an error and not
 * a second definition: it returns the type that stands, which is how a submitted form that timed out is read.
 */
export async function defineRecordType(input: unknown): Promise<RecordTypeDefinition> {
  const parsed = parse(defineInput, input);

  const seen = new Set<string>();
  for (const field of parsed.fields) {
    if (seen.has(field.code)) refusal('DUPLICATE_FIELD', `${field.code} appears more than once.`);
    seen.add(field.code);
  }

  await withTenant(parsed.client, async (tx) => {
    // A second definition of a code that stands is refused, not merged and not replayed: the configuration
    // tables carry no request key, because a definition is a thing a tenant reads before it writes, not a
    // document a clerk submits twice.
    if (await typeRow(tx, parsed.client, parsed.code)) refusal('TYPE_EXISTS');

    await tx.insert(recordType).values({
      client: parsed.client,
      code: parsed.code,
      name: parsed.name,
      description: parsed.description || null,
      isValid: true,
      createdBy: parsed.changedBy,
    });

    const inserted: Array<z.infer<typeof fieldInput>> = [];
    for (const [index, field] of parsed.fields.entries()) {
      await tx.insert(recordField).values(fieldRow(
        { ...field, client: parsed.client, recordType: parsed.code, changedBy: parsed.changedBy }, index,
      ));
      inserted.push(field);
    }

    await recordChange(tx, {
      client: parsed.client,
      objectClass: RECORD_TYPE_OBJECT_CLASS,
      objectKey: parsed.code,
      changeType: 'CREATE',
      changedBy: parsed.changedBy,
      after: {
        code: parsed.code,
        name: parsed.name,
        description: parsed.description || null,
        fields: inserted.map((f) => `${f.code}:${f.valueKind}${f.isRequired ? ':required' : ''}`).join(' '),
      },
    });
    return undefined;
  });

  return getRecordType(parsed.client, parsed.code);
}

/** Read one type with its fields. */
export async function getRecordType(clientInput: string, codeValue: string): Promise<RecordTypeDefinition> {
  const client = parse(z.string(), clientInput).trim();
  const wanted = codeValue.trim().toUpperCase();
  return withTenant(client, async (tx) => {
    const row = await typeRow(tx, client, wanted);
    if (!row) refusal('TYPE_UNKNOWN', wanted);
    const [usage] = await tx.select({ records: count() }).from(employeeRecord).where(and(
      eq(employeeRecord.client, client),
      eq(employeeRecord.recordType, wanted),
    ));
    return {
      code: row.code,
      name: row.name,
      description: row.description ?? null,
      isValid: row.isValid,
      recordsStanding: Number(usage?.records ?? 0),
      fields: await fieldsOf(tx, client, wanted),
    };
  });
}

/** List the tenant's types with what stands against each, newest code first. */
export async function listRecordTypes(clientInput: string): Promise<RecordTypeDefinition[]> {
  const client = parse(z.string(), clientInput).trim();
  return withTenant(client, async (tx) => {
    const rows = await tx.select({
      code: recordType.code,
      name: recordType.name,
      description: recordType.description,
      isValid: recordType.isValid,
      recordsStanding: sql<number>`(
        select count(*)::int from public.employee_record r
         where r.client = ${recordType.client} and r.record_type = ${recordType.code})`.as('records_standing'),
    }).from(recordType).where(eq(recordType.client, client)).orderBy(asc(recordType.code));
    const out: RecordTypeDefinition[] = [];
    for (const row of rows) {
      out.push({
        code: row.code,
        name: row.name,
        description: row.description ?? null,
        isValid: row.isValid,
        recordsStanding: Number(row.recordsStanding),
        fields: await fieldsOf(tx, client, row.code),
      });
    }
    return out;
  });
}

/**
 * Change what a type is called, or retire it. `isValid: false` stops new records of this type and keeps every
 * standing record readable — deletion is not offered, by `9193` and by the database's own foreign key.
 */
export async function changeRecordType(input: unknown): Promise<RecordTypeDefinition> {
  const parsed = parse(changeInput, input);
  const patch: { name?: string; description?: string | null; isValid?: boolean } = {};
  if (parsed.name) patch.name = parsed.name;
  if (parsed.description !== undefined) patch.description = parsed.description || null;
  if (parsed.isValid !== undefined) patch.isValid = parsed.isValid;
  if (Object.keys(patch).length === 0) {
    throw new RecordTypeConfigError(
      `Nothing was given to change about record type ${parsed.code}.`,
      `Give a new name, a description, or the validity you want it to have.`,
    );
  }

  await withTenant(parsed.client, async (tx) => {
    const standing = await typeRow(tx, parsed.client, parsed.code);
    if (!standing) refusal('TYPE_UNKNOWN', parsed.code);
    await tx.update(recordType).set({ ...patch, changedBy: parsed.changedBy, changedAt: new Date() }).where(and(
      eq(recordType.client, parsed.client),
      eq(recordType.code, parsed.code),
    ));
    await recordChange(tx, {
      client: parsed.client,
      objectClass: RECORD_TYPE_OBJECT_CLASS,
      objectKey: parsed.code,
      changeType: 'CHANGE',
      changedBy: parsed.changedBy,
      before: { name: standing!.name, description: standing!.description, isValid: standing!.isValid },
      after: patch,
    });
    return undefined;
  });

  return getRecordType(parsed.client, parsed.code);
}

/** Add one field to a type that is already defined. */
export async function addRecordField(input: unknown): Promise<RecordTypeDefinition> {
  const parsed = parse(addFieldInput, input);
  await withTenant(parsed.client, async (tx) => {
    if (!await typeRow(tx, parsed.client, parsed.recordType)) refusal('TYPE_UNKNOWN', parsed.recordType);
    const [existing] = await tx.select({ code: recordField.code }).from(recordField).where(and(
      eq(recordField.client, parsed.client),
      eq(recordField.recordType, parsed.recordType),
      eq(recordField.code, parsed.code),
    )).limit(1);
    if (existing) refusal('FIELD_EXISTS', parsed.code);
    // An explicitly ordered add keeps its order; a caller that gave none gets the end of the list.
    const [last] = await tx.select({ order: sql<number>`coalesce(max(${recordField.displayOrder}), 0)::int` })
      .from(recordField).where(and(
        eq(recordField.client, parsed.client),
        eq(recordField.recordType, parsed.recordType),
      ));
    await tx.insert(recordField).values(fieldRow(
      { ...parsed, displayOrder: parsed.displayOrder ?? Number(last?.order ?? 0) + 10 }, 0,
    ));
    await recordChange(tx, {
      client: parsed.client,
      objectClass: RECORD_TYPE_OBJECT_CLASS,
      objectKey: parsed.recordType,
      changeType: 'CHANGE',
      changedBy: parsed.changedBy,
      reason: `field ${parsed.code} added`,
      after: { field: `${parsed.code}:${parsed.valueKind}${parsed.isRequired ? ':required' : ''}` },
    });
    return undefined;
  });
  return getRecordType(parsed.client, parsed.recordType);
}

/** Correct a field. A kind change is refused while values of the old kind answer it. */
export async function changeRecordField(input: unknown): Promise<RecordTypeDefinition> {
  const parsed = parse(changeFieldInput, input);
  await withTenant(parsed.client, async (tx) => {
    const [standing] = await tx.select().from(recordField).where(and(
      eq(recordField.client, parsed.client),
      eq(recordField.recordType, parsed.recordType),
      eq(recordField.code, parsed.code),
    )).limit(1);
    if (!standing) refusal('FIELD_UNKNOWN', parsed.code);
    if (parsed.valueKind && parsed.valueKind !== standing.valueKind) {
      const [usage] = await tx.execute(sql`
        select count(*)::int as answers from public.record_field_value
         where client = ${parsed.client} and record_type = ${parsed.recordType} and field_code = ${parsed.code}`);
      if (Number((usage as { answers?: number } | undefined)?.answers ?? 0) > 0) refusal('KIND_IN_USE', parsed.code);
    }
    const patch: Record<string, unknown> = { changedBy: parsed.changedBy, changedAt: new Date() };
    if (parsed.label) patch.label = parsed.label;
    if (parsed.valueKind) patch.valueKind = parsed.valueKind;
    if (parsed.isRequired !== undefined) patch.isRequired = parsed.isRequired;
    if (parsed.displayOrder !== undefined) patch.displayOrder = parsed.displayOrder;
    await tx.update(recordField).set(patch).where(and(
      eq(recordField.client, parsed.client),
      eq(recordField.recordType, parsed.recordType),
      eq(recordField.code, parsed.code),
    ));
    await recordChange(tx, {
      client: parsed.client,
      objectClass: RECORD_TYPE_OBJECT_CLASS,
      objectKey: parsed.recordType,
      changeType: 'CHANGE',
      changedBy: parsed.changedBy,
      reason: `field ${parsed.code} changed`,
      before: { label: standing.label, valueKind: standing.valueKind, isRequired: standing.isRequired, displayOrder: standing.displayOrder },
      after: patch,
    });
    return undefined;
  });
  return getRecordType(parsed.client, parsed.recordType);
}
