'use client';

import { useActionState, useState } from 'react';

import {
  changeShippingPointAction,
  defineShippingPointAction,
  type ShippingPointActionState,
} from './actions';
import type { ShippingPointRow } from '@/modules/sales/shipping-point-maintenance';

const INITIAL: ShippingPointActionState = { ok: false, message: '' };

function Notice({ state }: { state: ShippingPointActionState }) {
  if (!state.message) return null;
  return (
    <p role="status" className={`mt-3 text-sm ${state.ok ? 'text-ink' : 'text-red-700'}`}>
      {state.message}
      {state.remedy ? ` ${state.remedy}` : ''}
    </p>
  );
}

function Field({ label, help, children }: { label: string; help?: string; children: React.ReactNode }) {
  return (
    <label className="block text-sm">
      <span className="mb-1 block font-medium">{label}</span>
      {children}
      {help ? <span className="mt-1 block text-xs text-ink-faint">{help}</span> : null}
    </label>
  );
}

/** Name the places goods are loaded from, and withdraw one that has stopped loading. */
export function ShippingPointSetup({ rows }: { rows: ShippingPointRow[] }) {
  const [defineState, defineForm, definePending] = useActionState(defineShippingPointAction, INITIAL);
  const [changeState, changeForm, changePending] = useActionState(changeShippingPointAction, INITIAL);
  const [selected, setSelected] = useState('');
  const row = rows.find((candidate) => candidate.shippingPoint === selected);

  return (
    <div className="space-y-4">
      <section aria-labelledby="dock-maintain" className="border border-line bg-surface p-4">
        <h2 id="dock-maintain" className="text-sm font-semibold">Name a dock</h2>
        <p className="mt-1 max-w-3xl text-sm text-ink-soft">
          A shipping point is a place: a dock, a depot, a gate. It carries no plant of its own — which
          plant it loads from is what the assignment below says, and one dock may serve several plants.
        </p>
        <form action={defineForm} className="mt-3 grid gap-3 sm:grid-cols-3">
          <Field label="Shipping point" help="Up to four capital letters or digits.">
            <input
              name="shippingPoint"
              maxLength={4}
              pattern="[A-Za-z0-9]{1,4}"
              className="field-input code"
              placeholder="1200"
            />
          </Field>
          <Field label="What it is" help="The place a reader would look for it.">
            <input name="name" maxLength={40} className="field-input" placeholder="East dock" />
          </Field>
          <div className="flex items-end">
            <button type="submit" className="btn btn-primary min-h-11 sm:min-h-8" disabled={definePending}>
              {definePending ? 'Saving…' : 'Name the dock'}
            </button>
          </div>
        </form>
        <Notice state={defineState} />
      </section>

      <section aria-labelledby="dock-withdraw" className="border border-line bg-surface p-4">
        <h2 id="dock-withdraw" className="text-sm font-semibold">Withdraw a dock, or restore one</h2>
        <p className="mt-1 max-w-3xl text-sm text-ink-soft">
          A withdrawn dock loads nothing, so a delivery assigned to it is refused and names this screen.
          Nothing is deleted: a shipping point is part of the rule a delivery was raised under.
        </p>
        {rows.length === 0 ? (
          <p className="mt-3 text-sm text-ink-soft">No shipping point stands, so no delivery can be raised at all.</p>
        ) : (
          <form action={changeForm} className="mt-3 flex flex-wrap items-end gap-3">
            <Field label="The dock">
              <select
                name="shippingPoint"
                value={selected}
                onChange={(event) => setSelected(event.currentTarget.value)}
                className="field-input code"
              >
                <option value="">Choose a shipping point</option>
                {rows.map((candidate) => (
                  <option key={candidate.shippingPoint} value={candidate.shippingPoint}>
                    {candidate.shippingPoint} · {candidate.name}
                  </option>
                ))}
              </select>
            </Field>
            {row ? (
              <>
                <input type="hidden" name="isActive" value={row.isActive ? 'false' : 'true'} />
                <button type="submit" className="btn btn-default min-h-11 sm:min-h-8" disabled={changePending}>
                  {changePending ? 'Saving…' : row.isActive ? 'Withdraw this dock' : 'Let this dock load again'}
                </button>
              </>
            ) : null}
          </form>
        )}
        <Notice state={changeState} />
      </section>
    </div>
  );
}
