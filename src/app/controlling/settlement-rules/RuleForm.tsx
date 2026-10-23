'use client';

import { useActionState, useState } from 'react';

import { saveSettlementRuleAction, type SettlementRuleActionState } from './actions';

const INITIAL: SettlementRuleActionState = { ok: false };

export default function RuleForm({
  documentTypes,
  orderNumber,
  stored,
}: {
  documentTypes: { documentType: string; name: string }[];
  orderNumber: string;
  stored: {
    orderType: string;
    profileCode: string | null;
    documentType: string | null;
    rules: Array<{ receiver: string; percentage: string | null; settlementType: string }>;
  } | null;
}) {
  const [state, action, pending] = useActionState(saveSettlementRuleAction, INITIAL);
  const [order, setOrder] = useState(orderNumber);
  const [profileCode, setProfileCode] = useState('');
  const [profileDescription, setProfileDescription] = useState('');
  const [documentType, setDocumentType] = useState('');
  const [structureCode, setStructureCode] = useState('');
  const [structureDescription, setStructureDescription] = useState('');
  const [sourceAccount, setSourceAccount] = useState('');
  const [byOriginalAccount, setByOriginalAccount] = useState(true);
  const [settlementAccount, setSettlementAccount] = useState('');
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
    profileCode,
    profileDescription,
    documentType,
    structureCode,
    structureDescription,
    sourceAccount,
    byOriginalAccount,
    settlementAccount,
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

  return (
    <form action={action} className="space-y-3">
      <input type="hidden" name="payload" value={payload} />
      {state.message && (
        <p className={state.ok ? 'text-sm' : 'text-sm text-red-700'} role={state.ok ? 'status' : 'alert'}>{state.message}</p>
      )}
      {stored && (
        <p className="text-sm">
          Order type {stored.orderType}. Stored profile {stored.profileCode ?? 'none'}. Stored document type {stored.documentType ?? 'none'}.
        </p>
      )}
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="block text-sm sm:col-span-2">
          <span className="mb-1 block text-ink-soft">Internal order</span>
          <input className="input w-full" value={order} maxLength={20} onChange={(event) => setOrder(event.target.value)} />
        </label>
        <label className="block text-sm">
          <span className="mb-1 block text-ink-soft">Profile</span>
          <input className="input w-full" value={profileCode} maxLength={6} onChange={(event) => setProfileCode(event.target.value)} />
        </label>
        <label className="block text-sm">
          <span className="mb-1 block text-ink-soft">Profile description</span>
          <input className="input w-full" value={profileDescription} maxLength={40} onChange={(event) => setProfileDescription(event.target.value)} />
        </label>
        <label className="block text-sm">
          <span className="mb-1 block text-ink-soft">Document type</span>
          <select className="input w-full" value={documentType} onChange={(event) => setDocumentType(event.target.value)}>
            <option value="">Choose a document type</option>
            {documentTypes.map((row) => (
              <option key={row.documentType} value={row.documentType}>{row.documentType} · {row.name}</option>
            ))}
          </select>
        </label>
        <label className="block text-sm">
          <span className="mb-1 block text-ink-soft">Allocation structure</span>
          <input className="input w-full" value={structureCode} maxLength={6} onChange={(event) => setStructureCode(event.target.value)} />
        </label>
        <label className="block text-sm sm:col-span-2">
          <span className="mb-1 block text-ink-soft">Allocation description</span>
          <input className="input w-full" value={structureDescription} maxLength={40} onChange={(event) => setStructureDescription(event.target.value)} />
        </label>
        <label className="block text-sm">
          <span className="mb-1 block text-ink-soft">Source account</span>
          <input className="input w-full" value={sourceAccount} maxLength={10} onChange={(event) => setSourceAccount(event.target.value)} />
        </label>
        <label className="block text-sm">
          <span className="mb-1 block text-ink-soft">Settlement account, if not the original</span>
          <input className="input w-full" value={settlementAccount} maxLength={10} disabled={byOriginalAccount} onChange={(event) => setSettlementAccount(event.target.value)} />
        </label>
        <label className="flex min-h-11 items-center gap-2 text-sm sm:col-span-2">
          <input type="checkbox" checked={byOriginalAccount} onChange={(event) => setByOriginalAccount(event.target.checked)} />
          Settle by the original account
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
      <p className="text-sm text-ink-soft">Saving does not post. A percentage is not filled in. KO88 is a different screen.</p>
      <button className="btn btn-primary min-h-11 sm:min-h-8" type="submit" disabled={pending}>
        {pending ? 'Saving' : 'Store rule'}
      </button>
    </form>
  );
}
