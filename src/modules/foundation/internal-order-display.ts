/**
 * KO03 — display an internal order. This service has no save.
 */
import { z } from 'zod';

import { getInternalOrder, type InternalOrderDocument, InternalOrderError } from './internal-order';

const displayInput = z.object({
  client: z.string().trim().min(1).max(4),
  orderNumber: z.string().trim().min(1).max(20),
}).strict();

export async function displayInternalOrder(raw: unknown): Promise<InternalOrderDocument> {
  const parsed = displayInput.safeParse(raw);
  if (!parsed.success) {
    throw new InternalOrderError('Display takes the client and order number only. It does not accept a change.');
  }
  const document = await getInternalOrder(parsed.data.client, parsed.data.orderNumber);
  if (!document) throw new InternalOrderError(`Internal order ${parsed.data.orderNumber} does not exist.`);
  return document;
}
