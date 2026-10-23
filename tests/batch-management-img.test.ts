import { readFileSync } from 'node:fs';
import { afterAll, describe, expect, it } from 'vitest';

import { saveClass } from '../src/modules/foundation/class-definition';
import { listCharacteristics, saveCharacteristic } from '../src/modules/foundation/characteristic-definition';
import {
  ACTIVITY,
  ALIAS,
  BATCH_IMG_NODES,
  NOT_OCHA,
  NOT_OPENED,
  RELATED_BATCH_NODES,
  ROUTE,
} from '../src/modules/inventory/batch-management-img';
import { resolveTerm } from '../src/platform/registry';
import { rankRegistry } from '../src/platform/registry/suggest';
import { createTenant, destroyTenant } from './helpers';

const ACTOR = 'OCHA_IMG_TEST';

describe('OCHA batch management IMG', () => {
  const clients: string[] = [];

  afterAll(async () => {
    for (const client of clients) await destroyTenant(client);
  });

  it('lists the existing batch configuration screens and does not treat CT04 as OCHA', () => {
    expect(ACTIVITY).toBe('CFG.INV.BATCHIMG.DISPLAY');
    expect(ALIAS).toBe('OCHA');
    expect(ROUTE).toBe('/config/batch-management');
    expect(BATCH_IMG_NODES.map((node) => node.tcode)).toEqual([
      'OMCE', 'OMCS', 'OMCU', 'OMAB', 'OMCZ', 'OMAD',
      'OMCT', 'ODOC', 'OMCV', 'OMCW', 'OMCX', 'OMA1', 'OMCY', 'OMCG', 'OMCWB',
    ]);
    expect(BATCH_IMG_NODES.every((node) => node.route.startsWith('/config/'))).toBe(true);
    expect(RELATED_BATCH_NODES.map((node) => node.tcode)).toEqual([
      'MBC1', 'BMC1', 'CU70', 'MB5C', 'BMBC', 'MSC2N', 'MSC3N',
    ]);
    expect(BATCH_IMG_NODES.some((node) => node.route === '/config/characteristics')).toBe(false);
    expect(NOT_OCHA.find((node) => node.tcode === 'CT04')).toMatchObject({
      route: '/config/characteristics',
    });
    expect(NOT_OPENED).toEqual([
      'batch determination',
      'movement 341',
      'movement 342',
      'class type 023',
    ]);
  });

  it('does not write, and does not invent a determination transaction', () => {
    const page = readFileSync('src/app/config/batch-management/page.tsx', 'utf8');
    expect(page).toMatch(/It is not CT04/);
    expect(page).not.toMatch(/<form/);
    expect(page).not.toMatch(/saveCharacteristic|saveClass|saveBatch/);
    expect(page).not.toMatch(/OICQ|VCH1/);
    const created = readFileSync('drizzle/9127_ocha_batch_img_term.sql', 'utf8');
    expect(created).not.toMatch(/CREATE TABLE/i);
    expect(created).toMatch(/'OCHA'/);
    const sql = readFileSync('drizzle/9128_ocha_term_description.sql', 'utf8');
    expect(sql).not.toMatch(/CREATE TABLE/i);
    expect(sql).not.toMatch(/insert into characteristic/i);
    expect(sql).not.toMatch(/CT04|OMCE|OMCS|OMCU|OMCZ|OMAD|341|342/);
  });

  it('keeps the OCHA alias off the characteristic term', () => {
    const seed = readFileSync('scripts/seed.ts', 'utf8');
    const ct04At = seed.indexOf("ourCode: 'CFG.PROC.CHARACTERISTIC.DEFINE'");
    const ct04 = seed.slice(ct04At, seed.indexOf('ourCode:', ct04At + 10));
    expect(ct04).toMatch(/aliases: \['CT04'\]/);
    expect(ct04).not.toMatch(/OCHA/);
    const ochaAt = seed.indexOf("ourCode: 'CFG.INV.BATCHIMG.DISPLAY'");
    const ocha = seed.slice(ochaAt, seed.indexOf('ourCode:', ochaAt + 10));
    expect(ocha).toMatch(/aliases: \['OCHA'\]/);
    expect(ocha).toMatch(/route: '\/config\/batch-management'/);
    expect(ocha).not.toMatch(/CT04|OMCE|341/);
    expect(readFileSync('onboarding-manual.md', 'utf8')).toMatch(/\/config\/batch-management/);
  });

  it('does not let the index description steal another transaction code', () => {
    const catalogue = [
      {
        ourCode: 'CFG.PROC.CHARACTERISTIC.DEFINE',
        ourTable: null,
        title: 'Define characteristics',
        description: 'Define characteristics.',
        aliases: ['CT04'],
        isSearchable: true,
      },
      {
        ourCode: 'CFG.INV.BATCHLEVEL.DEFINE',
        ourTable: null,
        title: 'Define batch level',
        description: 'Define the batch level.',
        aliases: ['OMCE'],
        isSearchable: true,
      },
      {
        ourCode: ACTIVITY,
        ourTable: null,
        title: 'Batch management index',
        description: 'OCHA is a search alias only. It opens the batch management configuration index. It does not define a characteristic, assign a class, or store a batch value. It does not create a batch, post a movement, or select a plant. Opening this screen writes nothing.',
        aliases: ['OCHA'],
        isSearchable: true,
      },
    ];
    expect(rankRegistry(catalogue, 'OCHA', 2)[0]?.item.ourCode).toBe(ACTIVITY);
    expect(rankRegistry(catalogue, 'CT04', 2)[0]?.item.ourCode).toBe('CFG.PROC.CHARACTERISTIC.DEFINE');
    expect(rankRegistry(catalogue, 'OMCE', 2)[0]?.item.ourCode).toBe('CFG.INV.BATCHLEVEL.DEFINE');
    expect(rankRegistry(catalogue, 'IMG', 2).some((hit) => hit.item.ourCode === ACTIVITY)).toBe(false);
  });

  it('opens OCHA on the index and does not move an existing batch alias', async () => {
    const ocha = await resolveTerm('OCHA');
    const omce = await resolveTerm('OMCE');
    expect(ocha).toMatchObject({
      routePath: '/config/batch-management',
      matchKind: 'EXACT',
      matchUnique: true,
    });
    expect(omce).toMatchObject({
      routePath: '/config/batch-level',
      matchKind: 'EXACT',
      matchUnique: true,
    });
  });

  it('shows the class that uses a characteristic and does not invent a batch value', async () => {
    const tenant = await createTenant('ocha-where-used');
    clients.push(tenant.client);
    const other = await createTenant('ocha-where-used-other');
    clients.push(other.client);

    await saveCharacteristic({
      client: tenant.client,
      changedBy: ACTOR,
      mode: 'CREATE',
      characteristicName: 'SHADE',
      description: 'Surface shade',
      dataFormat: 'CHAR',
      valueLength: 10,
      decimalPlaces: 0,
      unit: '',
      currency: '',
      negativeValuesAllowed: false,
      caseSensitive: false,
      intervalsAllowed: false,
      additionalValuesAllowed: false,
      valueAssignment: 'SINGLE',
      requiredEntry: false,
      values: ['RED'],
      reason: 'OCHA where-used',
    });
    await saveClass({
      client: tenant.client,
      changedBy: ACTOR,
      mode: 'CREATE',
      classType: 'BATCH',
      className: 'SHADE_CLASS',
      description: 'Shade class',
      assignments: [{ characteristicName: 'SHADE', requiredForClassification: false }],
      reason: 'OCHA where-used',
    });

    const rows = await listCharacteristics(tenant.client);
    expect(rows.find((row) => row.characteristicName === 'SHADE')).toMatchObject({
      whereUsed: [{ classType: 'BATCH', className: 'SHADE_CLASS', position: 1 }],
    });
    const hidden = await listCharacteristics(other.client);
    expect(hidden.find((row) => row.characteristicName === 'SHADE')).toBeUndefined();
  });
});
