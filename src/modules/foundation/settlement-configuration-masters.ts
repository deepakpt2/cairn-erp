/**
 * Settlement masters: the profile, the allocation structure with its assignments, and the order
 * type that a settlement rule reads.
 *
 * These four rows belong to a client and to an order type, never to one order, so they are stored
 * here rather than by the rule screen at `/controlling/settlement-rules`. A document type and the
 * three distribution methods are stated on the profile by whoever maintains it; none of them is
 * inferred from the share field one order happened to save last. Nothing here posts: an update
 * writes a master row and its change document, and a settlement run stays the only path that clears
 * an order balance.
 *
 * A change refuses rather than stranding an order. An account a balance still stands on keeps its
 * assignment, a profile an order type resolves to stays active, and a profile keeps allowing every
 * method a rule of its orders uses, because the settlement run reads exactly these rows and stops
 * when one of them is missing.
 */
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { z } from 'zod';

import { recordChange } from '../../platform/change';
import { type Tx, withTenant } from '../../platform/db/client';
import { markActivityComplete } from '../../platform/tenancy';
import { changeDocument } from '../../platform/tables/audit-trail';
import { glAccount, journalEntry, journalEntryLine } from '../finance/schema';
import {
  allocationStructure,
  allocationStructureAssignment,
  documentType,
  internalOrder,
  internalOrderType,
  internalOrderTypeSettlementProfile,
  settlementDistributionRule,
  settlementDocument,
  settlementProfile,
} from './schema';

import {
  SETTLEMENT_CONFIG_ACTIVITY,
  settlementConfigAdvisoryKey,
} from './settlement-configuration-keys';

/** The capability, the route and the change-session keys live in one DB-free file the screen shares. */
export {
  SETTLEMENT_CONFIG_ACTIVITY,
  SETTLEMENT_CONFIG_LOCKS,
  SETTLEMENT_CONFIG_ROUTE,
  settlementConfigLock,
  type SettlementConfigLockKind,
} from './settlement-configuration-keys';

/** The workbench step these four masters complete, and the capability that maintains them. */
export const SETTLEMENT_CONFIG_CAPABILITY = SETTLEMENT_CONFIG_ACTIVITY;

const PROFILE_CLASS = 'settlement_profile';
const STRUCTURE_CLASS = 'allocation_structure';
const ASSIGNMENT_CLASS = 'allocation_structure_assignment';
const TYPE_CLASS = 'internal_order_type_settlement_profile';

const RECEIVER_CATEGORIES = ['COST_CENTER', 'INTERNAL_ORDER', 'GL_ACCOUNT'] as const;

const clientSchema = z.string().trim().regex(/^[A-Za-z0-9]{2,4}$/);
const actorSchema = z.string().trim().min(1).max(60);
const codeSchema = z.string().trim().transform((value) => value.toUpperCase())
  .pipe(z.string().regex(/^[A-Z0-9]{2,6}$/, 'A code is 2 to 6 letters or numbers.'));
const accountSchema = z.string().trim().transform((value) => value.toUpperCase())
  .pipe(z.string().regex(/^[A-Z0-9]{2,10}$/, 'An account number is 2 to 10 letters or numbers.'));
const descriptionSchema = z.string().trim().min(1, 'A description is required.').max(40, 'A description is 40 characters or fewer.');
const receiverCategorySchema = z.enum(RECEIVER_CATEGORIES);
const versionSchema = z.number().int().nonnegative();
const reasonSchema = z.string().trim().max(500).optional().transform((value) => value || undefined);
const modeSchema = z.enum(['CREATE', 'CHANGE']);

export const allocationStructureInputSchema = z.object({
  client: clientSchema,
  changedBy: actorSchema,
  mode: modeSchema,
  expectedVersion: versionSchema,
  reason: reasonSchema,
  structureCode: codeSchema,
  description: descriptionSchema,
}).strict();
export type AllocationStructureInput = z.input<typeof allocationStructureInputSchema>;

export const allocationAssignmentInputSchema = z.object({
  client: clientSchema,
  changedBy: actorSchema,
  expectedVersion: versionSchema,
  reason: reasonSchema,
  structureCode: codeSchema,
  sourceAccount: accountSchema,
  receiverCategory: receiverCategorySchema,
  byOriginalAccount: z.boolean(),
  settlementAccount: z.string().trim().transform((value) => value.toUpperCase())
    .pipe(z.union([z.literal(''), z.string().regex(/^[A-Z0-9]{2,10}$/)])),
  /** Required when the removal or the change leaves an order with a settlement history behind. */
  confirmed: z.boolean().optional(),
}).strict();
export type AllocationAssignmentInput = z.input<typeof allocationAssignmentInputSchema>;

export const allocationAssignmentKeyInputSchema = z.object({
  client: clientSchema,
  changedBy: actorSchema,
  reason: reasonSchema,
  structureCode: codeSchema,
  sourceAccount: accountSchema,
  receiverCategory: receiverCategorySchema,
  confirmed: z.boolean().optional(),
}).strict();
export type AllocationAssignmentKeyInput = z.input<typeof allocationAssignmentKeyInputSchema>;

export const settlementProfileInputSchema = z.object({
  client: clientSchema,
  changedBy: actorSchema,
  mode: modeSchema,
  expectedVersion: versionSchema,
  reason: reasonSchema,
  profileCode: codeSchema,
  description: descriptionSchema,
  allocationStructure: codeSchema,
  documentType: z.string().trim().transform((value) => value.toUpperCase())
    .pipe(z.string().regex(/^[A-Z0-9]{2,12}$/, 'A document type is 2 to 12 letters or numbers.')),
  percentageAllowed: z.boolean(),
  equivalenceAllowed: z.boolean(),
  amountAllowed: z.boolean(),
  /** Stated explicitly. A new profile is never created inactive by accident, and never left active by accident. */
  isActive: z.boolean(),
}).strict();
export type SettlementProfileInput = z.input<typeof settlementProfileInputSchema>;

export const orderTypeSettlementProfileInputSchema = z.object({
  client: clientSchema,
  changedBy: actorSchema,
  mode: modeSchema,
  expectedVersion: versionSchema,
  reason: reasonSchema,
  orderType: z.string().trim().transform((value) => value.toUpperCase())
    .pipe(z.string().regex(/^[A-Z0-9]{1,4}$/, 'An order type is up to 4 letters or numbers.')),
  profileCode: codeSchema,
  confirmed: z.boolean().optional(),
}).strict();
export type OrderTypeSettlementProfileInput = z.input<typeof orderTypeSettlementProfileInputSchema>;

export const orderTypeSettlementProfileKeyInputSchema = z.object({
  client: z.string().trim(),
  changedBy: actorSchema,
  reason: reasonSchema,
  orderType: z.string().trim().transform((value) => value.toUpperCase())
    .pipe(z.string().min(1).max(4)),
  confirmed: z.boolean().optional(),
}).strict();
export type OrderTypeSettlementProfileKeyInput = z.input<typeof orderTypeSettlementProfileKeyInputSchema>;

