'use client';

import { useActionState, useState } from 'react';

import type { OrderChoices, OrderDocument } from '@/modules/purchasing/orders';
import type { DocumentReleaseState } from '@/modules/purchasing/release';
import {
  cancelOrderReleaseAction,
  releaseOrderAction,
  saveOrderAction,
  type OrderActionState,
} from './actions';

/**
 * Purchase orders (SCR-056 / ME21N; inert in stage 1, live since
 * stage 3). Header with the item grid, per-item schedule lines and
 * account assignment. The net value is the stated baseline — quantity
 * × net price ÷ price unit. A flagged material warns on save; the
 * flag never blocks an order.
 */

interface ScheduleRow {
  deliveryDate: string;
  quantity: string;
}

interface AssignmentRow {
  glAccount: string;
  costCenter: string;
  percentage: string;
}

interface ItemRow {
  itemNumber?: number;
  material: string;
  text: string;
  quantity: string;
  unit: string;
  netPrice: string;
  priceUnit: string;
  taxCode: string;
  plant: string;
  storageLocation: string;
  requisitionNumber: string;
  requisitionItem: string;
  assignment: 'STOCK' | 'COST_CENTER';
  markedForDeletion: boolean;
  scheduleLines: ScheduleRow[];
  assignments: AssignmentRow[];
}

const EMPTY_ITEM: ItemRow = {
  material: '',
  text: '',
  quantity: '',
  unit: '',
  netPrice: '',
  priceUnit: '1',
  taxCode: '',
  plant: '',
  storageLocation: '',
  requisitionNumber: '',
  requisitionItem: '',
  assignment: 'STOCK',
  markedForDeletion: false,
  scheduleLines: [{ deliveryDate: '', quantity: '' }],
  assignments: [{ glAccount: '', costCenter: '', percentage: '100' }],
};

function itemFromDocument(item: OrderDocument['items'][number]): ItemRow {
  return {
    itemNumber: item.itemNumber,
    material: item.materialNumber ?? '',
    text: item.shortText,
    quantity: item.quantity,
    unit: item.unit,
    netPrice: item.netPrice,
    priceUnit: item.priceUnit,
    taxCode: item.taxCode ?? '',
    plant: item.plant,
    storageLocation: item.storageLocation ?? '',
    requisitionNumber: item.requisitionNumber ?? '',
    requisitionItem: item.requisitionItem ? String(item.requisitionItem) : '',
    assignment: item.accountAssignmentCategory === 'COST_CENTER' ? 'COST_CENTER' : 'STOCK',
    markedForDeletion: item.markedForDeletion,
    scheduleLines: item.scheduleLines.map((s) => ({ deliveryDate: s.deliveryDate, quantity: s.quantity })),
    assignments: item.assignments.length > 0
      ? item.assignments.map((a) => ({
          glAccount: a.glAccount, costCenter: a.costCenter, percentage: a.distributionPercentage,
        }))
      : [{ glAccount: '', costCenter: '', percentage: '100' }],
  };
}

const INITIAL: OrderActionState = { ok: false };

