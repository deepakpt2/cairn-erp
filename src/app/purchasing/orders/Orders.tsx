'use client';

import { useState } from 'react';

/**
 * Purchase orders (SCR-056 / ME21N; inert since stage 1).
 *
 * The document shape the round builds: an overview of standing
 * orders, the header, the item grid, and per-item schedule lines and
 * account assignment. Stage 3 wires the acts.
 */

interface ItemRow {
  material: string;
  text: string;
  quantity: string;
  unit: string;
  netPrice: string;
  priceUnit: string;
  plant: string;
  storageLocation: string;
  taxCode: string;
  requisition: string;
  scheduleDate: string;
  scheduleQuantity: string;
  assignment: 'STOCK' | 'COST_CENTER';
  costCenter: string;
  glAccount: string;
  percentage: string;
}

const EMPTY_ITEM: ItemRow = {
  material: '',
  text: '',
  quantity: '',
  unit: '',
  netPrice: '',
  priceUnit: '1',
  plant: '',
  storageLocation: '',
  taxCode: '',
  requisition: '',
  scheduleDate: '',
  scheduleQuantity: '',
  assignment: 'STOCK',
  costCenter: '',
  glAccount: '',
  percentage: '100',
};

const HEADER_FIELDS = [
  { key: 'supplier', label: 'Supplier' },
  { key: 'purchasingOrg', label: 'Purchasing organization' },
  { key: 'purchasingGroup', label: 'Purchasing group' },
  { key: 'companyCode', label: 'Company code' },
  { key: 'currency', label: 'Currency' },
] as const;

const ITEM_FIELDS: Array<{ key: keyof ItemRow; label: string; width: string }> = [
  { key: 'material', label: 'Material', width: 'w-32' },
  { key: 'text', label: 'Short text', width: 'w-44' },
  { key: 'quantity', label: 'Order quantity', width: 'w-28' },
  { key: 'unit', label: 'Order unit', width: 'w-16' },
  { key: 'netPrice', label: 'Net price', width: 'w-28' },
  { key: 'priceUnit', label: 'Price unit', width: 'w-20' },
  { key: 'plant', label: 'Plant', width: 'w-20' },
  { key: 'storageLocation', label: 'Storage location', width: 'w-28' },
  { key: 'taxCode', label: 'Tax code', width: 'w-20' },
  { key: 'requisition', label: 'Requisition item', width: 'w-32' },
];

export default function Orders() {
  const [header, setHeader] = useState({ supplier: '', purchasingOrg: '', purchasingGroup: '', companyCode: '', currency: '' });
  const [items, setItems] = useState<ItemRow[]>([{ ...EMPTY_ITEM }]);

  function patch(index: number, next: Partial<ItemRow>) {
    setItems(items.map((item, i) => (i === index ? { ...item, ...next } : item)));
  }

  return (
    <div className="space-y-4">
      <section aria-labelledby="po-overview" className="rounded-card border border-line bg-surface p-4 shadow-card">
        <h2 id="po-overview" className="text-sm font-semibold">Purchase orders</h2>
        <p className="mt-2 text-sm text-ink-soft">No purchase orders stand yet. Create the first below.</p>
      </section>

      <section aria-labelledby="po-create" className="rounded-card border border-line bg-surface p-4 shadow-card">
        <h2 id="po-create" className="text-sm font-semibold">New purchase order</h2>

        <div className="mt-3 grid gap-3 sm:grid-cols-3 lg:grid-cols-5">
          {HEADER_FIELDS.map((field) => (
            <label key={field.key} className="block">
              <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-ink-faint">{field.label}</span>
              <input
                className="input w-full"
                value={header[field.key]}
                onChange={(event) => setHeader({ ...header, [field.key]: event.target.value })}
              />
            </label>
          ))}
        </div>

        <div className="mt-3 overflow-x-auto">
          <table className="w-full min-w-[1100px] text-sm">
            <thead>
              <tr className="border-b border-line text-left">
                <th className="px-2 py-2">Item</th>
                {ITEM_FIELDS.map((field) => (
                  <th key={field.key} className="px-2 py-2">{field.label}</th>
                ))}
                <th className="px-2 py-2">Net value</th>
              </tr>
            </thead>
            <tbody>
              {items.map((item, index) => {
                const value = Number(item.quantity) * Number(item.netPrice) / Math.max(1, Number(item.priceUnit) || 1);
                return (
                  <tr key={index} className="border-b border-line/60 align-top">
                    <td className="px-2 py-2 text-ink-faint">{String((index + 1) * 10).padStart(5, '0')}</td>
                    {ITEM_FIELDS.map((field) => (
                      <td key={field.key} className="px-1 py-1">
                        <input
                          className={`input ${field.width}`}
                          value={item[field.key]}
                          onChange={(event) => patch(index, { [field.key]: event.target.value })}
                        />
                      </td>
                    ))}
                    <td className="px-2 py-2">{Number.isFinite(value) && item.quantity ? value.toFixed(2) : ''}</td>
                  </tr>
                );
              })}
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
              Item {String((index + 1) * 10).padStart(5, '0')} · Schedule lines and account assignment
            </legend>
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="block">
                <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-ink-faint">Delivery date</span>
                <input
                  className="input w-full"
                  type="date"
                  value={item.scheduleDate}
                  onChange={(event) => patch(index, { scheduleDate: event.target.value })}
                />
              </label>
              <label className="block">
                <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-ink-faint">Scheduled quantity</span>
                <input
                  className="input w-full"
                  value={item.scheduleQuantity}
                  onChange={(event) => patch(index, { scheduleQuantity: event.target.value })}
                />
              </label>
            </div>
            <div className="mt-3 flex flex-wrap items-center gap-4 text-sm">
              <label className="inline-flex items-center gap-2">
                <input
                  type="radio"
                  name={`assignment-${index}`}
                  checked={item.assignment === 'STOCK'}
                  onChange={() => patch(index, { assignment: 'STOCK' })}
                />
                Stock (no account assignment)
              </label>
              <label className="inline-flex items-center gap-2">
                <input
                  type="radio"
                  name={`assignment-${index}`}
                  checked={item.assignment === 'COST_CENTER'}
                  onChange={() => patch(index, { assignment: 'COST_CENTER' })}
                />
                Cost centre
              </label>
            </div>
            {item.assignment === 'COST_CENTER' && (
              <div className="mt-3 grid gap-3 sm:grid-cols-3">
                <input className="input w-full" placeholder="Cost centre" value={item.costCenter}
                  onChange={(event) => patch(index, { costCenter: event.target.value })} />
                <input className="input w-full" placeholder="G/L account" value={item.glAccount}
                  onChange={(event) => patch(index, { glAccount: event.target.value })} />
                <input className="input w-full" placeholder="Distribution %" value={item.percentage}
                  onChange={(event) => patch(index, { percentage: event.target.value })} />
              </div>
            )}
          </fieldset>
        ))}

        <div className="mt-4 flex justify-end">
          <button type="button" className="btn btn-primary min-h-11 sm:min-h-8" disabled>
            Save purchase order
          </button>
        </div>
      </section>
    </div>
  );
}
