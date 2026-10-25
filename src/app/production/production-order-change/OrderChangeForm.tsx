'use client';

import { useActionState } from 'react';

import { ChangeLock } from '@/ui/lock/ChangeLock';
import type { ProductionOrderDisplay } from '@/modules/production/production-order-display';
import {
  changeProductionOrderAction,
  revokeTechnicalCompletionAction,
  technicallyCompleteProductionOrderAction,
  type ProductionOrderChangeState,
} from './actions';

const initial: ProductionOrderChangeState = { ok: false };

export default function OrderChangeForm({ order }: { order: ProductionOrderDisplay }) {
  const [saved, save, savePending] = useActionState(changeProductionOrderAction, initial);
  const [completed, complete, completePending] = useActionState(technicallyCompleteProductionOrderAction, initial);
  const [revoked, revoke, revokePending] = useActionState(revokeTechnicalCompletionAction, initial);
  const shown = completed.order ?? revoked.order ?? saved.order ?? order;
  const technicallyComplete = shown.status === 'TECHNICALLY_COMPLETED';
  const busy = savePending || completePending || revokePending;
  const editsLocked = technicallyComplete || busy;
  return (
    <div className="mt-4 space-y-4 text-sm">
      <p data-co02-status>
        Status {shown.status}. Record version {shown.version}.
        {shown.technicallyCompletedBy
          ? ` Technically completed by ${shown.technicallyCompletedBy} at ${shown.technicallyCompletedAt ?? '—'}.`
          : ' Technical completion has not been recorded.'}
        {technicallyComplete ? ' Quantity, dates, and components are display-only until completion is revoked.' : ''}
      </p>
      <form action={save} className="space-y-3">
        <ChangeLock lockObject="PRODUCTION_ORDER" argument={shown.orderNumber} />
        <input type="hidden" name="orderNumber" value={shown.orderNumber} />
        <input type="hidden" name="version" value={String(shown.version)} />
        <input type="hidden" name="materialNumber" value={shown.materialNumber} />
        <input type="hidden" name="plant" value={shown.plant} />
        <p data-order-type={shown.orderType ?? ''}>Order type {shown.orderType ?? 'not assigned'}. This change does not replace it.</p>
        <input type="hidden" name="unit" value={shown.unit} />
        <label className="block">Quantity
          <input className="input mt-1" name="quantity" defaultValue={shown.quantity} disabled={editsLocked} />
        </label>
        <label className="block">Start
          <input className="input mt-1" name="startDate" defaultValue={shown.scheduledStart} disabled={editsLocked} />
        </label>
        <label className="block">Finish
          <input className="input mt-1" name="finishDate" defaultValue={shown.scheduledFinish} disabled={editsLocked} />
        </label>
        <p>A component requirement date is not moved when the start or finish changes. No scheduling calculation exists. The finish is the receipt date and is separate from component demand.</p>
        <table className="w-full">
          <thead>
            <tr className="text-left text-ink-faint">
              <th>Item</th>
              <th>Component</th>
              <th>Quantity</th>
              <th>Requirement date</th>
              <th>Location</th>
              <th>Remove</th>
            </tr>
          </thead>
          <tbody>
            {shown.components.map((component) => (
              <tr key={component.itemNumber}>
                <td><input type="hidden" name="itemNumber" value={String(component.itemNumber)} />{component.itemNumber}</td>
                <td><input type="hidden" name="componentMaterial" value={component.materialNumber} />{component.materialNumber}</td>
                <td><input className="input" name="componentQuantity" defaultValue={component.requiredQuantity} disabled={editsLocked} /></td>
                <td data-requirement-date={component.requirementDate ?? ''}>{component.requirementDate ?? 'not established'}</td>
                <td>
                  <input type="hidden" name="componentUnit" value={component.unit} />
                  <input className="input" name="componentLocation" defaultValue={component.storageLocation ?? ''} disabled={editsLocked} />
                </td>
                <td><input type="checkbox" name={`remove-${component.itemNumber}`} value="X" disabled={editsLocked} /></td>
              </tr>
            ))}
            <tr>
              <td>New</td>
              <td><input type="hidden" name="itemNumber" value="" /><input className="input" name="componentMaterial" placeholder="Material" disabled={editsLocked} /></td>
              <td><input className="input" name="componentQuantity" placeholder="Quantity" disabled={editsLocked} /></td>
              <td>not established</td>
              <td><input type="hidden" name="componentUnit" value="" /><input className="input" name="componentLocation" placeholder="Location" disabled={editsLocked} /></td>
              <td></td>
            </tr>
          </tbody>
        </table>
        <button className="btn" type="submit" disabled={editsLocked}>Save</button>
        {saved.message && <p className={saved.ok ? 'text-ink' : 'text-danger'}>{saved.message}{saved.remedy ? ` ${saved.remedy}` : ''}</p>}
        {saved.warnings?.map((warning) => <p key={warning}>{warning}</p>)}
      </form>
      {!technicallyComplete && (
        <form action={complete}>
          <input type="hidden" name="orderNumber" value={shown.orderNumber} />
          <input type="hidden" name="version" value={String(shown.version)} />
          <button className="btn" type="submit" disabled={busy} data-co02-teco>Technically complete</button>
        </form>
      )}
      {technicallyComplete && (
        <form action={revoke}>
          <input type="hidden" name="orderNumber" value={shown.orderNumber} />
          <input type="hidden" name="version" value={String(shown.version)} />
          <button className="btn" type="submit" disabled={busy} data-co02-revoke-teco>Revoke technical completion</button>
        </form>
      )}
      {completed.message && <p className={completed.ok ? 'text-ink' : 'text-danger'}>{completed.message}{completed.remedy ? ` ${completed.remedy}` : ''}</p>}
      {completed.warnings?.map((warning) => <p key={warning}>{warning}</p>)}
      {revoked.message && <p className={revoked.ok ? 'text-ink' : 'text-danger'}>{revoked.message}{revoked.remedy ? ` ${revoked.remedy}` : ''}</p>}
      {revoked.warnings?.map((warning) => <p key={warning}>{warning}</p>)}
    </div>
  );
}
