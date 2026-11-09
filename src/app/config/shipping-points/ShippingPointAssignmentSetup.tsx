'use client';

import { useActionState, useState } from 'react';

import {
  assignShippingPointAction,
  changeShippingPointAssignmentAction,
  type ShippingPointActionState,
} from './actions';
import type { ShippingPointAssignmentRow } from '@/modules/sales/shipping-point-maintenance';

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

export interface AssignmentChoice {
  plants: Array<{ plant: string; name: string | null }>;
  points: Array<{ shippingPoint: string; name: string }>;
  conditions: Array<{ shippingCondition: string; description: string }>;
  /** The loading groups materials carry, so a row is not typed from memory. */
  loadingGroups: string[];
}

/** Say which dock a plant loads each kind of goods through, and withdraw a row that no longer holds. */
export function ShippingPointAssignmentSetup({
  rows,
  choices,
}: {
  rows: ShippingPointAssignmentRow[];
  choices: AssignmentChoice;
}) {
  const [assignState, assignForm, assignPending] = useActionState(assignShippingPointAction, INITIAL);
  const [changeState, changeForm, changePending] = useActionState(changeShippingPointAssignmentAction, INITIAL);
  const [selected, setSelected] = useState('');
  const key = (row: ShippingPointAssignmentRow) =>
    `${row.deliveringPlant}/${row.shippingCondition}/${row.loadingGroup}`;
  const row = rows.find((candidate) => key(candidate) === selected);

  return (
    <div className="space-y-4">
      <section aria-labelledby="assignment-maintain" className="border border-line bg-surface p-4">
        <h2 id="assignment-maintain" className="text-sm font-semibold">Assign a dock to a plant</h2>
        <p className="mt-1 max-w-3xl text-sm text-ink-soft">
          One row per plant, shipping condition and loading group. A part left blank answers for every value
          of that part, and the most specific row that fits is the one that loads — so this plant can have a
          row for everything it ships and a second row for the one customer who needs it faster.
        </p>
        <form action={assignForm} className="mt-3 grid gap-3 sm:grid-cols-4">
          <Field label="Delivering plant">
            <select name="deliveringPlant" className="field-input code">
              {choices.plants.length === 0 ? <option value="">No active plant stands</option> : null}
              {choices.plants.map((site) => (
                <option key={site.plant} value={site.plant}>
                  {site.plant}{site.name ? ` · ${site.name}` : ''}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Shipping condition" help="Blank answers for every customer, however they want their goods.">
            <select name="shippingCondition" defaultValue="" className="field-input code">
              <option value="">(any)</option>
              {choices.conditions.map((condition) => (
                <option key={condition.shippingCondition} value={condition.shippingCondition}>
                  {condition.shippingCondition} · {condition.description}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Loading group" help="Blank answers for every material.">
            <input
              name="loadingGroup"
              maxLength={4}
              pattern="[A-Za-z0-9]{0,4}"
              list="loading-groups"
              className="field-input code"
              placeholder="(any)"
            />
          </Field>
          <Field label="Loads through">
            <select name="shippingPoint" className="field-input code">
              {choices.points.length === 0 ? <option value="">No shipping point stands</option> : null}
              {choices.points.map((point) => (
                <option key={point.shippingPoint} value={point.shippingPoint}>
                  {point.shippingPoint} · {point.name}
                </option>
              ))}
            </select>
          </Field>
          <datalist id="loading-groups">
            {choices.loadingGroups.map((group) => <option key={group} value={group} />)}
          </datalist>
          <div className="sm:col-span-4">
            <button type="submit" className="btn btn-primary min-h-11 sm:min-h-8" disabled={assignPending}>
              {assignPending ? 'Saving…' : 'Assign the dock'}
            </button>
          </div>
        </form>
        <Notice state={assignState} />
      </section>

      <section aria-labelledby="assignment-withdraw" className="border border-line bg-surface p-4">
        <h2 id="assignment-withdraw" className="text-sm font-semibold">Withdraw a row, or restore one</h2>
        <p className="mt-1 max-w-3xl text-sm text-ink-soft">
          A withdrawn row stops answering, so a delivery of that combination is refused and names this
          screen. Nothing is deleted: a row here is the rule a delivery was raised under.
        </p>
        {rows.length === 0 ? (
          <p className="mt-3 text-sm text-ink-soft">No plant is assigned a dock, so no delivery can be raised.</p>
        ) : (
          <form action={changeForm} className="mt-3 flex flex-wrap items-end gap-3">
            <Field label="The row">
              <select
                name="row"
                value={selected}
                onChange={(event) => setSelected(event.currentTarget.value)}
                className="field-input code"
              >
                <option value="">Choose a row</option>
                {rows.map((candidate) => (
                  <option key={key(candidate)} value={key(candidate)}>
                    {candidate.deliveringPlant}/{candidate.shippingCondition || 'any'}/
                    {candidate.loadingGroup || 'any'} → {candidate.shippingPoint}
                  </option>
                ))}
              </select>
            </Field>
            {row ? (
              <>
                <input type="hidden" name="deliveringPlant" value={row.deliveringPlant} />
                <input type="hidden" name="shippingCondition" value={row.shippingCondition} />
                <input type="hidden" name="loadingGroup" value={row.loadingGroup} />
                <input type="hidden" name="isActive" value={row.isActive ? 'false' : 'true'} />
                <button type="submit" className="btn btn-default min-h-11 sm:min-h-8" disabled={changePending}>
                  {changePending ? 'Saving…' : row.isActive ? 'Withdraw this row' : 'Let this row answer again'}
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
