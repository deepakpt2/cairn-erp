'use client';

import { useActionState, useState } from 'react';

import { ChangeLock } from '@/ui/lock/ChangeLock';
import {
  WORK_CENTER_LOCK,
  type WorkCenterView,
} from '@/modules/production/work-center';
import { saveWorkCenterAction, type WorkCenterActionState } from './actions';

const INITIAL: WorkCenterActionState = { ok: false };

export default function WorkCenterForm({
  document,
  plants,
  categories,
  locked,
}: {
  document: WorkCenterView | null;
  plants: Array<{ plant: string; name: string }>;
  categories: Array<{ category: string; description: string }>;
  locked: boolean;
}) {
  const [state, action, pending] = useActionState(saveWorkCenterAction, INITIAL);
  const saved = state.workCenter ?? document;
  const [capacities, setCapacities] = useState(saved?.capacities ?? []);
  const [costing, setCosting] = useState(saved?.costing.map((row) => ({
    validFrom: row.validFrom,
    validTo: row.validTo,
    costCenter: row.costCenter,
    activityType: row.activityType ?? '',
    formula: row.formula ?? '',
  })) ?? []);
  const mode = document ? 'CHANGE' : 'CREATE';

  return (
    <form action={action} className="space-y-4">
      <input type="hidden" name="mode" value={mode} />
      <input type="hidden" name="version" value={saved?.version ?? ''} />
      {mode === 'CHANGE' && (
        <>
          <input type="hidden" name="plant" value={saved?.plant ?? ''} />
          <input type="hidden" name="workCenter" value={saved?.workCenter ?? ''} />
          <input type="hidden" name="category" value={saved?.category ?? ''} />
        </>
      )}
      <input type="hidden" name="capacities" value={JSON.stringify(capacities)} />
      <input type="hidden" name="costing" value={JSON.stringify(costing)} />
      {state.message && (
        <p role="status" className={`text-sm ${state.ok ? 'text-ink' : 'text-red-700'}`}>
          {state.message}{state.remedy ? ` ${state.remedy}` : ''}
        </p>
      )}
      {locked && <p className="text-sm text-ink-soft">This work center is open for change elsewhere. It is not editable here.</p>}
      {document && !locked && (
        <ChangeLock lockObject={WORK_CENTER_LOCK} argument={`${document.plant}/${document.workCenter}`} />
      )}

      <section className="panel space-y-3 p-4">
        <h2 className="text-sm font-semibold">Basic data</h2>
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="block text-sm">
            <span className="field-label">Plant</span>
            <select className="input mt-1 w-full" name="plant" defaultValue={saved?.plant ?? ''} required disabled={mode === 'CHANGE' || locked}>
              <option value="">Choose</option>
              {plants.map((row) => <option key={row.plant} value={row.plant}>{row.plant} · {row.name}</option>)}
            </select>
          </label>
          <label className="block text-sm">
            <span className="field-label">Work center</span>
            <input className="input mt-1 w-full" name="workCenter" defaultValue={saved?.workCenter ?? ''} maxLength={8} required readOnly={mode === 'CHANGE' || locked} />
          </label>
          <label className="block text-sm">
            <span className="field-label">Category</span>
            <select className="input mt-1 w-full" name="category" defaultValue={saved?.category ?? ''} required disabled={mode === 'CHANGE' || locked}>
              <option value="">Choose</option>
              {categories.map((row) => <option key={row.category} value={row.category}>{row.category} · {row.description}</option>)}
            </select>
          </label>
          <label className="block text-sm">
            <span className="field-label">Description</span>
            <input className="input mt-1 w-full" name="description" defaultValue={saved?.description ?? ''} maxLength={40} required disabled={locked} />
          </label>
          <label className="block text-sm">
            <span className="field-label">Person responsible</span>
            <input className="input mt-1 w-full" name="personResponsible" defaultValue={saved?.personResponsible ?? ''} maxLength={3} disabled={locked} />
          </label>
          <label className="block text-sm">
            <span className="field-label">Location</span>
            <input className="input mt-1 w-full" name="location" defaultValue={saved?.location ?? ''} maxLength={10} disabled={locked} />
          </label>
          <label className="block text-sm">
            <span className="field-label">Usage</span>
            <input className="input mt-1 w-full" name="usage" defaultValue={saved?.usage ?? ''} maxLength={3} disabled={locked} />
          </label>
          <label className="block text-sm">
            <span className="field-label">Standard value key</span>
            <input className="input mt-1 w-full" name="standardValueKey" defaultValue={saved?.standardValueKey ?? ''} maxLength={4} disabled={locked} />
          </label>
        </div>
        {mode === 'CREATE' && (
          <div className="grid gap-3 sm:grid-cols-3">
            <label className="block text-sm">
              <span className="field-label">Copy from plant</span>
              <input className="input mt-1 w-full" name="copyPlant" maxLength={10} disabled={locked} />
            </label>
            <label className="block text-sm">
              <span className="field-label">Copy from work center</span>
              <input className="input mt-1 w-full" name="copyCenter" maxLength={8} disabled={locked} />
            </label>
            <label className="flex items-end gap-2 text-sm">
              <input type="checkbox" name="copyChildren" value="X" defaultChecked disabled={locked} />
              Copy capacities and costing
            </label>
          </div>
        )}
      </section>

      <section className="panel space-y-3 p-4">
        <h2 className="text-sm font-semibold">Default values</h2>
        <label className="block max-w-xs text-sm">
          <span className="field-label">Control key</span>
          <input className="input mt-1 w-full" name="controlKey" defaultValue={saved?.controlKey ?? ''} maxLength={4} disabled={locked} />
        </label>
        <p className="text-sm text-ink-soft">The control key is stored. This screen does not create a routing. A routing operation copies it only when that operation leaves the control key blank.</p>
      </section>

      <section className="panel space-y-3 p-4">
        <h2 className="text-sm font-semibold">Capacities</h2>
        {capacities.map((row, index) => (
          <div key={`${row.capacityCategory}-${index}`} className="grid gap-2 border-t border-line pt-2 sm:grid-cols-4">
            <input className="input" aria-label="Capacity category" value={row.capacityCategory} maxLength={3} disabled={locked} onChange={(event) => setCapacities(capacities.map((item, itemIndex) => itemIndex === index ? { ...item, capacityCategory: event.target.value } : item))} />
            <input className="input" aria-label="Factory calendar" value={row.factoryCalendar ?? ''} maxLength={2} placeholder="Calendar" disabled={locked} onChange={(event) => setCapacities(capacities.map((item, itemIndex) => itemIndex === index ? { ...item, factoryCalendar: event.target.value } : item))} />
            <input className="input" aria-label="Start time" value={row.startTime ?? ''} maxLength={5} placeholder="HH:MM" disabled={locked} onChange={(event) => setCapacities(capacities.map((item, itemIndex) => itemIndex === index ? { ...item, startTime: event.target.value } : item))} />
            <input className="input" aria-label="End time" value={row.endTime ?? ''} maxLength={5} placeholder="HH:MM" disabled={locked} onChange={(event) => setCapacities(capacities.map((item, itemIndex) => itemIndex === index ? { ...item, endTime: event.target.value } : item))} />
          </div>
        ))}
        {!locked && (
          <button type="button" className="btn btn-default min-h-11 sm:min-h-8" onClick={() => setCapacities([...capacities, { capacityCategory: '', description: null, factoryCalendar: null, baseUnit: null, startTime: null, endTime: null, breakMinutes: 0, utilization: null, individualCapacities: null, finiteScheduling: ' ', longTermPlanning: ' ', severalOperations: ' ' }])}>
            Add capacity
          </button>
        )}
        <p className="text-sm text-ink-soft">Available time is stored. It is not evaluated, and a shift sequence is not stored.</p>
      </section>

      <section className="panel space-y-3 p-4">
        <h2 className="text-sm font-semibold">Scheduling</h2>
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="block text-sm">
            <span className="field-label">Capacity category</span>
            <input className="input mt-1 w-full" name="schedulingCapacityCategory" defaultValue={saved?.schedulingCapacityCategory ?? ''} maxLength={3} disabled={locked} />
          </label>
          <label className="block text-sm">
            <span className="field-label">Processing formula</span>
            <input className="input mt-1 w-full" name="schedulingProcessingFormula" defaultValue={saved?.schedulingProcessingFormula ?? ''} maxLength={6} disabled={locked} />
          </label>
          <label className="block text-sm">
            <span className="field-label">Setup formula</span>
            <input className="input mt-1 w-full" name="schedulingSetupFormula" defaultValue={saved?.schedulingSetupFormula ?? ''} maxLength={6} disabled={locked} />
          </label>
          <label className="block text-sm">
            <span className="field-label">Teardown formula</span>
            <input className="input mt-1 w-full" name="schedulingTeardownFormula" defaultValue={saved?.schedulingTeardownFormula ?? ''} maxLength={6} disabled={locked} />
          </label>
        </div>
        <p className="text-sm text-ink-soft">A formula key is stored. It is not calculated. No formula list is delivered.</p>
      </section>

      <section className="panel space-y-3 p-4">
        <h2 className="text-sm font-semibold">Costing</h2>
        {costing.map((row, index) => (
          <div key={index} className="grid gap-2 border-t border-line pt-2 sm:grid-cols-5">
            <input className="input" aria-label="Valid from" value={row.validFrom} disabled={locked} onChange={(event) => setCosting(costing.map((item, itemIndex) => itemIndex === index ? { ...item, validFrom: event.target.value } : item))} />
            <input className="input" aria-label="Valid to" value={row.validTo} disabled={locked} onChange={(event) => setCosting(costing.map((item, itemIndex) => itemIndex === index ? { ...item, validTo: event.target.value } : item))} />
            <input className="input" aria-label="Cost center" value={row.costCenter} maxLength={10} disabled={locked} onChange={(event) => setCosting(costing.map((item, itemIndex) => itemIndex === index ? { ...item, costCenter: event.target.value } : item))} />
            <input className="input" aria-label="Activity type" value={row.activityType} maxLength={6} disabled={locked} onChange={(event) => setCosting(costing.map((item, itemIndex) => itemIndex === index ? { ...item, activityType: event.target.value } : item))} />
            <input className="input" aria-label="Formula" value={row.formula} maxLength={6} disabled={locked} onChange={(event) => setCosting(costing.map((item, itemIndex) => itemIndex === index ? { ...item, formula: event.target.value } : item))} />
          </div>
        ))}
        {!locked && (
          <button type="button" className="btn btn-default min-h-11 sm:min-h-8" onClick={() => setCosting([...costing, { validFrom: '', validTo: '', costCenter: '', activityType: '', formula: '' }])}>
            Add costing
          </button>
        )}
        {mode === 'CHANGE' && (
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" name="deletionFlag" value="X" defaultChecked={saved?.deletionFlag === 'X'} disabled={locked} />
            Deletion flag
          </label>
        )}
      </section>

      <button className="btn btn-primary min-h-11 sm:min-h-8" type="submit" disabled={pending || locked}>
        {pending ? 'Saving' : 'Save'}
      </button>
    </form>
  );
}
