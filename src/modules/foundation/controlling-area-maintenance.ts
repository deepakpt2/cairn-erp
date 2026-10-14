/** SCR-024 / OKKP Controlling Area definition business functions. */
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { z } from 'zod';
import { recordChange } from '../../platform/change';
import { withTenant, type Tx } from '../../platform/db/client';
import { markActivityComplete } from '../../platform/tenancy';
import { currency as currencyReference } from '../../platform/tables/reference';
import { changeDocument, documentIndex } from '../../platform/tables/audit-trail';
import { configActivityStatus } from '../../platform/tables/registry';
import { journalEntry } from '../finance/schema';
import {
  companyCode,
  controllingArea,
  controllingAreaCompany,
  fiscalYearVariant,
} from './schema';

const ACTIVITY = 'CFG.COST.CONTROLLINGAREA.DEFINE';
const OBJECT_CLASS = 'controlling_area';
const PREREQUISITES = ['CFG.ORG.COMPANYCODE.DEFINE'] as const;

const clientSchema = z.string().trim().regex(/^[A-Za-z0-9]{2,4}$/);
const codeSchema = z.string().trim().transform((value) => value.toUpperCase())
  .pipe(z.string().regex(/^[A-Z0-9]{4}$/, 'Controlling Area must be four letters or numbers.'));
const nameSchema = z.string().trim().min(1, 'Name is required.').max(30, 'Name must be 30 characters or fewer.');
const organizationNameSchema = z.string().trim().max(30, 'Name of Controlling Area must be 30 characters or fewer.')
  .optional().transform((value) => value || null);
const scopeSchema = z.enum(['SINGLE', 'MULTIPLE']);
const currencySchema = z.string().trim().transform((value) => value.toUpperCase())
  .pipe(z.string().regex(/^[A-Z]{3}$/, 'Currency Key must be three uppercase letters.'));
const fiscalYearVariantSchema = z.string().trim().transform((value) => value.toUpperCase())
  .pipe(z.string().regex(/^[A-Z0-9]{2}$/, 'Fiscal Year Variant must be two letters or numbers.'));
const reasonSchema = z.string().trim().max(500).optional().transform((value) => value || undefined);

/** Cairn-native fields for create/change; the Controlling Area key is immutable after creation. */
export const controllingAreaValuesSchema = z.object({
  controllingArea: codeSchema,
  name: nameSchema,
  organizationName: organizationNameSchema,
  companyCodeScope: scopeSchema,
  currency: currencySchema,
  fiscalYearVariant: fiscalYearVariantSchema,
}).strict();

export const controllingAreaMaintenanceInputSchema = controllingAreaValuesSchema.extend({
  client: clientSchema,
  changedBy: z.string().trim().min(1).max(60),
  mode: z.enum(['CREATE', 'CHANGE']),
  expectedVersion: z.number().int().nonnegative(),
  reason: reasonSchema,
}).strict();

const controllingAreaKeyInputSchema = z.object({
  client: clientSchema,
  controllingArea: codeSchema,
}).strict();

export type ControllingAreaValues = z.output<typeof controllingAreaValuesSchema>;
export type ControllingAreaMaintenanceInput = z.input<typeof controllingAreaMaintenanceInputSchema>;

export class ControllingAreaMaintenanceError extends Error {
  readonly code = 'CAIRN_CONFIG';

  constructor(
    message: string,
    readonly remedy = 'Review the Controlling Area and its configuration, then try again.',
  ) {
    super(message);
    this.name = 'ControllingAreaMaintenanceError';
  }
}

