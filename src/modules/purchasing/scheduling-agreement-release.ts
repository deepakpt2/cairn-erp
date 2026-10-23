/**
 * ME84 — create scheduling agreement releases.
 *
 * A release is a snapshot of eligible delivery schedule lines. It does not
 * change those lines, create a purchase order, post stock, or notify the
 * supplier. Purchasing output is not configured. There is no job framework.
 * A release profile is configuration. This service does not invent a horizon
 * or a tolerance. LPA is a seeded type name, not a meaning in the code.
 * ME83 and ME88 are not this service.
 */
import { and, asc, desc, eq, sql } from 'drizzle-orm';
import { z } from 'zod';

import { recordChange } from '../../platform/change';
import { type Tx, withTenant } from '../../platform/db/client';
import { allocateNumber } from '../../platform/numbering';
import { fromScaled, toScaled } from '../../platform/posting/decimal';
import { numberRange } from '../../platform/tables/numbering';
import { businessPartner } from '../foundation/business-partner-schema';
import { supplierPurchasing } from '../foundation/supplier-purchasing-schema';
import { materialPlant } from '../inventory/schema';
import {
  documentRelease,
  schedulingAgreement,
  schedulingAgreementItem,
  schedulingAgreementRelease,
  schedulingAgreementReleaseLine,
  schedulingAgreementScheduleLine,
  schedulingAgreementType,
  schedulingReleaseProfile,
  schedulingReleaseProfileAssignment,
} from './schema';

export const RELEASE_CREATE_CAPABILITY = 'PROC.SARELEASE.CREATE';
export const RELEASE_ROUTE = '/purchasing/scheduling-agreement-releases';
export const RELEASE_OBJECT_CLASS = 'scheduling_agreement_release';
export const NOT_TRANSMITTED = 'The release was saved. Purchasing output is not configured, so the supplier was not notified.';

const RELEASE_TYPES = ['FRC', 'JIT'] as const;
type ReleaseType = (typeof RELEASE_TYPES)[number];
const AGGREGATIONS = ['NONE', 'DAY', 'WEEK', 'MONTH'] as const;
const COMPARISONS = ['LINE', 'OVERALL'] as const;

export class SchedulingAgreementReleaseError extends Error {
  readonly remedy?: string;

  constructor(message: string, remedy?: string) {
    super(message);
    this.name = 'SchedulingAgreementReleaseError';
    this.remedy = remedy;
  }
}

const selectionInput = z.object({
  client: z.string().trim().min(1).max(4),
  changedBy: z.string().trim().min(1).max(60),
  agreementFrom: z.string().trim().max(20).optional().default(''),
  agreementTo: z.string().trim().max(20).optional().default(''),
  supplierNumber: z.string().trim().max(40).optional().default(''),
  purchasingOrg: z.string().trim().max(10).optional().default(''),
  purchasingGroup: z.string().trim().max(3).optional().default(''),
  plant: z.string().trim().max(10).optional().default(''),
  itemFrom: z.number().int().positive().optional(),
  itemTo: z.number().int().positive().optional(),
  releaseTypes: z.array(z.enum(RELEASE_TYPES)).min(1),
  generationDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  profileCode: z.string().trim().max(10).optional().default(''),
  requestKey: z.string().trim().max(64).optional(),
}).strict();

export type CreateSchedulingReleasesInput = z.input<typeof selectionInput>;

export interface ReleaseRunLine {
  agreementNumber: string;
  itemNumber: number | null;
  releaseType: string | null;
  reason: string;
}

export interface CreatedRelease {
  releaseNumber: string;
  agreementNumber: string;
  itemNumber: number;
  releaseType: string;
  lineCount: number;
  releasedQuantity: string;
  transmissionStatus: 'NOT_TRANSMITTED';
  transmissionDetail: string;
  reused: boolean;
}

export interface ReleaseRunResult {
  created: CreatedRelease[];
  skipped: ReleaseRunLine[];
  failed: ReleaseRunLine[];
  truncated: boolean;
}

