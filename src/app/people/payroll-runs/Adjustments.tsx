'use client';

import { useActionState } from 'react';

import {
  cancelAdjustmentAction,
  decideAdjustmentAction,
  enterAdjustmentAction,
  type AdjustmentActionState,
} from './adjustment-actions';

function Status({ state }: { state: AdjustmentActionState }) {
  if (!state.message) return null;
  return (
    <p role="status" className={`text-sm ${state.ok ? 'text-ink' : 'text-signal-error'}`}>
      {state.message}{state.remedy ? ` ${state.remedy}` : ''}
    </p>
  );
}

/** Enter a one-time adjustment. Employee and component are typed freely (suggestions only); the server validates on save. */
export function EnterAdjustmentForm({
  companies,
  defaultCompany,
  defaultYear,
  defaultPeriod,
  components,
  employees,
  requestKey,
}: {
  companies: string[];
  defaultCompany: string;
  defaultYear: number;
  defaultPeriod: number;
  components: Array<{ code: string; name: string; componentKind: string }>;
  employees: string[];
  requestKey: string;
}) {
  const [state, action, pending] = useActionState(enterAdjustmentAction, { ok: false, requestKey });
  return (
    <form action={action} className="space-y-3">
      <input type="hidden" name="requestKey" value={state.requestKey ?? requestKey} />
      <div className="grid gap-3 sm:grid-cols-4">
        <label>
          <span className="field-label">Company</span>
          <input name="companyCode" className="field-input code" required maxLength={4} defaultValue={defaultCompany} list="adj-companies" />
          <datalist id="adj-companies">{companies.map((c) => <option key={c} value={c} />)}</datalist>
        </label>
        <label>
          <span className="field-label">Fiscal year</span>
          <input name="fiscalYear" className="field-input code" required inputMode="numeric" defaultValue={defaultYear} />
        </label>
        <label>
          <span className="field-label">Period</span>
          <input name="period" className="field-input code" required inputMode="numeric" defaultValue={defaultPeriod} />
        </label>
        <label>
          <span className="field-label">Employee (personnel number)</span>
          <input name="personnelNumber" className="field-input code" required list="adj-employees" />
          <datalist id="adj-employees">{employees.map((e) => <option key={e} value={e} />)}</datalist>
        </label>
        <label>
          <span className="field-label">Pay component</span>
          <input name="componentCode" className="field-input code" required list="adj-components" />
          <datalist id="adj-components">{components.map((c) => <option key={c.code} value={c.code}>{c.name} ({c.componentKind})</option>)}</datalist>
        </label>
        <label>
          <span className="field-label">Amount (payroll currency, fixed, positive)</span>
          <input name="amount" className="field-input code" required inputMode="decimal" />
        </label>
        <label className="sm:col-span-2">
          <span className="field-label">Reason (required)</span>
          <input name="reason" className="field-input w-full" required maxLength={200} />
        </label>
        <label>
          <span className="field-label">Source reference (optional)</span>
          <input name="sourceReference" className="field-input" maxLength={100} />
        </label>
        <label className="sm:col-span-3">
          <span className="field-label">Corrects result (optional result id of an earlier period)</span>
          <input name="correctsResultId" className="field-input code w-full" maxLength={36} />
        </label>
      </div>
      <p className="text-xs text-ink-soft">
        Not prorated and not recurring. A correction is a separately approved offsetting entry with the opposite component, in a later period; negative amounts do not exist,
        and an employer-contribution correction is refused here — use a manual accounting entry.
      </p>
      <button type="submit" className="btn btn-primary min-h-11 sm:min-h-8" disabled={pending}>Enter adjustment</button>
      <Status state={state} />
    </form>
  );
}

export function AdjustmentRowActions({ adjustmentId, status, mayApprove, mayCancel, isCreator }: {
  adjustmentId: string; status: string; mayApprove: boolean; mayCancel: boolean; isCreator: boolean;
}) {
  const [decided, decideAction, decidePending] = useActionState(decideAdjustmentAction, { ok: false });
  const [cancelled, cancelAction, cancelPending] = useActionState(cancelAdjustmentAction, { ok: false });
  return (
    <div className="space-y-2">
      {status === 'PENDING' && mayApprove && !isCreator && (
        <form action={decideAction} className="flex flex-wrap items-center gap-2">
          <input type="hidden" name="adjustmentId" value={adjustmentId} />
          <input name="note" className="field-input" placeholder="Note (required to reject)" maxLength={200} aria-label="Decision note" />
          <button type="submit" name="decision" value="APPROVE" className="btn btn-primary min-h-11 sm:min-h-8" disabled={decidePending}>Approve</button>
          <button type="submit" name="decision" value="REJECT" className="btn btn-default min-h-11 sm:min-h-8" disabled={decidePending}>Reject</button>
        </form>
      )}
      {status === 'PENDING' && isCreator && <p className="text-xs text-ink-soft">You entered this; someone else must approve it.</p>}
      {(status === 'PENDING' || status === 'APPROVED') && mayCancel && (
        <form action={cancelAction} className="flex flex-wrap items-center gap-2">
          <input type="hidden" name="adjustmentId" value={adjustmentId} />
          <input name="reason" className="field-input" placeholder="Reason for cancelling" required maxLength={200} aria-label="Cancel reason" />
          <button type="submit" className="btn btn-default min-h-11 sm:min-h-8" disabled={cancelPending}>Cancel</button>
        </form>
      )}
      <Status state={decided} />
      <Status state={cancelled} />
    </div>
  );
}
