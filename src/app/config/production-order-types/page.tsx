import Link from 'next/link';

import ProductionOrderTypeForm from './ProductionOrderTypeForm';
import { can, requireSession } from '@/platform/auth/current';
import { ACTIVITY, ALIAS, listProductionOrderTypes, ROUTE } from '@/modules/production/production-order-type';

export const dynamic = 'force-dynamic';

/** OPJH. Opening this page writes nothing and does not create a production order. */
export default async function ProductionOrderTypesPage() {
  const session = await requireSession(ROUTE);
  const canMaintain = can(session, ACTIVITY);
  const current = await listProductionOrderTypes(session.user.client);

  return (
    <div className="mx-auto max-w-4xl space-y-4 p-3 sm:p-4 lg:p-6">
      <header className="border-b border-line pb-4">
        <span className="code text-ink-faint">{ACTIVITY} · {ALIAS}</span>
        <div className="mt-1 flex flex-wrap items-center justify-between gap-3">
          <h1 className="text-xl font-semibold tracking-tight">Production order type</h1>
          <Link href="/config" className="btn btn-default min-h-11 sm:min-h-8">Workbench</Link>
        </div>
        <p className="mt-1 max-w-3xl text-sm text-ink-soft">
          The key is four characters and is not a plant. The category is production order only.
          Saving a type does not create an order, change numbering, or define checking control.
        </p>
      </header>
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
    </div>
  );
}
