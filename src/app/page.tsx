import Link from 'next/link';
import { t } from '@/platform/i18n';
import { listTenants } from '@/platform/tenancy';
import { requireSession } from '@/platform/auth/current';

/**
 * Launchpad — CAIRN.md §19.3.
 *
 * Not a tile dashboard for its own sake: it shows what exists, what state it is
 * in, and the next step. Honest about scope, which matters more than looking full.
 */
export default async function LaunchpadPage() {
  const session = process.env.CAIRN_ENV === 'development' ? null : await requireSession('/');
  const allTenants = await listTenants();
  const tenants = session ? allTenants.filter((tenant) => tenant.client === session.user.client) : allTenants;

  const tiles = [
    {
      href: '/clients',
      code: 'CFG.PLT.CLIENT.DEFINE',
      title: t('nav.tenants'),
      body: t('tenants.subtitle'),
      meta: `${tenants.length} tenant${tenants.length === 1 ? '' : 's'}`,
    },
    {
      href: '/config',
      code: 'CFG.WORKBENCH',
      title: t('nav.workbench'),
      body: t('workbench.subtitle'),
      meta: '51 activities',
    },
    {
      href: '/inventory/materials', code: 'INV.MATERIAL.DISPLAY', title: t('nav.materials'),
      body: t('material.subtitle'), meta: t('launchpad.materialMeta'),
    },
    {
      href: '/config/number-ranges', code: 'CFG.PLT.NUMBERRANGE.DEFINE', title: t('nr.title'),
      body: t('nr.subtitle'), meta: t('launchpad.rangeMeta'),
    },
    {
      href: '/finance/journal', code: 'FIN.JOURNAL.DISPLAY', title: t('nav.journal'),
      body: t('journal.subtitle'), meta: t('launchpad.journalMeta'),
    },
    {
      href: '/registry',
      code: 'PLT.REGISTRY.SEARCH',
      title: t('nav.registry'),
      body: t('registry.subtitle'),
      meta: 'Search by code or alias',
    },
  ];

  return (
    <div className="mx-auto max-w-6xl p-6">
      <header className="mb-6 border-b border-line pb-4">
        <h1 className="text-xl font-semibold tracking-tight">{t('launchpad.title')}</h1>
        <p className="mt-1 max-w-3xl text-sm text-ink-soft">{t('launchpad.subtitle')}</p>
      </header>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {tiles.map((tile) => (
          <Link
            key={tile.href}
            href={tile.href}
            className="panel group flex flex-col p-4 transition-colors hover:border-accent-line hover:bg-accent-soft/20"
          >
            <span className="code text-ink-faint">{tile.code}</span>
            <span className="mt-2 text-base font-semibold tracking-tight group-hover:text-accent">
              {tile.title}
            </span>
            <span className="mt-1 flex-1 text-sm text-ink-soft">{tile.body}</span>
            <span className="mt-3 text-2xs uppercase tracking-wide text-ink-faint">
              {tile.meta}
            </span>
          </Link>
        ))}
      </div>

      <section className="panel mt-6 p-4">
        <div className="panel-header -m-4 mb-3 border-b">
          <h2 className="panel-title">{t('launchpad.status.title')}</h2>
          <span className="chip chip-ok">Live</span>
        </div>
        <p className="text-sm text-ink-soft">{t('launchpad.status.body')}</p>

        <ul className="mt-3 grid gap-1.5 text-sm sm:grid-cols-2">
          {[
            'Gap-free number ranges, allocation-proof under concurrency',
            'Advisory-lock enqueue with ordered acquisition and a contention log',
            'Document flow graph, status history and cross-class search index',
            'Field-level change documents with security-relevant flagging',
            'Posting engine with a database-enforced balance invariant',
            'Tenant isolation by row-level security — default deny',
          ].map((item) => (
            <li key={item} className="flex items-start gap-2">
              <span aria-hidden className="mt-1.5 h-1.5 w-1.5 shrink-0 bg-accent" />
              <span className="text-ink-soft">{item}</span>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
