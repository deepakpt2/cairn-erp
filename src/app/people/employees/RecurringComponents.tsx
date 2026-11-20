'use client';

import { useActionState } from 'react';

import {
  addComponentAction,
  endComponentAction,
  withdrawComponentAction,
  type ComponentActionState,
} from './component-actions';

function Status({ state }: { state: ComponentActionState }) {
  if (!state.message) return null;
  return (
    <p role="status" className={`text-sm ${state.ok ? 'text-ink' : 'text-signal-error'}`}>
      {state.message}{state.remedy ? ` ${state.remedy}` : ''}
    </p>
  );
}

/**
 * Add a recurring component for this employee. Nothing is pre-selected for the two decisions that change pay:
 * add-versus-replace and the proration policy. Component codes are typed freely (suggestions only); the server validates on save.
 */
export function AddComponentForm({
  personnelNumber,
  components,
  defaultCurrency,
  today,
  requestKey,
}: {
  personnelNumber: string;
  components: Array<{ code: string; name: string; componentKind: string }>;
  defaultCurrency: string;
  today: string;
  requestKey: string;
}) {
  const [state, action, pending] = useActionState(addComponentAction, { ok: false, requestKey });
  return (
    <form action={action} className="space-y-3">
      <input type="hidden" name="personnelNumber" value={personnelNumber} />
      <input type="hidden" name="requestKey" value={state.requestKey ?? requestKey} />
      <div className="grid gap-3 sm:grid-cols-4">
        <label>
          <span className="field-label">Pay component</span>
          <input name="componentCode" className="field-input code" required list="emp-components" />
          <datalist id="emp-components">{components.map((c) => <option key={c.code} value={c.code}>{c.name} ({c.componentKind})</option>)}</datalist>
        </label>
        <label>
          <span className="field-label">Relation to the salary structure</span>
          <select name="mode" className="field-input" required defaultValue="">
            <option value="" disabled>Choose…</option>
            <option value="ADD">Add — a separate line beside the structure</option>
            <option value="REPLACE">Replace — suppress this component’s structure rule on these dates</option>
          </select>
        </label>
        <label>
          <span className="field-label">Calculation</span>
          <select name="amountKind" className="field-input" required defaultValue="">
            <option value="" disabled>Choose…</option>
            <option value="FIXED">Fixed amount per payroll period</option>
            <option value="PERCENT_OF_BASE">Percent of the employee’s assigned base salary</option>
          </select>
        </label>
        <label>
          <span className="field-label">Value (amount, or percent 0–100)</span>
          <input name="amountValue" className="field-input code" required inputMode="decimal" />
        </label>
        <label>
          <span className="field-label">Currency</span>
          <input name="currency" className="field-input code" required maxLength={3} defaultValue={defaultCurrency} />
        </label>
        <label>
          <span className="field-label">Valid from</span>
          <input type="date" name="validFrom" className="field-input" required defaultValue={today} />
        </label>
        <label>
          <span className="field-label">Valid to (optional, last day)</span>
          <input type="date" name="validTo" className="field-input" />
        </label>
        <label>
          <span className="field-label">Proration</span>
          <select name="prorationPolicy" className="field-input" required defaultValue="">
            <option value="" disabled>Choose…</option>
            <option value="PAYABLE_CALENDAR_DAYS">Payable calendar days (less approved unpaid leave)</option>
            <option value="NO_UNPAID_LEAVE_REDUCTION">Covered days, unpaid leave not deducted</option>
            <option value="FULL_PERIOD">Full period, applied once</option>
          </select>
        </label>
        <label className="sm:col-span-4">
          <span className="field-label">Reason (required)</span>
          <input name="reason" className="field-input w-full" required maxLength={200} />
        </label>
      </div>
      <p className="text-xs text-ink-soft">
        A percentage is a percentage of the assigned base salary only — not taxable gross, and not all earnings. Where the legal base is different, enter an externally calculated fixed amount.
        Rates and bases are the company’s to determine and keep current.
      </p>
      <button type="submit" className="btn btn-primary min-h-11 sm:min-h-8" disabled={pending}>Add component</button>
      <Status state={state} />
    </form>
  );
}

export function EntryActions({ entryId, defaultEnd }: { entryId: string; defaultEnd: string }) {
  const [ended, endAction, endPending] = useActionState(endComponentAction, { ok: false });
  const [withdrawn, withdrawAction, withdrawPending] = useActionState(withdrawComponentAction, { ok: false });
  return (
    <div className="space-y-2">
      <form action={endAction} className="flex flex-wrap items-center gap-2">
        <input type="hidden" name="entryId" value={entryId} />
        <input type="date" name="validTo" className="field-input" required defaultValue={defaultEnd} aria-label="Last day" />
        <input name="reason" className="field-input" placeholder="Reason" required maxLength={200} aria-label="Reason" />
        <button type="submit" className="btn btn-default min-h-11 sm:min-h-8" disabled={endPending}>End</button>
      </form>
      <form action={withdrawAction} className="flex flex-wrap items-center gap-2">
        <input type="hidden" name="entryId" value={entryId} />
        <input name="reason" className="field-input" placeholder="Reason" required maxLength={200} aria-label="Withdraw reason" />
        <button type="submit" className="btn btn-default min-h-11 sm:min-h-8" disabled={withdrawPending}>Withdraw</button>
      </form>
      <Status state={ended} />
      <Status state={withdrawn} />
    </div>
  );
}
