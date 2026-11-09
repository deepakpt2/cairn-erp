import Link from 'next/link';

import { requireSession } from '@/platform/auth/current';
import {
  INCOMPLETION_PROCESS_CAPABILITY, listIncompleteDocuments,
} from '@/modules/sales/incompletion';

export const dynamic = 'force-dynamic';

const ROUTE = '/sales/incomplete';

/**
 * The worklist of incomplete documents — SAP's V.02.
 *
 * An entry carries the field, the line and the screen the field is entered on, so the list is not a
 * report to be read but a set of links to be followed, which is the only shape in which a worklist
 * gets worked.
 */
export default async function IncompleteDocumentsPage() {
  const session = await requireSession(ROUTE);
  const documents = await listIncompleteDocuments(session.user.client);

  return (
    <main className="mx-auto max-w-6xl space-y-4 p-3 sm:p-4 lg:p-6">
      <header className="border-b border-line pb-4">
        <span className="code text-ink-faint">{INCOMPLETION_PROCESS_CAPABILITY} · SD</span>
        <div className="mt-1 flex flex-wrap items-center justify-between gap-3">
          <h1 className="text-xl font-semibold tracking-tight">Incomplete documents</h1>
          <Link href="/" className="btn btn-default min-h-11 sm:min-h-8">Launchpad</Link>
        </div>
        <p className="mt-1 max-w-3xl text-sm text-ink-soft">
          Every order and delivery that stands and is missing something its procedure says it must
          carry. A document is incomplete when it has log entries, and blocked for a function when an
          entry that is not a warning names a status group that stops it. Filling the field in and
          saving the document takes the entry with it: the log is what stands now, not what stood
          the last time the document was judged.
        </p>
        {documents.length === 0 && (
          <p role="status" className="mt-3 border border-line bg-surface p-3 text-sm text-ink-soft">
            Nothing is incomplete. Either no document is missing anything, or no document type has
            been assigned an incompletion procedure yet.
          </p>
        )}
      </header>

      {documents.length > 0 && (
        <section aria-labelledby="incomplete" className="border border-line bg-surface p-4">
          <h2 id="incomplete" className="text-sm font-semibold">
            {documents.length} document{documents.length === 1 ? '' : 's'} standing incomplete
          </h2>
          <div className="mt-3 space-y-4">
            {documents.map((document) => (
              <article
                key={`${document.documentCategory}/${document.documentNumber}`}
                className="border border-line p-3"
              >
                <div className="flex flex-wrap items-baseline justify-between gap-3">
                  <h3 className="text-sm font-semibold">
                    {document.documentCategory === 'ORDER' ? 'Sales order' : 'Delivery'}{' '}
                    <span className="font-mono">{document.documentNumber}</span>
                    <span className="ml-2 font-normal text-ink-faint">
                      {document.documentType} · {document.documentDate}
                    </span>
                  </h3>
                  <p className="text-sm text-ink-soft">
                    <span className="font-mono">{document.customerNumber}</span>
                    {' · '}
                    {document.missing} missing
                    {document.blocking > 0 ? (
                      <span className="text-red-700"> · {document.blocking} stopping something</span>
                    ) : (
                      <span> · {document.blocking} stopping anything</span>
                    )}
                  </p>
                </div>
                <table className="grid-table mt-2 text-left text-sm">
                  <thead>
                    <tr className="text-xs uppercase tracking-wide text-ink-faint">
                      <th>Line</th>
                      <th>What is missing</th>
                      <th>Consequence</th>
                      <th>Filled in at</th>
                    </tr>
                  </thead>
                  <tbody>
                    {document.entries.map((entry) => (
                      <tr key={`${entry.tableName}.${entry.fieldName}/${entry.lineNumber}`}>
                        <td className="font-mono">
                          {entry.lineNumber > 0
                            ? entry.lineNumber
                            : entry.partnerFunction || 'header'}
                        </td>
                        <td>{entry.name}</td>
                        <td className="text-ink-soft">
                          {entry.isWarning ? 'Recorded only' : `${entry.statusGroup}`}
                        </td>
                        <td>
                          <Link
                            href={entry.screen}
                            className="btn btn-default min-h-11 sm:min-h-8"
                          >
                            {entry.screen}
                          </Link>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </article>
            ))}
          </div>
          <p className="mt-3 max-w-3xl text-xs text-ink-faint">
            What a consequence means is maintained at{' '}
            <Link href="/config/incompletion" className="underline">/config/incompletion</Link>, where
            a status group names the functions a missing field stops.
          </p>
        </section>
      )}
    </main>
  );
}
