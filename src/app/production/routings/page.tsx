import Link from 'next/link';
import { eq } from 'drizzle-orm';

import { can, requireSession } from '@/platform/auth/current';
import { withTenant } from '@/platform/db/client';
import { displayOnlyMessage, openChangeForSession } from '@/platform/lock/enqueue';
import { plant as plantTable } from '@/modules/foundation/schema';
import { material as materialTable } from '@/modules/inventory/schema';
import {
  ROUTING_ACTIVITY,
  ROUTING_CHANGE_CAPABILITY,
  ROUTING_CREATE_CAPABILITY,
  ROUTING_DISPLAY_ROUTE,
  ROUTING_LOCK,
  ROUTING_ROUTE,
  RoutingError,
  listRoutingConfiguration,
  listRoutings,
  resolveRouting,
} from '@/modules/production/routing';
import RoutingForm from './RoutingForm';
import { ControlKeyForm, StandardValueKeyForm, StatusForm, TaskListTypeForm, UsageForm } from './ConfigForms';

export const dynamic = 'force-dynamic';

function last(value: string | string[] | undefined): string {
  return (Array.isArray(value) ? value[value.length - 1] : value)?.trim() ?? '';
}

/** CA01 and CA02. This is not the chart of accounts, and it is not a confirmation. */
export default async function RoutingsPage({ searchParams }: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const session = await requireSession(ROUTING_ROUTE);
  const canCreate = can(session, ROUTING_CREATE_CAPABILITY);
  const canChange = can(session, ROUTING_CHANGE_CAPABILITY);
  if (!canCreate && !canChange) {
    return (
      <main className="mx-auto max-w-3xl p-6">
        <h1 className="text-xl font-semibold">Routing</h1>
        <p className="mt-2 text-sm">You do not hold the routing create or change capability.</p>
      </main>
    );
  }
  const raw = await searchParams;
  const taskListType = last(raw.type);
  const routingGroup = last(raw.group);
  const groupCounter = last(raw.counter);
  const materialNumber = last(raw.material);
  const plant = last(raw.plant);
  const validOn = last(raw.validOn);
  const creating = last(raw.create) === '1';
  let listed: Awaited<ReturnType<typeof listRoutings>> = [];
  let openError = '';
  const [configuration, plants, materials] = await Promise.all([
    listRoutingConfiguration(session.user.client),
    withTenant(session.user.client, (tx) => tx.select({ plant: plantTable.plant, name: plantTable.name }).from(plantTable).where(eq(plantTable.client, session.user.client))),
    withTenant(session.user.client, (tx) => tx.select({
      materialNumber: materialTable.materialNumber,
      description: materialTable.description,
      baseUnit: materialTable.baseUnit,
    }).from(materialTable).where(eq(materialTable.client, session.user.client))),
  ]);
  if (materialNumber || plant || taskListType) {
    try {
      listed = await listRoutings(session.user.client, { materialNumber, plant, taskListType });
    } catch (error) {
      openError = error instanceof RoutingError ? error.message : 'The routing could not be opened.';
    }
  }
  let document = null;
  if (!creating && ((taskListType && routingGroup && groupCounter) || listed.length === 1)) {
    try {
      document = await resolveRouting(session.user.client, {
        taskListType: taskListType || listed[0]?.taskListType,
        routingGroup: routingGroup || listed[0]?.routingGroup,
        groupCounter: groupCounter || listed[0]?.groupCounter,
        materialNumber,
        plant,
        keyDate: validOn || null,
      });
    } catch (error) {
      openError = error instanceof RoutingError ? error.message : 'The routing could not be opened.';
    }
  }
  // The routing screen writes an existing routing through one action, and that action requires the
  // change capability, so only a session holding it takes the lock. A create-only session takes
  // none: it cannot block an editor with a lock it cannot use. Creating stays lock-free.
  // Only a lock this session was actually given grants change: another holder, or no lock at all,
  // reads and never writes.
  const lock = document && canChange
    ? await openChangeForSession(session, {
      lockObject: ROUTING_LOCK,
      argument: `${document.taskListType}/${document.routingGroup}/${document.groupCounter}`,
      transactionCode: ROUTING_ACTIVITY,
    })
    : null;
  const locked = Boolean(document) && lock?.mode !== 'CHANGE';
  const displayNotice = lock ? displayOnlyMessage(lock) : null;

  return (
    <main className="mx-auto max-w-5xl p-6">
      <p className="text-sm"><Link href="/config">Configuration</Link></p>
      <h1 className="mt-2 text-xl font-semibold">Routing</h1>
      <p className="mt-2 text-sm text-ink-soft">CA01 creates and CA02 changes a standard routing. The chart-of-accounts key CA01 is not this transaction. A material assignment is separate. Only sequence 000000 of type 0 is stored. Execution order is a separate number and is not taken from the operation number. Alternative and parallel sequences are not stored. A formula is not calculated. A production order is not rewritten. <Link href={ROUTING_DISPLAY_ROUTE}>CA03 displays and does not save.</Link></p>
      {openError && <p className="mt-3 text-sm text-danger">{openError}</p>}
      {listed.length > 1 && !routingGroup && (
        <ul className="mt-3 space-y-1 text-sm">
          {listed.map((row) => (
            <li key={`${row.taskListType}/${row.routingGroup}/${row.groupCounter}`}>
              <Link href={`${ROUTING_ROUTE}?type=${row.taskListType}&group=${row.routingGroup}&counter=${row.groupCounter}`}>{row.taskListType} {row.routingGroup}/{row.groupCounter} plant {row.plant}</Link>
            </li>
          ))}
          <li>More than one routing matches. The first was not opened.</li>
        </ul>
      )}
      <form className="mt-4 grid gap-2 sm:grid-cols-6" method="get">
        <input className="input" name="type" defaultValue={taskListType} maxLength={1} placeholder="Type" />
        <input className="input" name="group" defaultValue={routingGroup} maxLength={8} placeholder="Group" />
        <input className="input" name="counter" defaultValue={groupCounter} maxLength={2} placeholder="Counter" />
        <input className="input" name="material" defaultValue={materialNumber} placeholder="Material" />
        <input className="input" name="plant" defaultValue={plant} placeholder="Plant" />
        <input className="input" name="validOn" type="date" defaultValue={validOn} />
        <button className="btn" type="submit">Open</button>
        <Link className="btn" href={`${ROUTING_ROUTE}?create=1`}>New routing</Link>
      </form>
      {displayNotice && <p className="mt-3 text-sm">{displayNotice}</p>}
      {(creating || document) && (
        <RoutingForm
          document={document}
          locked={locked}
          plants={plants}
          materials={materials}
          types={configuration.types}
          usages={configuration.usages}
          statuses={configuration.statuses}
          controlKeys={configuration.controlKeys}
          valueKeys={configuration.standardValueKeys}
        />
      )}
      {canCreate && (
        <div className="mt-8 grid gap-3 lg:grid-cols-2">
          <TaskListTypeForm />
          <UsageForm />
          <StatusForm />
          <ControlKeyForm />
          <StandardValueKeyForm />
        </div>
      )}
    </main>
  );
}
