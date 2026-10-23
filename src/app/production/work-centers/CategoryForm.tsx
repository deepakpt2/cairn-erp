'use client';

import { useActionState } from 'react';

import type { WorkCenterActionState } from './actions';

export function CategoryForm({
  action,
  initial,
}: {
  action: (previous: WorkCenterActionState, formData: FormData) => Promise<WorkCenterActionState>;
  initial: WorkCenterActionState;
}) {
  const [state, formAction, pending] = useActionState(action, initial);
  return (
    <form action={formAction} className="panel space-y-3 p-4">
      <h2 className="text-sm font-semibold">Category</h2>
      <p className="text-sm text-ink-soft">A category is defined here. No category such as 0001 is delivered. Required sections are not mandatory for every category.</p>
      {state.message && <p role="status" className={`text-sm ${state.ok ? 'text-ink' : 'text-red-700'}`}>{state.message}</p>}
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="block text-sm">
          <span className="field-label">Category</span>
          <input className="input mt-1 w-full" name="category" maxLength={4} required />
        </label>
        <label className="block text-sm">
          <span className="field-label">Description</span>
          <input className="input mt-1 w-full" name="description" maxLength={40} required />
        </label>
      </div>
      <div className="flex flex-wrap gap-4 text-sm">
        <label className="flex items-center gap-2"><input type="checkbox" name="requireCapacity" value="X" /> Capacity required</label>
        <label className="flex items-center gap-2"><input type="checkbox" name="requireScheduling" value="X" /> Scheduling required</label>
        <label className="flex items-center gap-2"><input type="checkbox" name="requireCosting" value="X" /> Costing required</label>
        <label className="flex items-center gap-2"><input type="checkbox" name="requireStandardValueKey" value="X" /> Standard value key required</label>
      </div>
      <button className="btn btn-default min-h-11 sm:min-h-8" type="submit" disabled={pending}>Save category</button>
    </form>
  );
}