export class SettlementMastersError extends Error {
  readonly code = 'CAIRN_CONFIG';
  readonly remedy: string;

  constructor(message: string, remedy = 'Review the settlement configuration and try again.') {
    super(message);
    this.name = 'SettlementConfigurationMastersError';
    this.remedy = remedy;
  }
}

/** An active document type from the client's own definitions. SA is not assumed. */
export async function listSettlementProfileDocumentTypes(client: string) {
  return withTenant(client, async (tx) => tx.select({
    documentType: documentType.documentType,
    name: documentType.name,
  }).from(documentType).where(and(
    eq(documentType.client, client),
    eq(documentType.isActive, true),
  )).orderBy(asc(documentType.documentType)));
}

export async function listAllocationStructures(client: string) {
  const parsed = z.object({ client: clientSchema }).strict().safeParse({ client });
  if (!parsed.success) throw invalidInput(parsed.error);
  return withTenant(parsed.data.client, async (tx) => {
    const rows = await tx.select().from(allocationStructure)
      .where(eq(allocationStructure.client, parsed.data.client))
      .orderBy(asc(allocationStructure.structureCode));
    const out: Array<{
      structureCode: string;
      description: string;
      assignments: number;
      profiles: number;
      orderTypes: number;
    }> = [];
    for (const row of rows) {
      out.push({
        structureCode: row.structureCode.trim(),
        description: row.description.trim(),
        assignments: (await tx.select({ n: sql<number>`count(*)::int` }).from(allocationStructureAssignment)
          .where(and(
            eq(allocationStructureAssignment.client, parsed.data.client),
            eq(allocationStructureAssignment.structureCode, row.structureCode),
          )))[0]!.n,
        profiles: (await tx.select({ n: sql<number>`count(*)::int` }).from(settlementProfile)
          .where(and(
            eq(settlementProfile.client, parsed.data.client),
            eq(settlementProfile.allocationStructure, row.structureCode),
          )))[0]!.n,
        orderTypes: (await tx.select({ n: sql<number>`count(*)::int` }).from(settlementProfile)
          .innerJoin(internalOrderTypeSettlementProfile, and(
            eq(internalOrderTypeSettlementProfile.client, settlementProfile.client),
            eq(internalOrderTypeSettlementProfile.profileCode, settlementProfile.profileCode),
          ))
          .where(and(
            eq(settlementProfile.client, parsed.data.client),
            eq(settlementProfile.allocationStructure, row.structureCode),
          )))[0]!.n,
      });
    }
    return out;
  });
}

/**
 * One structure as a maintainer sees it: its description, the profiles that read it, its assignment rows,
 * and the version each of those rows stands at. A key that was assigned and removed has no row to show, so
 * it is reported in `removedAssignments` with the version its own history left behind: that is the number a
 * save must submit to take the key back.
 */
export async function getAllocationStructure(client: string, structureCode: string) {
  const parsed = z.object({ client: clientSchema, structureCode: codeSchema }).strict().safeParse({ client, structureCode });
  if (!parsed.success) throw invalidInput(parsed.error);
  return withTenant(parsed.data.client, async (tx) => {
    const [row] = await tx.select().from(allocationStructure).where(and(
      eq(allocationStructure.client, parsed.data.client),
      eq(allocationStructure.structureCode, parsed.data.structureCode),
    ));
    if (!row) return null;
    const assignments = await tx.select().from(allocationStructureAssignment).where(and(
      eq(allocationStructureAssignment.client, parsed.data.client),
      eq(allocationStructureAssignment.structureCode, parsed.data.structureCode),
    )).orderBy(asc(allocationStructureAssignment.sourceAccount), asc(allocationStructureAssignment.receiverCategory));
    const profiles = await tx.select({ profileCode: settlementProfile.profileCode, isActive: settlementProfile.isActive })
      .from(settlementProfile).where(and(
        eq(settlementProfile.client, parsed.data.client),
        eq(settlementProfile.allocationStructure, parsed.data.structureCode),
      )).orderBy(asc(settlementProfile.profileCode));
    // A removed assignment leaves its audit rows behind, so its key keeps a version even though there is
    // no row to read. The write-side guard counts those rows (`auditVersion`), and a removal adds one
    // rather than clearing them, so a reader that reported only live rows could never satisfy the guard for
    // a key it wants back: it would be told to re-read a row that does not exist. The order-type read
    // (`listOrderTypeSettlementProfiles`) has always handed out the version whether or not a row stands
    // there; this is the same rule, over the keys this structure's history names.
    const history = await tx.select({
      objectKey: changeDocument.objectKey,
      version: sql<number>`count(*)::int`,
    }).from(changeDocument).where(and(
      eq(changeDocument.client, parsed.data.client),
      eq(changeDocument.objectClass, ASSIGNMENT_CLASS),
      sql`split_part(${changeDocument.objectKey}, '/', 1) = ${parsed.data.structureCode}`,
    )).groupBy(changeDocument.objectKey).orderBy(asc(changeDocument.objectKey));
    const liveKeys = new Set(assignments.map((assignment) => assignmentKeyOf(parsed.data.structureCode, {
      sourceAccount: assignment.sourceAccount.trim(),
      receiverCategory: assignment.receiverCategory,
    })));
    const removedAssignments = history.flatMap((entry) => {
      if (liveKeys.has(entry.objectKey)) return [];
      const [, sourceAccount, receiverCategory] = entry.objectKey.split('/');
      if (!sourceAccount || !receiverCategory) return [];
      return [{ sourceAccount, receiverCategory, version: entry.version }];
    });

    return {
      structureCode: row.structureCode.trim(),
      description: row.description.trim(),
      version: await auditVersion(tx, parsed.data.client, STRUCTURE_CLASS, parsed.data.structureCode),
      profilesUsedBy: profiles.map((profile) => ({
        profileCode: profile.profileCode.trim(),
        isActive: profile.isActive,
      })),
      assignments: await Promise.all(assignments.map(async (assignment) => ({
        sourceAccount: assignment.sourceAccount.trim(),
        receiverCategory: assignment.receiverCategory,
        byOriginalAccount: assignment.byOriginalAccount,
        settlementAccount: assignment.settlementAccount?.trim() ?? null,
        version: await auditVersion(tx, parsed.data.client, ASSIGNMENT_CLASS, assignmentKeyOf(parsed.data.structureCode, assignment)),
      }))),
      removedAssignments,
    };
  });
}

