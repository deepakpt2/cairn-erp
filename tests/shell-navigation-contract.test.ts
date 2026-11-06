import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { SCREENS } from '@/ui/shell/screen-catalog';
import { resolveScreen, screenTerms } from '../src/app/registry/screen-terms';

const relatedScreens = readFileSync('src/ui/shell/RelatedScreens.tsx', 'utf8');
const scrollToTop = readFileSync('src/ui/shell/ScrollToTop.tsx', 'utf8');
const layout = readFileSync('src/app/layout.tsx', 'utf8');
const command = readFileSync('src/app/command.ts', 'utf8');
const registryPage = readFileSync('src/app/registry/page.tsx', 'utf8');
const screenTermsSource = readFileSync('src/app/registry/screen-terms.ts', 'utf8');

/**
 * Arriving on a screen: the page starts at its top, the chips say what they
 * mean, and the codes behind them are still findable in the registry.
 */
describe('shell navigation contract', () => {
  it('shows the screen name in the related strip, and no code beside it', () => {
    expect(relatedScreens).not.toContain('link.screen.code');
    expect(relatedScreens).toContain('{link.screen.title}');
    // The link itself is untouched: the name still goes where the code did.
    expect(relatedScreens).toContain('href={link.href}');
  });

  it('starts a new page at the top, and leaves back, forward and anchors alone', () => {
    expect(layout).toContain('<ScrollToTop />');
    expect(scrollToTop).toContain('usePathname()');
    expect(scrollToTop).toContain('window.scrollTo(');
    // Instant: this is an arrival, not a journey.
    expect(scrollToTop).toContain("behavior: 'auto'");
    // Going back to a list means going back to the row you were reading.
    expect(scrollToTop).toContain("addEventListener('popstate'");
    expect(scrollToTop).toContain('wasPop.current');
    // A link that names an anchor has already said where it wants to be.
    expect(scrollToTop).toContain('window.location.hash');
  });

  it('lists every screen code in the term registry', () => {
    expect(registryPage).toContain('screenTerms(query)');
    // Read from the catalogue, never restated.
    expect(screenTermsSource).toContain("from '@/ui/shell/screen-catalog'");
    expect(screenTermsSource).not.toContain("code: 'CFG.");
  });

  it('opens a screen when its code is typed into the command bar', () => {
    // Exact before ranking: a code is unambiguous.
    expect(command).toContain('resolveScreen(term) ?? (await resolveTerm(term))');
  });
});

describe('screen terms', () => {
  const coded = SCREENS.find((screen) => screen.code === 'CFG.FIN.COA.DEFINE');

  it('finds one screen by an exact code, whatever the case it was typed in', () => {
    expect(coded).toBeDefined();
    for (const typed of ['CFG.FIN.COA.DEFINE', 'cfg.fin.coa.define', '  CFG.FIN.COA.DEFINE  ']) {
      const hits = screenTerms(typed);
      expect(hits).toHaveLength(1);
      expect(hits[0]?.ourCode).toBe('CFG.FIN.COA.DEFINE');
      expect(hits[0]?.routePath).toBe(coded!.path);
      expect(hits[0]?.title).toBe(coded!.title);
    }
  });

  it('answers the command bar with that screen, and with nothing for a code it does not know', () => {
    expect(resolveScreen('CFG.FIN.COA.DEFINE')?.routePath).toBe(coded!.path);
    expect(resolveScreen('CFG.FIN.COA.DEFINE.NOPE')).toBeNull();
    expect(resolveScreen('')).toBeNull();
    expect(resolveScreen('chart of accounts')).toBeNull();
  });

  it('finds screens by their words, and offers everything when nothing was typed', () => {
    const byWord = screenTerms('chart of accounts');
    expect(byWord.length).toBeGreaterThan(0);
    expect(byWord.some((hit) => hit.ourCode === 'CFG.FIN.COA.DEFINE')).toBe(true);

    const all = screenTerms('');
    // Bounded, so listing the screens cannot bury the rest of the registry.
    expect(all).toHaveLength(50);
    expect(all.every((hit) => hit.termType === 'SCREEN')).toBe(true);
    // Alphabetical by code, so the list does not move between visits.
    const codes = all.map((hit) => hit.ourCode ?? '');
    expect([...codes].sort()).toEqual(codes);
  });

  it('returns nothing rather than guessing when the words match no screen', () => {
    expect(screenTerms('zzzz not a screen')).toEqual([]);
  });

  it('marks each hit as a screen with a route, in the registry’s own shape', () => {
    const [hit] = screenTerms('CFG.FIN.COA.DEFINE');
    expect(hit).toMatchObject({
      ourCode: 'CFG.FIN.COA.DEFINE',
      termType: 'SCREEN',
      routePath: coded!.path,
    });
    expect(hit?.id?.startsWith('screen:')).toBe(true);
  });
});
