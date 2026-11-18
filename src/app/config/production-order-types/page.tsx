
import ProductionOrderTypeForm from './ProductionOrderTypeForm';
import { can, requireSession } from '@/platform/auth/current';
import { ACTIVITY, ALIAS, listProductionOrderTypes, ROUTE } from '@/modules/production/production-order-type';
import { LinkButton, Page } from '@/ui/kit';

export const dynamic = 'force-dynamic';

/** OPJH. Opening this page writes nothing and does not create a production order. */
export default async function ProductionOrderTypesPage() {
  const session = await requireSession(ROUTE);
  const canMaintain = can(session, ACTIVITY);
  const current = await listProductionOrderTypes(session.user.client);

  return (
    <Page
      title="Production order type" code={<>{ACTIVITY} · {ALIAS}</>} width="4xl" back={null}
      description="The key is four characters and is not a plant. The category is production order only. Saving a type does not create an order, change numbering, or define checking control."
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
      <ProductionOrderTypeForm types={current.types} canMaintain={canMaintain} />
    </Page>
  );
}