/** Saves the description of an allocation structure. A structure is never deleted; its rows are history. */
export async function saveAllocationStructure(raw: AllocationStructureInput) {
  const parsed = allocationStructureInputSchema.safeParse(raw);
  if (!parsed.success) throw invalidInput(parsed.error);
  const { client, changedBy, mode, expectedVersion, reason, structureCode, description } = parsed.data;

  return withTenant(client, async (tx) => {
    await lockStructure(tx, client, structureCode);
    const [current] = await tx.select().from(allocationStructure)
      .where(and(eq(allocationStructure.client, client), eq(allocationStructure.structureCode, structureCode)))
      .for('update');
    const version = await auditVersion(tx, client, STRUCTURE_CLASS, structureCode);

    if (mode === 'CREATE' && current) {
      await markActivityComplete(tx, client, SETTLEMENT_CONFIG_ACTIVITY, changedBy);
      return { created: false as const, changed: false as const, structureCode, description: current.description.trim(), version };
    }
    if (mode === 'CHANGE' && !current) throw notFound(`Allocation structure ${structureCode}`);
    if (expectedVersion !== version) throw staleVersion(structureCode);

    if (current && current.description.trim() === description) {
      await markActivityComplete(tx, client, SETTLEMENT_CONFIG_ACTIVITY, changedBy);
      return { created: false as const, changed: false as const, structureCode, description, version };
    }

    const [written] = current
      ? await tx.update(allocationStructure).set({
        description,
        changedBy,
        changedAt: new Date(),
      }).where(and(
        eq(allocationStructure.client, client),
        eq(allocationStructure.structureCode, structureCode),
      )).returning({ structureCode: allocationStructure.structureCode })
      : await tx.insert(allocationStructure).values({
        client,
        structureCode,
        description,
        createdBy: changedBy,
      }).onConflictDoNothing().returning({ structureCode: allocationStructure.structureCode });
    if (!written) throw new SettlementMastersError(`Allocation structure ${structureCode} was not stored.`, 'Retry the save. Nothing was assumed.');

    await recordChange(tx, {
      client,
      objectClass: STRUCTURE_CLASS,
      objectKey: structureCode,
      changeType: current ? 'CHANGE' : 'CREATE',
      changedBy,
      transactionCode: SETTLEMENT_CONFIG_ACTIVITY,
      reason,
      before: current ? { description: current.description.trim() } : undefined,
      after: { description },
    });
    await markActivityComplete(tx, client, SETTLEMENT_CONFIG_ACTIVITY, changedBy);
    return { created: !current, changed: true, structureCode, description, version: version + 1 };
  });
}

/**
 * Stores one assignment row of an allocation structure: which account is settled from, for which
 * receiver category, and against which settlement account. The row belongs to the structure, so an
 * order of any type whose profile names this structure reads it.
 */
export async function saveAllocationStructureAssignment(raw: AllocationAssignmentInput) {
  const parsed = allocationAssignmentInputSchema.safeParse(raw);
  if (!parsed.success) throw invalidInput(parsed.error);
  const values = parsed.data;
  const { client, changedBy, reason, structureCode, sourceAccount, receiverCategory, confirmed } = values;
  const settlementAccount = values.settlementAccount === '' ? null : values.settlementAccount;
  assertAccountChoice(values.byOriginalAccount, settlementAccount);

  const assignmentKey = assignmentKeyOf(structureCode, { sourceAccount, receiverCategory });
  return withTenant(client, async (tx) => {
    await lockStructure(tx, client, structureCode);
    const [structure] = await tx.select().from(allocationStructure).where(and(
      eq(allocationStructure.client, client),
      eq(allocationStructure.structureCode, structureCode),
    ));
    if (!structure) {
      throw new SettlementMastersError(
        `Allocation structure ${structureCode} does not exist. Its assignments are not created on the side.`,
        'Define the allocation structure first, then its assignments.',
      );
    }
    await assertAccountsKnown(tx, client, sourceAccount, settlementAccount);

    const [current] = await tx.select().from(allocationStructureAssignment).where(assignmentWhere(client, assignmentKey))
      .for('update');
    const version = await auditVersion(tx, client, ASSIGNMENT_CLASS, assignmentKey);
    if (values.expectedVersion !== version) throw staleVersion(assignmentKey);

    if (current
      && current.byOriginalAccount === values.byOriginalAccount
      && (current.settlementAccount?.trim() ?? null) === settlementAccount) {
      await markActivityComplete(tx, client, SETTLEMENT_CONFIG_ACTIVITY, changedBy);
      return { created: false as const, changed: false as const, structureCode, sourceAccount, receiverCategory, version };
    }

    // Replacing the row a balance still stands on would move that balance's offsetting account
    // mid-flight, so the orders that read it are checked first. Removals carry the same check.
    const coverage = await dependentOrdersForStructure(tx, client, structureCode);
    if (current) {
      const stranded = await ordersLeftUncovered(tx, client, coverage.orderNumbers, sourceAccount);
      if (stranded.ordersWithBalance.length > 0) throw uncoveredRefusal(stranded, 'change');
      if (stranded.ordersWithDocuments.length > 0 && confirmed !== true) {
        throw confirmRefusal(structureCode, stranded.ordersWithDocuments.length);
      }
    }

    if (current) {
      await tx.delete(allocationStructureAssignment).where(assignmentWhere(client, assignmentKey));
    }
    await tx.insert(allocationStructureAssignment).values({
      client,
      structureCode,
      sourceAccount,
      receiverCategory,
      byOriginalAccount: values.byOriginalAccount,
      settlementAccount,
      createdBy: changedBy,
    });

    await recordChange(tx, {
      client,
      objectClass: ASSIGNMENT_CLASS,
      objectKey: assignmentKey,
      changeType: current ? 'CHANGE' : 'CREATE',
      changedBy,
      transactionCode: SETTLEMENT_CONFIG_ACTIVITY,
      reason,
      before: current
        ? { structureCode, sourceAccount, receiverCategory, byOriginalAccount: current.byOriginalAccount, settlementAccount: current.settlementAccount?.trim() ?? null }
        : undefined,
      after: { structureCode, sourceAccount, receiverCategory, byOriginalAccount: values.byOriginalAccount, settlementAccount },
    });
    await markActivityComplete(tx, client, SETTLEMENT_CONFIG_ACTIVITY, changedBy);
    return {
      created: !current,
      changed: true,
      structureCode,
      sourceAccount,
      receiverCategory,
      version: version + 1,
    };
  });
}

/**
 * Removes one assignment row. An order of a type reading this structure still needs its row while a
 * balance on that account stands: so the removal refuses there, and asks for an explicit confirmation
 * when settled documents of those orders already exist.
 */
