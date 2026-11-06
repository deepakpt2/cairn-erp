'use client';

import { useActionState, useState } from 'react';

import type { OrderChoices, OrderDocument } from '@/modules/purchasing/orders';
import { ConstrainedField } from '@/ui/fields/ConstrainedField';
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
  batch: string;
  requisitionNumber: string;
  requisitionItem: string;
  quotationNumber: string;
  quotationItem: string;
  contractNumber: string;
  contractItem: string;
  assignment: 'STOCK' | 'COST_CENTER';
  markedForDeletion: boolean;
  /** Delivery control. A blank tolerance resolves from the masters when the order is saved. */
  overdeliveryTolerance: string;
  underdeliveryTolerance: string;
  unlimitedOverdelivery: boolean;
  deliveryCompleted: boolean;
  goodsReceiptIndicator: boolean;
  /** Invoice control. All three default to what the order has always done. */
  invoiceReceiptIndicator: boolean;
  grBasedInvoiceVerification: boolean;
  finalInvoiceIndicator: boolean;
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
  batch: '',
  requisitionNumber: '',
  requisitionItem: '',
  quotationNumber: '',
  quotationItem: '',
  contractNumber: '',
  contractItem: '',
  assignment: 'STOCK',
  markedForDeletion: false,
  overdeliveryTolerance: '',
  underdeliveryTolerance: '',
  unlimitedOverdelivery: false,
  deliveryCompleted: false,
  goodsReceiptIndicator: true,
  invoiceReceiptIndicator: true,
  grBasedInvoiceVerification: true,
  finalInvoiceIndicator: false,
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
    batch: item.batch ?? '',
    requisitionNumber: item.requisitionNumber ?? '',
    requisitionItem: item.requisitionItem ? String(item.requisitionItem) : '',
    quotationNumber: item.quotationNumber ?? '',
    quotationItem: item.quotationItem ? String(item.quotationItem) : '',
    contractNumber: item.contractNumber ?? '',
    contractItem: item.contractItem ? String(item.contractItem) : '',
    assignment: item.accountAssignmentCategory === 'COST_CENTER' ? 'COST_CENTER' : 'STOCK',
    markedForDeletion: item.markedForDeletion,
    overdeliveryTolerance: item.overdeliveryTolerance,
    underdeliveryTolerance: item.underdeliveryTolerance,
    unlimitedOverdelivery: item.unlimitedOverdelivery,
    deliveryCompleted: item.deliveryCompleted,
    goodsReceiptIndicator: item.goodsReceiptIndicator,
    invoiceReceiptIndicator: item.invoiceReceiptIndicator,
    grBasedInvoiceVerification: item.grBasedInvoiceVerification,
    finalInvoiceIndicator: item.finalInvoiceIndicator,
    scheduleLines: item.scheduleLines.map((s) => ({ deliveryDate: s.deliveryDate, quantity: s.quantity })),
    assignments: item.assignments.length > 0
      ? item.assignments.map((a) => ({
          glAccount: a.glAccount, costCenter: a.costCenter, percentage: a.distributionPercentage,
        }))
      : [{ glAccount: '', costCenter: '', percentage: '100' }],
  };
}

const INITIAL: OrderActionState = { ok: false };

/** ME21N carries delivery and invoicing terms on one header tab. */
const HEADER_TABS = [
  { key: 'ORG', label: 'Org. data' },
  { key: 'DELIVERY_INVOICE', label: 'Delivery / Invoice' },
] as const;

/** Item detail, as ME21N splits it: what the grid cannot carry without scrolling. */
const ITEM_TABS = [
  { key: 'SCHEDULE', label: 'Delivery schedule' },
  { key: 'DELIVERY', label: 'Delivery' },
  { key: 'INVOICE', label: 'Invoice' },
  { key: 'ACCOUNT', label: 'Account assignment' },
  { key: 'SOURCE', label: 'Source' },
] as const;

type HeaderTab = typeof HEADER_TABS[number]['key'];
type ItemTab = typeof ITEM_TABS[number]['key'];

