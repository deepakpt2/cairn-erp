'use client';

import { useEffect, useRef } from 'react';
import { usePathname } from 'next/navigation';

/**
 * Starts each new page at the top — CAIRN.md §19.1.
 *
 * Reading a long list, then following a link to a shorter page, used to leave
 * you looking at the blank space below the new page: the scroll position came
 * with you, but the content did not. A new page is a new page; it should start
 * at its beginning.
 *
 * Two navigations keep their place. Back and forward restore where you were,
 * because going back to a list means going back to the row you were reading.
 * And a link that names an anchor has already said where it wants to be.
 */
export function ScrollToTop() {
  const pathname = usePathname();
  const wasPop = useRef(false);

  useEffect(() => {
    function onPop() {
      wasPop.current = true;
    }
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  useEffect(() => {
    if (wasPop.current) {
      wasPop.current = false;
      return;
    }
    if (window.location.hash !== '') return;
    // Instant, not smooth: this is an arrival, not a journey, and a reader who
    // has asked for less movement is not given any.
    window.scrollTo({ top: 0, left: 0, behavior: 'auto' });
  }, [pathname]);

  return null;
}
