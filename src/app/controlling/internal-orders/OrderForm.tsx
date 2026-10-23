'use client';

import { useActionState, useState } from 'react';

import type { InternalOrderDocument } from '@/modules/foundation/internal-order';
import { saveInternalOrderAction, type OrderActionState } from './actions';

const INITIAL: OrderActionState = { ok: false };

export default function OrderForm({
  document,
  choices,
}: {
  document: InternalOrderDocument | null;
  choices: {
    types: { orderType: string; description: string }[];
    areas: { controllingArea: string; name: string; currency: string }[];
    companies: { controllingArea: string; companyCode: string }[];
    costCenters: { controllingArea: string; companyCode: string; costCenter: string; name: string }[];
    profitCenters: { controllingArea: string; profitCenter: string; name: string }[];
  };
}) {
  const [state, action, pending] = useActionState(saveInternalOrderAction, INITIAL);
  const [area, setArea] = useState(document?.controllingArea ?? choices.areas[0]?.controllingArea ?? '');
  const [company, setCompany] = useState(document?.companyCode ?? '');
  const [orderType, setOrderType] = useState(document?.orderType ?? choices.types[0]?.orderType ?? '');
  const [description, setDescription] = useState(document?.description ?? '');
  const [startDate, setStartDate] = useState(document?.startDate ?? '2026-04-01');
  const [endDate, setEndDate] = useState(document?.endDate ?? '2027-03-31');
  const [costCenter, setCostCenter] = useState(document?.costCenter ?? '');
  const [profitCenter, setProfitCenter] = useState(document?.profitCenter ?? '');
  const [person, setPerson] = useState(document?.personResponsible ?? '');
  const [user, setUser] = useState(document?.responsibleUser ?? '');
  const [statistical, setStatistical] = useState(document?.statistical ?? false);
  const [locked, setLocked] = useState(document?.isPostingLocked ?? false);
  const [marked, setMarked] = useState(document?.markedForDeletion ?? false);
  const [source, setSource] = useState('');
  const companies = choices.companies.filter((row) => row.controllingArea === area);
  const centers = choices.costCenters.filter((row) => row.controllingArea === area && row.companyCode === company);
  const profits = choices.profitCenters.filter((row) => row.controllingArea === area);
  const currency = choices.areas.find((row) => row.controllingArea === area)?.currency ?? document?.currency ?? '';

  const payload = JSON.stringify({
    orderNumber: document?.orderNumber ?? '',
    orderType,
    description,
    controllingArea: area,
    companyCode: company,
    startDate,
    endDate,
    costCenter,
    profitCenter,
    personResponsible: person,
    responsibleUser: user,
    statistical,
    isPostingLocked: locked,
    markedForDeletion: marked,
    sourceOrderNumber: document ? '' : source,
  });

  return (
    <form action={action} className="space-y-3">
      <input type="hidden" name="payload" value={payload} />
      {state.message && (
        <p className={state.ok ? 'text-sm' : 'text-sm text-red-700'} role={state.ok ? 'status' : 'alert'}>{state.message}</p>
      )}
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="block text-sm">
          <span className="mb-1 block text-ink-soft">Order type</span>
          <select className="input w-full" value={orderType} disabled={Boolean(document)} onChange={(event) => setOrderType(event.target.value)}>
            {choices.types.map((row) => <option key={row.orderType} value={row.orderType}>{row.orderType} · {row.description}</option>)}
          </select>
        </label>
        <label className="block text-sm">
          <span className="mb-1 block text-ink-soft">Description</span>
          <input className="input w-full" value={description} maxLength={40} onChange={(event) => setDescription(event.target.value)} />
        </label>
        <label className="block text-sm">
          <span className="mb-1 block text-ink-soft">Controlling area</span>
          <select className="input w-full" value={area} disabled={Boolean(document)} onChange={(event) => { setArea(event.target.value); setCompany(''); }}>
            {choices.areas.map((row) => <option key={row.controllingArea} value={row.controllingArea}>{row.controllingArea} · {row.name}</option>)}
          </select>
        </label>
        <label className="block text-sm">
          <span className="mb-1 block text-ink-soft">Company code</span>
          <select className="input w-full" value={company} disabled={Boolean(document)} onChange={(event) => setCompany(event.target.value)}>
            <option value="">Select</option>
            {companies.map((row) => <option key={row.companyCode} value={row.companyCode}>{row.companyCode}</option>)}
          </select>
        </label>
        <label className="block text-sm">
          <span className="mb-1 block text-ink-soft">Start date</span>
          <input className="input w-full" type="date" value={startDate} onChange={(event) => setStartDate(event.target.value)} />
        </label>
        <label className="block text-sm">
          <span className="mb-1 block text-ink-soft">End date</span>
          <input className="input w-full" type="date" value={endDate} onChange={(event) => setEndDate(event.target.value)} />
        </label>
        <label className="block text-sm">
          <span className="mb-1 block text-ink-soft">Cost center</span>
          <select className="input w-full" value={costCenter} onChange={(event) => setCostCenter(event.target.value)}>
            <option value="">None</option>
            {centers.map((row) => <option key={row.costCenter} value={row.costCenter}>{row.costCenter} · {row.name}</option>)}
          </select>
        </label>
        <label className="block text-sm">
          <span className="mb-1 block text-ink-soft">Profit center</span>
          <select className="input w-full" value={profitCenter} onChange={(event) => setProfitCenter(event.target.value)}>
            <option value="">None</option>
            {profits.map((row) => <option key={row.profitCenter} value={row.profitCenter}>{row.profitCenter} · {row.name}</option>)}
          </select>
        </label>
        <label className="block text-sm">
          <span className="mb-1 block text-ink-soft">Person responsible</span>
          <input className="input w-full" value={person} maxLength={20} onChange={(event) => setPerson(event.target.value)} />
        </label>
        <label className="block text-sm">
          <span className="mb-1 block text-ink-soft">Responsible user</span>
          <input className="input w-full" value={user} maxLength={40} onChange={(event) => setUser(event.target.value)} />
        </label>
      </div>
      <p className="text-sm text-ink-soft">Currency {currency}. It follows the controlling area. No status profile is configured.</p>
      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" checked={statistical} onChange={(event) => setStatistical(event.target.checked)} />
        Statistical
      </label>
      {document && (
        <>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={locked} onChange={(event) => setLocked(event.target.checked)} />
            Posting lock
          </label>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={marked} onChange={(event) => setMarked(event.target.checked)} />
            Mark for deletion
          </label>
          <p className="text-sm">Journal lines citing this order: {document.journalCount}. Saving does not post or rewrite them.</p>
        </>
      )}
      {!document && (
        <label className="block text-sm">
          <span className="mb-1 block text-ink-soft">Reference order, optional</span>
          <input className="input" value={source} maxLength={20} onChange={(event) => setSource(event.target.value)} />
        </label>
      )}
      <button className="btn btn-primary min-h-11 sm:min-h-8" type="submit" disabled={pending || marked && Boolean(document) && document?.markedForDeletion}>
        {pending ? 'Saving' : document ? 'Save change' : 'Create order'}
      </button>
    </form>
  );
}
