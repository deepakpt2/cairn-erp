import { RETURNS } from './warehouse-stocks';

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
  /**
   * Whether the counter movement carries value. True only where the forward posting put value INTO
   * valuated stock that the issuing bucket never carried — returns stock — and the reversal therefore
   * has to take it back out. Every other move inside one valuation area carries no value either way.
   */
  reversalValuationRelevant?: boolean;
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
  // The returns transfers — SAP 453, 457 and 459. Goods that came back from a customer stand in
  // returns stock: counted, and deliberately not valued, because the receipt that brought them in
  // (651) wrote no accounting document and the goods are not the company's stock again until
  // somebody has inspected them. Taking them out of returns stock is the moment they become valuated
  // stock again, and therefore the moment the accounting document is written — which is why these
  // three carry value and their counters carry it back out, while 321 carries none.
  {
    code: '453', movementType: 'TR_RETURNS_UNRES',
    reversalMovementType: 'TR_RETURNS_UNRES_REV', kind: 'STOCK_TYPE',
    description: 'Returns stock to unrestricted-use',
    fromStockType: RETURNS, toStockType: 'UNRESTRICTED',
    plantRule: 'SAME', locationRule: 'SAME', isTwoStep: false,
    valuationRelevant: true, reversalValuationRelevant: true, negativeStockPolicy: 'LOCATION',
  },
  {
    code: '457', movementType: 'TR_RETURNS_QUAL',
    reversalMovementType: 'TR_RETURNS_QUAL_REV', kind: 'STOCK_TYPE',
    description: 'Returns stock to quality inspection',
    fromStockType: RETURNS, toStockType: 'QUALITY',
    plantRule: 'SAME', locationRule: 'SAME', isTwoStep: false,
    valuationRelevant: true, reversalValuationRelevant: true, negativeStockPolicy: 'LOCATION',
  },
  {
    code: '459', movementType: 'TR_RETURNS_BLOCK',
    reversalMovementType: 'TR_RETURNS_BLOCK_REV', kind: 'STOCK_TYPE',
    description: 'Returns stock to blocked',
    fromStockType: RETURNS, toStockType: 'BLOCKED',
    plantRule: 'SAME', locationRule: 'SAME', isTwoStep: false,
    valuationRelevant: true, reversalValuationRelevant: true, negativeStockPolicy: 'LOCATION',
  },
] as const;

/**
 * What the movement field offers, and what it offers honestly.
 *
 * The three one-step transfers are posted. The three two-step transfers are offered so that
 * choosing one gets an answer rather than a missing row: canon carries no in-transit stock, so the
 * service refuses them by name (§14 — never silently posted as a one-step move). The counters are
 * not offered at all: a counter is what a reversal posts, not something a person enters.
 */
export interface MovementChoice {
  code: string;
  description: string;
  available: boolean;
}

export const MOVEMENT_CHOICES: readonly MovementChoice[] = [
  ...TRANSFER_SCENARIOS.map((s) => ({ code: s.code, description: s.description, available: true })),
  { code: '303', description: 'Transfer to in-transit stock (two-step, not carried)', available: false },
  { code: '313', description: 'Stock transfer to in-transit storage location (two-step, not carried)', available: false },
  { code: '315', description: 'In-transit to destination (two-step, not carried)', available: false },
];

export const COUNTER_CODES: Record<string, [string, string]> = {
  '312': ['311', 'TRANSFER_SLOC'],
  '302': ['301', 'TRANSFER_PLANT'],
  '322': ['321', 'TRANSFER_STYPE'],
  // The returns counters. Entered by hand they are refused — a counter is what a reversal posts —
  // but they have to be known, or reversing a returns transfer would answer with a missing row.
  '454': ['453', 'TR_RETURNS_UNRES'],
  '458': ['457', 'TR_RETURNS_QUAL'],
  '460': ['459', 'TR_RETURNS_BLOCK'],
};

/**
 * The six movement types the catalogue must carry, as data — the *delivered defaults*, seeded per
 * tenant and then authoritative from the table. SCR-146 moved the rules above from being read out
 * of this file at posting time to being read out of `movement_type`; what remains here is the seed.
 */
export const DELIVERED_TRANSFER_MOVEMENTS = [
  ...TRANSFER_SCENARIOS.flatMap((s) => [
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
      // The counter carries value only where the forward posting created it: undoing a returns
      // transfer has to take the value back out of valuated stock, or the books would keep a value
      // for goods that are sitting in returns stock again.
      valuationRelevant: s.reversalValuationRelevant ?? false, negativeStockPolicy: 'LOCATION',
    },
  ]),
  // TRANSFER_STYPE_BLOCK (323) is a one-way quality-to-blocked stock type transfer
  // used by QM usage decisions. It has no reversal movement.
  {
    movementType: 'TRANSFER_STYPE_BLOCK', description: 'Quality inspection to blocked stock (323)',
    direction: 'TRANSFER', referenceCategory: 'MATERIAL_DOCUMENT',
    reversalMovementType: null,
    movementKind: 'STOCK_TYPE', sourceStockType: 'QUALITY', destinationStockType: 'BLOCKED',
    plantRule: 'SAME', locationRule: 'SAME', isTwoStep: false,
    valuationRelevant: false, negativeStockPolicy: 'LOCATION',
  },
];

