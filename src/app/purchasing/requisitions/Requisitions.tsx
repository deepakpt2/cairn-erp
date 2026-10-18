'use client';

import { useActionState, useState } from 'react';

import type {
  RequisitionChoices,
  RequisitionDocument,
} from '@/modules/purchasing/requisitions';
import type { DocumentReleaseState } from '@/modules/purchasing/release';
import {
  cancelRequisitionReleaseAction,
  releaseRequisitionAction,
  saveRequisitionAction,
  type ReleaseActionState,
  type RequisitionActionState,
} from './actions';

/**
 * Purchase requisitions (SCR-055 / ME51N; inert in stage 1, live since
 * stage 3). The document overview beside the item grid — one row per
 * requisition item with its account-assignment panel. A flagged
 * material warns on save; the flag never blocks a requisition.
 */

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
  deliveryDate: string;
  plant: string;
  storageLocation: string;
  purchasingGroup: string;
  estimatedPrice: string;
  priceUnit: string;
  currency: string;
  assignment: 'STOCK' | 'COST_CENTER';
  markedForDeletion: boolean;
  assignments: AssignmentRow[];
}

const EMPTY_ITEM: ItemRow = {
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
  markedForDeletion: false,
  assignments: [{ glAccount: '', costCenter: '', percentage: '100' }],
};

function itemFromDocument(item: RequisitionDocument['items'][number]): ItemRow {
  return {
    itemNumber: item.itemNumber,
    material: item.materialNumber ?? '',
    text: item.shortText,
    quantity: item.quantity,
    unit: item.unit,
    deliveryDate: item.deliveryDate,
    plant: item.plant,
    storageLocation: item.storageLocation ?? '',
    purchasingGroup: item.purchasingGroup,
    estimatedPrice: item.estimatedPrice ?? '',
    priceUnit: item.priceUnit,
    currency: item.currency ?? '',
    assignment: item.accountAssignmentCategory === 'COST_CENTER' ? 'COST_CENTER' : 'STOCK',
    markedForDeletion: item.markedForDeletion,
    assignments: item.assignments.length > 0
      ? item.assignments.map((a) => ({
          glAccount: a.glAccount,
          costCenter: a.costCenter,
          percentage: a.distributionPercentage,
        }))
      : [{ glAccount: '', costCenter: '', percentage: '100' }],
  };
}

const INITIAL: RequisitionActionState = { ok: false };

