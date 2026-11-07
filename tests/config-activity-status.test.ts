import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';

import { createTenant } from '../src/platform/tenancy';
import { recomputeActivityStatus } from '../src/platform/tenancy/config-activity-status';
import { destroyTenant, withTenant } from './helpers';

/**
 * The workbench, settled against the configuration instead of against what
 * happened to be marked.
 *
 * Three of these paths were untested because the behaviour they pin did not exist:
 * a step written by the standard package was never marked, a step whose status row
 * was missing was marked by nothing at all without complaint, and a run could in
 * principle take back a step a hand had completed. The first two are the reason a
 * fresh tenant's workbench can ask for work already standing in it; the third is
 * why this runs in one direction only.
 */

const KEYS = ['CR01', 'CR02'] as const;
const PASSWORD = 'config-status-2026';

function input(clientKey: string, name: string) {
  return {
    clientKey,
    name,
    creationType: 'standard' as const,
    country: 'KW',
    currency: 'KWD',
    timezone: 'Asia/Kuwait',
    administrator: {
      username: 'first.admin',
      fullName: 'First Administrator',
      email: 'first.admin@cairn.local',
      password: PASSWORD,
    },
    createdBy: 'TEST',
  };
}

async function statusOf(client: string, code: string): Promise<string | null> {
  const rows = (await withTenant(client, (tx) =>
    tx.execute(sql`select status from config_activity_status
                    where client = ${client} and activity_code = ${code}`),
  )) as unknown as Array<{ status: string }>;
  return rows[0]?.status ?? null;
}

async function countRows(client: string, relation: string): Promise<number> {
  const rows = (await withTenant(client, (tx) =>
    tx.execute(sql.raw(`select count(*)::int as n from ${relation}`)),
  )) as unknown as Array<{ n: number }>;
  return rows[0]?.n ?? 0;
}

async function mark(client: string, code: string, status: string): Promise<void> {
  await withTenant(client, (tx) =>
    tx.execute(sql`update config_activity_status set status = ${status}
                    where client = ${client} and activity_code = ${code}`),
  );
}

describe('configuration status recompute', () => {
  beforeAll(async () => {
    // One tenant, created once: the tests below read the checklist it was born with
    // and then disturb it, so a tenant per test would measure the creation order
    // rather than the rule being asserted.
    await createTenant(input('CR01', 'Checklist Tenant'));
    await createTenant(input('CR02', 'Gapped Tenant'));
  });

  afterAll(async () => {
    for (const key of KEYS) {
      if (await countRows(key, 'client')) await destroyTenant(key);
    }
  });

  it('gives every catalogue step a standing row for the tenant', async () => {
    const activities = await countRows('CR01', 'config_activity');
    const statuses = await countRows('CR01', 'config_activity_status');

    expect(activities).toBeGreaterThan(50);
    expect(statuses).toBe(activities);
  });

  it('marks complete the steps the tenant already holds, including the ones nothing marked', async () => {
    // The administrator is a user and the package wrote G/L accounts, so both steps
    // are standing in the tenant. Only the first was ever marked by tenant creation;
    // the second used to sit at NOT_STARTED over a table with rows in it.
    expect(await countRows('CR01', 'app_user')).toBeGreaterThan(0);
    expect(await countRows('CR01', 'gl_account')).toBeGreaterThan(0);
    expect(await statusOf('CR01', 'CFG.PLT.USER.CREATE')).toBe('COMPLETED');
    expect(await statusOf('CR01', 'CFG.FIN.GLACCOUNT.CREATE')).toBe('COMPLETED');
  });

  it('leaves a step alone when the tenant holds none of what it defines', async () => {
    expect(await countRows('CR01', 'settlement_profile')).toBe(0);
    expect(await statusOf('CR01', 'CFG.COST.SETTLEMENT.DEFINE')).toBe('NOT_STARTED');
  });

  it('never takes back a step a hand completed', async () => {
    // A tenant is allowed to record that a step is done deliberately — the work was
    // performed outside Cairn, or the step does not apply. Evidence is what settles
    // an unmarked step; it is not grounds to overrule a decision.
    const before = await recomputeActivityStatus({ client: 'CR01', by: 'TEST' });
    await mark('CR01', 'CFG.COST.SETTLEMENT.DEFINE', 'COMPLETED');
    await mark('CR01', 'CFG.FIN.RETAINED.DEFINE', 'SKIPPED');

    const after = await recomputeActivityStatus({ client: 'CR01', by: 'TEST' });

    expect(await statusOf('CR01', 'CFG.COST.SETTLEMENT.DEFINE')).toBe('COMPLETED');
    expect(await statusOf('CR01', 'CFG.FIN.RETAINED.DEFINE')).toBe('SKIPPED');
    expect(after.completedNow).toBe(0);
    expect(after.alreadyComplete).toBe(before.alreadyComplete + 1);
  });

  it('repairs a tenant whose status rows are missing, without complaint or surprise', async () => {
    // A tenant older than the catalogue, or one whose rows were pruned, is exactly
    // the case `markActivityComplete` used to swallow: an update against no row.
    await withTenant('CR02', (tx) =>
      tx.execute(sql`delete from config_activity_status
                      where client = 'CR02' and activity_code in ('CFG.FIN.GLACCOUNT.CREATE', 'CFG.PLT.USER.CREATE')`),
    );
    expect(await statusOf('CR02', 'CFG.FIN.GLACCOUNT.CREATE')).toBeNull();

    const result = await recomputeActivityStatus({ client: 'CR02', by: 'TEST' });

    expect(result.rowsCreated).toBe(2);
    expect(await statusOf('CR02', 'CFG.FIN.GLACCOUNT.CREATE')).toBe('COMPLETED');
    expect(await statusOf('CR02', 'CFG.PLT.USER.CREATE')).toBe('COMPLETED');

    // Settling twice changes nothing the second time.
    const again = await recomputeActivityStatus({ client: 'CR02', by: 'TEST' });
    expect(again.rowsCreated).toBe(0);
    expect(again.completedNow).toBe(0);
  });
});
