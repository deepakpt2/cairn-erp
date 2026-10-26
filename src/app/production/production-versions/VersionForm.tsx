'use client';

import { useActionState, useMemo } from 'react';

import { ChangeLock } from '@/ui/lock/ChangeLock';
import type { ProductionVersionView } from '@/modules/production/production-version';
import { copyVersionAction, saveVersionAction, type VersionActionState } from './actions';

const initial: VersionActionState = { ok: false };

export default function VersionForm({
  document,
  locked,
  canCopy,
  plants,
  materials,
  choices,
}: {
  document: ProductionVersionView | null;
  locked: boolean;
  /** Whether this session may create a version. A copy is a create, so it stands outside the change lock. */
  canCopy: boolean;
  plants: Array<{ plant: string; name: string }>;
  materials: Array<{ materialNumber: string; description: string; baseUnit: string }>;
  choices: {
    boms: Array<{ usage: string; alternative: string }>;
    routings: Array<{ taskListType: string; routingGroup: string; groupCounter: string }>;
    storageLocations: Array<{ storageLocation: string; name: string }>;
  };
}) {
  const [state, action, pending] = useActionState(saveVersionAction, initial);
  const [copyState, copyAction, copyPending] = useActionState(copyVersionAction, initial);
  const saved = state.version ?? copyState.version ?? document;
  const mode = document ? 'CHANGE' : 'CREATE';
  const requestKey = useMemo(() => (typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `version-${Date.now()}`), []);
  const note = state.message ?? copyState.message;

  return (
    <div className="mt-4 space-y-4">
      {note && <p className={`text-sm ${state.ok || copyState.ok ? 'text-ink' : 'text-danger'}`}>{note}{state.remedy ? ` ${state.remedy}` : ''}</p>}
      {document && !locked && <ChangeLock lockObject="PRODUCTION_VERSION" argument={`${document.plant}/${document.materialNumber}/${document.productionVersion}`} />}
      <form action={action} className="space-y-3">
        <input type="hidden" name="mode" value={mode} />
        <input type="hidden" name="version" value={saved?.version ?? ''} />
        <input type="hidden" name="requestKey" value={mode === 'CREATE' ? requestKey : ''} />
        {mode === 'CHANGE' && (
          <>
            <input type="hidden" name="materialNumber" value={saved?.materialNumber ?? ''} />
            <input type="hidden" name="plant" value={saved?.plant ?? ''} />
            <input type="hidden" name="productionVersion" value={saved?.productionVersion ?? ''} />
          </>
        )}
        <div className="grid gap-3 sm:grid-cols-4">
          <label className="text-sm">Plant
            <select className="input mt-1 w-full" name="plant" defaultValue={saved?.plant ?? ''} required disabled={mode === 'CHANGE' || locked}>
              <option value="">Choose</option>
              {plants.map((row) => <option key={row.plant} value={row.plant}>{row.plant} — {row.name}</option>)}
            </select>
          </label>
          <label className="text-sm">Material
            <input className="input mt-1 w-full" name="materialNumber" list="version-materials" defaultValue={saved?.materialNumber ?? ''} required readOnly={mode === 'CHANGE'} disabled={locked} />
          </label>
          <label className="text-sm">Version
            <input className="input mt-1 w-full" name="productionVersion" defaultValue={saved?.productionVersion ?? ''} maxLength={4} required readOnly={mode === 'CHANGE'} disabled={locked} />
          </label>
          <label className="text-sm">Description
            <input className="input mt-1 w-full" name="description" defaultValue={saved?.description ?? ''} maxLength={40} disabled={locked} />
          </label>
          <label className="text-sm">Valid from
            <input className="input mt-1 w-full" type="date" name="validFrom" defaultValue={saved?.validFrom ?? ''} required disabled={locked} />
          </label>
          <label className="text-sm">Valid to
            <input className="input mt-1 w-full" type="date" name="validTo" defaultValue={saved && saved.validTo !== '9999-12-31' ? saved.validTo : ''} disabled={locked} />
          </label>
          <label className="text-sm">Lot from
            <input className="input mt-1 w-full" name="lotFrom" defaultValue={saved?.lotFrom ?? '0'} required disabled={locked} />
          </label>
          <label className="text-sm">Lot to
            <input className="input mt-1 w-full" name="lotTo" defaultValue={saved?.lotTo ?? ''} required disabled={locked} />
          </label>
          <label className="text-sm">Lot unit
            <input className="input mt-1 w-full" name="lotUnit" defaultValue={saved?.lotUnit ?? ''} maxLength={6} required disabled={locked} />
          </label>
          <label className="text-sm">BOM usage
            <input className="input mt-1 w-full" name="bomUsage" defaultValue={saved?.bomUsage ?? ''} maxLength={1} required disabled={locked} />
          </label>
          <label className="text-sm">BOM alternative
            <input className="input mt-1 w-full" name="bomAlternative" defaultValue={saved?.bomAlternative ?? ''} maxLength={2} required disabled={locked} />
          </label>
          <label className="text-sm">Task list type
            <input className="input mt-1 w-full" name="taskListType" defaultValue={saved?.taskListType ?? ''} maxLength={1} required disabled={locked} />
          </label>
          <label className="text-sm">Routing group
            <input className="input mt-1 w-full" name="routingGroup" defaultValue={saved?.routingGroup ?? ''} maxLength={8} required disabled={locked} />
          </label>
          <label className="text-sm">Group counter
            <input className="input mt-1 w-full" name="groupCounter" defaultValue={saved?.groupCounter ?? ''} maxLength={2} required disabled={locked} />
          </label>
          <label className="text-sm">Receiving location
            <input className="input mt-1 w-full" name="receivingStorageLocation" list="version-locations" defaultValue={saved?.receivingStorageLocation ?? ''} maxLength={10} disabled={locked} />
          </label>
          <label className="text-sm">Change number
            <input className="input mt-1 w-full" name="changeNumber" placeholder="Refused" disabled={locked} />
          </label>
        </div>
        <p className="text-sm text-ink-soft">BOM alternatives: {choices.boms.map((row) => `${row.usage}/${row.alternative}`).join(', ') || 'none'}. Routings: {choices.routings.map((row) => `${row.taskListType} ${row.routingGroup}/${row.groupCounter}`).join(', ') || 'none'}. This screen does not maintain either master.</p>
        <button className="btn btn-primary min-h-11 sm:min-h-8" type="submit" disabled={pending || locked}>{pending ? 'Saving' : mode === 'CHANGE' ? 'Save change' : 'Create version'}</button>
      </form>
      {document && canCopy && (
        <form action={copyAction} className="flex flex-wrap items-end gap-2">
          <input type="hidden" name="materialNumber" value={document.materialNumber} />
          <input type="hidden" name="plant" value={document.plant} />
          <input type="hidden" name="productionVersion" value={document.productionVersion} />
          <label className="text-sm">Copy to a new version
            <input className="input mt-1" name="newProductionVersion" maxLength={4} required />
          </label>
          <button className="btn" type="submit" disabled={copyPending}>Copy</button>
        </form>
      )}
      <datalist id="version-materials">{materials.map((row) => <option key={row.materialNumber} value={row.materialNumber}>{row.description} {row.baseUnit}</option>)}</datalist>
      <datalist id="version-locations">{choices.storageLocations.map((row) => <option key={row.storageLocation} value={row.storageLocation}>{row.name}</option>)}</datalist>
    </div>
  );
}
