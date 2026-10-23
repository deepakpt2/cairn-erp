/**
 * ME39 — display delivery schedule lines.
 *
 * A read of the lines that already stand. It writes nothing and does not
 * release, reprice, or send a supplier message.
 */
import { changeHistory } from '../../platform/change';
import { withTenant } from '../../platform/db/client';
import { SCHEDULING_AGREEMENT_OBJECT_CLASS } from './scheduling-agreement';
import { readDeliverySchedule } from './scheduling-agreement-schedule';
import type { SchedulingAgreementDocument } from './scheduling-agreement';

export const SCHEDULE_DISPLAY_ROUTE = '/purchasing/delivery-schedule-display';

const REFUSED: Record<string, string> = {
  save: 'Display does not save a delivery schedule.',
  quantity: 'A quantity change is not this display.',
  price: 'A price is not stored on a schedule line.',
  release: 'This display does not release a scheduling agreement or send a supplier release.',
  output: 'Schedule output is not stored. This display does not send a message.',
  fixed: 'A fixed indicator is not stored.',
  firmZone: 'A firm zone is not stored.',
  mrp: 'This display does not run MRP.',
  stock: 'This display does not post a goods receipt.',
};

const KNOWN = new Set(['agreement', 'item']);

export class DeliveryScheduleDisplayError extends Error {
  constructor(message: string, readonly remedy?: string) {
    super(message);
    this.name = 'DeliveryScheduleDisplayError';
  }
}

function fail(message: string, remedy?: string): never {
  throw new DeliveryScheduleDisplayError(message, remedy);
}

function refuseNamed(params: Record<string, string>): void {
  for (const [name, value] of Object.entries(params)) {
    if (!value.trim() || KNOWN.has(name)) continue;
    fail(REFUSED[name] ?? `${name} is not a field on this display.`, 'Open the agreement and item. This display does not save.');
  }
}

export async function openDeliveryScheduleDisplay(
  client: string,
  params: Record<string, string>,
): Promise<{
  refusal: { message: string; remedy?: string } | null;
  document: SchedulingAgreementDocument | null;
}> {
  try {
    refuseNamed(params);
    const agreement = params.agreement?.trim() ?? '';
    if (!agreement) return { refusal: null, document: null };
    if (agreement.length > 20) fail('The agreement number is too long.');
    const itemText = params.item?.trim() ?? '';
    const itemNumber = itemText ? Number(itemText) : undefined;
    if (itemText && (!Number.isInteger(itemNumber) || (itemNumber ?? 0) <= 0)) {
      fail('The item number is not valid.');
    }
    const document = await readDeliverySchedule(client, agreement, itemNumber);
    if (!document || (itemNumber != null && document.items.length === 0)) {
      return {
        refusal: { message: `Scheduling agreement ${agreement} item ${itemText || '—'} does not exist.`, remedy: 'Choose an agreement and item that stand in this client.' },
        document: null,
      };
    }
    return { refusal: null, document };
  } catch (error) {
    if (error instanceof DeliveryScheduleDisplayError) {
      return { refusal: { message: error.message, remedy: error.remedy }, document: null };
    }
    throw error;
  }
}

export async function deliveryScheduleHistory(client: string, agreementNumber: string) {
  return withTenant(client, async (tx) => {
    const documents = await changeHistory(tx, client, SCHEDULING_AGREEMENT_OBJECT_CLASS, agreementNumber);
    return documents.filter((entry) => entry.transactionCode === 'ME38');
  });
}
