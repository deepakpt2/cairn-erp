
import { can, requireSession } from '@/platform/auth/current';
import {
  ACTIVITY,
  ALIAS,
  getWipBatchActivation,
  NOT_EXECUTED,
  ROUTE,
} from '@/modules/production/wip-batch';

import WipForm from './WipForm';
import { LinkButton, Page } from '@/ui/kit';

export const dynamic = 'force-dynamic';

/** Activate WIP batch. This screen does not create a WIP batch. */
export default async function WipBatchPage() {
  const session = await requireSession(ROUTE);
  const canMaintain = can(session, ACTIVITY);
  const current = await getWipBatchActivation(session.user.client);

  return (
    <Page
      title="Activate WIP batch" code={<>{ACTIVITY} · {ALIAS}</>} width="3xl" back={null}
      description="OMCWB is the client indicator. It is not an inventory batch, a documentary batch, or a where-used list. Opening this screen writes nothing. A closed posting period does not block it."
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

      <WipForm client={session.user.client} current={current} canMaintain={canMaintain} />
    </Page>
  );
}
