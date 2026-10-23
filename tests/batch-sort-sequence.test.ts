import { readFileSync } from 'node:fs';
import { sql } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';

import { withTenant } from '../src/platform/db/client';
import { saveCharacteristic, setCharacteristicStatus } from '../src/modules/foundation/characteristic-definition';
import { saveBatchLevel } from '../src/modules/inventory/batch-level';
import { saveBatchClass } from '../src/modules/inventory/batch-class';
import {
  ACTIVITY,
  ALIAS,
  CHANGE_ALIAS,
  DISPLAY_ALIAS,
  NOT_EXECUTED,
  SORT_STATUS,
  deleteSortSequence,
  determineBatches,
  listSortSequences,
  rankSuppliedCandidates,
  saveSortSequence,
} from '../src/modules/inventory/batch-sort-sequence';
import { closeDb, createTenant, destroyTenant } from './helpers';

const ACTOR = 'CU70_TEST';
const AUTH = [ACTIVITY];
const CLASS_AUTH = ['INV.BATCHCLASS.MAINTAIN'];
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

function characteristic(client: string, name: string, dataFormat = 'CHAR') {
  return saveCharacteristic({
    client,
    changedBy: ACTOR,
    mode: 'CREATE',
    characteristicName: name,
    description: name.slice(0, 30),
    dataFormat,
    valueLength: dataFormat === 'DATE' ? 10 : 10,
    decimalPlaces: 0,
    unit: '',
    currency: '',
    negativeValuesAllowed: false,
    caseSensitive: false,
    intervalsAllowed: false,
    additionalValuesAllowed: false,
    valueAssignment: 'SINGLE',
    requiredEntry: false,
    values: [],
    reason: 'Characteristic for the sort sequence',
  });
}

function save(client: string, sortSequence: string, criteria: Array<{ characteristicName: string; direction: string }>, extra: Record<string, unknown> = {}) {
  return saveSortSequence({
    client,
    changedBy: ACTOR,
    capabilities: AUTH,
    mode: 'CREATE',
    sortSequence,
    description: 'Expiry sequence',
    status: '1',
    criteria,
    expectedVersion: null,
    confirmed: true,
    reason: 'Create the sort sequence',
    ...extra,
  });
}

