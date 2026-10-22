import { and, eq } from 'drizzle-orm';

import type { Tx } from '../../platform/db/client';
import { plant, purchasingOrg, purchasingOrgPlant } from './schema';

/**
 * The direct assignment is the authorization. A company-code match is a
 * separate rule and does not stand in for this row. A requisition does not
 * name a purchasing organisation, so it has no combination to refuse; the
 * order that converts it does.
 */
export const PURCH_ORG_PLANT_NOT_AUTHORIZED = 'PURCH_ORG_PLANT_NOT_AUTHORIZED';

export class PurchasingOrgPlantAuthorizationError extends Error {
  readonly code = PURCH_ORG_PLANT_NOT_AUTHORIZED;
  readonly details: { purchasingOrg: string; plant: string; documentType: string };

  constructor(
    message: string,
    readonly remedy: string,
    details: { purchasingOrg: string; plant: string; documentType: string },
  ) {
    super(message);
    this.name = 'PurchasingOrgPlantAuthorizationError';
    this.details = details;
  }
}

export async function purchasingOrgMayBuyForPlant(
  tx: Tx,
  client: string,
  purchasingOrgCode: string,
  plantCode: string,
): Promise<boolean> {
  const [row] = await tx
    .select({ plant: purchasingOrgPlant.plant })
    .from(purchasingOrgPlant)
    .where(and(
      eq(purchasingOrgPlant.client, client),
      eq(purchasingOrgPlant.purchasingOrg, purchasingOrgCode),
      eq(purchasingOrgPlant.plant, plantCode),
    ))
    .limit(1);
  return Boolean(row);
}

/** The read every document that names both an organisation and a plant uses. It writes nothing. */
export async function assertPurchasingOrgForPlant(
  tx: Tx,
  input: { client: string; purchasingOrg: string; plant: string; documentType: string },
): Promise<void> {
  const org = input.purchasingOrg.trim().toUpperCase();
  const site = input.plant.trim().toUpperCase();
  const details = { purchasingOrg: org, plant: site, documentType: input.documentType };
  const [organisation] = await tx
    .select({ isActive: purchasingOrg.isActive })
    .from(purchasingOrg)
    .where(and(eq(purchasingOrg.client, input.client), eq(purchasingOrg.purchasingOrg, org)));
  if (!organisation?.isActive) {
    throw new PurchasingOrgPlantAuthorizationError(
      `Purchasing organisation ${org} does not exist or is inactive.`,
      'Choose an active purchasing organisation.',
      details,
    );
  }
  const [siteRow] = await tx
    .select({ isActive: plant.isActive })
    .from(plant)
    .where(and(eq(plant.client, input.client), eq(plant.plant, site)));
  if (!siteRow?.isActive) {
    throw new PurchasingOrgPlantAuthorizationError(
      `Plant ${site} does not exist or is inactive.`,
      'Choose an active plant.',
      details,
    );
  }
  if (!(await purchasingOrgMayBuyForPlant(tx, input.client, org, site))) {
    throw new PurchasingOrgPlantAuthorizationError(
      `Purchasing organisation ${org} is not assigned to plant ${site}.`,
      'Assign the pair before this document is saved. A company-code match is not an authorization.',
      details,
    );
  }
}
