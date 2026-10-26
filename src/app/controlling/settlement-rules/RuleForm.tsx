'use client';

import { useActionState, useState } from 'react';

import Link from 'next/link';

import { saveSettlementRuleAction, type SettlementRuleActionState } from './actions';
import type { SettlementConfigurationView } from '@/modules/foundation/settlement-configuration';

const INITIAL: SettlementRuleActionState = { ok: false };

/**
 * The rule of one order: a receiver, a share, and the period it is valid over. What the order settles
 * against — its profile, its document type, the allocation structure and its account assignments — is
 * read here and edited at `/config/settlement-configuration`, because those rows belong to the order
 * type and to every other order of it.
 */
export default function RuleForm({
  orderNumber,
  stored,
}: {
  orderNumber: string;
  stored: SettlementConfigurationView | null;
}) {
  const [state, action, pending] = useActionState(saveSettlementRuleAction, INITIAL);
  const [order, setOrder] = useState(orderNumber);
  const [receiverCategory, setReceiverCategory] = useState('COST_CENTER');
  const [receiver, setReceiver] = useState('');
  const [method, setMethod] = useState('PERCENT');
  const [share, setShare] = useState('');
  const [settlementType, setSettlementType] = useState('PER');
  const [validFromYear, setValidFromYear] = useState('2026');
  const [validFromPeriod, setValidFromPeriod] = useState('1');
  const [validToYear, setValidToYear] = useState('2026');
  const [validToPeriod, setValidToPeriod] = useState('12');
  const payload = JSON.stringify({
    orderNumber: order,
    receiverCategory,
    receiver,
    method,
    share,
    settlementType,
    validFromYear: Number(validFromYear),
    validFromPeriod: Number(validFromPeriod),
    validToYear: Number(validToYear),
    validToPeriod: Number(validToPeriod),
  });
  const profile = stored?.settlementProfile ?? null;
  const allowed = profile
    ? method === 'PERCENT' ? profile.percentageAllowed : method === 'EQUIVALENCE' ? profile.equivalenceAllowed : profile.amountAllowed
    : true;

  return (
    <form action={action} className="space-y-3">
      <input type="hidden" name="payload" value={payload} />
      {state.message && (
        <p className={state.ok ? 'text-sm' : 'text-sm text-red-700'} role={state.ok ? 'status' : 'alert'}>{state.message}</p>
      )}

      <section className="border border-line p-3 text-sm" aria-label="Settlement configuration this order reads">
        {stored ? (
          <>
            <p className="text-ink-soft">
              Order type {stored.orderType}. {' '}
              {profile ? (
                <>Profile <span className="code">{profile.profileCode}</span> · document type <span className="code">{profile.documentType}</span> · allocation structure <span className="code">{profile.allocationStructure}</span>{profile.isActive ? '' : ' · inactive'}</>
              ) : (
                <>Order type {stored.orderType} reads no settlement profile, so a rule cannot be stored yet.</>
              )}
            </p>
            {stored.rules.length > 0 && (
              <ul className="mt-2 space-y-1">
                {stored.rules.map((rule) => (
                  <li key={rule.ruleNumber}>
                    Rule {rule.ruleNumber}: <span className="code">{rule.receiver}</span> ({rule.receiverCategory}) ·{' '}
                    {rule.percentage ? `${rule.percentage}%` : rule.equivalence ? `equivalence ${rule.equivalence}` : `amount ${rule.amount}`}
                    {' '}· {rule.settlementType === 'PER' ? 'periodic' : 'full'}
                  </li>
                ))}
              </ul>
            )}
            <p className="mt-2 text-ink-soft">
              These rows are shared by every order of the type. Change them at{' '}
              <Link href="/config/settlement-configuration" className="underline">Settlement configuration</Link>, not here.
            </p>
          </>
        ) : (
          <p className="text-ink-soft">
            Enter an order number to see the profile its order type reads and the rule it already stores.
          </p>
        )}
      </section>

      <div className="grid gap-3 sm:grid-cols-2">
        <label className="block text-sm sm:col-span-2">
          <span className="mb-1 block text-ink-soft">Internal order</span>
          <input className="input w-full" value={order} maxLength={20} onChange={(event) => setOrder(event.target.value)} />
        </label>
        <label className="block text-sm">
          <span className="mb-1 block text-ink-soft">Receiver category</span>
          <select className="input w-full" value={receiverCategory} onChange={(event) => setReceiverCategory(event.target.value)}>
            <option value="COST_CENTER">Cost center</option>
            <option value="INTERNAL_ORDER">Internal order</option>
            <option value="GL_ACCOUNT">G/L account</option>
          </select>
        </label>
        <label className="block text-sm">
          <span className="mb-1 block text-ink-soft">Receiver</span>
          <input className="input w-full" value={receiver} maxLength={20} onChange={(event) => setReceiver(event.target.value)} />
        </label>
        <label className="block text-sm">
          <span className="mb-1 block text-ink-soft">Distribution</span>
          <select className="input w-full" value={method} onChange={(event) => setMethod(event.target.value)}>
            <option value="PERCENT">Percentage</option>
            <option value="EQUIVALENCE">Equivalence number</option>
            <option value="AMOUNT">Amount</option>
          </select>
        </label>
        <label className="block text-sm">
          <span className="mb-1 block text-ink-soft">Share</span>
          <input className="input w-full" value={share} onChange={(event) => setShare(event.target.value)} />
        </label>
        <label className="block text-sm">
          <span className="mb-1 block text-ink-soft">Settlement type</span>
          <select className="input w-full" value={settlementType} onChange={(event) => setSettlementType(event.target.value)}>
            <option value="PER">Periodic</option>
            <option value="FUL">Full</option>
          </select>
        </label>
        <label className="block text-sm">
          <span className="mb-1 block text-ink-soft">Valid from year</span>
          <input className="input w-full" value={validFromYear} onChange={(event) => setValidFromYear(event.target.value)} />
        </label>
        <label className="block text-sm">
          <span className="mb-1 block text-ink-soft">Valid from period</span>
          <input className="input w-full" value={validFromPeriod} onChange={(event) => setValidFromPeriod(event.target.value)} />
        </label>
        <label className="block text-sm">
          <span className="mb-1 block text-ink-soft">Valid to year</span>
          <input className="input w-full" value={validToYear} onChange={(event) => setValidToYear(event.target.value)} />
        </label>
        <label className="block text-sm">
          <span className="mb-1 block text-ink-soft">Valid to period</span>
          <input className="input w-full" value={validToPeriod} onChange={(event) => setValidToPeriod(event.target.value)} />
        </label>
      </div>
      {profile && !allowed && (
        <p className="text-sm text-red-700" role="status">
          Profile {profile.profileCode} does not allow distribution by this method, so the rule will be refused until the profile allows it.
        </p>
      )}
      <p className="text-sm text-ink-soft">Saving does not post. A percentage is not filled in. KO88 is a different screen.</p>
      <button className="btn btn-primary min-h-11 sm:min-h-8" type="submit" disabled={pending}>
        {pending ? 'Saving' : 'Store rule'}
      </button>
    </form>
  );
}
