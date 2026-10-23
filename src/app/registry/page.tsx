import Link from 'next/link';
import { t } from '@/platform/i18n';
import { searchRegistry, coverageLabel, type RegistryHit } from '@/platform/registry';
import { RegistrySearch } from './RegistrySearch';

export const dynamic = 'force-dynamic';

/**
 * Term registry — CAIRN.md §4.4.
 *
 * The one place external identifiers are shown, and always labelled as a lookup
 * courtesy. Someone who has used the reference product for twenty years can type
 * what they know and land on our screen; nobody is ever told a reference
 * identifier is one of ours (§19.5 AI-05).
 *
 * The search box suggests as you type. Submitting the form still works without
 * JavaScript, and uses the same ranking.
 */
export default async function RegistryPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; miss?: string }>;
}) {
  const params = await searchParams;
  const query = params.q ?? '';
  const hits = await searchRegistry(query);

  return (
    <div className="mx-auto max-w-4xl p-6">
      <header className="mb-4 border-b border-line pb-4">
        <span className="code text-ink-faint">PLT.REGISTRY.SEARCH</span>
        <h1 className="mt-0.5 text-xl font-semibold tracking-tight">{t('registry.title')}</h1>
        <p className="mt-1 max-w-3xl text-sm text-ink-soft">{t('registry.subtitle')}</p>
      </header>

      <RegistrySearch key={query} initialQuery={query} />

      {params.miss === '1' && (
        <div className="mb-4 border border-signal-warn/30 bg-signal-warn-soft p-3">
          <p className="text-sm font-semibold text-signal-warn">
            {t('command.notFound', { term: query })}
          </p>
          <p className="mt-0.5 text-sm text-ink-soft">{t('command.notFoundHint')}</p>
        </div>
      )}

      {query && hits[0]?.matchKind === 'NEAREST' && (
        <p className="mb-3 text-sm text-ink-soft">{t('registry.suggest.nearestNote')}</p>
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
                <th className="w-56">{t('registry.column.code')}</th>
                <th>{t('registry.column.description')}</th>
                <th className="w-44">{t('registry.coverage')}</th>
                <th className="w-24" />
              </tr>
            </thead>
            <tbody>
              {hits.map((hit) => {
                const reason = matchLabel(hit);
                return (
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
                      {hit.aliases && hit.aliases.length > 0 && (
                        <div className="mt-1 text-2xs text-ink-faint">
                          {t('registry.aliases')}:{' '}
                          <span className="code">{hit.aliases.join(', ')}</span>
                        </div>
                      )}
                      {query && reason && (
                        <div className="mt-1 text-2xs uppercase tracking-wide text-ink-faint">{reason}</div>
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
                          {t('registry.open')}
                        </Link>
                      )}
                    </td>
                  </tr>
                );
              })}
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

function matchLabel(hit: RegistryHit): string | null {
  if (!hit.matchField || !hit.matchKind) return null;
  const kind = t(hit.matchKind === 'NEAREST' ? 'registry.suggest.nearest' : 'registry.suggest.matched');
  const field = t(hit.matchField === 'ALIAS' ? 'registry.aliases' : `registry.suggest.field.${hit.matchField}`);
  const alias = hit.matchField === 'ALIAS' && hit.matchedText ? ` ${hit.matchedText}` : '';
  return `${kind} · ${field}${alias}`;
}