const profileInput = z.object({
  client: z.string().trim().min(1).max(4),
  changedBy: z.string().trim().min(1).max(60),
  profileCode: z.string().trim().min(2).max(10),
  description: z.string().trim().min(1).max(40),
  releaseType: z.enum(RELEASE_TYPES),
  horizonDays: z.number().int().min(0).max(999).nullable().optional(),
  aggregation: z.enum(AGGREGATIONS),
  comparisonMode: z.enum(COMPARISONS),
  tolerancePercent: z.number().min(0).max(999.99).nullable().optional(),
}).strict();

const assignmentInput = z.object({
  client: z.string().trim().min(1).max(4),
  changedBy: z.string().trim().min(1).max(60),
  supplierNumber: z.string().trim().min(1).max(40),
  purchasingOrg: z.string().trim().min(1).max(10),
  plant: z.string().trim().max(10).optional().default(''),
  releaseType: z.enum(RELEASE_TYPES),
  profileCode: z.string().trim().min(2).max(10),
}).strict();

function calendarDate(value: string): void {
  const [year, month, day] = value.split('-').map(Number);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  if (parsed.getUTCFullYear() !== year || parsed.getUTCMonth() !== month - 1 || parsed.getUTCDate() !== day) {
    throw new SchedulingAgreementReleaseError(`${value} is not a calendar date.`);
  }
}

function addDays(iso: string, days: number): string {
  const [year, month, day] = iso.split('-').map(Number);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  parsed.setUTCDate(parsed.getUTCDate() + days);
  return parsed.toISOString().slice(0, 10);
}

function weekStart(iso: string): string {
  const [year, month, day] = iso.split('-').map(Number);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  const weekday = parsed.getUTCDay();
  parsed.setUTCDate(parsed.getUTCDate() - (weekday === 0 ? 6 : weekday - 1));
  return parsed.toISOString().slice(0, 10);
}

function bucketDate(iso: string, aggregation: string): string {
  if (aggregation === 'WEEK') return weekStart(iso);
  if (aggregation === 'MONTH') return `${iso.slice(0, 7)}-01`;
  return iso;
}

function qty(value: string): bigint {
  return toScaled(value, 3);
}

function qtyText(value: bigint): string {
  return fromScaled(value, 3);
}

function beyondTolerance(before: bigint, after: bigint, tolerance: string | null): boolean {
  if (before === after) return false;
  if (tolerance == null) return true;
  if (before === 0n) return after !== 0n;
  const difference = before > after ? before - after : after - before;
  const percent = toScaled(tolerance, 2);
  return difference * 10000n > (before < 0n ? -before : before) * percent;
}

interface SnapshotLine {
  deliveryDate: string;
  quantity: string;
  unit: string;
}

function qualifies(previous: SnapshotLine[] | null, next: SnapshotLine[], mode: string, tolerance: string | null): boolean {
  if (!previous) return next.length > 0;
  if (mode === 'OVERALL') {
    const before = previous.reduce((sum, line) => sum + qty(line.quantity), 0n);
    const after = next.reduce((sum, line) => sum + qty(line.quantity), 0n);
    return beyondTolerance(before, after, tolerance);
  }
  const before = new Map(previous.map((line) => [line.deliveryDate, qty(line.quantity)]));
  const after = new Map(next.map((line) => [line.deliveryDate, qty(line.quantity)]));
  const dates = new Set([...before.keys(), ...after.keys()]);
  for (const date of dates) {
    const left = before.get(date);
    const right = after.get(date);
    if (left == null || right == null) return true;
    if (beyondTolerance(left, right, tolerance)) return true;
  }
  return false;
}

async function businessDate(tx: Tx): Promise<string> {
  const [row] = await tx.execute(sql`select current_date::text as today`) as unknown as Array<{ today: string }>;
  return row?.today ?? new Date().toISOString().slice(0, 10);
}

export async function saveReleaseProfile(raw: z.input<typeof profileInput>): Promise<void> {
  const parsed = profileInput.safeParse(raw);
  if (!parsed.success) throw new SchedulingAgreementReleaseError(parsed.error.issues[0].message);
  const input = parsed.data;
  const code = input.profileCode.toUpperCase();
  await withTenant(input.client, async (tx) => {
    await tx.insert(schedulingReleaseProfile).values({
      client: input.client,
      profileCode: code,
      description: input.description,
      releaseType: input.releaseType,
      horizonDays: input.horizonDays ?? null,
      aggregation: input.aggregation,
      comparisonMode: input.comparisonMode,
      tolerancePercent: input.tolerancePercent == null ? null : input.tolerancePercent.toFixed(2),
      isActive: true,
      createdBy: input.changedBy,
    }).onConflictDoUpdate({
      target: [schedulingReleaseProfile.client, schedulingReleaseProfile.profileCode],
      set: {
        description: input.description,
        releaseType: input.releaseType,
        horizonDays: input.horizonDays ?? null,
        aggregation: input.aggregation,
        comparisonMode: input.comparisonMode,
        tolerancePercent: input.tolerancePercent == null ? null : input.tolerancePercent.toFixed(2),
        isActive: true,
        changedBy: input.changedBy,
        changedAt: new Date(),
      },
    });
  });
}

