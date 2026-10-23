'use client';

import { useActionState, useState } from 'react';

import type { SchedulingAgreementDocument } from '@/modules/purchasing/scheduling-agreement';
import { saveDeliveryScheduleAction, type ScheduleActionState } from './actions';

interface LineRow {
  lineNumber?: number;
  deliveryDate: string;
  quantity: string;
  markedForDeletion: boolean;
}

const INITIAL: ScheduleActionState = { ok: false };

export default function ScheduleForm({ document, itemNumber }: {
  document: SchedulingAgreementDocument;
  itemNumber: number;
}) {
  const item = document.items.find((row) => row.itemNumber === itemNumber);
  const [state, action, pending] = useActionState(saveDeliveryScheduleAction, INITIAL);
  const [lines, setLines] = useState<LineRow[]>(
    document.scheduleLines
      .filter((line) => line.itemNumber === itemNumber)
      .sort((left, right) => left.deliveryDate.localeCompare(right.deliveryDate) || left.lineNumber - right.lineNumber)
      .map((line) => ({
        lineNumber: line.lineNumber,
        deliveryDate: line.deliveryDate,
        quantity: line.quantity,
        markedForDeletion: line.markedForDeletion,
      })),
  );

  function payload(): string {
    return JSON.stringify({
      agreementNumber: document.agreementNumber,
      itemNumber,
      lines: lines.map((line) => ({
        lineNumber: line.lineNumber,
        deliveryDate: line.deliveryDate,
        quantity: Number(line.quantity),
        markedForDeletion: line.markedForDeletion,
      })),
    });
  }

  if (!item) return <p className="text-sm">Item {itemNumber} does not belong to this agreement.</p>;

  return (
    <form action={action} className="space-y-3">
      <h2 className="text-sm font-semibold">ME38 · item {item.itemNumber}</h2>
      <p className="text-sm text-ink-soft">
        {item.shortText}. Target {item.targetQuantity} {item.unit}. Scheduled {item.scheduledQuantity}. Remaining {item.remainingQuantity}. The item unit is {item.unit}. A goods receipt is not linked to these lines.
      </p>
      <input type="hidden" name="payload" value={payload()} />
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b text-left">
            <th className="px-2 py-2">Line</th>
            <th className="px-2 py-2">Delivery date</th>
            <th className="px-2 py-2">Quantity</th>
            <th className="px-2 py-2">Cancel</th>
          </tr>
        </thead>
        <tbody>
          {lines.map((line, index) => (
            <tr key={line.lineNumber ?? `new-${index}`}>
              <td className="px-2 py-1">{line.lineNumber ?? 'New'}</td>
              <td className="px-2 py-1">
                <input aria-label="Delivery date" className="input" type="date" value={line.deliveryDate} onChange={(event) => setLines(lines.map((row, i) => i === index ? { ...row, deliveryDate: event.target.value } : row))} />
              </td>
              <td className="px-2 py-1">
                <input aria-label="Scheduled quantity" className="input w-28" value={line.quantity} onChange={(event) => setLines(lines.map((row, i) => i === index ? { ...row, quantity: event.target.value } : row))} />
              </td>
              <td className="px-2 py-1">
                <input aria-label="Cancel line" type="checkbox" checked={line.markedForDeletion} onChange={(event) => setLines(lines.map((row, i) => i === index ? { ...row, markedForDeletion: event.target.checked } : row))} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="flex gap-2">
        <button type="button" className="btn btn-default min-h-11 sm:min-h-8" onClick={() => setLines([...lines, { deliveryDate: document.validityStart, quantity: '', markedForDeletion: false }])}>Add line</button>
        <button className="btn btn-primary min-h-11 sm:min-h-8" disabled={pending || lines.length === 0}>{pending ? 'Saving' : 'Save schedule'}</button>
      </div>
      {state.message && (
        <p className={state.ok ? 'text-sm' : 'text-sm text-red-700'} role="status">{state.message} {state.remedy ?? ''}</p>
      )}
      <p className="text-sm text-ink-soft">A partial schedule is allowed. Saving does not send a supplier release, run MRP, or post inventory. A firm zone is not stored.</p>
    </form>
  );
}
