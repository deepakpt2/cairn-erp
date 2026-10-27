'use client';

import { useActionState } from 'react';

import type { ConditionView } from '@/modules/sales/conditions';
import { saveConditionAction, type ConditionActionState } from './actions';

const EMPTY: ConditionActionState = { ok: false };

interface Props {
  records: ConditionView[];
  salesAreas: Array<{ salesOrg: string; distributionChannel: string; division: string; name: string; isActive: boolean }>;
  canMaintain: boolean;
}

function money(value: string, currency: string): string {
  return `${Number(value).toFixed(4)} / ${currency.trim()}`;
}

export default function Conditions({ records, salesAreas, canMaintain }: Props) {
  const [state, action] = useActionState(saveConditionAction, EMPTY);
  const today = new Date().toISOString().slice(0, 10);
  const area = salesAreas.find((row) => row.isActive) ?? salesAreas[0];

  const field = (name: string, label: string, placeholder: string, value = '') => (
    <label className="block text-xs text-ink-soft" htmlFor={`condition-${name}`}>
      {label}
      <input
        className="input mt-1"
        id={`condition-${name}`}
        name={name}
        defaultValue={value}
        placeholder={placeholder}
        autoComplete="off"
      />
    </label>
  );

  return (
    <div className="space-y-4">
      {canMaintain ? (
        <form action={action} className="panel space-y-3 p-4" aria-label="Save condition record">
          <h2 className="text-lg font-semibold">Save a price</h2>
          {state.message ? (
            <div className={state.ok ? 'panel panel-success p-3 text-sm' : 'panel panel-danger p-3 text-sm'} role="status">
              <p className="font-medium">{state.message}</p>
              {state.remedy ? <p className="mt-1 text-ink-soft">{state.remedy}</p> : null}
            </div>
          ) : null}
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
            {field('salesOrg', 'Sales organization', '1000', area?.salesOrg ?? '')}
            {field('distributionChannel', 'Distribution channel', '10', area?.distributionChannel ?? '')}
            {field('division', 'Division', '01', area?.division ?? '')}
            {field('customerNumber', 'Customer', 'Blank means every customer')}
            {field('materialNumber', 'Material', 'Blank means every material')}
            {field('currency', 'Currency', 'KWD', 'KWD')}
            {field('amount', 'Amount', '25.00')}
            {field('priceUnit', 'Price unit', '1', '1')}
            {field('validityFrom', 'Valid from', 'YYYY-MM-DD', today)}
            {field('validityTo', 'Valid to', 'YYYY-MM-DD', '2099-12-31')}
          </div>
          <label className="flex items-start gap-2 text-xs text-ink-soft">
            <input type="checkbox" name="supersedeStanding" className="mt-1" />
            <span>
              Replace the price that stands for an overlapping period: the standing record ends the day
              before this one starts. Without this box an overlapping record is refused, because the
              orders that read the standing price must keep reading it.
            </span>
          </label>
          <button type="submit" className="btn btn-primary min-h-11 sm:min-h-8">Save condition record</button>
        </form>
      ) : (
        <p className="panel p-4 text-sm text-ink-soft">
          You hold the display capability only, so the prices below are read-only. A saved price needs{' '}
          <span className="code">CFG.SALES.CONDITION.MAINTAIN</span>.
        </p>
      )}

      <section className="panel p-4" aria-label="Condition records">
        <h2 className="text-lg font-semibold">Standing prices</h2>
        <table className="mt-2 w-full text-sm">
          <thead>
            <tr className="text-left text-xs text-ink-faint">
              <th className="py-1">Record</th><th>Sales area</th><th>Customer</th><th>Material</th>
              <th className="text-right">Amount</th><th>Valid from</th><th>Valid to</th><th>Changed by</th>
            </tr>
          </thead>
          <tbody>
            {records.length === 0 ? (
              <tr><td colSpan={8} className="py-3 text-ink-soft">No condition record stands for that selection.</td></tr>
            ) : records.map((record) => (
              <tr key={record.conditionNumber} className="border-t border-line">
                <td className="py-1 code">{record.conditionNumber}</td>
                <td>{record.salesOrg}/{record.distributionChannel}/{record.division}</td>
                <td>{record.customerNumber || 'any'}</td>
                <td>{record.materialNumber || 'any'}</td>
                <td className="text-right">{money(record.amount, record.currency)}</td>
                <td>{record.validityFrom}</td>
                <td>{record.validityTo}</td>
                <td>{record.changedBy ?? '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </div>
  );
}
