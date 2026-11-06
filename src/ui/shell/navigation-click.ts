/**
 * Whether a click will take the reader somewhere they have to wait for.
 *
 * This is the whole of the judgement, kept apart from the component and from the
 * browser so it can be checked on its own: it takes the click, the link and the
 * address we are on, and answers yes or no. It touches no global state.
 *
 * Everything that cannot end in a wait is let through untouched — a new tab or
 * window, a download, an address on another site, an in-page jump, a mail or
 * telephone link, a click another handler has already dealt with, and a link to
 * the page already being read. Those are somebody else's business, and a
 * spinner that promises a page which is not coming is worse than none.
 */
export function isNavigationClick(
  event: {
    defaultPrevented: boolean;
    button: number;
    metaKey: boolean;
    ctrlKey: boolean;
    shiftKey: boolean;
    altKey: boolean;
  },
  anchor: {
    target: string;
    href: string;
    hasAttribute: (name: string) => boolean;
    getAttribute: (name: string) => string | null;
    dataset: Record<string, string | undefined>;
  },
  currentUrl: string,
): boolean {
  // Another handler has already answered this click.
  if (event.defaultPrevented) return false;
  // A modified click opens something else; this page stays exactly as it is.
  if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return false;
  if (anchor.target && anchor.target !== '_self') return false;
  if (anchor.hasAttribute('download')) return false;
  // An escape hatch for links that answer for themselves.
  if (anchor.dataset.noProgress !== undefined) return false;

  const raw = anchor.getAttribute('href');
  if (!raw || raw.startsWith('#')) return false;

  let target: URL;
  let current: URL;
  try {
    // `anchor.href` is always absolute, which is why this is read rather than
    // the raw attribute: a relative href is resolved for us.
    target = new URL(anchor.href);
    current = new URL(currentUrl);
  } catch {
    return false;
  }

  // mailto:, tel: and their like — nothing to wait for.
  if (!target.protocol.startsWith('http')) return false;
  // Another site: we cannot know when it answers, so we promise nothing.
  if (target.origin !== current.origin) return false;
  // The same page — the router has nothing to fetch.
  if (target.pathname === current.pathname && target.search === current.search) return false;

  return true;
}