export async function removeAllocationStructureAssignment(raw: AllocationAssignmentKeyInput) {
  const parsed = allocationAssignmentKeyInputSchema.safeParse(raw);
  if (!parsed.success) throw invalidInput(parsed.error);
  const { client, changedBy, reason, structureCode, sourceAccount, receiverCategory, confirmed } = parsed.data;
  const assignmentKey = assignmentKeyOf(structureCode, { sourceAccount, receiverCategory });

  return withTenant(client, async (tx) => {
    await lockStructure(tx, client, structureCode);
    const [current] = await tx.select().from(allocationStructureAssignment).where(assignmentWhere(client, assignmentKey)).for('update');
    if (!current) {
      return {
        removed: false as const,
        structureCode,
        sourceAccount,
        receiverCategory,
        version: await auditVersion(tx, client, ASSIGNMENT_CLASS, assignmentKey),
      };
    }
    const coverage = await dependentOrdersForStructure(tx, client, structureCode);
    const stranded = await ordersLeftUncovered(tx, client, coverage.orderNumbers, sourceAccount);
    if (stranded.ordersWithBalance.length > 0) throw uncoveredRefusal(stranded, 'remove');
    if (stranded.ordersWithDocuments.length > 0 && confirmed !== true) throw confirmRefusal(structureCode, stranded.ordersWithDocuments.length);

    await tx.delete(allocationStructureAssignment).where(assignmentWhere(client, assignmentKey));
    await recordChange(tx, {
      client,
      objectClass: ASSIGNMENT_CLASS,
      objectKey: assignmentKey,
      changeType: 'DELETE',
      changedBy,
      transactionCode: SETTLEMENT_CONFIG_ACTIVITY,
      reason,
      before: { structureCode, sourceAccount, receiverCategory, byOriginalAccount: current.byOriginalAccount, settlementAccount: current.settlementAccount?.trim() ?? null },
    });
    return { removed: true as const, structureCode, sourceAccount, receiverCategory, version: (await auditVersion(tx, client, ASSIGNMENT_CLASS, assignmentKey)) + 1 };
  });
}

export async function listSettlementProfiles(client: string) {
  const parsed = z.object({ client: clientSchema }).strict().safeParse({ client });
  if (!parsed.success) throw invalidInput(parsed.error);
  return withTenant(parsed.data.client, async (tx) => {
    const rows = await tx.select().from(settlementProfile)
      .where(eq(settlementProfile.client, parsed.data.client))
      .orderBy(asc(settlementProfile.profileCode));
    const out = [];
    for (const row of rows) {
      const orderTypes = await tx.select({ orderType: internalOrderTypeSettlementProfile.orderType })
        .from(internalOrderTypeSettlementProfile).where(and(
          eq(internalOrderTypeSettlementProfile.client, parsed.data.client),
          eq(internalOrderTypeSettlementProfile.profileCode, row.profileCode),
        )).orderBy(asc(internalOrderTypeSettlementProfile.orderType));
      out.push({
        profileCode: row.profileCode.trim(),
        description: row.description.trim(),
        allocationStructure: row.allocationStructure.trim(),
        documentType: row.documentType.trim(),
        percentageAllowed: row.percentageAllowed,
        equivalenceAllowed: row.equivalenceAllowed,
        amountAllowed: row.amountAllowed,
        isActive: row.isActive,
        orderTypes: orderTypes.map((entry) => entry.orderType.trim()),
      });
    }
    return out;
  });
}

export async function getSettlementProfile(client: string, profileCode: string) {
  const parsed = z.object({ client: clientSchema, profileCode: codeSchema }).strict().safeParse({ client, profileCode });
  if (!parsed.success) throw invalidInput(parsed.error);
  return withTenant(parsed.data.client, async (tx) => {
    const [row] = await tx.select().from(settlementProfile).where(and(
      eq(settlementProfile.client, parsed.data.client),
      eq(settlementProfile.profileCode, parsed.data.profileCode),
    ));
    if (!row) return null;
    const orderTypes = await tx.select({ orderType: internalOrderTypeSettlementProfile.orderType })
      .from(internalOrderTypeSettlementProfile).where(and(
        eq(internalOrderTypeSettlementProfile.client, parsed.data.client),
        eq(internalOrderTypeSettlementProfile.profileCode, parsed.data.profileCode),
      )).orderBy(asc(internalOrderTypeSettlementProfile.orderType));
    return {
      profileCode: row.profileCode.trim(),
      description: row.description.trim(),
      allocationStructure: row.allocationStructure.trim(),
      documentType: row.documentType.trim(),
      percentageAllowed: row.percentageAllowed,
      equivalenceAllowed: row.equivalenceAllowed,
      amountAllowed: row.amountAllowed,
      isActive: row.isActive,
      orderTypes: orderTypes.map((entry) => entry.orderType.trim()),
      version: await auditVersion(tx, parsed.data.client, PROFILE_CLASS, parsed.data.profileCode),
    };
  });
}

/**
 * Stores a settlement profile. The document type and the three distribution methods are stated here,
 * never read back from an order's share field, and every change that would leave an order of a type
 * resolving to this profile un-settleable is refused.
 */
