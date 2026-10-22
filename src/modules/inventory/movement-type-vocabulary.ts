/**
 * The movement-type vocabulary the catalogue already stores.
 *
 * Kept apart from the maintenance service so a screen can offer the same
 * words without pulling the database into the client bundle. These are the
 * check constraints on `movement_type`. A three-digit alias is not a value
 * here.
 */

export const MOVEMENT_DIRECTIONS = ['RECEIPT', 'REVERSAL', 'TRANSFER', 'ISSUE'] as const;
export const MOVEMENT_REFERENCES = [
  'PURCHASE_ORDER',
  'MATERIAL_DOCUMENT',
  'RESERVATION',
  'PRODUCTION_ORDER',
  'PHYSICAL_INVENTORY',
] as const;
export const MOVEMENT_KINDS = [
  'MATERIAL',
  'STORAGE_LOCATION',
  'PLANT',
  'STOCK_TYPE',
  'INVENTORY_DIFFERENCE',
] as const;
export const MOVEMENT_STOCK_TYPES = ['UNRESTRICTED', 'QUALITY', 'BLOCKED'] as const;
export const MOVEMENT_RULES = ['SAME', 'DIFFERENT', 'ANY'] as const;
export const MOVEMENT_NEGATIVE_POLICIES = ['LOCATION', 'FORBID'] as const;
export const MOVEMENT_ASSIGNMENTS = ['NONE', 'COST_CENTER', 'ORDER'] as const;

export type MovementDirection = (typeof MOVEMENT_DIRECTIONS)[number];
export type MovementReference = (typeof MOVEMENT_REFERENCES)[number];
export type MovementKind = (typeof MOVEMENT_KINDS)[number];
