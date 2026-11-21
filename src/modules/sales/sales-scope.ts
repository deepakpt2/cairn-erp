/**
 * Reach over a sales document: its company code is inside the actor's Company Code scope, its sales area (Sales Org,
 * Distribution Channel, Division) is inside any such restriction the actor holds, and every plant it ships from is
 * inside the Plant scope when one is held. A document outside the reach answers as a missing one.
 */
import type { Tx } from '../../platform/db/client';
import type { CompanyAuthority } from '../../platform/auth/company-scope';
import type { ServiceAuthorityContext } from '../../platform/auth/service-authority';
import {
  orgLevelsAllow, plantsAllow, purchasingActor, type ScopeFailure,
} from '../../platform/auth/scope-actor';
import { hasOrgAccess } from '../../platform/auth/session';

export interface SalesDocumentReach {
  companyCode: string;
  salesOrg: string;
  distributionChannel: string;
  division: string;
  plants?: readonly string[];
}

export async function salesActor(
  tx: Tx, client: string, authorization: ServiceAuthorityContext | undefined,
  capabilities: readonly string[], failure: ScopeFailure,
): Promise<CompanyAuthority> {
  return purchasingActor(tx, client, authorization, capabilities, failure);
}

export function salesDocumentReachable(actor: CompanyAuthority, doc: SalesDocumentReach): boolean {
  return hasOrgAccess(actor.restrictions, 'COMPANY_CODE', doc.companyCode.trim())
    && orgLevelsAllow(actor, {
      SALES_ORG: doc.salesOrg, DISTRIBUTION_CHANNEL: doc.distributionChannel, DIVISION: doc.division,
    })
    && plantsAllow(actor, doc.plants ?? []);
}

/** A sales area on its own (a master or a choice list): the company is the area's sales org's company, when known. */
export function salesAreaReachable(
  actor: CompanyAuthority, area: { salesOrg: string; distributionChannel: string; division: string },
): boolean {
  return orgLevelsAllow(actor, {
    SALES_ORG: area.salesOrg, DISTRIBUTION_CHANNEL: area.distributionChannel, DIVISION: area.division,
  });
}
