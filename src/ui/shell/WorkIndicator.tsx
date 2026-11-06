'use client';

import { useEffect, useRef, useState } from 'react';
import { usePathname } from 'next/navigation';
import { t } from '@/platform/i18n';
import { Spinner } from './Spinner';
import { isNavigationClick } from './navigation-click';

/**
 * The status word, and a thin bar at the top of the viewport, while a click is
 * being answered — CAIRN.md §19.1.
 *
 * A screen that takes a few seconds to load gave nothing away: the click looked
 * like it had been missed, and people pressed again. This says the click landed
 * and the answer is on its way.
 *
 * It is an addition, never a dependency. Nothing here is needed to use the app:
 * the idle word is rendered on the server exactly as it was before, so with no
 * client JavaScript at all the status bar still reads "Ready" and every link and
 * button keeps working as it always did. Only the reassurance is missing.
 */

/** How long to wait for the new page before assuming it is never coming. */
const GIVE_UP_AFTER_MS = 12_000;
/** How often to look at the address, for navigations that keep the pathname. */
const POLL_MS = 150;

export function WorkIndicator() {
  const pathname = usePathname();
  const [pending, setPending] = useState(false);
  const startHref = useRef<string | null>(null);

  // Capture, so this runs before the router has taken the click away.
  useEffect(() => {
    function onClick(event: MouseEvent) {
      const target = event.target as Element | null;
      const anchor = target?.closest?.('a[href]') as HTMLAnchorElement | null;
      if (!anchor || !isNavigationClick(event, anchor, window.location.href)) return;
      startHref.current = window.location.href;
      setPending(true);
    }
    document.addEventListener('click', onClick, true);
    return () => document.removeEventListener('click', onClick, true);
  }, []);

  // The route committed, so the wait is over.
  useEffect(() => {
    setPending(false);
    startHref.current = null;
  }, [pathname]);

  useEffect(() => {
    if (!pending) return;

    function finish() {
      setPending(false);
      startHref.current = null;
    }

    // A navigation that changes only the query keeps the pathname, so the
    // address is watched as well: filters and paging wait like anything else.
    const poll = setInterval(() => {
      if (startHref.current && window.location.href !== startHref.current) finish();
    }, POLL_MS);
    // Nothing waits forever. If the answer never comes, the indicator stops
    // rather than promising a page that is not on its way.
    const giveUp = setTimeout(finish, GIVE_UP_AFTER_MS);

    window.addEventListener('popstate', finish);
    window.addEventListener('pageshow', finish);
    return () => {
      clearInterval(poll);
      clearTimeout(giveUp);
      window.removeEventListener('popstate', finish);
      window.removeEventListener('pageshow', finish);
    };
  }, [pending]);

  return (
    <>
      <span role="status" aria-live="polite" className="inline-flex items-center gap-1.5">
        {pending ? (
          <>
            <Spinner />
            {t('status.working')}
          </>
        ) : (
          t('status.ready')
        )}
      </span>
      {pending ? <div className="route-progress" aria-hidden data-testid="route-progress" /> : null}
    </>
  );
}
