import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { requireSession } from '@/platform/auth/current';
import { t } from '@/platform/i18n';
import { buildNavTree } from '@/ui/shell/nav-tree';
import { sidebarNavigationEnabled } from '@/ui/shell/nav-flag';
import { menuScreenIds } from '@/ui/shell/menu-access';

export const dynamic = 'force-dynamic';

/**
 * A module's page (navigation Stage 3): its screens grouped by category and activity.
 *
 * Rows, not tiles — CAIRN.md §19.2. Shown only when the sidebar navigation flag is on; otherwise there is no such
 * page. It lists what this reader may be offered and grants nothing: every screen asks for its own authority.
 */
export default async function ModulePage({ searchParams }: { searchParams: Promise<{ module?: string }> }) {
  if (!sidebarNavigationEnabled()) notFound();
  const session = await requireSession('/menu');
  const { module: id } = await searchParams;
  if (id === 'dashboard') redirect('/');
  const tree = buildNavTree(menuScreenIds(session.user.capabilities));
  const node = tree.find((m) => m.id === id);
  // A module that exists but holds nothing open to this reader is an empty page, not a missing one.
  if (!node && !['mm', 'pp', 'qm', 'fico', 'sd', 'hr', 'admin'].includes(id ?? '')) notFound();

  return (
    <div className="mx-auto max-w-5xl space-y-6 p-3 sm:p-4 lg:p-6">
      <header className="border-b border-line pb-4">
        <h1 className="text-xl font-semibold tracking-tight">{node?.label ?? id}</h1>
        <p className="mt-1 max-w-3xl text-sm text-ink-soft">{t('menuPage.subtitle')}</p>
      </header>
      {!node && <p role="status" className="text-sm text-ink-soft">{t('menuPage.empty')}</p>}
      {node?.categories.map((category) => (
        <section key={category.slug} id={category.slug} className="scroll-mt-24">
          <h2 className="flex items-baseline justify-between border-b border-line pb-1 text-sm font-semibold">
            <span>{category.name}</span>
            <span className="tabular text-2xs font-normal text-ink-faint">{category.count}</span>
          </h2>
          <div className="mt-2 grid gap-x-6 gap-y-4 sm:grid-cols-2">
            {category.activities.map((activity) => (
              <div key={activity.name}>
                <h3 className="text-2xs uppercase tracking-wide text-ink-faint">{activity.name}</h3>
                <ul className="mt-1">
                  {activity.items.map((leaf) => (
                    <li key={leaf.id}>
                      <Link href={leaf.href} className="flex min-h-9 items-center px-2 text-sm hover:bg-surface hover:text-accent">
                        {leaf.title}
                      </Link>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}
