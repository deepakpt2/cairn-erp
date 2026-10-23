import { readFileSync } from 'node:fs';
import { sql } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';

import { withTenant } from '../src/platform/db/client';
import { createBatchIdentity, saveBatchLevel } from '../src/modules/inventory/batch-level';
import {
  ACTIVITY,
  ALIAS,
  documentManagementActive,
  getBatchDocumentManagement,
  linkBatchDocument,
  saveBatchDocumentManagement,
} from '../src/modules/inventory/batch-document-management';
import { closeDb, createTenant, destroyTenant } from './helpers';

const ACTOR = 'ODOC_TEST';
const clients: string[] = [];

afterAll(async () => {
  for (const client of clients) await destroyTenant(client);
  await closeDb();
});

async function tenant(seed: string): Promise<string> {
  const created = await createTenant(seed);
  clients.push(created.client);
  return created.client;
}

function save(client: string, documentManagement: string, version: number, extra: Record<string, unknown> = {}) {
  return saveBatchDocumentManagement({
    client,
    changedBy: ACTOR,
    documentManagement,
    version,
    reason: 'Set the document indicator',
    ...extra,
  });
}

describe('ODOC batch document management', () => {
  it('stores only the indicator and does not create a document link', async () => {
    const client = await tenant('odoc-flag');
    expect(await documentManagementActive(client)).toBe(false);
    expect(await getBatchDocumentManagement(client)).toMatchObject({ code: null, version: 0 });
    const active = await save(client, 'X', 0);
    expect(active).toMatchObject({ code: 'X', version: 1 });
    expect(await documentManagementActive(client)).toBe(true);
    const hidden = await save(client, '', 1);
    expect(hidden.code).toBeNull();
    expect(hidden.version).toBe(2);
    expect(await documentManagementActive(client)).toBe(false);
    expect(() => linkBatchDocument()).toThrow(/not saved/);
    await expect(save(client, '1', 2)).rejects.toMatchObject({ code: 'CODE_UNKNOWN' });
    await expect(save(client, 'X', 2, { fileName: 'cert.pdf' })).rejects.toMatchObject({ code: 'DOCUMENT_REFUSED' });
    await expect(save(client, 'X', 2, { whereUsed: true })).rejects.toMatchObject({ code: 'GENEALOGY_REFUSED' });
    await expect(save(client, 'X', 2, { transportRequest: 'DEVK9' })).rejects.toMatchObject({ code: 'TRANSPORT_REFUSED' });
    await expect(save(client, 'X', 9)).rejects.toMatchObject({ code: 'VERSION_STALE' });
  });

  it('hides the tab without deleting a batch, and does not cross tenants', async () => {
    const client = await tenant('odoc-batch');
    const other = await tenant('odoc-other');
    await withTenant(client, (tx) => tx.execute(sql`
      insert into material (client, material_number, description, material_type, base_unit, created_by)
      values (${client}, 'RM-DOC', 'Document material', 'RAW', 'PC', ${ACTOR})
    `));
    await saveBatchLevel({ client, changedBy: ACTOR, batchLevel: '0', version: 0, reason: 'Plant level' });
    await createBatchIdentity({ client, changedBy: ACTOR, materialNumber: 'RM-DOC', batchNumber: 'B1', plant: '1000' });
    const before = await withTenant(client, (tx) => tx.execute(sql`
      select count(*)::int as batches from batch where client = ${client}
    `)) as unknown as Array<{ batches: number }>;
    await save(client, 'X', 0);
    await save(client, 'BLANK', 1);
    const after = await withTenant(client, (tx) => tx.execute(sql`
      select count(*)::int as batches from batch where client = ${client}
    `)) as unknown as Array<{ batches: number }>;
    expect(after[0]?.batches).toBe(before[0]?.batches);
    expect(await documentManagementActive(other)).toBe(false);
    expect(await documentManagementActive(client)).toBe(false);
    const documents = await withTenant(client, (tx) => tx.execute(sql`
      select count(*)::int as n from material_document where client = ${client}
    `)) as unknown as Array<{ n: number }>;
    expect(documents[0]?.n).toBe(0);
  });

  it('does not let a goods movement or the batch service become this screen', () => {
    const service = readFileSync('src/modules/inventory/batch-document-management.ts', 'utf8');
    expect(service).toContain('LINK_NOT_AVAILABLE');
    expect(service).not.toContain('saveBatchLevel');
    const page = readFileSync('src/app/config/batch-document-management/page.tsx', 'utf8');
    expect(page).toContain('Not executed');
    const actions = readFileSync('src/app/config/batch-document-management/actions.ts', 'utf8');
    expect(actions).toContain('requireCapability');
    for (const file of [
      'src/modules/inventory/goods-issue.ts',
      'src/modules/inventory/transfer-posting.ts',
      'src/modules/inventory/batch-master.ts',
      'src/modules/inventory/batch-change.ts',
      'src/modules/inventory/batch-display.ts',
    ]) {
      expect(readFileSync(file, 'utf8')).not.toContain("batch-document-management");
    }
    expect(ACTIVITY).toBe('CFG.INV.BATCHDOCMGMT.DEFINE');
    expect(ALIAS).toBe('ODOC');
  });
});
