'use client';

import Link from 'next/link';
import { useActionState } from 'react';
import { t } from '@/platform/i18n';
import { materialFormValue } from '@/modules/inventory/form-values';
import type { materialChoices } from '@/modules/inventory/materials';
import { type MaterialView, MRP_TYPES, PROCUREMENT_TYPES, LOT_PROCEDURES, PRICE_CONTROLS } from '@/modules/inventory/constants';
import { saveMaterialAction } from './actions';

export function MaterialForm({ view, number, plant, initial, choices, creating }: {
  view: MaterialView; number: string; plant: string;
  initial: Record<string, string | number | boolean | null | undefined>;
  choices: Awaited<ReturnType<typeof materialChoices>>; creating: boolean;
}) {
  const [state, action, pending] = useActionState(saveMaterialAction, { ok: true });
  const value = (name: string, fallback = '') => materialFormValue(initial, name, fallback);
  const currentType = choices.types.find((t) => t.materialType === value('materialType', 'RAW'));
  const decimal = (name: string, label: string, fallback = '0') => <Field label={t(label)}><input name={name} defaultValue={value(name, fallback)} inputMode="decimal" className="field-input tabular" required /></Field>;
  const options = (name: string, label: string, rows: Array<{ key: string; text: string }>, fallback = '', blank = true, immutable = false) => <Field label={t(label)}>
    {immutable ? <input name={name} value={value(name, fallback)} className="field-input code bg-sunken" readOnly /> :
      <select name={name} defaultValue={value(name, fallback)} className="field-input">{blank && <option value="">{t('material.notSet')}</option>}{rows.map((r) => <option key={r.key} value={r.key}>{r.key} · {r.text}</option>)}</select>}
  </Field>;
  const coded = (name: string, label: string, codes: readonly string[], fallback: string) => options(name, label, codes.map((key) => ({ key, text: t(`material.code.${key}`) })), fallback, false);
  const unitOptions = choices.units.map((u) => ({ key: u.code, text: u.name }));

  return <section className="panel p-4" aria-labelledby="material-form-title">
    <h2 id="material-form-title" className="panel-title mb-3">{t(`material.view.${view}`)}</h2>
    {state.message && <div role="status" className={`mb-3 border p-3 text-sm ${state.ok ? 'border-signal-ok/30 bg-signal-ok-soft text-signal-ok' : 'border-signal-error/30 bg-signal-error-soft text-signal-error'}`}>
      <p>{state.message}</p>{state.remedy && <p className="mt-1 text-ink-soft">{state.remedy}</p>}
      {state.ok && state.materialNumber && <Link className="mt-2 inline-block underline" href={`/inventory/materials?material=${encodeURIComponent(state.materialNumber)}&plant=${encodeURIComponent(plant)}&view=${view}`}>{t('material.open')}</Link>}
    </div>}
    {/* Commit a new default snapshot after save; action resets must not restore old select defaults. */}
    <form key={Number(initial.version ?? 0)} action={action} className="space-y-4">
      <input type="hidden" name="view" value={view} />
      <input type="hidden" name="expectedVersion" value={state.version ?? Number(initial.version ?? 0)} />
      {view !== 'BASIC' && <><input type="hidden" name="materialNumber" value={number} /><input type="hidden" name="plant" value={plant} /></>}
      {view === 'BASIC' && <>
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label={t('material.number')}><input name="materialNumber" defaultValue={number} readOnly={!creating} onInput={(e) => { e.currentTarget.value = e.currentTarget.value.toUpperCase(); }} required maxLength={40} pattern="[A-Z0-9][A-Z0-9_.-]*" className="field-input code" /></Field>
          {options('materialType', 'material.type', choices.types.map((r) => ({ key: r.materialType, text: r.name })), 'RAW', false, !creating)}
          {options('materialGroup', 'material.group', choices.groups.map((r) => ({ key: r.materialGroup, text: r.name })), 'GENERAL')}
        </div>
        <Field label={t('material.description')}><input name="description" defaultValue={value('description')} maxLength={200} className="field-input" /></Field>
        <div className="grid gap-3 sm:grid-cols-3">
          {options('baseUnit', 'material.baseUnit', unitOptions)}
          <Field label={t('material.industry')}><input name="industrySector" defaultValue={value('industrySector', 'MANUFACTURING')} maxLength={20} className="field-input" /></Field>
          <Field label={t('material.barcode')}><input name="barcode" defaultValue={value('barcode')} maxLength={32} className="field-input code" /></Field>
          {decimal('grossWeight', 'material.grossWeight')}{decimal('netWeight', 'material.netWeight')}
          {options('weightUnit', 'material.weightUnit', choices.units.filter((u) => u.dimension === 'MASS').map((u) => ({ key: u.code, text: u.name })))}
        </div>
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" name="isBlocked" defaultChecked={initial.isBlocked === true} className="accent-accent" />{t('material.blocked')}</label>
        <p className="text-2xs text-ink-soft">{t('material.stagedNote')}</p>
      </>}
      {view === 'PURCHASING' && <>
        <div className="grid gap-3 sm:grid-cols-3">
          {options('purchasingGroup', 'material.purchasingGroup', choices.purchasingGroups.map((r) => ({ key: r.purchasingGroup, text: r.name })), '001')}
          {options('orderUnit', 'material.orderUnit', unitOptions, value('baseUnit'))}
          <Field label={t('material.manufacturerPart')}><input name="manufacturerPartNumber" defaultValue={value('manufacturerPartNumber')} maxLength={80} className="field-input code" /></Field>
          {decimal('overdeliveryTolerance', 'material.overdelivery')}{decimal('underdeliveryTolerance', 'material.underdelivery')}
        </div><p className="text-2xs text-ink-soft">{t('material.orderUnitNote')}</p>
      </>}
      {view === 'MRP' && <>
        <div className="grid gap-3 sm:grid-cols-3">
          {coded('mrpType', 'material.mrpType', MRP_TYPES, 'REQUIREMENTS')}
          {options('mrpController', 'material.controller', choices.controllers.map((r) => ({ key: r.controller, text: r.name })), '001')}
          {coded('procurementType', 'material.procurement', PROCUREMENT_TYPES, currentType?.defaultProcurementType ?? 'BUY')}
          {coded('lotSizing', 'material.lotSizing', LOT_PROCEDURES, 'EXACT')}
          {decimal('fixedLotSize', 'material.fixedLot')}{decimal('minimumLotSize', 'material.minimumLot')}
          {decimal('maximumLotSize', 'material.maximumLot')}{decimal('safetyStock', 'material.safetyStock')}{decimal('reorderPoint', 'material.reorderPoint')}
          <Field label={t('material.deliveryDays')}><input name="plannedDeliveryDays" type="number" min={0} max={3650} defaultValue={value('plannedDeliveryDays', '0')} required className="field-input tabular" /></Field>
          <Field label={t('material.productionDays')}><input name="inHouseProductionDays" type="number" min={0} max={3650} defaultValue={value('inHouseProductionDays', '0')} required className="field-input tabular" /></Field>
        </div><p className="text-2xs text-ink-soft">{t('material.mrpNote')}</p>
      </>}
      {view === 'ACCOUNTING' && <>
        <div className="grid gap-3 sm:grid-cols-3">
          {options('valuationClass', 'material.valuationClass', choices.valuationClasses.filter((c) => c.allowedMaterialTypes.split(',').includes(value('materialType'))).map((r) => ({ key: r.valuationClass, text: r.name })))}
          {coded('priceControl', 'material.priceControl', PRICE_CONTROLS, currentType?.defaultPriceControl ?? 'STANDARD')}
          {decimal('priceUnit', 'material.priceUnit', '1')}
          {decimal('standardPrice', 'material.standardPrice')}{decimal('movingAveragePrice', 'material.movingPrice')}
          <Field label={t('journal.currency')}><span className="field-input code bg-sunken">{value('currency', '—')}</span></Field>
          <Field label={t('material.stockQuantity')}><span className="field-input tabular bg-sunken">{value('totalStockQuantity', '0.000')}</span></Field>
          <Field label={t('material.stockValue')}><span className="field-input tabular bg-sunken">{value('stockValue', '0.0000')}</span></Field>
        </div><p className="text-2xs text-ink-soft">{t('material.valuationNote')}</p>
      </>}
      <Field label={t('material.reason')}><input name="reason" maxLength={500} className="field-input" /></Field>
      <div className="flex items-center gap-2"><button className="btn btn-primary" disabled={pending}>{pending ? t('common.saving') : t('common.save')}</button><Link href="/inventory/materials" className="btn btn-default">{t('common.cancel')}</Link></div>
    </form>
  </section>;
}
function Field({ label, children }: { label: string; children: React.ReactNode }) { return <label className="block"><span className="field-label">{label}</span>{children}</label>; }
