'use client';

import { useActionState } from 'react';

import {
  changeStructureAction,
  defineStructureAction,
  removeComponentAction,
  setComponentAction,
  type PayrollActionState,
} from './actions';

function Status({ state }: { state: PayrollActionState }) {
  if (!state.message) return null;
  return (
    <p role="status" className={`text-sm ${state.ok ? 'text-ink' : 'text-signal-error'}`}>
      {state.message}{state.remedy ? ` ${state.remedy}` : ''}
    </p>
  );
}

export function DefineStructureForm({ defaultCurrency, today }: { defaultCurrency: string; today: string }) {
  const [state, action, pending] = useActionState(defineStructureAction, { ok: false });
  return (
    <form action={action} className="panel space-y-3 p-4">
      <h2 className="panel-title">Define a structure</h2>
      <div className="grid gap-3 sm:grid-cols-5">
        <label>
          <span className="field-label">Code</span>
          <input name="code" className="field-input code" required maxLength={10} placeholder="STAFF" />
        </label>
        <label className="sm:col-span-2">
          <span className="field-label">Name</span>
          <input name="name" className="field-input w-full" required maxLength={60} />
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
      </div>
      <button type="submit" className="btn btn-primary min-h-11 sm:min-h-8" disabled={pending}>Define</button>
      <Status state={state} />
    </form>
  );
}

export function ChangeStructureForm({ code, name, validTo, isValid }: { code: string; name: string; validTo: string | null; isValid: boolean }) {
  const [state, action, pending] = useActionState(changeStructureAction, { ok: false });
  return (
    <form action={action} className="panel space-y-3 p-4">
      <h2 className="panel-title">Change {code}</h2>
      <input type="hidden" name="code" value={code} />
      <div className="grid gap-3 sm:grid-cols-3">
        <label>
          <span className="field-label">Name</span>
          <input name="name" className="field-input w-full" maxLength={60} defaultValue={name} />
        </label>
        <label>
          <span className="field-label">Valid to (blank = open)</span>
          <input type="date" name="validTo" className="field-input" defaultValue={validTo ?? ''} />
        </label>
        <label>
          <span className="field-label">Valid</span>
          <select name="isValid" className="field-input" defaultValue={isValid ? 'yes' : 'no'}>
            <option value="yes">valid</option>
            <option value="no">retired</option>
          </select>
        </label>
      </div>
      <button type="submit" className="btn btn-default min-h-11 sm:min-h-8" disabled={pending}>Save</button>
      <Status state={state} />
    </form>
  );
}

export function ComponentForm({
  structureCode,
  components,
}: {
  structureCode: string;
  components: Array<{ code: string; name: string; componentKind: string }>;
}) {
  const [state, action, pending] = useActionState(setComponentAction, { ok: false });
  return (
    <form action={action} className="panel space-y-3 p-4">
      <h2 className="panel-title">Add or change a component</h2>
      <p className="text-sm text-ink-soft">The amount rule lives here, on the structure. The pay component only names the kind of pay and where it posts.</p>
      <input type="hidden" name="structureCode" value={structureCode} />
      <div className="grid gap-3 sm:grid-cols-3">
        <label>
          <span className="field-label">Component</span>
          <select name="componentCode" className="field-input" required defaultValue="">
            <option value="" disabled>Choose…</option>
            {components.map((c) => <option key={c.code} value={c.code}>{c.code} — {c.name} ({c.componentKind.toLowerCase()})</option>)}
          </select>
        </label>
        <label>
          <span className="field-label">Amount rule</span>
          <select name="amountKind" className="field-input" defaultValue="FIXED">
            <option value="FIXED">Fixed amount</option>
            <option value="PERCENT_OF_BASE">Percent of base</option>
          </select>
        </label>
        <label>
          <span className="field-label">Amount or rate (7.5 = 7.5 %)</span>
          <input name="amountValue" className="field-input code" required inputMode="decimal" />
        </label>
      </div>
      <button type="submit" className="btn btn-primary min-h-11 sm:min-h-8" disabled={pending || components.length === 0}>Save component</button>
      <Status state={state} />
    </form>
  );
}

export function RemoveComponentForm({ structureCode, componentCode }: { structureCode: string; componentCode: string }) {
  const [state, action, pending] = useActionState(removeComponentAction, { ok: false });
  return (
    <form action={action} className="flex items-center gap-2">
      <input type="hidden" name="structureCode" value={structureCode} />
      <input type="hidden" name="componentCode" value={componentCode} />
      <button type="submit" className="btn btn-default min-h-11 sm:min-h-8" disabled={pending} aria-label={`Remove ${componentCode} from ${structureCode}`}>Remove</button>
      {state.message && !state.ok ? <span role="status" className="text-xs text-signal-error">{state.message}</span> : null}
    </form>
  );
}
