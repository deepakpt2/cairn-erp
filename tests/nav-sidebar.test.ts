import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { NAV_MODULES, SCREENS } from '@/ui/shell/screen-catalog';
import { visibleScreenIds } from '@/ui/shell/screen-access';
import { menuScreenIds } from '@/ui/shell/menu-access';
import { buildNavTree, categorySlug, moduleHref, type NavModuleNode } from '@/ui/shell/nav-tree';
import { sidebarNavigationEnabled } from '@/ui/shell/nav-flag';
import { resolveMenuPath } from '@/ui/shell/menu-path';

const all = menuScreenIds(['*']);
const leavesOf = (tree: NavModuleNode[]) =>
  tree.flatMap((m) => m.categories.flatMap((c) => c.activities.flatMap((a) => a.items.map((i) => ({ module: m.id, category: c.name, activity: a.name, id: i.id })))));

describe('menu tree', () => {
  it('offers every screen the reader may see, under its primary home, and under each extra context', () => {
    const tree = buildNavTree(all);
    const leaves = leavesOf(tree);
    for (const s of SCREENS.filter((x) => x.nav!.module !== 'dashboard' && all.has(x.id))) {
      const homes = [s.nav!, ...(s.nav!.also ?? [])];
      for (const h of homes) {
        expect(leaves.some((l) => l.id === s.id && l.module === h.module && l.category === h.category && l.activity === h.activity), `${s.id} under ${h.module}/${h.category}/${h.activity}`).toBe(true);
      }
      expect(leaves.filter((l) => l.id === s.id).length, s.id).toBe(homes.length);
    }
  });

  it('puts the dashboard in as the launchpad alone, linking to it', () => {
    const dash = buildNavTree(all).find((m) => m.id === 'dashboard')!;
    expect(dash).toMatchObject({ href: '/', categories: [] });
  });

  it('keeps modules in menu order, categories alphabetical with Configuration last', () => {
    const tree = buildNavTree(all);
    expect(tree.map((m) => m.id)).toEqual(NAV_MODULES.map((m) => m.id));
    for (const m of tree.filter((x) => x.categories.length > 0)) {
      const names = m.categories.map((c) => c.name);
      const rest = names.filter((n) => n !== 'Configuration');
      expect(rest).toEqual([...rest].sort((a, b) => a.localeCompare(b)));
      if (names.includes('Configuration')) expect(names[names.length - 1]).toBe('Configuration');
    }
  });

  it('counts are the leaves beneath them', () => {
    for (const m of buildNavTree(all)) {
      if (m.id === 'dashboard') continue;
      expect(m.count).toBe(m.categories.reduce((n, c) => n + c.count, 0));
      for (const c of m.categories) expect(c.count).toBe(c.activities.reduce((n, a) => n + a.items.length, 0));
    }
  });

  it('shows a reader holding nothing only what the permission filter allows, and no empty branch', () => {
    const none = menuScreenIds([]);
    const tree = buildNavTree(none);
    for (const l of leavesOf(tree)) expect(none.has(l.id), l.id).toBe(true);
    for (const m of tree) {
      if (m.id === 'dashboard') continue;
      expect(m.categories.length).toBeGreaterThan(0);
      for (const c of m.categories) expect(c.activities.length).toBeGreaterThan(0);
    }
    expect(leavesOf(tree).length).toBeLessThan(leavesOf(buildNavTree(all)).length);
  });

  it('grows strictly: holding more never hides what was already shown', () => {
    const small = new Set(leavesOf(buildNavTree(menuScreenIds(['FIN.JOURNAL.POST']))).map((l) => `${l.module}|${l.id}`));
    const big = new Set(leavesOf(buildNavTree(all)).map((l) => `${l.module}|${l.id}`));
    for (const k of small) expect(big.has(k), k).toBe(true);
  });

  it('never offers an exact-grant-only screen to a wildcard holder', () => {
    const stockAgeing = SCREENS.find((s) => s.code === 'INV.STOCK.AGEING.DISPLAY')!;
    // The related strip offers it to everybody, because its code names reading; the menu does not.
    expect(visibleScreenIds(['*']).has(stockAgeing.id)).toBe(true);
    for (const held of [['*'], [], ['INV.*']]) {
      expect(new Set(leavesOf(buildNavTree(menuScreenIds(held))).map((l) => l.id)).has(stockAgeing.id), held.join()).toBe(false);
    }
    const named = new Set(leavesOf(buildNavTree(menuScreenIds(['INV.STOCK.AGEING.DISPLAY']))).map((l) => l.id));
    expect(named.has(stockAgeing.id)).toBe(true);
  });

  it('is never wider than the related strip, for any reader', () => {
    for (const held of [[], ['*'], ['INV.STOCK.AGEING.DISPLAY'], ['FIN.JOURNAL.POST'], ['PROD.ORDER.COST.DISPLAY', 'CO.ORDER.COST.DISPLAY']]) {
      const strip = visibleScreenIds(held);
      for (const id of menuScreenIds(held)) expect(strip.has(id), `${id} for ${held.join()}`).toBe(true);
    }
  });

  it('leaves a hidden screen out of the tree', () => {
    const target = SCREENS.find((s) => s.nav!.module === 'mm')!;
    const original = target.nav!.hidden;
    (target.nav as { hidden?: boolean }).hidden = true;
    try {
      expect(leavesOf(buildNavTree(all)).some((l) => l.id === target.id)).toBe(false);
    } finally {
      (target.nav as { hidden?: boolean }).hidden = original;
    }
  });

  it('builds addresses that open the screen, and module pages that exist', () => {
    expect(moduleHref('mm')).toBe('/menu?module=mm');
    expect(moduleHref('dashboard')).toBe('/');
    expect(categorySlug('Accounts payable')).toBe('accounts-payable');
    for (const l of leavesOf(buildNavTree(all))) expect(l.id.startsWith('/')).toBe(true);
  });
});

