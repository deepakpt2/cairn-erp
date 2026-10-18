'use client';

import { useState } from 'react';

/**
 * Classes for classification (SCR-058 / CL02; inert since stage 1).
 * The master shape: the standing classes beside the editor — basic
 * data and the characteristic assignments at their positions.
 * Stage 3 wires the acts.
 */

const CLASS_TYPES = ['MATERIAL', 'BATCH', 'EQUIPMENT', 'VARIANT', 'PURCHASE_REQUISITION', 'PURCHASE_ORDER'];

export default function Classes() {
  const [classType, setClassType] = useState('PURCHASE_ORDER');
  const [className, setClassName] = useState('');
  const [description, setDescription] = useState('');
  const [assignments, setAssignments] = useState<string[]>(['']);

  return (
    <div className="space-y-4">
      <section aria-labelledby="class-grid" className="rounded-card border border-line bg-surface p-4 shadow-card">
        <h2 id="class-grid" className="text-sm font-semibold">Classes</h2>
        <p className="mt-2 text-sm text-ink-soft">No classes stand yet. Define the first below.</p>
      </section>

      <section aria-labelledby="class-editor" className="rounded-card border border-line bg-surface p-4 shadow-card">
        <h2 id="class-editor" className="text-sm font-semibold">New class</h2>
        <div className="mt-3 grid gap-3 sm:grid-cols-3">
          <label className="block">
            <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-ink-faint">Class type</span>
            <select className="input w-full" value={classType} onChange={(event) => setClassType(event.target.value)}>
              {CLASS_TYPES.map((type) => (
                <option key={type} value={type}>{type}</option>
              ))}
            </select>
          </label>
          <label className="block">
            <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-ink-faint">Class name</span>
            <input className="input w-full" value={className} onChange={(event) => setClassName(event.target.value)} />
          </label>
          <label className="block">
            <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-ink-faint">Description</span>
            <input className="input w-full" value={description} onChange={(event) => setDescription(event.target.value)} />
          </label>
        </div>

        <fieldset className="mt-4 rounded-card border border-line p-3">
          <legend className="px-1 text-xs font-medium uppercase tracking-wide text-ink-faint">Characteristics</legend>
          <div className="space-y-2">
            {assignments.map((value, index) => (
              <div key={index} className="flex items-center gap-3">
                <span className="text-sm text-ink-faint">{String(index + 1).padStart(3, '0')}</span>
                <input
                  className="input w-full sm:w-80"
                  value={value}
                  onChange={(event) => {
                    const next = assignments.slice();
                    next[index] = event.target.value;
                    setAssignments(next);
                  }}
                />
              </div>
            ))}
          </div>
          <button
            type="button"
            className="btn btn-default mt-2 min-h-11 sm:min-h-8"
            onClick={() => setAssignments([...assignments, ''])}
          >
            Add characteristic
          </button>
        </fieldset>

        <div className="mt-4 flex justify-end">
          <button type="button" className="btn btn-primary min-h-11 sm:min-h-8" disabled>
            Save class
          </button>
        </div>
      </section>
    </div>
  );
}
