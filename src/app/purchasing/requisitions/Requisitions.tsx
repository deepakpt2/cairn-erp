'use client';

import { useState } from 'react';

/**
 * Purchase requisitions (SCR-055 / ME51N; inert since stage 1).
 *
 * The document shape the round builds: an overview of standing
 * requisitions, and the item grid — one row per requisition item with
 * its account-assignment panel. Stage 3 wires the acts.
 */

type ItemRow = {
  material: string;
  text: string;
  quantity: string;
  unit: string;
  deliveryDate: string;
  plant: string;
  storageLocation: string;
  purchasingGroup: string;
  estimatedPrice: string;
  priceUnit: string;
  currency: string;
  assignment: 'STOCK' | 'COST_CENTER';
  costCenter: string;
  glAccount: string;
  percentage: string;
};

export const EMPTY_ITEM: ItemRow = {
  material: '',
  text: '',
  quantity: '',
  unit: '',
  deliveryDate: '',
  plant: '',
  storageLocation: '',
  purchasingGroup: '',
  estimatedPrice: '',
  priceUnit: '1',
  currency: '',
  assignment: 'STOCK',
  costCenter: '',
  glAccount: '',
  percentage: '100',
};

const GRID_FIELDS: Array<{ key: keyof ItemRow; label: string; width: string }> = [
  { key: 'material', label: 'Material', width: 'w-32' },
  { key: 'text', label: 'Short text', width: 'w-44' },
  { key: 'quantity', label: 'Quantity', width: 'w-24' },
  { key: 'unit', label: 'Unit', width: 'w-16' },
  { key: 'deliveryDate', label: 'Delivery date', width: 'w-32' },
  { key: 'plant', label: 'Plant', width: 'w-20' },
  { key: 'storageLocation', label: 'Storage location', width: 'w-28' },
  { key: 'purchasingGroup', label: 'Purchasing group', width: 'w-28' },
  { key: 'estimatedPrice', label: 'Estimated price', width: 'w-28' },
  { key: 'priceUnit', label: 'Price unit', width: 'w-20' },
  { key: 'currency', label: 'Currency', width: 'w-20' },
];

export default function Requisitions() {
  const [items, setItems] = useState<ItemRow[]>([{ ...EMPTY_ITEM }]);
  const [documentType, setDocumentType] = useState('STANDARD');

  return (
    <div className="space-y-4">
      <section aria-labelledby="pr-overview" className="rounded-card border border-line bg-surface p-4 shadow-card">
        <h2 id="pr-overview" className="text-sm font-semibold">Requisitions</h2>
        <p className="mt-2 text-sm text-ink-soft">No requisitions stand yet. Create the first below.</p>
      </section>

      <section aria-labelledby="pr-create" className="rounded-card border border-line bg-surface p-4 shadow-card">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <h2 id="pr-create" className="text-sm font-semibold">New requisition</h2>
          <label className="block">
            <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-ink-faint">Document type</span>
            <select
              className="input w-56"
              value={documentType}
              onChange={(event) => setDocumentType(event.target.value)}
            >
              <option value="STANDARD">Standard requisition</option>
            </select>
          </label>
        </div>

        <div className="mt-3 overflow-x-auto">
          <table className="w-full min-w-[1100px] text-sm">
            <thead>
              <tr className="border-b border-line text-left">
                <th className="px-2 py-2">Item</th>
                {GRID_FIELDS.map((field) => (
                  <th key={field.key} className="px-2 py-2">{field.label}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {items.map((item, index) => (
                <tr key={index} className="border-b border-line/60 align-top">
                  <td className="px-2 py-2 text-ink-faint">{String((index + 1) * 10).padStart(5, '0')}</td>
                  {GRID_FIELDS.map((field) => (
                    <td key={field.key} className="px-1 py-1">
                      <input
                        className={`input ${field.width}`}
                        value={item[field.key] as string}
                        onChange={(event) => {
                          const next = items.slice();
                          next[index] = { ...next[index], [field.key]: event.target.value };
                          setItems(next);
                        }}
                      />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <button
          type="button"
          className="btn btn-default mt-2 min-h-11 sm:min-h-8"
          onClick={() => setItems([...items, { ...EMPTY_ITEM }])}
        >
          Add item
        </button>

        {items.map((item, index) => (
          <fieldset key={index} className="mt-4 rounded-card border border-line p-3">
            <legend className="px-1 text-xs font-medium uppercase tracking-wide text-ink-faint">
              Item {String((index + 1) * 10).padStart(5, '0')} · Account assignment
            </legend>
            <div className="flex flex-wrap items-center gap-4 text-sm">
              <label className="inline-flex items-center gap-2">
                <input
                  type="radio"
                  name={`assignment-${index}`}
                  checked={item.assignment === 'STOCK'}
                  onChange={() => {
                    const next = items.slice();
                    next[index] = { ...next[index], assignment: 'STOCK' };
                    setItems(next);
                  }}
                />
                Stock (no account assignment)
              </label>
              <label className="inline-flex items-center gap-2">
                <input
                  type="radio"
                  name={`assignment-${index}`}
                  checked={item.assignment === 'COST_CENTER'}
                  onChange={() => {
                    const next = items.slice();
                    next[index] = { ...next[index], assignment: 'COST_CENTER' };
                    setItems(next);
                  }}
                />
                Cost centre
              </label>
            </div>
            {item.assignment === 'COST_CENTER' && (
              <div className="mt-3 grid gap-3 sm:grid-cols-3">
                <label className="block">
                  <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-ink-faint">Cost centre</span>
                  <input
                    className="input w-full"
                    value={item.costCenter}
                    onChange={(event) => {
                      const next = items.slice();
                      next[index] = { ...next[index], costCenter: event.target.value };
                      setItems(next);
                    }}
                  />
                </label>
                <label className="block">
                  <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-ink-faint">G/L account</span>
                  <input
                    className="input w-full"
                    value={item.glAccount}
                    onChange={(event) => {
                      const next = items.slice();
                      next[index] = { ...next[index], glAccount: event.target.value };
                      setItems(next);
                    }}
                  />
                </label>
                <label className="block">
                  <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-ink-faint">Distribution %</span>
                  <input
                    className="input w-full"
                    value={item.percentage}
                    onChange={(event) => {
                      const next = items.slice();
                      next[index] = { ...next[index], percentage: event.target.value };
                      setItems(next);
                    }}
                  />
                </label>
              </div>
            )}
          </fieldset>
        ))}

        <div className="mt-4 flex justify-end">
          <button type="button" className="btn btn-primary min-h-11 sm:min-h-8" disabled>
            Save requisition
          </button>
        </div>
      </section>
    </div>
  );
}
