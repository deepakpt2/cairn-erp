import { sql } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';

import { changeHistory } from '../src/platform/change';
import { withTenant } from '../src/platform/db/client';
import {
  checkMovementType,
  deleteMovementType,
  listMovementTypes,
  saveMovementType,
} from '../src/modules/inventory/movement-type-configuration';
import { createTenant, destroyTenant } from './helpers';

const ACTOR = 'OMJJ_MOVETYPE_TEST';

describe('movement type configuration (OMJJ)', () => {
  let client = '';

  afterAll(async () => {
    if (client) await destroyTenant(client);
  });

  async function standingClient(): Promise<string> {
    if (!client) {
      const tenant = await createTenant('omjj-movement-type');
      client = tenant.client;
      await withTenant(client, async (tx) => {
        await tx.execute(sql`
          insert into config_activity_status (client, activity_code, status, created_by)
          values (${client}, 'CFG.INV.MOVETYPE.CONFIG', 'NOT_STARTED', ${ACTOR})
          on conflict (client, activity_code) do nothing
        `);
      });
    }
    return client;
  }

  const issue = {
    mode: 'CREATE' as const,
    movementType: 'CUSTOM_ISSUE',
    description: 'Custom issue',
    direction: 'ISSUE',
    referenceCategory: 'MATERIAL_DOCUMENT',
    reason: 'OMJJ acceptance',
  };

  async function counts(c: string) {
    const [row] = await withTenant(c, async (tx) => {
      const rows = await tx.execute(sql`
        select
          (select count(*) from stock_quantity where client = ${c}) as stock,
          (select count(*) from journal_entry where client = ${c}) as journals,
          (select count(*) from material_document where client = ${c}) as documents
      `);
      return rows as unknown as { stock: string; journals: string; documents: string }[];
    });
    return row;
  }

  it('refuses a reason-less write and does not require a posting period', async () => {
    const c = await standingClient();
    await expect(
      saveMovementType({ client: c, changedBy: ACTOR, ...issue, reason: ' ' }),
    ).rejects.toThrow('A reason is required');
  });

  it('refuses a G/L account, a company code, a three-digit alias, a draft, a policy and a period', async () => {
    const c = await standingClient();
    await expect(
      saveMovementType({ client: c, changedBy: ACTOR, ...issue, generalLedgerAccount: '140000' }),
    ).rejects.toThrow('G/L account');
    await expect(
      saveMovementType({ client: c, changedBy: ACTOR, ...issue, companyCode: '1000' }),
    ).rejects.toThrow('company code');
    await expect(
      saveMovementType({ client: c, changedBy: ACTOR, ...issue, bwart: '201' }),
    ).rejects.toThrow('three-digit');
    await expect(
      saveMovementType({ client: c, changedBy: ACTOR, ...issue, status: 'DRAFT' }),
    ).rejects.toThrow('status');
    await expect(
      saveMovementType({ client: c, changedBy: ACTOR, ...issue, policyId: 'QTY-1' }),
    ).rejects.toThrow('policy');
    await expect(
      saveMovementType({ client: c, changedBy: ACTOR, ...issue, fieldSelectionProfile: 'MM-01' }),
    ).rejects.toThrow('field-selection');
    await expect(
      saveMovementType({ client: c, changedBy: ACTOR, ...issue, postingPeriod: '10' }),
    ).rejects.toThrow('posting period');
    await expect(
      saveMovementType({ client: c, changedBy: ACTOR, ...issue, isTwoStep: true }),
    ).rejects.toThrow('two-step');
    await expect(
      saveMovementType({ client: c, changedBy: ACTOR, ...issue, requiresSpecialStock: true }),
    ).rejects.toThrow('Special stock');
  });

  it('creates a movement with a change document and posts nothing', async () => {
    const c = await standingClient();
    const before = await counts(c);
    const created = await saveMovementType({ client: c, changedBy: ACTOR, ...issue, requestKey: 'omjj-create-1' });
    expect(created).toEqual({ movementType: 'CUSTOM_ISSUE', changed: true, replayed: false });
    const after = await counts(c);
    expect(after).toEqual(before);
    const history = await withTenant(c, (tx) => changeHistory(tx, c, 'movement_type', 'CUSTOM_ISSUE'));
    expect(history).toHaveLength(1);
    expect(history[0].transactionCode).toBe('CFG.INV.MOVETYPE.CONFIG');
    const [status] = await withTenant(c, async (tx) => {
      const rows = await tx.execute(sql`
        select status from config_activity_status
        where client = ${c} and activity_code = 'CFG.INV.MOVETYPE.CONFIG'
      `);
      return rows as unknown as { status: string }[];
    });
    expect(status.status).toBe('COMPLETED');
  });

  it('replays the same request and refuses a different payload under that key', async () => {
    const c = await standingClient();
    const again = await saveMovementType({ client: c, changedBy: ACTOR, ...issue, requestKey: 'omjj-create-1' });
    expect(again.replayed).toBe(true);
    const history = await withTenant(c, (tx) => changeHistory(tx, c, 'movement_type', 'CUSTOM_ISSUE'));
    expect(history).toHaveLength(1);
    await expect(
      saveMovementType({
        client: c, changedBy: ACTOR, ...issue, requestKey: 'omjj-create-1', description: 'Different',
      }),
    ).rejects.toThrow('different movement type change');
  });

  it('checks without writing', async () => {
    const c = await standingClient();
    const before = await withTenant(c, (tx) => changeHistory(tx, c, 'movement_type', 'CUSTOM_ISSUE'));
    const checked = await checkMovementType(c, 'CUSTOM_ISSUE');
    expect(checked.direction).toBe('ISSUE');
    expect(checked.documentCount).toBe(0);
    const after = await withTenant(c, (tx) => changeHistory(tx, c, 'movement_type', 'CUSTOM_ISSUE'));
    expect(after).toHaveLength(before.length);
    const listed = await listMovementTypes(c);
    expect(listed.map((row) => row.movementType)).toContain('CUSTOM_ISSUE');
  });

  it('refuses a missing reversal, a self reversal, and a reversal that names another counter', async () => {
    const c = await standingClient();
    await expect(
      saveMovementType({
        client: c, changedBy: ACTOR, ...issue,
        movementType: 'NEEDS_REV', reversalMovementType: 'ABSENT', requestKey: 'omjj-rev-missing',
      }),
    ).rejects.toThrow('does not stand');
    await expect(
      saveMovementType({
        client: c, changedBy: ACTOR, ...issue,
        movementType: 'SELF_REV', reversalMovementType: 'SELF_REV',
      }),
    ).rejects.toThrow('cannot name itself');
    await saveMovementType({
      client: c, changedBy: ACTOR, ...issue,
      movementType: 'COUNTER_C', description: 'Counter C', requestKey: 'omjj-c',
    });
    await saveMovementType({
      client: c, changedBy: ACTOR, ...issue,
      movementType: 'COUNTER_B', description: 'Counter B', reversalMovementType: 'COUNTER_C', requestKey: 'omjj-b',
    });
    await expect(
      saveMovementType({
        client: c, changedBy: ACTOR, ...issue,
        movementType: 'COUNTER_A', description: 'Counter A', reversalMovementType: 'COUNTER_B',
      }),
    ).rejects.toThrow('already names COUNTER_C');
  });

  it('allows a reciprocal pair and refuses a second goods-receipt movement', async () => {
    const c = await standingClient();
    await saveMovementType({
      client: c, changedBy: ACTOR, ...issue,
      movementType: 'PAIR_REV', description: 'Pair reversal', direction: 'ISSUE', requestKey: 'omjj-pair-rev',
    });
    await saveMovementType({
      client: c, changedBy: ACTOR, ...issue,
      movementType: 'PAIR_MAIN', description: 'Pair main', reversalMovementType: 'PAIR_REV', requestKey: 'omjj-pair-main',
    });
    const paired = await saveMovementType({
      client: c, changedBy: ACTOR,
      mode: 'CHANGE', movementType: 'PAIR_REV', description: 'Pair reversal',
      direction: 'ISSUE', referenceCategory: 'MATERIAL_DOCUMENT',
      reversalMovementType: 'PAIR_MAIN', reason: 'Complete the pair', requestKey: 'omjj-pair-back',
    });
    expect(paired.changed).toBe(true);
    await saveMovementType({
      client: c, changedBy: ACTOR,
      mode: 'CREATE', movementType: 'GOODS_RECEIPT_PO', description: 'Goods receipt for purchase order',
      direction: 'RECEIPT', referenceCategory: 'PURCHASE_ORDER', reason: 'Deliver the receipt movement',
      requestKey: 'omjj-gr',
    });
    await expect(
      saveMovementType({
        client: c, changedBy: ACTOR,
        mode: 'CREATE', movementType: 'OTHER_RECEIPT', description: 'Another receipt',
        direction: 'RECEIPT', referenceCategory: 'PURCHASE_ORDER', reason: 'Should not stand',
      }),
    ).rejects.toThrow('GOODS_RECEIPT_PO');
  });

  it('refuses a second difference movement for the same direction', async () => {
    const c = await standingClient();
    await saveMovementType({
      client: c, changedBy: ACTOR,
      mode: 'CREATE', movementType: 'DIFF_SURPLUS', description: 'Surplus',
      direction: 'RECEIPT', referenceCategory: 'PHYSICAL_INVENTORY', movementKind: 'INVENTORY_DIFFERENCE',
      valuationRelevant: true, inventoryEvent: 'INVENTORY', offsetEvent: 'OFFSETTING_INVENTORY', offsetModifier: 'DIFF',
      reason: 'Difference movement', requestKey: 'omjj-diff',
    });
    await expect(
      saveMovementType({
        client: c, changedBy: ACTOR,
        mode: 'CREATE', movementType: 'DIFF_OTHER', description: 'Other surplus',
        direction: 'RECEIPT', referenceCategory: 'PHYSICAL_INVENTORY', movementKind: 'INVENTORY_DIFFERENCE',
        valuationRelevant: false, reason: 'Should not stand',
      }),
    ).rejects.toThrow('DIFF_SURPLUS');
  });

  it('freezes posting rules once a document cites the movement, and still allows the description', async () => {
    const c = await standingClient();
    await withTenant(c, async (tx) => {
      await tx.execute(sql`
        insert into material_document (
          client, material_document_number, document_year, document_date, posting_date, created_by
        ) values (${c}, 'OMJJ-DOC', 2026, '2026-10-22', '2026-10-22', ${ACTOR})
      `);
      await tx.execute(sql`
        insert into material_document_line (
          client, material_document_number, line_number, movement_type, material_number, plant,
          entry_quantity, entry_unit, base_quantity, base_unit, created_by
        ) values (${c}, 'OMJJ-DOC', 1, 'CUSTOM_ISSUE', 'MAT-1', '1000', 1, 'PC', 1, 'PC', ${ACTOR})
      `);
    });
    await expect(
      saveMovementType({
        client: c, changedBy: ACTOR,
        mode: 'CHANGE', movementType: 'CUSTOM_ISSUE', description: 'Custom issue',
        direction: 'RECEIPT', referenceCategory: 'MATERIAL_DOCUMENT', reason: 'Should not rewrite history',
      }),
    ).rejects.toThrow('posting rules are not changed');
    const described = await saveMovementType({
      client: c, changedBy: ACTOR,
      mode: 'CHANGE', movementType: 'CUSTOM_ISSUE', description: 'Custom issue, renamed',
      direction: 'ISSUE', referenceCategory: 'MATERIAL_DOCUMENT', reason: 'Rename only',
      requestKey: 'omjj-rename',
    });
    expect(described.changed).toBe(true);
    const [line] = await withTenant(c, async (tx) => {
      const rows = await tx.execute(sql`
        select movement_type from material_document_line
        where client = ${c} and material_document_number = 'OMJJ-DOC'
      `);
      return rows as unknown as { movement_type: string }[];
    });
    expect(line.movement_type).toBe('CUSTOM_ISSUE');
    await expect(
      deleteMovementType({ client: c, changedBy: ACTOR, movementType: 'CUSTOM_ISSUE', reason: 'Should fail' }),
    ).rejects.toThrow('not deleted');
  });

  it('deletes an unused movement and refuses an unknown event', async () => {
    const c = await standingClient();
    await saveMovementType({
      client: c, changedBy: ACTOR, ...issue,
      movementType: 'UNUSED_ONE', description: 'Unused', requestKey: 'omjj-unused',
    });
    await expect(
      saveMovementType({
        client: c, changedBy: ACTOR, ...issue,
        movementType: 'BAD_EVENT', description: 'Bad event', inventoryEvent: 'NOT_AN_EVENT',
      }),
    ).rejects.toThrow('NOT_AN_EVENT');
    const deleted = await deleteMovementType({
      client: c, changedBy: ACTOR, movementType: 'UNUSED_ONE', reason: 'Not cited', requestKey: 'omjj-delete',
    });
    expect(deleted.deleted).toBe(true);
    const replayed = await deleteMovementType({
      client: c, changedBy: ACTOR, movementType: 'UNUSED_ONE', reason: 'Not cited', requestKey: 'omjj-delete',
    });
    expect(replayed.replayed).toBe(true);
    await expect(checkMovementType(c, 'UNUSED_ONE')).rejects.toThrow('does not stand');
  });
});
