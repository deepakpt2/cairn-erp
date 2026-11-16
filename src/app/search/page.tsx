import Link from 'next/link';
import { notFound } from 'next/navigation';
import { requireSession } from '@/platform/auth/current';
import { t } from '@/platform/i18n';
import { searchRegistry } from '@/platform/registry';
import { sidebarNavigationEnabled } from '@/ui/shell/nav-flag';
import { menuScreenIds } from '@/ui/shell/menu-access';
import { searchNav, type AliasHit } from '@/ui/shell/nav-search';

export const dynamic = 'force-dynamic';

/**
 * Search the menu (navigation Stage 4), behind the sidebar flag.
 *
 * Results are the screens this reader may be offered, grouped by module. A reference transaction code typed here
 * is looked up in the term registry's aliases; the screen it leads to is shown with the alias it was found by,
 * labelled as an alias. Finding a screen grants nothing — the page asks for its own authority.
 */
export default async function SearchPage({ searchParams }: { searchParams: Promise<{ q?: string }> }) {
  if (!sidebarNavigationEnabled()) notFound();
  const session = await requireSession('/search');
  const q = ((await searchParams).q ?? '').trim().slice(0, 100);
  let aliasHits: AliasHit[] = [];
  if (q) {
    const hits = await searchRegistry(q, 20);
    aliasHits = hits
      .filter((h) => h.matchedOn === 'ALIAS' && h.routePath && h.matchedTerm)
      .map((h) => ({ routePath: h.routePath as string, alias: h.matchedTerm as string }));
  }
  const groups = searchNav(q, menuScreenIds(session.user.capabilities), aliasHits);

  return (
    <div className="mx-auto max-w-5xl space-y-6 p-3 sm:p-4 lg:p-6">
      <header className="border-b border-line pb-4">
        <h1 className="text-xl font-semibold tracking-tight">{t('search.title')}</h1>
        <form action="/search" method="get" role="search" className="mt-3 flex max-w-xl gap-2">
          <label htmlFor="menu-search" className="sr-only">{t('search.label')}</label>
          <input id="menu-search" name="q" type="search" defaultValue={q} maxLength={100} autoComplete="off" className="min-w-0 flex-1" placeholder={t('search.placeholder')} />
          <button type="submit" className="btn btn-default">{t('search.submit')}</button>
        </form>
      </header>
      {q === '' && <p role="status" className="text-sm text-ink-soft">{t('search.prompt')}</p>}
      {q !== '' && groups.length === 0 && <p role="status" className="text-sm text-ink-soft">{t('search.none', { q })}</p>}
      {groups.map((group) => (
        <section key={group.module} aria-labelledby={`g-${group.module}`}>
          <h2 id={`g-${group.module}`} className="flex items-baseline justify-between border-b border-line pb-1 text-sm font-semibold">
            <span>{group.label}</span>
            <span className="tabular text-2xs font-normal text-ink-faint">{group.results.length}</span>
          </h2>
          <ul className="mt-2 divide-y divide-line">
            {group.results.map((r) => (
              <li key={r.id} className="py-2">
                <Link href={r.href} className="text-sm font-medium text-accent hover:underline">{r.title}</Link>
                {r.alias && (
                  <span className="ms-2 border border-line px-1 text-2xs text-ink-soft">{t('search.alias', { alias: r.alias })}</span>
                )}
                <div className="text-xs text-ink-faint">{r.where}</div>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}
