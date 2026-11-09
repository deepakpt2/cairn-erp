'use client';

import Link from 'next/link';
import { useActionState, useId } from 'react';

import type { BillingPlanView } from '@/modules/sales/billing-plan';
import type { listBillingPlans, planTypeChoices } from '@/modules/sales/billing-plan';
import { saveBillingPlanAction, type BillingPlanActionState } from './actions';

const EMPTY: BillingPlanActionState = { ok: false };
const DATE_SLOTS = 12;

interface Props {
  plans: Awaited<ReturnType<typeof listBillingPlans>>;
  types: Awaited<ReturnType<typeof planTypeChoices>>;
  selected: BillingPlanView | null;
  orderNumber: string;
  orderLineNumber: number | null;
  canMaintain: boolean;
}

function Notice({ state, label }: { state: BillingPlanActionState; label?: string }) {
  if (!state.message) return null;
  return (
    <div className={state.ok ? 'panel panel-success mt-3 p-3 text-sm' : 'panel panel-danger mt-3 p-3 text-sm'} role="status">
      {label ? <p className="text-xs text-ink-faint">{label}</p> : null}
      <p className="font-medium">{state.message}</p>
      {state.remedy ? <p className="mt-1 text-ink-soft">{state.remedy}</p> : null}
      {state.ok && state.orderNumber ? (
        <p className="mt-2">
          <Link className="link" href={`/sales/billing-plans?order=${state.orderNumber}&item=${state.orderLineNumber}`}>
            Open the plan of order {state.orderNumber} item {state.orderLineNumber}
          </Link>
        </p>
      ) : null}
    </div>
  );
}

/**
 * The plan itself: the order item, what kind of plan it is, and the dates it is made of.
 *
 * The dates submitted are the plan. One that stood and was not submitted again is withdrawn, not
 * deleted — a plan is part of what was agreed about an order — and the shares have to total a hundred,
 * because a plan that promises ninety has not said when the last tenth is billed.
 */
function MaintainPlan({
  types, selected, orderNumber, orderLineNumber, allowed,
}: { types: Props['types']; selected: BillingPlanView | null; orderNumber: string; orderLineNumber: number | null; allowed: boolean }) {
  const [state, action, pending] = useActionState(saveBillingPlanAction, EMPTY);
  const id = useId();
  if (!allowed) {
    return (
      <p className="mt-2 text-sm text-ink-soft">
        Billing plans are read-only for this session: maintaining one needs SALES.BILLING_PLAN.MAINTAIN.
      </p>
    );
  }
  // What stands and can still be changed: a billed date is settled, and the service refuses the whole
  // plan rather than half of it, so the form says so before the refusal can arrive.
  const editable = selected?.dates.filter((date) => date.status !== 'WITHDRAWN') ?? [];
  const billed = selected?.dates.find((date) => date.status === 'BILLED');
  const settled = Boolean(billed);
  return (
    <form action={action} className="panel space-y-3 p-4" aria-label="Maintain a billing plan">
      <p className="text-sm font-medium">Maintain the billing plan of an order item</p>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <label className="block text-xs text-ink-soft" htmlFor={`${id}-order`}>
          Sales order
          <input
            className="input mt-1" id={`${id}-order`} name="orderNumber"
            defaultValue={selected?.orderNumber ?? orderNumber} placeholder="OR-0000001" autoComplete="off"
          />
        </label>
        <label className="block text-xs text-ink-soft" htmlFor={`${id}-item`}>
          Item
          <input
            className="input mt-1" id={`${id}-item`} name="orderLineNumber"
            defaultValue={selected?.orderLineNumber ?? orderLineNumber ?? 10} autoComplete="off"
          />
        </label>
        <label className="block text-xs text-ink-soft" htmlFor={`${id}-type`}>
          Kind of plan
          <select className="input mt-1" id={`${id}-type`} name="planType" defaultValue={selected?.planType ?? 'PE'}>
            {types.map((type) => (
              <option key={type.planType} value={type.planType} title={type.meaning}>
                {type.planType} · {type.displayName}
              </option>
            ))}
            {types.length === 0 ? <option value="PE">PE · Periodic</option> : null}
          </select>
        </label>
        <label className="block text-xs text-ink-soft" htmlFor={`${id}-reason`}>
          Why it is changed
          <input
            className="input mt-1" id={`${id}-reason`} name="reason"
            placeholder="Agreed schedule with the customer" autoComplete="off"
          />
        </label>
      </div>
      <p className="text-xs text-ink-faint">
        {types.find((type) => type.planType === (selected?.planType ?? 'PE'))?.meaning ?? ''}
      </p>

      <div className="space-y-1">
        <div className="grid grid-cols-4 gap-2 text-xs font-medium text-ink-soft sm:grid-cols-5">
          <span>Day it falls on</span><span className="text-right">Share of the item</span>
          <span />
        </div>
        {Array.from({ length: DATE_SLOTS }, (_, index) => index + 1).map((slot) => {
          const date = editable[slot - 1];
          return (
            <div key={slot} className="grid grid-cols-4 gap-2 sm:grid-cols-5">
              <input type="hidden" name={`date-${slot}-dateNumber`} value={date?.dateNumber ?? ''} />
              <input
                className="input" name={`date-${slot}-billingDate`} defaultValue={date?.billingDate ?? ''}
                placeholder="YYYY-MM-DD" aria-label={`Day of date ${slot}`} autoComplete="off"
              />
              <input
                className="input text-right" name={`date-${slot}-percentage`} defaultValue={date?.percentage ?? ''}
                placeholder="0" aria-label={`Share carried by date ${slot}`} autoComplete="off"
              />
              <select
                className="input" name={`date-${slot}-billingRule`}
                defaultValue={date?.billingRule ?? 'INVOICE'}
                aria-label={`What date ${slot} does with its share`}
              >
                <option value="INVOICE">Invoice it</option>
                <option value="DOWN_PAYMENT">Ask in advance</option>
              </select>
            </div>
          );
        })}
      </div>
      <p className="text-xs text-ink-faint">
        The dates that invoice share a hundred per cent between them, and every date is billed on the day it
        names or later — a plan is a promise about a day. A date that asks in advance raises a request for
        that share and posts nothing: the money arrives as an advance, and the invoice that settles it is
        raised from the dates that invoice.
      </p>
      <input type="hidden" name="expectedVersion" value={selected?.version ?? ''} />
      <input type="hidden" name="requestKey" value={`BP-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`} />
      {settled ? (
        <p className="text-sm text-ink-soft">
          This plan has a billed date — date {billed?.dateNumber} was billed as{' '}
          <Link className="link" href={`/sales/billing?billing=${billed?.billingNumber}`}>{billed?.billingNumber}</Link>
          {' '}— so it is settled as it stands. Cancel that document first: a cancelled document releases its date.
        </p>
      ) : null}
      <button type="submit" className="btn btn-primary min-h-11 sm:min-h-9" disabled={pending || settled}>
        {pending ? 'Saving…' : selected ? 'Replace the plan' : 'Create the plan'}
      </button>
      <Notice state={state} label="Billing plan" />
    </form>
  );
}

