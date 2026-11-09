'use client';

import Link from 'next/link';
import { useActionState, useId } from 'react';

import type { RebateRegister, rebateConditionTypes, listRebateAgreements } from '@/modules/sales/rebate';
import {
  releaseRebateAgreementAction,
  saveRebateAgreementAction,
  settleRebateAgreementAction,
  type RebateActionState,
} from './actions';

const EMPTY: RebateActionState = { ok: false };

interface Props {
  agreements: Awaited<ReturnType<typeof listRebateAgreements>>;
  types: Awaited<ReturnType<typeof rebateConditionTypes>>;
  register: RebateRegister | null;
  canMaintain: boolean;
  canSettle: boolean;
  today: string;
}

function Notice({ state, label }: { state: RebateActionState; label?: string }) {
  if (!state.message) return null;
  return (
    <div className={state.ok ? 'panel panel-success mt-3 p-3 text-sm' : 'panel panel-danger mt-3 p-3 text-sm'} role="status">
      {label ? <p className="text-xs text-ink-faint">{label}</p> : null}
      <p className="font-medium">{state.message}</p>
      {state.remedy ? <p className="mt-1 text-ink-soft">{state.remedy}</p> : null}
      {state.ok && state.agreementNumber ? (
        <p className="mt-2">
          <Link className="link" href={`/sales/rebate-agreements?agreement=${state.agreementNumber}`}>
            Open agreement {state.agreementNumber}
          </Link>
        </p>
      ) : null}
    </div>
  );
}

/**
 * Maintain an agreement: who the promise was made to, over what period, priced by which rebate
 * condition type. It stands open, and open accrues nothing.
 */
function MaintainAgreement({
  types, register, allowed, today,
}: { types: Props['types']; register: RebateRegister | null; allowed: boolean; today: string }) {
  const [state, action, pending] = useActionState(saveRebateAgreementAction, EMPTY);
  const id = useId();
  if (!allowed) {
    return (
      <p className="mt-2 text-sm text-ink-soft">
        Rebate agreements are read-only for this session: maintaining one needs SALES.REBATE.MAINTAIN.
      </p>
    );
  }
  const agreement = register?.agreement;
  return (
    <form action={action} className="panel space-y-3 p-4" aria-label="Maintain a rebate agreement">
      <p className="text-sm font-medium">{agreement ? 'Change the period this agreement runs to' : 'Promise a customer a rebate'}</p>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <label className="block text-xs text-ink-soft" htmlFor={`${id}-customer`}>
          Customer
          <input
            className="input mt-1" id={`${id}-customer`} name="customerNumber"
            defaultValue={agreement?.customerNumber ?? ''} placeholder="C10000" autoComplete="off"
            disabled={Boolean(agreement)}
          />
        </label>
        <label className="block text-xs text-ink-soft" htmlFor={`${id}-org`}>
          Sales organisation
          <input
            className="input mt-1" id={`${id}-org`} name="salesOrg"
            defaultValue={agreement?.salesOrg ?? '1000'} autoComplete="off" disabled={Boolean(agreement)}
          />
        </label>
        <label className="block text-xs text-ink-soft" htmlFor={`${id}-channel`}>
          Channel
          <input
            className="input mt-1" id={`${id}-channel`} name="distributionChannel"
            defaultValue={agreement?.distributionChannel ?? ''} autoComplete="off" disabled={Boolean(agreement)}
          />
        </label>
        <label className="block text-xs text-ink-soft" htmlFor={`${id}-division`}>
          Division
          <input
            className="input mt-1" id={`${id}-division`} name="division"
            defaultValue={agreement?.division ?? ''} autoComplete="off" disabled={Boolean(agreement)}
          />
        </label>
        <label className="block text-xs text-ink-soft" htmlFor={`${id}-from`}>
          Runs from
          <input
            className="input mt-1" id={`${id}-from`} name="validFrom" type="date"
            defaultValue={agreement?.validFrom ?? today} disabled={Boolean(agreement)}
          />
        </label>
        <label className="block text-xs text-ink-soft" htmlFor={`${id}-to`}>
          Runs to
          <input
            className="input mt-1" id={`${id}-to`} name="validTo" type="date"
            defaultValue={agreement?.validTo ?? today}
          />
        </label>
        <label className="block text-xs text-ink-soft" htmlFor={`${id}-currency`}>
          Currency
          <input
            className="input mt-1" id={`${id}-currency`} name="currency" maxLength={3}
            defaultValue={agreement?.currency ?? 'USD'} autoComplete="off" disabled={Boolean(agreement)}
          />
        </label>
        <label className="block text-xs text-ink-soft" htmlFor={`${id}-type`}>
          Priced by
          <select
            className="input mt-1" id={`${id}-type`} name="conditionType"
            defaultValue={agreement?.conditionType ?? 'BO01'} disabled={Boolean(agreement)}
          >
            {types.map((type) => (
              <option key={type.conditionType} value={type.conditionType}>
                {type.conditionType} · {type.name}
              </option>
            ))}
            {types.length === 0 ? <option value="BO01">BO01 · Rebate accrual</option> : null}
          </select>
        </label>
      </div>
      <p className="text-xs text-ink-faint">
        {types.find((type) => type.conditionType === (agreement?.conditionType ?? 'BO01'))
          ? `Calculated as a ${(types.find((type) => type.conditionType === (agreement?.conditionType ?? 'BO01'))?.calculationType ?? '').toLowerCase()} of the net value of the line, and provided for in the account the key ${types.find((type) => type.conditionType === (agreement?.conditionType ?? 'BO01'))?.accountKey ?? ''} determines.`
          : 'The rate is a condition record, maintained where every other price is maintained.'}
      </p>
      <input type="hidden" name="agreementNumber" value={agreement?.agreementNumber ?? ''} />
      <input type="hidden" name="requestKey" value={`RB-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`} />
      <button type="submit" className="btn btn-primary min-h-11 sm:min-h-9" disabled={pending}>
        {pending ? 'Saving…' : agreement ? 'Change the period' : 'Create the agreement'}
      </button>
      {agreement ? (
        <p className="text-xs text-ink-faint">
          An agreement that has accrued is history: the customer, the sales area and the rate it was priced
          by cannot be rewritten underneath money that has already been provided for.
        </p>
      ) : null}
      <Notice state={state} label="Rebate agreement" />
    </form>
  );
}

