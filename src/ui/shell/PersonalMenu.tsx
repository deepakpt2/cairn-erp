'use client';

import Link from 'next/link';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { t } from '@/platform/i18n';
import type { NavModuleNode } from './nav-tree';
import {
  EMPTY_PERSONAL, parsePersonal, recordRecent, resolveEntries, serializePersonal, toggleFavourite,
  type PersonalNav, type ResolvedEntry,
} from './nav-personal';

/**
 * Favourites and recent screens at the top of the sidebar (navigation Stage 5).
 *
 * Kept in this browser only; see nav-personal.ts. What is shown is always looked up in the menu the server built
 * for this reader, so stored ids can never surface a screen the menu does not offer. Storage can be missing or
 * refused (private windows, blocked site data): every access is guarded and the menu works the same without it.
 */
export function PersonalMenu({ tree, storageKey, activeScreenId }: {
  tree: NavModuleNode[];
  storageKey: string;
  activeScreenId: string | null;
}) {
  const offered = useMemo(() => {
    const map = new Map<string, ResolvedEntry>();
    for (const m of tree) for (const c of m.categories) for (const a of c.activities) for (const i of a.items) {
      if (!map.has(i.id)) map.set(i.id, { id: i.id, title: i.title, href: i.href });
    }
    return map;
  }, [tree]);

  const [personal, setPersonal] = useState<PersonalNav>(EMPTY_PERSONAL);
  const [ready, setReady] = useState(false);

  const save = useCallback((next: PersonalNav) => {
    try { window.localStorage.setItem(storageKey, serializePersonal(next)); } catch { /* storage unavailable */ }
  }, [storageKey]);

  useEffect(() => {
    let loaded = EMPTY_PERSONAL;
    try { loaded = parsePersonal(window.localStorage.getItem(storageKey)); } catch { /* storage unavailable */ }
    setPersonal(loaded);
    setReady(true);
    const onStorage = (e: StorageEvent) => {
      if (e.key === storageKey) setPersonal(parsePersonal(e.newValue));
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, [storageKey]);

  // Opening an offered screen makes it the most recent.
  useEffect(() => {
    if (!ready || !activeScreenId || !offered.has(activeScreenId)) return;
    setPersonal((prev) => {
      const next = recordRecent(prev, activeScreenId);
      if (next !== prev) save(next);
      return next;
    });
  }, [ready, activeScreenId, offered, save]);

  if (!ready) return null;
  const favourites = resolveEntries(personal.favourites, offered);
  const recents = resolveEntries(personal.recents, offered).filter((r) => !personal.favourites.includes(r.id));
  const active = activeScreenId ? offered.get(activeScreenId) : undefined;
  const activeIsFavourite = active ? personal.favourites.includes(active.id) : false;

  const flip = (id: string) => setPersonal((prev) => {
    const next = toggleFavourite(prev, id);
    if (next !== prev) save(next);
    return next;
  });

  return (
    <div className="border-b border-line/60 pb-1 text-sm" data-testid="personal-menu">
      {active && (
        <button
          type="button"
          className="flex min-h-9 w-full items-center gap-2 px-2 text-start text-xs text-ink-soft hover:bg-paper"
          aria-pressed={activeIsFavourite}
          onClick={() => flip(active.id)}
        >
          <span aria-hidden>{activeIsFavourite ? '★' : '☆'}</span>
          <span className="truncate">{activeIsFavourite ? t('nav.favouriteRemove') : t('nav.favouriteAdd')}</span>
        </button>
      )}
      {favourites.length > 0 && (
        <section aria-label={t('nav.favourites')}>
          <h2 className="px-2 pt-1 text-2xs font-semibold uppercase tracking-wide text-ink-faint">{t('nav.favourites')}</h2>
          <ul>
            {favourites.map((e) => (
              <li key={e.id} className="flex items-stretch">
                <Link href={e.href} aria-current={e.id === activeScreenId ? 'page' : undefined} className={`min-h-8 min-w-0 flex-1 truncate py-1.5 ps-3 pe-1 hover:bg-paper ${e.id === activeScreenId ? 'font-medium text-ink' : 'text-ink-soft'}`}>{e.title}</Link>
                <button type="button" className="w-8 text-ink-faint hover:bg-paper" aria-label={t('nav.favouriteRemoveNamed', { name: e.title })} onClick={() => flip(e.id)}>
                  <span aria-hidden>×</span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}
      {recents.length > 0 && (
        <section aria-label={t('nav.recents')}>
          <h2 className="px-2 pt-1 text-2xs font-semibold uppercase tracking-wide text-ink-faint">{t('nav.recents')}</h2>
          <ul>
            {recents.map((e) => (
              <li key={e.id}>
                <Link href={e.href} aria-current={e.id === activeScreenId ? 'page' : undefined} className={`block min-h-8 truncate py-1.5 ps-3 pe-2 hover:bg-paper ${e.id === activeScreenId ? 'font-medium text-ink' : 'text-ink-soft'}`}>{e.title}</Link>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
