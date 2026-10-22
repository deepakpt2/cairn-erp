import Link from 'next/link';

import { can, requireSession } from '@/platform/auth/current';
import { t } from '@/platform/i18n';
import {
  PHYSICAL_INVENTORY_COUNT_CAPABILITY,
  PHYSICAL_INVENTORY_COUNT_CORRECT_CAPABILITY,
  PHYSICAL_INVENTORY_COUNT_ROUTE,
  countNamedRefusal,
  getCountDocument,
  getCountHistory,
} from '@/modules/inventory/physical-inventory-count';
import { searchCountDocuments } from '@/modules/inventory/physical-inventory-count';
import CountWorkbench from './CountWorkbench';

export const dynamic = 'force-dynamic';

const ROUTE = PHYSICAL_INVENTORY_COUNT_ROUTE;

/**
 * Count entry — SCR-147 / MI04 (as a search alias only).
 *
 * A count records what a person saw. Nothing on this screen posts: no material document, no
 * journal, no stock. The difference it shows is arithmetic held for the difference review, and the
 * page says so rather than leaving it to be discovered.
 */
function one(value: string | string[] | undefined): string {
  return (Array.isArray(value) ? value[0] : value)?.trim() ?? '';
}

export default async function PhysicalInventoryCountPage({ searchParams }: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const session = await requireSession(ROUTE);
  const params = await searchParams;
  const client = session.user.client;
  const doc = one(params.doc);
  const yearText = one(params.year);
  const refusal = countNamedRefusal({
    batch: one(params.batch),
    serialNumber: one(params.serialNumber),
    handlingUnit: one(params.handlingUnit),
    bookQuantity: one(params.bookQuantity),
    differenceQuantity: one(params.differenceQuantity),
    companyCode: one(params.companyCode),
    countId: one(params.countId),
    post: one(params.post),
    countEvent: one(params.countEvent),
  });
  const year = Number(yearText) || null;
  const document = !refusal && doc && year
    ? await getCountDocument(client, { documentNumber: doc.toUpperCase(), fiscalYear: year })
    : null;
  const history = document
    ? await getCountHistory(client, {
      documentNumber: document.documentNumber, fiscalYear: document.fiscalYear,
    })
    : [];
  const documents = await searchCountDocuments(client);
  const today = new Date().toISOString().slice(0, 10);

  return (
    <div className="mx-auto max-w-6xl space-y-4 p-3 sm:p-4 lg:p-6">
      <header className="border-b border-line pb-4">
        <span className="code text-ink-faint">{t('mi04.code')}</span>
        <div className="mt-1 flex flex-wrap items-center justify-between gap-3">
          <h1 className="text-xl font-semibold tracking-tight">{t('mi04.title')}</h1>
          <div className="flex gap-2">
            <Link href="/inventory/physical-inventory" className="btn btn-default min-h-11 sm:min-h-8">
              {t('mi04.toDocuments')}
            </Link>
            {document && (
              <>
                <Link
                  href={`/inventory/physical-inventory-differences?executed=1&plantFrom=${encodeURIComponent(document.plant)}&fiscalYear=${document.fiscalYear}&documentFrom=${encodeURIComponent(document.documentNumber)}&documentTo=${encodeURIComponent(document.documentNumber)}&differenceExists=1`}
                  className="btn btn-default min-h-11 sm:min-h-8"
                  data-count-differences-link
                >
                  {t('mi04.toDifferences')}
                </Link>
                <Link
                  href={`/inventory/physical-inventory-recount?doc=${encodeURIComponent(document.documentNumber)}&year=${document.fiscalYear}`}
                  className="btn btn-default min-h-11 sm:min-h-8"
                  data-count-recount-link
                >
                  {t('mi20.toRecount')}
                </Link>
              </>
            )}
            <Link href="/" className="btn btn-default min-h-11 sm:min-h-8">{t('nav.launchpad')}</Link>
          </div>
        </div>
        <p className="mt-1 max-w-3xl text-sm text-ink-soft">{t('mi04.subtitle')}</p>
      </header>

      <section aria-labelledby="count-lookup" className="rounded-card border border-line bg-surface p-4 shadow-card">
        <h2 id="count-lookup" className="text-sm font-semibold">{t('mi04.lookupTitle')}</h2>
        <form method="get" action={ROUTE} className="mt-3 flex flex-wrap items-end gap-3">
          <label className="block">
            <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-ink-faint">{t('mi04.document')}</span>
            <input
              name="doc"
              className="input"
              placeholder={t('mi04.documentPlaceholder')}
              defaultValue={document?.documentNumber ?? doc}
              required
            />
          </label>
          <label className="block">
            <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-ink-faint">{t('mi04.fiscalYear')}</span>
            <input
              name="year"
              className="input w-28"
              inputMode="numeric"
              defaultValue={document?.fiscalYear ?? new Date().getUTCFullYear()}
              required
            />
          </label>
          <button type="submit" className="btn btn-default min-h-11 sm:min-h-8">{t('mi04.load')}</button>
        </form>

        {refusal && (
          <p role="status" data-count-refused className="mt-2 text-sm text-red-700">{refusal}</p>
        )}

        {doc && !refusal && !document && (
          <p role="status" className="mt-2 text-sm text-red-700">
            {t('mi04.notFound', { document: doc, year: yearText })}
          </p>
        )}

        {documents.length > 0 && (
          <div className="mt-3">
            <h3 className="text-xs font-medium uppercase tracking-wide text-ink-faint">{t('mi04.openDocuments')}</h3>
            <ul className="mt-1 flex flex-wrap gap-2 text-sm" data-count-documents>
              {documents.slice(0, 12).map((row) => (
                <li key={`${row.documentNumber}/${row.fiscalYear}`}>
                  <Link
                    className="link"
                    href={`${ROUTE}?doc=${encodeURIComponent(row.documentNumber)}&year=${row.fiscalYear}`}
                  >
                    {row.documentNumber} · {row.fiscalYear} · {row.status} · {row.counts.counted}/{row.counts.items}
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        )}
      </section>

      {document && (
        <CountWorkbench
          document={document}
          history={history}
          canCount={can(session, PHYSICAL_INVENTORY_COUNT_CAPABILITY)}
          canCorrect={can(session, PHYSICAL_INVENTORY_COUNT_CORRECT_CAPABILITY)}
          today={today}
        />
      )}
    </div>
  );
}
