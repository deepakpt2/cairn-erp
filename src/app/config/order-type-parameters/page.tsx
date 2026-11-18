
import OrderTypeParameterForm from './OrderTypeParameterForm';
import { can, requireSession } from '@/platform/auth/current';
import { ACTIVITY, ALIAS, listOrderTypeParameters, ROUTE } from '@/modules/production/order-type-parameters';
import { LinkButton, Page } from '@/ui/kit';

export const dynamic = 'force-dynamic';

/** OPL8. Opening this page writes nothing and does not create a production order. */
export default async function OrderTypeParametersPage() {
  const session = await requireSession(ROUTE);
  const canMaintain = can(session, ACTIVITY);
  const current = await listOrderTypeParameters(session.user.client);

  return (
    <Page
      title="Order type-dependent parameters" code={<>{ACTIVITY} · {ALIAS}</>} width="4xl" back={null}
      description="The key is a standing plant and a standing production order type. Saving does not create an order, select a routing or a production version, or run an availability check. Order creation and planned-order conversion read the stored production version selection for this plant and order type."
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
      <OrderTypeParameterForm parameters={current.parameters} canMaintain={canMaintain} />
    </Page>
  );
}