export async function assignReleaseProfile(raw: z.input<typeof assignmentInput>): Promise<void> {
  const parsed = assignmentInput.safeParse(raw);
  if (!parsed.success) throw new SchedulingAgreementReleaseError(parsed.error.issues[0].message);
  const input = parsed.data;
  await withTenant(input.client, async (tx) => {
    const [profile] = await tx.select().from(schedulingReleaseProfile).where(and(
      eq(schedulingReleaseProfile.client, input.client),
      eq(schedulingReleaseProfile.profileCode, input.profileCode.toUpperCase()),
      eq(schedulingReleaseProfile.isActive, true),
    ));
    if (!profile) {
      throw new SchedulingAgreementReleaseError(`Release profile ${input.profileCode} is not an active profile.`);
    }
    if (profile.releaseType !== input.releaseType) {
      throw new SchedulingAgreementReleaseError(`Release profile ${profile.profileCode} is for ${profile.releaseType}, not ${input.releaseType}.`);
    }
    await tx.insert(schedulingReleaseProfileAssignment).values({
      client: input.client,
      supplierNumber: input.supplierNumber,
      purchasingOrg: input.purchasingOrg,
      plant: input.plant,
      releaseType: input.releaseType,
      profileCode: profile.profileCode,
      createdBy: input.changedBy,
    }).onConflictDoUpdate({
      target: [
        schedulingReleaseProfileAssignment.client,
        schedulingReleaseProfileAssignment.supplierNumber,
        schedulingReleaseProfileAssignment.purchasingOrg,
        schedulingReleaseProfileAssignment.plant,
        schedulingReleaseProfileAssignment.releaseType,
      ],
      set: { profileCode: profile.profileCode, changedBy: input.changedBy, changedAt: new Date() },
    });
  });
}

async function assertRange(client: string): Promise<void> {
  await withTenant(client, async (tx) => {
    const [range] = await tx.select().from(numberRange).where(and(
      eq(numberRange.client, client),
      eq(numberRange.objectCode, 'SARELEASE'),
      eq(numberRange.companyCode, '*'),
      eq(numberRange.subObject, '*'),
      eq(numberRange.fiscalYear, 0),
    ));
    if (!range) {
      throw new SchedulingAgreementReleaseError(
        'No internal SARELEASE number range stands, so no release number can be drawn.',
        'Define an internal SARELEASE interval. External numbering is not assigned by this service.',
      );
    }
    if (range.isExternal) {
      throw new SchedulingAgreementReleaseError(
        'The SARELEASE number range is external. This service does not assign an external number.',
      );
    }
  });
}

function itemRequestKey(requestKey: string | undefined, agreement: string, item: number, releaseType: string): string | null {
  if (!requestKey) return null;
  return `${requestKey}/${agreement}/${item}/${releaseType}`.slice(0, 120);
}

async function latestSnapshot(tx: Tx, client: string, agreement: string, item: number, releaseType: string): Promise<{ number: string; lines: SnapshotLine[] } | null> {
  const [header] = await tx.select().from(schedulingAgreementRelease).where(and(
    eq(schedulingAgreementRelease.client, client),
    eq(schedulingAgreementRelease.agreementNumber, agreement),
    eq(schedulingAgreementRelease.itemNumber, item),
    eq(schedulingAgreementRelease.releaseType, releaseType),
  )).orderBy(desc(schedulingAgreementRelease.createdAt), desc(schedulingAgreementRelease.releaseNumber)).limit(1);
  if (!header) return null;
  const lines = await tx.select().from(schedulingAgreementReleaseLine).where(and(
    eq(schedulingAgreementReleaseLine.client, client),
    eq(schedulingAgreementReleaseLine.releaseNumber, header.releaseNumber),
  )).orderBy(asc(schedulingAgreementReleaseLine.lineNumber));
  return {
    number: header.releaseNumber,
    lines: lines.map((line) => ({ deliveryDate: line.deliveryDate, quantity: line.quantity, unit: line.unit })),
  };
}

