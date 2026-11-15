'use client';

import { useActionState } from 'react';

import type { CycleView } from '@/modules/foundation/cost-allocation-cycle';
import {
  cancelRunAction,
  deleteAction,
  executeAction,
  saveCycleAction,
  setNodeAction,
  setSegmentAction,
  type CycleActionState,
} from './actions';

const initial: CycleActionState = { ok: false };

function Status({ state }: { state: CycleActionState }) {
  if (!state.message) return null;
  return (
    <p role="status" className={`text-sm ${state.ok ? 'text-ink' : 'text-signal-error'}`}>
      {state.message}{state.remedy ? ` ${state.remedy}` : ''}
    </p>
  );
}

function Reason() {
  return (
    <label className="min-w-48 flex-1">
      <span className="field-label">Reason</span>
      <input name="reason" required maxLength={500} className="field-input w-full" />
    </label>
  );
}

/** Create or change a cycle header. */
export function CycleForm({ area, cycle }: { area: string; cycle: CycleView | null }) {
  const [state, action, pending] = useActionState(saveCycleAction, initial);
  return (
    <form action={action} className="panel space-y-3 p-4" aria-label={cycle ? `Change cycle ${cycle.cycleCode}` : 'Create a cycle'}>
      <h2 className="panel-title">{cycle ? `Change cycle ${cycle.cycleCode}` : 'Create a cycle (KSU1)'}</h2>
      <input type="hidden" name="mode" value={cycle ? 'CHANGE' : 'CREATE'} />
      <input type="hidden" name="controllingArea" value={area} />
      <div className="flex flex-wrap items-end gap-3">
        <label>
          <span className="field-label">Cycle</span>
          {cycle
            ? <><input type="hidden" name="cycleCode" value={cycle.cycleCode} /><span className="code block py-1">{cycle.cycleCode}</span></>
            : <input name="cycleCode" required maxLength={6} className="field-input code w-24" />}
        </label>
        <label className="min-w-48 flex-1">
          <span className="field-label">Name</span>
          <input name="name" required maxLength={40} defaultValue={cycle?.name ?? ''} className="field-input w-full" />
        </label>
        <label>
          <span className="field-label">Category</span>
          <select name="category" defaultValue={cycle?.category ?? 'ASSESSMENT'} className="field-input">
            <option value="ASSESSMENT">Assessment</option>
            <option value="DISTRIBUTION">Distribution (not executable yet)</option>
          </select>
        </label>
        <label>
          <span className="field-label">Valid from</span>
          <input type="date" name="validFrom" required defaultValue={cycle?.validFrom ?? ''} className="field-input" />
        </label>
        <label>
          <span className="field-label">Valid to</span>
          <input type="date" name="validTo" required defaultValue={cycle?.validTo ?? '9999-12-31'} className="field-input" />
        </label>
        <label>
          <span className="field-label">Active</span>
          <select name="isActive" defaultValue={cycle && !cycle.isActive ? 'no' : 'yes'} className="field-input">
            <option value="yes">Yes</option>
            <option value="no">No</option>
          </select>
        </label>
        <Reason />
      </div>
      <button type="submit" className="btn btn-primary min-h-11 sm:min-h-8" disabled={pending}>{cycle ? 'Save cycle' : 'Create cycle'}</button>
      <Status state={state} />
    </form>
  );
}