/** Currency F4 is active-only; Fiscal Year Variant F4 includes inactive definitions. */
export async function controllingAreaF4Choices(client: string) {
  const parsed = clientSchema.safeParse(client);
  if (!parsed.success) throw invalidInput(parsed.error);
  const tenant = parsed.data;

  return withTenant(tenant, async (tx) => {
    const [currencies, variants] = await Promise.all([
      tx.select({ code: currencyReference.code, name: currencyReference.name })
        .from(currencyReference)
        .where(eq(currencyReference.isActive, true))
        .orderBy(asc(currencyReference.code)),
      tx.select({ code: fiscalYearVariant.variant, name: fiscalYearVariant.name, isActive: fiscalYearVariant.isActive })
        .from(fiscalYearVariant)
        .where(eq(fiscalYearVariant.client, tenant))
        .orderBy(asc(fiscalYearVariant.variant)),
    ]);

    return {
      currencies: currencies
        .map((row) => ({ code: row.code.trim(), name: row.name.trim() }))
        .filter((row) => /^[A-Z]{3}$/.test(row.code)),
      fiscalYearVariants: variants
        .map((row) => ({ code: row.code.trim(), name: row.name.trim(), isActive: row.isActive }))
        .filter((row) => /^[A-Z0-9]{2}$/.test(row.code)),
    };
  });
}

/** List retained areas and calculate their read-only financial-field state. */
export async function listControllingAreas(client: string) {
  const parsed = clientSchema.safeParse(client);
  if (!parsed.success) throw invalidInput(parsed.error);
  const tenant = parsed.data;

  return withTenant(tenant, async (tx) => {
    const [rows, assignments, journalRows, indexedDocuments] = await Promise.all([
      tx.select().from(controllingArea)
        .where(eq(controllingArea.client, tenant))
        .orderBy(asc(controllingArea.controllingArea)),
      tx.select({
        controllingArea: controllingAreaCompany.controllingArea,
        companyCode: controllingAreaCompany.companyCode,
      }).from(controllingAreaCompany)
        .where(eq(controllingAreaCompany.client, tenant)),
      tx.select({ controllingArea: controllingAreaCompany.controllingArea })
        .from(controllingAreaCompany)
        .innerJoin(journalEntry, and(
          eq(journalEntry.client, controllingAreaCompany.client),
          eq(journalEntry.companyCode, controllingAreaCompany.companyCode),
        ))
        .where(and(
          eq(controllingAreaCompany.client, tenant),
          inArray(journalEntry.status, ['POSTED', 'REVERSED']),
        )),
      tx.select({ controllingArea: controllingAreaCompany.controllingArea })
        .from(controllingAreaCompany)
        .innerJoin(documentIndex, and(
          eq(documentIndex.client, controllingAreaCompany.client),
          eq(documentIndex.companyCode, controllingAreaCompany.companyCode),
        ))
        .where(eq(controllingAreaCompany.client, tenant)),
    ]);

    const assignmentCounts = new Map<string, number>();
    for (const row of assignments) {
      const key = row.controllingArea.trim();
      assignmentCounts.set(key, (assignmentCounts.get(key) ?? 0) + 1);
    }
    const lockedAreas = new Set([
      ...journalRows.map((row) => row.controllingArea.trim()),
      ...indexedDocuments.map((row) => row.controllingArea.trim()),
    ]);

    return rows.map((row) => {
      const code = row.controllingArea.trim();
      const currencyLocked = lockedAreas.has(code);
      return {
        controllingArea: code,
        name: row.name.trim(),
        organizationName: row.organizationName?.trim() || null,
        companyCodeScope: row.companyCodeScope as 'SINGLE' | 'MULTIPLE',
        currency: row.currency.trim(),
        fiscalYearVariant: row.fiscalYearVariant.trim(),
        isActive: row.isActive,
        companyCodeCount: assignmentCounts.get(code) ?? 0,
        currencyLocked,
        fiscalYearVariantLocked: currencyLocked,
        createdAt: row.createdAt,
        changedAt: row.changedAt,
      };
    });
  });
}