async function generateItem(
  input: z.infer<typeof selectionInput>,
  agreementNumber: string,
  itemNumber: number,
  releaseType: ReleaseType,
  generationDate: string,
): Promise<{ created?: CreatedRelease; skipped?: ReleaseRunLine }> {
  return withTenant(input.client, async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`${input.client}/scheduling_agreement/${agreementNumber}`}, 0))`);
    const requestKey = itemRequestKey(input.requestKey, agreementNumber, itemNumber, releaseType);
    if (requestKey) {
      const [existing] = await tx.select().from(schedulingAgreementRelease).where(and(
        eq(schedulingAgreementRelease.client, input.client),
        eq(schedulingAgreementRelease.requestKey, requestKey),
      ));
      if (existing) {
        const lines = await tx.select().from(schedulingAgreementReleaseLine).where(and(
          eq(schedulingAgreementReleaseLine.client, input.client),
          eq(schedulingAgreementReleaseLine.releaseNumber, existing.releaseNumber),
        ));
        return {
          created: {
            releaseNumber: existing.releaseNumber,
            agreementNumber: existing.agreementNumber,
            itemNumber: existing.itemNumber,
            releaseType: existing.releaseType,
            lineCount: lines.length,
            releasedQuantity: existing.releasedQuantity,
            transmissionStatus: 'NOT_TRANSMITTED',
            transmissionDetail: existing.transmissionDetail,
            reused: true,
          },
        };
      }
    }
    const [header] = await tx.select().from(schedulingAgreement).where(and(
      eq(schedulingAgreement.client, input.client),
      eq(schedulingAgreement.agreementNumber, agreementNumber),
    ));
    if (!header) return { skipped: { agreementNumber, itemNumber, releaseType, reason: `Scheduling agreement ${agreementNumber} does not exist.` } };
    const [type] = await tx.select().from(schedulingAgreementType).where(and(
      eq(schedulingAgreementType.client, input.client),
      eq(schedulingAgreementType.documentType, header.documentType),
    ));
    if (!type?.releaseDocumentation) {
      return { skipped: { agreementNumber, itemNumber, releaseType, reason: `Document type ${header.documentType} does not use release documentation.` } };
    }
    const [approval] = await tx.select({ status: documentRelease.status }).from(documentRelease).where(and(
      eq(documentRelease.client, input.client),
      eq(documentRelease.documentCategory, 'SCHED_AGREEMENT'),
      eq(documentRelease.documentNumber, agreementNumber),
    ));
    if (approval?.status === 'PENDING') {
      return { skipped: { agreementNumber, itemNumber, releaseType, reason: 'The agreement is waiting for release. ME84 does not approve it.' } };
    }
    if (generationDate < header.validityStart || generationDate > header.validityEnd) {
      return { skipped: { agreementNumber, itemNumber, releaseType, reason: 'The generation date is outside the agreement validity.' } };
    }
    const [partner] = await tx.select().from(businessPartner).where(and(
      eq(businessPartner.client, input.client),
      eq(businessPartner.partnerNumber, header.supplierNumber),
    ));
    if (!partner || partner.isBlocked) {
      return { skipped: { agreementNumber, itemNumber, releaseType, reason: `Supplier ${header.supplierNumber} does not exist or is blocked.` } };
    }
    const [supplier] = await tx.select().from(supplierPurchasing).where(and(
      eq(supplierPurchasing.client, input.client),
      eq(supplierPurchasing.partnerNumber, header.supplierNumber),
      eq(supplierPurchasing.purchasingOrg, header.purchasingOrg),
    ));
    if (!supplier || supplier.isBlocked) {
      return { skipped: { agreementNumber, itemNumber, releaseType, reason: `Supplier ${header.supplierNumber} has no open purchasing data for organization ${header.purchasingOrg}.` } };
    }
    const [item] = await tx.select().from(schedulingAgreementItem).where(and(
      eq(schedulingAgreementItem.client, input.client),
      eq(schedulingAgreementItem.agreementNumber, agreementNumber),
      eq(schedulingAgreementItem.itemNumber, itemNumber),
    ));
    if (!item) return { skipped: { agreementNumber, itemNumber, releaseType, reason: `Item ${itemNumber} does not belong to this agreement.` } };
    if (item.markedForDeletion) {
      return { skipped: { agreementNumber, itemNumber, releaseType, reason: `Item ${itemNumber} is marked for deletion.` } };
    }
    if (releaseType === 'JIT') {
      if (!item.jitEnabled) {
        return { skipped: { agreementNumber, itemNumber, releaseType, reason: 'JIT is not enabled on this agreement item.' } };
      }
      if (!item.materialNumber || !item.plant) {
        return { skipped: { agreementNumber, itemNumber, releaseType, reason: 'JIT requires a material and a plant on the agreement item.' } };
      }
      const [plant] = await tx.select().from(materialPlant).where(and(
        eq(materialPlant.client, input.client),
        eq(materialPlant.materialNumber, item.materialNumber),
        eq(materialPlant.plant, item.plant),
      ));
      if (!plant?.jitDeliverySchedule) {
        return { skipped: { agreementNumber, itemNumber, releaseType, reason: 'JIT is not enabled on the material plant.' } };
      }
    }
    let profile = input.profileCode
      ? (await tx.select().from(schedulingReleaseProfile).where(and(
          eq(schedulingReleaseProfile.client, input.client),
          eq(schedulingReleaseProfile.profileCode, input.profileCode.toUpperCase()),
        )))[0]
      : undefined;
    if (input.profileCode) {
      if (!profile?.isActive) {
        return { skipped: { agreementNumber, itemNumber, releaseType, reason: `Release profile ${input.profileCode} is not an active profile.` } };
      }
      if (profile.releaseType !== releaseType) {
        return { skipped: { agreementNumber, itemNumber, releaseType, reason: `Release profile ${profile.profileCode} is for ${profile.releaseType}, not ${releaseType}.` } };
      }
    } else {
      const assignments = await tx.select().from(schedulingReleaseProfileAssignment).where(and(
        eq(schedulingReleaseProfileAssignment.client, input.client),
        eq(schedulingReleaseProfileAssignment.supplierNumber, header.supplierNumber),
        eq(schedulingReleaseProfileAssignment.purchasingOrg, header.purchasingOrg),
        eq(schedulingReleaseProfileAssignment.releaseType, releaseType),
      ));
      const plant = item.plant ?? '';
      const assigned = assignments.find((row) => row.plant === plant) ?? assignments.find((row) => row.plant === '');
      if (!assigned) {
        return { skipped: { agreementNumber, itemNumber, releaseType, reason: 'No release creation profile is configured for this supplier, purchasing organization, and release type.' } };
      }
      const [loaded] = await tx.select().from(schedulingReleaseProfile).where(and(
        eq(schedulingReleaseProfile.client, input.client),
        eq(schedulingReleaseProfile.profileCode, assigned.profileCode),
      ));
      if (!loaded?.isActive) {
        return { skipped: { agreementNumber, itemNumber, releaseType, reason: `Release profile ${assigned.profileCode} is not active.` } };
      }
      profile = loaded;
    }
    if (!profile) {
      return { skipped: { agreementNumber, itemNumber, releaseType, reason: 'No release creation profile is configured for this supplier, purchasing organization, and release type.' } };
    }
    const schedule = await tx.select().from(schedulingAgreementScheduleLine).where(and(
      eq(schedulingAgreementScheduleLine.client, input.client),
      eq(schedulingAgreementScheduleLine.agreementNumber, agreementNumber),
      eq(schedulingAgreementScheduleLine.itemNumber, itemNumber),
    ));
    const buckets = new Map<string, bigint>();
    for (const line of schedule) {
      if (line.markedForDeletion) continue;
      if (line.unit && line.unit !== item.unit) {
        return { skipped: { agreementNumber, itemNumber, releaseType, reason: `A schedule line unit does not match item unit ${item.unit}.` } };
      }
      if (line.deliveryDate < header.validityStart || line.deliveryDate > header.validityEnd) continue;
      if (profile.horizonDays != null && (line.deliveryDate < generationDate || line.deliveryDate > addDays(generationDate, profile.horizonDays))) continue;
      const key = bucketDate(line.deliveryDate, profile.aggregation);
      buckets.set(key, (buckets.get(key) ?? 0n) + qty(line.quantity));
    }
    const next: SnapshotLine[] = [...buckets.entries()]
      .filter(([, quantity]) => quantity > 0n)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([deliveryDate, quantity]) => ({ deliveryDate, quantity: qtyText(quantity), unit: item.unit }));
    if (next.length === 0) {
      return { skipped: { agreementNumber, itemNumber, releaseType, reason: 'No delivery schedule lines fall in the release horizon.' } };
    }
    const previous = await latestSnapshot(tx, input.client, agreementNumber, itemNumber, releaseType);
    if (!qualifies(previous?.lines ?? null, next, profile.comparisonMode, profile.tolerancePercent)) {
      return { skipped: { agreementNumber, itemNumber, releaseType, reason: `No qualifying change since release ${previous?.number}.` } };
    }
    const drawn = await allocateNumber(tx, {
      client: input.client,
      objectCode: 'SARELEASE',
      companyCode: '*',
      subObject: '*',
      fiscalYear: 0,
      allocatedBy: input.changedBy,
    });
    if (drawn.display.length > 20) {
      throw new SchedulingAgreementReleaseError('The drawn release number is longer than the release number field.');
    }
    const released = next.reduce((sum, line) => sum + qty(line.quantity), 0n);
    await tx.insert(schedulingAgreementRelease).values({
      client: input.client,
      releaseNumber: drawn.display,
      agreementNumber,
      itemNumber,
      releaseType,
      profileCode: profile.profileCode,
      aggregation: profile.aggregation,
      comparisonMode: profile.comparisonMode,
      horizonDays: profile.horizonDays,
      tolerancePercent: profile.tolerancePercent,
      generationDate,
      releasedQuantity: qtyText(released),
      transmissionStatus: 'NOT_TRANSMITTED',
      transmissionDetail: NOT_TRANSMITTED,
      requestKey,
      createdBy: input.changedBy,
    });
    let lineNumber = 0;
    for (const line of next) {
      lineNumber += 1;
      await tx.insert(schedulingAgreementReleaseLine).values({
        client: input.client,
        releaseNumber: drawn.display,
        lineNumber,
        deliveryDate: line.deliveryDate,
        quantity: line.quantity,
        unit: line.unit,
        createdBy: input.changedBy,
      });
    }
    await recordChange(tx, {
      client: input.client,
      objectClass: RELEASE_OBJECT_CLASS,
      objectKey: drawn.display,
      changeType: 'CREATE',
      changedBy: input.changedBy,
      transactionCode: 'ME84',
      after: {
        agreementNumber,
        itemNumber: String(itemNumber),
        releaseType,
        transmissionStatus: 'NOT_TRANSMITTED',
      },
    });
    return {
      created: {
        releaseNumber: drawn.display,
        agreementNumber,
        itemNumber,
        releaseType,
        lineCount: next.length,
        releasedQuantity: qtyText(released),
        transmissionStatus: 'NOT_TRANSMITTED',
        transmissionDetail: NOT_TRANSMITTED,
        reused: false,
      },
    };
  });
}

export async function createSchedulingAgreementReleases(raw: CreateSchedulingReleasesInput): Promise<ReleaseRunResult> {
  const parsed = selectionInput.safeParse(raw);
  if (!parsed.success) throw new SchedulingAgreementReleaseError(parsed.error.issues[0].message);
  const input = parsed.data;
  if (!input.agreementFrom && !input.supplierNumber && !input.purchasingOrg && !input.plant) {
    throw new SchedulingAgreementReleaseError('Enter an agreement, a supplier, a purchasing organization, or a plant.');
  }
  if (input.agreementFrom && input.agreementTo && input.agreementFrom > input.agreementTo) {
    throw new SchedulingAgreementReleaseError('The agreement number from is after the agreement number to.');
  }
  if (input.itemFrom && input.itemTo && input.itemFrom > input.itemTo) {
    throw new SchedulingAgreementReleaseError('The item number from is after the item number to.');
  }
  if (input.generationDate) calendarDate(input.generationDate);
  await assertRange(input.client);
  const result: ReleaseRunResult = { created: [], skipped: [], failed: [], truncated: false };
  const agreements = await withTenant(input.client, async (tx) => {
    const conditions = [eq(schedulingAgreement.client, input.client)];
    if (input.supplierNumber) conditions.push(eq(schedulingAgreement.supplierNumber, input.supplierNumber));
    if (input.purchasingOrg) conditions.push(eq(schedulingAgreement.purchasingOrg, input.purchasingOrg));
    if (input.purchasingGroup) conditions.push(eq(schedulingAgreement.purchasingGroup, input.purchasingGroup));
    return tx.select().from(schedulingAgreement).where(and(...conditions)).orderBy(asc(schedulingAgreement.agreementNumber));
  });
  const from = input.agreementFrom;
  const to = input.agreementTo || input.agreementFrom;
  const selected = agreements.filter((row) => {
    if (from && row.agreementNumber < from) return false;
    if (to && row.agreementNumber > to) return false;
    return true;
  });
  if (from && from === to && selected.length === 0) {
    result.skipped.push({ agreementNumber: from, itemNumber: null, releaseType: null, reason: `Scheduling agreement ${from} does not exist.` });
    return result;
  }
  const limited = selected.slice(0, 100);
  result.truncated = selected.length > 100;
  const generationDate = input.generationDate ?? await withTenant(input.client, (tx) => businessDate(tx));
  for (const agreement of limited) {
    const items = await withTenant(input.client, async (tx) => tx.select().from(schedulingAgreementItem).where(and(
      eq(schedulingAgreementItem.client, input.client),
      eq(schedulingAgreementItem.agreementNumber, agreement.agreementNumber),
    )).orderBy(asc(schedulingAgreementItem.itemNumber)));
    const matching = items.filter((item) => {
      if (input.plant && item.plant !== input.plant) return false;
      if (input.itemFrom && item.itemNumber < input.itemFrom) return false;
      if (input.itemTo && item.itemNumber > input.itemTo) return false;
      return true;
    });
    if (matching.length === 0) {
      result.skipped.push({
        agreementNumber: agreement.agreementNumber,
        itemNumber: null,
        releaseType: null,
        reason: 'No agreement item matches the plant or item selection.',
      });
      continue;
    }
    for (const item of matching) {
      for (const releaseType of input.releaseTypes) {
        try {
          const outcome = await generateItem(input, agreement.agreementNumber, item.itemNumber, releaseType, generationDate);
          if (outcome.created) result.created.push(outcome.created);
          if (outcome.skipped) result.skipped.push(outcome.skipped);
        } catch (error) {
          result.failed.push({
            agreementNumber: agreement.agreementNumber,
            itemNumber: item.itemNumber,
            releaseType,
            reason: error instanceof Error ? error.message : 'The release could not be created.',
          });
        }
      }
    }
  }
  return result;
}

export async function listSchedulingAgreementReleases(client: string, agreementNumber: string) {
  return withTenant(client, async (tx) => {
    const headers = await tx.select().from(schedulingAgreementRelease).where(and(
      eq(schedulingAgreementRelease.client, client),
      eq(schedulingAgreementRelease.agreementNumber, agreementNumber.trim()),
    )).orderBy(desc(schedulingAgreementRelease.createdAt));
    const listed = [];
    for (const header of headers) {
      const lines = await tx.select().from(schedulingAgreementReleaseLine).where(and(
        eq(schedulingAgreementReleaseLine.client, client),
        eq(schedulingAgreementReleaseLine.releaseNumber, header.releaseNumber),
      )).orderBy(asc(schedulingAgreementReleaseLine.lineNumber));
      listed.push({
        releaseNumber: header.releaseNumber,
        agreementNumber: header.agreementNumber,
        itemNumber: header.itemNumber,
        releaseType: header.releaseType,
        generationDate: header.generationDate,
        releasedQuantity: header.releasedQuantity,
        transmissionStatus: header.transmissionStatus,
        transmissionDetail: header.transmissionDetail,
        lines: lines.map((line) => ({
          lineNumber: line.lineNumber,
          deliveryDate: line.deliveryDate,
          quantity: line.quantity,
          unit: line.unit,
        })),
      });
    }
    return listed;
  });
}
