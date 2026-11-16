import { hasCapability } from '@/platform/auth/session';
import { NAV_MODULES, SCREENS, type NavModule } from './screen-catalog';
import { menuScreenIds } from './menu-access';
import { namesReading } from './screen-access';
import { screenHref } from './screen-links';

/**
 * What the launchpad offers a reader to start with (navigation follow-up to Stage 7).
 *
 * Two kinds of thing, both decided from what the reader holds:
 *
 *  - Work: screens whose own code the reader holds and which change something (not the reading screens everyone
 *    sees). A buyer starts from purchasing, an accountant from posting, a planner from planning. Held through
 *    a role pattern counts the same as an exact grant. Configuration and administration screens are not work
 *    here; they are the setup tiles below.
 *  - Setup: the tenant, configuration workbench and number-range tiles, offered only to a reader who holds the
 *    authority behind them.
 *
 * Pure, server side. Like the menu, this can only show less than the pages allow; each page still checks its own
 * authority, and a reader who holds a full wildcard gets the setup tiles and the module list rather than an
 * arbitrary sample of every screen.
 */
export interface LaunchpadItem {
  id: string;
  title: string;
  href: string;
}

export interface LaunchpadWork {
  module: NavModule;
  label: string;
  items: LaunchpadItem[];
}

export type SetupTile = 'tenants' | 'workbench' | 'numberRanges';

export interface LaunchpadView {
  work: LaunchpadWork[];
  setup: SetupTile[];
}

const PER_MODULE = 5;

/** The verbs that start a piece of work come first; everything else keeps the catalogue's order. */
const STARTS_WORK = ['CREATE', 'POST', 'ENTER', 'RECEIVE', 'ISSUE', 'CONFIRM', 'RELEASE'];
const startsWork = (code: string) => (STARTS_WORK.includes(code.split('.').pop() ?? '') ? 0 : 1);

export function launchpadFor(capabilities: readonly string[]): LaunchpadView {
  const held = [...capabilities];
  const setup: SetupTile[] = [];
  if (hasCapability(held, 'CFG.PLT.CLIENT.DEFINE')) setup.push('tenants');
  if (held.some((c) => c === '*' || c.startsWith('CFG.'))) setup.push('workbench');
  if (hasCapability(held, 'CFG.PLT.NUMBERRANGE.DEFINE')) setup.push('numberRanges');

  if (held.includes('*')) return { work: [], setup };

  const offered = menuScreenIds(held);
  const labels = new Map(NAV_MODULES.map((m) => [m.id, m.label] as const));
  const byModule = new Map<NavModule, LaunchpadItem[]>();
  const ordered = SCREENS.map((screen, index) => ({ screen, index })).sort(
    (a, b) => startsWork(a.screen.code) - startsWork(b.screen.code) || a.index - b.index,
  );
  for (const { screen } of ordered) {
    const nav = screen.nav;
    if (!nav || screen.code === '' || !offered.has(screen.id)) continue;
    if (nav.module === 'dashboard' || nav.module === 'admin' || nav.category === 'Configuration') continue;
    if (namesReading(screen.code) || !hasCapability(held, screen.code)) continue;
    const list = byModule.get(nav.module) ?? [];
    if (list.length < PER_MODULE) list.push({ id: screen.id, title: screen.title, href: screenHref(screen) });
    byModule.set(nav.module, list);
  }
  const work = NAV_MODULES.filter((m) => byModule.has(m.id)).map((m) => ({
    module: m.id,
    label: labels.get(m.id) ?? m.id,
    items: byModule.get(m.id)!,
  }));
  return { work, setup };
}
