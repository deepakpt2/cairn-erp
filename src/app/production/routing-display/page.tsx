import Link from 'next/link';

import { can, requireSession } from '@/platform/auth/current';
import {
  ROUTING_DISPLAY_CAPABILITY,
  ROUTING_DISPLAY_ROUTE,
  ROUTING_ROUTE,
  RoutingError,
  listRoutings,
  resolveRouting,
} from '@/modules/production/routing';

export const dynamic = 'force-dynamic';

function last(value: string | string[] | undefined): string {
  return (Array.isArray(value) ? value[value.length - 1] : value)?.trim() ?? '';
}

/** CA03. Display writes nothing and takes no change lock. */
export default async function RoutingDisplayPage({ searchParams }: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const session = await requireSession(ROUTING_DISPLAY_ROUTE);
  if (!can(session, ROUTING_DISPLAY_CAPABILITY)) {
    return (
      <main className="mx-auto max-w-3xl p-6">
        <h1 className="text-xl font-semibold">Display routing</h1>
        <p className="mt-2 text-sm">You do not hold the routing display capability.</p>
      </main>
    );
  }
  const raw = await searchParams;
  const taskListType = last(raw.type);
  const routingGroup = last(raw.group);
  const groupCounter = last(raw.counter);
  const materialNumber = last(raw.material);
  const plant = last(raw.plant);
  let openError = '';
  let listed: Awaited<ReturnType<typeof listRoutings>> = [];
  if (materialNumber || plant || taskListType) {
    try {
      listed = await listRoutings(session.user.client, { materialNumber, plant, taskListType });
    } catch (error) {
      openError = error instanceof RoutingError ? error.message : 'The routing could not be displayed.';
    }
  }
  let document = null;
  if ((taskListType && routingGroup && groupCounter) || listed.length === 1) {
    try {
      document = await resolveRouting(session.user.client, {
        taskListType: taskListType || listed[0]?.taskListType,
        routingGroup: routingGroup || listed[0]?.routingGroup,
        groupCounter: groupCounter || listed[0]?.groupCounter,
        materialNumber,
        plant,
      });
    } catch (error) {
      openError = error instanceof RoutingError ? error.message : 'The routing could not be displayed.';
    }
  }

  return (
    <main className="mx-auto max-w-5xl p-6">
      <p className="text-sm"><Link href={ROUTING_ROUTE}>CA01 / CA02</Link></p>
      <h1 className="mt-2 text-xl font-semibold">Display routing</h1>
      <p className="mt-2 text-sm text-ink-soft">CA03 writes nothing. It does not take a change lock and does not change a timestamp or version. A formula is not calculated.</p>
      {openError && <p className="mt-3 text-sm text-danger">{openError}</p>}
      {listed.length > 1 && !routingGroup && (
        <ul className="mt-3 space-y-1 text-sm">
          {listed.map((row) => (
            <li key={`${row.taskListType}/${row.routingGroup}/${row.groupCounter}`}>
              <Link href={`${ROUTING_DISPLAY_ROUTE}?type=${row.taskListType}&group=${row.routingGroup}&counter=${row.groupCounter}`}>{row.taskListType} {row.routingGroup}/{row.groupCounter}</Link>
            </li>
          ))}
          <li>More than one routing matches. The first was not opened.</li>
        </ul>
      )}
      <form className="mt-4 grid gap-2 sm:grid-cols-5" method="get">
        <input className="input" name="type" defaultValue={taskListType} placeholder="Type" />
        <input className="input" name="group" defaultValue={routingGroup} placeholder="Group" />
        <input className="input" name="counter" defaultValue={groupCounter} placeholder="Counter" />
        <input className="input" name="material" defaultValue={materialNumber} placeholder="Material" />
        <input className="input" name="plant" defaultValue={plant} placeholder="Plant" />
        <button className="btn" type="submit">Display</button>
      </form>
      {document && (
        <section className="mt-4 space-y-3 text-sm">
          <p>{document.taskListType} {document.routingGroup}/{document.groupCounter} plant {document.plant} usage {document.usage} version {document.version}</p>
          <p>Sequence {document.sequence} type {document.sequenceType}. Valid {document.validFrom} to {document.validTo}. Deletion {document.deletionFlag === 'X' ? 'marked' : 'not marked'}.</p>
          <ul>
            {document.operations.map((operation) => (
              <li key={operation.operationNumber}>
                order {operation.executionOrder} operation {operation.operationNumber} sequence {operation.sequence} {operation.shortText ?? ''} work center {operation.workCenter ?? 'none'} control {operation.controlKey ?? 'none'}
                {operation.deletionFlag === 'X' ? ' deleted' : ''}
                {operation.values.map((value) => ` ${value.parameter} ${value.quantity} ${value.unit}`)}
                {operation.schedulingFormula ? ` formula ${operation.schedulingFormula} not calculated` : ''}
              </li>
            ))}
          </ul>
        </section>
      )}
    </main>
  );
}
