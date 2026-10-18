'use client';

import { useState } from 'react';

/**
 * Release strategies (SCR-059; inert since stage 1). The shape the
 * round builds: release groups with their codes, and the strategy
 * editor — class, criteria against the document attributes, and the
 * ordered release codes. Stage 3 wires the acts.
 */

export default function ReleaseStrategies() {
  const [category, setCategory] = useState('PURCHASE_ORDER');
  const [groupCode, setGroupCode] = useState('');
  const [strategyCode, setStrategyCode] = useState('');
  const [className, setClassName] = useState('');
  const [criteria, setCriteria] = useState<Array<{ characteristic: string; operator: string; value: string }>>([
    { characteristic: 'TOTAL_VALUE', operator: 'GE', value: '' },
  ]);
  const [steps, setSteps] = useState<string[]>(['']);

  return (
    <div className="space-y-4">
      <section aria-labelledby="release-grid" className="rounded-card border border-line bg-surface p-4 shadow-card">
        <h2 id="release-grid" className="text-sm font-semibold">Release groups and strategies</h2>
        <p className="mt-2 text-sm text-ink-soft">No release strategies stand yet. Define the first below.</p>
      </section>

      <section aria-labelledby="release-editor" className="rounded-card border border-line bg-surface p-4 shadow-card">
        <h2 id="release-editor" className="text-sm font-semibold">New release strategy</h2>
        <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <label className="block">
            <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-ink-faint">Document category</span>
            <select className="input w-full" value={category} onChange={(event) => setCategory(event.target.value)}>
              <option value="PURCHASE_REQUISITION">Purchase requisition</option>
              <option value="PURCHASE_ORDER">Purchase order</option>
            </select>
          </label>
          <label className="block">
            <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-ink-faint">Release group</span>
            <input className="input w-full" value={groupCode} onChange={(event) => setGroupCode(event.target.value)} />
          </label>
          <label className="block">
            <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-ink-faint">Strategy</span>
            <input className="input w-full" value={strategyCode} onChange={(event) => setStrategyCode(event.target.value)} />
          </label>
          <label className="block">
            <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-ink-faint">Class</span>
            <input className="input w-full" value={className} onChange={(event) => setClassName(event.target.value)} />
          </label>
        </div>

        <fieldset className="mt-4 rounded-card border border-line p-3">
          <legend className="px-1 text-xs font-medium uppercase tracking-wide text-ink-faint">Criteria</legend>
          <div className="space-y-2">
            {criteria.map((row, index) => (
              <div key={index} className="grid gap-3 sm:grid-cols-3">
                <input className="input w-full" placeholder="Characteristic" value={row.characteristic}
                  onChange={(event) => {
                    const next = criteria.slice();
                    next[index] = { ...next[index], characteristic: event.target.value };
                    setCriteria(next);
                  }} />
                <select className="input w-full" value={row.operator}
                  onChange={(event) => {
                    const next = criteria.slice();
                    next[index] = { ...next[index], operator: event.target.value };
                    setCriteria(next);
                  }}>
                  <option value="EQ">Equals</option>
                  <option value="GE">At least</option>
                  <option value="GT">Greater than</option>
                  <option value="LE">At most</option>
                  <option value="LT">Less than</option>
                  <option value="BETWEEN">Between</option>
                </select>
                <input className="input w-full" placeholder="Value" value={row.value}
                  onChange={(event) => {
                    const next = criteria.slice();
                    next[index] = { ...next[index], value: event.target.value };
                    setCriteria(next);
                  }} />
              </div>
            ))}
          </div>
          <button type="button" className="btn btn-default mt-2 min-h-11 sm:min-h-8"
            onClick={() => setCriteria([...criteria, { characteristic: '', operator: 'EQ', value: '' }])}>
            Add criterion
          </button>
        </fieldset>

        <fieldset className="mt-4 rounded-card border border-line p-3">
          <legend className="px-1 text-xs font-medium uppercase tracking-wide text-ink-faint">Release codes in sequence</legend>
          <div className="space-y-2">
            {steps.map((code, index) => (
              <div key={index} className="flex items-center gap-3">
                <span className="text-sm text-ink-faint">{index + 1}</span>
                <input className="input w-full sm:w-60" value={code}
                  onChange={(event) => {
                    const next = steps.slice();
                    next[index] = event.target.value;
                    setSteps(next);
                  }} />
              </div>
            ))}
          </div>
          <button type="button" className="btn btn-default mt-2 min-h-11 sm:min-h-8"
            onClick={() => setSteps([...steps, ''])}>
            Add release code
          </button>
        </fieldset>

        <div className="mt-4 flex justify-end">
          <button type="button" className="btn btn-primary min-h-11 sm:min-h-8" disabled>
            Save strategy
          </button>
        </div>
      </section>
    </div>
  );
}
