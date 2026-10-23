import Link from 'next/link';

import { can, requireSession } from '@/platform/auth/current';
import { displayOnlyMessage, openChangeForSession } from '@/platform/lock/enqueue';
import { plant as plantTable } from '@/modules/foundation/schema';
import { withTenant } from '@/platform/db/client';
import { eq } from 'drizzle-orm';
import {
  WORK_CENTER_CHANGE_CAPABILITY,
  WORK_CENTER_CREATE_CAPABILITY,
  WORK_CENTER_DISPLAY_ROUTE,
  WORK_CENTER_LOCK,
  WORK_CENTER_ROUTE,
  getWorkCenter,
  listWorkCenterCategories,
  listWorkCenters,
} from '@/modules/production/work-center';
import { saveCategoryAction } from './actions';
import WorkCenterForm from './WorkCenterForm';
import { CategoryForm } from './CategoryForm';

export const dynamic = 'force-dynamic';

function last(value: string | string[] | undefined): string {
  return (Array.isArray(value) ? value[value.length - 1] : value)?.trim() ?? '';
}

/** CR01 and CR02. A work center is master data. This is not a routing. */
export default async function WorkCentersPage({ searchParams }: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const session = await requireSession(WORK_CENTER_ROUTE);
  const canCreate = can(session, WORK_CENTER_CREATE_CAPABILITY);
  const canChange = can(session, WORK_CENTER_CHANGE_CAPABILITY);
  if (!canCreate && !canChange) {
    return (
      <main className="mx-auto max-w-3xl p-6">
        <h1 className="text-xl font-semibold">Work center</h1>
        <p className="mt-2 text-sm">You do not hold the work-center create or change capability.</p>
      </main>
    );
  }
  const raw = await searchParams;
  const plant = last(raw.plant);
  const center = last(raw.workCenter);
  const creating = last(raw.create) === '1' || !center;
  const document = plant && center ? await getWorkCenter(session.user.client, plant, center) : null;
  const [categories, centers, plants] = await Promise.all([
    listWorkCenterCategories(session.user.client),
    listWorkCenters(session.user.client),
    withTenant(session.user.client, (tx) => tx.select({
      plant: plantTable.plant,
      name: plantTable.name,
    }).from(plantTable).where(eq(plantTable.client, session.user.client))),
  ]);
  const changeLock = document && canChange
    ? await openChangeForSession(session, {
        lockObject: WORK_CENTER_LOCK,
        argument: `${document.plant}/${document.workCenter}`,
        transactionCode: 'CR02',
      })
    : null;
  const showCreate = creating && canCreate && !document;
  const showChange = Boolean(document) && canChange && changeLock?.mode !== 'DISPLAY';

  return (
    <main className="mx-auto max-w-5xl space-y-4 p-3 sm:p-4 lg:p-6">
      <header className="border-b border-line pb-4">
        <span className="code text-ink-faint">PROD.WORKCENTER.CREATE · CR01 / CR02</span>
        <div className="mt-1 flex flex-wrap items-center justify-between gap-3">
          <h1 className="text-xl font-semibold tracking-tight">Work center</h1>
          <Link href="/" className="btn btn-default min-h-11 sm:min-h-8">Launchpad</Link>
        </div>
        <p className="mt-1 max-w-3xl text-sm text-ink-soft">
          CR01 creates a work center in a plant. CR02 changes one. The category cannot be changed.
          A formula key is stored and not calculated. No routing is created. CR03 displays and does not save.
          The chart-of-accounts key CA01 is not this screen.
        </p>
      </header>
      <form className="flex flex-wrap items-end gap-3" method="get">
        <label className="block text-sm">
          <span className="mb-1 block text-ink-soft">Plant</span>
          <input className="input" name="plant" defaultValue={plant} maxLength={10} />
        </label>
        <label className="block text-sm">
          <span className="mb-1 block text-ink-soft">Work center</span>
          <input className="input" name="workCenter" defaultValue={center} maxLength={8} />
        </label>
        <button className="btn btn-primary min-h-11 sm:min-h-8" type="submit">Open</button>
        {canCreate && <Link className="btn btn-default min-h-11 sm:min-h-8" href={`${WORK_CENTER_ROUTE}?create=1`}>Create</Link>}
      </form>
      {plant && center && !document && (
        <p className="text-sm text-red-700" role="alert">Work center {center} does not exist in plant {plant}.</p>
      )}
      {document && (
        <p className="text-sm">
          {document.workCenter} · {document.plant} · {document.category}
          {' · '}
          <Link className="underline" href={`${WORK_CENTER_DISPLAY_ROUTE}?plant=${encodeURIComponent(document.plant)}&workCenter=${encodeURIComponent(document.workCenter)}`}>CR03 display</Link>
        </p>
      )}
      {changeLock?.mode === 'DISPLAY' && <p className="text-sm text-ink-soft">{displayOnlyMessage(changeLock)}</p>}
      {(showCreate || showChange) && (
        <WorkCenterForm
          document={showChange ? document : null}
          plants={plants}
          categories={categories.map((row) => ({ category: row.category, description: row.description }))}
          locked={false}
        />
      )}
      {canCreate && <CategoryForm action={saveCategoryAction} initial={{ ok: false }} />}
      {centers.length > 0 && (
        <ul className="text-sm">
          {centers.map((row) => (
            <li key={`${row.plant}/${row.workCenter}`}>
              <Link className="underline" href={`${WORK_CENTER_ROUTE}?plant=${encodeURIComponent(row.plant)}&workCenter=${encodeURIComponent(row.workCenter)}`}>
                {row.plant} / {row.workCenter} · {row.description}
              </Link>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
