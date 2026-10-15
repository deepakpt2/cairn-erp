/**
 * SCR-028 / FS00 stage 4 — G/L account activity registry contract.
 *
 * FS00 replaced the legacy read-only G/L account list. One maintenance screen per
 * activity, the OB13 shape: three capabilities and three Term Registry entries,
 * with the FS00 and FSP0 aliases moved onto their own activities and FSS0 added.
 *
 * These tests read the database, not the seed source: migration 0037 and
 * `scripts/seed.ts` are two routes to the same end state, and only the persisted
 * registry proves both of them got there.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { inArray } from 'drizzle-orm';

import { closeDb, db, sql } from './helpers';
import { hasCapability } from '@/platform/auth/session';
import { capability } from '@/platform/tables/security';
import { termAlias, termRegistry } from '@/platform/tables/registry';

const LEGACY_TERM = 'FIN.GL.MASTER.LIST';
const LEGACY_CAPABILITY = 'FIN.GL.MASTER.CREATE';

const ACTIVITIES = [
  { code: 'CFG.FIN.GLACCOUNT.CREATE', alias: 'FS00', route: '/config/gl-accounts/new', action: 'CONFIGURE' },
  { code: 'CFG.FIN.GLACCOUNT.CHANGE', alias: 'FSP0', route: '/config/gl-accounts/edit', action: 'CONFIGURE' },
  { code: 'CFG.FIN.GLACCOUNT.DISPLAY', alias: 'FSS0', route: '/config/gl-accounts', action: 'DISPLAY' },
] as const;

async function capabilities(codes: string[]) {
  return db()
    .select()
    .from(capability)
    .where(inArray(capability.code, codes))
    .orderBy(capability.code);
}

async function terms(codes: string[]) {
  return db()
    .select()
    .from(termRegistry)
    .where(inArray(termRegistry.ourCode, codes))
    .orderBy(termRegistry.ourCode);
}

/** Alias → term → route, the join the registry search and the command palette run. */
async function aliasTargets(aliases: string[]) {
  return db()
    .select({
      alias: termAlias.alias,
      externalSystem: termAlias.externalSystem,
      usage: termAlias.usage,
      ourCode: termRegistry.ourCode,
      routePath: termRegistry.routePath,
    })
    .from(termAlias)
    .innerJoin(termRegistry, sql`${termRegistry.id} = ${termAlias.termId}`)
    .where(inArray(termAlias.alias, aliases))
    .orderBy(termAlias.alias);
}

afterAll(async () => {
  await closeDb();
});

describe('FS00 activity registry — retirement', () => {
  it('retires the legacy read-only G/L account list term and its aliases', async () => {
    const rows = await terms([LEGACY_TERM]);
    expect(rows).toEqual([]);

    // term_alias.term_id cascades, so the term leaving takes FS00 and FSP0 with it —
    // and nothing else may still point at the retired entry.
    const orphaned = await db()
      .select({ alias: termAlias.alias })
      .from(termAlias)
      .innerJoin(termRegistry, sql`${termRegistry.id} = ${termAlias.termId}`)
      .where(sql`${termRegistry.ourCode} = ${LEGACY_TERM}`);
    expect(orphaned).toEqual([]);

    const stale = await db()
      .select({ title: termRegistry.title })
      .from(termRegistry)
      .where(sql`${termRegistry.title} = 'G/L account list'`);
    expect(stale).toEqual([]);
  });

  it('retires the legacy G/L account capability once its replacement exists', async () => {
    const rows = await capabilities([LEGACY_CAPABILITY]);
    expect(rows).toEqual([]);

    // Nothing to un-grant: role_capability has deliberately no foreign key and holds
    // patterns, so a retired capability simply stops matching anything.
    const catalogue = await capabilities([LEGACY_CAPABILITY, 'CFG.FIN.GLACCOUNT.CREATE']);
    expect(catalogue.map((c) => c.code)).toEqual(['CFG.FIN.GLACCOUNT.CREATE']);
  });

  it('keeps the retired codes out of the application source', () => {
    const remedy = readFileSync('src/platform/posting/index.ts', 'utf8');
    expect(remedy).not.toContain(LEGACY_CAPABILITY);
    expect(remedy).toContain('CFG.FIN.GLACCOUNT.CREATE');
  });
});

