/**
 * The settlement masters a test needs, stored the way the product stores them: through
 * `/config/settlement-configuration`'s module.
 *
 * A fixture must not write the masters by some back door, because that path no longer exists — an order's
 * settlement rule screen refuses those fields. So a test that settles an order calls this first, and the
 * screens' own rules (an active profile, a structure that assigns the account, a type that reads the
 * profile) are satisfied by the same writers a user would use.
 */
import {
  assignOrderTypeSettlementProfile,
  getAllocationStructure,
  listOrderTypeSettlementProfiles,
  saveAllocationStructure,
  saveAllocationStructureAssignment,
  saveSettlementProfile,
} from '../src/modules/foundation/settlement-configuration-masters';

const ACTOR = 'SETTLE_FIXTURE';

export interface SettlementMasterFixture {
  orderType?: string;
  structureCode?: string;
  profileCode?: string;
  sourceAccount?: string;
  documentType?: string;
  receiverCategories?: Array<'COST_CENTER' | 'INTERNAL_ORDER' | 'GL_ACCOUNT'>;
  methods?: { percentage?: boolean; equivalence?: boolean; amount?: boolean };
}

/**
 * Idempotent: a create over a standing row changes nothing, and a create over a key that was removed
 * submits the version its history left behind, so two fixtures for one tenant agree whichever order the
 * removals came in.
 */
export async function ensureSettlementMasters(client: string, input: SettlementMasterFixture = {}): Promise<void> {
  const structureCode = input.structureCode ?? 'AS01';
  const profileCode = input.profileCode ?? 'SP01';
  const sourceAccount = input.sourceAccount ?? '410000';
  const orderType = input.orderType ?? 'IO01';

  await saveAllocationStructure({
    client,
    changedBy: ACTOR,
    mode: 'CREATE',
    expectedVersion: 0,
    structureCode,
    description: 'Original account',
  });
  const structure = await getAllocationStructure(client, structureCode);
  for (const receiverCategory of input.receiverCategories ?? ['COST_CENTER']) {
    if (structure?.assignments.some((row) => row.sourceAccount === sourceAccount && row.receiverCategory === receiverCategory)) {
      continue;
    }
    // A key that was assigned here and removed has no row to read, yet its audit rows still count: the
    // version it stands at comes from `removedAssignments`, and 0 is only right for a key never used.
    const version = structure?.removedAssignments.find(
      (row) => row.sourceAccount === sourceAccount && row.receiverCategory === receiverCategory,
    )?.version ?? 0;
    await saveAllocationStructureAssignment({
      client,
      changedBy: ACTOR,
      expectedVersion: version,
      structureCode,
      sourceAccount,
      receiverCategory,
      byOriginalAccount: true,
      settlementAccount: '',
    });
  }
  await saveSettlementProfile({
    client,
    changedBy: ACTOR,
    mode: 'CREATE',
    expectedVersion: 0,
    profileCode,
    description: 'Order settlement',
    allocationStructure: structureCode,
    documentType: input.documentType ?? 'SA',
    percentageAllowed: input.methods?.percentage ?? true,
    equivalenceAllowed: input.methods?.equivalence ?? true,
    amountAllowed: input.methods?.amount ?? true,
    isActive: true,
  });
  // Same rule on the other side of the chain: an order type that was assigned a profile and then unlinked
  // stands at its audit count, not at 0.
  const standingType = (await listOrderTypeSettlementProfiles(client)).find((row) => row.orderType === orderType);
  await assignOrderTypeSettlementProfile({
    client,
    changedBy: ACTOR,
    mode: 'CREATE',
    expectedVersion: standingType?.version ?? 0,
    orderType,
    profileCode,
  });
}
