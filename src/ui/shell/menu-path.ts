import { NAV_CHILD_ROUTES, NAV_MODULES, type ScreenLink } from './screen-catalog';
import { matchScreen } from './screen-links';

/**
 * Where a page sits in the menu: module > category > activity > screen (navigation Stage 2).
 *
 * Read from the catalogue's `nav` placement and nothing else. It names a place; it grants nothing — the page
 * still asks for its own authority. It never prints a screen code or a reference alias (CAIRN.md §19.5).
 */
export interface MenuPath {
  /** Labels from the top: module, category, activity, screen. Repeats are collapsed. */
  segments: string[];
  /** The screen the path was read from. */
  screen: ScreenLink;
}

function collapse(labels: string[]): string[] {
  const out: string[] = [];
  for (const label of labels) {
    const clean = label.trim();
    if (clean === '') continue;
    if (out.length > 0 && out[out.length - 1].toLowerCase() === clean.toLowerCase()) continue;
    out.push(clean);
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
  const screen = owner(pathname, search);
  if (!screen?.nav) return null;
  const module = NAV_MODULES.find((m) => m.id === screen.nav!.module)?.label ?? '';
  // The launchpad is the Dashboard itself: one label, not "Dashboard / Launchpad / Launchpad / Launchpad".
  if (screen.nav.module === 'dashboard') return { segments: [module], screen };
  return { segments: collapse([module, screen.nav.category, screen.nav.activity, screen.title]), screen };
}
