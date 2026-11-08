/**
 * The material's sales view, read the way a sales document reads it.
 *
 * A material is maintained for sale in a sales area, and a sales document belongs to a sales area, so
 * the two are asked of each other before any price is calculated. What sales needs from the view is
 * small and specific: whether the material may be sold here at all, the unit it is sold in, the kind
 * of order item it becomes, the plant it ships from, the group revenue is determined by, and the
 * groups the shipping point and the availability check will read.
 *
 * The maintenance of the view belongs to the material master, which owns every other view; this
 * module is only the reading of it, and the refusal that names the screen when it is not maintained.
 */
import { and, eq } from 'drizzle-orm';

import { type Tx } from '../../platform/db/client';
import { materialSales } from '../inventory/schema';

/** Where the view is maintained. A refusal that does not name the screen leaves the reader guessing. */
export const MATERIAL_SALES_ROUTE = '/inventory/materials';

export class MaterialSalesError extends Error {
  remedy: string;
  constructor(message: string, remedy: string) {
    super(message);
    this.name = 'MaterialSalesError';
    this.remedy = remedy;
  }
}

export interface MaterialSalesView {
  materialNumber: string;
  salesOrg: string;
  distributionChannel: string;
  /** Null means the base unit: the material is sold in the unit it is counted in. */
  salesUnit: string | null;
  itemCategoryGroup: string;
  /** Null is a key of its own and is matched as one in revenue determination. */
  materialAccountAssignmentGroup: string | null;
  deliveringPlant: string | null;
  loadingGroup: string | null;
  availabilityCheckGroup: string | null;
  salesStatus: string;
}

export interface MaterialSalesKey {
  materialNumber: string;
  salesOrg: string;
  distributionChannel: string;
}

const viewKey = (client: string, key: MaterialSalesKey) => and(
  eq(materialSales.client, client),
  eq(materialSales.materialNumber, key.materialNumber),
  eq(materialSales.salesOrg, key.salesOrg),
  eq(materialSales.distributionChannel, key.distributionChannel),
);

/** The view as it stands, or null where the material has never been maintained for this sales area. */
export async function readMaterialSales(
  tx: Tx,
  client: string,
  key: MaterialSalesKey,
): Promise<MaterialSalesView | null> {
  const [row] = await tx.select().from(materialSales).where(viewKey(client, key));
  if (!row) return null;
  return {
    materialNumber: row.materialNumber,
    salesOrg: row.salesOrg,
    distributionChannel: row.distributionChannel,
    salesUnit: row.salesUnit,
    itemCategoryGroup: row.itemCategoryGroup,
    materialAccountAssignmentGroup: row.materialAccountAssignmentGroup,
    deliveringPlant: row.deliveringPlant,
    loadingGroup: row.loadingGroup,
    availabilityCheckGroup: row.availabilityCheckGroup,
    salesStatus: row.salesStatus,
  };
}

/**
 * The view a sales document requires, or a refusal.
 *
 * A material with no view in the sales area cannot be sold there. That is not a formality: the item
 * category of the line, the plant it ships from and the revenue account its sale belongs to are all
 * read from the view, and a line priced without them is a line the rest of the chain cannot place.
 * The refusal names the screen, because a reader told that a material cannot be sold has not been
 * told where to make it sellable.
 */
export async function assertMaterialSalesArea(
  tx: Tx,
  client: string,
  key: MaterialSalesKey,
): Promise<MaterialSalesView> {
  const view = await readMaterialSales(tx, client, key);
  if (!view) {
    throw new MaterialSalesError(
      `Material ${key.materialNumber} has no sales view for sales area ${key.salesOrg}/${key.distributionChannel}, so it cannot be sold there.`,
      `Maintain the sales view of the material at ${MATERIAL_SALES_ROUTE}: the unit it is sold in, the item category it becomes on an order, the plant it ships from, and the account assignment group its revenue is determined by.`,
    );
  }
  if (view.salesStatus === 'INCOMPLETE') {
    throw new MaterialSalesError(
      `The sales view of material ${key.materialNumber} for sales area ${key.salesOrg}/${key.distributionChannel} is incomplete, so the material cannot be sold there yet.`,
      `Complete the sales view at ${MATERIAL_SALES_ROUTE}: an item category group and the base unit of the material are the two things a sales view has to say.`,
    );
  }
  return view;
}