export async function saveSettlementProfile(raw: SettlementProfileInput) {
  const parsed = settlementProfileInputSchema.safeParse(raw);
  if (!parsed.success) throw invalidInput(parsed.error);
  const {
    client, changedBy, mode, expectedVersion, reason, profileCode, description, allocationStructure: structureCode,
    documentType: documentTypeCode, percentageAllowed, equivalenceAllowed, amountAllowed, isActive,
  } = parsed.data;

  if (!percentageAllowed && !equivalenceAllowed && !amountAllowed) {
    throw new SettlementMastersError(
      `Settlement profile ${profileCode} allows no distribution method.`,
      'Allow a percentage, an equivalence number, or an amount. A method is not assumed.',
    );
  }

  return withTenant(client, async (tx) => {
    await lockProfile(tx, client, profileCode);
    const [current] = await tx.select().from(settlementProfile)
      .where(and(eq(settlementProfile.client, client), eq(settlementProfile.profileCode, profileCode)))
      .for('update');
    const version = await auditVersion(tx, client, PROFILE_CLASS, profileCode);

    if (mode === 'CREATE' && current) {
      await markActivityComplete(tx, client, SETTLEMENT_CONFIG_ACTIVITY, changedBy);
      return { created: false as const, changed: false as const, profileCode, version };
    }
    if (mode === 'CHANGE' && !current) throw notFound(`Settlement profile ${profileCode}`);
    if (expectedVersion !== version) throw staleVersion(profileCode);
    if (current && !current.isActive && isActive) {
      throw new SettlementMastersError(
        `Settlement profile ${profileCode} is inactive and is not reactivated here.`,
        'An inactive profile stays as history. Create a profile with its own code instead.',
      );
    }

    const [structure] = await tx.select().from(allocationStructure).where(and(
      eq(allocationStructure.client, client),
      eq(allocationStructure.structureCode, structureCode),
    ));
    if (!structure) {
      throw new SettlementMastersError(
        `Allocation structure ${structureCode} does not exist. A profile does not create it.`,
        'Define the allocation structure and its assignments first.',
      );
    }
    const [type] = await tx.select().from(documentType).where(and(
      eq(documentType.client, client),
      eq(documentType.documentType, documentTypeCode),
    ));
    if (!type) {
      throw new SettlementMastersError(
        `Document type ${documentTypeCode} is not configured for this client.`,
        'Name a document type the client defines. SA is not assumed.',
      );
    }
    if (!type.isActive) {
      throw new SettlementMastersError(
        `Document type ${documentTypeCode} is not active.`,
        'A settlement profile points at an active document type only.',
      );
    }

    // Every order of every type resolving to this profile is settled through this row. A change that
    // would stop one of them settling is refused rather than left for the run to report.
    const affectedTypes = await orderTypesOfProfile(tx, client, profileCode);
    const dependentOrders = affectedTypes.length > 0
      ? (await tx.select({ orderNumber: internalOrder.orderNumber }).from(internalOrder)
        .where(and(
          eq(internalOrder.client, client),
          inArray(internalOrder.orderType, affectedTypes),
        ))).map((row2) => row2.orderNumber)
      : [];

    const before = current
      ? {
        description: current.description.trim(),
        allocationStructure: current.allocationStructure.trim(),
        documentType: current.documentType.trim(),
        percentageAllowed: current.percentageAllowed,
        equivalenceAllowed: current.equivalenceAllowed,
        amountAllowed: current.amountAllowed,
        isActive: current.isActive,
      }
      : null;

    if (current && before && sameProfileValues(before, {
      description,
      allocationStructure: structureCode,
      documentType: documentTypeCode,
      percentageAllowed,
      equivalenceAllowed,
      amountAllowed,
      isActive,
    })) {
      await markActivityComplete(tx, client, SETTLEMENT_CONFIG_ACTIVITY, changedBy);
      return { created: false as const, changed: false as const, profileCode, version };
    }

    if (current) {
      await assertMethodsStillAllowed(tx, client, dependentOrders, { percentageAllowed, equivalenceAllowed, amountAllowed });
      // D-5: a profile an order type resolves to stays active while that link stands.
      if (current.isActive && !isActive && affectedTypes.length > 0) {
        throw new SettlementMastersError(
          `Settlement profile ${profileCode} is assigned to ${affectedTypes.length} order type(s): ${affectedTypes.join(', ')}.`,
          'Remove the order type assignment first. Deactivating a profile in use would leave those orders un-settleable.',
        );
      }
      if (current.allocationStructure !== structureCode) {
        const coverage = await ordersOfTypes(tx, client, affectedTypes);
        const uncovered = await uncoveredAccountsForStructure(tx, client, coverage, structureCode);
        if (uncovered.length > 0) {
          throw new SettlementMastersError(
            `Allocation structure ${structureCode} assigns none of the accounts being settled: ${uncovered.map((row2) => row2.account).join(', ')}.`,
            'Store the assignment on the new structure before repointing the profile. Nothing was stored.',
          );
        }
      }
    }

    if (current) {
      await tx.update(settlementProfile).set({
        description,
        allocationStructure: structureCode,
        documentType: documentTypeCode,
        percentageAllowed,
        equivalenceAllowed,
        amountAllowed,
        isActive,
        changedBy,
        changedAt: new Date(),
      }).where(and(
        eq(settlementProfile.client, client),
        eq(settlementProfile.profileCode, profileCode),
      ));
    } else {
      const [created] = await tx.insert(settlementProfile).values({
        client,
        profileCode,
        description,
        allocationStructure: structureCode,
        documentType: documentTypeCode,
        percentageAllowed,
        equivalenceAllowed,
        amountAllowed,
        isActive,
        createdBy: changedBy,
      }).onConflictDoNothing().returning({ profileCode: settlementProfile.profileCode });
      if (!created) {
        const [raced] = await tx.select().from(settlementProfile).where(and(
          eq(settlementProfile.client, client),
          eq(settlementProfile.profileCode, profileCode),
        ));
        if (raced) return { created: false as const, changed: false as const, profileCode, version: await auditVersion(tx, client, PROFILE_CLASS, profileCode) };
        throw new SettlementMastersError(`Settlement profile ${profileCode} was not stored.`, 'Retry the save. Nothing was assumed.');
      }
    }

    await recordChange(tx, {
      client,
      objectClass: PROFILE_CLASS,
      objectKey: profileCode,
      changeType: current ? 'CHANGE' : 'CREATE',
      changedBy,
      transactionCode: SETTLEMENT_CONFIG_ACTIVITY,
      reason,
      before: before ?? undefined,
      after: {
        description,
        allocationStructure: structureCode,
        documentType: documentTypeCode,
        percentageAllowed,
        equivalenceAllowed,
        amountAllowed,
        isActive,
      },
    });
    await markActivityComplete(tx, client, SETTLEMENT_CONFIG_ACTIVITY, changedBy);
    return { created: !current, changed: true, profileCode, version: version + 1 };
  });
}

export async function listOrderTypeSettlementProfiles(client: string) {
  const parsed = z.object({ client: clientSchema }).strict().safeParse({ client });
  if (!parsed.success) throw invalidInput(parsed.error);
  return withTenant(parsed.data.client, async (tx) => {
    const types = await tx.select().from(internalOrderType)
      .where(eq(internalOrderType.client, parsed.data.client))
      .orderBy(asc(internalOrderType.orderType));
    const out = [];
    for (const type of types) {
      const [assignment] = await tx.select().from(internalOrderTypeSettlementProfile).where(and(
        eq(internalOrderTypeSettlementProfile.client, parsed.data.client),
        eq(internalOrderTypeSettlementProfile.orderType, type.orderType),
      ));
      const orders = await tx.select({ orderNumber: internalOrder.orderNumber }).from(internalOrder)
        .where(and(eq(internalOrder.client, parsed.data.client), eq(internalOrder.orderType, type.orderType)));
      const orderNumbers = orders.map((row) => row.orderNumber);
      const withRules = orderNumbers.length === 0 ? 0 : (await tx.select({ n: sql<number>`count(distinct ${settlementDistributionRule.orderNumber})::int` })
        .from(settlementDistributionRule).where(and(
          eq(settlementDistributionRule.client, parsed.data.client),
          inArray(settlementDistributionRule.orderNumber, orderNumbers),
        )))[0]!.n;
      const withDocuments = orderNumbers.length === 0 ? 0 : (await tx.select({ n: sql<number>`count(distinct ${settlementDocument.orderNumber})::int` })
        .from(settlementDocument).where(and(
          eq(settlementDocument.client, parsed.data.client),
          inArray(settlementDocument.orderNumber, orderNumbers),
        )))[0]!.n;
      out.push({
        orderType: type.orderType.trim(),
        description: type.description.trim(),
        profileCode: assignment?.profileCode.trim() ?? null,
        orders: orderNumbers.length,
        ordersWithRules: withRules,
        ordersWithSettlementDocuments: withDocuments,
        version: await auditVersion(tx, parsed.data.client, TYPE_CLASS, type.orderType),
      });
    }
    return out;
  });
}

/**
 * Points one order type at one settlement profile. The link is what every order of that type reads,
 * so repointing it is a whole-type act: it is confirmed when orders of the type have already settled,
 * and refused when the target profile could not settle a balance one of them still carries.
 */