/** Create a new area or change its non-key configuration; duplicate create is a no-op. */
export async function saveControllingArea(raw: ControllingAreaMaintenanceInput) {
  const parsed = controllingAreaMaintenanceInputSchema.safeParse(raw);
  if (!parsed.success) throw invalidInput(parsed.error);
  const { client, changedBy, mode, expectedVersion, reason, ...values } = parsed.data;

  return withTenant(client, async (tx) => {
    await lockControllingArea(tx, client, values.controllingArea);
    const [current] = await tx.select().from(controllingArea)
      .where(areaKey(client, values.controllingArea))
      .for('update');
    const version = await auditVersion(tx, client, values.controllingArea);

    if (mode === 'CREATE' && current) {
      await markActivityComplete(tx, client, ACTIVITY, changedBy);
      return noChangeResult(current, version);
    }

    if (mode === 'CHANGE' && !current) throw notFound(values.controllingArea);
    if (mode === 'CREATE' && (expectedVersion !== 0 || version !== 0)) throw staleVersion(values.controllingArea);
    if (mode === 'CHANGE' && expectedVersion !== version) throw staleVersion(values.controllingArea);
    if (current && !current.isActive) {
      throw new ControllingAreaMaintenanceError(
        `Controlling Area ${values.controllingArea} is inactive and cannot be changed.`,
        'Inactive Controlling Areas are retained for history; no reactivation action is available.',
      );
    }

    await requirePrerequisites(tx, client);
    if (!current) {
      await requireReferences(tx, client, values);
    } else {
      if (current.currency.trim() !== values.currency) await requireCurrencyReference(tx, values.currency);
      if (current.fiscalYearVariant.trim() !== values.fiscalYearVariant) {
        await requireFiscalYearVariant(tx, client, values.fiscalYearVariant);
      }
    }

    if (current) {
      const oldCurrency = current.currency.trim();
      const oldVariant = current.fiscalYearVariant.trim();
      const currencyOrVariantChanged = oldCurrency !== values.currency || oldVariant !== values.fiscalYearVariant;
      if (currencyOrVariantChanged && await hasRecordedTransactions(tx, client, values.controllingArea)) {
        throw new ControllingAreaMaintenanceError(
          `Currency and Fiscal Year Variant for Controlling Area ${values.controllingArea} are read-only after actual operational transactions exist.`,
          'Retain the established financial settings after business transactions have been recorded.',
        );
      }

      if (
        current.companyCodeScope !== values.companyCodeScope
        || oldVariant !== values.fiscalYearVariant
      ) {
        await assertScopeCompatible(tx, client, values.controllingArea, values.companyCodeScope, values.fiscalYearVariant);
      }
      const before = snapshot(current);
      const after = { ...values, isActive: current.isActive };
      if (sameValues(before, after)) return noChangeResult(current, version);

      await tx.update(controllingArea).set({
        name: values.name,
        organizationName: values.organizationName,
        companyCodeScope: values.companyCodeScope,
        currency: values.currency,
        fiscalYearVariant: values.fiscalYearVariant,
        changedBy,
        changedAt: new Date(),
      }).where(areaKey(client, values.controllingArea));

      const changeId = await recordChange(tx, {
        client,
        objectClass: OBJECT_CLASS,
        objectKey: values.controllingArea,
        changeType: 'CHANGE',
        changedBy,
        transactionCode: ACTIVITY,
        reason,
        before,
        after,
        securityRelevantFields: ['companyCodeScope', 'currency', 'fiscalYearVariant'],
        fieldLabels: FIELD_LABELS,
      });
      if (!changeId) throw new ControllingAreaMaintenanceError('Controlling Area change could not be recorded in change history.');
      await markActivityComplete(tx, client, ACTIVITY, changedBy);
      return { created: false as const, changed: true as const, version: version + 1, ...values };
    }

    await assertScopeCompatible(tx, client, values.controllingArea, values.companyCodeScope, values.fiscalYearVariant);
    const [created] = await tx.insert(controllingArea).values({
      client,
      controllingArea: values.controllingArea,
      name: values.name,
      organizationName: values.organizationName,
      companyCodeScope: values.companyCodeScope,
      currency: values.currency,
      fiscalYearVariant: values.fiscalYearVariant,
      isActive: true,
      createdBy: changedBy,
    }).onConflictDoNothing().returning({ controllingArea: controllingArea.controllingArea });
    if (!created) {
      const [raced] = await tx.select().from(controllingArea).where(areaKey(client, values.controllingArea));
      if (raced) return noChangeResult(raced, await auditVersion(tx, client, values.controllingArea));
      throw new ControllingAreaMaintenanceError('Controlling Area creation did not persist.', 'Retry the save. If it continues, contact an administrator.');
    }

    const changeId = await recordChange(tx, {
      client,
      objectClass: OBJECT_CLASS,
      objectKey: values.controllingArea,
      changeType: 'CREATE',
      changedBy,
      transactionCode: ACTIVITY,
      reason,
      after: { ...values, isActive: true },
      securityRelevantFields: ['controllingArea', 'companyCodeScope', 'currency', 'fiscalYearVariant'],
      fieldLabels: FIELD_LABELS,
    });
    if (!changeId) throw new ControllingAreaMaintenanceError('Controlling Area creation could not be recorded in change history.');
    await markActivityComplete(tx, client, ACTIVITY, changedBy);
    return { created: true as const, changed: true as const, version: version + 1, ...values };
  });
}

