/**
 * The transfer movement catalogue — SCR-131 / MB1B.
 *
 * Kept apart from the posting service so the screen can list the scenarios
 * without pulling the database into the client bundle. The stored keys are the
 * movement-type identities; the three-digit numbers are what the user enters.
 */
export type ScenarioKind = 'STORAGE_LOCATION' | 'PLANT' | 'STOCK_TYPE';

export interface TransferScenario {
  /** The three-digit movement type the user enters — an input alias, never a stored code. */
  code: string;
  movementType: string;
  reversalMovementType: string;
  kind: ScenarioKind;
  description: string;
  /** The stock type the issuing line must carry, and the one the receiving line must carry. */
  fromStockType: string;
  toStockType: string;
  /** SCR-146: the organizational rule the movement carries, read from configuration. */
  plantRule: 'SAME' | 'DIFFERENT' | 'ANY';
  locationRule: 'SAME' | 'DIFFERENT' | 'ANY';
  isTwoStep: boolean;
  valuationRelevant: boolean;
  negativeStockPolicy: 'LOCATION' | 'FORBID';
}

/**
 * The transfer movement catalogue, delivered per tenant as movement types.
 * The stored keys are the movement-type identities; the numbers are aliases.
 */
export const TRANSFER_SCENARIOS: readonly TransferScenario[] = [
  {
    code: '311', movementType: 'TRANSFER_SLOC',
    reversalMovementType: 'TRANSFER_SLOC_REV', kind: 'STORAGE_LOCATION',
    description: 'Storage location to storage location',
    fromStockType: 'UNRESTRICTED', toStockType: 'UNRESTRICTED',
    plantRule: 'SAME', locationRule: 'DIFFERENT', isTwoStep: false,
    valuationRelevant: false, negativeStockPolicy: 'LOCATION',
  },
  {
    code: '301', movementType: 'TRANSFER_PLANT',
    reversalMovementType: 'TRANSFER_PLANT_REV', kind: 'PLANT',
    description: 'Plant to plant',
    fromStockType: 'UNRESTRICTED', toStockType: 'UNRESTRICTED',
    plantRule: 'DIFFERENT', locationRule: 'ANY', isTwoStep: false,
    valuationRelevant: true, negativeStockPolicy: 'LOCATION',
  },
  {
    code: '321', movementType: 'TRANSFER_STYPE',
    reversalMovementType: 'TRANSFER_STYPE_REV', kind: 'STOCK_TYPE',
    description: 'Quality inspection to unrestricted',
    fromStockType: 'QUALITY', toStockType: 'UNRESTRICTED',
    plantRule: 'SAME', locationRule: 'SAME', isTwoStep: false,
    valuationRelevant: false, negativeStockPolicy: 'LOCATION',
  },
] as const;

export const COUNTER_CODES: Record<string, [string, string]> = {
  '312': ['311', 'TRANSFER_SLOC'],
  '302': ['301', 'TRANSFER_PLANT'],
  '322': ['321', 'TRANSFER_STYPE'],
};

/**
 * The six movement types the catalogue must carry, as data — the *delivered defaults*, seeded per
 * tenant and then authoritative from the table. SCR-146 moved the rules above from being read out
 * of this file at posting time to being read out of `movement_type`; what remains here is the seed.
 */
export const DELIVERED_TRANSFER_MOVEMENTS = TRANSFER_SCENARIOS.flatMap((s) => [
  {
    movementType: s.movementType, description: `${s.description} (${s.code})`,
    direction: 'TRANSFER', referenceCategory: 'MATERIAL_DOCUMENT',
    reversalMovementType: s.reversalMovementType,
    movementKind: s.kind, sourceStockType: s.fromStockType, destinationStockType: s.toStockType,
    plantRule: s.plantRule, locationRule: s.locationRule, isTwoStep: s.isTwoStep,
    valuationRelevant: s.valuationRelevant, negativeStockPolicy: s.negativeStockPolicy,
  },
  {
    movementType: s.reversalMovementType, description: `Reversal of ${s.description} (${Number(s.code) + 1})`,
    direction: 'TRANSFER', referenceCategory: 'MATERIAL_DOCUMENT',
    reversalMovementType: null,
    movementKind: s.kind, sourceStockType: s.toStockType, destinationStockType: s.fromStockType,
    plantRule: s.plantRule, locationRule: s.locationRule, isTwoStep: false,
    valuationRelevant: false, negativeStockPolicy: 'LOCATION',
  },
]);