export default function Requisitions({ documents, choices, selected, canCreate, releases, selectedRelease, canRelease }: {
  documents: RequisitionDocument[];
  choices: RequisitionChoices;
  selected: RequisitionDocument | null;
  canCreate: boolean;
  releases: Record<string, DocumentReleaseState>;
  selectedRelease: DocumentReleaseState | null;
  canRelease: boolean;
}) {
  const [state, formAction, pending] = useActionState(saveRequisitionAction, INITIAL);
  const [releaseState, releaseAction] = useActionState(releaseRequisitionAction, { ok: false } as ReleaseActionState);
  const [cancelState, cancelAction] = useActionState(cancelRequisitionReleaseAction, { ok: false } as ReleaseActionState);
  const releaseMessage = cancelState.message ? cancelState : releaseState;
  const [documentType, setDocumentType] = useState(selected?.documentType ?? 'STANDARD');
  const [items, setItems] = useState<ItemRow[]>(
    selected ? selected.items.map(itemFromDocument) : [{ ...EMPTY_ITEM }],
  );

  function patch(index: number, next: Partial<ItemRow>) {
    setItems(items.map((item, i) => (i === index ? { ...item, ...next } : item)));
  }

  function payload(): string {
    return JSON.stringify({
      documentType,
      items: items.map((item) => ({
        itemNumber: item.itemNumber,
        materialNumber: item.material,
        shortText: item.text,
        quantity: Number(item.quantity),
        unit: item.unit,
        deliveryDate: item.deliveryDate,
        plant: item.plant,
        storageLocation: item.storageLocation,
        purchasingGroup: item.purchasingGroup,
        estimatedPrice: item.estimatedPrice === '' ? undefined : Number(item.estimatedPrice),
        priceUnit: Number(item.priceUnit || 1),
        currency: item.currency,
        accountAssignmentCategory: item.assignment === 'COST_CENTER' ? 'COST_CENTER' : null,
        markedForDeletion: item.markedForDeletion,
        assignments: item.assignment === 'COST_CENTER'
          ? item.assignments.map((row) => ({
              glAccount: row.glAccount,
              costCenter: row.costCenter,
              distributionPercentage: Number(row.percentage),
            }))
          : [],
      })),
    });
  }

  const textFields: Array<{ key: 'material' | 'text' | 'quantity' | 'unit' | 'deliveryDate' | 'estimatedPrice' | 'priceUnit' | 'currency'; label: string; width: string; type?: string }> = [
    { key: 'material', label: 'Material', width: 'w-32' },
    { key: 'text', label: 'Short text', width: 'w-44' },
    { key: 'quantity', label: 'Quantity', width: 'w-24' },
    { key: 'unit', label: 'Unit', width: 'w-16' },
    { key: 'deliveryDate', label: 'Delivery date', width: 'w-32', type: 'date' },
    { key: 'estimatedPrice', label: 'Estimated price', width: 'w-28' },
    { key: 'priceUnit', label: 'Price unit', width: 'w-20' },
    { key: 'currency', label: 'Currency', width: 'w-20' },
  ];

  return (
    <div className="space-y-4">
      <section aria-labelledby="pr-overview" className="rounded-card border border-line bg-surface p-4 shadow-card">
        <h2 id="pr-overview" className="text-sm font-semibold">Requisitions</h2>
        {documents.length === 0 ? (
          <p className="mt-2 text-sm text-ink-soft">No requisitions stand yet. Create the first below.</p>
        ) : (
          <table className="mt-2 w-full text-sm">
            <thead>
              <tr className="border-b border-line text-left">
                <th className="px-2 py-2">Requisition</th>
                <th className="px-2 py-2">Type</th>
                <th className="px-2 py-2">Date</th>
                <th className="px-2 py-2">Items</th>
                <th className="px-2 py-2">Created by</th>
                <th className="px-2 py-2">Release</th>
              </tr>
            </thead>
            <tbody>
              {documents.map((doc) => (
                <tr key={doc.requisitionNumber} className="border-b border-line/60">
                  <td className="px-2 py-2">
                    <a className="underline" href={`/purchasing/requisitions?req=${doc.requisitionNumber}`}>
                      {doc.requisitionNumber}
                    </a>
                  </td>
                  <td className="px-2 py-2">{doc.documentType}</td>
                  <td className="px-2 py-2">{doc.requisitionDate}</td>
                  <td className="px-2 py-2">{doc.items.length}</td>
                  <td className="px-2 py-2">{doc.createdBy}</td>
                  <td className="px-2 py-2">
                    {releases[doc.requisitionNumber]
                      ? releases[doc.requisitionNumber].status === 'RELEASED'
                        ? 'Released'
                        : `Pending · step ${releases[doc.requisitionNumber].currentStep} of ${releases[doc.requisitionNumber].steps.length}`
                      : 'Not required'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      {selected && selectedRelease && (
        <section aria-labelledby="pr-release" className="rounded-card border border-line bg-surface p-4 shadow-card">
          <h2 id="pr-release" className="text-sm font-semibold">Release</h2>
          {selectedRelease.status === 'NOT_REQUIRED' ? (
            <p className="mt-2 text-sm text-ink-soft">
              No release strategy claims requisition {selected.requisitionNumber}; it needs no release.
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
                    <input type="hidden" name="requisitionNumber" value={selected.requisitionNumber} />
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
                    <input type="hidden" name="requisitionNumber" value={selected.requisitionNumber} />
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

      <section aria-labelledby="pr-create" className="rounded-card border border-line bg-surface p-4 shadow-card">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <h2 id="pr-create" className="text-sm font-semibold">
            {selected ? `Requisition ${selected.requisitionNumber}` : 'New requisition'}
          </h2>
          <label className="block">
            <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-ink-faint">Document type</span>
            <select
              className="input w-56"
              value={documentType}
              disabled={!!selected}
              onChange={(event) => setDocumentType(event.target.value)}
            >
              <option value="STANDARD">Standard requisition</option>
            </select>
          </label>
        </div>

        <form action={formAction}>
          <input type="hidden" name="payload" value={payload()} />
          <input type="hidden" name="requisitionNumber" value={selected?.requisitionNumber ?? ''} />

          <div className="mt-3 overflow-x-auto">
            <table className="w-full min-w-[1100px] text-sm">
              <thead>
                <tr className="border-b border-line text-left">
                  <th className="px-2 py-2">Item</th>
                  {textFields.map((field) => (
                    <th key={field.key} className="px-2 py-2">{field.label}</th>
                  ))}
                  <th className="px-2 py-2">Plant</th>
                  <th className="px-2 py-2">Storage location</th>
                  <th className="px-2 py-2">Purchasing group</th>
                  {selected && <th className="px-2 py-2">Marked for deletion</th>}
                </tr>
              </thead>
              <tbody>
                {items.map((item, index) => (
                  <tr key={index} className="border-b border-line/60 align-top">
                    <td className="px-2 py-2 text-ink-faint">
                      {String(item.itemNumber ?? (index + 1) * 10).padStart(5, '0')}
                    </td>
                    {textFields.map((field) => (
                      <td key={field.key} className="px-1 py-1">
                        <input
                          className={`input ${field.width}`}
                          type={field.type ?? 'text'}
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
                        {choices.storageLocations
                          .filter((sl) => sl.plant === item.plant)
                          .map((sl) => (
                            <option key={sl.storageLocation} value={sl.storageLocation}>
                              {sl.storageLocation} · {sl.name}
                            </option>
                          ))}
                      </select>
                    </td>
                    <td className="px-1 py-1">
                      <select
                        className="input w-32"
                        value={item.purchasingGroup}
                        onChange={(event) => patch(index, { purchasingGroup: event.target.value })}
                      >
                        <option value="">—</option>
                        {choices.purchasingGroups.map((g) => (
                          <option key={g.purchasingGroup} value={g.purchasingGroup}>
                            {g.purchasingGroup} · {g.name}
                          </option>
                        ))}
                      </select>
                    </td>
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
                Item {String(item.itemNumber ?? (index + 1) * 10).padStart(5, '0')} · Account assignment
              </legend>
              <div className="flex flex-wrap items-center gap-4 text-sm">
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
                <div className="mt-3 space-y-2">
                  {item.assignments.map((row, rowIndex) => (
                    <div key={rowIndex} className="grid gap-3 sm:grid-cols-3">
                      <input
                        className="input w-full"
                        placeholder="Cost centre"
                        value={row.costCenter}
                        onChange={(event) => {
                          const rows = item.assignments.slice();
                          rows[rowIndex] = { ...rows[rowIndex], costCenter: event.target.value };
                          patch(index, { assignments: rows });
                        }}
                      />
                      <input
                        className="input w-full"
                        placeholder="G/L account"
                        value={row.glAccount}
                        onChange={(event) => {
                          const rows = item.assignments.slice();
                          rows[rowIndex] = { ...rows[rowIndex], glAccount: event.target.value };
                          patch(index, { assignments: rows });
                        }}
                      />
                      <input
                        className="input w-full"
                        placeholder="Distribution %"
                        value={row.percentage}
                        onChange={(event) => {
                          const rows = item.assignments.slice();
                          rows[rowIndex] = { ...rows[rowIndex], percentage: event.target.value };
                          patch(index, { assignments: rows });
                        }}
                      />
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
              {selected ? 'Save changes' : 'Save requisition'}
            </button>
          </div>
        </form>
      </section>
    </div>
  );
}
