'use client';

import { useActionState } from 'react';

import { SERIAL_STATUSES, SERIAL_STATUS_MEANING } from '@/modules/inventory/serial-status';
import type { SerialView } from '@/modules/inventory/serial-number';
import { saveSerialAction, type SerialActionState } from './actions';

const EMPTY: SerialActionState = { ok: false };

export default function SerialNumbers({ serials, canMaintain }: {
  serials: SerialView[];
  canMaintain: boolean;
}) {
  const [state, action] = useActionState(saveSerialAction, EMPTY);

  const field = (name: string, label: string, placeholder: string) => (
    <label className="block text-xs text-ink-soft" htmlFor={`serial-${name}`}>
      {label}
      <input
        className="input mt-1 code"
        id={`serial-${name}`}
        name={name}
        placeholder={placeholder}
        autoComplete="off"
      />
    </label>
  );

  return (
    <div className="space-y-4">
      {canMaintain ? (
        <form action={action} className="panel space-y-3 p-4" aria-label="Record a serialised unit">
          <h2 className="text-sm font-semibold">Record a unit</h2>
          {state.message ? (
            <div className={state.ok ? 'panel panel-success p-3 text-sm' : 'panel panel-danger p-3 text-sm'} role="status">
              <p className="font-medium">{state.message}</p>
              {state.remedy ? <p className="mt-1 text-ink-soft">{state.remedy}</p> : null}
            </div>
          ) : null}
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
            {field('materialNumber', 'Material', 'SD9259MAT2')}
            {field('serialNumber', 'Serial number', 'SN-0001')}
            {field('plant', 'Plant', '1000')}
            {field('storageLocation', 'Storage location', '0001')}
            {field('batchNumber', 'Batch', 'Optional')}
            <label className="block text-xs text-ink-soft" htmlFor="serial-status">
              Where it stands
              <select className="input mt-1" id="serial-status" name="status" defaultValue="IN_STOCK">
                {SERIAL_STATUSES.filter((status) => status !== 'DELIVERED').map((status) => (
                  <option key={status} value={status}>{status}</option>
                ))}
              </select>
            </label>
          </div>
          <p className="text-xs text-ink-faint">
            Recording the same serial a second time moves the unit rather than making another one:
            a serial is the identity of a thing, and there is only one of it. A unit goes out on a
            delivery pick — it is not recorded as delivered by hand, because the pick is what writes
            the delivery it went on.
          </p>
          <button type="submit" className="btn btn-primary min-h-11 sm:min-h-8">Record the unit</button>
        </form>
      ) : null}

      <section className="panel p-4" aria-label="Serial numbers">
        <h2 className="text-sm font-semibold">The units that stand</h2>
        {serials.length === 0 ? (
          <p className="mt-2 text-sm text-ink-soft">
            No serialised unit is recorded, so a material that demands serials asks the picker which
            units came off the shelf and is told there are none standing. Nothing is seeded, and a
            tenant that records no units is not pretending to any.
          </p>
        ) : (
          <table className="grid-table mt-2 text-sm">
            <thead>
              <tr className="text-left text-xs text-ink-faint">
                <th>Material</th><th>Serial</th><th>Plant</th><th>Store</th>
                <th>Batch</th><th>Where it stands</th><th>Delivery</th><th>Customer</th>
              </tr>
            </thead>
            <tbody>
              {serials.map((row) => (
                <tr key={`${row.materialNumber}-${row.serialNumber}`}>
                  <td className="code">{row.materialNumber}</td>
                  <td className="code">{row.serialNumber}</td>
                  <td className="code">{row.plant || '—'}</td>
                  <td className="code">{row.storageLocation || '—'}</td>
                  <td className="code">{row.batchNumber || '—'}</td>
                  <td title={SERIAL_STATUS_MEANING[row.status]}>{row.status}</td>
                  <td className="code">{row.deliveryNumber || '—'}</td>
                  <td className="code">{row.customerNumber || '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}
