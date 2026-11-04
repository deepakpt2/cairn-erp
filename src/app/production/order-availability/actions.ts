'use server';

import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';

import { requireCapability } from '@/platform/auth/current';
import {
  PRODUCTION_ORDER_AVAILABILITY_COMMIT_CAPABILITY,
  PRODUCTION_ORDER_AVAILABILITY_RESET_CAPABILITY,
} from '@/platform/auth/capability-policy';
import { ORDER_AVAILABILITY_ROUTE } from '@/modules/production/order-availability';
import {
  OrderAvailabilityCommitmentError,
  commitOrderComponentAvailability,
  resetOrderComponentAvailability,
} from '@/modules/production/order-availability-commitment';

function pageUrl(input: {
  orderNumber: string;
  itemNumber: string;
  horizonEnd: string;
  message: string;
  kind: 'success' | 'error';
}): string {
  const params = new URLSearchParams();
  if (input.orderNumber) params.set('order', input.orderNumber);
  if (input.itemNumber) params.set('item', input.itemNumber);
  if (input.horizonEnd) params.set('horizonEnd', input.horizonEnd);
  params.set('actionMessage', input.message);
  params.set('actionKind', input.kind);
  return `${ORDER_AVAILABILITY_ROUTE}?${params.toString()}`;
}

function formString(formData: FormData, key: string): string {
  return String(formData.get(key) ?? '').trim();
}

export async function commitAvailabilityAction(formData: FormData): Promise<void> {
  const session = await requireCapability(PRODUCTION_ORDER_AVAILABILITY_COMMIT_CAPABILITY);
  const orderNumber = formString(formData, 'orderNumber').toUpperCase();
  const itemNumber = formString(formData, 'itemNumber');
  const horizonEnd = formString(formData, 'horizonEnd');
  let message: string;
  let kind: 'success' | 'error';
  try {
    const result = await commitOrderComponentAvailability({
      client: session.user.client,
      changedBy: session.user.username,
      capabilities: session.user.capabilities,
      requestKey: formString(formData, 'requestKey'),
      orderNumber,
      itemNumber,
      today: formString(formData, 'today') || new Date().toISOString().slice(0, 10),
      horizonEnd: horizonEnd || null,
    });
    message = result.message;
    kind = 'success';
  } catch (error) {
    message = error instanceof OrderAvailabilityCommitmentError
      ? (error.remedy ? `${error.message} ${error.remedy}` : error.message)
      : error instanceof Error ? error.message : 'The CO09 commitment could not be saved.';
    kind = 'error';
  }
  revalidatePath(ORDER_AVAILABILITY_ROUTE);
  redirect(pageUrl({ orderNumber, itemNumber, horizonEnd, message, kind }));
}

export async function resetAvailabilityAction(formData: FormData): Promise<void> {
  const session = await requireCapability(PRODUCTION_ORDER_AVAILABILITY_RESET_CAPABILITY);
  const orderNumber = formString(formData, 'orderNumber').toUpperCase();
  const itemNumber = formString(formData, 'itemNumber');
  const horizonEnd = formString(formData, 'horizonEnd');
  let message: string;
  let kind: 'success' | 'error';
  try {
    const result = await resetOrderComponentAvailability({
      client: session.user.client,
      changedBy: session.user.username,
      capabilities: session.user.capabilities,
      requestKey: formString(formData, 'requestKey'),
      orderNumber,
      itemNumber,
      reason: formString(formData, 'reason'),
    });
    message = result.message;
    kind = 'success';
  } catch (error) {
    message = error instanceof OrderAvailabilityCommitmentError
      ? (error.remedy ? `${error.message} ${error.remedy}` : error.message)
      : error instanceof Error ? error.message : 'The CO09 commitment could not be reset.';
    kind = 'error';
  }
  revalidatePath(ORDER_AVAILABILITY_ROUTE);
  redirect(pageUrl({ orderNumber, itemNumber, horizonEnd, message, kind }));
}