describe('module page address in the menu path', () => {
  it('names the module alone, and nothing for an unknown module', () => {
    expect(resolveMenuPath('/menu', new URLSearchParams('module=mm'))!.segments).toEqual(['MM – Materials Management']);
    expect(resolveMenuPath('/menu', new URLSearchParams('module=zz'))).toBeNull();
  });

  it('links the module and category levels of a screen to the module page', () => {
    const p = resolveMenuPath('/purchasing/orders', new URLSearchParams())!;
    expect(p.links[0]).toBe('/menu?module=mm');
    expect(p.links[1]).toBe('/menu?module=mm#procurement');
    expect(p.links[p.links.length - 1]).toBeNull();
  });
});

describe('the flag', () => {
  const saved = process.env.CAIRN_NAVIGATION;
  afterEach(() => { if (saved === undefined) delete process.env.CAIRN_NAVIGATION; else process.env.CAIRN_NAVIGATION = saved; });

  it('is off unless set to exactly "sidebar"', () => {
    for (const v of [undefined, '', '1', 'true', 'on', 'Sidebar']) {
      if (v === undefined) delete process.env.CAIRN_NAVIGATION; else process.env.CAIRN_NAVIGATION = v;
      expect(sidebarNavigationEnabled(), String(v)).toBe(false);
    }
    process.env.CAIRN_NAVIGATION = 'sidebar';
    expect(sidebarNavigationEnabled()).toBe(true);
  });

  it('leaves the shell as it was when off: the layout keeps its plain main, and the sidebar and module page refuse to render', () => {
    const layout = readFileSync('src/app/layout.tsx', 'utf8');
    expect(layout).toContain('sidebarNavigationEnabled() ? (');
    expect(layout).toContain('<main className="flex-1">{children}</main>');
    expect(readFileSync('src/ui/shell/NavSidebar.tsx', 'utf8')).toContain('if (!sidebarNavigationEnabled()) return null;');
    expect(readFileSync('src/app/menu/page.tsx', 'utf8')).toContain('if (!sidebarNavigationEnabled()) notFound();');
  });

  it('decides on the server and ships the browser only labels and addresses', () => {
    const server = readFileSync('src/ui/shell/NavSidebar.tsx', 'utf8');
    expect(server).toContain('menuScreenIds(session.user.capabilities)');
    const client = readFileSync('src/ui/shell/SidebarMenu.tsx', 'utf8');
    expect(client).not.toContain('capabilities');
    expect(client).not.toContain('screen-access');
  });
});
