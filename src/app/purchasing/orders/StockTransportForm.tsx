'use client';

import { useState } from 'react';

import type { OrderChoices, OrderDocument } from '@/modules/purchasing/orders';
import { Button } from '@/ui/kit';
import { ConstrainedField } from '@/ui/fields/ConstrainedField';

/**
 * The stock transport order body of the purchase order screen (ITEM-22, ME21N/ME22N, type UB).
 *
 * An STO has no supplier, price, tax or invoice, so the supplier and pricing fields are not offered at all:
 * it names the SUPPLYING plant, the receiving company (the header company), and items with a material, a
 * quantity, the RECEIVING plant and a schedule. Plant and material fields use the existing constrained fields
 * (a typed value is still submitted when the list does not load). The screen says, from the plant master,
 * whether the move stays inside one company or crosses companies; the service judges it again on save.
 */

interface ScheduleRow { deliveryDate: string; quantity: string }
interface ItemRow {
  itemNumber?: number;
  material: string;
  quantity: string;
  unit: string;
  plant: string;
  storageLocation: string;
  batch: string;
  markedForDeletion: boolean;
  scheduleLines: ScheduleRow[];
}

const EMPTY: ItemRow = {
  material: '', quantity: '', unit: '', plant: '', storageLocation: '', batch: '', markedForDeletion: false,
  scheduleLines: [{ deliveryDate: '', quantity: '' }],
};

function fromDocument(item: OrderDocument['items'][number]): ItemRow {
  return {
    itemNumber: item.itemNumber,
    material: item.materialNumber ?? '',
    quantity: item.quantity,
    unit: item.unit,
    plant: item.plant,
    storageLocation: item.storageLocation ?? '',
    batch: item.batch ?? '',
    markedForDeletion: item.markedForDeletion,
    scheduleLines: item.scheduleLines.map((l) => ({ deliveryDate: l.deliveryDate, quantity: l.quantity })),
  };
}