/** Add or change a segment. */
export function SegmentForm({ area, cycleCode, segment, nextNumber }: {
  area: string; cycleCode: string; segment?: CycleView['segments'][number]; nextNumber: number;
}) {
  const [state, action, pending] = useActionState(setSegmentAction, initial);
  return (
    <form action={action} className="space-y-2" aria-label={segment ? `Change segment ${segment.segmentNumber}` : 'Add a segment'}>
      <input type="hidden" name="controllingArea" value={area} />
      <input type="hidden" name="cycleCode" value={cycleCode} />
      <input type="hidden" name="segmentNumber" value={segment?.segmentNumber ?? nextNumber} />
      <input type="hidden" name="senderRule" value="POSTED" />
      <div className="flex flex-wrap items-end gap-3">
        <span className="code self-center text-xs">{segment ? `Segment ${segment.segmentNumber}` : `New segment ${nextNumber}`}</span>
        <label className="min-w-40 flex-1">
          <span className="field-label">Name</span>
          <input name="name" required maxLength={40} defaultValue={segment?.name ?? ''} className="field-input w-full" />
        </label>
        <label>
          <span className="field-label">Receiver rule</span>
          <select name="receiverRule" defaultValue={segment?.receiverRule ?? 'PERCENTAGE'} className="field-input">
            <option value="PERCENTAGE">Fixed percentages</option>
            <option value="PORTION">Fixed portions</option>
            <option value="FIXED_AMOUNT">Fixed amounts</option>
          </select>
        </label>
        <label>
          <span className="field-label">Cost elements from</span>
          <input name="costElementFrom" maxLength={10} defaultValue={segment?.costElementFrom ?? ''} className="field-input code w-24" />
        </label>
        <label>
          <span className="field-label">to</span>
          <input name="costElementTo" maxLength={10} defaultValue={segment?.costElementTo ?? ''} className="field-input code w-24" />
        </label>
        <Reason />
        <button type="submit" className="btn btn-default min-h-11 sm:min-h-8" disabled={pending}>{segment ? 'Save segment' : 'Add segment'}</button>
      </div>
      <Status state={state} />
    </form>
  );
}

/** One sender or receiver item: a cost centre or a group. Both blank removes it. */
export function NodeForm({ area, cycleCode, segmentNumber, kind, item, itemNumber }: {
  area: string; cycleCode: string; segmentNumber: number; kind: 'sender' | 'receiver';
  item?: { costCenter: string | null; groupName: string | null; weight?: string }; itemNumber: number;
}) {
  const [state, action, pending] = useActionState(setNodeAction, initial);
  return (
    <form action={action} className="flex flex-wrap items-end gap-2" aria-label={`${kind} ${itemNumber} of segment ${segmentNumber}`}>
      <input type="hidden" name="kind" value={kind} />
      <input type="hidden" name="controllingArea" value={area} />
      <input type="hidden" name="cycleCode" value={cycleCode} />
      <input type="hidden" name="segmentNumber" value={segmentNumber} />
      <input type="hidden" name="itemNumber" value={itemNumber} />
      <span className="code self-center text-xs">{itemNumber}</span>
      <label>
        <span className="field-label">Cost centre</span>
        <input name="costCenter" maxLength={10} defaultValue={item?.costCenter ?? ''} className="field-input code w-24" />
      </label>
      <label>
        <span className="field-label">or group</span>
        <input name="groupName" maxLength={24} defaultValue={item?.groupName ?? ''} className="field-input code w-28" />
      </label>
      {kind === 'receiver' && (
        <label>
          <span className="field-label">Weight</span>
          <input name="weight" inputMode="decimal" defaultValue={item?.weight ?? ''} className="field-input w-24" />
        </label>
      )}
      <Reason />
      <button type="submit" className="btn btn-default min-h-11 sm:min-h-8" disabled={pending}>{item ? 'Save' : 'Add'}</button>
      <Status state={state} />
    </form>
  );
}

export function DeleteForm({ area, cycleCode, segmentNumber, label }: { area: string; cycleCode: string; segmentNumber?: number; label: string }) {
  const [state, action, pending] = useActionState(deleteAction, initial);
  return (
    <form action={action} className="flex flex-wrap items-end gap-2" aria-label={label}>
      <input type="hidden" name="controllingArea" value={area} />
      <input type="hidden" name="cycleCode" value={cycleCode} />
      {segmentNumber !== undefined && <input type="hidden" name="segmentNumber" value={segmentNumber} />}
      <Reason />
      <button type="submit" className="btn btn-default min-h-11 sm:min-h-8" disabled={pending}>{label}</button>
      <Status state={state} />
    </form>
  );
}

