import Link from 'next/link';
import { t } from '@/platform/i18n';
import { searchRegistry, aliasesFor, coverageLabel } from '@/platform/registry';

export const dynamic = 'force-dynamic';

/**
 * Term registry — CAIRN.md §4.4.
 *
 * The one place external identifiers are shown, and always labelled as a lookup
 * courtesy. Someone who has used the reference product for twenty years can type
 * what they know and land on our screen; nobody is ever told a reference
 * identifier is one of ours (§19.5 AI-05).
 */
export default async function RegistryPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; miss?: string }>;
}) {
  const params = await searchParams;
  const query = params.q ?? '';
  const hits = await searchRegistry(query);
  const aliasMap = await aliasesFor(hits.map((h) => h.id));

  return (
    <div className="mx-auto max-w-4xl p-6">
      <header className="mb-4 border-b border-line pb-4">
        <span className="code text-ink-faint">PLT.REGISTRY.SEARCH</span>
        <h1 className="mt-0.5 text-xl font-semibold tracking-tight">{t('registry.title')}</h1>
        <p className="mt-1 max-w-3xl text-sm text-ink-soft">{t('registry.subtitle')}</p>
      </header>

      <form method="get" className="mb-4 flex gap-2">
        <input
          type="text"
          name="q"
          defaultValue={query}
          placeholder={t('registry.searchPlaceholder')}
          className="field-input flex-1"
          autoFocus
        />
        <button type="submit" className="btn btn-primary">
          {t('registry.search')}
        </button>
      </form>

      {params.miss === '1' && (
        <div className="mb-4 border border-signal-warn/30 bg-signal-warn-soft p-3">
          <p className="text-sm font-semibold text-signal-warn">
            {t('command.notFound', { term: query })}
          </p>
          <p className="mt-0.5 text-sm text-ink-soft">{t('command.notFoundHint')}</p>
        </div>
      )}

      {hits.length === 0 ? (
        <div className="panel p-8 text-center text-sm text-ink-soft">
          {t('registry.noResults')}
        </div>
      ) : (
        <div className="panel overflow-hidden">
          <div className="panel-header">
            <h2 className="panel-title">{t('registry.results')}</h2>
            <span className="text-2xs text-ink-faint">{hits.length}</span>
          </div>
          <table className="grid-table">
            <thead>
              <tr>
                <th className="w-56">Code</th>
                <th>Description</th>
                <th className="w-44">{t('registry.coverage')}</th>
                <th className="w-24" />
              </tr>
            </thead>
            <tbody>
              {hits.map((hit) => (
                <tr key={hit.id}>
                  <td>
                    <div className="code font-semibold">{hit.ourCode ?? hit.ourTable}</div>
                    <div className="text-2xs uppercase tracking-wide text-ink-faint">
                      {hit.termType.replace(/_/g, ' ').toLowerCase()}
                      {hit.conformanceTier ? ` · tier ${hit.conformanceTier}` : ''}
                    </div>
                  </td>
                  <td>
                    <div className="font-medium">{hit.title}</div>
                    {hit.description && (
                      <div className="text-sm text-ink-soft">{hit.description}</div>
                    )}
                    {aliasMap[hit.id]?.length > 0 && (
                      <div className="mt-1 text-2xs text-ink-faint">
                        {t('registry.aliases')}:{' '}
                        <span className="code">{aliasMap[hit.id].join(', ')}</span>
                      </div>
                    )}
                  </td>
                  <td>
                    <span
                      className={`chip ${
                        hit.coverageTier === 'TIER_1_BUILT'
                          ? 'chip-ok'
                          : hit.coverageTier === 'TIER_2_CONFIGURED'
                            ? 'chip-info'
                            : 'chip-neutral'
                      }`}
                    >
                      {coverageLabel(hit.coverageTier)}
                    </span>
                  </td>
                  <td className="text-end">
                    {hit.routePath && (
                      <Link href={hit.routePath} className="text-accent hover:underline">
                        Open
                      </Link>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="border-t border-line bg-sunken px-3 py-2 text-2xs text-ink-faint">
            {t('registry.aliasNote')}
          </p>
        </div>
      )}
    </div>
  );
}
