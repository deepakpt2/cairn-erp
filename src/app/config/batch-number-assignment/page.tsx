
import { can, requireSession } from '@/platform/auth/current';
import {
  ACTIVITY,
  getInternalBatchAssignment,
  listAssignedReceiptSettings,
} from '@/modules/inventory/batch-number-assignment';

import BatchNumberAssignmentForm from './BatchNumberAssignmentForm';
import { LinkButton, Page } from '@/ui/kit';

export const dynamic = 'force-dynamic';

const ROUTE = '/config/batch-number-assignment';

/** Internal batch number assignment. OMCZ is a search alias only. */
export default async function BatchNumberAssignmentPage() {
  const session = await requireSession(ROUTE);
  const canMaintain = can(session, ACTIVITY);
  const [current, plants] = await Promise.all([
    getInternalBatchAssignment(session.user.client),
    listAssignedReceiptSettings(session.user.client),
  ]);

  return (
    <Page
      title="Activate internal batch number assignment" code={<>{ACTIVITY} · OMCZ</>} width="3xl" back={null}
      description="Two settings, kept apart. The client flag is X or blank. The plant flag permits a number only for an account-assigned goods receipt. Neither setting creates BATCH_CLT interval 01, a batch, or a stock receipt. OMAD, OMCE, and OPKP are not this screen. A closed posting period does not block it."
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

      <BatchNumberAssignmentForm
        client={session.user.client}
        current={current}
        plants={plants}
        canMaintain={canMaintain}
      />
    </Page>
  );
}
