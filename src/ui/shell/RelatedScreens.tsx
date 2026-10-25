'use client';

import Link from 'next/link';
import { usePathname, useSearchParams } from 'next/navigation';
import { t } from '@/platform/i18n';
import { relatedLinks, type RelatedLink } from './screen-links';

function ScreenLinkChip({ link }: { link: RelatedLink }) {
  return (
    <Link
      href={link.href}
      className="inline-flex max-w-full items-center gap-1 border border-line bg-surface px-2 py-1 text-xs text-ink hover:border-accent-line hover:bg-accent-soft focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent"
    >
      {link.screen.code ? <span className="code text-ink-faint">{link.screen.code}</span> : null}
      <span>{link.screen.title}</span>
    </Link>
  );
}

/**
 * Related screens for the page that is open.
 *
 * The strip is navigation only. Following a link does not post, confirm, or
 * start a run. The destination still asks before it writes.
 */
export function RelatedScreens() {
  const pathname = usePathname() || '/';
  const search = useSearchParams();
  if (pathname === '/signin') return null;

  const { links, more, indexHref } = relatedLinks(pathname, new URLSearchParams(search.toString()));

  return (
    <nav aria-label={t('nav.related')} data-screen-links className="border-b border-line bg-paper px-3 py-1.5 sm:px-4">
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="text-2xs uppercase tracking-wide text-ink-faint">{t('nav.related')}</span>
        {links.map((link) => <ScreenLinkChip key={link.screen.id} link={link} />)}
        {more.length > 0 && (
          <details className="border border-line bg-surface">
            <summary className="cursor-pointer px-2 py-1 text-xs text-ink-soft">{t('nav.moreScreens')}</summary>
            <div className="flex max-w-3xl flex-wrap gap-1.5 p-2">
              {more.map((link) => <ScreenLinkChip key={link.screen.id} link={link} />)}
            </div>
          </details>
        )}
        <Link href={indexHref} className="ms-auto text-xs text-accent hover:underline">
          {t('nav.allScreens')}
        </Link>
      </div>
    </nav>
  );
}
