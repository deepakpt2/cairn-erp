
import { can, requireSession } from '@/platform/auth/current';
import { ACTIVITY, getBatchStatusManagement } from '@/modules/inventory/batch-status';

import BatchStatusForm from './BatchStatusForm';
import { LinkButton, Page } from '@/ui/kit';

export const dynamic = 'force-dynamic';

const ROUTE = '/config/batch-status';

/**
 * Batch status management. OMCS is a search alias only.
 * One indicator for the client. It does not post, and a closed period does not block it.
 */
export default async function BatchStatusPage() {
  const session = await requireSession(ROUTE);
  const canMaintain = can(session, ACTIVITY);
  const current = await getBatchStatusManagement(session.user.client);

  return (
    <Page
      title="Activate batch status management" code={<>{ACTIVITY} · OMCS</>} width="3xl" back={null}
      description="One indicator for this client. Active is the character 1. Not active is blank. The batch level is read from OMCE. This screen does not select a plant, set an initial status, create a batch, or post movement 341 or 342. Plant selection is OMCU. OMCU, OMAB, OMCZ, OMAD, MSC1N, MSC2N, and MSC3N are not this screen. A closed posting period does not block it."
      actions={
        <>
          <LinkButton href="/config">Workbench</LinkButton>
        </>
      }
    >

      {!canMaintain && (
        <p role="status" className="border border-line bg-white p-3 text-sm text-ink">
          Display only. Ask an administrator for {ACTIVITY}.
        </p>
      )}

      <BatchStatusForm client={session.user.client} current={current} canMaintain={canMaintain} />
    </Page>
  );
}
