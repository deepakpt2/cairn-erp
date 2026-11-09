'use client';

import { useActionState, useState } from 'react';

import {
  changeShippingConditionAction,
  defineShippingConditionAction,
  type ShippingPointActionState,
} from './actions';
import type { ShippingConditionRow } from '@/modules/sales/shipping-point-maintenance';

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

/** Name the ways a customer can want goods to arrive, and withdraw one nobody may ask for. */
export function ShippingConditionSetup({ rows }: { rows: ShippingConditionRow[] }) {
  const [defineState, defineForm, definePending] = useActionState(defineShippingConditionAction, INITIAL);
  const [changeState, changeForm, changePending] = useActionState(changeShippingConditionAction, INITIAL);
  const [selected, setSelected] = useState('');
  const row = rows.find((candidate) => candidate.shippingCondition === selected);

  return (
    <div className="space-y-4">
      <section aria-labelledby="condition-maintain" className="border border-line bg-surface p-4">
        <h2 id="condition-maintain" className="text-sm font-semibold">Name what a customer can ask for</h2>
        <p className="mt-1 max-w-3xl text-sm text-ink-soft">
          A shipping condition is a way of wanting goods to arrive: express, standard, collect. It is the
          customer&apos;s half of the determination, and it is maintained on that customer&apos;s own sales
          area. The description is what makes the two characters on the customer readable.
        </p>
        <form action={defineForm} className="mt-3 grid gap-3 sm:grid-cols-3">
          <Field label="Shipping condition" help="One or two capital letters or digits.">
            <input
              name="shippingCondition"
              maxLength={2}
              pattern="[A-Za-z0-9]{1,2}"
              className="field-input code"
              placeholder="01"
            />
          </Field>
          <Field label="What it means" help="What the customer is asking for when they carry it.">
            <input name="description" maxLength={40} className="field-input" placeholder="Express, next day" />
          </Field>
          <div className="flex items-end">
            <button type="submit" className="btn btn-primary min-h-11 sm:min-h-8" disabled={definePending}>
              {definePending ? 'Saving…' : 'Name the condition'}
            </button>
          </div>
        </form>
        <Notice state={defineState} />
      </section>

      <section aria-labelledby="condition-withdraw" className="border border-line bg-surface p-4">
        <h2 id="condition-withdraw" className="text-sm font-semibold">Withdraw a condition, or restore one</h2>
        <p className="mt-1 max-w-3xl text-sm text-ink-soft">
          A withdrawn condition is one nobody may ask for: a customer still carrying it is refused by name
          rather than treated as a customer who said nothing.
        </p>
        {rows.length === 0 ? (
          <p className="mt-3 text-sm text-ink-soft">
            No shipping condition stands. Customers can still be maintained with none, and the rows naming
            no condition answer for them.
          </p>
        ) : (
          <form action={changeForm} className="mt-3 flex flex-wrap items-end gap-3">
            <Field label="The condition">
              <select
                name="shippingCondition"
                value={selected}
                onChange={(event) => setSelected(event.currentTarget.value)}
                className="field-input code"
              >
                <option value="">Choose a condition</option>
                {rows.map((candidate) => (
                  <option key={candidate.shippingCondition} value={candidate.shippingCondition}>
                    {candidate.shippingCondition} · {candidate.description}
                    {candidate.carriers > 0 ? ` (${candidate.carriers} customer${candidate.carriers === 1 ? '' : 's'})` : ''}
                  </option>
                ))}
              </select>
            </Field>
            {row ? (
              <>
                <input type="hidden" name="isActive" value={row.isActive ? 'false' : 'true'} />
                <button type="submit" className="btn btn-default min-h-11 sm:min-h-8" disabled={changePending}>
                  {changePending ? 'Saving…' : row.isActive ? 'Withdraw this condition' : 'Let this condition stand again'}
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