/** Read-only currency/Fiscal Year Variant lock status for the UI and server-action guard. */
export async function controllingAreaHasRecordedTransactions(client: string, code: string) {
  const parsed = controllingAreaKeyInputSchema.safeParse({ client, controllingArea: code });
  if (!parsed.success) throw invalidInput(parsed.error);
  return withTenant(parsed.data.client, (tx) => hasRecordedTransactions(tx, parsed.data.client, parsed.data.controllingArea));
}

/** Shared row-lock seam: posting paths take FOR SHARE; config edits take FOR UPDATE. */
export async function lockControllingAreaForCompanyCode(tx: Tx, client: string, code: string) {
  const parsed = z.object({ client: clientSchema, companyCode: z.string().trim().min(1).max(10) }).safeParse({ client, companyCode: code });
  if (!parsed.success) throw invalidInput(parsed.error);
  const rows = await tx.select({ controllingArea: controllingArea.controllingArea })
    .from(controllingAreaCompany)
    .innerJoin(controllingArea, and(
      eq(controllingArea.client, controllingAreaCompany.client),
      eq(controllingArea.controllingArea, controllingAreaCompany.controllingArea),
    ))
    .where(and(
      eq(controllingAreaCompany.client, parsed.data.client),
      eq(controllingAreaCompany.companyCode, parsed.data.companyCode),
    ))
    .orderBy(asc(controllingArea.controllingArea))
    .for('share');
  return rows.map((row) => row.controllingArea.trim());
}

export async function getControllingAreaVersion(client: string, code: string) {
  const parsed = controllingAreaKeyInputSchema.safeParse({ client, controllingArea: code });
  if (!parsed.success) throw invalidInput(parsed.error);
  return withTenant(parsed.data.client, (tx) => auditVersion(tx, parsed.data.client, parsed.data.controllingArea));
}

async function requirePrerequisites(tx: Tx, client: string) {
  const rows = await tx.select({ activityCode: configActivityStatus.activityCode })
    .from(configActivityStatus)
    .where(and(
      eq(configActivityStatus.client, client),
      inArray(configActivityStatus.activityCode, [...PREREQUISITES]),
      eq(configActivityStatus.status, 'COMPLETED'),
    ));
  const completed = new Set(rows.map((row) => row.activityCode));
  const missing = PREREQUISITES.filter((code) => !completed.has(code));
  if (missing.length) throw new ControllingAreaMaintenanceError(
    `Controlling Area prerequisites are incomplete: ${missing.join(', ')}.`,
    'Complete Company Code definition in the configuration workbench first.',
  );
}