export async function assignOrderTypeSettlementProfile(raw: OrderTypeSettlementProfileInput) {
  const parsed = orderTypeSettlementProfileInputSchema.safeParse(raw);
  if (!parsed.success) throw invalidInput(parsed.error);
  const { client, changedBy, mode, expectedVersion, reason, orderType, profileCode, confirmed } = parsed.data;

  return withTenant(client, async (tx) => {
    await lockOrderType(tx, client, orderType);
    const [type] = await tx.select().from(internalOrderType).where(and(
      eq(internalOrderType.client, client),
      eq(internalOrderType.orderType, orderType),
    ));
    if (!type) {
      throw new SettlementMastersError(
        `Internal order type ${orderType} does not exist. IO01 is not assumed.`,
        'Name a configured internal order type.',
      );
    }
    const [profile] = await tx.select().from(settlementProfile).where(and(
      eq(settlementProfile.client, client),
      eq(settlementProfile.profileCode, profileCode),
    ));
    if (!profile) {
      throw new SettlementMastersError(
        `Settlement profile ${profileCode} does not exist. The order type assignment does not create it.`,
        'Define the profile first, then assign it to the order type.',
      );
    }
    if (!profile.isActive) {
      throw new SettlementMastersError(
        `Settlement profile ${profileCode} is inactive.`,
        'Assign an active profile, or create one with its own code.',
      );
    }

    const [current] = await tx.select().from(internalOrderTypeSettlementProfile).where(and(
      eq(internalOrderTypeSettlementProfile.client, client),
      eq(internalOrderTypeSettlementProfile.orderType, orderType),
    )).for('update');
    const version = await auditVersion(tx, client, TYPE_CLASS, orderType);
    if (mode === 'CREATE' && current) {
      return { created: false as const, changed: false as const, orderType, profileCode: current.profileCode.trim(), version };
    }
    if (mode === 'CHANGE' && !current) throw notFound(`Order type ${orderType} settlement profile assignment`);
    if (expectedVersion !== version) throw staleVersion(orderType);

    const coverage = await ordersOfTypes(tx, client, [orderType]);
    if (current && current.profileCode === profileCode) {
      await markActivityComplete(tx, client, SETTLEMENT_CONFIG_ACTIVITY, changedBy);
      return { created: false as const, changed: false as const, orderType, profileCode, version };
    }
    if (current) {
      const uncovered = await uncoveredAccountsForStructure(tx, client, coverage, profile.allocationStructure.trim());
      if (uncovered.length > 0) {
        throw new SettlementMastersError(
          `Order type ${orderType} has balances on accounts that allocation structure ${profile.allocationStructure.trim()} does not assign: ${uncovered.map((row) => `${row.account} (order ${row.orderNumber})`).join(', ')}.`,
          'Store those assignments, or settle the orders first. Nothing was stored.',
        );
      }
      if (coverage.settledOrderNumbers.length > 0 && confirmed !== true) {
        throw confirmRefusal(orderType, coverage.settledOrderNumbers.length);
      }
    }

    if (current) {
      await tx.update(internalOrderTypeSettlementProfile).set({
        profileCode,
        changedBy,
        changedAt: new Date(),
      }).where(and(
        eq(internalOrderTypeSettlementProfile.client, client),
        eq(internalOrderTypeSettlementProfile.orderType, orderType),
      ));
    } else {
      const [written] = await tx.insert(internalOrderTypeSettlementProfile).values({
        client,
        orderType,
        profileCode,
        createdBy: changedBy,
      }).onConflictDoNothing().returning({ orderType: internalOrderTypeSettlementProfile.orderType });
      if (!written) throw staleVersion(orderType);
    }

    await recordChange(tx, {
      client,
      objectClass: TYPE_CLASS,
      objectKey: orderType,
      changeType: current ? 'CHANGE' : 'CREATE',
      changedBy,
      transactionCode: SETTLEMENT_CONFIG_ACTIVITY,
      reason,
      before: current ? { profileCode: current.profileCode.trim() } : undefined,
      after: { profileCode },
    });
    await markActivityComplete(tx, client, SETTLEMENT_CONFIG_ACTIVITY, changedBy);
    return { created: !current, changed: true, orderType, profileCode, version: version + 1 };
  });
}

/** Removes the order type's profile. The orders keep their rules; a settlement then reports the missing profile. */
export async function removeOrderTypeSettlementProfile(raw: OrderTypeSettlementProfileKeyInput) {
  const parsed = orderTypeSettlementProfileKeyInputSchema.safeParse(raw);
  if (!parsed.success) throw invalidInput(parsed.error);
  const { client, changedBy, reason, orderType, confirmed } = parsed.data;

  return withTenant(client, async (tx) => {
    await lockOrderType(tx, client, orderType);
    const [current] = await tx.select().from(internalOrderTypeSettlementProfile).where(and(
      eq(internalOrderTypeSettlementProfile.client, client),
      eq(internalOrderTypeSettlementProfile.orderType, orderType),
    )).for('update');
    if (!current) {
      return { removed: false as const, orderType, version: await auditVersion(tx, client, TYPE_CLASS, orderType) };
    }
    const coverage = await ordersOfTypes(tx, client, [orderType]);
    const withRules = coverage.orderNumbers.filter((number) => coverage.ruleOrderNumbers.includes(number));
    if (withRules.length > 0 && confirmed !== true) {
      throw new SettlementMastersError(
        `${withRules.length} order(s) of type ${orderType} already store a settlement rule.`,
        'Confirm the removal. Their rules stay stored, and a settlement reports the missing profile until one is assigned again.',
      );
    }
    await tx.delete(internalOrderTypeSettlementProfile).where(and(
      eq(internalOrderTypeSettlementProfile.client, client),
      eq(internalOrderTypeSettlementProfile.orderType, orderType),
    ));
    await recordChange(tx, {
      client,
      objectClass: TYPE_CLASS,
      objectKey: orderType,
      changeType: 'DELETE',
      changedBy,
      transactionCode: SETTLEMENT_CONFIG_ACTIVITY,
      reason,
      before: { profileCode: current.profileCode.trim() },
    });
    return { removed: true as const, orderType, version: (await auditVersion(tx, client, TYPE_CLASS, orderType)) + 1 };
  });
}

/** Counts the orders of one structure that a settlement reads, for the assignment screens. */
export async function structureDependents(client: string, structureCode: string) {
  const parsed = z.object({ client: clientSchema, structureCode: codeSchema }).strict().safeParse({ client, structureCode });
  if (!parsed.success) throw invalidInput(parsed.error);
  return withTenant(parsed.data.client, async (tx) => {
    const coverage = await dependentOrdersForStructure(tx, parsed.data.client, parsed.data.structureCode);
    const unsettled = await uncoveredAccountsForStructure(tx, parsed.data.client, coverage, parsed.data.structureCode);
    return {
      orderTypes: coverage.orderTypes,
      orders: coverage.orderNumbers.length,
      accountsWithBalance: unsettled.map((row) => ({ account: row.account, orderNumber: row.orderNumber })),
    };
  });
}