describe('FS00 activity registry — capabilities', () => {
  it('registers one capability per maintenance activity, none of them posting-relevant', async () => {
    const rows = await capabilities(ACTIVITIES.map((a) => a.code));

    const expected = ACTIVITIES.map((a) => [a.code, a.action]).sort();
    expect(rows.map((r) => [r.code, r.action]).sort()).toEqual(expected);
    for (const row of rows) {
      expect(row.module).toBe('FIN');
      expect(row.isPostingRelevant).toBe(false);
      expect(row.description).toBeTruthy();
    }
  });

  it('reaches the right roles through the patterns the system roles already hold', () => {
    // role_capability stores PATTERNS resolved at authorisation time by hasCapability,
    // which is why it has no foreign key and why no grant row had to be migrated.
    const ADMINISTRATOR = ['*'];
    const CONFIGURATOR = ['CFG.*', 'FND.*', 'PLT.MESSAGE.DISPLAY'];
    const ACCOUNTANT = ['FIN.*', 'COST.*', 'AUDIT.TRAIL.VIEW'];

    for (const activity of ACTIVITIES) {
      expect(hasCapability(ADMINISTRATOR, activity.code)).toBe(true);
      expect(hasCapability(CONFIGURATOR, activity.code)).toBe(true);
    }

    // The consequence to remember: the retired FIN.GL.MASTER.CREATE matched the
    // ACCOUNTANT pattern FIN.*, and the CFG.FIN.GLACCOUNT.* codes do not. G/L account
    // maintenance is configuration work now, exactly as OB13 already was.
    expect(hasCapability(ACCOUNTANT, LEGACY_CAPABILITY)).toBe(true);
    for (const activity of ACTIVITIES) {
      expect(hasCapability(ACCOUNTANT, activity.code)).toBe(false);
    }
  });
});

describe('FS00 activity registry — term entries', () => {
  it('registers three configuration activities in the OB13 shape', async () => {
    const rows = await terms(ACTIVITIES.map((a) => a.code));

    expect(rows.map((r) => r.ourCode)).toEqual(ACTIVITIES.map((a) => a.code).sort());
    for (const row of rows) {
      expect(row.termType).toBe('CONFIG_ACTIVITY');
      expect(row.module).toBe('FIN');
      expect(row.coverageTier).toBe('TIER_2_CONFIGURED');
      expect(row.conformanceTier).toBe('B');
      expect(row.isSearchable).toBe(true);
      expect(row.description).toBeTruthy();
    }
  });

  it('routes each activity to its own mode screen and leaves the hub with display', async () => {
    const rows = await terms(ACTIVITIES.map((a) => a.code));
    const routes = Object.fromEntries(rows.map((r) => [r.ourCode, r.routePath]));

    expect(routes['CFG.FIN.GLACCOUNT.CREATE']).toBe('/config/gl-accounts/new');
    expect(routes['CFG.FIN.GLACCOUNT.CHANGE']).toBe('/config/gl-accounts/edit');
    // The hub is the entry point that means something without query parameters;
    // display mode itself is /config/gl-accounts/view, reached from the hub.
    expect(routes['CFG.FIN.GLACCOUNT.DISPLAY']).toBe('/config/gl-accounts');
    expect(new Set(Object.values(routes)).size).toBe(3);
  });

  it('gives every registered route a built screen in the Configuration Workbench', () => {
    const hub = readFileSync('src/app/config/page.tsx', 'utf8');
    const built = hub.slice(hub.indexOf('const BUILT_ROUTES'), hub.indexOf(']);', hub.indexOf('const BUILT_ROUTES')));

    for (const activity of ACTIVITIES) {
      expect(built).toContain(`'${activity.route}'`);
    }
    expect(built).toContain("'/config/gl-accounts/view'");
  });
});

describe('FS00 activity registry — aliases', () => {
  it('moves FS00 and FSP0 onto their own activities and adds FSS0', async () => {
    const rows = await aliasTargets(ACTIVITIES.map((a) => a.alias));

    expect(rows.map((r) => [r.alias, r.ourCode])).toEqual(
      [...ACTIVITIES].sort((a, b) => a.alias.localeCompare(b.alias)).map((a) => [a.alias, a.code]),
    );
    for (const row of rows) {
      expect(row.externalSystem).toBe('REFERENCE_ERP');
      expect(row.usage).toBe('SEARCH_ONLY');
    }
  });

  it('resolves each alias to the route its activity owns', async () => {
    const rows = await aliasTargets(ACTIVITIES.map((a) => a.alias));
    const byAlias = Object.fromEntries(rows.map((r) => [r.alias, r.routePath]));

    expect(byAlias.FS00).toBe('/config/gl-accounts/new');
    expect(byAlias.FSP0).toBe('/config/gl-accounts/edit');
    expect(byAlias.FSS0).toBe('/config/gl-accounts');
  });

  it('keeps one owner per alias', async () => {
    const counts = await db()
      .select({ alias: termAlias.alias, n: sql<number>`count(*)::int` })
      .from(termAlias)
      .where(inArray(termAlias.alias, ACTIVITIES.map((a) => a.alias)))
      .groupBy(termAlias.alias);

    expect(counts).toHaveLength(3);
    for (const row of counts) expect(row.n).toBe(1);
  });
});
