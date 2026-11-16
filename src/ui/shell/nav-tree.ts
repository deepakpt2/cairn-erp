import { NAV_MODULES, SCREENS, type NavModule, type NavPlacement, type ScreenLink } from './screen-catalog';
import { screenHref } from './screen-links';

/**
 * The menu tree, built from the catalogue's `nav` placements (navigation Stage 3).
 *
 * module > category > activity > screen. A screen with extra contexts (`nav.also`) appears under each of them —
 * one implementation, several doors. The tree is built for one reader: only screens in `visible` are included,
 * and a branch with nothing left is dropped. `visible` comes from `visibleScreenIds`, the same filter the related
 * strip uses, so the menu can only ever show less than the pages allow — never more, and never a different rule.
 * Showing a screen here grants nothing: the page still asks for its own authority.
 */
export interface NavLeaf {
  id: string;
  title: string;
  href: string;
}

export interface NavActivity {
  name: string;
  items: NavLeaf[];
}

export interface NavCategory {
  name: string;
  /** For a page anchor. */
  slug: string;
  activities: NavActivity[];
  count: number;
}

export interface NavModuleNode {
  id: NavModule;
  label: string;
  /** Where the module's own page is. The dashboard is the launchpad itself. */
  href: string;
  categories: NavCategory[];
  count: number;
}

export function categorySlug(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

export function moduleHref(id: NavModule): string {
  return id === 'dashboard' ? '/' : `/menu?module=${id}`;
}

/** Alphabetical, with Configuration last: the setup a few people do, after the work everyone does. */
function byCategory(a: string, b: string): number {
  const rank = (x: string) => (x === 'Configuration' ? 1 : 0);
  return rank(a) - rank(b) || a.localeCompare(b);
}

function placementsOf(screen: ScreenLink): NavPlacement[] {
  return screen.nav ? [screen.nav, ...(screen.nav.also ?? [])] : [];
}

export function buildNavTree(visible: ReadonlySet<string>): NavModuleNode[] {
  const nodes: NavModuleNode[] = [];
  for (const module of NAV_MODULES) {
    const byCat = new Map<string, Map<string, NavLeaf[]>>();
    for (const screen of SCREENS) {
      if (!visible.has(screen.id) || screen.nav?.hidden) continue;
      for (const placement of placementsOf(screen)) {
        if (placement.module !== module.id) continue;
        const activities = byCat.get(placement.category) ?? new Map<string, NavLeaf[]>();
        const leaves = activities.get(placement.activity) ?? [];
        leaves.push({ id: screen.id, title: screen.title, href: screenHref(screen) });
        activities.set(placement.activity, leaves);
        byCat.set(placement.category, activities);
      }
    }
    if (module.id === 'dashboard') {
      if (byCat.size > 0) nodes.push({ id: module.id, label: module.label, href: '/', categories: [], count: 1 });
      continue;
    }
    const categories: NavCategory[] = [...byCat.entries()]
      .sort(([a], [b]) => byCategory(a, b))
      .map(([name, activities]) => {
        const list: NavActivity[] = [...activities.entries()]
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([activity, items]) => ({
            name: activity,
            items: items.slice().sort((x, y) => x.title.localeCompare(y.title) || x.id.localeCompare(y.id)),
          }));
        return { name, slug: categorySlug(name), activities: list, count: list.reduce((n, a) => n + a.items.length, 0) };
      });
    if (categories.length === 0) continue;
    nodes.push({
      id: module.id, label: module.label, href: moduleHref(module.id), categories,
      count: categories.reduce((n, c) => n + c.count, 0),
    });
  }
  return nodes;
}