// --- internals -----------------------------------------------------------------------------

interface OrderCoverage {
  orderTypes: string[];
  orderNumbers: string[];
  ruleOrderNumbers: string[];
  settledOrderNumbers: string[];
}

async function orderTypesOfProfile(tx: Tx, client: string, profileCode: string): Promise<string[]> {
  const rows = await tx.select({ orderType: internalOrderTypeSettlementProfile.orderType })
    .from(internalOrderTypeSettlementProfile).where(and(
      eq(internalOrderTypeSettlementProfile.client, client),
      eq(internalOrderTypeSettlementProfile.profileCode, profileCode),
    )).orderBy(asc(internalOrderTypeSettlementProfile.orderType));
  return rows.map((row) => row.orderType.trim());
}

async function ordersOfTypes(tx: Tx, client: string, orderTypes: string[]): Promise<OrderCoverage> {
  if (orderTypes.length === 0) return { orderTypes: [], orderNumbers: [], ruleOrderNumbers: [], settledOrderNumbers: [] };
  const orders = await tx.select({ orderNumber: internalOrder.orderNumber }).from(internalOrder).where(and(
    eq(internalOrder.client, client),
    inArray(internalOrder.orderType, orderTypes),
  )).orderBy(asc(internalOrder.orderNumber));
  const orderNumbers = orders.map((row) => row.orderNumber);
  if (orderNumbers.length === 0) return { orderTypes, orderNumbers: [], ruleOrderNumbers: [], settledOrderNumbers: [] };
  const rules = await tx.select({ orderNumber: settlementDistributionRule.orderNumber }).from(settlementDistributionRule).where(and(
    eq(settlementDistributionRule.client, client),
    inArray(settlementDistributionRule.orderNumber, orderNumbers),
  ));
  const documents = await tx.select({ orderNumber: settlementDocument.orderNumber }).from(settlementDocument).where(and(
    eq(settlementDocument.client, client),
    inArray(settlementDocument.orderNumber, orderNumbers),
  ));
  return {
    orderTypes,
    orderNumbers,
    ruleOrderNumbers: [...new Set(rules.map((row) => row.orderNumber))],
    settledOrderNumbers: [...new Set(documents.map((row) => row.orderNumber))],
  };
}

/** Orders of every type whose profile — active or not — names this allocation structure. */
async function dependentOrdersForStructure(tx: Tx, client: string, structureCode: string): Promise<OrderCoverage> {
  const profiles = await tx.select({ profileCode: settlementProfile.profileCode }).from(settlementProfile).where(and(
    eq(settlementProfile.client, client),
    eq(settlementProfile.allocationStructure, structureCode),
  ));
  const perProfile = await Promise.all(profiles.map((profile) => orderTypesOfProfile(tx, client, profile.profileCode)));
  return ordersOfTypes(tx, client, [...new Set(perProfile.flat())]);
}

/**
 * Accounts with a live balance that the structure does not assign. The balance and the pairing rule
 * are the settlement run's own: journal lines citing the order over posted and reversed documents,
 * matched against an assignment by account and by the rule's receiver category.
 */
async function uncoveredAccountsForStructure(
  tx: Tx,
  client: string,
  coverage: OrderCoverage,
  structureCode: string,
): Promise<Array<{ account: string; orderNumber: string }>> {
  if (coverage.orderNumbers.length === 0) return [];
  const [structure] = await tx.select().from(allocationStructure).where(and(
    eq(allocationStructure.client, client),
    eq(allocationStructure.structureCode, structureCode),
  ));
  if (!structure) return [];
  const assignments = await tx.select().from(allocationStructureAssignment).where(and(
    eq(allocationStructureAssignment.client, client),
    eq(allocationStructureAssignment.structureCode, structureCode),
  ));
  const rules = await tx.select().from(settlementDistributionRule).where(and(
    eq(settlementDistributionRule.client, client),
    inArray(settlementDistributionRule.orderNumber, coverage.orderNumbers),
  )).orderBy(asc(settlementDistributionRule.orderNumber), asc(settlementDistributionRule.ruleNumber));
  const categoryByOrder = new Map<string, string>();
  for (const rule of rules) if (!categoryByOrder.has(rule.orderNumber)) categoryByOrder.set(rule.orderNumber, rule.receiverCategory);

  const balances = await balancesByOrderAndAccount(tx, client, coverage.orderNumbers);

  const uncovered: Array<{ account: string; orderNumber: string }> = [];
  for (const balance of balances) {
    const category = categoryByOrder.get(balance.orderNumber);
    if (!category) continue;
    const mapped = assignments.some((assignment) => assignment.sourceAccount === balance.account
      && assignment.receiverCategory === category);
    if (!mapped) uncovered.push({ account: balance.account, orderNumber: balance.orderNumber });
  }
  return uncovered;
}

/**
 * The balance a settlement would clear, grouped the way the run groups it: journal lines citing the
 * order over posted and reversed documents, kept only where the debit and credit do not net to zero.
 * A refusal here and a stop in `order-settlement` are therefore the same fact, read the same way.
 */
async function balancesByOrderAndAccount(
  tx: Tx,
  client: string,
  orderNumbers: string[],
  account?: string,
): Promise<Array<{ orderNumber: string; account: string }>> {
  if (orderNumbers.length === 0) return [];
  const conditions = [
    eq(journalEntryLine.client, client),
    inArray(journalEntryLine.internalOrder, orderNumbers),
    inArray(journalEntry.status, ['POSTED', 'REVERSED']),
  ];
  if (account) conditions.push(eq(journalEntryLine.glAccount, account));
  const rows = await tx.select({
    orderNumber: journalEntryLine.internalOrder,
    account: journalEntryLine.glAccount,
  }).from(journalEntryLine).innerJoin(journalEntry, and(
    eq(journalEntry.client, journalEntryLine.client),
    eq(journalEntry.documentNumber, journalEntryLine.documentNumber),
    eq(journalEntry.fiscalYear, journalEntryLine.fiscalYear),
  )).where(and(...conditions))
    .groupBy(journalEntryLine.internalOrder, journalEntryLine.glAccount)
    .having(sql`sum(case when ${journalEntryLine.debitCredit} = 'S' then ${journalEntryLine.amountLocal} else -${journalEntryLine.amountLocal} end) <> 0`);
  return rows.map((row) => ({ orderNumber: row.orderNumber ?? '', account: row.account }));
}

async function ordersLeftUncovered(
  tx: Tx,
  client: string,
  orderNumbers: string[],
  sourceAccount: string,
): Promise<{ ordersWithBalance: string[]; ordersWithDocuments: string[] }> {
  if (orderNumbers.length === 0) return { ordersWithBalance: [], ordersWithDocuments: [] };
  const documents = await tx.select({ orderNumber: settlementDocument.orderNumber }).from(settlementDocument).where(and(
    eq(settlementDocument.client, client),
    inArray(settlementDocument.orderNumber, orderNumbers),
  ));
  const balances = await balancesByOrderAndAccount(tx, client, orderNumbers, sourceAccount);

  return {
    ordersWithBalance: balances.map((row) => row.orderNumber),
    ordersWithDocuments: [...new Set(documents.map((row) => row.orderNumber))],
  };
}

