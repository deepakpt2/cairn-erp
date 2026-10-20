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
  },
  {
    code: '301', movementType: 'TRANSFER_PLANT',
    reversalMovementType: 'TRANSFER_PLANT_REV', kind: 'PLANT',
    description: 'Plant to plant',
    fromStockType: 'UNRESTRICTED', toStockType: 'UNRESTRICTED',
  },
  {
    code: '321', movementType: 'TRANSFER_STYPE',
    reversalMovementType: 'TRANSFER_STYPE_REV', kind: 'STOCK_TYPE',
    description: 'Quality inspection to unrestricted',
    fromStockType: 'QUALITY', toStockType: 'UNRESTRICTED',
  },
] as const;

export const COUNTER_CODES: Record<string, [string, string]> = {
  '312': ['311', 'TRANSFER_SLOC'],
  '302': ['301', 'TRANSFER_PLANT'],
  '322': ['321', 'TRANSFER_STYPE'],
};

/** The six movement types the catalogue must carry, as data. */
export const DELIVERED_TRANSFER_MOVEMENTS = TRANSFER_SCENARIOS.flatMap((s) => [
  {
    movementType: s.movementType, description: `${s.description} (${s.code})`,
    direction: 'TRANSFER', referenceCategory: 'MATERIAL_DOCUMENT',
    reversalMovementType: s.reversalMovementType,
  },
  {
    movementType: s.reversalMovementType, description: `Reversal of ${s.description} (${Number(s.code) + 1})`,
    direction: 'TRANSFER', referenceCategory: 'MATERIAL_DOCUMENT',
    reversalMovementType: null,
  },
]);

