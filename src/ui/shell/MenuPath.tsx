'use client';

import Link from 'next/link';
import { usePathname, useSearchParams } from 'next/navigation';
import { t } from '@/platform/i18n';
import { resolveMenuPath } from './menu-path';

/**
 * The menu path in the status bar — CAIRN.md §19.1 ("Status bar: menu path").
 *
 * Plain text unless `linkLevels` is set: the module and category levels only have a page of their own when the
 * sidebar navigation is on, and a link that goes nowhere is worse than none. The slash separator reads the same
 * in either text direction.
 */
export function MenuPath({ linkLevels = false }: { linkLevels?: boolean }) {
  const pathname = usePathname() || '/';
  const search = useSearchParams();
  const path = resolveMenuPath(pathname, new URLSearchParams(search.toString()));
  if (!path) return null;
  const last = path.segments.length - 1;

  return (
    <>
      <span className="text-line-strong" aria-hidden>
        |
      </span>
      <nav aria-label={t('status.menuPath')} className="min-w-0" data-testid="menu-path">
        <ol className="flex min-w-0 flex-wrap items-center gap-x-1.5 text-ink-soft">
          {path.segments.map((label, index) => {
            const href = path.links[index];
            const current = index === last;
            return (
              <li key={`${index}:${label}`} className="flex min-w-0 items-center gap-x-1.5">
                {index > 0 && <span className="text-line-strong" aria-hidden>/</span>}
                {linkLevels && href && !current ? (
                  <Link href={href} className="truncate underline-offset-2 hover:text-accent hover:underline">{label}</Link>
                ) : (
                  <span className={current ? 'truncate font-medium text-ink' : 'truncate'} aria-current={current ? 'page' : undefined}>
                    {label}
                  </span>
                )}
              </li>
            );
          })}
        </ol>
      </nav>
    </>
  );
}
