'use client';

import { useActionState } from 'react';

import type { SplitCriterionView } from '@/modules/sales/billing';
import { setSplitCriterionAction, type BillingSplitActionState } from './actions';

const INITIAL: BillingSplitActionState = { ok: false, message: '' };

/**
 * One criterion, and the switch that says whether the run reads it.
 *
 * The form is per row rather than one form for the table, because the act is per criterion: a tenant
 * turns on what it bills by and leaves the rest alone, and a single submit that rewrote all five from
 * whatever the browser happened to render would silently withdraw what somebody had switched on.
 */
function CriterionRow({
  row, canMaintain,
}: { row: SplitCriterionView; canMaintain: boolean }) {
  const [state, action, pending] = useActionState(setSplitCriterionAction, INITIAL);

  return (
    <tr>
      <td className="font-mono">{row.criterion}</td>
      <td>{row.displayName}</td>
      <td className="text-ink-soft">{row.meaning}</td>
      <td>
        {row.isActive ? (
          <span className="font-medium">
            Splits{row.position > 1 ? ` · ${row.position} of the run` : ''}
          </span>
        ) : (
          <span className="text-ink-faint">Not maintained</span>
        )}
      </td>
      <td>
        {canMaintain ? (
          <form action={action} className="flex items-center gap-2">
            <input type="hidden" name="criterion" value={row.criterion} />
            <input type="hidden" name="isActive" value={row.isActive ? 'no' : 'yes'} />
            <button type="submit" className="btn btn-default min-h-11 sm:min-h-8" disabled={pending}>
              {pending ? 'Saving…' : row.isActive ? 'Withdraw' : 'Maintain'}
            </button>
            {state.message ? (
              <span role="status" className={`text-xs ${state.ok ? 'text-ink' : 'text-red-700'}`}>
                {state.message}
              </span>
            ) : null}
          </form>
        ) : null}
      </td>
    </tr>
  );
}

export function BillingSplit({
  criteria, canMaintain,
}: { criteria: SplitCriterionView[]; canMaintain: boolean }) {
  return (
    <section aria-labelledby="billing-split-list" className="border border-line bg-surface p-4">
      <h2 id="billing-split-list" className="text-sm font-semibold">The criteria as they stand</h2>
      <div className="mt-3 overflow-x-auto">
        <table className="grid-table text-left text-sm">
          <thead>
            <tr className="text-xs uppercase tracking-wide text-ink-faint">
              <th>Field</th><th>Criterion</th><th>What it separates</th><th>Stands</th>
              <th>{canMaintain ? 'What it does' : ''}</th>
            </tr>
          </thead>
          <tbody>
            {criteria.map((row) => (
              <CriterionRow key={row.criterion} row={row} canMaintain={canMaintain} />
            ))}
          </tbody>
        </table>
      </div>
      <p className="mt-3 max-w-3xl text-xs text-ink-faint">
        Where a field no criterion names differs between two deliveries of one group, the value the first
        delivery carried answers for the whole document — which is why the billing screen shows the groups
        the run will raise before it raises them.
      </p>
    </section>
  );
}
