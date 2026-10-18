'use client';

import { useState } from 'react';

/**
 * Characteristics for classification (SCR-057 / CT04; inert since
 * stage 1). The master shape: the standing characteristics beside the
 * editor — basic data, the allowed values, and the lifecycle. Stage 3
 * wires the acts.
 */

const FORMATS = ['CHAR', 'NUM', 'DATE', 'TIME', 'CURR'] as const;

export default function Characteristics() {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [format, setFormat] = useState<(typeof FORMATS)[number]>('CHAR');
  const [length, setLength] = useState('30');
  const [decimals, setDecimals] = useState('0');
  const [mode, setMode] = useState<'SINGLE' | 'MULTIPLE'>('SINGLE');
  const [values, setValues] = useState<string[]>(['']);

  return (
    <div className="space-y-4">
      <section aria-labelledby="characteristic-grid" className="rounded-card border border-line bg-surface p-4 shadow-card">
        <h2 id="characteristic-grid" className="text-sm font-semibold">Characteristics</h2>
        <p className="mt-2 text-sm text-ink-soft">No characteristics stand yet. Define the first below.</p>
      </section>

      <section aria-labelledby="characteristic-editor" className="rounded-card border border-line bg-surface p-4 shadow-card">
        <h2 id="characteristic-editor" className="text-sm font-semibold">New characteristic</h2>
        <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <label className="block">
            <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-ink-faint">Characteristic name</span>
            <input className="input w-full" value={name} onChange={(event) => setName(event.target.value)} />
          </label>
          <label className="block">
            <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-ink-faint">Description</span>
            <input className="input w-full" value={description} onChange={(event) => setDescription(event.target.value)} />
          </label>
          <label className="block">
            <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-ink-faint">Data format</span>
            <select className="input w-full" value={format} onChange={(event) => setFormat(event.target.value as typeof format)}>
              {FORMATS.map((f) => (
                <option key={f} value={f}>{f}</option>
              ))}
            </select>
          </label>
          <label className="block">
            <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-ink-faint">Length</span>
            <input className="input w-full" value={length} onChange={(event) => setLength(event.target.value)} />
          </label>
          <label className="block">
            <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-ink-faint">Decimal places</span>
            <input className="input w-full" value={decimals} onChange={(event) => setDecimals(event.target.value)} />
          </label>
          <label className="block">
            <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-ink-faint">Value assignment</span>
            <select className="input w-full" value={mode} onChange={(event) => setMode(event.target.value as typeof mode)}>
              <option value="SINGLE">Single value</option>
              <option value="MULTIPLE">Multiple values</option>
            </select>
          </label>
        </div>

        <fieldset className="mt-4 rounded-card border border-line p-3">
          <legend className="px-1 text-xs font-medium uppercase tracking-wide text-ink-faint">Allowed values</legend>
          <div className="space-y-2">
            {values.map((value, index) => (
              <input
                key={index}
                className="input w-full sm:w-80"
                value={value}
                onChange={(event) => {
                  const next = values.slice();
                  next[index] = event.target.value;
                  setValues(next);
                }}
              />
            ))}
          </div>
          <button
            type="button"
            className="btn btn-default mt-2 min-h-11 sm:min-h-8"
            onClick={() => setValues([...values, ''])}
          >
            Add value
          </button>
        </fieldset>

        <div className="mt-4 flex justify-end">
          <button type="button" className="btn btn-primary min-h-11 sm:min-h-8" disabled>
            Save characteristic
          </button>
        </div>
      </section>
    </div>
  );
}
