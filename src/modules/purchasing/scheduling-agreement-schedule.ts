/**
 * ME38 — maintain delivery schedule lines for a scheduling agreement.
 *
 * This writes schedule lines on the agreement item. It does not create an
 * agreement, a purchase order, a goods receipt, or a supplier release.
 * ME39 only reads. ME84 is not this service. A firm zone is not stored.
 */
import { and, eq, sql } from 'drizzle-orm';
import { z } from 'zod';

import { recordChange } from '../../platform/change';
import { type Tx, withTenant } from '../../platform/db/client';
import { fromScaled, toScaled } from '../../platform/posting/decimal';
import { businessPartner } from '../foundation/business-partner-schema';
import { supplierPurchasing } from '../foundation/supplier-purchasing-schema';
import {
  SCHEDULING_AGREEMENT_OBJECT_CLASS,
  getSchedulingAgreement,
} from './scheduling-agreement';
import {
  schedulingAgreement,
  schedulingAgreementItem,
  schedulingAgreementScheduleLine,
} from './schema';

export const SCHEDULE_MAINTAIN_CAPABILITY = 'PROC.SCHEDLINE.MAINTAIN';
export const SCHEDULE_DISPLAY_CAPABILITY = 'PROC.SCHEDLINE.DISPLAY';
export const SCHEDULE_ROUTE = '/purchasing/delivery-schedule';

const lineInput = z.object({
  lineNumber: z.number().int().positive().optional(),
  deliveryDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  quantity: z.number().positive().finite(),
  unit: z.string().trim().max(6).optional().default(''),
  markedForDeletion: z.boolean().optional().default(false),
}).strict();

const maintainInput = z.object({
  client: z.string().trim().min(1).max(4),
  changedBy: z.string().trim().min(1).max(60),
  agreementNumber: z.string().trim().min(1).max(20),
  itemNumber: z.number().int().positive(),
  lines: z.array(lineInput).min(1),
}).strict();

export type MaintainScheduleInput = z.input<typeof maintainInput>;

export class SchedulingAgreementScheduleError extends Error {
  readonly remedy?: string;

  constructor(message: string, remedy?: string) {
    super(message);
    this.name = 'SchedulingAgreementScheduleError';
    this.remedy = remedy;
  }
}

function calendarDate(value: string): void {
  const [year, month, day] = value.split('-').map(Number);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  if (parsed.getUTCFullYear() !== year || parsed.getUTCMonth() !== month - 1 || parsed.getUTCDate() !== day) {
    throw new SchedulingAgreementScheduleError(`${value} is not a calendar date.`, 'Enter the delivery date as a calendar date. It is not shifted.');
  }
}

function quantity(value: number): string {
  const text = Object.is(value, -0) ? '0' : value.toString();
  if (!Number.isFinite(value) || value <= 0 || /e/i.test(text)) {
    throw new SchedulingAgreementScheduleError('The scheduled quantity is not a valid quantity.');
  }
  const fraction = text.split('.')[1] ?? '';
  if (fraction.length > 3) {
    throw new SchedulingAgreementScheduleError('The scheduled quantity has more than 3 decimal places.');
  }
  return fromScaled(toScaled(text, 3), 3);
}

function snapshot(rows: Array<{
  lineNumber: number;
  deliveryDate: string;
  quantity: string;
  markedForDeletion: boolean;
}>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const row of rows) {
    result[`line${row.lineNumber}Date`] = row.deliveryDate;
    result[`line${row.lineNumber}Quantity`] = row.quantity;
    result[`line${row.lineNumber}Deleted`] = row.markedForDeletion ? 'true' : 'false';
  }
  return result;
}

