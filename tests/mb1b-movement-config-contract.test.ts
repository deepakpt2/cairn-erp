import { sql } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';

import { withTenant } from '../src/platform/db/client';
import { createTenant, destroyTenant } from './helpers';

/**
 * SCR-146 stage 2 — the movement catalogue can describe itself.
 *
 * §9 of the specification lists what movement-type configuration must control. These assertions
 * are about the table being able to *carry* that list at all: before this migration it could not
 * say which dimensions may move, whether a movement is two-step, what master data it requires or
 * how it treats negative stock, so every one of those questions was answered by a TypeScript
 * constant instead.
 */
describe('SCR-146 the movement configuration is data', () => {
  let client = '';

  afterAll(async () => {
    if (client) await destroyTenant(client);
  });

  const columns = async () => {
    const rows = await withTenant(client, (tx) => tx.execute(sql`
      select column_name from information_schema.columns where table_name = 'movement_type'
    `)) as unknown as Array<{ column_name: string }>;
    return rows.map((r) => r.column_name);
  };

  it('carries every rule §9 lists, as columns', async () => {
    const tenant = await createTenant('scr146-config');
    client = tenant.client;
    const present = await columns();
    for (const column of [
      'movement_kind', 'source_stock_type', 'destination_stock_type',
      'plant_rule', 'location_rule', 'is_two_step',
      'requires_batch', 'requires_serial', 'requires_special_stock', 'requires_valuation_type',
      'negative_stock_policy', 'valuation_relevant',
    ]) {
      expect(present, `movement_type.${column}`).toContain(column);
    }
  });

  it('refuses a vocabulary it does not define', async () => {
    // The rejection poisons the transaction, so it is expected at the transaction boundary rather
    // than swallowed inside it — which is exactly how a posting would see it.
    await expect(withTenant(client, (tx) => tx.execute(sql`
      insert into movement_type (client, movement_type, description, direction, reference_category, plant_rule)
      values (${client}, 'BAD_RULE', 'Bad rule', 'TRANSFER', 'MATERIAL_DOCUMENT', 'SIDEWAYS')
    `))).rejects.toThrow(/movement_type_plant_rule_ck/);

    await expect(withTenant(client, (tx) => tx.execute(sql`
      insert into movement_type (client, movement_type, description, direction, reference_category)
      values (${client}, 'BAD_DIRECTION', 'Bad direction', 'SIDEWAYS', 'MATERIAL_DOCUMENT')
    `))).rejects.toThrow(/movement_type_direction_ck/);
  });

  it('gives the material document its external reference and its request fingerprint', async () => {
    const rows = await withTenant(client, (tx) => tx.execute(sql`
      select column_name from information_schema.columns where table_name = 'material_document'
    `)) as unknown as Array<{ column_name: string }>;
    const present = rows.map((r) => r.column_name);
    expect(present).toContain('external_reference');
    expect(present).toContain('request_fingerprint');
  });
});