describe('CU70 batch sort sequence', () => {
  it('creates, changes, and displays a sequence without selecting a batch', async () => {
    const client = await tenant('cu70-save');
    await characteristic(client, 'LOBM_VFDAT', 'DATE');
    await characteristic(client, 'COLOUR');
    const created = await save(client, 'FEFO_DATE', [
      { characteristicName: 'LOBM_VFDAT', direction: 'A' },
      { characteristicName: 'COLOUR', direction: 'D' },
    ]);
    expect(created.status).toBe('1');
    expect(created.criteria.map((item) => `${item.position}:${item.characteristicName}:${item.direction}`)).toEqual([
      '1:LOBM_VFDAT:A',
      '2:COLOUR:D',
    ]);
    const changed = await saveSortSequence({
      client,
      changedBy: ACTOR,
      capabilities: AUTH,
      mode: 'CHANGE',
      sortSequence: 'FEFO_DATE',
      description: 'Colour first',
      status: '0',
      criteria: [
        { characteristicName: 'COLOUR', direction: 'A' },
        { characteristicName: 'LOBM_VFDAT', direction: 'D' },
      ],
      expectedVersion: created.version,
      confirmed: true,
      reason: 'Reorder the criteria',
    });
    expect(changed.statusTitle).toBe('In preparation');
    expect(changed.criteria.map((item) => item.characteristicName)).toEqual(['COLOUR', 'LOBM_VFDAT']);
    expect((await listSortSequences(client)).sequences.map((row) => row.sortSequence)).toEqual(['FEFO_DATE']);
    await expect(save(client, 'FEFO_DATE', [{ characteristicName: 'COLOUR', direction: 'A' }])).rejects.toMatchObject({ code: 'SEQUENCE_EXISTS' });
    await expect(saveSortSequence({
      client, changedBy: ACTOR, capabilities: AUTH, mode: 'CHANGE', sortSequence: 'FEFO_DATE',
      description: 'Stale', status: '1', criteria: [{ characteristicName: 'COLOUR', direction: 'A' }],
      expectedVersion: created.version, confirmed: true, reason: 'A stale save',
    })).rejects.toMatchObject({ code: 'STALE_VERSION' });
    expect(() => determineBatches()).toThrow(/not executed/i);
  });

  it('refuses a missing, foreign, blocked, duplicate, or unclassified exception', async () => {
    const client = await tenant('cu70-rule');
    const other = await tenant('cu70-other');
    await characteristic(other, 'FOREIGN_CHAR');
    await characteristic(client, 'GRADE');
    await setCharacteristicStatus({
      client, changedBy: ACTOR, characteristicName: 'GRADE', status: 'BLOCKED', reason: 'Block the characteristic',
    });
    await characteristic(client, 'LOBM_LGORT');
    await saveBatchLevel({ client, changedBy: ACTOR, batchLevel: '1', version: 0, reason: 'Material level' });
    await saveBatchClass({
      client, changedBy: ACTOR, capabilities: CLASS_AUTH, mode: 'CREATE', className: 'ZPLACE',
      description: 'Place class', assignments: [{ characteristicName: 'LOBM_LGORT', requiredForClassification: false }],
      expectedVersion: null, confirmed: true, reason: 'Assign the exception',
    });

    await expect(save(client, 'ZSORT', [])).rejects.toMatchObject({ code: 'CHARACTERISTIC_REQUIRED' });
    await expect(save(client, 'ZSORT', [{ characteristicName: 'MISSING', direction: 'A' }])).rejects.toMatchObject({ code: 'CHARACTERISTIC_UNKNOWN' });
    await expect(save(client, 'ZSORT', [{ characteristicName: 'FOREIGN_CHAR', direction: 'A' }])).rejects.toMatchObject({ code: 'CHARACTERISTIC_UNKNOWN' });
    await expect(save(client, 'ZSORT', [{ characteristicName: 'GRADE', direction: 'A' }])).rejects.toMatchObject({ code: 'CHARACTERISTIC_BLOCKED' });
    await expect(save(client, 'ZSORT', [
      { characteristicName: 'LOBM_MENGE', direction: 'A' },
      { characteristicName: 'LOBM_MENGE', direction: 'D' },
    ])).rejects.toMatchObject({ code: 'DUPLICATE_CHARACTERISTIC' });
    await expect(save(client, 'ZSORT', [{ characteristicName: 'LOBM_LGORT', direction: 'A' }])).rejects.toMatchObject({ code: 'EXCEPTION_IN_CLASS' });
    await expect(save(client, 'ZSORT', [{ characteristicName: 'LOBM_MENGE', direction: 'D' }], { weight: '10' })).rejects.toMatchObject({ code: 'WEIGHT_REFUSED' });
    await expect(save(client, 'ZSORT', [{ characteristicName: 'LOBM_MENGE', direction: 'D' }], { status: 'RELEASED' })).rejects.toMatchObject({ code: 'STATUS_REFUSED' });
    await expect(save(client, 'ZSORT', [{ characteristicName: 'LOBM_MENGE', direction: 'D' }], { capabilities: [] })).rejects.toMatchObject({ code: 'AUTHORITY_REQUIRED' });

    const allowed = await save(other, 'QTY_SORT', [{ characteristicName: 'LOBM_MENGE', direction: 'D' }]);
    expect(allowed.criteria[0]).toMatchObject({ characteristicName: 'LOBM_MENGE', stockException: true, direction: 'D' });
    expect((await listSortSequences(client)).sequences).toEqual([]);
  });

  it('ranks a supplied list and does not let a goods movement consume the sequence', async () => {
    const client = await tenant('cu70-rank');
    await characteristic(client, 'LOBM_VFDAT', 'DATE');
    await characteristic(client, 'RECEIPT_DATE', 'DATE');
    await characteristic(client, 'GRADE');
    await save(client, 'FEFO_DATE', [
      { characteristicName: 'LOBM_VFDAT', direction: 'A' },
      { characteristicName: 'RECEIPT_DATE', direction: 'A' },
    ]);
    const fefo = await rankSuppliedCandidates({
      client,
      sortSequence: 'FEFO_DATE',
      candidates: [
        { key: 'LATE', values: { LOBM_VFDAT: '2026-12-01', RECEIPT_DATE: '2026-01-01' } },
        { key: 'EARLY', values: { LOBM_VFDAT: '2026-10-01', RECEIPT_DATE: '2026-09-01' } },
        { key: 'TIED_LATER', values: { LOBM_VFDAT: '2026-10-01', RECEIPT_DATE: '2026-08-01' } },
        { key: 'BLANK', values: { LOBM_VFDAT: '', RECEIPT_DATE: '2026-01-01' } },
      ],
    });
    expect(fefo.convention).toBe('FEFO');
    expect(fefo.chronological).toBe(true);
    expect(fefo.keys).toEqual(['BLANK', 'TIED_LATER', 'EARLY', 'LATE']);

    await save(client, 'CHAR_SORT', [{ characteristicName: 'GRADE', direction: 'A' }], { description: 'Not a date' });
    const letters = await rankSuppliedCandidates({
      client,
      sortSequence: 'CHAR_SORT',
      candidates: [
        { key: 'G', values: { GRADE: 'G' } },
        { key: 'B', values: { GRADE: 'B' } },
      ],
    });
    expect(letters.chronological).toBe(false);
    expect(letters.convention).toBe('');
    expect(letters.keys).toEqual(['B', 'G']);

    await save(client, 'QTY_SORT', [{ characteristicName: 'LOBM_MENGE', direction: 'D' }], { description: 'Largest first' });
    const quantity = await rankSuppliedCandidates({
      client,
      sortSequence: 'QTY_SORT',
      candidates: [
        { key: 'SMALL', values: { LOBM_MENGE: '2' } },
        { key: 'LARGE', values: { LOBM_MENGE: '100' } },
        { key: 'MID', values: { LOBM_MENGE: '10' } },
      ],
    });
    expect(quantity.convention).toBe('QUANTITY_DESC');
    expect(quantity.keys).toEqual(['LARGE', 'MID', 'SMALL']);
    await expect(rankSuppliedCandidates({
      client,
      sortSequence: 'QTY_SORT',
      candidates: [{ key: 'BAD', values: { LOBM_MENGE: 'abc' } }],
    })).rejects.toMatchObject({ code: 'INCOMPATIBLE_VALUE' });
    await expect(rankSuppliedCandidates({
      client, sortSequence: 'CHAR_SORT', candidates: [],
    })).resolves.toMatchObject({ keys: [] });
    await save(client, 'DRAFT_SORT', [{ characteristicName: 'GRADE', direction: 'A' }], { status: '0', description: 'Not released' });
    await expect(rankSuppliedCandidates({
      client, sortSequence: 'DRAFT_SORT', candidates: [{ key: 'B', values: { GRADE: 'B' } }],
    })).rejects.toMatchObject({ code: 'STATUS_NOT_RELEASED' });

    const before = await withTenant(client, (tx) => tx.execute(sql`
      select count(*)::int as strategies from batch_search_strategy where client = ${client}
    `)) as unknown as Array<{ strategies: number }>;
    await deleteSortSequence({
      client, changedBy: ACTOR, capabilities: AUTH, sortSequence: 'DRAFT_SORT', expectedVersion: 1,
      confirmed: true, reason: 'Remove the draft',
    });
    const after = await withTenant(client, (tx) => tx.execute(sql`
      select
        (select count(*) from batch_search_strategy where client = ${client})::int as strategies,
        (select count(*) from batch_sort_sequence where client = ${client} and sort_sequence = 'DRAFT_SORT')::int as drafts
    `)) as unknown as Array<{ strategies: number; drafts: number }>;
    expect(after[0]?.strategies).toBe(before[0]?.strategies ?? 0);
    expect(after[0]?.drafts).toBe(0);

    const service = readFileSync('src/modules/inventory/batch-sort-sequence.ts', 'utf8');
    expect(service).not.toContain('gewic');
    expect(service).toContain('NOT_EXECUTED');
    const page = readFileSync('src/app/inventory/batch-sort-sequences/page.tsx', 'utf8');
    expect(page).toContain('Not executed');
    expect(page).not.toContain('name="weight"');
    for (const file of [
      'src/modules/inventory/goods-issue.ts',
      'src/modules/inventory/transfer-posting.ts',
      'src/modules/inventory/production-receipt.ts',
      'src/modules/inventory/batch-search-strategy.ts',
    ]) {
      expect(readFileSync(file, 'utf8')).not.toContain("from './batch-sort-sequence'");
      expect(readFileSync(file, 'utf8')).not.toContain("from '@/modules/inventory/batch-sort-sequence'");
    }
    expect(ACTIVITY).toBe('INV.BATCHSORT.MAINTAIN');
    expect([ALIAS, CHANGE_ALIAS, DISPLAY_ALIAS]).toEqual(['CU70', 'CU71', 'CU72']);
    expect(SORT_STATUS.map((item) => item.code)).toEqual(['0', '1', '2']);
    expect(NOT_EXECUTED.map((item) => item.field)).toEqual(['SRTSQ', 'AUSP', 'GEWIC', 'LANGUAGE', 'DETERMINATION']);
  });

  it('rolls back a failed save and refuses a second concurrent create', async () => {
    const client = await tenant('cu70-atom');
    await characteristic(client, 'COLOUR');
    await expect(save(client, 'ZATOM', [
      { characteristicName: 'COLOUR', direction: 'A' },
      { characteristicName: 'MISSING', direction: 'D' },
    ])).rejects.toMatchObject({ code: 'CHARACTERISTIC_UNKNOWN' });
    expect(await listSortSequences(client)).toMatchObject({ sequences: [] });

    const [first, second] = await Promise.allSettled([
      save(client, 'ZRACE', [{ characteristicName: 'COLOUR', direction: 'A' }]),
      save(client, 'ZRACE', [{ characteristicName: 'COLOUR', direction: 'D' }]),
    ]);
    const outcomes = [first, second].map((item) => item.status === 'fulfilled' ? 'saved' : (item.reason as { code?: string }).code);
    expect(outcomes.filter((item) => item === 'saved')).toHaveLength(1);
    expect(outcomes).toContain('SEQUENCE_EXISTS');
    expect((await listSortSequences(client)).sequences).toHaveLength(1);
  });
});