/** A profile may not stop allowing a method a rule of its orders still uses. */
async function assertMethodsStillAllowed(
  tx: Tx,
  client: string,
  orderNumbers: string[],
  flags: { percentageAllowed: boolean; equivalenceAllowed: boolean; amountAllowed: boolean },
): Promise<void> {
  if (orderNumbers.length === 0) return;
  const rules = await tx.select({
    orderNumber: settlementDistributionRule.orderNumber,
    percentage: settlementDistributionRule.percentage,
    equivalence: settlementDistributionRule.equivalence,
    amount: settlementDistributionRule.amount,
  }).from(settlementDistributionRule).where(and(
    eq(settlementDistributionRule.client, client),
    inArray(settlementDistributionRule.orderNumber, orderNumbers),
  ));
  for (const [method, allowed, column] of [
    ['percentage', flags.percentageAllowed, 'percentage'],
    ['equivalence', flags.equivalenceAllowed, 'equivalence'],
    ['amount', flags.amountAllowed, 'amount'],
  ] as const) {
    if (allowed) continue;
    const used = rules.filter((rule) => rule[column] !== null).map((rule) => rule.orderNumber);
    if (used.length > 0) {
      throw new SettlementMastersError(
        `${used.length} order(s) of this profile distribute by ${method}: ${[...new Set(used)].join(', ')}.`,
        `Keep ${method} allowed on the profile, or change those rules first. Their rules may stand frozen by a settlement document, so the flag is not cleared.`,
      );
    }
  }
}

function assertAccountChoice(byOriginalAccount: boolean, settlementAccount: string | null): void {
  if (byOriginalAccount === (settlementAccount !== null)) {
    throw new SettlementMastersError(
      'Choose the original account or a settlement account, not both and not neither.',
      'An assignment settles against the account it was posted from, or against one named account.',
    );
  }
}

/** Accounts are checked against every chart the client defines: a master row is not company-scoped. */
async function assertAccountsKnown(tx: Tx, client: string, sourceAccount: string, settlementAccount: string | null): Promise<void> {
  for (const account of [sourceAccount, settlementAccount].filter((value): value is string => value !== null)) {
    const [row] = await tx.select({ accountNumber: glAccount.accountNumber }).from(glAccount).where(and(
      eq(glAccount.client, client),
      eq(glAccount.accountNumber, account),
    )).limit(1);
    if (!row) {
      throw new SettlementMastersError(
        `Account ${account} is not in a chart of accounts of this client.`,
        'Name a G/L account the client defines. A settlement account is not invented.',
      );
    }
  }
}

function assignmentKeyOf(
  structureCode: string,
  assignment: { sourceAccount: string; receiverCategory: string },
): string {
  return `${structureCode}/${assignment.sourceAccount}/${assignment.receiverCategory}`;
}

function assignmentWhere(client: string, key: string) {
  const [structureCode, sourceAccount, receiverCategory] = key.split('/');
  return and(
    eq(allocationStructureAssignment.client, client),
    eq(allocationStructureAssignment.structureCode, structureCode!),
    eq(allocationStructureAssignment.sourceAccount, sourceAccount!),
    eq(allocationStructureAssignment.receiverCategory, receiverCategory!),
  );
}

function uncoveredRefusal(
  stranded: { ordersWithBalance: string[] },
  act: 'change' | 'remove',
): SettlementMastersError {
  return new SettlementMastersError(
    `${stranded.ordersWithBalance.length} order(s) still carry a balance on that account: ${[...new Set(stranded.ordersWithBalance)].join(', ')}.`,
    `The assignment is not removed${act === 'change' ? ' or replaced' : ''}, because a settlement would stop with no allocation assignment. Settle those orders or add the mapping elsewhere first.`,
  );
}

function confirmRefusal(code: string, count: number): SettlementMastersError {
  return new SettlementMastersError(
    `${count} order(s) tied to ${code} already have settlement documents.`,
    'Confirm the change. Posted settlements are not rewritten by it, and a re-settlement reads what you store now.',
  );
}

function notFound(what: string): SettlementMastersError {
  return new SettlementMastersError(
    `${what} does not exist.`,
    'Change a stored row. A create is not performed on the side.',
  );
}

function staleVersion(code: string): SettlementMastersError {
  return new SettlementMastersError(
    `${code} stands at another version.`,
    'Re-read the row and repeat the change. Nothing was overwritten.',
  );
}

function invalidInput(error: z.ZodError): SettlementMastersError {
  const first = error.issues[0];
  return new SettlementMastersError(
    `${first?.path.join('.') ?? 'Input'}: ${first?.message ?? 'is not valid.'}`,
    'The value was not replaced with a default.',
  );
}

async function auditVersion(tx: Tx, client: string, objectClass: string, objectKey: string): Promise<number> {
  const [row] = await tx.select({ version: sql<number>`count(*)::int` }).from(changeDocument).where(and(
    eq(changeDocument.client, client),
    eq(changeDocument.objectClass, objectClass),
    eq(changeDocument.objectKey, objectKey),
  ));
  return row?.version ?? 0;
}

function sameProfileValues(
  before: {
    description: string;
    allocationStructure: string;
    documentType: string;
    percentageAllowed: boolean;
    equivalenceAllowed: boolean;
    amountAllowed: boolean;
    isActive: boolean;
  },
  after: {
    description: string;
    allocationStructure: string;
    documentType: string;
    percentageAllowed: boolean;
    equivalenceAllowed: boolean;
    amountAllowed: boolean;
    isActive: boolean;
  },
): boolean {
  return before.description === after.description
    && before.allocationStructure === after.allocationStructure
    && before.documentType === after.documentType
    && before.percentageAllowed === after.percentageAllowed
    && before.equivalenceAllowed === after.equivalenceAllowed
    && before.amountAllowed === after.amountAllowed
    && before.isActive === after.isActive;
}

/**
 * One key per master object, shared by three callers: the advisory lock this module takes inside its
 * transaction, the change session the screen opens before it submits, and the settlement run's read of
 * the same rows. A screen that locked a different string than the writer would let two users edit one
 * row and let the second save stand. The order rule keeps its own key at `lockSettlementRuleForOrder`.
 */
async function lockStructure(tx: Tx, client: string, structureCode: string): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${settlementConfigAdvisoryKey(client, 'structure', structureCode)}, 0))`);
}

async function lockProfile(tx: Tx, client: string, profileCode: string): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${settlementConfigAdvisoryKey(client, 'profile', profileCode)}, 0))`);
}

async function lockOrderType(tx: Tx, client: string, orderType: string): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${settlementConfigAdvisoryKey(client, 'orderType', orderType)}, 0))`);
}

