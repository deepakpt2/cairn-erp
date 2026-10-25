'use client';

import { useActionState, useMemo } from 'react';

import { ChangeLock } from '@/ui/lock/ChangeLock';
import type { RoutingView } from '@/modules/production/routing';
import { saveRoutingAction, type RoutingActionState } from './actions';

const initial: RoutingActionState = { ok: false };

export default function RoutingForm({
  document,
  locked,
  plants,
  materials,
  types,
  usages,
  statuses,
  controlKeys,
  valueKeys,
}: {
  document: RoutingView | null;
  locked: boolean;
  plants: Array<{ plant: string; name: string }>;
  materials: Array<{ materialNumber: string; description: string; baseUnit: string }>;
  types: Array<{ taskListType: string; description: string }>;
  usages: Array<{ usage: string; description: string }>;
  statuses: Array<{ status: string; description: string }>;
  controlKeys: Array<{ controlKey: string; description: string }>;
  valueKeys: Array<{ standardValueKey: string; description: string }>;
}) {
  const [state, action, pending] = useActionState(saveRoutingAction, initial);
  const saved = state.routing ?? document;
  const mode = document ? 'CHANGE' : 'CREATE';
  const requestKey = useMemo(() => (typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `routing-${Date.now()}`), []);
  const operationText = saved?.operations.filter((row) => row.deletionFlag !== 'X').map((row) => (
    `${row.operationNumber}|${row.shortText ?? ''}|${row.workCenter ?? ''}|${row.controlKey ?? ''}|${row.standardValueKey ?? ''}|${row.values.map((value) => `${value.parameter},${value.quantity},${value.unit}`).join(';')}|${row.allocations.filter((item) => item.deletionFlag !== 'X').map((item) => `${item.materialNumber},${item.bomUsage},${item.alternative},${item.itemNumber},${item.allocatedQuantity ?? ''}`).join(';')}|${row.executionOrder}`
  )).join('\n') ?? '';
  const assignmentText = saved?.assignments.filter((row) => row.deletionFlag !== 'X').map((row) => `${row.materialNumber}|${row.plant}`).join('\n') ?? '';

  return (
    <form action={action} className="mt-4 space-y-4">
      <input type="hidden" name="mode" value={mode} />
      <input type="hidden" name="version" value={saved?.version ?? ''} />
      <input type="hidden" name="requestKey" value={mode === 'CREATE' ? requestKey : ''} />
      {mode === 'CHANGE' && (
        <>
          <input type="hidden" name="taskListType" value={saved?.taskListType ?? ''} />
          <input type="hidden" name="routingGroup" value={saved?.routingGroup ?? ''} />
          <input type="hidden" name="groupCounter" value={saved?.groupCounter ?? ''} />
          <input type="hidden" name="plant" value={saved?.plant ?? ''} />
        </>
      )}
      {state.message && <p className={`text-sm ${state.ok ? 'text-ink' : 'text-danger'}`}>{state.message}{state.remedy ? ` ${state.remedy}` : ''}</p>}
      {state.warnings?.map((warning) => <p key={warning} className="text-sm">{warning}</p>)}
      {document && !locked && <ChangeLock lockObject="ROUTING" argument={`${document.taskListType}/${document.routingGroup}/${document.groupCounter}`} />}
      <div className="grid gap-3 sm:grid-cols-4">
        <label className="text-sm">Task list type
          <select className="input mt-1 w-full" name="taskListType" defaultValue={saved?.taskListType ?? ''} required disabled={mode === 'CHANGE' || locked}>
            <option value="">Choose</option>
            {types.map((row) => <option key={row.taskListType} value={row.taskListType}>{row.taskListType} — {row.description}</option>)}
          </select>
        </label>
        <label className="text-sm">Group
          <input className="input mt-1 w-full" name="routingGroup" defaultValue={saved?.routingGroup ?? ''} maxLength={8} readOnly={mode === 'CHANGE'} placeholder="Blank assigns the next group" />
        </label>
        <label className="text-sm">Counter
          <input className="input mt-1 w-full" name="groupCounter" defaultValue={saved?.groupCounter ?? ''} maxLength={2} readOnly={mode === 'CHANGE'} placeholder="Blank assigns the next" />
        </label>
        <label className="text-sm">Plant
          <select className="input mt-1 w-full" name="plant" defaultValue={saved?.plant ?? ''} required disabled={mode === 'CHANGE' || locked}>
            <option value="">Choose</option>
            {plants.map((row) => <option key={row.plant} value={row.plant}>{row.plant} — {row.name}</option>)}
          </select>
        </label>
        <label className="text-sm sm:col-span-2">Description
          <input className="input mt-1 w-full" name="description" defaultValue={saved?.description ?? ''} maxLength={40} disabled={locked} />
        </label>
        <label className="text-sm">Usage
          <select className="input mt-1 w-full" name="usage" defaultValue={saved?.usage ?? ''} required disabled={locked}>
            <option value="">Choose</option>
            {usages.map((row) => <option key={row.usage} value={row.usage}>{row.usage} — {row.description}</option>)}
          </select>
        </label>
        <label className="text-sm">Status
          <select className="input mt-1 w-full" name="status" defaultValue={saved?.status ?? ''} disabled={locked}>
            <option value="">None</option>
            {statuses.map((row) => <option key={row.status} value={row.status}>{row.status} — {row.description}</option>)}
          </select>
        </label>
        <label className="text-sm">Base quantity
          <input className="input mt-1 w-full" name="baseQuantity" defaultValue={saved?.baseQuantity ?? '1'} required disabled={locked} />
        </label>
        <label className="text-sm">Base unit
          <input className="input mt-1 w-full" name="baseUnit" defaultValue={saved?.baseUnit ?? ''} maxLength={6} required disabled={locked} />
        </label>
        <label className="text-sm">Lot from
          <input className="input mt-1 w-full" name="lotFrom" defaultValue={saved?.lotFrom ?? ''} disabled={locked} />
        </label>
        <label className="text-sm">Lot to
          <input className="input mt-1 w-full" name="lotTo" defaultValue={saved?.lotTo ?? ''} disabled={locked} />
        </label>
        <label className="text-sm">Valid from
          <input className="input mt-1 w-full" type="date" name="validFrom" defaultValue={saved?.validFrom ?? ''} required disabled={locked} />
        </label>
        <label className="text-sm">Valid to
          <input className="input mt-1 w-full" type="date" name="validTo" defaultValue={saved && saved.validTo !== '9999-12-31' ? saved.validTo : ''} disabled={locked} />
        </label>
        <label className="text-sm">Change number
          <input className="input mt-1 w-full" name="changeNumber" placeholder="Refused" disabled={locked} />
        </label>
        {mode === 'CHANGE' && (
          <label className="text-sm flex items-end gap-2"><input type="checkbox" name="deletionFlag" value="X" defaultChecked={saved?.deletionFlag === 'X'} disabled={locked} /> Deletion flag</label>
        )}
      </div>
      <label className="block text-sm">Material assignments, one per line: material|plant. A routing may have none.
        <textarea className="input mt-1 w-full font-mono" name="assignments" rows={3} defaultValue={assignmentText} disabled={locked} />
      </label>
      <label className="block text-sm">Operations, one per line: number|text|work center|control key|value key|parameter,quantity,unit|material,usage,alternative,item,quantity|execution order. The operation number is not the execution order. If every line omits the last field, create uses the line order and change keeps the stored order. A new operation with no order is placed after the highest stored order. A gap is not filled. If any line has it, every line must have it. An omitted saved operation is marked deleted and keeps its stored order. Sequence 000000 of type 0 only.
        <textarea className="input mt-1 w-full font-mono" name="operations" rows={6} defaultValue={operationText} disabled={locked} />
      </label>
      <datalist id="routing-materials">{materials.map((row) => <option key={row.materialNumber} value={row.materialNumber}>{row.description}</option>)}</datalist>
      <p className="text-sm text-ink-soft">Control keys: {controlKeys.map((row) => row.controlKey).join(', ') || 'none'}. Value keys: {valueKeys.map((row) => row.standardValueKey).join(', ') || 'none'}. A formula is not calculated. A production order is not rewritten.</p>
      <button className="btn btn-primary min-h-11 sm:min-h-8" type="submit" disabled={pending || locked}>{pending ? 'Saving' : mode === 'CHANGE' ? 'Save change' : 'Create routing'}</button>
    </form>
  );
}
