
import AvailabilityCheckForm from './AvailabilityCheckForm';
import { can, requireSession } from '@/platform/auth/current';
import { ACTIVITY, ALIASES, listAvailabilityCheck, ROUTE } from '@/modules/production/availability-check';
import { LinkButton, Page } from '@/ui/kit';

export const dynamic = 'force-dynamic';

/** Availability-check configuration. Opening this page writes nothing and calculates no ATP quantity. */
export default async function AvailabilityCheckPage() {
  const session = await requireSession(ROUTE);
  const canMaintain = can(session, ACTIVITY);
  const current = await listAvailabilityCheck(session.user.client);

  return (
    <Page
      title="Availability check configuration" code={<>{ACTIVITY} · {ALIASES.join(' · ')}</>} width="5xl" back={null}
      description="A checking group is assigned on the material plant view. A missing assignment stays unassigned. A checking rule is a separate key. It is not a checking group, and it does not decide whether a check runs. A scope of check is that pair. Checking control is not stored. Saving this screen does not calculate ATP, does not read the stock/requirements list, and does not post."
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
        <h2 className="font-semibold">Not configured, and not inferred</h2>
        <ul className="mt-2 list-disc space-y-1 pl-5 text-ink-soft">
          {current.gaps.map((gap) => <li key={gap}>{gap}</li>)}
        </ul>
      </section>
      <AvailabilityCheckForm current={current} canMaintain={canMaintain} />
    </Page>
  );
}
