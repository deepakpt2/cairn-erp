import { afterAll, describe, expect, it } from 'vitest';

import { withTenant } from '../src/platform/db/client';
import { changeHistory } from '../src/platform/change';
import {
  saveMaterialView,
  setMaterialDeletionFlag,
  type MaterialInput,
} from '../src/modules/inventory/materials';
import { createTenant, destroyTenant } from './helpers';

const ACTOR = 'SCR053_MM06_TEST';

/**
 * SCR-053 / MM06 acceptance: the deletion flag as a confirmed,
 * reasoned, reversible act at client and plant scope — a marker that
 * refuses only new plant extensions under a client flag, never the
 * flagging itself.
 */
describe('SCR-053 material deletion flags (MM06)', () => {
  let client = '';

  afterAll(async () => {
    if (client) await destroyTenant(client);
  });

  async function standingClient(): Promise<string> {
    if (!client) {
      const tenant = await createTenant('scr053-deletion-flag');
      client = tenant.client;
      await saveMaterialView({
        client, materialNumber: 'FLAG-MAT', changedBy: ACTOR, expectedVersion: 0,
        reason: 'Stage 5 acceptance', view: 'BASIC', description: 'Flagged component',
        materialType: 'RAW', materialGroup: 'RAW', baseUnit: 'KG', industrySector: 'M',
        barcode: '', grossWeight: '0', netWeight: '0', weightUnit: '', isBlocked: false,
      });
    }
    return client;
  }

  const flag = (patch: Partial<Parameters<typeof setMaterialDeletionFlag>[0]> = {}) => ({
    client,
    materialNumber: 'FLAG-MAT',
    changedBy: ACTOR,
    scope: 'CLIENT' as const,
    flagged: true,
    reason: 'Material discontinued',
    ...patch,
  });

  const purchasing = (): MaterialInput => ({
    client, materialNumber: 'FLAG-MAT', changedBy: ACTOR, expectedVersion: 0,
    reason: 'Stage 5 acceptance', view: 'PURCHASING', plant: '1000',
    purchasingGroup: '', orderUnit: 'KG', overdeliveryTolerance: '0',
    underdeliveryTolerance: '0', manufacturerPartNumber: '',
  });

  it('sets and cancels the client flag as documented acts', async () => {
    const c = await standingClient();
    void c;
    await expect(setMaterialDeletionFlag(flag({ reason: '  ' }))).rejects.toThrow(
      'A reason is required',
    );
    const set = await setMaterialDeletionFlag(flag());
    expect(set).toMatchObject({ changed: true, flagged: true, stockAtScope: '0' });
    const again = await setMaterialDeletionFlag(flag());
    expect(again.changed).toBe(false);
    const history = await withTenant(client, (tx) =>
      changeHistory(tx, client, 'material', 'FLAG-MAT'),
    );
    const flagEntry = history.find((h) =>
      h.items.some((i) => i.fieldName === 'markedForDeletion'),
    );
    expect(flagEntry?.items.find((i) => i.fieldName === 'markedForDeletion')
      ?.isSecurityRelevant).toBe('true');
    const cancelled = await setMaterialDeletionFlag(flag({ flagged: false }));
    expect(cancelled.changed).toBe(true);
  });

  it('a client flag refuses new plant extensions until cancelled', async () => {
    const c = await standingClient();
    void c;
    await setMaterialDeletionFlag(flag());
    await expect(saveMaterialView(purchasing())).rejects.toThrow(
      'is flagged for deletion at client level',
    );
    await setMaterialDeletionFlag(flag({ flagged: false, reason: 'Flag was premature' }));
    const extended = await saveMaterialView(purchasing());
    expect(extended.changed).toBe(true);
  });

  it('plant flags stand on their own scope only', async () => {
    const c = await standingClient();
    void c;
    await expect(
      setMaterialDeletionFlag(flag({ scope: 'PLANT', plant: '9999' })),
    ).rejects.toThrow('is not extended to plant 9999');
    const set = await setMaterialDeletionFlag(flag({ scope: 'PLANT', plant: '1000' }));
    expect(set).toMatchObject({ changed: true, flagged: true });
    // The client flag was never touched by the plant act.
    const cancelled = await setMaterialDeletionFlag(
      flag({ scope: 'PLANT', plant: '1000', flagged: false, reason: 'Kept after all' }),
    );
    expect(cancelled.changed).toBe(true);
    const history = await withTenant(client, (tx) =>
      changeHistory(tx, client, 'material_plant', 'FLAG-MAT/1000'),
    );
    expect(
      history.filter((h) => h.items.some((i) => i.fieldName === 'markedForDeletion')),
    ).toHaveLength(2);
  });
});