export async function maintainDeliverySchedule(
  raw: MaintainScheduleInput,
): Promise<{ agreementNumber: string; itemNumber: number }> {
  const parsed = maintainInput.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new SchedulingAgreementScheduleError(`${issue.path.join('.') || 'schedule'}: ${issue.message}`);
  }
  const input = parsed.data;
  const seen = new Set<number>();
  for (const line of input.lines) {
    calendarDate(line.deliveryDate);
    if (line.lineNumber == null) continue;
    if (seen.has(line.lineNumber)) {
      throw new SchedulingAgreementScheduleError(`Schedule line ${line.lineNumber} is named more than once.`);
    }
    seen.add(line.lineNumber);
  }
  await withTenant(input.client, async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`${input.client}/scheduling_agreement/${input.agreementNumber}`}, 0))`);
    const [header] = await tx.select().from(schedulingAgreement).where(and(
      eq(schedulingAgreement.client, input.client),
      eq(schedulingAgreement.agreementNumber, input.agreementNumber),
    ));
    if (!header) throw new SchedulingAgreementScheduleError(`Scheduling agreement ${input.agreementNumber} does not exist.`);
    const [partner] = await tx.select().from(businessPartner).where(and(
      eq(businessPartner.client, input.client),
      eq(businessPartner.partnerNumber, header.supplierNumber),
    ));
    if (partner?.isBlocked) {
      throw new SchedulingAgreementScheduleError(`Supplier ${header.supplierNumber} is blocked.`);
    }
    const [supplierOrg] = await tx.select().from(supplierPurchasing).where(and(
      eq(supplierPurchasing.client, input.client),
      eq(supplierPurchasing.partnerNumber, header.supplierNumber),
      eq(supplierPurchasing.purchasingOrg, header.purchasingOrg),
    ));
    if (supplierOrg?.isBlocked) {
      throw new SchedulingAgreementScheduleError(`Supplier ${header.supplierNumber} is blocked for purchasing organization ${header.purchasingOrg}.`);
    }
    const [item] = await tx.select().from(schedulingAgreementItem).where(and(
      eq(schedulingAgreementItem.client, input.client),
      eq(schedulingAgreementItem.agreementNumber, input.agreementNumber),
      eq(schedulingAgreementItem.itemNumber, input.itemNumber),
    ));
    if (!item) {
      throw new SchedulingAgreementScheduleError(`Item ${input.itemNumber} does not belong to scheduling agreement ${input.agreementNumber}.`);
    }
    if (item.markedForDeletion) {
      throw new SchedulingAgreementScheduleError(`Item ${input.itemNumber} is marked for deletion. A schedule line cannot be maintained.`);
    }
    const standing = await tx.select().from(schedulingAgreementScheduleLine).where(and(
      eq(schedulingAgreementScheduleLine.client, input.client),
      eq(schedulingAgreementScheduleLine.agreementNumber, input.agreementNumber),
      eq(schedulingAgreementScheduleLine.itemNumber, input.itemNumber),
    ));
    const before = snapshot(standing);
    let nextNumber = standing.reduce((max, line) => Math.max(max, line.lineNumber), 0);
    for (const line of input.lines) {
      if (line.lineNumber != null) nextNumber = Math.max(nextNumber, line.lineNumber);
    }
    const commands: Array<{ lineNumber: number; deliveryDate: string; quantity: string; markedForDeletion: boolean; isNew: boolean }> = [];
    for (const line of input.lines) {
      if (line.unit.trim() && line.unit.trim().toUpperCase() !== item.unit) {
        throw new SchedulingAgreementScheduleError(
          `Schedule line unit ${line.unit.trim().toUpperCase()} does not match item unit ${item.unit}.`,
          'The schedule line uses the agreement item unit. A conversion is not stored here.',
        );
      }
      if (line.deliveryDate < header.validityStart || line.deliveryDate > header.validityEnd) {
        throw new SchedulingAgreementScheduleError(
          `Delivery date ${line.deliveryDate} is outside agreement validity ${header.validityStart} to ${header.validityEnd}.`,
        );
      }
      const lineNumber = line.lineNumber ?? (nextNumber += 1);
      commands.push({
        lineNumber,
        deliveryDate: line.deliveryDate,
        quantity: quantity(line.quantity),
        markedForDeletion: line.markedForDeletion,
        isNew: !standing.some((row) => row.lineNumber === lineNumber),
      });
    }
    const active = new Map<number, string>();
    for (const row of standing) {
      if (!row.markedForDeletion) active.set(row.lineNumber, row.quantity);
    }
    for (const command of commands) {
      if (command.markedForDeletion) active.delete(command.lineNumber);
      else active.set(command.lineNumber, command.quantity);
    }
    const total = [...active.values()].reduce((sum, value) => sum + toScaled(value, 3), 0n);
    if (total > toScaled(item.targetQuantity, 3)) {
      throw new SchedulingAgreementScheduleError(
        `Scheduled quantity ${fromScaled(total, 3)} exceeds target quantity ${item.targetQuantity}.`,
        'A partial schedule is allowed. No overdelivery tolerance is configured, so the total cannot exceed the target. The lines were not saved.',
      );
    }
    for (const command of commands) {
      if (command.isNew) {
        await tx.insert(schedulingAgreementScheduleLine).values({
          client: input.client,
          agreementNumber: input.agreementNumber,
          itemNumber: input.itemNumber,
          lineNumber: command.lineNumber,
          deliveryDate: command.deliveryDate,
          quantity: command.quantity,
          unit: item.unit,
          markedForDeletion: command.markedForDeletion,
          createdBy: input.changedBy,
        });
      } else {
        await tx.update(schedulingAgreementScheduleLine).set({
          deliveryDate: command.deliveryDate,
          quantity: command.quantity,
          unit: item.unit,
          markedForDeletion: command.markedForDeletion,
          changedBy: input.changedBy,
          changedAt: new Date(),
        }).where(and(
          eq(schedulingAgreementScheduleLine.client, input.client),
          eq(schedulingAgreementScheduleLine.agreementNumber, input.agreementNumber),
          eq(schedulingAgreementScheduleLine.itemNumber, input.itemNumber),
          eq(schedulingAgreementScheduleLine.lineNumber, command.lineNumber),
        ));
      }
    }
    const afterRows = await tx.select().from(schedulingAgreementScheduleLine).where(and(
      eq(schedulingAgreementScheduleLine.client, input.client),
      eq(schedulingAgreementScheduleLine.agreementNumber, input.agreementNumber),
      eq(schedulingAgreementScheduleLine.itemNumber, input.itemNumber),
    ));
    await recordChange(tx, {
      client: input.client,
      objectClass: SCHEDULING_AGREEMENT_OBJECT_CLASS,
      objectKey: input.agreementNumber,
      changeType: 'CHANGE',
      changedBy: input.changedBy,
      transactionCode: 'ME38',
      before,
      after: snapshot(afterRows),
    });
  });
  return { agreementNumber: input.agreementNumber, itemNumber: input.itemNumber };
}

export async function readDeliverySchedule(client: string, agreementNumber: string, itemNumber?: number) {
  const document = await getSchedulingAgreement(client, agreementNumber);
  if (!document) return null;
  if (itemNumber == null) return document;
  return {
    ...document,
    items: document.items.filter((item) => item.itemNumber === itemNumber),
    scheduleLines: document.scheduleLines.filter((line) => line.itemNumber === itemNumber),
  };
}