export default function Orders({ documents, choices, selected, canCreate, releases, selectedRelease, canRelease }: {
  documents: OrderDocument[];
  choices: OrderChoices;
  selected: OrderDocument | null;
  canCreate: boolean;
  releases: Record<string, DocumentReleaseState>;
  selectedRelease: DocumentReleaseState | null;
  canRelease: boolean;
}) {
  const [state, formAction, pending] = useActionState(saveOrderAction, INITIAL);
  const [releaseState, releaseAction] = useActionState(releaseOrderAction, INITIAL);
  const [cancelState, cancelAction] = useActionState(cancelOrderReleaseAction, INITIAL);
  const releaseMessage = cancelState.message ? cancelState : releaseState;
  const [header, setHeader] = useState({
    documentType: selected?.documentType ?? 'STANDARD',
    supplierNumber: selected?.supplierNumber ?? '',
    purchasingOrg: selected?.purchasingOrg ?? '',
    purchasingGroup: selected?.purchasingGroup ?? '',
    companyCode: selected?.companyCode ?? '',
    currency: selected?.currency ?? '',
  });
  const [items, setItems] = useState<ItemRow[]>(
    selected ? selected.items.map(itemFromDocument) : [{ ...EMPTY_ITEM }],
  );

  function patch(index: number, next: Partial<ItemRow>) {
    setItems(items.map((item, i) => (i === index ? { ...item, ...next } : item)));
  }

  function payload(): string {
    return JSON.stringify({
      ...header,
      items: items.map((item) => ({
        itemNumber: item.itemNumber,
        materialNumber: item.material,
        shortText: item.text,
        quantity: Number(item.quantity),
        unit: item.unit,
        netPrice: Number(item.netPrice),
        priceUnit: Number(item.priceUnit || 1),
        taxCode: item.taxCode,
        plant: item.plant,
        storageLocation: item.storageLocation,
        accountAssignmentCategory: item.assignment === 'COST_CENTER' ? 'COST_CENTER' : null,
        markedForDeletion: item.markedForDeletion,
        requisitionNumber: item.requisitionNumber,
        requisitionItem: item.requisitionItem ? Number(item.requisitionItem) : undefined,
        scheduleLines: item.scheduleLines.map((line) => ({
          deliveryDate: line.deliveryDate, quantity: Number(line.quantity),
        })),
        assignments: item.assignment === 'COST_CENTER'
          ? item.assignments.map((row) => ({
              glAccount: row.glAccount, costCenter: row.costCenter,
              distributionPercentage: Number(row.percentage),
            }))
          : [],
      })),
    });
  }

  const itemFields: Array<{ key: 'material' | 'text' | 'quantity' | 'unit' | 'netPrice' | 'priceUnit' | 'taxCode' | 'requisitionNumber' | 'requisitionItem'; label: string; width: string }> = [
    { key: 'material', label: 'Material', width: 'w-32' },
    { key: 'text', label: 'Short text', width: 'w-44' },
    { key: 'quantity', label: 'Order quantity', width: 'w-28' },
    { key: 'unit', label: 'Order unit', width: 'w-16' },
    { key: 'netPrice', label: 'Net price', width: 'w-28' },
    { key: 'priceUnit', label: 'Price unit', width: 'w-20' },
    { key: 'taxCode', label: 'Tax code', width: 'w-20' },
    { key: 'requisitionNumber', label: 'Requisition', width: 'w-32' },
    { key: 'requisitionItem', label: 'Req. item', width: 'w-20' },
  ];

  return (
    <div className="space-y-4">
      <section aria-labelledby="po-overview" className="rounded-card border border-line bg-surface p-4 shadow-card">
        <h2 id="po-overview" className="text-sm font-semibold">Purchase orders</h2>
        {documents.length === 0 ? (
          <p className="mt-2 text-sm text-ink-soft">No purchase orders stand yet. Create the first below.</p>
        ) : (
          <table className="mt-2 w-full text-sm">
            <thead>
              <tr className="border-b border-line text-left">
                <th className="px-2 py-2">Order</th>
                <th className="px-2 py-2">Supplier</th>
                <th className="px-2 py-2">Date</th>
                <th className="px-2 py-2">Currency</th>
                <th className="px-2 py-2">Items</th>
                <th className="px-2 py-2">Release</th>
              </tr>
            </thead>
            <tbody>
              {documents.map((doc) => (
                <tr key={doc.orderNumber} className="border-b border-line/60">
                  <td className="px-2 py-2">
                    <a className="underline" href={`/purchasing/orders?order=${doc.orderNumber}`}>{doc.orderNumber}</a>
                  </td>
                  <td className="px-2 py-2">{doc.supplierName || doc.supplierNumber}</td>
                  <td className="px-2 py-2">{doc.documentDate}</td>
                  <td className="px-2 py-2">{doc.currency}</td>
                  <td className="px-2 py-2">{doc.items.length}</td>
                  <td className="px-2 py-2">
                    {releases[doc.orderNumber]
                      ? releases[doc.orderNumber].status === 'RELEASED'
                        ? 'Released'
                        : `Pending · step ${releases[doc.orderNumber].currentStep} of ${releases[doc.orderNumber].steps.length}`
                      : 'Not required'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      {selected && selectedRelease && (
        <section aria-labelledby="po-release" className="rounded-card border border-line bg-surface p-4 shadow-card">
          <h2 id="po-release" className="text-sm font-semibold">Release</h2>
          {selectedRelease.status === 'NOT_REQUIRED' ? (
            <p className="mt-2 text-sm text-ink-soft">
              No release strategy claims purchase order {selected.orderNumber}; it needs no release.
            </p>
          ) : (
            <>
              <p className="mt-2 text-sm text-ink-soft">
                Strategy {selectedRelease.groupCode} / {selectedRelease.strategyCode}:{' '}
                {selectedRelease.status === 'RELEASED'
                  ? 'fully released'
                  : `released through step ${selectedRelease.currentStep} of ${selectedRelease.steps.length}`}
                {' '}({selectedRelease.steps.map((code, i) => `${i + 1}. ${code}`).join(' · ')}).
              </p>
              {releaseMessage.message && (
                <p role="status" className={`mt-2 text-sm ${releaseMessage.ok ? 'text-ink' : 'text-red-700'}`}>
                  {releaseMessage.message}
                  {releaseMessage.remedy ? ` ${releaseMessage.remedy}` : ''}
                </p>
              )}
              <div className="mt-3 flex flex-wrap items-end gap-2">
                {selectedRelease.status === 'PENDING' && (
                  <form action={releaseAction}>
                    <input type="hidden" name="orderNumberValue" value={selected.orderNumber} />
                    <label className="block">
                      <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-ink-faint">Release code</span>
                      <select name="releaseCode" className="input w-48">
                        {selectedRelease.steps.map((code) => (
                          <option key={code} value={code}>{code}</option>
                        ))}
                      </select>
                    </label>
                    <button type="submit" className="btn btn-primary mt-2 min-h-11 sm:min-h-8" disabled={!canRelease}>
                      Release step {selectedRelease.currentStep + 1}
                    </button>
                  </form>
                )}
                {(selectedRelease.currentStep > 0 || selectedRelease.status === 'RELEASED') && (
                  <form action={cancelAction}>
                    <input type="hidden" name="orderNumberValue" value={selected.orderNumber} />
                    <button type="submit" className="btn btn-default min-h-11 sm:min-h-8" disabled={!canRelease}>
                      Cancel release
                    </button>
                  </form>
                )}
              </div>
            </>
          )}
        </section>
      )}

      <section aria-labelledby="po-create" className="rounded-card border border-line bg-surface p-4 shadow-card">
        <h2 id="po-create" className="text-sm font-semibold">
          {selected ? `Purchase order ${selected.orderNumber}` : 'New purchase order'}
        </h2>

        <form action={formAction}>
          <input type="hidden" name="payload" value={payload()} />
          <input type="hidden" name="orderNumber" value={selected?.orderNumber ?? ''} />

          <div className="mt-3 grid gap-3 sm:grid-cols-3 lg:grid-cols-5">
            <label className="block">
              <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-ink-faint">Supplier</span>
              <input
                className="input w-full"
                list="po-suppliers"
                value={header.supplierNumber}
                onChange={(event) => setHeader({ ...header, supplierNumber: event.target.value })}
              />
              <datalist id="po-suppliers">
                {choices.suppliers.map((s) => (
                  <option key={`${s.partnerNumber}-${s.purchasingOrg}`} value={s.partnerNumber}>
                    {s.name} · org {s.purchasingOrg}
                  </option>
                ))}
              </datalist>
            </label>
            <label className="block">
              <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-ink-faint">Purchasing organization</span>
              <select
                className="input w-full"
                value={header.purchasingOrg}
                onChange={(event) => setHeader({ ...header, purchasingOrg: event.target.value })}
              >
                <option value="">—</option>
                {choices.purchasingOrgs.map((o) => (
                  <option key={o.purchasingOrg} value={o.purchasingOrg}>{o.purchasingOrg} · {o.name}</option>
                ))}
              </select>
            </label>
            <label className="block">
              <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-ink-faint">Purchasing group</span>
              <select
                className="input w-full"
                value={header.purchasingGroup}
                onChange={(event) => setHeader({ ...header, purchasingGroup: event.target.value })}
              >
                <option value="">—</option>
                {choices.purchasingGroups.map((g) => (
                  <option key={g.purchasingGroup} value={g.purchasingGroup}>{g.purchasingGroup} · {g.name}</option>
                ))}
              </select>
            </label>
            <label className="block">
              <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-ink-faint">Company code</span>
              <select
                className="input w-full"
                value={header.companyCode}
                onChange={(event) => setHeader({ ...header, companyCode: event.target.value })}
              >
                <option value="">—</option>
                {choices.companies.map((c) => (
                  <option key={c.companyCode} value={c.companyCode}>{c.companyCode} · {c.name}</option>
                ))}
              </select>
            </label>
            <label className="block">
              <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-ink-faint">Currency</span>
              <input
                className="input w-full"
                value={header.currency}
                placeholder="From supplier / company"
                onChange={(event) => setHeader({ ...header, currency: event.target.value })}
              />
            </label>
          </div>

          <div className="mt-3 overflow-x-auto">
            <table className="w-full min-w-[1100px] text-sm">
              <thead>
                <tr className="border-b border-line text-left">
                  <th className="px-2 py-2">Item</th>
                  {itemFields.map((field) => (
                    <th key={field.key} className="px-2 py-2">{field.label}</th>
                  ))}
                  <th className="px-2 py-2">Plant</th>
                  <th className="px-2 py-2">Storage location</th>
                  <th className="px-2 py-2">Net value</th>
                  {selected && <th className="px-2 py-2">Marked for deletion</th>}
                </tr>
              </thead>
              <tbody>
                {items.map((item, index) => {
                  const value = Number(item.quantity) * Number(item.netPrice) / Math.max(1, Number(item.priceUnit) || 1);
                  return (
                    <tr key={index} className="border-b border-line/60 align-top">
                      <td className="px-2 py-2 text-ink-faint">{String(item.itemNumber ?? (index + 1) * 10).padStart(5, '0')}</td>
                      {itemFields.map((field) => (
                        <td key={field.key} className="px-1 py-1">
                          <input
                            className={`input ${field.width}`}
                            value={item[field.key]}
                            onChange={(event) => patch(index, { [field.key]: event.target.value })}
                          />
                        </td>
                      ))}
                      <td className="px-1 py-1">
                        <select
                          className="input w-36"
                          value={item.plant}
                          onChange={(event) => patch(index, { plant: event.target.value, storageLocation: '' })}
                        >
                          <option value="">—</option>
                          {choices.plants.map((p) => (
                            <option key={p.plant} value={p.plant}>{p.plant} · {p.name}</option>
                          ))}
                        </select>
                      </td>
                      <td className="px-1 py-1">
                        <select
                          className="input w-32"
                          value={item.storageLocation}
                          onChange={(event) => patch(index, { storageLocation: event.target.value })}
                        >
                          <option value="">—</option>
                          {choices.storageLocations.filter((sl) => sl.plant === item.plant).map((sl) => (
                            <option key={sl.storageLocation} value={sl.storageLocation}>{sl.storageLocation} · {sl.name}</option>
                          ))}
                        </select>
                      </td>
                      <td className="px-2 py-2">{item.quantity && item.netPrice ? value.toFixed(2) : ''}</td>
                      {selected && (
                        <td className="px-1 py-2">
                          <input
                            type="checkbox"
                            checked={item.markedForDeletion}
                            onChange={(event) => patch(index, { markedForDeletion: event.target.checked })}
                          />
                        </td>
                      )}
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
                Item {String(item.itemNumber ?? (index + 1) * 10).padStart(5, '0')} · Schedule lines and account assignment
              </legend>
              <div className="space-y-2">
                {item.scheduleLines.map((line, lineIndex) => (
                  <div key={lineIndex} className="grid gap-3 sm:grid-cols-2">
                    <input
                      className="input w-full"
                      type="date"
                      value={line.deliveryDate}
                      onChange={(event) => {
                        const lines = item.scheduleLines.slice();
                        lines[lineIndex] = { ...lines[lineIndex], deliveryDate: event.target.value };
                        patch(index, { scheduleLines: lines });
                      }}
                    />
                    <input
                      className="input w-full"
                      placeholder="Scheduled quantity"
                      value={line.quantity}
                      onChange={(event) => {
                        const lines = item.scheduleLines.slice();
                        lines[lineIndex] = { ...lines[lineIndex], quantity: event.target.value };
                        patch(index, { scheduleLines: lines });
                      }}
                    />
                  </div>
                ))}
                <button
                  type="button"
                  className="btn btn-default min-h-11 sm:min-h-8"
                  onClick={() => patch(index, {
                    scheduleLines: [...item.scheduleLines, { deliveryDate: '', quantity: '' }],
                  })}
                >
                  Add schedule line
                </button>
              </div>

              <div className="mt-3 flex flex-wrap items-center gap-4 text-sm">
                <label className="inline-flex items-center gap-2">
                  <input type="radio" name={`assignment-${index}`} checked={item.assignment === 'STOCK'}
                    onChange={() => patch(index, { assignment: 'STOCK' })} />
                  Stock (no account assignment)
                </label>
                <label className="inline-flex items-center gap-2">
                  <input type="radio" name={`assignment-${index}`} checked={item.assignment === 'COST_CENTER'}
                    onChange={() => patch(index, { assignment: 'COST_CENTER' })} />
                  Cost centre
                </label>
              </div>
              {item.assignment === 'COST_CENTER' && (
                <div className="mt-3 space-y-2">
                  {item.assignments.map((row, rowIndex) => (
                    <div key={rowIndex} className="grid gap-3 sm:grid-cols-3">
                      <input className="input w-full" placeholder="Cost centre" value={row.costCenter}
                        onChange={(event) => {
                          const rows = item.assignments.slice();
                          rows[rowIndex] = { ...rows[rowIndex], costCenter: event.target.value };
                          patch(index, { assignments: rows });
                        }} />
                      <input className="input w-full" placeholder="G/L account" value={row.glAccount}
                        onChange={(event) => {
                          const rows = item.assignments.slice();
                          rows[rowIndex] = { ...rows[rowIndex], glAccount: event.target.value };
                          patch(index, { assignments: rows });
                        }} />
                      <input className="input w-full" placeholder="Distribution %" value={row.percentage}
                        onChange={(event) => {
                          const rows = item.assignments.slice();
                          rows[rowIndex] = { ...rows[rowIndex], percentage: event.target.value };
                          patch(index, { assignments: rows });
                        }} />
                    </div>
                  ))}
                  <button
                    type="button"
                    className="btn btn-default min-h-11 sm:min-h-8"
                    onClick={() => patch(index, {
                      assignments: [...item.assignments, { glAccount: '', costCenter: '', percentage: '0' }],
                    })}
                  >
                    Add assignment row
                  </button>
                </div>
              )}
            </fieldset>
          ))}

          {state.message && (
            <p role="status" className={`mt-3 text-sm ${state.ok ? 'text-ink' : 'text-red-700'}`}>
              {state.message}
              {state.remedy ? ` ${state.remedy}` : ''}
            </p>
          )}
          {state.warnings?.map((warning) => (
            <p key={warning} role="status" className="mt-1 text-sm text-amber-700">{warning}</p>
          ))}

          <div className="mt-4 flex justify-end">
            <button type="submit" className="btn btn-primary min-h-11 sm:min-h-8" disabled={!canCreate || pending}>
              {selected ? 'Save changes' : 'Save purchase order'}
            </button>
          </div>
        </form>
      </section>
    </div>
  );
}
