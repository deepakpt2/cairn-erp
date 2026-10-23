'use client';

import { useActionState, useState } from 'react';
import Link from 'next/link';

import type { SchedulingAgreementDocument, SchedulingAgreementListRow } from '@/modules/purchasing/scheduling-agreement';
import type { DocumentReleaseState } from '@/modules/purchasing/release';
import {
  cancelSchedulingAgreementReleaseAction,
  releaseSchedulingAgreementAction,
  saveSchedulingAgreementAction,
  type SchedulingAgreementActionState,
} from './actions';

interface Choices {
  types: Array<{ documentType: string; description: string }>;
  suppliers: Array<{ partnerNumber: string; name: string }>;
  organizations: Array<{ purchasingOrg: string; name: string }>;
  groups: Array<{ purchasingGroup: string; name: string }>;
  companies: Array<{ companyCode: string; name: string }>;
  plants: Array<{ plant: string; name: string }>;
}

interface ItemRow {
  itemNumber?: number;
  material: string;
  text: string;
  targetQuantity: string;
  unit: string;
  netPrice: string;
  priceUnit: string;
  plant: string;
  markedForDeletion: boolean;
}

const EMPTY: ItemRow = {
  material: '',
  text: '',
  targetQuantity: '',
  unit: '',
  netPrice: '',
  priceUnit: '1',
  plant: '',
  markedForDeletion: false,
};

const INITIAL: SchedulingAgreementActionState = { ok: false };