export default function Orders({ choices, selected, canCreate, viewOnly = false, lockMessage = null, selectedRelease, canRelease, draft = null, callOff = null }: {
  choices: OrderChoices;
  selected: OrderDocument | null;
  canCreate: boolean;
  viewOnly?: boolean;
  lockMessage?: string | null;
  selectedRelease: DocumentReleaseState | null;
  canRelease: boolean;
  callOff?: { contractNumber: string; contractItem: string } | null;
  draft?: {
    supplierNumber: string;
    purchasingOrg: string;
    purchasingGroup: string;
    companyCode: string;
    currency: string;
    warning: string | null;
    items: Array<{
      materialNumber: string;
      shortText: string;
      quantity: number;
      unit: string;
      netPrice: number | null;
      priceUnit: number;
      plant: string;
      storageLocation: string;
      requisitionNumber: string;
      requisitionItem: number | null;
      quotationNumber: string;
      quotationItem: number | null;
      deliveryDate: string;
      accountAssignmentCategory?: 'COST_CENTER' | null;
      assignments?: Array<{ glAccount: string; costCenter: string; percentage: string }>;
    }>;
  } | null;
}) {
  const [state, formAction, pending] = useActionState(saveOrderAction, INITIAL);
  const [releaseState, releaseAction] = useActionState(releaseOrderAction, INITIAL);
  const [cancelState, cancelAction] = useActionState(cancelOrderReleaseAction, INITIAL);
  const releaseMessage = cancelState.message ? cancelState : releaseState;
  const [header, setHeader] = useState({
    documentType: selected?.documentType ?? 'STANDARD',
    supplierNumber: selected?.supplierNumber ?? draft?.supplierNumber ?? '',
    purchasingOrg: selected?.purchasingOrg ?? draft?.purchasingOrg ?? '',
    purchasingGroup: selected?.purchasingGroup ?? draft?.purchasingGroup ?? '',
    companyCode: selected?.companyCode ?? draft?.companyCode ?? '',
    currency: selected?.currency ?? draft?.currency ?? '',
    paymentTermsCode: selected?.paymentTermsCode ?? '',
    incotermsCode: selected?.incotermsCode ?? '',
    incotermsLocation: selected?.incotermsLocation ?? '',
  });
  const [headerTab, setHeaderTab] = useState<HeaderTab>('ORG');
  const [itemTab, setItemTab] = useState<ItemTab>('SCHEDULE');
  const [activeItem, setActiveItem] = useState(0);

  /** ME21N defaults the Delivery/Invoice fields from the vendor master. */
  function pickSupplier(supplierNumber: string) {
    const supplier = choices.suppliers.find((s) => s.partnerNumber === supplierNumber);
    setHeader({
      ...header,
      supplierNumber,
      paymentTermsCode: supplier?.paymentTermsCode ?? '',
      incotermsCode: supplier?.incotermsCode ?? '',
      incotermsLocation: supplier?.incotermsLocation ?? '',
    });
  }
  const [items, setItems] = useState<ItemRow[]>(
    selected
      ? selected.items.map(itemFromDocument)
      : draft && draft.items.length > 0
        ? draft.items.map((item) => ({
            ...EMPTY_ITEM,
            material: item.materialNumber,
            text: item.shortText,
            quantity: String(item.quantity),
            unit: item.unit,
            netPrice: item.netPrice == null ? '' : String(item.netPrice),
            priceUnit: String(item.priceUnit),
            plant: item.plant,
            storageLocation: item.storageLocation,
            requisitionNumber: item.requisitionNumber,
            requisitionItem: item.requisitionItem ? String(item.requisitionItem) : '',
            quotationNumber: item.quotationNumber,
            quotationItem: item.quotationItem ? String(item.quotationItem) : '',
            assignment: item.accountAssignmentCategory === 'COST_CENTER' ? 'COST_CENTER' : 'STOCK',
            assignments: item.assignments && item.assignments.length > 0
              ? item.assignments.map((row) => ({
                  glAccount: row.glAccount,
                  costCenter: row.costCenter,
                  percentage: row.percentage,
                }))
              : [{ glAccount: '', costCenter: '', percentage: '100' }],
            scheduleLines: [{ deliveryDate: item.deliveryDate, quantity: String(item.quantity) }],
          }))
        : [{ ...EMPTY_ITEM, contractNumber: callOff?.contractNumber ?? '', contractItem: callOff?.contractItem ?? '' }],
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
        netPrice: item.netPrice.trim() === '' ? undefined : Number(item.netPrice),
        priceUnit: Number(item.priceUnit || 1),
        taxCode: item.taxCode,
        plant: item.plant,
        storageLocation: item.storageLocation,
        batch: item.batch,
        accountAssignmentCategory: item.assignment === 'COST_CENTER' ? 'COST_CENTER' : null,
        markedForDeletion: item.markedForDeletion,
        overdeliveryTolerance: item.overdeliveryTolerance,
        underdeliveryTolerance: item.underdeliveryTolerance,
        unlimitedOverdelivery: item.unlimitedOverdelivery,
        deliveryCompleted: item.deliveryCompleted,
        goodsReceiptIndicator: item.goodsReceiptIndicator,
        invoiceReceiptIndicator: item.invoiceReceiptIndicator,
        grBasedInvoiceVerification: item.grBasedInvoiceVerification,
        finalInvoiceIndicator: item.finalInvoiceIndicator,
        requisitionNumber: item.requisitionNumber,
        requisitionItem: item.requisitionItem ? Number(item.requisitionItem) : undefined,
        quotationNumber: item.quotationNumber,
        quotationItem: item.quotationItem ? Number(item.quotationItem) : undefined,
        contractNumber: item.contractNumber,
        contractItem: item.contractItem ? Number(item.contractItem) : null,
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

  // The grid carries what a buyer judges at a glance; everything else stands on a tab.
  const itemFields: Array<{ key: 'material' | 'text' | 'quantity' | 'unit' | 'netPrice' | 'priceUnit'; label: string; width: string }> = [
    { key: 'material', label: 'Material', width: 'w-32' },
    { key: 'text', label: 'Short text', width: 'w-44' },
    { key: 'quantity', label: 'Order quantity', width: 'w-28' },
    { key: 'unit', label: 'Order unit', width: 'w-16' },
    { key: 'netPrice', label: 'Net price', width: 'w-28' },
    { key: 'priceUnit', label: 'Price unit', width: 'w-20' },
  ];
  const active = Math.min(activeItem, Math.max(0, items.length - 1));

  return (
    <div className="space-y-4">

      {selected && selectedRelease && (
        <section aria-labelledby="po-release" className="border border-line bg-surface p-4">
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

      <section aria-labelledby="po-create" className="border border-line bg-surface p-4">
        <h2 id="po-create" className="text-sm font-semibold">
          {selected ? `Purchase order ${selected.orderNumber}` : 'New purchase order'}
        </h2>
        {draft?.warning && (
          <p role="status" className="mt-2 text-sm text-amber-800">{draft.warning}</p>
        )}

        {lockMessage && (
          <p role="status" className="mt-2 border border-signal-warn/40 bg-amber-50 p-3 text-sm text-amber-800">{lockMessage}</p>
        )}
        <form action={formAction}>
          <input type="hidden" name="payload" value={payload()} />
          <input type="hidden" name="orderNumber" value={selected?.orderNumber ?? ''} />
          <fieldset disabled={viewOnly} className="min-w-0">

          <nav aria-label="Purchase order header" className="mt-3 flex flex-wrap gap-1 border-b border-line pb-2">
            {HEADER_TABS.map((tab) => (
              <button
                key={tab.key}
                type="button"
                onClick={() => setHeaderTab(tab.key)}
                className={`border px-3 py-2 text-sm ${tab.key === headerTab ? 'border-accent bg-accent-soft text-accent' : 'border-line bg-paper text-ink-soft'}`}
              >
                {tab.label}
              </button>
            ))}
          </nav>

          {headerTab === 'ORG' && (
          <div className="mt-3 grid gap-3 sm:grid-cols-3 lg:grid-cols-5">
            <label className="block">
              <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-ink-faint">Supplier</span>
              <ConstrainedField
                kind="supplier-purchasing"
                className="input min-w-0 flex-1"
                value={header.supplierNumber}
                context={{ purchasingOrg: header.purchasingOrg }}
                onChange={(supplierNumber) => pickSupplier(supplierNumber)}
              />
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
              <ConstrainedField
                kind="currency"
                value={header.currency}
                onChange={(currency) => setHeader({ ...header, currency })}
              />
            </label>
          </div>
          )}

          {headerTab === 'DELIVERY_INVOICE' && (
            <div className="mt-3 grid gap-3 sm:grid-cols-3">
              <label className="block">
                <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-ink-faint">Payment terms</span>
                <select
                  className="input w-full"
                  value={header.paymentTermsCode}
                  onChange={(event) => setHeader({ ...header, paymentTermsCode: event.target.value })}
                >
                  <option value="">— supplier default —</option>
                  {choices.paymentTerms.map((term) => (
                    <option key={term.code} value={term.code}>{term.code} · {term.description}</option>
                  ))}
                </select>
              </label>
              <label className="block">
                <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-ink-faint">Incoterms</span>
                <select
                  className="input w-full"
                  value={header.incotermsCode}
                  onChange={(event) => setHeader({ ...header, incotermsCode: event.target.value })}
                >
                  <option value="">— supplier default —</option>
                  {choices.incoterms.map((code) => (
                    <option key={code} value={code}>{code}</option>
                  ))}
                </select>
              </label>
              <label className="block">
                <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-ink-faint">Incoterms location</span>
                <input
                  className="input w-full"
                  maxLength={160}
                  value={header.incotermsLocation}
                  placeholder="Named place"
                  onChange={(event) => setHeader({ ...header, incotermsLocation: event.target.value })}
                />
              </label>
            </div>
          )}

          <div className="mt-3 overflow-x-auto">
            <table className="grid-table text-sm">
              <thead>
                <tr className="text-left">
                  <th>Item</th>
                  {itemFields.map((field) => (
                    <th key={field.key}>{field.label}</th>
                  ))}
                  <th>Net value</th>
                  {selected && <th>Marked for deletion</th>}
                </tr>
              </thead>
              <tbody>
                {items.map((item, index) => {
                  const value = Number(item.quantity) * Number(item.netPrice) / Math.max(1, Number(item.priceUnit) || 1);
                  return (
                    <tr
                      key={index}
                      onClick={() => setActiveItem(index)}
                      aria-selected={index === active}
                      className={`cursor-pointer align-top ${index === active ? 'bg-sunken' : ''}`}
                    >
                      <td className="text-ink-faint">{String(item.itemNumber ?? (index + 1) * 10).padStart(5, '0')}</td>
                      {itemFields.map((field) => (
                        <td key={field.key}>
                          {field.key === 'material' ? (
                            <ConstrainedField
                              kind="material-order"
                              className={`input ${field.width}`}
                              value={item.material}
                              context={{ plant: item.plant }}
                              onChange={(material) => patch(index, { material })}
                            />
                          ) : field.key === 'unit' ? (
                            <ConstrainedField
                              kind="unit"
                              uppercase
                              className={`input ${field.width}`}
                              value={item.unit}
                              onChange={(unit) => patch(index, { unit })}
                            />
                          ) : (
                            <input
                              className={`input ${field.width}`}
                              value={item[field.key]}
                              onChange={(event) => patch(index, { [field.key]: event.target.value })}
                            />
                          )}
                        </td>
                      ))}
                      <td className="num">{item.quantity && item.netPrice ? value.toFixed(2) : ''}</td>
                      {selected && (
                        <td>
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

          <nav aria-label="Purchase order item detail" className="mt-4 flex flex-wrap gap-1 border-b border-line pb-2">
            {ITEM_TABS.map((tab) => (
              <button
                key={tab.key}
                type="button"
                onClick={() => setItemTab(tab.key)}
                className={`border px-3 py-2 text-sm ${tab.key === itemTab ? 'border-accent bg-accent-soft text-accent' : 'border-line bg-paper text-ink-soft'}`}
              >
                {tab.label}
              </button>
            ))}
          </nav>

          {items[active] && (
            <section aria-label={`Item ${String(items[active].itemNumber ?? (active + 1) * 10).padStart(5, '0')} detail`} className="mt-2 border border-line p-3">
              <p className="mb-3 text-xs font-medium uppercase tracking-wide text-ink-faint">
                Item {String(items[active].itemNumber ?? (active + 1) * 10).padStart(5, '0')}
                {' · '}
                {ITEM_TABS.find((tab) => tab.key === itemTab)?.label}
              </p>

              {itemTab === 'SCHEDULE' && (() => {
                const item = items[active];
                const scheduled = item.scheduleLines.reduce((sum, line) => sum + (Number(line.quantity) || 0), 0);
                return (
                  <div className="space-y-2">
                    <table className="grid-table text-sm">
                      <thead>
                        <tr className="text-left">
                          <th>Delivery date</th>
                          <th>Scheduled quantity</th>
                          <th>Order quantity</th>
                          {item.scheduleLines.length > 1 && <th><span className="sr-only">Remove</span></th>}
                        </tr>
                      </thead>
                      <tbody>
                        {item.scheduleLines.map((line, lineIndex) => (
                          <tr key={lineIndex}>
                            <td>
                              <input
                                className="input w-44"
                                type="date"
                                value={line.deliveryDate}
                                onChange={(event) => {
                                  const lines = item.scheduleLines.slice();
                                  lines[lineIndex] = { ...lines[lineIndex], deliveryDate: event.target.value };
                                  patch(active, { scheduleLines: lines });
                                }}
                              />
                            </td>
                            <td>
                              <input
                                className="input w-32"
                                inputMode="decimal"
                                placeholder="Scheduled quantity"
                                value={line.quantity}
                                onChange={(event) => {
                                  const lines = item.scheduleLines.slice();
                                  lines[lineIndex] = { ...lines[lineIndex], quantity: event.target.value };
                                  patch(active, { scheduleLines: lines });
                                }}
                              />
                            </td>
                            <td className="num text-ink-soft">{item.quantity}</td>
                            {item.scheduleLines.length > 1 && (
                              <td>
                                <button
                                  type="button"
                                  className="btn btn-default min-h-11 sm:min-h-8"
                                  onClick={() => patch(active, {
                                    scheduleLines: item.scheduleLines.filter((_, i) => i !== lineIndex),
                                  })}
                                >
                                  Remove
                                </button>
                              </td>
                            )}
                          </tr>
                        ))}
                      </tbody>
                      <tfoot>
                        <tr>
                          <th>Scheduled</th>
                          <td className="num">{scheduled.toFixed(3)}</td>
                          <td className="num text-ink-soft">{item.quantity}</td>
                          {item.scheduleLines.length > 1 && <td />}
                        </tr>
                      </tfoot>
                    </table>
                    <button
                      type="button"
                      className="btn btn-default min-h-11 sm:min-h-8"
                      onClick={() => patch(active, {
                        scheduleLines: [...item.scheduleLines, { deliveryDate: '', quantity: '' }],
                      })}
                    >
                      Add schedule line
                    </button>
                  </div>
                );
              })()}

              {itemTab === 'DELIVERY' && (
                <div className="grid gap-3 sm:grid-cols-3">
                  <label className="block">
                    <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-ink-faint">Plant</span>
                    <select
                      className="input w-full"
                      value={items[active].plant}
                      onChange={(event) => patch(active, { plant: event.target.value, storageLocation: '' })}
                    >
                      <option value="">—</option>
                      {choices.plants.map((plant) => (
                        <option key={plant.plant} value={plant.plant}>{plant.plant} · {plant.name}</option>
                      ))}
                    </select>
                  </label>
                  <label className="block">
                    <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-ink-faint">Storage location</span>
                    <select
                      className="input w-full"
                      value={items[active].storageLocation}
                      onChange={(event) => patch(active, { storageLocation: event.target.value })}
                    >
                      <option value="">—</option>
                      {choices.storageLocations.filter((sl) => sl.plant === items[active].plant).map((sl) => (
                        <option key={sl.storageLocation} value={sl.storageLocation}>{sl.storageLocation} · {sl.name}</option>
                      ))}
                    </select>
                  </label>
                  <label className="block">
                    <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-ink-faint">Batch</span>
                    <input
                      className="input w-full"
                      maxLength={10}
                      value={items[active].batch}
                      placeholder="Batch"
                      onChange={(event) => patch(active, { batch: event.target.value })}
                    />
                  </label>
                  <label className="block">
                    <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-ink-faint">Overdelivery tolerance %</span>
                    <input
                      className="input w-full"
                      inputMode="decimal"
                      maxLength={6}
                      value={items[active].overdeliveryTolerance}
                      placeholder="From the material"
                      onChange={(event) => patch(active, { overdeliveryTolerance: event.target.value })}
                    />
                  </label>
                  <label className="block">
                    <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-ink-faint">Underdelivery tolerance %</span>
                    <input
                      className="input w-full"
                      inputMode="decimal"
                      maxLength={6}
                      value={items[active].underdeliveryTolerance}
                      placeholder="From the material"
                      onChange={(event) => patch(active, { underdeliveryTolerance: event.target.value })}
                    />
                  </label>
                  <div className="flex flex-wrap items-center gap-4 self-end pb-2 text-sm">
                    <label className="inline-flex items-center gap-2">
                      <input
                        type="checkbox"
                        checked={items[active].unlimitedOverdelivery}
                        onChange={(event) => patch(active, { unlimitedOverdelivery: event.target.checked })}
                      />
                      Unlimited overdelivery
                    </label>
                    <label className="inline-flex items-center gap-2">
                      <input
                        type="checkbox"
                        checked={items[active].deliveryCompleted}
                        onChange={(event) => patch(active, { deliveryCompleted: event.target.checked })}
                      />
                      Delivery completed
                    </label>
                    <label className="inline-flex items-center gap-2">
                      <input
                        type="checkbox"
                        checked={items[active].goodsReceiptIndicator}
                        disabled={!items[active].material}
                        onChange={(event) => patch(active, { goodsReceiptIndicator: event.target.checked })}
                      />
                      Goods receipt
                    </label>
                  </div>
                </div>
              )}

              {itemTab === 'INVOICE' && (
                <div className="grid gap-3 sm:grid-cols-2">
                  <label className="block">
                    <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-ink-faint">Tax code</span>
                    <ConstrainedField
                      kind="tax"
                      className="input w-full"
                      value={items[active].taxCode}
                      context={{ companyCode: header.companyCode }}
                      onChange={(taxCode) => patch(active, { taxCode })}
                    />
                  </label>
                  <div className="space-y-2 self-end pb-1 text-sm">
                    <label className="flex items-start gap-2">
                      <input
                        type="checkbox"
                        className="mt-0.5"
                        checked={items[active].grBasedInvoiceVerification}
                        disabled={!items[active].goodsReceiptIndicator}
                        onChange={(event) => patch(active, { grBasedInvoiceVerification: event.target.checked })}
                      />
                      <span>
                        GR-based invoice verification
                        <span className="block text-xs text-ink-soft">
                          {items[active].goodsReceiptIndicator
                            ? 'On, the invoice is checked against what arrived. Off, the item can be invoiced before the goods arrive.'
                            : 'Nothing to check against: the item receives no goods, so it is invoiced against the quantity ordered.'}
                        </span>
                      </span>
                    </label>
                    <label className="flex items-start gap-2">
                      <input
                        type="checkbox"
                        className="mt-0.5"
                        checked={items[active].invoiceReceiptIndicator}
                        onChange={(event) => patch(active, { invoiceReceiptIndicator: event.target.checked })}
                      />
                      <span>
                        Invoice receipt
                        <span className="block text-xs text-ink-soft">Off, no invoice is posted against the item at all.</span>
                      </span>
                    </label>
                    <label className="flex items-start gap-2">
                      <input
                        type="checkbox"
                        className="mt-0.5"
                        checked={items[active].finalInvoiceIndicator}
                        onChange={(event) => patch(active, { finalInvoiceIndicator: event.target.checked })}
                      />
                      <span>
                        Final invoice
                        <span className="block text-xs text-ink-soft">No further invoices are expected. Set by a buyer; never set by a posting.</span>
                      </span>
                    </label>
                  </div>
                </div>
              )}

              {itemTab === 'ACCOUNT' && (
                <div className="space-y-3">
                  <div className="flex flex-wrap items-center gap-4 text-sm">
                    <label className="inline-flex items-center gap-2">
                      <input type="radio" name="assignment" checked={items[active].assignment === 'STOCK'}
                        onChange={() => patch(active, { assignment: 'STOCK' })} />
                      Stock (no account assignment)
                    </label>
                    <label className="inline-flex items-center gap-2">
                      <input type="radio" name="assignment" checked={items[active].assignment === 'COST_CENTER'}
                        onChange={() => patch(active, { assignment: 'COST_CENTER' })} />
                      Cost centre
                    </label>
                  </div>
                  {items[active].assignment === 'COST_CENTER' && (
                    <div className="space-y-2">
                      <table className="grid-table text-sm">
                        <thead>
                          <tr className="text-left">
                            <th>G/L account</th>
                            <th>Cost centre</th>
                            <th>Distribution %</th>
                            {items[active].assignments.length > 1 && <th><span className="sr-only">Remove</span></th>}
                          </tr>
                        </thead>
                        <tbody>
                          {items[active].assignments.map((row, rowIndex) => (
                            <tr key={rowIndex}>
                              <td>
                                <input className="input w-40" placeholder="G/L account" value={row.glAccount}
                                  onChange={(event) => {
                                    const rows = items[active].assignments.slice();
                                    rows[rowIndex] = { ...rows[rowIndex], glAccount: event.target.value };
                                    patch(active, { assignments: rows });
                                  }} />
                              </td>
                              <td>
                                <input className="input w-40" placeholder="Cost centre" value={row.costCenter}
                                  onChange={(event) => {
                                    const rows = items[active].assignments.slice();
                                    rows[rowIndex] = { ...rows[rowIndex], costCenter: event.target.value };
                                    patch(active, { assignments: rows });
                                  }} />
                              </td>
                              <td>
                                <input className="input w-28" inputMode="decimal" placeholder="Distribution %" value={row.percentage}
                                  onChange={(event) => {
                                    const rows = items[active].assignments.slice();
                                    rows[rowIndex] = { ...rows[rowIndex], percentage: event.target.value };
                                    patch(active, { assignments: rows });
                                  }} />
                              </td>
                              {items[active].assignments.length > 1 && (
                                <td>
                                  <button
                                    type="button"
                                    className="btn btn-default min-h-11 sm:min-h-8"
                                    onClick={() => patch(active, {
                                      assignments: items[active].assignments.filter((_, i) => i !== rowIndex),
                                    })}
                                  >
                                    Remove
                                  </button>
                                </td>
                              )}
                            </tr>
                          ))}
                        </tbody>
                      </table>
                      <button
                        type="button"
                        className="btn btn-default min-h-11 sm:min-h-8"
                        onClick={() => patch(active, {
                          assignments: [...items[active].assignments, { glAccount: '', costCenter: '', percentage: '0' }],
                        })}
                      >
                        Add assignment row
                      </button>
                    </div>
                  )}
                </div>
              )}

              {itemTab === 'SOURCE' && (
                <div className="grid gap-3 sm:grid-cols-3">
                  <label className="block">
                    <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-ink-faint">Requisition</span>
                    <input className="input w-full" value={items[active].requisitionNumber} placeholder="Requisition"
                      onChange={(event) => patch(active, { requisitionNumber: event.target.value })} />
                  </label>
                  <label className="block">
                    <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-ink-faint">Req. item</span>
                    <input className="input w-full" value={items[active].requisitionItem} placeholder="Item"
                      onChange={(event) => patch(active, { requisitionItem: event.target.value })} />
                  </label>
                  <label className="block">
                    <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-ink-faint">Quotation</span>
                    <input className="input w-full" value={items[active].quotationNumber} placeholder="Quotation"
                      onChange={(event) => patch(active, { quotationNumber: event.target.value })} />
                  </label>
                  <label className="block">
                    <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-ink-faint">Quot. item</span>
                    <input className="input w-full" value={items[active].quotationItem} placeholder="Item"
                      onChange={(event) => patch(active, { quotationItem: event.target.value })} />
                  </label>
                  <label className="block">
                    <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-ink-faint">Contract</span>
                    <input className="input w-full" value={items[active].contractNumber} placeholder="Contract"
                      onChange={(event) => patch(active, { contractNumber: event.target.value })} />
                  </label>
                  <label className="block">
                    <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-ink-faint">Contract item</span>
                    <input className="input w-full" value={items[active].contractItem} placeholder="Item"
                      onChange={(event) => patch(active, { contractItem: event.target.value })} />
                  </label>
                </div>
              )}
            </section>
          )}

          {state.message && (
            <p role="status" className={`mt-3 text-sm ${state.ok ? 'text-ink' : 'text-red-700'}`}>
              {state.message}
              {state.remedy ? ` ${state.remedy}` : ''}
              {state.ok && state.orderNumber ? (
                <>
                  {' '}
                  <a className="underline" href={`/purchasing/orders?order=${encodeURIComponent(state.orderNumber)}`}>
                    Open purchase order {state.orderNumber}
                  </a>
                </>
              ) : null}
            </p>
          )}
          {state.warnings?.map((warning) => (
            <p key={warning} role="status" className="mt-1 text-sm text-amber-700">{warning}</p>
          ))}

          <div className="mt-4 flex justify-end">
            <button type="submit" className="btn btn-primary min-h-11 sm:min-h-8" disabled={!canCreate || pending || viewOnly}>
              {selected ? 'Save changes' : 'Save purchase order'}
            </button>
          </div>
          </fieldset>
        </form>
      </section>
    </div>
  );
}
