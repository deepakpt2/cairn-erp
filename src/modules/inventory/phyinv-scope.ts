/**
 * Plant-scope judgement shared by the physical inventory services (count, differences, posting, recount).
 *
 * A count document belongs to one plant, and a plant to one company. The service judges, inside its own
 * transaction and before it reads or replays anything: the session, the live capability, and the plant's reach
 * (company in the explicit Company Code scope; Plant scope honoured). A document in an unreachable plant answers
 * exactly as a missing one. The recorded actor is the session user.
 */
import type { CompanyAuthority } from '../../platform/auth/company-scope';
import { purchasingActor, reachablePlantsInTx, type ScopeFailure } from '../../platform/auth/scope-actor';
import type { ServiceAuthorityContext } from '../../platform/auth/service-authority';
import type { Tx } from '../../platform/db/client';

export interface PhyInvScope {
  actor: CompanyAuthority;
  username: string;
  reachable: Set<string>;
}

export async function phyInvScope(
  tx: Tx, client: string, authorization: ServiceAuthorityContext | undefined,
  capabilities: readonly string[], failure: ScopeFailure,
): Promise<PhyInvScope> {
  const actor = await purchasingActor(tx, client, authorization, capabilities, failure);
  return { actor, username: actor.username, reachable: new Set(await reachablePlantsInTx(tx, client, actor)) };
}
