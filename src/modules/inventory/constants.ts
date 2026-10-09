/** Browser-safe vocabulary shared by view forms, validation and planning. */
export const MATERIAL_VIEWS = ['BASIC', 'PURCHASING', 'MRP', 'ACCOUNTING'] as const;
export type MaterialView = typeof MATERIAL_VIEWS[number];
export const MATERIAL_VIEW_CAPABILITY: Record<MaterialView, string> = {
  BASIC: 'INV.MATERIAL.MAINTAIN',
  PURCHASING: 'PROC.MATERIAL.PURCHASING.MAINTAIN',
  MRP: 'PROD.MATERIAL.MRP.MAINTAIN',
  ACCOUNTING: 'FIN.MATERIAL.VALUATION.MAINTAIN',
};
export const MRP_TYPES = ['REQUIREMENTS', 'REORDER', 'NONE'] as const;
export const PROCUREMENT_TYPES = ['BUY', 'MAKE', 'BOTH'] as const;
export const LOT_PROCEDURES = ['EXACT', 'FIXED'] as const;
export const PRICE_CONTROLS = ['STANDARD', 'MOVING_AVERAGE'] as const;
