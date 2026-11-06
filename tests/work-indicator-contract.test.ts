import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { isNavigationClick } from '../src/ui/shell/navigation-click';

const indicator = readFileSync('src/ui/shell/WorkIndicator.tsx', 'utf8');
const spinner = readFileSync('src/ui/shell/Spinner.tsx', 'utf8');
const judgement = readFileSync('src/ui/shell/navigation-click.ts', 'utf8');
const submitButton = readFileSync('src/ui/shell/SubmitButton.tsx', 'utf8');
const statusBar = readFileSync('src/ui/shell/StatusBar.tsx', 'utf8');
const commandBar = readFileSync('src/ui/shell/CommandBar.tsx', 'utf8');
const css = readFileSync('src/app/globals.css', 'utf8');
const locale = readFileSync('src/platform/i18n/index.ts', 'utf8');

/**
 * A click that took seconds to answer gave nothing away, so people pressed
 * again. These are the properties that stop that happening without making the
 * shell depend on client JavaScript: the idle status word is still rendered on
 * the server, and every link and button keeps working without it.
 */
describe('working-indicator contract', () => {
  it('keeps the server-rendered status word, so the no-JavaScript path is unchanged', () => {
    expect(indicator).toContain("t('status.ready')");
    expect(indicator).toContain("t('status.working')");
    expect(locale).toContain("'status.working': 'Working…'");
    // The status bar no longer hard-codes the word; it renders the indicator,
    // which renders the same word when nothing is outstanding.
    expect(statusBar).toContain('<WorkIndicator />');
    expect(statusBar).not.toContain('{t(\'status.ready\')}');
    expect(statusBar).toContain("const DEVELOPMENT_UI_BUILD_CODE = 'DEV-SCR022-DISTCHANNEL-DIVISION-20261014'");
  });

  it('announces the wait politely and hides the decoration from assistive technology', () => {
    expect(indicator).toContain('role="status"');
    expect(indicator).toContain('aria-live="polite"');
    expect(spinner).toContain('aria-hidden');
    expect(spinner).not.toContain('role=');
    // Pure markup and CSS: no client JavaScript, so a server component can use it.
    expect(spinner).not.toContain("'use client'");
  });

  it('waits for navigations only, and leaves every other click alone', () => {
    // The judgement lives on its own, where it can be checked case by case.
    for (const guard of [
      'event.defaultPrevented',
      'event.metaKey || event.ctrlKey || event.shiftKey || event.altKey',
      "anchor.target !== '_self'",
      "anchor.hasAttribute('download')",
      'anchor.dataset.noProgress !== undefined',
      "raw.startsWith('#')",
      'target.protocol.startsWith(\'http\')',
      'target.origin !== current.origin',
      'target.pathname === current.pathname && target.search === current.search',
    ]) {
      expect(judgement).toContain(guard);
    }
    // It decides from what it is given, and touches no global state of its own.
    expect(judgement).not.toContain('window.');
    // Capture, so the router has not taken the click away first.
    expect(indicator).toContain("addEventListener('click', onClick, true)");
    expect(indicator).toContain('isNavigationClick(event, anchor, window.location.href)');
  });

  it('stops when the page arrives, and stops anyway if it never does', () => {
    // The route committing is the end of the wait.
    expect(indicator).toContain('usePathname()');
    expect(indicator).toMatch(/useEffect\(\(\) => \{\s*setPending\(false\);[\s\S]*\}, \[pathname\]\)/);
    // A navigation that changes only the query keeps the pathname.
    expect(indicator).toContain('window.location.href !== startHref.current');
    // Nothing promises a page that is not coming.
    expect(indicator).toContain('const GIVE_UP_AFTER_MS = 12_000');
    expect(indicator).toContain('setTimeout(finish, GIVE_UP_AFTER_MS)');
    // Back, forward and a restored page are the end of the wait too.
    expect(indicator).toContain("addEventListener('popstate', finish)");
    expect(indicator).toContain("addEventListener('pageshow', finish)");
    // Every timer and listener is removed again.
    expect(indicator).toContain('clearInterval(poll)');
    expect(indicator).toContain('clearTimeout(giveUp)');
  });

  it('takes the submit button’s pending state from the form, not from a guess', () => {
    expect(submitButton).toContain("import { useFormStatus } from 'react-dom'");
    expect(submitButton).toContain('const { pending } = useFormStatus()');
    expect(submitButton).toContain('disabled={disabled || pending}');
    expect(submitButton).toContain('aria-busy={pending || undefined}');
    // The command bar’s Execute button was the one click in the shell with
    // nothing to show for itself.
    expect(commandBar).toContain('<SubmitButton');
    expect(commandBar).toContain("pendingLabel={t('command.executing')}");
    expect(locale).toContain("'command.executing': 'Executing'");
  });

  it('defines the motion, and offers a still alternative to readers who ask for one', () => {
    expect(css).toContain('.spinner {');
    expect(css).toContain('animation: cairn-spin 0.7s linear infinite');
    expect(css).toContain('.route-progress {');
    expect(css).toContain('@keyframes cairn-spin');
    expect(css).toContain('@keyframes cairn-progress');
    // Right-to-left runs the bar the other way (R-19).
    expect(css).toContain("[dir='rtl'] .route-progress::after");
    expect(css).toContain('@keyframes cairn-progress-rtl');
    // Reduced motion keeps the reassurance and drops the movement.
    expect(css).toContain('@media (prefers-reduced-motion: reduce)');
    expect(css).toContain('animation: cairn-pulse 1.4s ease-in-out infinite');
    expect(css).toContain('@keyframes cairn-pulse');
  });
});

