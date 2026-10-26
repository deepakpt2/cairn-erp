/**
 * The registration of `/config/settlement-configuration`.
 *
 * The configuration workbench renders its steps from `config_activity`, so a screen whose capability,
 * activity row and term row are not all present is not failing: it is simply missing, and the person
 * who has to maintain the settlement masters never finds the path. This checks the rows migration 9189
 * stores, against the live database, and checks the other half of the same decision: that no settlement
 * default was seeded for a tenant.
 */
import { afterAll, describe, expect, it } from 'vitest';

import { closeDb, createTenant, db, destroyTenant, sql, withTenant } from './helpers';

const ACTIVITY = 'CFG.COST.SETTLEMENT.DEFINE';
const RULE_ACTIVITY = 'CO.SETTLE.RULE';
const ROUTE = '/config/settlement-configuration';
const CONTROLLING_AREA_ACTIVITY = 'CFG.COST.CONTROLLINGAREA.DEFINE';
const clients: string[] = [];

afterAll(async () => {
  for (const client of clients) await destroyTenant(client);
  await closeDb();
});

async function globalRows<T>(query: ReturnType<typeof sql>): Promise<T[]> {
  return (await db().execute(query)) as unknown as T[];
}

describe('the settlement configuration screen registration', () => {
  it('registers the capability as a non-posting configuration authority', async () => {
    const rows = await globalRows<{ code: string; module: string; action: string; is_posting_relevant: boolean; description: string }>(sql`
      select code, module, action, is_posting_relevant, description
        from capability where code = ${ACTIVITY}
    `);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ code: ACTIVITY, module: 'COST', action: 'CONFIGURE', is_posting_relevant: false });
    // Nothing here posts: the sentence a role administrator reads says so.
    expect(rows[0]?.description).toMatch(/Nothing is posted/i);
    expect(rows[0]?.description).toMatch(/allocation structure/i);
    expect(rows[0]?.description).toMatch(/settlement profile/i);
  });

  it('shows in the configuration workbench at the screen that maintains the masters', async () => {
    const rows = await globalRows<{
      area: string; title: string; activity_kind: string; route_path: string; is_config_only: boolean; prerequisite_exists: number;
    }>(sql`
      select a.area, a.title, a.activity_kind, a.route_path, a.is_config_only,
             (select count(*)::int from config_activity p where p.code = ${CONTROLLING_AREA_ACTIVITY}) as prerequisite_exists
        from config_activity a
       where a.code = ${ACTIVITY}
    `);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      area: 'CONTROLLING',
      activity_kind: 'DEFINE',
      route_path: ROUTE,
      is_config_only: true,
      prerequisite_exists: 1,
    });
    // The name of the step says what it maintains and never sounds like one order's rule.
    expect(rows[0]?.title).toMatch(/settlement configuration/i);
  });

  it('names the shared masters in the term registry so a reader finds the boundary', async () => {
    const rows = await globalRows<{ our_table: string; title: string; term_type: string; module: string; description: string; route_path: string }>(sql`
      select our_table, title, term_type, module, description, route_path
        from term_registry where our_code = ${ACTIVITY}
    `);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      our_table: 'settlement_profile', term_type: 'CONFIG_ACTIVITY', module: 'CO', route_path: ROUTE,
    });
    expect(rows[0]?.description).toMatch(/no SAP transaction code/i);
    expect(rows[0]?.description).toMatch(/\/controlling\/settlement-rules/);
  });

  it('tells the rule screen whose masters are shared', async () => {
    const rows = await globalRows<{ description: string }>(sql`
      select description from capability where code = ${RULE_ACTIVITY}
    `);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.description).toContain(ROUTE);
    expect(rows[0]?.description).toMatch(/Saving does not post/i);
  });

  it('states the owner of each shared master in the schema itself', async () => {
    const rows = await globalRows<{ relname: string; description: string | null }>(sql`
      select c.relname, d.description
        from pg_class c
        join pg_namespace n on n.oid = c.relnamespace
        left join pg_description d on d.objoid = c.oid and d.objsubid = 0
       where n.nspname = 'public'
         and c.relname in ('allocation_structure', 'allocation_structure_assignment', 'settlement_profile',
                           'internal_order_type_settlement_profile', 'settlement_distribution_rule')
    `);
    expect(rows).toHaveLength(5);
    const byName = new Map(rows.map((row) => [row.relname, row.description ?? '']));
    for (const table of ['allocation_structure', 'allocation_structure_assignment', 'settlement_profile', 'internal_order_type_settlement_profile']) {
      expect(byName.get(table), `${table} comment`).toMatch(/Shared master/i);
      expect(byName.get(table), `${table} comment`).toContain(ACTIVITY);
    }
    // And the one table the rule screen owns says so, naming its own capability.
    expect(byName.get('settlement_distribution_rule')).toMatch(/\/controlling\/settlement-rules/);
    expect(byName.get('settlement_distribution_rule')).toContain(RULE_ACTIVITY);
  });

  it('grants the new authority to no role by itself', async () => {
    // The migration may copy the capability to the roles that already maintain the controlling area,
    // but a role is never granted a posting authority here, and nothing is inserted for a role that
    // does not already hold one of the named peers.
    const rows = await globalRows<{ granted: number; also_posts: number }>(sql`
      select
        (select count(*)::int from role_capability where capability_code = ${ACTIVITY}) as granted,
        (select count(*)::int from role_capability rc
           where rc.capability_code = ${ACTIVITY}
             and not exists (
               select 1 from role_capability peer
                where peer.client = rc.client and peer.role_code = rc.role_code
                  and peer.capability_code in (${CONTROLLING_AREA_ACTIVITY}, 'CFG.COST.COSTCENTER.DEFINE', ${RULE_ACTIVITY})
             )) as also_posts
    `);
    expect(rows[0]).toMatchObject({ also_posts: 0 });
  });

  it('seeds no settlement default for a new tenant', async () => {
    const tenant = await createTenant('ko88-no-defaults');
    clients.push(tenant.client);
    const counts = await withTenant(tenant.client, async (tx) => tx.execute(sql`
      select (select count(*)::int from allocation_structure) as structures,
             (select count(*)::int from allocation_structure_assignment) as assignments,
             (select count(*)::int from settlement_profile) as profiles,
             (select count(*)::int from internal_order_type_settlement_profile) as type_links,
             (select count(*)::int from settlement_distribution_rule) as rules,
             (select count(*)::int from config_activity_status where activity_code = ${ACTIVITY}) as step,
             (select count(*)::int from config_activity_status where activity_code = ${CONTROLLING_AREA_ACTIVITY}) as peer_step
    `)) as unknown as Array<Record<string, number>>;
    expect(counts[0]).toMatchObject({
      structures: 0, assignments: 0, profiles: 0, type_links: 0, rules: 0,
    });
    // The checklist row of the new step is created exactly as its peers' are: the migration backfills
    // the tenants that exist when it runs, and onboarding creates it for a later one. The workbench
    // left joins the status, so a tenant without the row still sees and opens the step.
    expect(counts[0]?.step).toBe(counts[0]?.peer_step);
  });
});