export default function BillingPlans({
  plans, types, selected, orderNumber, orderLineNumber, canMaintain,
}: Props) {
  return (
    <div className="space-y-4">
      <section className="panel p-4" aria-label="Billing plans">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="text-sm font-semibold">Billing plans</h2>
          <span className="code text-ink-faint">{plans.length} standing</span>
        </div>
        <table className="grid-table mt-3 text-sm">
          <thead>
            <tr>
              <th>Order</th><th>Item</th><th>Material</th><th>Kind</th>
              <th className="text-right">Dates</th><th className="text-right">Shares</th>
              <th className="text-right">Billed</th><th>Version</th>
            </tr>
          </thead>
          <tbody>
            {plans.map((plan) => (
              <tr key={`${plan.orderNumber}-${plan.orderLineNumber}`}>
                <td>
                  <Link className="link" href={`/sales/billing-plans?order=${plan.orderNumber}&item=${plan.orderLineNumber}`}>
                    {plan.orderNumber}
                  </Link>
                </td>
                <td>{plan.orderLineNumber}</td>
                <td>{plan.materialNumber}</td>
                <td>{plan.planTypeName}</td>
                <td className="text-right">{plan.dates.filter((date) => date.status !== 'WITHDRAWN').length}</td>
                <td className="text-right">{Number(plan.totalPercentage).toFixed(3)}%</td>
                <td className="text-right">{plan.dates.filter((date) => date.status === 'BILLED').length}</td>
                <td>{plan.version}</td>
              </tr>
            ))}
            {plans.length === 0 ? (
              <tr>
                <td colSpan={8} className="text-ink-soft">
                  No billing plan stands. Maintain one on an item that is billed by a schedule rather than by
                  what is delivered — twelve months of maintenance, or a piece of work paid in stages.
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </section>

      {selected ? (
        <section className="panel p-4" aria-label={`Plan of order ${selected.orderNumber} item ${selected.orderLineNumber}`}>
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h2 className="text-sm font-semibold">
              Order {selected.orderNumber} item {selected.orderLineNumber} · {selected.materialNumber}
            </h2>
            <span className="code text-ink-faint">
              {selected.planType} · {selected.planTypeName} · version {selected.version}
            </span>
          </div>
          <table className="grid-table mt-3 text-sm">
            <thead>
              <tr>
                <th>Date</th><th>Day it falls on</th><th className="text-right">Share</th>
                <th>What it does</th><th>Status</th><th>Document</th>
              </tr>
            </thead>
            <tbody>
              {selected.dates.map((date) => (
                <tr key={date.dateNumber}>
                  <td>{date.dateNumber}</td>
                  <td>{date.billingDate}</td>
                  <td className="text-right">{Number(date.percentage).toFixed(3)}%</td>
                  <td>{date.billingRule === 'DOWN_PAYMENT' ? 'asks in advance' : 'invoices'}</td>
                  <td>{date.status === 'WITHDRAWN' ? 'withdrawn' : date.status.toLowerCase()}</td>
                  <td>
                    {date.billingNumber
                      ? <Link className="link" href={`/sales/billing?billing=${date.billingNumber}`}>{date.billingNumber}</Link>
                      : <span className="text-ink-faint">—</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="mt-2 text-sm text-ink-soft">
            A withdrawn date answers nothing from the day it was withdrawn, and it stays on the record: a plan
            is part of what was agreed about this order. A date that asks in advance raises a request, and the
            invoice that settles it is raised from the dates that invoice — the advance is then cleared against
            that invoice, and what is still to pay is the billed value less it.
          </p>
        </section>
      ) : null}

      <MaintainPlan
        types={types}
        selected={selected}
        orderNumber={orderNumber}
        orderLineNumber={orderLineNumber}
        allowed={canMaintain}
      />
    </div>
  );
}
