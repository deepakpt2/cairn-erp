'use client';

import { useActionState, useState } from 'react';
import Link from 'next/link';

import type { ContractDocument, ContractListRow } from '@/modules/purchasing/contract';
import type { DocumentReleaseState } from '@/modules/purchasing/release';
import {
  cancelContractReleaseAction,
  releaseContractAction,
  saveContractAction,
  type ContractActionState,
} from './actions';

interface Choices {
  types: Array<{ documentType: string; description: string; category: string }>;
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
  storageLocation: string;
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
  storageLocation: '',
  markedForDeletion: false,
};

const INITIAL: ContractActionState = { ok: false };

export default function Contracts({
  documents,
  choices,
  selected,
  canCreate,
  canRelease,
  selectedRelease,
  viewOnly,
  lockMessage,
}: {
  documents: ContractListRow[];
  choices: Choices;
  selected: ContractDocument | null;
  canCreate: boolean;
  canRelease: boolean;
  selectedRelease: DocumentReleaseState | null;
  viewOnly: boolean;
  lockMessage: string | null;
}) {
  const [state, action, pending] = useActionState(saveContractAction, INITIAL);
  const [releaseState, releaseAction, releasePending] = useActionState(releaseContractAction, INITIAL);
  const [cancelState, cancelAction] = useActionState(cancelContractReleaseAction, INITIAL);
  const [header, setHeader] = useState({
    documentType: selected?.documentType ?? choices.types[0]?.documentType ?? '',
    supplierNumber: selected?.supplierNumber ?? '',
    purchasingOrg: selected?.purchasingOrg ?? '',
    purchasingGroup: selected?.purchasingGroup ?? '',
    companyCode: selected?.companyCode ?? '',
    currency: selected?.currency ?? '',
    validityStart: selected?.validityStart ?? '',
    validityEnd: selected?.validityEnd ?? '',
    targetValue: selected?.targetValue ?? '',
    sourceContractNumber: '',
    requestKey: '',
  });
  const [items, setItems] = useState<ItemRow[]>(
    selected
      ? selected.items.map((item) => ({
          itemNumber: item.itemNumber,
          material: item.materialNumber ?? '',
          text: item.shortText,
          targetQuantity: item.targetQuantity ?? '',
          unit: item.unit ?? '',
          netPrice: item.netPrice,
          priceUnit: item.priceUnit,
          plant: item.plant ?? '',
          storageLocation: item.storageLocation ?? '',
          markedForDeletion: item.markedForDeletion,
        }))
      : [{ ...EMPTY }],
  );
  const selectedType = choices.types.find((type) => type.documentType === header.documentType);
  const message = state.message ? state : releaseState.message ? releaseState : cancelState;

  function payload(): string {
    return JSON.stringify({
      ...header,
      contractNumber: selected?.contractNumber,
      targetValue: header.targetValue.trim() === '' ? null : Number(header.targetValue),
      items: items.map((item) => ({
        itemNumber: item.itemNumber,
        materialNumber: item.material,
        shortText: item.text,
        targetQuantity: item.targetQuantity.trim() === '' ? null : Number(item.targetQuantity),
        unit: item.unit,
        netPrice: item.netPrice.trim() === '' ? null : Number(item.netPrice),
        priceUnit: Number(item.priceUnit || 1),
        plant: item.plant,
        storageLocation: item.storageLocation,
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
        <h2 className="mb-2 text-sm font-semibold">Outline agreements · ME3N</h2>
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b text-left">
              <th className="px-2 py-2">Contract</th>
              <th className="px-2 py-2">Type</th>
              <th className="px-2 py-2">Category</th>
              <th className="px-2 py-2">Supplier</th>
              <th className="px-2 py-2">Validity</th>
              <th className="px-2 py-2">Target value</th>
              <th className="px-2 py-2">Called-off value</th>
              <th className="px-2 py-2">Remaining value</th>
              <th className="px-2 py-2">Release</th>
            </tr>
          </thead>
          <tbody>
            {documents.map((row) => (
              <tr key={row.contractNumber} className="border-b">
                <td className="px-2 py-2">
                  <Link className="underline" href={`/purchasing/contracts?contract=${encodeURIComponent(row.contractNumber)}`}>{row.contractNumber}</Link>
                </td>
                <td className="px-2 py-2">{row.documentType}</td>
                <td className="px-2 py-2">{row.category}</td>
                <td className="px-2 py-2">{row.supplierNumber}</td>
                <td className="px-2 py-2">{row.validityStart} – {row.validityEnd}</td>
                <td className="px-2 py-2">{row.targetValue ?? '—'}</td>
                <td className="px-2 py-2">{row.calledOffValue}</td>
                <td className="px-2 py-2">{row.remainingValue ?? '—'}</td>
                <td className="px-2 py-2">{row.releaseStatus}</td>
              </tr>
            ))}
            {documents.length === 0 && (
              <tr><td className="px-2 py-3 text-ink-soft" colSpan={9}>No contracts stand.</td></tr>
            )}
          </tbody>
        </table>
      </section>

      {selected && (
        <section className="space-y-2 text-sm">
          <h2 className="font-semibold">{selected.contractNumber}</h2>
          <p>
            <Link className="underline" href={`/purchasing/contract-display?contract=${encodeURIComponent(selected.contractNumber)}`}>ME33K display</Link>
            {' '}reads this contract and does not save it.
          </p>
          <p>
            {selected.category} contract. Called-off value {selected.calledOffValue} {selected.currency}. Remaining value {selected.remainingValue ?? 'not a value commitment'}. Release {selected.releaseStatus}.
            Goods receipt and invoice figures below are display only. They are not the remaining commitment, and this screen does not post them.
          </p>
          <table className="w-full">
            <thead>
              <tr className="border-b text-left">
                <th className="px-2 py-2">Item</th>
                <th className="px-2 py-2">Text</th>
                <th className="px-2 py-2">Target qty</th>
                <th className="px-2 py-2">Called-off qty</th>
                <th className="px-2 py-2">Remaining qty</th>
                <th className="px-2 py-2">Goods receipt</th>
                <th className="px-2 py-2">Invoice value</th>
              </tr>
            </thead>
            <tbody>
              {selected.items.map((item) => (
                <tr key={item.itemNumber} className="border-b">
                  <td className="px-2 py-2">{item.itemNumber}</td>
                  <td className="px-2 py-2">{item.shortText}</td>
                  <td className="px-2 py-2">{item.targetQuantity ?? '—'} {item.unit ?? ''}</td>
                  <td className="px-2 py-2">{item.calledOffQuantity}</td>
                  <td className="px-2 py-2">{item.remainingQuantity ?? '—'}</td>
                  <td className="px-2 py-2">{item.goodsReceiptQuantity}</td>
                  <td className="px-2 py-2">{item.invoiceValue}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p>
            <Link className="underline" href={`/purchasing/orders?contract=${encodeURIComponent(selected.contractNumber)}&contractItem=${selected.items[0]?.itemNumber ?? ''}`}>
              Create a call-off purchase order
            </Link>
          </p>
          {canRelease && selectedRelease?.status === 'PENDING' && (
            <form action={releaseAction} className="flex flex-wrap items-end gap-2">
              <input type="hidden" name="contractNumber" value={selected.contractNumber} />
              <label className="text-sm">
                Release code
                <select name="releaseCode" className="input ml-2 w-32">
                  {selectedRelease.steps.map((code) => <option key={code} value={code}>{code}</option>)}
                </select>
              </label>
              <button className="btn btn-default min-h-11 sm:min-h-8" disabled={releasePending}>Release step {selectedRelease.currentStep + 1} · ME35K</button>
            </form>
          )}
          {canRelease && selected.releaseStatus === 'RELEASED' && (
            <form action={cancelAction}>
              <input type="hidden" name="contractNumber" value={selected.contractNumber} />
              <button className="btn btn-default min-h-11 sm:min-h-8">Cancel release</button>
            </form>
          )}
        </section>
      )}

      {canCreate && !viewOnly && (
        <form action={action} className="space-y-3">
          <h2 className="text-sm font-semibold">{selected ? 'ME32K change' : 'ME31K create'}</h2>
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
            <label className="text-sm">Target value {selectedType?.category === 'VALUE' ? '(required)' : '(optional)'}
              <input className="input mt-1 w-full" value={header.targetValue} onChange={(event) => setHeader({ ...header, targetValue: event.target.value })} />
            </label>
            {!selected && (
              <label className="text-sm">Copy from contract
                <input className="input mt-1 w-full" value={header.sourceContractNumber} onChange={(event) => setHeader({ ...header, sourceContractNumber: event.target.value })} />
              </label>
            )}
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
                  <td className="px-1 py-1"><input className="input w-28" value={item.material} onChange={(event) => setItems(items.map((row, i) => i === index ? { ...row, material: event.target.value } : row))} /></td>
                  <td className="px-1 py-1"><input className="input w-40" value={item.text} onChange={(event) => setItems(items.map((row, i) => i === index ? { ...row, text: event.target.value } : row))} /></td>
                  <td className="px-1 py-1"><input className="input w-24" value={item.targetQuantity} onChange={(event) => setItems(items.map((row, i) => i === index ? { ...row, targetQuantity: event.target.value } : row))} /></td>
                  <td className="px-1 py-1"><input className="input w-16" value={item.unit} onChange={(event) => setItems(items.map((row, i) => i === index ? { ...row, unit: event.target.value } : row))} /></td>
                  <td className="px-1 py-1"><input className="input w-24" value={item.netPrice} onChange={(event) => setItems(items.map((row, i) => i === index ? { ...row, netPrice: event.target.value } : row))} /></td>
                  <td className="px-1 py-1">
                    <select className="input w-28" value={item.plant} onChange={(event) => setItems(items.map((row, i) => i === index ? { ...row, plant: event.target.value } : row))}>
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
          <p className="text-sm text-ink-soft">Plant and storage location are not required. Service, limit, asset, WBS, and internal-order items are not offered. A call-off is a saved purchase order, not a draft.</p>
        </form>
      )}
    </div>
  );
}
