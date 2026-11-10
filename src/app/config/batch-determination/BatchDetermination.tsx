'use client';

import { useActionState } from 'react';

import { SORT_RULES, SORT_RULE_MEANING } from '@/modules/sales/batch-sort-rules';
import type { BatchRule } from '@/modules/sales/batch-determination';
import {
  saveBatchRuleAction, type BatchRuleActionState,
} from './actions';

const EMPTY: BatchRuleActionState = { ok: false };

export default function BatchDetermination({ rules, canMaintain }: {
  rules: BatchRule[];
  canMaintain: boolean;
}) {
  const [state, action] = useActionState(saveBatchRuleAction, EMPTY);

  const field = (name: string, label: string, placeholder: string, value?: string) => (
    <label className="block text-xs text-ink-soft" htmlFor={`rule-${name}`}>
      {label}
      <input
        className="input mt-1 code"
        id={`rule-${name}`}
        name={name}
        defaultValue={value ?? ''}
        placeholder={placeholder}
        autoComplete="off"
      />
    </label>
  );

  return (
    <div className="space-y-4">
      {canMaintain ? (
        <form action={action} className="panel space-y-3 p-4" aria-label="Maintain a batch determination rule">
          <h2 className="text-sm font-semibold">Maintain a rule</h2>
          {state.message ? (
            <div className={state.ok ? 'panel panel-success p-3 text-sm' : 'panel panel-danger p-3 text-sm'} role="status">
              <p className="font-medium">{state.message}</p>
              {state.remedy ? <p className="mt-1 text-ink-soft">{state.remedy}</p> : null}
            </div>
          ) : null}
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
            {field('ruleNumber', 'Rule', 'BATCH1')}
            {field('name', 'What it is for', 'Perishables to the wholesaler')}
            {field('customerNumber', 'Customer', 'Any customer')}
            {field('materialNumber', 'Material', 'Any material')}
            {field('plant', 'Plant', 'Any plant')}
            {field('salesOrg', 'Sales organisation', 'Any sales org')}
            {field('distributionChannel', 'Channel', 'Any channel')}
            <label className="block text-xs text-ink-soft" htmlFor="rule-sortRule">
              The order batches are taken in
              <select className="input mt-1" id="rule-sortRule" name="sortRule" defaultValue="FIFO">
                {SORT_RULES.map((rule) => (
                  <option key={rule} value={rule}>{rule}</option>
                ))}
              </select>
            </label>
            {field('validityFrom', 'Valid from', '2026-01-01')}
            {field('validityTo', 'Valid to', '2026-12-31')}
            <label className="flex items-end gap-2 pb-2 text-xs text-ink-soft">
              <input type="checkbox" name="isActive" defaultChecked className="h-4 w-4" />
              Active
            </label>
          </div>
          <p className="text-xs text-ink-faint">
            A blank box answers for every value of it. Where two rules answer, the more specific one
            wins: a rule naming the material beats one naming only the customer, and one naming the
            customer beats one naming nothing.
          </p>
          <button type="submit" className="btn btn-primary min-h-11 sm:min-h-8">Save the rule</button>
        </form>
      ) : null}

      <section className="panel p-4" aria-label="Batch determination rules">
        <h2 className="text-sm font-semibold">The rules that stand</h2>
        {rules.length === 0 ? (
          <p className="mt-2 text-sm text-ink-soft">
            No rule is maintained, so a pick that names no batch is confirmed with no batch, exactly as
            it has always been. Determination is not a default you have to switch off — it is an answer
            a tenant has to ask for.
          </p>
        ) : (
          <table className="grid-table mt-2 text-sm">
            <thead>
              <tr className="text-left text-xs text-ink-faint">
                <th>Rule</th><th>What it is for</th><th>Customer</th><th>Material</th>
                <th>Plant</th><th>Sales org</th><th>Order</th><th>Valid</th><th>Active</th>
              </tr>
            </thead>
            <tbody>
              {rules.map((rule) => (
                <tr key={rule.ruleNumber}>
                  <td className="code">{rule.ruleNumber}</td>
                  <td>{rule.name}</td>
                  <td className="code">{rule.customerNumber || 'any'}</td>
                  <td className="code">{rule.materialNumber || 'any'}</td>
                  <td className="code">{rule.plant || 'any'}</td>
                  <td className="code">{rule.salesOrg || 'any'}</td>
                  <td title={SORT_RULE_MEANING[rule.sortRule]}>{rule.sortRule}</td>
                  <td className="code">{rule.validityFrom} – {rule.validityTo}</td>
                  <td>{rule.isActive ? 'yes' : 'no'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}
