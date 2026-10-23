'use client';

import { useActionState } from 'react';

import {
  saveControlKeyAction,
  saveStandardValueKeyAction,
  saveStatusAction,
  saveTaskListTypeAction,
  saveUsageAction,
  type RoutingActionState,
} from './actions';

const initial: RoutingActionState = { ok: false };

function Note({ state }: { state: RoutingActionState }) {
  if (!state.message) return null;
  return <p className={`mt-2 text-sm ${state.ok ? 'text-ink' : 'text-danger'}`}>{state.message}{state.remedy ? ` ${state.remedy}` : ''}</p>;
}

export function TaskListTypeForm() {
  const [state, action, pending] = useActionState(saveTaskListTypeAction, initial);
  return (
    <form action={action} className="rounded border border-line p-3">
      <h2 className="text-sm font-semibold">Task list type</h2>
      <p className="mt-1 text-sm text-ink-soft">No type is delivered. This screen stores a standard routing only.</p>
      <div className="mt-2 grid gap-2 sm:grid-cols-3">
        <input className="input" name="taskListType" maxLength={1} placeholder="Type" required />
        <input className="input sm:col-span-2" name="description" maxLength={40} placeholder="Description" required />
      </div>
      <label className="mt-2 flex items-center gap-2 text-sm"><input type="checkbox" name="requireControlKey" value="X" /> Require a control key</label>
      <button className="btn mt-2" type="submit" disabled={pending}>Save type</button>
      <Note state={state} />
    </form>
  );
}

export function UsageForm() {
  const [state, action, pending] = useActionState(saveUsageAction, initial);
  return (
    <form action={action} className="rounded border border-line p-3">
      <h2 className="text-sm font-semibold">Routing usage</h2>
      <div className="mt-2 grid gap-2 sm:grid-cols-3">
        <input className="input" name="usage" maxLength={3} placeholder="Usage" required />
        <input className="input sm:col-span-2" name="description" maxLength={40} placeholder="Description" required />
      </div>
      <button className="btn mt-2" type="submit" disabled={pending}>Save usage</button>
      <Note state={state} />
    </form>
  );
}

export function StatusForm() {
  const [state, action, pending] = useActionState(saveStatusAction, initial);
  return (
    <form action={action} className="rounded border border-line p-3">
      <h2 className="text-sm font-semibold">Routing status</h2>
      <p className="mt-1 text-sm text-ink-soft">A release flag is stored. It does not schedule, cost, or create an order.</p>
      <div className="mt-2 grid gap-2 sm:grid-cols-3">
        <input className="input" name="status" maxLength={3} placeholder="Status" required />
        <input className="input sm:col-span-2" name="description" maxLength={40} placeholder="Description" required />
      </div>
      <div className="mt-2 flex flex-wrap gap-3 text-sm">
        <label><input type="checkbox" name="releasedForScheduling" value="X" /> Scheduling</label>
        <label><input type="checkbox" name="releasedForCosting" value="X" /> Costing</label>
        <label><input type="checkbox" name="releasedForOrders" value="X" /> Orders</label>
      </div>
      <button className="btn mt-2" type="submit" disabled={pending}>Save status</button>
      <Note state={state} />
    </form>
  );
}

export function ControlKeyForm() {
  const [state, action, pending] = useActionState(saveControlKeyAction, initial);
  return (
    <form action={action} className="rounded border border-line p-3">
      <h2 className="text-sm font-semibold">Control key</h2>
      <p className="mt-1 text-sm text-ink-soft">No control key is delivered. External processing does not create a purchase order.</p>
      <div className="mt-2 grid gap-2 sm:grid-cols-3">
        <input className="input" name="controlKey" maxLength={4} placeholder="Key" required />
        <input className="input sm:col-span-2" name="description" maxLength={40} placeholder="Description" required />
      </div>
      <div className="mt-2 flex flex-wrap gap-3 text-sm">
        <label><input type="checkbox" name="scheduling" value="X" /> Scheduling</label>
        <label><input type="checkbox" name="costing" value="X" /> Costing</label>
        <label><input type="checkbox" name="confirmation" value="X" /> Confirmation</label>
        <label><input type="checkbox" name="externalProcessing" value="X" /> External</label>
        <label><input type="checkbox" name="requireWorkCenter" value="X" /> Work center required</label>
      </div>
      <button className="btn mt-2" type="submit" disabled={pending}>Save control key</button>
      <Note state={state} />
    </form>
  );
}

export function StandardValueKeyForm() {
  const [state, action, pending] = useActionState(saveStandardValueKeyAction, initial);
  return (
    <form action={action} className="rounded border border-line p-3">
      <h2 className="text-sm font-semibold">Standard value key</h2>
      <p className="mt-1 text-sm text-ink-soft">One line per parameter: parameter|description|unit|X. These are not fixed setup, machine, and labor columns.</p>
      <div className="mt-2 grid gap-2 sm:grid-cols-3">
        <input className="input" name="standardValueKey" maxLength={4} placeholder="Key" required />
        <input className="input sm:col-span-2" name="description" maxLength={40} placeholder="Description" required />
      </div>
      <textarea className="input mt-2 w-full" name="parameters" rows={3} placeholder="SETUP|Setup time|H|X" />
      <button className="btn mt-2" type="submit" disabled={pending}>Save value key</button>
      <Note state={state} />
    </form>
  );
}