/** Release an agreement, which is the act that lets it accrue. */
function ReleaseAgreement({ agreementNumber, allowed }: { agreementNumber: string; allowed: boolean }) {
  const [state, action, pending] = useActionState(releaseRebateAgreementAction, EMPTY);
  return (
    <form action={action} className="panel space-y-2 p-4" aria-label="Release a rebate agreement">
      <p className="text-sm font-medium">Release it</p>
      <p className="text-xs text-ink-soft">
        An agreement accrues nothing until it stands released: a provision nobody authorised is worse than no
        provision.
      </p>
      <input type="hidden" name="agreementNumber" value={agreementNumber} />
      <button type="submit" className="btn btn-default min-h-11 sm:min-h-9" disabled={pending || !allowed}>
        {pending ? 'Releasing…' : 'Release the agreement'}
      </button>
      {!allowed ? (
        <p className="text-xs text-ink-faint">Releasing an agreement needs SALES.REBATE.MAINTAIN.</p>
      ) : null}
      <Notice state={state} />
    </form>
  );
}

/** Settle an agreement: the credit memo that gives the money back. */
function SettleAgreement({
  agreementNumber, outstanding, currency, allowed, today,
}: { agreementNumber: string; outstanding: string; currency: string; allowed: boolean; today: string }) {
  const [state, action, pending] = useActionState(settleRebateAgreementAction, EMPTY);
  const id = useId();
  return (
    <form action={action} className="panel space-y-2 p-4" aria-label="Settle a rebate agreement">
      <p className="text-sm font-medium">Settle it</p>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        <label className="block text-xs text-ink-soft" htmlFor={`${id}-date`}>
          Day the credit memo bears
          <input className="input mt-1" id={`${id}-date`} name="settlementDate" type="date" defaultValue={today} />
        </label>
        <label className="block text-xs text-ink-soft" htmlFor={`${id}-amount`}>
          What to pay out
          <input
            className="input mt-1" id={`${id}-amount`} name="amount"
            placeholder={outstanding} autoComplete="off"
          />
        </label>
      </div>
      <p className="text-xs text-ink-faint">
        Leave the amount empty to settle the {outstanding} {currency} that stands, which closes the agreement.
        Name less and the agreement goes on accruing. Settling more than accrued is refused: a promise is not a
        blank cheque.
      </p>
      <input type="hidden" name="agreementNumber" value={agreementNumber} />
      <input type="hidden" name="requestKey" value={`RS-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`} />
      <button type="submit" className="btn btn-primary min-h-11 sm:min-h-9" disabled={pending || !allowed}>
        {pending ? 'Settling…' : 'Settle and raise the credit memo'}
      </button>
      {!allowed ? (
        <p className="text-xs text-ink-faint">Settling gives the company’s money away, and needs SALES.CREDIT.MEMO.POST.</p>
      ) : null}
      <Notice state={state} />
    </form>
  );
}

