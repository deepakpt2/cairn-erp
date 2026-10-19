'use client';

import { useActionState, useState } from 'react';

import type { AssetActionState } from './actions';
import { createAction } from './actions';

const INITIAL: AssetActionState = { ok: false, message: '' };

interface AreaRow { areaCode: string; depreciationKey: string; usefulLifeYears: string; usefulLifePeriods: string; depreciationStartDate: string }

const inputCls = 'input w-full';
const labelCls = 'mb-1 block text-xs font-medium uppercase tracking-wide text-ink-faint';

export default function AssetCreate({ canCreate, today }: { canCreate: boolean; today: string }) {
  const [state, create, creating] = useActionState(createAction, INITIAL);
  const [tab, setTab] = useState<'general' | 'assignments' | 'depreciation'>('general');
  const [areas, setAreas] = useState<AreaRow[]>([
    { areaCode: '01', depreciationKey: '', usefulLifeYears: '', usefulLifePeriods: '0', depreciationStartDate: '' },
  ]);
  const setArea = (index: number, patch: Partial<AreaRow>) =>
    setAreas((prev) => prev.map((a, i) => (i === index ? { ...a, ...patch } : a)));

  const tabBtn = (id: typeof tab, label: string) => (
    <button type="button" role="tab" aria-selected={tab === id}
      className={`btn min-h-11 sm:min-h-8 ${tab === id ? 'btn-primary' : 'btn-default'}`}
      onClick={() => setTab(id)}>
      {label}
    </button>
  );

  return (
    <section aria-labelledby="ac-form" className="rounded-card border border-line bg-surface p-4 shadow-card">
      <h2 id="ac-form" className="text-sm font-semibold">Create asset</h2>
      <div role="tablist" aria-label="Asset master data" className="mt-3 flex flex-wrap gap-2">
        {tabBtn('general', 'General')}
        {tabBtn('assignments', 'Time-dependent assignments')}
        {tabBtn('depreciation', 'Depreciation areas')}
      </div>

      {state.message && (
        <p role="status" className={`mt-3 text-sm ${state.ok ? 'text-ink' : 'text-red-700'}`}>
          {state.message}{state.remedy ? ` ${state.remedy}` : ''}
        </p>
      )}
      <form action={create} className="mt-4">
        <input type="hidden" name="areas" value={JSON.stringify(areas)} />
        {tab === 'general' && (
          <div role="tabpanel" className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            <label className="block"><span className={labelCls}>Company code</span>
              <input name="companyCode" className={inputCls} placeholder="1000" required /></label>
            <label className="block"><span className={labelCls}>Asset class</span>
              <input name="assetClass" className={inputCls} placeholder="1000" required /></label>
            <label className="block"><span className={labelCls}>Number of similar assets</span>
              <input name="similarCount" className={inputCls} defaultValue="1" /></label>
            <label className="block"><span className={labelCls}>Asset main number (external, when configured)</span>
              <input name="assetNumber" className={inputCls} placeholder="Generated" /></label>
            <label className="block"><span className={labelCls}>Asset sub-number</span>
              <input name="subNumber" className={inputCls} defaultValue="0000" /></label>
            <label className="block"><span className={labelCls}>Description 1</span>
              <input name="description1" className={inputCls} maxLength={50} required /></label>
            <label className="block"><span className={labelCls}>Description 2</span>
              <input name="description2" className={inputCls} maxLength={25} /></label>
            <label className="block"><span className={labelCls}>Inventory number</span>
              <input name="inventoryNumber" className={inputCls} /></label>
            <label className="block"><span className={labelCls}>Serial number</span>
              <input name="serialNumber" className={inputCls} /></label>
            <label className="block"><span className={labelCls}>Quantity</span>
              <input name="quantity" className={inputCls} /></label>
            <label className="block"><span className={labelCls}>Unit of measure</span>
              <input name="unitOfMeasure" className={inputCls} placeholder="EA" /></label>
            <label className="block"><span className={labelCls}>Capitalization date</span>
              <input type="date" name="capitalizationDate" className={inputCls} /></label>
          </div>
        )}

        {tab === 'assignments' && (
          <div role="tabpanel" className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            <label className="block"><span className={labelCls}>Valid from</span>
              <input type="date" name="validFrom" className={inputCls} defaultValue={today} required /></label>
            <label className="block"><span className={labelCls}>Cost centre</span>
              <input name="costCenter" className={inputCls} /></label>
            <label className="block"><span className={labelCls}>Profit centre</span>
              <input name="profitCenter" className={inputCls} /></label>
            <label className="block"><span className={labelCls}>Plant</span>
              <input name="plant" className={inputCls} /></label>
            <label className="block"><span className={labelCls}>Location</span>
              <input name="location" className={inputCls} /></label>
            <p className="text-sm text-ink-soft sm:col-span-2 lg:col-span-3">
              Assignments stand as intervals [valid from, valid to): a later change closes the
              open interval and appends a new one, so history is never rewritten.
            </p>
          </div>
        )}

        {tab === 'depreciation' && (
          <div role="tabpanel" className="space-y-3">
            {areas.map((area, index) => (
              <div key={index} className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
                <label className="block"><span className={labelCls}>Depreciation area</span>
                  <input aria-label="Depreciation area" className={inputCls} value={area.areaCode}
                    onChange={(e) => setArea(index, { areaCode: e.target.value })} /></label>
                <label className="block"><span className={labelCls}>Depreciation key</span>
                  <input aria-label="Depreciation key" className={inputCls} value={area.depreciationKey}
                    onChange={(e) => setArea(index, { depreciationKey: e.target.value })} /></label>
                <label className="block"><span className={labelCls}>Useful life (years)</span>
                  <input aria-label="Useful life years" className={inputCls} value={area.usefulLifeYears}
                    onChange={(e) => setArea(index, { usefulLifeYears: e.target.value })} /></label>
                <label className="block"><span className={labelCls}>Useful life (periods)</span>
                  <input aria-label="Useful life periods" className={inputCls} value={area.usefulLifePeriods}
                    onChange={(e) => setArea(index, { usefulLifePeriods: e.target.value })} /></label>
                <label className="block"><span className={labelCls}>Depreciation start</span>
                  <input type="date" aria-label="Depreciation start" className={inputCls} value={area.depreciationStartDate}
                    onChange={(e) => setArea(index, { depreciationStartDate: e.target.value })} /></label>
              </div>
            ))}
            <button type="button" className="btn btn-default min-h-11 sm:min-h-8"
              onClick={() => setAreas((prev) => [...prev, { areaCode: '', depreciationKey: '', usefulLifeYears: '', usefulLifePeriods: '0', depreciationStartDate: '' }])}>
              Add area
            </button>
            <p className="text-sm text-ink-soft">
              Areas, keys and useful life judge against the tenant's depreciation configuration
              on the server; the class pre-fills its defaults, and nothing here posts or depreciates.
            </p>
          </div>
        )}

        <div className="mt-4">
          <button type="submit" className="btn btn-primary min-h-11 sm:min-h-8"
            disabled={!canCreate || creating}>
            Create asset
          </button>
          {!canCreate && (
            <p className="mt-2 text-sm text-ink-soft">You do not hold the asset creation capability.</p>
          )}
        </div>
      </form>
    </section>
  );
}
