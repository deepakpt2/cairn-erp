import Link from 'next/link';

import { can, requireSession } from '@/platform/auth/current';
import {
  WORK_CENTER_DISPLAY_CAPABILITY,
  WORK_CENTER_DISPLAY_ROUTE,
  WORK_CENTER_ROUTE,
} from '@/modules/production/work-center';
import { displayWorkCenter } from '@/modules/production/work-center-display';

export const dynamic = 'force-dynamic';

function last(value: string | string[] | undefined): string {
  return (Array.isArray(value) ? value[value.length - 1] : value)?.trim() ?? '';
}

function Field({ label, value }: { label: string; value: string | number | null | undefined }) {
  return (
    <div>
      <dt className="field-label">{label}</dt>
      <dd>{value == null || value === '' ? '—' : value}</dd>
    </div>
  );
}

/** CR03. Display only. Opening this screen does not write. */
export default async function WorkCenterDisplayPage({ searchParams }: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const session = await requireSession(WORK_CENTER_DISPLAY_ROUTE);
  if (!can(session, WORK_CENTER_DISPLAY_CAPABILITY)) {
    return (
      <main className="mx-auto max-w-3xl p-6">
        <h1 className="text-xl font-semibold">Display work center</h1>
        <p className="mt-2 text-sm">You do not hold the work-center display capability (PROD.WORKCENTER.DISPLAY).</p>
      </main>
    );
  }
  const raw = await searchParams;
  const plant = last(raw.plant);
  const center = last(raw.workCenter);
  const document = plant && center ? await displayWorkCenter(session.user.client, plant, center) : null;

  return (
    <main className="mx-auto max-w-5xl space-y-4 p-3 sm:p-4 lg:p-6">
      <header className="border-b border-line pb-4">
        <span className="code text-ink-faint">PROD.WORKCENTER.DISPLAY · CR03</span>
        <div className="mt-1 flex flex-wrap items-center justify-between gap-3">
          <h1 className="text-xl font-semibold tracking-tight">Display work center</h1>
          <Link href="/" className="btn btn-default min-h-11 sm:min-h-8">Launchpad</Link>
        </div>
        <p className="mt-1 max-w-3xl text-sm text-ink-soft">
          CR03 shows the stored work center. It does not save, lock for change, or create a routing.
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
        <button className="btn btn-primary min-h-11 sm:min-h-8" type="submit">Display</button>
      </form>
      {plant && center && !document && (
        <p className="text-sm text-red-700" role="alert">Work center {center} does not exist in plant {plant}.</p>
      )}
      {document && (
        <>
          <p className="text-sm">
            <Link className="underline" href={`${WORK_CENTER_ROUTE}?plant=${encodeURIComponent(document.plant)}&workCenter=${encodeURIComponent(document.workCenter)}`}>CR02 change</Link>
          </p>
          <section className="panel p-4" aria-readonly="true">
            <h2 className="text-sm font-semibold">Basic data</h2>
            <dl className="mt-2 grid gap-3 text-sm sm:grid-cols-2">
              <Field label="Plant" value={`${document.plant} · ${document.plantName}`} />
              <Field label="Work center" value={document.workCenter} />
              <Field label="Category" value={`${document.category} · ${document.categoryDescription}`} />
              <Field label="Description" value={document.description} />
              <Field label="Person responsible" value={document.personResponsible} />
              <Field label="Location" value={document.location} />
              <Field label="Usage" value={document.usage} />
              <Field label="Standard value key" value={document.standardValueKey} />
              <Field label="Control key" value={document.controlKey} />
              <Field label="Deletion flag" value={document.deletionFlag === 'X' ? 'X' : ' '} />
            </dl>
          </section>
          <section className="panel p-4">
            <h2 className="text-sm font-semibold">Capacities</h2>
            {document.capacities.length === 0 && <p className="mt-2 text-sm text-ink-soft">No capacity is stored.</p>}
            <ul className="mt-2 space-y-2 text-sm">
              {document.capacities.map((row) => (
                <li key={row.capacityCategory}>
                  {row.capacityCategory}
                  {row.factoryCalendar ? ` · calendar ${row.factoryCalendar}` : ''}
                  {row.startTime ? ` · ${row.startTime}–${row.endTime}` : ''}
                  {row.finiteScheduling === 'X' ? ' · finite scheduling stored' : ''}
                </li>
              ))}
            </ul>
          </section>
          <section className="panel p-4">
            <h2 className="text-sm font-semibold">Scheduling</h2>
            <dl className="mt-2 grid gap-3 text-sm sm:grid-cols-2">
              <Field label="Capacity category" value={document.schedulingCapacityCategory} />
              <Field label="Setup formula" value={document.schedulingSetupFormula} />
              <Field label="Processing formula" value={document.schedulingProcessingFormula} />
              <Field label="Teardown formula" value={document.schedulingTeardownFormula} />
            </dl>
            <p className="mt-2 text-sm text-ink-soft">The formula is stored. It was not calculated.</p>
          </section>
          <section className="panel p-4">
            <h2 className="text-sm font-semibold">Costing</h2>
            {document.costing.length === 0 && <p className="mt-2 text-sm text-ink-soft">No costing assignment is stored.</p>}
            <ul className="mt-2 space-y-2 text-sm">
              {document.costing.map((row) => (
                <li key={row.lineNumber}>
                  {row.validFrom} to {row.validTo} · {row.costCenter}
                  {row.activityType ? ` · ${row.activityType}` : ''}
                  {row.formula ? ` · formula ${row.formula}` : ''}
                </li>
              ))}
            </ul>
          </section>
          <p className="text-sm text-ink-soft">This screen does not create a routing and does not list one. No production order is changed here.</p>
        </>
      )}
    </main>
  );
}
