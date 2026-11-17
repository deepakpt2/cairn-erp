import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { NAV_MODULES, SCREENS, type NavModule } from '@/ui/shell/screen-catalog';
import { visibleScreenIds } from '@/ui/shell/screen-access';

/**
 * Navigation metadata contract (Stage 1 of the navigation modernization).
 *
 * The metadata places a screen in the menu; it never decides who may open it. These cases pin that every
 * catalogue entry has exactly one primary home, that the homes are well formed, that the hierarchy is the
 * approved one, and that no reference-product identifier leaks into a menu label (CAIRN.md §19.5 AI-05).
 */
const MODULE_IDS = new Set<NavModule>(NAV_MODULES.map((m) => m.id));

/** The approved distribution of primary homes. A change here is a change to the approved tree. */
const APPROVED_COUNTS: Record<NavModule, number> = {
  dashboard: 1, mm: 94, pp: 38, qm: 2, fico: 106, sd: 30, hr: 10, admin: 25,
};

describe('screen navigation metadata', () => {
  it('gives every catalogue entry exactly one primary home', () => {
    const missing = SCREENS.filter((s) => !s.nav).map((s) => s.id);
    expect(missing, `entries with no nav: ${missing.join(', ')}`).toEqual([]);
  });

  it('uses only known modules and non-empty category and activity names', () => {
    for (const s of SCREENS) {
      const nav = s.nav!;
      expect(MODULE_IDS.has(nav.module), `${s.id}: module ${nav.module}`).toBe(true);
      expect(nav.category.trim(), `${s.id}: category`).not.toBe('');
      expect(nav.activity.trim(), `${s.id}: activity`).not.toBe('');
    }
  });

  it('matches the approved distribution of screens over modules', () => {
    const counts: Record<string, number> = {};
    for (const s of SCREENS) counts[s.nav!.module] = (counts[s.nav!.module] ?? 0) + 1;
    expect(counts).toEqual(APPROVED_COUNTS);
    expect(Object.values(counts).reduce((a, b) => a + b, 0)).toBe(SCREENS.length);
  });

  it('puts only the launchpad under Dashboard', () => {
    expect(SCREENS.filter((s) => s.nav!.module === 'dashboard').map((s) => s.id)).toEqual(['/']);
  });

  it('keeps extra contexts distinct from the primary home and from each other', () => {
    for (const s of SCREENS) {
      const seen = new Set([`${s.nav!.module}|${s.nav!.category}|${s.nav!.activity}`]);
      for (const p of s.nav!.also ?? []) {
        expect(MODULE_IDS.has(p.module), `${s.id}: also module`).toBe(true);
        const key = `${p.module}|${p.category}|${p.activity}`;
        expect(seen.has(key), `${s.id}: repeated placement ${key}`).toBe(false);
        seen.add(key);
      }
    }
  });

  it('offers business partners from finance first, with MM and SD as contexts', () => {
    const general = SCREENS.find((s) => s.id === '/foundation/partners' && s.code === 'FND.PARTNER.DISPLAY')!;
    expect(general.nav!.module).toBe('fico');
    expect(general.nav!.also!.map((p) => p.module).sort()).toEqual(['mm', 'sd']);
  });

  it('places quality inspection under its own module', () => {
    expect(SCREENS.filter((s) => s.family === 'quality-inspection').every((s) => s.nav!.module === 'qm')).toBe(true);
  });

  it('keeps every configuration screen under a Configuration-type home, never a flat bucket', () => {
    for (const s of SCREENS.filter((x) => x.area === 'configuration')) {
      expect(s.nav!.module, s.id).not.toBe('dashboard');
    }
    const perModule = new Set(SCREENS.filter((x) => x.area === 'configuration').map((x) => x.nav!.module));
    expect([...perModule].sort()).toEqual(['admin', 'fico', 'hr', 'mm', 'pp', 'sd']);
  });

  it('puts no reference-product identifier in a menu label (AI-05)', () => {
    // A reference transaction code is two letters and two digits and an optional letter or digit: ME21N, MD04, FB50.
    const tcode = /\b[A-Z]{2}\d{2}[A-Z0-9]?\b/;
    for (const s of SCREENS) {
      const labels = [s.nav!.category, s.nav!.activity, ...(s.nav!.also ?? []).flatMap((p) => [p.category, p.activity]), ...(s.nav!.keywords ?? [])];
      for (const label of labels) expect(label, `${s.id}: "${label}"`).not.toMatch(tcode);
    }
  });

  it('changes nothing about who is offered a screen', () => {
    // Placement is metadata. The permission filter decides from the catalogue's code alone and must never read `nav`.
    const access = readFileSync('src/ui/shell/screen-access.ts', 'utf8');
    expect(access).not.toMatch(/\.nav\b/);
    expect(access).toContain('hasCapability(held, screen.code)');
    // A reader who holds nothing is still offered the launchpad, whatever its placement.
    expect(visibleScreenIds([]).has('/')).toBe(true);
  });
});
