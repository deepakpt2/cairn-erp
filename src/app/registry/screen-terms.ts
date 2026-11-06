import { SCREENS, type ScreenLink } from '@/ui/shell/screen-catalog';
import type { RegistryHit } from '@/platform/registry';

/**
 * Screens, in the shape the term registry already speaks.
 *
 * Every screen carries a code of its own — CFG.FIN.COA.DEFINE and the rest. The
 * chips in the related-screens strip no longer print it, because the name is
 * what a reader is looking for; the code is what a machine, or a reader who
 * already knows it, types. So the code has to stay findable, and the place to
 * find a code is the registry: list it here and it is listed there, and the
 * command bar will open the screen for anyone who types it.
 *
 * The catalogue is the single source — nothing is restated here, only read.
 */

const AREA_LABEL: Record<string, string> = {
  platform: 'Platform',
  foundation: 'Foundation',
  configuration: 'Configuration',
  inventory: 'Inventory',
  purchasing: 'Purchasing',
  production: 'Production',
  sales: 'Sales',
  finance: 'Finance',
  quality: 'Quality',
  controlling: 'Controlling',
  people: 'People',
};

function toHit(screen: ScreenLink): RegistryHit {
  return {
    id: `screen:${screen.id}`,
    ourCode: screen.code === '' ? null : screen.code,
    ourTable: null,
    title: screen.title,
    termType: 'SCREEN',
    module: AREA_LABEL[screen.area] ?? screen.area,
    description: `Screen at ${screen.path}`,
    coverageTier: 'TIER_1_BUILT',
    routePath: screen.path,
    conformanceTier: null,
    matchedOn: 'OUR_CODE',
  };
}

function haystack(screen: ScreenLink): string {
  return `${screen.code} ${screen.title} ${screen.path} ${screen.area} ${screen.family}`.toLowerCase();
}

/**
 * Screens answering a typed term.
 *
 * An exact code wins outright — a code is unambiguous, and anyone who has typed
 * one means that screen. Otherwise the words are matched against the code, the
 * title, the path and the area, and the remainder falls back to alphabetical
 * order so the list is stable between keystrokes.
 */
export function screenTerms(query: string, limit = 50): RegistryHit[] {
  const needle = query.trim().toLowerCase();
  const exact = needle === '' ? [] : SCREENS.filter((screen) => screen.code.toLowerCase() === needle);
  if (exact.length > 0) return exact.map(toHit);

  const matched = needle === ''
    ? [...SCREENS]
    : SCREENS.filter((screen) => haystack(screen).includes(needle));

  return matched
    .slice()
    .sort(
      (left, right) =>
        left.code.localeCompare(right.code) || left.title.localeCompare(right.title),
    )
    .slice(0, limit)
    .map(toHit);
}

/** The one screen a code names, for the command bar. Null when nothing names it. */
export function resolveScreen(term: string): RegistryHit | null {
  const needle = term.trim().toLowerCase();
  if (needle === '') return null;
  const screen = SCREENS.find((entry) => entry.code.toLowerCase() === needle);
  return screen ? toHit(screen) : null;
}
