import { readFileSync } from 'node:fs';
import { afterAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';

import { resolveTerm, searchRegistry, suggestRegistry } from '@/platform/registry';
import { closeDb, db, sql } from './helpers';
import { termAlias, termRegistry } from '@/platform/tables/registry';

afterAll(async () => {
  await closeDb();
});

describe('CO14 registry migration contract', () => {
  const migration = readFileSync('drizzle/history/9211_co14_registry_alias.sql', 'utf8');
  const seed = readFileSync('scripts/seed.ts', 'utf8');

  it('adds CO14 to the existing PROD.ORDER.DISPLAY entry without introducing authorization data', () => {
    expect(migration).toContain("'PROD.ORDER.DISPLAY'");
    expect(migration).toContain("'/production/production-order-display'");
    expect(migration).toContain("ON CONFLICT (our_code) DO UPDATE");
    expect(migration).toContain("'CO14', 'SEARCH_ONLY'");
    expect(migration).toContain('ON CONFLICT (external_system, alias) DO NOTHING');
    expect(migration).toContain('v_alias_term_id IS DISTINCT FROM v_term_id');
    expect(migration).not.toContain('INSERT INTO capability');
    expect(migration).not.toContain('INSERT INTO role_capability');
    expect(seed).toMatch(/ourCode: 'PROD\.ORDER\.DISPLAY'[\s\S]{0,400}aliases: \['CO03', 'CO14'\]/);
    expect(seed).toContain('if (alias === \'CO14\')');
    expect(seed).toContain('CO14 is already assigned to a different registry term');
  });
});

describe('CO14 database-backed registry lookup', () => {
  it('resolves CO14 to the existing production-order display route', async () => {
    const rows = await db()
      .select({
        ourCode: termRegistry.ourCode,
        routePath: termRegistry.routePath,
        alias: termAlias.alias,
        externalSystem: termAlias.externalSystem,
      })
      .from(termAlias)
      .innerJoin(termRegistry, sql`${termRegistry.id} = ${termAlias.termId}`)
      .where(and(eq(termAlias.externalSystem, 'REFERENCE_ERP'), eq(termAlias.alias, 'CO14')));

    expect(rows).toEqual([{
      ourCode: 'PROD.ORDER.DISPLAY',
      routePath: '/production/production-order-display',
      alias: 'CO14',
      externalSystem: 'REFERENCE_ERP',
    }]);

    const registeredTerms = await db()
      .select({ id: termRegistry.id })
      .from(termRegistry)
      .where(eq(termRegistry.ourCode, 'PROD.ORDER.DISPLAY'));
    expect(registeredTerms).toHaveLength(1);

    const results = await searchRegistry('CO14');
    expect(results[0]).toMatchObject({
      ourCode: 'PROD.ORDER.DISPLAY',
      title: 'Display production order confirmation',
      routePath: '/production/confirmation-display',
      matchedOn: 'ALIAS',
      matchedTerm: 'CO14',
    });

    const suggestions = await suggestRegistry('CO14');
    expect(suggestions[0]).toMatchObject({
      ourCode: 'PROD.ORDER.DISPLAY',
      title: 'Display production order confirmation',
      routePath: '/production/confirmation-display',
      field: 'ALIAS',
      matchedText: 'CO14',
    });

    expect(await resolveTerm('CO14')).toMatchObject({
      ourCode: 'PROD.ORDER.DISPLAY',
      routePath: '/production/confirmation-display',
      matchedTerm: 'CO14',
    });
    expect(await resolveTerm('CO03')).toMatchObject({
      ourCode: 'PROD.ORDER.DISPLAY',
      routePath: '/production/production-order-display',
      matchedTerm: 'CO03',
    });

    const preservedRoutes: Record<string, { ourCode: string; routePath: string }> = {
      CO03: { ourCode: 'PROD.ORDER.DISPLAY', routePath: '/production/production-order-display' },
      CO11N: { ourCode: 'PROD.CONFIRM.ENTER', routePath: '/production/time-ticket' },
      CO13: { ourCode: 'PROD.CONFIRM.CANCEL', routePath: '/production/confirmation-cancel' },
      CO15: { ourCode: 'PROD.CONFIRM.ORDER', routePath: '/production/order-confirmation' },
      COOIS: { ourCode: 'PROD.ORDER.INFO', routePath: '/production/order-information' },
    };
    for (const [alias, target] of Object.entries(preservedRoutes)) {
      expect((await searchRegistry(alias))[0]).toMatchObject({
        ...target,
        matchedOn: 'ALIAS',
        matchedTerm: alias,
      });
    }
  });
});
