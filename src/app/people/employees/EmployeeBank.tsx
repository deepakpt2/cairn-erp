'use client';

import { useActionState, useState } from 'react';

import {
  addBankAction,
  endBankAction,
  revealBankAction,
  type BankActionState,
} from './bank-actions';

function Status({ state }: { state: BankActionState }) {
  if (!state.message) return null;
  return (
    <p role="status" className={`text-sm ${state.ok ? 'text-ink' : 'text-signal-error'}`}>
      {state.message}{state.remedy ? ` ${state.remedy}` : ''}
      {state.revealed ? <span className="code ml-2">{state.revealed}</span> : null}
    </p>
  );
}

const today = () => new Date().toISOString().slice(0, 10);

/** Create a new effective-dated main bank account for the employee. */
export function AddBankForm({ personnelNumber }: { personnelNumber: string }) {
  const [state, action, pending] = useActionState(addBankAction, { ok: false });
  const [kind, setKind] = useState<'IBAN' | 'ACCOUNT'>('IBAN');
  return (
    <form action={action} className="space-y-3 border-t border-line pt-3">
      <h3 className="text-sm font-semibold">Add a bank account</h3>
      <input type="hidden" name="personnelNumber" value={personnelNumber} />
      <div className="grid gap-3 sm:grid-cols-2">
        <label>
          <span className="field-label">Beneficiary name</span>
          <input name="beneficiaryName" className="field-input w-full" required maxLength={160} placeholder="As the bank should read it" />
        </label>
        <label>
          <span className="field-label">Bank name</span>
          <input name="bankName" className="field-input w-full" required maxLength={160} />
        </label>
        <label>
          <span className="field-label">Bank / routing code (optional)</span>
          <input name="bankCode" className="field-input w-full" maxLength={40} />
        </label>
        <label>
          <span className="field-label">Country (optional)</span>
          <input name="country" className="field-input w-full code" maxLength={2} placeholder="e.g. KW" />
        </label>
        <label>
          <span className="field-label">Identifier kind</span>
          <select name="accountKind" className="field-input w-full" value={kind} onChange={(e) => setKind(e.target.value as 'IBAN' | 'ACCOUNT')}>
            <option value="IBAN">IBAN</option>
            <option value="ACCOUNT">Account number</option>
          </select>
        </label>
        <label>
          <span className="field-label">{kind === 'IBAN' ? 'IBAN' : 'Account number'}</span>
          <input name="accountValue" className="field-input w-full code" required maxLength={64} autoComplete="off" />
        </label>
        <label>
          <span className="field-label">Valid from</span>
          <input type="date" name="validFrom" className="field-input w-full" required defaultValue={today()} />
        </label>
        <label>
          <span className="field-label">Valid to (optional)</span>
          <input type="date" name="validTo" className="field-input w-full" />
        </label>
      </div>
      <p className="text-xs text-ink-soft">
        One main account at a time. A later account means a new record: end the current one on the day before, then add this
        one. The account number or IBAN is stored encrypted and shown masked; revealing it in full is audited.
      </p>
      <button type="submit" className="btn btn-default min-h-11 sm:min-h-8" disabled={pending}>Add account</button>
      <Status state={state} />
    </form>
  );
}

/** End an active record on a date; the record stays readable as history. */
export function EndBankForm({ bankRecordId, defaultEnd }: { bankRecordId: string; defaultEnd: string }) {
  const [state, action, pending] = useActionState(endBankAction, { ok: false });
  return (
    <form action={action} className="flex flex-wrap items-end gap-2">
      <input type="hidden" name="bankRecordId" value={bankRecordId} />
      <label>
        <span className="field-label">End on</span>
        <input type="date" name="validTo" className="field-input" defaultValue={defaultEnd} required />
      </label>
      <button type="submit" className="btn btn-default min-h-11 sm:min-h-8" disabled={pending}>End</button>
      <Status state={state} />
    </form>
  );
}

/** Reveal the full account value for one record, with a required purpose. Audited server-side. */
export function RevealBank({ bankRecordId }: { bankRecordId: string }) {
  const [state, action, pending] = useActionState(revealBankAction, { ok: false });
  return (
    <form action={action} className="flex flex-wrap items-end gap-2">
      <input type="hidden" name="bankRecordId" value={bankRecordId} />
      <label>
        <span className="field-label">Purpose</span>
        <select name="purpose" className="field-input">
          <option value="PAYROLL_SUPPORT">Payroll support</option>
          <option value="DATA_CORRECTION">Data correction</option>
          <option value="AUDIT_REVIEW">Audit review</option>
        </select>
      </label>
      <button type="submit" className="btn btn-default min-h-11 sm:min-h-8" disabled={pending}>Reveal</button>
      <Status state={state} />
    </form>
  );
}
