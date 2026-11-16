import { NAV_CHILD_ROUTES, NAV_MODULES, type ScreenLink } from './screen-catalog';
import { matchScreen } from './screen-links';
import { categorySlug, moduleHref } from './nav-tree';

/**
 * Where a page sits in the menu: module > category > activity > screen (navigation Stage 2).
 *
 * Read from the catalogue's `nav` placement and nothing else. It names a place; it grants nothing — the page
 * still asks for its own authority. It never prints a screen code or a reference alias (CAIRN.md §19.5).
 */
export interface MenuPath {
  /** Labels from the top: module, category, activity, screen. Repeats are collapsed. */
  segments: string[];
  /** Where each segment's own page is, aligned with `segments`; null where there is none (the screen itself). */
  links: (string | null)[];
  /** The screen the path was read from; null on a module page. */
  screen: ScreenLink | null;
}

function collapse(entries: { label: string; href: string | null }[]): { label: string; href: string | null }[] {
  const out: { label: string; href: string | null }[] = [];
  for (const entry of entries) {
    const label = entry.label.trim();
    if (label === '') continue;
    if (out.length > 0 && out[out.length - 1].label.toLowerCase() === label.toLowerCase()) continue;
    out.push({ label, href: entry.href });
  }
  return out;
}

/** The catalogued screen an address belongs to: the screen itself, or the parent of a detail page. */
function owner(pathname: string, search: URLSearchParams): ScreenLink | null {
  const direct = matchScreen(pathname, search);
  if (direct) return direct;
  const path = pathname.length > 1 ? pathname.replace(/\/$/, '') : '/';
  const child = NAV_CHILD_ROUTES.find((route) => route.pattern.test(path));
  return child ? matchScreen(child.parent, new URLSearchParams()) : null;
}

/** The menu path for an address, or null when the address is not a catalogued screen (sign-in and the like). */
export function resolveMenuPath(pathname: string, search: URLSearchParams = new URLSearchParams()): MenuPath | null {
  // A module page lists a module's screens; it is not a screen, so it names only the module.
  if (pathname.replace(/\/$/, '') === '/menu') {
    const module = NAV_MODULES.find((m) => m.id === search.get('module'));
    return module ? { segments: [module.label], links: [null], screen: null } : null;
  }
  const screen = owner(pathname, search);
  if (!screen?.nav) return null;
  const nav = screen.nav;
  const label = NAV_MODULES.find((m) => m.id === nav.module)?.label ?? '';
  // The launchpad is the Dashboard itself: one label, not "Dashboard / Launchpad / Launchpad / Launchpad".
  if (nav.module === 'dashboard') return { segments: [label], links: [null], screen };
  const module = moduleHref(nav.module);
  const entries = collapse([
    { label, href: module },
    { label: nav.category, href: `${module}#${categorySlug(nav.category)}` },
    { label: nav.activity, href: `${module}#${categorySlug(nav.category)}` },
    { label: screen.title, href: null },
  ]);
  return { segments: entries.map((e) => e.label), links: entries.map((e) => e.href), screen };
}
