import Link from 'next/link';

import { can, requireSession } from '@/platform/auth/current';
import {
  DOCUMENT_TYPE_DEFINE_CAPABILITY,
  listSalesDocumentTypes,
} from '@/modules/sales/document-type-maintenance';
import { SalesDocumentTypeSetup } from './SalesDocumentTypeSetup';

export const dynamic = 'force-dynamic';

const ROUTE = '/config/sales-document-types';

export default async function SalesDocumentTypesPage() {
  const session = await requireSession(ROUTE);
  const types = await listSalesDocumentTypes(session.user.client);
  const canMaintain = can(session, DOCUMENT_TYPE_DEFINE_CAPABILITY);

  return (
    <main className="mx-auto max-w-6xl space-y-4 p-3 sm:p-4 lg:p-6">
      <header className="border-b border-line pb-4">
        <span className="code text-ink-faint">{DOCUMENT_TYPE_DEFINE_CAPABILITY} · SD</span>
        <div className="mt-1 flex flex-wrap items-center justify-between gap-3">
          <h1 className="text-xl font-semibold tracking-tight">Sales document types</h1>
          <Link href="/" className="btn btn-default min-h-11 sm:min-h-8">Launchpad</Link>
        </div>
        <p className="mt-1 max-w-3xl text-sm text-ink-soft">
          What a sales document <em>is</em>: the code it carries, the name a screen shows, the number range
          its number is drawn from, what the type cancels into, and whether documents of that type may still
          be created. Every document service reads this configuration before it creates anything, which is
          what makes a new commercial process a configuration rather than a deployment.
        </p>
        {!canMaintain && (
          <p role="status" className="mt-3 border border-line bg-surface p-3 text-sm text-ink-soft">
            Read-only. Maintenance requires an explicit exact-code role grant for {DOCUMENT_TYPE_DEFINE_CAPABILITY};
            broad wildcard role patterns do not grant it.
          </p>
        )}
      </header>

      <section aria-labelledby="doctype-list" className="border border-line bg-surface p-4">
        <h2 id="doctype-list" className="text-sm font-semibold">Document types as configured</h2>
        {types.length === 0 ? (
          <p className="mt-2 text-sm text-ink-soft">
            No document types stand for this tenant. The document chain will refuse to create anything until
            the type it asks for is defined here.
          </p>
        ) : (
          <div className="mt-3 overflow-x-auto">
            <table className="grid-table text-left text-sm">
              <thead>
                <tr className="text-xs uppercase tracking-wide text-ink-faint">
                  <th>Type</th>
                  <th>Name</th>
                  <th>Number range</th>
                  <th>Cancels into</th>
                  <th>Status</th>
                  <th>Documents standing</th>
                  <th>Range stands</th>
                </tr>
              </thead>
              <tbody>
                {types.map((type) => (
                  <tr key={type.documentType}>
                    <td className="font-mono">{type.documentType}</td>
                    <td>{type.name}</td>
                    <td className="font-mono">
                      {type.numberRangeObject} / {type.numberRangeSubObject}
                    </td>
                    <td className="font-mono">{type.cancellationDocumentType ?? '—'}</td>
                    <td>{type.isActive ? 'Offered' : 'Withdrawn'}</td>
                    <td>{type.documentsStanding}</td>
                    <td>
                      {type.rangeStands ? (
                        'Yes'
                      ) : (
                        <span className="text-red-700">
                          No — no document of this type can be numbered
                        </span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className="mt-3 max-w-3xl text-xs text-ink-faint">
          A type whose number range does not stand is the one configuration that fails silently everywhere
          else: the document is refused for want of a number, and the refusal names a range rather than the
          type that pointed at it.
        </p>
      </section>

      {canMaintain && (
        <SalesDocumentTypeSetup
          types={types.map((type) => ({
            documentType: type.documentType,
            name: type.name,
            numberRangeObject: type.numberRangeObject,
            numberRangeSubObject: type.numberRangeSubObject,
            cancellationDocumentType: type.cancellationDocumentType,
            isActive: type.isActive,
            documentsStanding: type.documentsStanding,
          }))}
        />
      )}
    </main>
  );
}
