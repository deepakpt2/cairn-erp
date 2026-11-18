
import CheckingControlForm from './CheckingControlForm';
import { can, requireSession } from '@/platform/auth/current';
import { ACTIVITY, ALIAS, listCheckingControls, ROUTE } from '@/modules/production/checking-control';
import { LinkButton, Page } from '@/ui/kit';

export const dynamic = 'force-dynamic';

/** OPJK. Opening this page writes nothing and does not run an availability check. */
export default async function CheckingControlPage() {
  const session = await requireSession(ROUTE);
  const canMaintain = can(session, ACTIVITY);
  const current = await listCheckingControls(session.user.client);

  return (
    <Page
      title="Checking control" code={<>{ACTIVITY} · {ALIAS}</>} width="4xl" back={null}
      description="The key is a standing plant, a standing production order type, and business function 1 or 2. A missing combination is not configured. Saving does not run an availability check, create an order, or release one. CO09 remains blocked."
      actions={
        <>
          <LinkButton href="/config">Workbench</LinkButton>
        </>
      }
    >
      {!canMaintain && (
        <p role="status" className="border border-line bg-white p-3 text-sm">
          Display only. Ask an administrator for {ACTIVITY}.
        </p>
      )}
      <section className="border border-line bg-white p-4 text-sm">
        <h2 className="font-semibold">Not stored</h2>
        <ul className="mt-2 list-disc space-y-1 pl-5 text-ink-soft">
          {current.gaps.map((gap) => <li key={gap}>{gap}</li>)}
        </ul>
      </section>
      <CheckingControlForm controls={current.controls} canMaintain={canMaintain} />
    </Page>
  );
}