export default function Agreements({
  documents,
  choices,
  selected,
  canCreate,
  canRelease,
  selectedRelease,
  viewOnly,
  lockMessage,
}: {
  documents: SchedulingAgreementListRow[];
  choices: Choices;
  selected: SchedulingAgreementDocument | null;
  canCreate: boolean;
  canRelease: boolean;
  selectedRelease: DocumentReleaseState | null;
  viewOnly: boolean;
  lockMessage: string | null;
}) {
  const [state, action, pending] = useActionState(saveSchedulingAgreementAction, INITIAL);
  const [releaseState, releaseAction, releasePending] = useActionState(releaseSchedulingAgreementAction, INITIAL);
  const [cancelState, cancelAction] = useActionState(cancelSchedulingAgreementReleaseAction, INITIAL);
  const [header, setHeader] = useState({
    documentType: selected?.documentType ?? choices.types[0]?.documentType ?? '',
    supplierNumber: selected?.supplierNumber ?? '',
    purchasingOrg: selected?.purchasingOrg ?? '',
    purchasingGroup: selected?.purchasingGroup ?? '',
    companyCode: selected?.companyCode ?? '',
    currency: selected?.currency ?? '',
    validityStart: selected?.validityStart ?? '',
    validityEnd: selected?.validityEnd ?? '',
  });
  const [items, setItems] = useState<ItemRow[]>(
    selected
      ? selected.items.map((item) => ({
          itemNumber: item.itemNumber,
          material: item.materialNumber ?? '',
          text: item.shortText,
          targetQuantity: item.targetQuantity,
          unit: item.unit,
          netPrice: item.netPrice,
          priceUnit: item.priceUnit,
          plant: item.plant ?? '',
          markedForDeletion: item.markedForDeletion,
        }))
      : [{ ...EMPTY }],
  );
  const message = state.message ? state : releaseState.message ? releaseState : cancelState;

  function payload(): string {
    return JSON.stringify({
      ...header,
      agreementNumber: selected?.agreementNumber,
      items: items.map((item) => ({
        itemNumber: item.itemNumber,
        materialNumber: item.material,
        shortText: item.text,
        targetQuantity: Number(item.targetQuantity),
        unit: item.unit,
        netPrice: item.netPrice.trim() === '' ? null : Number(item.netPrice),
        priceUnit: Number(item.priceUnit || 1),
        plant: item.plant,
        markedForDeletion: item.markedForDeletion,
      })),
    });
  }

  return (
    <div className="space-y-6">
      {message.message && (
        <p className={message.ok ? 'text-sm text-ink' : 'text-sm text-red-700'} role="status">
          {message.message} {message.remedy ?? ''}
        </p>
      )}
      {state.warnings && state.warnings.length > 0 && (
        <ul className="text-sm text-ink-soft">
          {state.warnings.map((warning) => <li key={warning}>{warning}</li>)}
        </ul>
      )}
      {lockMessage && <p className="text-sm text-ink-soft">{lockMessage}</p>}

      <section className="overflow-x-auto">
        <h2 className="mb-2 text-sm font-semibold">Scheduling agreements · ME3L</h2>
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b text-left">
              <th className="px-2 py-2">Agreement</th>
              <th className="px-2 py-2">Type</th>
              <th className="px-2 py-2">Supplier</th>
              <th className="px-2 py-2">Validity</th>
              <th className="px-2 py-2">Target qty</th>
              <th className="px-2 py-2">Scheduled qty</th>
              <th className="px-2 py-2">Release</th>
            </tr>
          </thead>
          <tbody>
            {documents.map((row) => (
              <tr key={row.agreementNumber} className="border-b">
                <td className="px-2 py-2">
                  <Link className="underline" href={`/purchasing/scheduling-agreements?agreement=${encodeURIComponent(row.agreementNumber)}`}>{row.agreementNumber}</Link>
                </td>
                <td className="px-2 py-2">{row.documentType}</td>
                <td className="px-2 py-2">{row.supplierNumber}</td>
                <td className="px-2 py-2">{row.validityStart} – {row.validityEnd}</td>
                <td className="px-2 py-2">{row.targetQuantity}</td>
                <td className="px-2 py-2">{row.scheduledQuantity}</td>
                <td className="px-2 py-2">{row.releaseStatus}</td>
              </tr>
            ))}
            {documents.length === 0 && (
              <tr><td className="px-2 py-3 text-ink-soft" colSpan={7}>No scheduling agreements stand.</td></tr>
            )}
          </tbody>
        </table>
      </section>

      {selected && (
        <section className="space-y-2 text-sm">
          <h2 className="font-semibold">{selected.agreementNumber}</h2>
          <p>
            <Link className="underline" href={`/purchasing/scheduling-agreement-display?agreement=${encodeURIComponent(selected.agreementNumber)}`}>ME33L display</Link>
            {' '}reads this agreement and does not save it.
            {' '}
            <Link className="underline" href={`/purchasing/delivery-schedule?agreement=${encodeURIComponent(selected.agreementNumber)}`}>ME38 delivery schedule</Link>
            {' '}maintains schedule lines. It is not this screen.
          </p>
          <p>
            Target and scheduled quantity are separate. A scheduled quantity is a delivery schedule line. It is not a goods receipt. This screen does not create a schedule line.
          </p>
          <table className="w-full">
            <thead>
              <tr className="border-b text-left">
                <th className="px-2 py-2">Item</th>
                <th className="px-2 py-2">Text</th>
                <th className="px-2 py-2">Target</th>
                <th className="px-2 py-2">Scheduled</th>
                <th className="px-2 py-2">Remaining</th>
                <th className="px-2 py-2">Price</th>
              </tr>
            </thead>
            <tbody>
              {selected.items.map((item) => (
                <tr key={item.itemNumber} className="border-b">
                  <td className="px-2 py-2">{item.itemNumber}</td>
                  <td className="px-2 py-2">{item.shortText}</td>
                  <td className="px-2 py-2">{item.targetQuantity} {item.unit}</td>
                  <td className="px-2 py-2">{item.scheduledQuantity}</td>
                  <td className="px-2 py-2">{item.remainingQuantity}</td>
                  <td className="px-2 py-2">{item.netPrice}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {selected.scheduleLines.length === 0 && <p className="text-ink-soft">No delivery schedule line stands. ME38 is not this screen.</p>}
          {canRelease && selectedRelease?.status === 'PENDING' && (
            <form action={releaseAction} className="flex flex-wrap items-end gap-2">
              <input type="hidden" name="agreementNumber" value={selected.agreementNumber} />
              <label className="text-sm">
                Release code
                <select name="releaseCode" className="input ml-2 w-32">
                  {selectedRelease.steps.map((code) => <option key={code} value={code}>{code}</option>)}
                </select>
              </label>
              <button className="btn btn-default min-h-11 sm:min-h-8" disabled={releasePending}>Release step {selectedRelease.currentStep + 1} · ME35L</button>
            </form>
          )}
          {canRelease && selected.releaseStatus === 'RELEASED' && (
            <form action={cancelAction}>
              <input type="hidden" name="agreementNumber" value={selected.agreementNumber} />
              <button className="btn btn-default min-h-11 sm:min-h-8">Cancel release</button>
            </form>
          )}
        </section>
      )}

      {canCreate && !viewOnly && (
        <form action={action} className="space-y-3">
          <h2 className="text-sm font-semibold">{selected ? 'ME32L change' : 'ME31L create'}</h2>
          <input type="hidden" name="payload" value={payload()} />
          <div className="grid gap-3 sm:grid-cols-3">
            <label className="text-sm">Document type
              <select className="input mt-1 w-full" value={header.documentType} onChange={(event) => setHeader({ ...header, documentType: event.target.value })}>
                {choices.types.map((type) => (
                  <option key={type.documentType} value={type.documentType}>{type.documentType} · {type.description}</option>
                ))}
              </select>
            </label>
            <label className="text-sm">Supplier
              <select className="input mt-1 w-full" value={header.supplierNumber} onChange={(event) => setHeader({ ...header, supplierNumber: event.target.value })}>
                <option value="">—</option>
                {choices.suppliers.map((row) => <option key={row.partnerNumber} value={row.partnerNumber}>{row.partnerNumber} · {row.name}</option>)}
              </select>
            </label>
            <label className="text-sm">Purchasing organization
              <select className="input mt-1 w-full" value={header.purchasingOrg} onChange={(event) => setHeader({ ...header, purchasingOrg: event.target.value })}>
                <option value="">—</option>
                {choices.organizations.map((row) => <option key={row.purchasingOrg} value={row.purchasingOrg}>{row.purchasingOrg}</option>)}
              </select>
            </label>
            <label className="text-sm">Purchasing group
              <select className="input mt-1 w-full" value={header.purchasingGroup} onChange={(event) => setHeader({ ...header, purchasingGroup: event.target.value })}>
                <option value="">—</option>
                {choices.groups.map((row) => <option key={row.purchasingGroup} value={row.purchasingGroup}>{row.purchasingGroup}</option>)}
              </select>
            </label>
            <label className="text-sm">Company code
              <select className="input mt-1 w-full" value={header.companyCode} onChange={(event) => setHeader({ ...header, companyCode: event.target.value })}>
                <option value="">—</option>
                {choices.companies.map((row) => <option key={row.companyCode} value={row.companyCode}>{row.companyCode}</option>)}
              </select>
            </label>
            <label className="text-sm">Currency
              <input className="input mt-1 w-full" value={header.currency} onChange={(event) => setHeader({ ...header, currency: event.target.value })} placeholder="From supplier if blank" />
            </label>
            <label className="text-sm">Valid from
              <input className="input mt-1 w-full" type="date" value={header.validityStart} onChange={(event) => setHeader({ ...header, validityStart: event.target.value })} />
            </label>
            <label className="text-sm">Valid to
              <input className="input mt-1 w-full" type="date" value={header.validityEnd} onChange={(event) => setHeader({ ...header, validityEnd: event.target.value })} />
            </label>
          </div>
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b text-left">
                <th className="px-2 py-2">Material</th>
                <th className="px-2 py-2">Text</th>
                <th className="px-2 py-2">Target qty</th>
                <th className="px-2 py-2">Unit</th>
                <th className="px-2 py-2">Net price</th>
                <th className="px-2 py-2">Plant</th>
              </tr>
            </thead>
            <tbody>
              {items.map((item, index) => (
                <tr key={item.itemNumber ?? `new-${index}`}>
                  <td className="px-1 py-1"><input aria-label="Material" className="input w-28" value={item.material} onChange={(event) => setItems(items.map((row, i) => i === index ? { ...row, material: event.target.value } : row))} /></td>
                  <td className="px-1 py-1"><input aria-label="Text" className="input w-40" value={item.text} onChange={(event) => setItems(items.map((row, i) => i === index ? { ...row, text: event.target.value } : row))} /></td>
                  <td className="px-1 py-1"><input aria-label="Target quantity" className="input w-24" value={item.targetQuantity} onChange={(event) => setItems(items.map((row, i) => i === index ? { ...row, targetQuantity: event.target.value } : row))} /></td>
                  <td className="px-1 py-1"><input aria-label="Unit" className="input w-16" value={item.unit} onChange={(event) => setItems(items.map((row, i) => i === index ? { ...row, unit: event.target.value } : row))} /></td>
                  <td className="px-1 py-1"><input aria-label="Net price" className="input w-24" value={item.netPrice} onChange={(event) => setItems(items.map((row, i) => i === index ? { ...row, netPrice: event.target.value } : row))} /></td>
                  <td className="px-1 py-1">
                    <select aria-label="Plant" className="input w-28" value={item.plant} onChange={(event) => setItems(items.map((row, i) => i === index ? { ...row, plant: event.target.value } : row))}>
                      <option value="">None</option>
                      {choices.plants.map((site) => <option key={site.plant} value={site.plant}>{site.plant}</option>)}
                    </select>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="flex gap-2">
            <button type="button" className="btn btn-default min-h-11 sm:min-h-8" onClick={() => setItems([...items, { ...EMPTY }])}>Add item</button>
            <button className="btn btn-primary min-h-11 sm:min-h-8" disabled={pending}>{pending ? 'Saving' : 'Save'}</button>
          </div>
          <p className="text-sm text-ink-soft">Plant is not required. A delivery schedule line is not created by this save. Service, limit, and stock-transport agreements are not offered.</p>
        </form>
      )}
    </div>
  );
}