/** KSU5: preview, then run one cycle for one period. */
export function ExecutePanel({ area, cycles, fiscalYear, periods, defaultPeriod }: {
  area: string; cycles: Array<{ cycleCode: string; name: string; category: string }>; fiscalYear: number; periods: number[]; defaultPeriod: number;
}) {
  const [state, action, pending] = useActionState(executeAction, initial);
  const view = state.preview;
  return (
    <section className="panel space-y-3 p-4" aria-label="Execute assessment">
      <h2 className="panel-title">Execute assessment (KSU5)</h2>
      <p className="text-sm text-ink-soft">
        Relieves the senders of their net posted cost in the period and charges the receivers by the segment&apos;s rule, through the
        account named on posting event CO_ASSESSMENT — one AL document dated the last day of the period. One pass. A correction is a
        reversal of the document, then cancelling the run below, then a new run.
      </p>
      <form action={action} className="flex flex-wrap items-end gap-3">
        <input type="hidden" name="controllingArea" value={area} />
        <label>
          <span className="field-label">Cycle</span>
          <select name="cycleCode" className="field-input">
            {cycles.map((c) => <option key={c.cycleCode} value={c.cycleCode}>{c.cycleCode} — {c.name}{c.category === 'DISTRIBUTION' ? ' (distribution)' : ''}</option>)}
          </select>
        </label>
        <label>
          <span className="field-label">Fiscal year</span>
          <input type="number" name="fiscalYear" defaultValue={fiscalYear} className="field-input w-24" />
        </label>
        <label>
          <span className="field-label">Period</span>
          <select name="period" defaultValue={String(defaultPeriod)} className="field-input">
            {periods.map((p) => <option key={p} value={p}>{p}</option>)}
          </select>
        </label>
        <label className="min-w-48 flex-1">
          <span className="field-label">Reason (required to run)</span>
          <input name="reason" maxLength={500} className="field-input w-full" />
        </label>
        <button type="submit" name="action" value="preview" className="btn btn-default min-h-11 sm:min-h-8" disabled={pending}>Preview</button>
        <button type="submit" name="action" value="run" className="btn btn-primary min-h-11 sm:min-h-8" disabled={pending}>Run</button>
      </form>
      <Status state={state} />
      {view && (
        <div className="space-y-2">
          <h3 className="text-sm font-semibold">
            {state.run ? `Posted as ${state.run.displayNumber}` : 'Preview'} · {view.cycleCode} · {view.period}/{view.fiscalYear} · dated {view.postingDate} ·
            company {view.companyCode} · account {view.assessmentAccount} · {view.assessedTotal} {view.currency} · {view.iterations} iteration
          </h3>
          {view.segments.map((s) => (
            <div key={s.segmentNumber} className="overflow-x-auto">
              <table className="grid-table text-xs" aria-label={`Segment ${s.segmentNumber} result`}>
                <thead><tr><th colSpan={4}>Segment {s.segmentNumber} — {s.name} · {s.receiverRule.toLowerCase().replace('_', ' ')} · {s.total} {view.currency}</th></tr>
                  <tr><th>Side</th><th>Cost centre</th><th>Weight</th><th>Amount ({view.currency})</th></tr></thead>
                <tbody>
                  {s.senders.map((x) => <tr key={`s${x.costCenter}`}><td>relieved</td><td className="code">{x.costCenter} {x.name}</td><td></td><td className="code">−{x.amount}</td></tr>)}
                  {s.receivers.map((x) => <tr key={`r${x.costCenter}`}><td>charged</td><td className="code">{x.costCenter} {x.name}</td><td className="code">{x.weight}</td><td className="code">{x.amount}</td></tr>)}
                </tbody>
              </table>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

export function CancelRunForm({ runId }: { runId: string }) {
  const [state, action, pending] = useActionState(cancelRunAction, initial);
  return (
    <form action={action} className="flex flex-wrap items-end gap-2" aria-label={`Cancel run ${runId}`}>
      <input type="hidden" name="runId" value={runId} />
      <Reason />
      <button type="submit" className="btn btn-default min-h-11 sm:min-h-8" disabled={pending}>Cancel run</button>
      <Status state={state} />
    </form>
  );
}
