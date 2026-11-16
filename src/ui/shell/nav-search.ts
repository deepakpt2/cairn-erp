import { NAV_MODULES, SCREENS, type NavModule, type ScreenLink } from './screen-catalog';
import { screenHref } from './screen-links';

/**
 * Global menu search (navigation Stage 4): a typed phrase against the screens a reader may be offered.
 *
 * Pure. The caller passes `visible` (from `menuScreenIds`) so a screen the menu hides is never found here either;
 * finding a screen grants nothing, the page still asks for its own authority. Results are grouped by module, one
 * row per screen, under the screen's primary home.
 *
 * Matching is on our own vocabulary only: title, our screen code, activity, category, module name and the
 * catalogue's keywords. Reference transaction codes are not in the catalogue (CAIRN.md §19.5, AI-05); they
 * arrive as `aliasHits` from the term registry, and a screen found that way carries the alias it was found by,
 * so the reader sees why it matched.
 */
export interface AliasHit {
  /** Route of the registry entry the alias belongs to. */
  routePath: string;
  alias: string;
}

export interface NavSearchResult {
  id: string;
  title: string;
  href: string;
  /** Module / category / activity, for the row's second line. */
  where: string;
  /** Set when the screen was found by a reference alias rather than by its own words. */
  alias?: string;
}

export interface NavSearchGroup {
  module: NavModule;
  label: string;
  results: NavSearchResult[];
}

function tokens(query: string): string[] {
  return query.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
}

/** Lower is better; null is no match. Every token must be found somewhere. */
function score(screen: ScreenLink, words: string[], moduleLabel: string): number | null {
  const title = screen.title.toLowerCase();
  const nav = screen.nav;
  const fields = [
    title,
    screen.code.toLowerCase(),
    (nav?.activity ?? '').toLowerCase(),
    (nav?.category ?? '').toLowerCase(),
    moduleLabel.toLowerCase(),
    ...(nav?.keywords ?? []).map((k) => k.toLowerCase()),
  ];
  let total = 0;
  for (const word of words) {
    if (title.split(/[^a-z0-9]+/).some((w) => w.startsWith(word))) total += 0;
    else if (title.includes(word)) total += 1;
    else if (fields.slice(1, 2).some((f) => f.includes(word))) total += 2;
    else if ((nav?.keywords ?? []).some((k) => k.toLowerCase().includes(word))) total += 2;
    else if (fields.slice(2).some((f) => f.includes(word))) total += 3;
    else return null;
  }
  return total;
}

export function searchNav(
  query: string,
  visible: ReadonlySet<string>,
  aliasHits: readonly AliasHit[] = [],
  limitPerModule = 12,
): NavSearchGroup[] {
  const words = tokens(query);
  if (words.length === 0) return [];
  const labels = new Map(NAV_MODULES.map((m) => [m.id, m.label] as const));
  const byRoute = new Map<string, string>();
  for (const hit of aliasHits) if (!byRoute.has(hit.routePath)) byRoute.set(hit.routePath, hit.alias);
  // An alias's route may carry a query (`/inventory/materials?new=1`). The exact address wins; a route that no
  // screen answers exactly falls back to the screens at its path.
  const exact = new Set(SCREENS.map((s) => screenHref(s)));
  const aliasOf = (screen: ScreenLink): string | undefined => {
    const own = byRoute.get(screenHref(screen));
    if (own !== undefined) return own;
    for (const [route, alias] of byRoute) {
      if (!exact.has(route) && route.split('?')[0] === screen.path) return alias;
    }
    return undefined;
  };

  const scored: { screen: ScreenLink; rank: number; alias?: string }[] = [];
  for (const screen of SCREENS) {
    if (!visible.has(screen.id) || !screen.nav) continue;
    const own = score(screen, words, labels.get(screen.nav.module) ?? '');
    const alias = aliasOf(screen);
    if (own === null && alias === undefined) continue;
    // A screen found only by its alias ranks after every screen found by its own words.
    scored.push({ screen, rank: own ?? 100, alias: own === null ? alias : undefined });
  }

  const groups: NavSearchGroup[] = [];
  for (const module of NAV_MODULES) {
    const rows = scored
      .filter((s) => s.screen.nav!.module === module.id)
      .sort((a, b) => a.rank - b.rank || a.screen.title.localeCompare(b.screen.title) || a.screen.id.localeCompare(b.screen.id))
      .slice(0, limitPerModule)
      .map(({ screen, alias }): NavSearchResult => ({
        id: screen.id,
        title: screen.title,
        href: screenHref(screen),
        where: [module.label, screen.nav!.category, screen.nav!.activity].join(' / '),
        ...(alias ? { alias } : {}),
      }));
    if (rows.length > 0) groups.push({ module: module.id, label: module.label, results: rows });
  }
  // Best group first: the module holding the best-ranked match.
  const best = (g: NavSearchGroup) => scored.find((s) => s.screen.id === g.results[0].id)?.rank ?? 100;
  return groups.sort((a, b) => best(a) - best(b));
}