async function requireReferences(tx: Tx, client: string, values: ControllingAreaValues) {
  await requireCurrencyReference(tx, values.currency);
  await requireFiscalYearVariant(tx, client, values.fiscalYearVariant);
}

async function requireCurrencyReference(tx: Tx, code: string) {
  const [currencyRow] = await tx.select({ code: currencyReference.code })
    .from(currencyReference)
    .where(and(eq(currencyReference.code, code), eq(currencyReference.isActive, true)))
    .limit(1);
  if (!currencyRow) throw new ControllingAreaMaintenanceError(
    `Active Currency Key ${code} is not available.`,
    'Select an active three-character currency from Currency F4.',
  );
}

async function requireFiscalYearVariant(tx: Tx, client: string, code: string) {
  const [variant] = await tx.select({ variant: fiscalYearVariant.variant })
    .from(fiscalYearVariant)
    .where(and(
      eq(fiscalYearVariant.client, client),
      eq(fiscalYearVariant.variant, code),
    ))
    .limit(1);
  if (!variant) throw new ControllingAreaMaintenanceError(
    `Fiscal Year Variant ${code} is not defined in this tenant.`,
    'Select an existing two-character Fiscal Year Variant from F4.',
  );
}

async function assertScopeCompatible(
  tx: Tx,
  client: string,
  areaCode: string,
  scope: 'SINGLE' | 'MULTIPLE',
  areaFiscalYearVariant: string,
) {
  const assignments = await tx.select({
    companyCode: controllingAreaCompany.companyCode,
    chartOfAccounts: companyCode.chartOfAccounts,
    fiscalYearVariant: companyCode.fiscalYearVariant,
  }).from(controllingAreaCompany)
    .innerJoin(companyCode, and(
      eq(companyCode.client, controllingAreaCompany.client),
      eq(companyCode.companyCode, controllingAreaCompany.companyCode),
    ))
    .where(and(
      eq(controllingAreaCompany.client, client),
      eq(controllingAreaCompany.controllingArea, areaCode),
    ))
    .orderBy(asc(controllingAreaCompany.companyCode));

  if (scope === 'SINGLE' && assignments.length > 1) {
    throw new ControllingAreaMaintenanceError(
      `Controlling Area ${areaCode} cannot use Same Company Code while multiple Company Codes are assigned.`,
      'Remove extra Company Code assignments through OX19 before changing the scope to 1:1.',
    );
  }

  if (scope === 'MULTIPLE' && assignments.length > 0) {
    if (assignments.some((row) => !row.chartOfAccounts || !row.fiscalYearVariant)) {
      throw new ControllingAreaMaintenanceError(
        `Company Code assignments for Controlling Area ${areaCode} lack an Operational Chart of Accounts or Fiscal Year Variant.`,
        'Complete each Company Code financial assignment before enabling cross-company cost accounting.',
      );
    }
    const charts = new Set(assignments.map((row) => row.chartOfAccounts!.trim()));
    const years = new Set(assignments.map((row) => row.fiscalYearVariant!.trim()));
    if (charts.size !== 1 || years.size !== 1 || years.values().next().value !== areaFiscalYearVariant) {
      throw new ControllingAreaMaintenanceError(
        `Company Codes assigned to Controlling Area ${areaCode} must share its Operational Chart of Accounts and Fiscal Year Variant.`,
        'Use the same Operational Chart of Accounts and Fiscal Year Variant for every Company Code in a cross-company Controlling Area.',
      );
    }
  }
}