/**
 * The judgement itself, away from the browser: the helper takes the click, the
 * link and the address we are on, so each case can be stated plainly.
 */
describe('navigation-click judgement', () => {
  const HERE = 'http://cairn.test/finance/journal?company=1000';

  function click(overrides: Partial<{
    defaultPrevented: boolean;
    button: number;
    metaKey: boolean;
    ctrlKey: boolean;
    shiftKey: boolean;
    altKey: boolean;
  }> = {}) {
    return {
      defaultPrevented: false,
      button: 0,
      metaKey: false,
      ctrlKey: false,
      shiftKey: false,
      altKey: false,
      ...overrides,
    };
  }

  function link(href: string, overrides: {
    target?: string;
    download?: boolean;
    noProgress?: boolean;
    raw?: string | null;
  } = {}) {
    return {
      href,
      target: overrides.target ?? '',
      hasAttribute: (name: string) => (name === 'download' ? Boolean(overrides.download) : false),
      getAttribute: (name: string) => (name === 'href' ? (overrides.raw === undefined ? href : overrides.raw) : null),
      dataset: overrides.noProgress ? { noProgress: '' } : {},
    };
  }

  it('waits for an ordinary link to another page', () => {
    expect(isNavigationClick(click(), link('http://cairn.test/sales/orders'), HERE)).toBe(true);
  });

  it('waits for a navigation that changes only the query, as filters and paging do', () => {
    expect(isNavigationClick(click(), link('http://cairn.test/finance/journal?company=2000'), HERE)).toBe(true);
  });

  it('does not wait for the page already being read', () => {
    expect(isNavigationClick(click(), link(HERE), HERE)).toBe(false);
  });

  it('does not wait when the click opens somewhere else', () => {
    const elsewhere = link('http://cairn.test/sales/orders', { target: '_blank' });
    for (const modification of [
      { metaKey: true },
      { ctrlKey: true },
      { shiftKey: true },
      { altKey: true },
      { button: 1 },
    ]) {
      expect(isNavigationClick(click(modification), link('http://cairn.test/sales/orders'), HERE)).toBe(false);
    }
    expect(isNavigationClick(click(), elsewhere, HERE)).toBe(false);
  });

  it('does not wait for a download, an in-page jump, or a link that is not a page', () => {
    expect(isNavigationClick(click(), link('http://cairn.test/report.csv', { download: true }), HERE)).toBe(false);
    expect(isNavigationClick(click(), link('http://cairn.test/finance/journal#lines', { raw: '#lines' }), HERE)).toBe(false);
    expect(isNavigationClick(click(), link('mailto:clerk@example.test'), HERE)).toBe(false);
    expect(isNavigationClick(click(), link('tel:+971500000000'), HERE)).toBe(false);
    expect(isNavigationClick(click(), link('http://cairn.test/sales/orders', { raw: null }), HERE)).toBe(false);
  });

  it('does not wait for another site, whose answer it cannot know', () => {
    expect(isNavigationClick(click(), link('http://elsewhere.test/sales/orders'), HERE)).toBe(false);
  });

  it('does not wait when another handler has already answered, or the link opts out', () => {
    expect(isNavigationClick(click({ defaultPrevented: true }), link('http://cairn.test/sales/orders'), HERE)).toBe(false);
    expect(isNavigationClick(click(), link('http://cairn.test/sales/orders', { noProgress: true }), HERE)).toBe(false);
  });
});
