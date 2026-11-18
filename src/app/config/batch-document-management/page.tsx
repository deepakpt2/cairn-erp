
import { can, requireSession } from '@/platform/auth/current';
import {
  ACTIVITY,
  ALIAS,
  getBatchDocumentManagement,
  NOT_EXECUTED,
  ROUTE,
} from '@/modules/inventory/batch-document-management';

import DocumentForm from './DocumentForm';
import { LinkButton, Page } from '@/ui/kit';

export const dynamic = 'force-dynamic';

/** Activate document management for batches. This screen does not store a document. */
export default async function BatchDocumentManagementPage() {
  const session = await requireSession(ROUTE);
  const canMaintain = can(session, ACTIVITY);
  const current = await getBatchDocumentManagement(session.user.client);

  return (
    <Page
      title="Activate document management for batches" code={<>{ACTIVITY} · {ALIAS}</>} width="3xl" back={null}
      description="ODOC is the client indicator. It is not a document store and not a genealogy report. Opening this screen writes nothing. A closed posting period does not block it."
      actions={
        <>
          <LinkButton href="/config/batch-level">Batch level</LinkButton>
        </>
      }
    >

      {!canMaintain && (
        <p role="status" className="border border-line bg-white p-3 text-sm text-ink">
          Display only. Ask an administrator for {ACTIVITY}.
        </p>
      )}

      <section className="border border-line bg-white p-3 text-sm">
        <h2 className="font-semibold">Not executed</h2>
        <ul className="mt-2 space-y-2">
          {NOT_EXECUTED.map((item) => (
            <li key={item.field}>
              <span className="code">{item.field}</span> · {item.title}. {item.reason}
            </li>
          ))}
        </ul>
      </section>

      <p className="text-sm text-ink-soft">
        Current indicator: <span className="code">{current.code ?? 'blank'}</span>. Version <span className="code">{current.version}</span>.
      </p>
      <DocumentForm client={session.user.client} current={current} canMaintain={canMaintain} />
    </Page>
  );
}