async function hasRecordedTransactions(tx: Tx, client: string, areaCode: string) {
  const [posting] = await tx.select({ documentNumber: journalEntry.documentNumber })
    .from(controllingAreaCompany)
    .innerJoin(journalEntry, and(
      eq(journalEntry.client, controllingAreaCompany.client),
      eq(journalEntry.companyCode, controllingAreaCompany.companyCode),
    ))
    .where(and(
      eq(controllingAreaCompany.client, client),
      eq(controllingAreaCompany.controllingArea, areaCode),
      inArray(journalEntry.status, ['POSTED', 'REVERSED']),
    ))
    .limit(1);
  if (posting) return true;

  // The document index is the generic source for operational documents which may
  // exist before they produce an accounting entry. Any indexed business document
  // for an assigned Company Code makes currency and period settings read-only.
  const [document] = await tx.select({ id: documentIndex.id })
    .from(controllingAreaCompany)
    .innerJoin(documentIndex, and(
      eq(documentIndex.client, controllingAreaCompany.client),
      eq(documentIndex.companyCode, controllingAreaCompany.companyCode),
    ))
    .where(and(
      eq(controllingAreaCompany.client, client),
      eq(controllingAreaCompany.controllingArea, areaCode),
    ))
    .limit(1);
  return Boolean(document);
}

async function lockControllingArea(tx: Tx, client: string, code: string) {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`${client}/controlling_area/${code}`}, 0))`);
}

function areaKey(client: string, code: string) {
  return and(eq(controllingArea.client, client), eq(controllingArea.controllingArea, code));
}

function snapshot(row: typeof controllingArea.$inferSelect) {
  return {
    controllingArea: row.controllingArea.trim(),
    name: row.name.trim(),
    organizationName: row.organizationName?.trim() || null,
    companyCodeScope: row.companyCodeScope,
    currency: row.currency.trim(),
    fiscalYearVariant: row.fiscalYearVariant.trim(),
    isActive: row.isActive,
  };
}

function sameValues(before: ReturnType<typeof snapshot>, after: ReturnType<typeof snapshot>) {
  return before.name === after.name
    && before.organizationName === after.organizationName
    && before.companyCodeScope === after.companyCodeScope
    && before.currency === after.currency
    && before.fiscalYearVariant === after.fiscalYearVariant
    && before.isActive === after.isActive;
}

async function auditVersion(tx: Tx, client: string, code: string): Promise<number> {
  const [row] = await tx.select({ version: sql<number>`count(*)::int` })
    .from(changeDocument)
    .where(and(
      eq(changeDocument.client, client),
      eq(changeDocument.objectClass, OBJECT_CLASS),
      eq(changeDocument.objectKey, code),
    ));
  return row?.version ?? 0;
}

function noChangeResult(current: typeof controllingArea.$inferSelect, version: number) {
  return {
    created: false as const,
    changed: false as const,
    controllingArea: current.controllingArea.trim(),
    name: current.name.trim(),
    organizationName: current.organizationName?.trim() || null,
    companyCodeScope: current.companyCodeScope as 'SINGLE' | 'MULTIPLE',
    currency: current.currency.trim(),
    fiscalYearVariant: current.fiscalYearVariant.trim(),
    isActive: current.isActive,
    version,
  };
}

function invalidInput(error: z.ZodError): ControllingAreaMaintenanceError {
  return new ControllingAreaMaintenanceError(
    error.issues[0]?.message ?? 'Controlling Area input is invalid.',
    'Correct the indicated value and submit again.',
  );
}

function staleVersion(code: string) {
  return new ControllingAreaMaintenanceError(
    `Controlling Area ${code} changed after it was opened.`,
    'Reload the current Controlling Area before saving your changes.',
  );
}

function notFound(code: string) {
  return new ControllingAreaMaintenanceError(
    `Controlling Area ${code} was not found.`,
    'Return to the overview and select an existing Controlling Area.',
  );
}

const FIELD_LABELS = {
  controllingArea: 'Controlling Area',
  name: 'Name',
  organizationName: 'Name of Controlling Area',
  companyCodeScope: 'Assignment Control',
  currency: 'Currency',
  fiscalYearVariant: 'Fiscal Year Variant',
  isActive: 'Active',
};
