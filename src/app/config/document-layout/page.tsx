import Link from 'next/link';

import { can, requireSession } from '@/platform/auth/current';
import {
  DOCUMENT_LAYOUT_CAPABILITY,
  DOCUMENT_LAYOUT_ROUTE,
  listDocumentLayouts,
} from '@/modules/output/document-layout';
import { DocumentLayoutForm } from './DocumentLayoutForm';

export const dynamic = 'force-dynamic';

/**
 * Document layout — SE78 / SE71 as search aliases only.
 *
 * One letterhead per company code: the logo, the header and footer text and overrides of the company
 * code's own name and address. The preview below the form is HTML and CSS, the same markup the print
 * stylesheet targets; no PDF is built on this screen.
 */
export default async function DocumentLayoutPage({ searchParams }: {
  searchParams: Promise<{ company?: string }>;
}) {
  const session = await requireSession(DOCUMENT_LAYOUT_ROUTE);
  const params = await searchParams;
  const allowed = can(session, DOCUMENT_LAYOUT_CAPABILITY);
  const layouts = allowed ? await listDocumentLayouts(session.user.client, session.user.capabilities) : [];
  const chosen = layouts.find((layout) => layout.companyCode === (params.company ?? '').trim()) ?? layouts[0] ?? null;

  return (
    <div className="mx-auto max-w-5xl space-y-4 p-3 sm:p-4 lg:p-6">
      <header className="border-b border-line pb-4">
        <span className="code text-ink-faint">{DOCUMENT_LAYOUT_CAPABILITY}</span>
        <div className="mt-1 flex flex-wrap items-center justify-between gap-3">
          <h1 className="text-xl font-semibold tracking-tight">Document layout</h1>
          <Link href="/" className="btn btn-default min-h-11 sm:min-h-8">Launchpad</Link>
        </div>
        <p className="mt-2 max-w-3xl text-sm text-ink-soft">
          The letterhead printed and sent with output documents, one per company code. The name and address are the
          company code&apos;s own; what is entered here overrides them, and empty falls back to them. The body of a
          document is the fixed-width text the output engine stored with the message, and is never changed here.
        </p>
      </header>

      {!allowed ? (
        <p role="alert" className="text-sm text-signal-error">
          This screen needs {DOCUMENT_LAYOUT_CAPABILITY}, which this session does not hold.
        </p>
      ) : layouts.length === 0 || !chosen ? (
        <p className="text-sm text-ink-soft">This tenant has no company codes yet; define one first.</p>
      ) : (
        <>
          <form method="get" action={DOCUMENT_LAYOUT_ROUTE} className="panel flex flex-wrap items-end gap-3 p-4">
            <label className="block">
              <span className="field-label">Company code</span>
              <select name="company" className="input w-72" defaultValue={chosen.companyCode}>
                {layouts.map((layout) => (
                  <option key={layout.companyCode} value={layout.companyCode}>
                    {layout.companyCode} · {layout.companyName}
                  </option>
                ))}
              </select>
            </label>
            <button type="submit" className="btn btn-default min-h-11 sm:min-h-8">Show</button>
          </form>
          <DocumentLayoutForm key={chosen.companyCode} layout={chosen} />
        </>
      )}
    </div>
  );
}
