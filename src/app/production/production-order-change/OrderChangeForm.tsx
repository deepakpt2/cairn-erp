'use client';

import { useActionState } from 'react';

import { ChangeLock } from '@/ui/lock/ChangeLock';
import { PRODUCTION_ORDER_LOCK } from '@/modules/production/production-order-change';
import type { ProductionOrderDisplay } from '@/modules/production/production-order-display';
import { changeProductionOrderAction, type ProductionOrderChangeState } from './actions';

const initial: ProductionOrderChangeState = { ok: false };

export default function OrderChangeForm({ order }: { order: ProductionOrderDisplay }) {
  const [state, action, pending] = useActionState(changeProductionOrderAction, initial);
  const shown = state.order ?? order;
  return (
    <form action={action} className="mt-4 space-y-3 text-sm">
      <ChangeLock lockObject={PRODUCTION_ORDER_LOCK} argument={shown.orderNumber} />
      <input type="hidden" name="orderNumber" value={shown.orderNumber} />
      <input type="hidden" name="version" value={String(shown.version)} />
      <input type="hidden" name="materialNumber" value={shown.materialNumber} />
      <input type="hidden" name="plant" value={shown.plant} />
      <input type="hidden" name="unit" value={shown.unit} />
      <label className="block">Quantity
        <input className="input mt-1" name="quantity" defaultValue={shown.quantity} />
      </label>
      <label className="block">Start
        <input className="input mt-1" name="startDate" defaultValue={shown.scheduledStart} />
      </label>
      <label className="block">Finish
        <input className="input mt-1" name="finishDate" defaultValue={shown.scheduledFinish} />
      </label>
      <table className="w-full">
        <thead>
          <tr className="text-left text-ink-faint">
            <th>Item</th>
            <th>Component</th>
            <th>Quantity</th>
            <th>Location</th>
            <th>Remove</th>
          </tr>
        </thead>
        <tbody>
          {shown.components.map((component) => (
            <tr key={component.itemNumber}>
              <td><input type="hidden" name="itemNumber" value={String(component.itemNumber)} />{component.itemNumber}</td>
              <td><input type="hidden" name="componentMaterial" value={component.materialNumber} />{component.materialNumber}</td>
              <td><input className="input" name="componentQuantity" defaultValue={component.requiredQuantity} /></td>
              <td>
                <input type="hidden" name="componentUnit" value={component.unit} />
                <input className="input" name="componentLocation" defaultValue={component.storageLocation ?? ''} />
              </td>
              <td><input type="checkbox" name={`remove-${component.itemNumber}`} value="X" /></td>
            </tr>
          ))}
          <tr>
            <td>New</td>
            <td><input type="hidden" name="itemNumber" value="" /><input className="input" name="componentMaterial" placeholder="Material" /></td>
            <td><input className="input" name="componentQuantity" placeholder="Quantity" /></td>
            <td><input type="hidden" name="componentUnit" value="" /><input className="input" name="componentLocation" placeholder="Location" /></td>
            <td></td>
          </tr>
        </tbody>
      </table>
      <button className="btn" type="submit" disabled={pending}>Save</button>
      {state.message && <p className={state.ok ? 'text-ink' : 'text-danger'}>{state.message}{state.remedy ? ` ${state.remedy}` : ''}</p>}
      {state.warnings?.map((warning) => <p key={warning}>{warning}</p>)}
    </form>
  );
}
