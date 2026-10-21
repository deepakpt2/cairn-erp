'use server';

/**
 * The suggestion door. The client comes from the session, never from the browser.
 * The query writes nothing.
 */
import { requireSession } from '@/platform/auth/current';
import {
  CONSTRAINED_KINDS,
  suggestConstrainedValues,
  type ConstrainedContext,
  type ConstrainedKind,
  type ConstrainedValue,
} from '@/modules/foundation/constrained-values';

export async function suggestConstrainedAction(input: {
  kind: string;
  query?: string;
  limit?: number;
  context?: ConstrainedContext;
}): Promise<ConstrainedValue[]> {
  const session = await requireSession();
  if (!CONSTRAINED_KINDS.includes(input.kind as ConstrainedKind)) return [];
  return suggestConstrainedValues(
    session.user.client,
    input.kind as ConstrainedKind,
    input.query ?? '',
    input.context ?? {},
    input.limit ?? 5,
  );
}
