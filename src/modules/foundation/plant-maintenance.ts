/** Audited tenant-scoped Plant definition create/change — SCR-014 / D-086–D-089. */
import { and, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { recordChange } from '../../platform/change';
import { withTenant, type Tx } from '../../platform/db/client';
import { markActivityComplete } from '../../platform/tenancy';
import { changeDocument } from '../../platform/tables/audit-trail';
import { country as countryReference } from '../../platform/tables/reference';
import { plant } from './schema';

const PLANT_ACTIVITY = 'CFG.ORG.PLANT.DEFINE';
const PLANT_OBJECT_CLASS = 'plant';

const optionalText = (maximum: number) =>
  z.string().trim().max(maximum).optional().transform((value) => value || undefined);

const languageSchema = z.preprocess(
  (value) => (typeof value === 'string' && value.trim() === '' ? undefined : value),
  z
    .string()
    .trim()
    .regex(/^[A-Za-z]{2}$/, 'Language must be a two-letter code.')
    .transform((value) => value.toUpperCase())
    .default('EN'),
);

/** Only fields owned by Plant definition are accepted here; assignments stay separate. */
export const plantDefinitionValuesSchema = z
  .object({
    name: z.string().trim().min(1).max(160),
    country: z
      .string()
      .trim()
      .regex(/^[A-Za-z]{2}$/, 'Country must be a two-letter code.')
      .transform((value) => value.toUpperCase()),
    street: optionalText(160),
    houseNumber: optionalText(40),
    postalCode: optionalText(20),
    city: optionalText(80),
    region: optionalText(80),
    /** Optional key only: intentionally not reference-validated or used operationally. */
    factoryCalendar: optionalText(10),
    language: languageSchema,
    /** Cairn-specific descriptive metadata; neither flag is an operational gate. */
    isProductionSite: z.boolean().default(true),
    isStorageSite: z.boolean().default(true),
  })
  .strict();

export const plantDefinitionModeSchema = z.enum(['CREATE', 'CHANGE']);

/** Tenant and actor are service inputs; the server action must derive both from its session. */
export const plantMaintenanceInputSchema = z
  .object({
    client: z.string().regex(/^[A-Za-z0-9]{2,4}$/),
    changedBy: z.string().trim().min(1).max(60),
    mode: plantDefinitionModeSchema,
    plant: z.string().trim().min(1).max(10),
    expectedVersion: z.number().int().nonnegative(),
    reason: z.string().trim().max(500).optional().transform((value) => value || undefined),
    values: plantDefinitionValuesSchema,
  })
  .strict();

export type PlantDefinitionValuesInput = z.input<typeof plantDefinitionValuesSchema>;
export type PlantDefinitionValues = z.output<typeof plantDefinitionValuesSchema>;
export type PlantDefinitionMode = z.infer<typeof plantDefinitionModeSchema>;
export type PlantMaintenanceInput = z.input<typeof plantMaintenanceInputSchema>;

export class PlantMaintenanceError extends Error {
  readonly code = 'CAIRN_CONFIG';

  constructor(
    message: string,
    readonly remedy = 'Review the Plant definition and try again.',
  ) {
    super(message);
    this.name = 'PlantMaintenanceError';
  }
}

type PlantRow = typeof plant.$inferSelect;

type PlantDefinitionFields = {
  name: string;
  country: string;
  street: string | null;
  houseNumber: string | null;
  postalCode: string | null;
  city: string | null;
  region: string | null;
  factoryCalendar: string | null;
  language: string;
  isProductionSite: boolean;
  isStorageSite: boolean;
};

const DEFINITION_FIELDS: Array<keyof PlantDefinitionFields> = [
  'name',
  'country',
  'street',
  'houseNumber',
  'postalCode',
  'city',
  'region',
  'factoryCalendar',
  'language',
  'isProductionSite',
  'isStorageSite',
];

const FIELD_LABELS: Record<string, string> = {
  plant: 'Plant code',
  name: 'Name',
  country: 'Country',
  street: 'Street',
  houseNumber: 'House number',
  postalCode: 'Postal code',
  city: 'City',
  region: 'Region',
  factoryCalendar: 'Factory Calendar key (optional, non-operational)',
  language: 'Language',
  isProductionSite: 'Cairn production-site flag (descriptive)',
  isStorageSite: 'Cairn storage-site flag (descriptive)',
};

function definitionFields(values: PlantDefinitionValues): PlantDefinitionFields {
  return {
    name: values.name,
    country: values.country,
    street: values.street ?? null,
    houseNumber: values.houseNumber ?? null,
    postalCode: values.postalCode ?? null,
    city: values.city ?? null,
    region: values.region ?? null,
    factoryCalendar: values.factoryCalendar ?? null,
    language: values.language,
    isProductionSite: values.isProductionSite,
    isStorageSite: values.isStorageSite,
  };
}

function auditSnapshot(plantCode: string, fields: PlantDefinitionFields | PlantRow) {
  // Explicit projection prevents Company Code, default storage location, the legacy
  // free-text address, active status, and technical columns from entering this action's audit allowlist.
  return {
    plant: plantCode,
    name: fields.name,
    country: fields.country,
    street: fields.street,
    houseNumber: fields.houseNumber,
    postalCode: fields.postalCode,
    city: fields.city,
    region: fields.region,
    factoryCalendar: fields.factoryCalendar,
    language: fields.language,
    isProductionSite: fields.isProductionSite,
    isStorageSite: fields.isStorageSite,
  };
}

function sameDefinition(before: PlantRow, after: PlantDefinitionFields): boolean {
  return DEFINITION_FIELDS.every((field) => before[field] === after[field]);
}

async function requireCountry(tx: Tx, countryCode: string): Promise<void> {
  const [reference] = await tx
    .select({ code: countryReference.code })
    .from(countryReference)
    .where(eq(countryReference.code, countryCode))
    .limit(1);

  if (!reference) {
    throw new PlantMaintenanceError(
      `Country ${countryCode} is not in the reference catalogue.`,
      'Choose a supported country from the country reference list.',
    );
  }
}

/**
 * Plant has no integer version column. Its field-level change-document count is
 * the optimistic version token, so rows without prior change documents begin at version 0.
 */
async function plantAuditVersion(tx: Tx, client: string, plantCode: string): Promise<number> {
  const [row] = await tx
    .select({ version: sql<number>`count(*)::int` })
    .from(changeDocument)
    .where(
      and(
        eq(changeDocument.client, client),
        eq(changeDocument.objectClass, PLANT_OBJECT_CLASS),
        eq(changeDocument.objectKey, plantCode),
      ),
    );

  return row?.version ?? 0;
}

/** Read the optimistic change-document-count token for an existing tenant Plant. */
export async function getPlantDefinitionVersion(client: string, plantCode: string): Promise<number> {
  return withTenant(client, (tx) => plantAuditVersion(tx, client, plantCode));
}

/** Create one Plant or maintain only its approved definition fields. */
export async function savePlantDefinition(raw: PlantMaintenanceInput) {
  const parsed = plantMaintenanceInputSchema.safeParse(raw);
  if (!parsed.success) {
    throw new PlantMaintenanceError(
      parsed.error.issues[0]?.message ?? 'Plant definition is invalid.',
      'Correct the indicated value and submit the definition again.',
    );
  }

  const { client, changedBy, mode, plant: plantCode, expectedVersion, reason, values } = parsed.data;
  const fields = definitionFields(values);

  return withTenant(client, async (tx) => {
    // The advisory lock also serializes first-time creates, for which no row can be locked yet.
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${`${client}/plant/${plantCode}`}, 0))`,
    );

    const [current] = await tx
      .select()
      .from(plant)
      .where(and(eq(plant.client, client), eq(plant.plant, plantCode)))
      .for('update');
    const version = await plantAuditVersion(tx, client, plantCode);

    if (mode === 'CREATE') {
      if (current) {
        throw new PlantMaintenanceError(
          `Plant ${plantCode} already exists.`,
          'Choose an unused Plant code. Create never changes an existing Plant.',
        );
      }
      if (expectedVersion !== 0 || version !== 0) {
        throw new PlantMaintenanceError(
          `Plant ${plantCode} has a stale definition version.`,
          'Reload the Plant list and retry with a new Plant code.',
        );
      }

      await requireCountry(tx, values.country);
      await tx.insert(plant).values({
        client,
        plant: plantCode,
        ...fields,
        createdBy: changedBy,
        // companyCode, defaultStorageLocation, legacy address, and isActive are
        // deliberately omitted: assignment is separate, the default stays unset,
        // old free-text data is never part of this allowlist, and active defaults true.
      });

      const changeId = await recordChange(tx, {
        client,
        objectClass: PLANT_OBJECT_CLASS,
        objectKey: plantCode,
        changeType: 'CREATE',
        changedBy,
        transactionCode: PLANT_ACTIVITY,
        reason,
        after: auditSnapshot(plantCode, fields),
        fieldLabels: FIELD_LABELS,
      });
      if (!changeId) {
        throw new PlantMaintenanceError(
          'Plant creation could not be recorded in change history.',
          'Retry the Plant definition. If the problem continues, contact an administrator.',
        );
      }

      await markActivityComplete(tx, client, PLANT_ACTIVITY, changedBy);
      return { plant: plantCode, created: true as const, changed: true as const, version: version + 1 };
    }

    if (!current) {
      throw new PlantMaintenanceError(
        `Plant ${plantCode} does not exist in this tenant.`,
        'Return to the Plant list and choose an existing Plant to change.',
      );
    }
    if (expectedVersion !== version) {
      throw new PlantMaintenanceError(
        `Plant ${plantCode} changed after it was opened.`,
        'Reload the current Plant definition before saving your changes.',
      );
    }

    await requireCountry(tx, values.country);
    if (sameDefinition(current, fields)) {
      await markActivityComplete(tx, client, PLANT_ACTIVITY, changedBy);
      return { plant: plantCode, created: false as const, changed: false as const, version };
    }

    await tx
      .update(plant)
      .set({
        ...fields,
        changedBy,
        changedAt: new Date(),
      })
      .where(and(eq(plant.client, client), eq(plant.plant, plantCode)));

    const changeId = await recordChange(tx, {
      client,
      objectClass: PLANT_OBJECT_CLASS,
      objectKey: plantCode,
      changeType: 'CHANGE',
      changedBy,
      transactionCode: PLANT_ACTIVITY,
      reason,
      before: auditSnapshot(plantCode, current),
      after: auditSnapshot(plantCode, fields),
      fieldLabels: FIELD_LABELS,
    });
    if (!changeId) {
      throw new PlantMaintenanceError(
        'Plant changes could not be recorded in change history.',
        'Retry the Plant definition. If the problem continues, contact an administrator.',
      );
    }

    await markActivityComplete(tx, client, PLANT_ACTIVITY, changedBy);
    return { plant: plantCode, created: false as const, changed: true as const, version: version + 1 };
  });
}