export default function StockTransportForm({
  choices, selected, viewOnly, formAction, pending,
}: {
  choices: OrderChoices;
  selected: OrderDocument | null;
  viewOnly: boolean;
  formAction: (form: FormData) => void;
  pending: boolean;
}) {
  const [header, setHeader] = useState({
    supplyingPlant: selected?.supplyingPlant ?? '',
    purchasingOrg: selected?.purchasingOrg ?? '',
    purchasingGroup: selected?.purchasingGroup ?? '',
    companyCode: selected?.companyCode ?? '',
  });
  const [items, setItems] = useState<ItemRow[]>(selected ? selected.items.map(fromDocument) : [{ ...EMPTY }]);
  const companyOf = (plant: string) => choices.plants.find((p) => p.plant === plant.trim().toUpperCase())?.companyCode ?? null;
  const supplyingCompany = companyOf(header.supplyingPlant);
  const patch = (index: number, next: Partial<ItemRow>) => setItems(items.map((item, i) => (i === index ? { ...item, ...next } : item)));

  const payload = JSON.stringify({
    documentType: 'STOCK_TRANSPORT',
    supplyingPlant: header.supplyingPlant.trim(),
    purchasingOrg: header.purchasingOrg,
    purchasingGroup: header.purchasingGroup,
    companyCode: header.companyCode,
    items: items.map((item) => ({
      ...(item.itemNumber ? { itemNumber: item.itemNumber } : {}),
      materialNumber: item.material.trim(),
      quantity: item.quantity.trim(),
      unit: item.unit.trim(),
      plant: item.plant.trim(),
      storageLocation: item.storageLocation.trim(),
      batch: item.batch.trim(),
      markedForDeletion: item.markedForDeletion,
      scheduleLines: item.scheduleLines.map((l) => ({ deliveryDate: l.deliveryDate, quantity: l.quantity.trim() })),
    })),
  });

  return (
    <form action={formAction} data-sto-order-form>
      <input type="hidden" name="payload" value={payload} />
      <input type="hidden" name="orderNumber" value={selected?.orderNumber ?? ''} />
      <fieldset disabled={viewOnly} className="min-w-0">
        <p className="mt-3 text-sm text-ink-soft">
          A stock transport order moves stock from a supplying plant to a receiving plant in two steps (issue 351, receipt 101).
          It has no supplier, no price and no invoice.
        </p>
        <div className="mt-3 grid gap-3 sm:grid-cols-4">
          <label className="block">
            <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-ink-faint">Supplying plant</span>
            <ConstrainedField
              kind="plant"
              className="input w-full"
              value={header.supplyingPlant}
              onChange={(supplyingPlant) => setHeader({ ...header, supplyingPlant })}
            />
          </label>
          <label className="block">
            <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-ink-faint">Receiving company code</span>
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
        </div>

        <div className="mt-3 overflow-x-auto">
          <div className="table-scroll">
            <table className="grid-table">
              <thead>
                <tr className="text-left">
                  <th>Item</th><th>Material</th><th>Quantity</th><th>Unit</th><th>Receiving plant</th>
                  <th>Company flow</th><th>Receiving storage location</th><th>Batch</th>
                  {selected && <th>Marked for deletion</th>}
                </tr>
              </thead>
              <tbody>
                {items.map((item, index) => {
                  const receivingCompany = companyOf(item.plant);
                  const flow = !supplyingCompany || !receivingCompany
                    ? '—'
                    : supplyingCompany === receivingCompany
                      ? `same company ${receivingCompany}`
                      : `cross-company ${supplyingCompany} → ${receivingCompany}`;
                  return (
                    <tr key={index} className="align-top">
                      <td className="text-ink-faint">{String(item.itemNumber ?? (index + 1) * 10).padStart(5, '0')}</td>
                      <td>
                        <ConstrainedField
                          kind="material-order"
                          className="input w-32"
                          value={item.material}
                          context={{ plant: item.plant }}
                          onChange={(material) => patch(index, { material })}
                        />
                      </td>
                      <td>
                        <input className="input w-28" inputMode="decimal" value={item.quantity}
                          onChange={(event) => patch(index, { quantity: event.target.value })} />
                      </td>
                      <td>
                        <ConstrainedField kind="unit" uppercase className="input w-16" value={item.unit}
                          onChange={(unit) => patch(index, { unit })} />
                      </td>
                      <td>
                        <ConstrainedField kind="plant" className="input w-24" value={item.plant}
                          context={{ companyCode: header.companyCode }}
                          onChange={(plant) => patch(index, { plant })} />
                      </td>
                      <td className="text-sm text-ink-soft" data-company-flow>{flow}</td>
                      <td>
                        <ConstrainedField kind="storage-location" className="input w-24" value={item.storageLocation}
                          context={{ plant: item.plant }}
                          onChange={(storageLocation) => patch(index, { storageLocation })} />
                      </td>
                      <td>
                        <input className="input w-24" maxLength={10} value={item.batch}
                          onChange={(event) => patch(index, { batch: event.target.value })} />
                      </td>
                      {selected && (
                        <td>
                          <input type="checkbox" checked={item.markedForDeletion}
                            onChange={(event) => patch(index, { markedForDeletion: event.target.checked })} />
                        </td>
                      )}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
        <Button type="button" className="mt-2" onClick={() => setItems([...items, { ...EMPTY, scheduleLines: [{ deliveryDate: '', quantity: '' }] }])}>
          Add item
        </Button>

        {items.map((item, index) => (
          <section key={index} aria-label={`Item ${index + 1} schedule`} className="mt-3 border border-line p-3">
            <p className="mb-2 text-xs font-medium uppercase tracking-wide text-ink-faint">
              Item {String(item.itemNumber ?? (index + 1) * 10).padStart(5, '0')} · schedule lines
              {' '}(must total the item quantity)
            </p>
            <div className="table-scroll">
              <table className="grid-table">
                <thead><tr className="text-left"><th>Delivery date</th><th>Scheduled quantity</th></tr></thead>
                <tbody>
                  {item.scheduleLines.map((line, lineIndex) => (
                    <tr key={lineIndex}>
                      <td>
                        <input className="input w-44" type="date" value={line.deliveryDate}
                          onChange={(event) => {
                            const lines = item.scheduleLines.slice();
                            lines[lineIndex] = { ...lines[lineIndex], deliveryDate: event.target.value };
                            patch(index, { scheduleLines: lines });
                          }} />
                      </td>
                      <td>
                        <input className="input w-32" inputMode="decimal" value={line.quantity}
                          onChange={(event) => {
                            const lines = item.scheduleLines.slice();
                            lines[lineIndex] = { ...lines[lineIndex], quantity: event.target.value };
                            patch(index, { scheduleLines: lines });
                          }} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <Button type="button" className="mt-2"
              onClick={() => patch(index, { scheduleLines: [...item.scheduleLines, { deliveryDate: '', quantity: '' }] })}>
              Add schedule line
            </Button>
          </section>
        ))}

        <div className="mt-4">
          <Button type="submit" variant="primary" disabled={viewOnly || pending}>
            {selected ? 'Save stock transport order' : 'Create stock transport order'}
          </Button>
        </div>
      </fieldset>
    </form>
  );
}
