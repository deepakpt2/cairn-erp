/** Browser-safe vocabulary shared by view forms, validation and planning. */
export const MATERIAL_VIEWS = ['BASIC', 'PURCHASING', 'MRP', 'ACCOUNTING', 'SALES', 'DELETION', 'SHELF_LIFE'] as const;
export type MaterialView = typeof MATERIAL_VIEWS[number];
export const MATERIAL_VIEW_CAPABILITY: Record<MaterialView, string> = {
  BASIC: 'INV.MATERIAL.MAINTAIN',
  PURCHASING: 'PROC.MATERIAL.PURCHASING.MAINTAIN',
  MRP: 'PROD.MATERIAL.MRP.MAINTAIN',
  ACCOUNTING: 'FIN.MATERIAL.VALUATION.MAINTAIN',
  // The sales view decides whether a material may be sold in a sales area at all, so it is an SD
  // authority and not a material-master one: the same reason the purchasing view belongs to PROC.
  SALES: 'SD.MATERIAL.SALES.MAINTAIN',
  // Both are maintained at client level, so the general material authority covers them.
  DELETION: 'INV.MATERIAL.MAINTAIN',
  SHELF_LIFE: 'INV.MATERIAL.MAINTAIN',
};
/** Views that carry their own panel and their own save action instead of the shared material form. */
export const MATERIAL_PANEL_VIEWS = ['DELETION', 'SHELF_LIFE'] as const;
export type MaterialPanelView = typeof MATERIAL_PANEL_VIEWS[number];
/** Narrows a view to the panel views, so a new one is handled everywhere by construction. */
export function isMaterialPanelView(view: MaterialView): view is MaterialPanelView {
  return (MATERIAL_PANEL_VIEWS as readonly MaterialView[]).includes(view);
}
export const MRP_TYPES = ['REQUIREMENTS', 'REORDER', 'NONE'] as const;
export const PROCUREMENT_TYPES = ['BUY', 'MAKE', 'BOTH'] as const;
export const LOT_PROCEDURES = ['EXACT', 'FIXED'] as const;
export const PRICE_CONTROLS = ['STANDARD', 'MOVING_AVERAGE'] as const;
/**
 * What kind of order item a material becomes. `NORM` is the standard item: priced, delivered and
 * billed. The rest are the distinctions that decide whether a line is delivered at all, and they are
 * vocabulary for now — no determination reads them until the item category is determined.
 */
export const ITEM_CATEGORY_GROUPS = ['NORM', 'TEXT', 'PACK', 'SERV'] as const;
