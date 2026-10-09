import Link from 'next/link';
import { t } from '@/platform/i18n';
import { requireSession, can } from '@/platform/auth/current';
import { listMaterials, materialChoices, getMaterialDetail } from '@/modules/inventory/materials';
import { MATERIAL_VIEWS, MATERIAL_VIEW_CAPABILITY } from '@/modules/inventory/constants';
import { withTenant } from '@/platform/db/client';
import { changeHistory } from '@/platform/change';
import { MaterialForm } from './MaterialForm';

export const dynamic = 'force-dynamic';

export default async function MaterialsPage({ searchParams }: {
  searchParams: Promise<{ material?: string; view?: string; plant?: string; q?: string; new?: string; copy?: string; history?: string }>;
}) {
  const session = await requireSession('/inventory/materials');
  const client = session.user.client;
  const params = await searchParams;
  const choices = await materialChoices(client);
  const creating = params.new === '1';
  const detail = params.material ? await getMaterialDetail(client, params.material) : null;
  const source = creating && params.copy ? await getMaterialDetail(client, params.copy) : null;
  const rows = !detail && !creating ? await listMaterials(client, params.q ?? '') : [];
  const view = creating ? 'BASIC' : MATERIAL_VIEWS.find((v) => v === params.view) ?? 'BASIC';
  const site = choices.plants.find((p) => p.plant === params.plant) ?? choices.plants[0];
  const plant = site?.plant ?? '';
  const org = detail?.plants.find((p) => p.plant === plant);
  const valuation = detail?.valuations.find((v) => v.valuationArea === plant);
  const company = choices.companies.find((c) => c.companyCode === site?.companyCode);
  const editable = can(session, MATERIAL_VIEW_CAPABILITY[view]);
  const valuationReadable = can(session, 'FIN.MATERIAL.VALUATION.DISPLAY') || can(session, MATERIAL_VIEW_CAPABILITY.ACCOUNTING) || can(session, 'AUDIT.WORKSPACE');
  const nonValuated = view === 'ACCOUNTING' && choices.types.find((t) => t.materialType === detail?.base.materialType)?.isValuated === false;
  const base = detail?.base ?? source?.base;
  const record = view === 'BASIC' ? detail?.base : view === 'ACCOUNTING' ? valuation : org;
  // Pass only editable/view-context primitives, not technical timestamps/tenant keys.
  const initial: Record<string, string | number | boolean | null | undefined> = {};
  for (const [key, value] of Object.entries(record ?? (creating ? source?.base ?? {} : {}))) {
    if (value === null || ['string', 'number', 'boolean'].includes(typeof value)) initial[key] = value as string | number | boolean | null;
  }
  initial.materialType = base?.materialType ?? 'RAW'; initial.baseUnit = base?.baseUnit ?? null;
  initial.currency = valuation?.currency ?? company?.currency;
  if (creating) { initial.version = 0; initial.isBlocked = false; }
  const url = (nextView: string) => `/inventory/materials?material=${encodeURIComponent(detail?.base.materialNumber ?? '')}&plant=${encodeURIComponent(plant)}&view=${nextView}`;
  const statuses: Record<string, string> = { BASIC: detail?.base.basicStatus ?? 'NOT_CREATED', PURCHASING: org?.purchasingStatus ?? 'NOT_CREATED', MRP: org?.mrpStatus ?? 'NOT_CREATED', ACCOUNTING: valuation?.accountingStatus ?? 'NOT_CREATED' };
  const history = detail && params.history === '1' ? await withTenant(client, async (tx) => [
    ...await changeHistory(tx, client, 'material', detail.base.materialNumber),
    ...await changeHistory(tx, client, 'material_plant', `${detail.base.materialNumber}/${plant}`),
    ...(valuationReadable ? await changeHistory(tx, client, 'material_valuation', `${detail.base.materialNumber}/${plant}`) : []),
  ]) : [];

  return <div className="mx-auto max-w-6xl space-y-4 p-6">
    <header className="border-b border-line pb-4"><span className="code text-ink-faint">INV.MATERIAL.MAINTAIN</span>
      <div className="mt-0.5 flex flex-wrap items-center justify-between gap-3"><h1 className="text-xl font-semibold tracking-tight">{t(creating ? 'material.create' : 'material.title')}</h1>
        <div className="flex gap-2"><Link href="/config" className="btn btn-default">{t('nav.workbench')}</Link><Link href="/inventory/materials" className="btn btn-default">{t('material.list')}</Link>{can(session, MATERIAL_VIEW_CAPABILITY.BASIC) && !creating && <Link href="/inventory/materials?new=1" className="btn btn-primary">{t('material.create')}</Link>}</div>
      </div><p className="mt-1 max-w-3xl text-sm text-ink-soft">{t('material.subtitle')}</p>
    </header>
    {params.material && !detail && <div className="border border-signal-error/30 bg-signal-error-soft p-3 text-sm text-signal-error">{t('material.notFound', { number: params.material })}</div>}
    {source && <p className="border border-accent-line bg-accent-soft p-3 text-sm">{t('material.copyNote', { number: source.base.materialNumber })}</p>}
    {detail && <>
      <section className="panel grid gap-3 p-3 sm:grid-cols-4"><Summary label={t('material.number')} value={detail.base.materialNumber} /><Summary label={t('material.description')} value={detail.base.description || '—'} /><Summary label={t('material.type')} value={`${detail.base.materialType} / ${detail.base.baseUnit ?? '—'}`} /><Summary label={t('material.status')} value={t(`material.state.${detail.base.isBlocked ? 'BLOCKED' : detail.base.basicStatus}`)} /></section>
      <div className="flex flex-wrap items-end justify-between gap-3"><form method="get" className="flex items-end gap-2"><input type="hidden" name="material" value={detail.base.materialNumber} /><input type="hidden" name="view" value={view} /><label><span className="field-label">{t('plant.code')}</span><select name="plant" defaultValue={plant} className="field-input code">{choices.plants.map((p) => <option key={p.plant} value={p.plant}>{p.plant} · {p.name}</option>)}</select></label><button className="btn btn-default">{t('material.choosePlant')}</button></form><Link href={`${url(view)}&history=1`} className="text-sm text-accent underline">{t('material.history')}</Link></div>
      <nav aria-label={t('material.views')} className="flex flex-wrap gap-1 border-b border-line pb-3">{MATERIAL_VIEWS.map((v) => <Link key={v} href={url(v)} className={`border px-3 py-2 text-sm ${v === view ? 'border-accent bg-accent-soft text-accent' : 'border-line bg-paper text-ink-soft'}`}>{t(`material.view.${v}`)}<span className="ms-2 text-2xs">{t(`material.state.${statuses[v]}`)}</span></Link>)}{['PRODUCTION', 'SALES', 'SALES_GENERAL', 'STORAGE', 'FORECASTING', 'QUALITY', 'WAREHOUSE'].map((v) => <span key={v} aria-disabled="true" className="border border-dashed border-line px-3 py-2 text-sm text-ink-faint">{t(`material.view.${v}`)} · {t('material.pending')}</span>)}</nav>
    </>}
    {detail && view === 'ACCOUNTING' && !valuationReadable && <p className="panel p-4 text-sm text-ink-soft">{t('auth.missingAuthority', { authority: 'FIN.MATERIAL.VALUATION.DISPLAY' })}</p>}
    {detail && nonValuated && <p className="panel p-4 text-sm text-ink-soft">{t('material.nonValuated')}</p>}
    {(creating || detail) && (view === 'BASIC' || site) && (view !== 'ACCOUNTING' || valuationReadable) && !nonValuated && (editable
      ? <MaterialForm key={`${detail?.base.materialNumber ?? 'new'}/${plant}/${view}/${params.copy ?? ''}`} view={view} number={creating ? '' : detail!.base.materialNumber} plant={plant} initial={initial} choices={choices} creating={creating} />
      : <section className="panel p-4"><p className="text-sm text-ink-soft">{t('auth.readOnly', { authority: MATERIAL_VIEW_CAPABILITY[view] })}</p><dl className="mt-3 grid gap-2 text-sm sm:grid-cols-3">{Object.entries(initial).filter(([k]) => !['client','version','createdBy','changedBy'].includes(k)).map(([k, v]) => <div key={k}><dt className="text-2xs uppercase text-ink-faint">{k}</dt><dd className="code">{String(v ?? '—')}</dd></div>)}</dl></section>)}
    {detail && view !== 'BASIC' && !site && <p className="panel p-4 text-sm">{t('material.noPlant')}</p>}
    {!detail && !creating && <>
      <form method="get" className="flex items-end gap-2"><input type="hidden" name="view" value={view} /><label className="w-80"><span className="field-label">{t('material.search')}</span><input name="q" defaultValue={params.q} className="field-input" /></label><button className="btn btn-default">{t('registry.search')}</button></form>
      <section className="panel overflow-x-auto"><table className="grid-table"><thead><tr>{['material.number', 'material.description', 'material.type', 'material.group', 'material.baseUnit', 'material.status', 'common.actions'].map((key) => <th key={key}>{t(key)}</th>)}</tr></thead><tbody>{rows.map((m) => <tr key={m.materialNumber}><td><Link className="code text-accent underline" href={`/inventory/materials?material=${encodeURIComponent(m.materialNumber)}&view=${view}`}>{m.materialNumber}</Link></td><td>{m.description || '—'}</td><td className="code">{m.materialType}</td><td className="code">{m.materialGroup ?? '—'}</td><td className="code">{m.baseUnit ?? '—'}</td><td><span className={`chip ${m.isBlocked ? 'chip-error' : m.basicStatus === 'INCOMPLETE' ? 'chip-warn' : 'chip-ok'}`}>{t(`material.state.${m.isBlocked ? 'BLOCKED' : m.basicStatus}`)}</span></td><td>{can(session, MATERIAL_VIEW_CAPABILITY.BASIC) && <Link className="text-accent underline" href={`/inventory/materials?new=1&copy=${encodeURIComponent(m.materialNumber)}`}>{t('material.copy')}</Link>}</td></tr>)}</tbody></table>{!rows.length && <p className="p-5 text-sm text-ink-soft">{t('material.empty')}</p>}<p className="border-t border-line p-2 text-2xs text-ink-faint">{t('material.listLimit')}</p></section>
    </>}
    {params.history === '1' && detail && <section className="panel"><div className="panel-header"><h2 className="panel-title">{t('material.history')}</h2></div>{history.sort((a,b) => b.changedAt.getTime()-a.changedAt.getTime()).map((d) => <article key={d.id} className="border-b border-line p-3 text-sm"><p className="font-medium">{d.changedAt.toISOString()} · {d.changedBy} · <span className="code">{d.objectClass}</span> · {d.changeType}</p>{d.reason && <p className="text-ink-soft">{d.reason}</p>}<ul className="mt-1 text-2xs text-ink-soft">{d.items.map((i) => <li key={i.id}>{i.fieldLabel}: {i.oldValue ?? '—'} → {i.newValue ?? '—'}{i.isSecurityRelevant === 'true' ? ` · ${t('nr.controlChange')}` : ''}</li>)}</ul></article>)}</section>}
  </div>;
}
function Summary({ label, value }: { label: string; value: string }) { return <div><p className="text-2xs uppercase tracking-wide text-ink-faint">{label}</p><p className="mt-1 font-medium">{value}</p></div>; }
