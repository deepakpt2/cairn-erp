'use client';

import { useActionState } from 'react';

import type { AssetView } from '@/modules/finance/asset-master';
import type { AssetActionState } from '../new/actions';
import {
  assignmentAction, changeAction, deactivateAction, depreciationAction,
} from './actions';

const INITIAL: AssetActionState = { ok: false, message: '' };
const inputCls = 'input w-full';
const labelCls = 'mb-1 block text-xs font-medium uppercase tracking-wide text-ink-faint';

function Message({ state }: { state: AssetActionState }) {
  if (!state.message) return null;
  return (
    <p role="status" className={`mt-2 text-sm ${state.ok ? 'text-ink' : 'text-red-700'}`}>
      {state.message}{state.remedy ? ` ${state.remedy}` : ''}
    </p>
  );
}

function KeyFields({ asset }: { asset: AssetView }) {
  return (
    <>
      <input type="hidden" name="companyCode" value={asset.companyCode} />
      <input type="hidden" name="assetNumber" value={asset.assetNumber} />
      <input type="hidden" name="subNumber" value={asset.subNumber} />
      <input type="hidden" name="version" value={asset.version} />
    </>
  );
}

export default function AssetChange({ asset, today }: { asset: AssetView; today: string }) {
  const [changeState, change, changing] = useActionState(changeAction, INITIAL);
  const [assignState, assign, assigning] = useActionState(assignmentAction, INITIAL);
  const [deprState, depr, savingDepr] = useActionState(depreciationAction, INITIAL);
  const [deactState, deactivate, deactivating] = useActionState(deactivateAction, INITIAL);
  const locked = asset.status !== 'ACTIVE';

  return (
    <div className="space-y-4">
      <section aria-labelledby="fa-general" className="rounded-card border border-line bg-surface p-4 shadow-card">
        <h2 id="fa-general" className="text-sm font-semibold">
          Asset {asset.assetNumber}/{asset.subNumber} · Company {asset.companyCode} · Class {asset.assetClass} · {asset.status} · Version {asset.version}
        </h2>
        <Message state={changeState} />
        <form action={change} className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <KeyFields asset={asset} />
          <label className="block"><span className={labelCls}>Description 1</span>
            <input name="description1" className={inputCls} defaultValue={asset.description1} maxLength={50} required disabled={locked} /></label>
          <label className="block"><span className={labelCls}>Description 2</span>
            <input name="description2" className={inputCls} defaultValue={asset.description2 ?? ''} maxLength={25} disabled={locked} /></label>
          <label className="block"><span className={labelCls}>Inventory number</span>
            <input name="inventoryNumber" className={inputCls} defaultValue={asset.inventoryNumber ?? ''} disabled={locked} /></label>
          <label className="block"><span className={labelCls}>Serial number</span>
            <input name="serialNumber" className={inputCls} defaultValue={asset.serialNumber ?? ''} disabled={locked} /></label>
          <label className="block"><span className={labelCls}>Capitalization date</span>
            <input type="date" name="capitalizationDate" className={inputCls} defaultValue={asset.capitalizationDate ?? ''} disabled={locked} /></label>
          <div className="flex items-end">
            <button type="submit" className="btn btn-primary min-h-11 sm:min-h-8" disabled={locked || changing}>Save master data</button>
          </div>
        </form>
        <p className="mt-2 text-sm text-ink-soft">
          Identity, company and asset class never move here; a class change is a reclassification
          workflow, not an edit.
        </p>
      </section>

      <section aria-labelledby="fa-assign" className="rounded-card border border-line bg-surface p-4 shadow-card">
        <h2 id="fa-assign" className="text-sm font-semibold">Time-dependent assignments</h2>
        <ul className="mt-2 space-y-1 text-sm">
          {asset.assignments.map((a) => (
            <li key={a.validFrom}>
              From {a.validFrom} {a.validTo ? `to ${a.validTo}` : 'open'} · Cost centre {a.costCenter ?? '—'} ·
              Profit centre {a.profitCenter ?? '—'} · Plant {a.plant ?? '—'} · Location {a.location ?? '—'}
            </li>
          ))}
        </ul>
        <Message state={assignState} />
        <form action={assign} className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
          <KeyFields asset={asset} />
          <label className="block"><span className={labelCls}>Valid from</span>
            <input type="date" name="validFrom" className={inputCls} defaultValue={today} required disabled={locked} /></label>
          <label className="block"><span className={labelCls}>Cost centre</span>
            <input name="costCenter" className={inputCls} disabled={locked} /></label>
          <label className="block"><span className={labelCls}>Profit centre</span>
            <input name="profitCenter" className={inputCls} disabled={locked} /></label>
          <label className="block"><span className={labelCls}>Plant</span>
            <input name="plant" className={inputCls} disabled={locked} /></label>
          <label className="block"><span className={labelCls}>Location</span>
            <input name="location" className={inputCls} disabled={locked} /></label>
          <div className="flex items-end">
            <button type="submit" className="btn btn-default min-h-11 sm:min-h-8" disabled={locked || assigning}>Append assignment</button>
          </div>
        </form>
      </section>

      <section aria-labelledby="fa-depr" className="rounded-card border border-line bg-surface p-4 shadow-card">
        <h2 id="fa-depr" className="text-sm font-semibold">Depreciation areas</h2>
        <ul className="mt-2 space-y-1 text-sm">
          {asset.depreciation.map((d) => (
            <li key={d.areaCode}>
              Area {d.areaCode} · Key {d.depreciationKey} · Life {d.usefulLifeYears} years {d.usefulLifePeriods} periods ·
              Start {d.depreciationStartDate ?? '—'}
            </li>
          ))}
        </ul>
        <Message state={deprState} />
        <form action={depr} className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
          <KeyFields asset={asset} />
          <label className="block"><span className={labelCls}>Area</span>
            <input name="areaCode" className={inputCls} defaultValue={asset.depreciation[0]?.areaCode ?? '01'} required disabled={locked} /></label>
          <label className="block"><span className={labelCls}>Depreciation key</span>
            <input name="depreciationKey" className={inputCls} defaultValue={asset.depreciation[0]?.depreciationKey ?? ''} required disabled={locked} /></label>
          <label className="block"><span className={labelCls}>Life (years)</span>
            <input name="usefulLifeYears" className={inputCls} defaultValue={asset.depreciation[0]?.usefulLifeYears ?? 0} required disabled={locked} /></label>
          <label className="block"><span className={labelCls}>Life (periods)</span>
            <input name="usefulLifePeriods" className={inputCls} defaultValue={asset.depreciation[0]?.usefulLifePeriods ?? 0} required disabled={locked} /></label>
          <label className="block"><span className={labelCls}>Start date</span>
            <input type="date" name="depreciationStartDate" className={inputCls} defaultValue={asset.depreciation[0]?.depreciationStartDate ?? ''} disabled={locked} /></label>
          <div className="flex items-end">
            <button type="submit" className="btn btn-default min-h-11 sm:min-h-8" disabled={locked || savingDepr}>Save area parameters</button>
          </div>
        </form>
        <p className="mt-2 text-sm text-ink-soft">
          Parameter changes apply prospectively and are audited; no posted depreciation exists to
          recalculate until the depreciation run stands.
        </p>
      </section>

      <section aria-labelledby="fa-deact" className="rounded-card border border-line bg-surface p-4 shadow-card">
        <h2 id="fa-deact" className="text-sm font-semibold">Deactivation</h2>
        <Message state={deactState} />
        <form action={deactivate} className="mt-3 flex flex-wrap items-end gap-3">
          <KeyFields asset={asset} />
          <label className="block"><span className={labelCls}>Deactivation date</span>
            <input type="date" name="deactivationDate" className={inputCls} defaultValue={today} required disabled={locked} /></label>
          <label className="block"><span className={labelCls}>Reason</span>
            <input name="reason" className={inputCls} placeholder="Reason" disabled={locked} /></label>
          <button type="submit" className="btn btn-default min-h-11 sm:min-h-8" disabled={locked || deactivating}>
            Deactivate asset
          </button>
        </form>
        <p className="mt-2 text-sm text-ink-soft">
          Deactivation is a master-data status, never a retirement: no posting follows from it.
        </p>
      </section>
    </div>
  );
}
