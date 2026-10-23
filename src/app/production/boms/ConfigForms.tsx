'use client';

import { useActionState } from 'react';

import { saveItemCategoryAction, saveStatusAction, saveUsageAction, type BomActionState } from './actions';

const INITIAL: BomActionState = { ok: false };

function Note({ state }: { state: BomActionState }) {
  if (!state.message) return null;
  return <p role="status" className={`text-sm ${state.ok ? 'text-ink' : 'text-red-700'}`}>{state.message}</p>;
}

export function UsageForm() {
  const [state, action, pending] = useActionState(saveUsageAction, INITIAL);
  return (
    <form action={action} className="panel space-y-3 p-4">
      <h2 className="text-sm font-semibold">Usage</h2>
      <p className="text-sm text-ink-soft">No usage such as 1 is delivered. Relevance is stored as +, ., or -. It is not executed.</p>
      <Note state={state} />
      <div className="grid gap-3 sm:grid-cols-2">
        <input className="input" name="usage" maxLength={1} placeholder="Usage" required aria-label="Usage" />
        <input className="input" name="description" maxLength={40} placeholder="Description" required aria-label="Usage description" />
      </div>
      <div className="grid gap-3 sm:grid-cols-4">
        {['productionRelevance', 'engineeringRelevance', 'costingRelevance', 'salesRelevance'].map((name) => (
          <label key={name} className="text-sm">{name}
            <select className="input mt-1 w-full" name={name} defaultValue="." aria-label={name}>
              <option value="+">+ required</option>
              <option value=".">. optional</option>
              <option value="-">- not allowed</option>
            </select>
          </label>
        ))}
      </div>
      <button className="btn btn-default min-h-11 sm:min-h-8" type="submit" disabled={pending}>Save usage</button>
    </form>
  );
}

export function StatusForm() {
  const [state, action, pending] = useActionState(saveStatusAction, INITIAL);
  return (
    <form action={action} className="panel space-y-3 p-4">
      <h2 className="text-sm font-semibold">Status</h2>
      <p className="text-sm text-ink-soft">A release flag is stored. Planning, costing, and order creation do not read it from this screen.</p>
      <Note state={state} />
      <div className="grid gap-3 sm:grid-cols-2">
        <input className="input" name="status" maxLength={2} placeholder="Status" required aria-label="Status" />
        <input className="input" name="description" maxLength={40} placeholder="Description" required aria-label="Status description" />
      </div>
      <div className="flex flex-wrap gap-4 text-sm">
        <label className="flex items-center gap-2"><input type="checkbox" name="releasedForMrp" value="X" /> Released for MRP</label>
        <label className="flex items-center gap-2"><input type="checkbox" name="releasedForCosting" value="X" /> Released for costing</label>
        <label className="flex items-center gap-2"><input type="checkbox" name="releasedForOrders" value="X" /> Released for orders</label>
      </div>
      <button className="btn btn-default min-h-11 sm:min-h-8" type="submit" disabled={pending}>Save status</button>
    </form>
  );
}

export function ItemCategoryForm() {
  const [state, action, pending] = useActionState(saveItemCategoryAction, INITIAL);
  return (
    <form action={action} className="panel space-y-3 p-4">
      <h2 className="text-sm font-semibold">Item category</h2>
      <p className="text-sm text-ink-soft">Material and quantity entry use + required, . optional, or - not allowed. No category L is delivered.</p>
      <Note state={state} />
      <div className="grid gap-3 sm:grid-cols-2">
        <input className="input" name="category" maxLength={1} placeholder="Category" required aria-label="Item category" />
        <input className="input" name="description" maxLength={40} placeholder="Description" required aria-label="Item category description" />
        <label className="text-sm">Material entry
          <select className="input mt-1 w-full" name="materialEntry" defaultValue="+" aria-label="Material entry">
            <option value="+">+ required</option>
            <option value=".">. optional</option>
            <option value="-">- not allowed</option>
          </select>
        </label>
        <label className="text-sm">Quantity entry
          <select className="input mt-1 w-full" name="quantityEntry" defaultValue="+" aria-label="Quantity entry">
            <option value="+">+ required</option>
            <option value=".">. optional</option>
            <option value="-">- not allowed</option>
          </select>
        </label>
      </div>
      <div className="flex flex-wrap gap-4 text-sm">
        <label className="flex items-center gap-2"><input type="checkbox" name="allowFixedQuantity" value="X" /> Fixed quantity</label>
        <label className="flex items-center gap-2"><input type="checkbox" name="allowBulk" value="X" /> Bulk</label>
        <label className="flex items-center gap-2"><input type="checkbox" name="allowPhantom" value="X" /> Phantom</label>
        <label className="flex items-center gap-2"><input type="checkbox" name="allowCoproduct" value="X" /> Co-product</label>
        <label className="flex items-center gap-2"><input type="checkbox" name="allowFollowUp" value="X" /> Follow-up</label>
        <label className="flex items-center gap-2"><input type="checkbox" name="allowSpecialProcurement" value="X" /> Special procurement</label>
        <label className="flex items-center gap-2"><input type="checkbox" name="allowNegativeQuantity" value="X" /> Negative quantity</label>
      </div>
      <button className="btn btn-default min-h-11 sm:min-h-8" type="submit" disabled={pending}>Save item category</button>
    </form>
  );
}