export default function RebateAgreements({
  agreements, types, register, canMaintain, canSettle, today,
}: Props) {
  return (
    <div className="space-y-4">
      <section className="panel p-4" aria-label="Rebate agreements">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="text-sm font-semibold">Rebate agreements</h2>
          <span className="code text-ink-faint">{agreements.length} standing</span>
        </div>
        <table className="grid-table mt-3 text-sm">
          <thead>
            <tr>
              <th>Agreement</th><th>Customer</th><th>Period</th><th>Priced by</th><th>Status</th>
              <th className="text-right">Accrued</th><th className="text-right">Settled</th>
              <th className="text-right">Standing</th>
            </tr>
          </thead>
          <tbody>
            {agreements.map((agreement) => (
              <tr key={agreement.agreementNumber}>
                <td>
                  <Link className="link" href={`/sales/rebate-agreements?agreement=${agreement.agreementNumber}`}>
                    {agreement.agreementNumber}
                  </Link>
                </td>
                <td>{agreement.customerNumber}</td>
                <td className="code">{agreement.validFrom} → {agreement.validTo}</td>
                <td>{agreement.conditionType}</td>
                <td>{agreement.status.toLowerCase()}</td>
                <td className="text-right">{agreement.accrued}</td>
                <td className="text-right">{agreement.settled}</td>
                <td className="text-right">{agreement.outstanding}</td>
              </tr>
            ))}
            {agreements.length === 0 ? (
              <tr>
                <td colSpan={8} className="text-ink-soft">
                  No rebate agreement stands. Promise one to a customer who buys enough to earn part of it
                  back, and every sale inside the period provides for what it earns on the day it is billed.
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </section>

      {register ? (
        <>
          <section className="panel p-4" aria-label={`Register of agreement ${register.agreement.agreementNumber}`}>
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <h2 className="text-sm font-semibold">
                Agreement {register.agreement.agreementNumber} · {register.agreement.customerNumber}
              </h2>
              <span className="code text-ink-faint">
                {register.agreement.status} · {register.agreement.currency} · provided for{' '}
                {register.agreement.accrued}, paid out {register.agreement.settled}, standing{' '}
                {register.agreement.outstanding}
              </span>
            </div>
            <table className="grid-table mt-3 text-sm">
              <thead>
                <tr>
                  <th>Billing</th><th>Item</th><th>Order</th><th>Material</th>
                  <th className="text-right">Basis</th><th className="text-right">Provided</th>
                  <th className="text-right">Paid out</th><th className="text-right">Standing</th>
                  <th>Status</th><th>Settled by</th>
                </tr>
              </thead>
              <tbody>
                {register.accruals.map((row) => (
                  <tr key={`${row.billingNumber}-${row.lineNumber}`}>
                    <td>
                      <Link className="link" href={`/sales/billing?billing=${row.billingNumber}`}>
                        {row.billingNumber}
                      </Link>
                    </td>
                    <td>{row.lineNumber}</td>
                    <td>{row.orderNumber}</td>
                    <td>{row.materialNumber}</td>
                    <td className="text-right">{row.basisAmount}</td>
                    <td className="text-right">{row.rebateAmount}</td>
                    <td className="text-right">{row.settledAmount}</td>
                    <td className="text-right">{row.outstanding}</td>
                    <td>{row.status.toLowerCase()}</td>
                    <td>
                      {row.settlementNumber
                        ? <Link className="link" href={`/sales/billing?billing=${row.settlementNumber}`}>{row.settlementNumber}</Link>
                        : <span className="text-ink-faint">—</span>}
                    </td>
                  </tr>
                ))}
                {register.accruals.length === 0 ? (
                  <tr>
                    <td colSpan={10} className="text-ink-soft">
                      Nothing has accrued against this agreement yet. Release it, and the sales inside its
                      period for its payer and sales area provide for what they earn as they are billed.
                    </td>
                  </tr>
                ) : null}
              </tbody>
            </table>
            <p className="mt-2 text-sm text-ink-soft">
              The register is read from the accruals and not kept beside them: what was provided for, what a
              cancelled billing document took back, and what has been paid out. A reversed line is one whose
              sale was undone — the provision went with it, and what had already been paid out stands.
            </p>
          </section>

          {register.agreement.status === 'OPEN' ? (
            <ReleaseAgreement agreementNumber={register.agreement.agreementNumber} allowed={canMaintain} />
          ) : null}

          {register.agreement.status === 'RELEASED' ? (
            <SettleAgreement
              agreementNumber={register.agreement.agreementNumber}
              outstanding={register.agreement.outstanding}
              currency={register.agreement.currency}
              allowed={canSettle}
              today={today}
            />
          ) : null}
        </>
      ) : null}

      <MaintainAgreement types={types} register={register} allowed={canMaintain} today={today} />
    </div>
  );
}
