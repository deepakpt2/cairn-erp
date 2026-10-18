import { sql } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';

import { withTenant } from '../src/platform/db/client';
import { changeHistory } from '../src/platform/change';
import {
  deleteIndustry,
  listIndustries,
  saveIndustry,
  setIndustryActive,
} from '../src/modules/foundation/industry-definition';
import { createTenant, destroyTenant } from './helpers';

const ACTOR = 'SCR077_OB44_TEST';

/**
 * SCR-077 acceptance: the delivered industries read back, the master
 * maintained in the standing shape with language-judged descriptions,
 * and deletion refused while a partner carries the industry — by the
 * service and by the database key alike.
 */
describe('SCR-077 industries (OB44)', () => {
  let client = '';

  afterAll(async () => {
    if (client) await destroyTenant(client);
  });

  async function standingClient(): Promise<string> {
    if (!client) {
      const tenant = await createTenant('scr077-industries');
      client = tenant.client;
      await withTenant(client, async (tx) => {
        await tx.execute(sql`
          insert into config_activity_status (client, activity_code, status, created_by)
          values (${client}, 'CFG.ORG.INDUSTRY.DEFINE', 'NOT_STARTED', ${ACTOR})
          on conflict (client, activity_code) do nothing
        `);
      });
    }
    return client;
  }

  const create = (patch: Record<string, unknown> = {}) => ({
    client, changedBy: ACTOR, mode: 'CREATE' as const,
    code: 'AGRI', texts: [{ language: 'en', description: 'Agriculture' }],
    reason: 'Stage 5 acceptance', ...patch,
  });

  it('reads back the five delivered industries with their descriptions', async () => {
    const c = await standingClient();
    const rows = await listIndustries(c);
    expect(rows.map((r) => r.code)).toEqual(['CHEM', 'CONS', 'MEC1', 'PHAR', 'RETL']);
    expect(rows.find((r) => r.code === 'MEC1')?.description).toBe('Mechanical Eng.');
    expect(rows.every((r) => r.isActive && r.partnerCount === 0)).toBe(true);
  });

  it('creates, changes and deactivates in the standing shape, refusing by name', async () => {
    const c = await standingClient();
    const made = await saveIndustry(create());
    expect(made).toEqual({ code: 'AGRI', changed: true });

    await expect(saveIndustry(create())).rejects.toThrow('Industry AGRI already stands');
    await expect(saveIndustry(create({ code: 'TOOLONG' })))
      .rejects.toThrow('one to four uppercase letters or digits');
    await expect(saveIndustry(create({ code: 'FARM', texts: [{ language: 'de', description: 'Landwirtschaft' }] })))
      .rejects.toThrow('Language de is not a configured system language');
    await expect(saveIndustry(create({ code: 'FARM', texts: [{ language: 'en', description: '   ' }] })))
      .rejects.toThrow('at most 20 characters');
    await expect(saveIndustry(create({ code: 'FARM', texts: [{ language: 'en', description: 'A description far too long' }] })))
      .rejects.toThrow('at most 20 characters');
    await expect(saveIndustry(create({ code: 'FARM', reason: ' ' })))
      .rejects.toThrow('A reason is required');

    const changed = await saveIndustry({
      ...create(), mode: 'CHANGE', texts: [{ language: 'en', description: 'Agriculture & food' }],
    });
    expect(changed.changed).toBe(true);
    const again = await saveIndustry({
      ...create(), mode: 'CHANGE', texts: [{ language: 'en', description: 'Agriculture & food' }],
    });
    expect(again.changed).toBe(false);
    const row = (await listIndustries(c)).find((r) => r.code === 'AGRI');
    expect(row?.description).toBe('Agriculture & food');
    expect(row?.texts).toEqual({ en: 'Agriculture & food' });

    const off = await setIndustryActive({ client: c, changedBy: ACTOR, code: 'AGRI', active: false, reason: 'Stage 5 acceptance' });
    expect(off.changed).toBe(true);
    const on = await setIndustryActive({ client: c, changedBy: ACTOR, code: 'AGRI', active: true, reason: 'Stage 5 acceptance' });
    expect(on.changed).toBe(true);

    const history = await withTenant(c, (tx) => changeHistory(tx, c, 'industry', 'AGRI'));
    expect(history.length).toBeGreaterThanOrEqual(3);
  });

  it('refuses deletion under a partner — service and database alike — then deletes clean', async () => {
    const c = await standingClient();
    // AGRI stands from the maintenance test above (one shared tenant).
    await withTenant(c, async (tx) => {
      await tx.execute(sql`
        insert into business_partner (client, partner_number, category, name, industry, created_by)
        values (${c}, 'P90000', 'ORGANIZATION', 'Farm Partner', 'AGRI', ${ACTOR})
      `);
    });
    const held = (await listIndustries(c)).find((r) => r.code === 'AGRI');
    expect(held?.partnerCount).toBe(1);

    await expect(deleteIndustry({ client: c, changedBy: ACTOR, code: 'AGRI', reason: 'Stage 5 acceptance' }))
      .rejects.toThrow('cannot be deleted: 1 business partner carries it');
    await expect(withTenant(c, (tx) => tx.execute(sql`
      delete from industry where client = ${c} and industry_code = 'AGRI'
    `))).rejects.toThrow(/violates foreign key|restrict/i);

    await withTenant(c, async (tx) => {
      await tx.execute(sql`delete from business_partner where client = ${c} and partner_number = 'P90000'`);
    });
    const gone = await deleteIndustry({ client: c, changedBy: ACTOR, code: 'AGRI', reason: 'Stage 5 acceptance' });
    expect(gone.changed).toBe(true);
    const rows = await listIndustries(c);
    expect(rows.some((r) => r.code === 'AGRI')).toBe(false);
    const texts = await withTenant(c, (tx) => tx.execute(sql`
      select count(*)::int as n from industry_text where client = ${c} and industry_code = 'AGRI'
    `));
    expect((texts as unknown as Array<{ n: number }>)[0].n).toBe(0);
  });
});
