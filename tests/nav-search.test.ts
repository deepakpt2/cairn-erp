import { describe, expect, it } from 'vitest';
import { SCREENS } from '@/ui/shell/screen-catalog';
import { menuScreenIds } from '@/ui/shell/menu-access';
import { searchNav } from '@/ui/shell/nav-search';
import { screenHref } from '@/ui/shell/screen-links';

const all = menuScreenIds(['*']);
const flat = (q: string, visible = all, alias: { routePath: string; alias: string }[] = []) =>
  searchNav(q, visible, alias).flatMap((g) => g.results.map((r) => ({ ...r, module: g.module })));

describe('menu search', () => {
  it('finds a screen by its title and by words in its place in the menu', () => {
    expect(flat('create purchase order').some((r) => r.title === 'Create purchase order')).toBe(true);
    expect(flat('procurement').length).toBeGreaterThan(0);
  });

  it('returns nothing for an empty or symbol-only phrase', () => {
    expect(searchNav('', all)).toEqual([]);
    expect(searchNav(' -- ', all)).toEqual([]);
  });

  it('requires every word to match', () => {
    expect(flat('purchase zzzqqq')).toEqual([]);
  });

  it('never returns a screen outside the visible set', () => {
    const none = new Set<string>();
    expect(searchNav('purchase', none)).toEqual([]);
    const one = SCREENS.find((s) => s.title === 'Create purchase order')!;
    const found = flat('purchase', new Set([one.id]));
    expect(found.map((r) => r.id)).toEqual([one.id]);
  });

  it('is filtered like the menu: an exact-grant screen is not found without its grant', () => {
    const held = menuScreenIds(['MM.PO.CREATE']);
    for (const r of flat('stock ageing', held)) expect(held.has(r.id)).toBe(true);
  });

  it('groups by module and gives each screen one row', () => {
    const groups = searchNav('order', all);
    const ids = groups.flatMap((g) => g.results.map((r) => r.id));
    expect(new Set(ids).size).toBe(ids.length);
    expect(new Set(groups.map((g) => g.module)).size).toBe(groups.length);
    for (const g of groups) expect(g.results.length).toBeLessThanOrEqual(12);
  });

  it('labels a screen found by a reference alias, and does not label one found by its own words', () => {
    const po = SCREENS.find((s) => s.title === 'Create purchase order')!;
    const byAlias = flat('zz9', all, [{ routePath: po.path, alias: 'ZZ99' }]).find((r) => r.id === po.id);
    expect(byAlias?.alias).toBe('ZZ99');
    const byWords = flat('create purchase order', all, [{ routePath: po.path, alias: 'ZZ99' }]).find((r) => r.id === po.id);
    expect(byWords?.alias).toBeUndefined();
  });

  it('keeps reference identifiers out of the catalogue vocabulary it matches on', () => {
    // AI-05: the catalogue holds no SAP transaction codes; they live only in the term registry's aliases.
    const reference = /\b(?:ME2[0-9]N?|MIGO|MIRO|VA0[123]|FB60|OMD0)\b/i;
    for (const sc of SCREENS) {
      const words = [sc.title, sc.nav!.category, sc.nav!.activity, ...(sc.nav!.keywords ?? [])].join(' ');
      expect(reference.test(words), sc.id).toBe(false);
    }
  });
});

describe('menu search: alias routes', () => {
  it('matches an alias whose route carries a query to the exact screen', () => {
    const withQuery = SCREENS.find((s) => Object.keys(s.query).length > 0 && s.nav)!;
    const route = screenHref(withQuery);
    const found = flat('zz9', all, [{ routePath: route, alias: 'ZZ99' }]);
    expect(found.some((r) => r.id === withQuery.id && r.alias === 'ZZ99')).toBe(true);
  });
});
