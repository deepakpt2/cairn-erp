import Link from 'next/link';
import { t } from '@/platform/i18n';
import { requireSession, can } from '@/platform/auth/current';
import { listNumberRanges, rangeKey, rangeAllocations, NUMBER_OBJECTS, NUMBER_RANGE_ACTIVITY } from '@/modules/foundation/number-ranges';
import { withTenant } from '@/platform/db/client';
import { changeHistory } from '@/platform/change';
import { formatNumber } from '@/platform/numbering';
import { RangeForm } from './RangeForm';

export const dynamic = 'force-dynamic';

export default async function NumberRangesPage({ searchParams }: {
  searchParams: Promise<{ edit?: string; history?: string; object?: string; new?: string }>;
}) {
  const session = await requireSession('/config/number-ranges');
  const client = session.user.client;
  const params = await searchParams;
  const { ranges, companies, types, readiness } = await listNumberRanges(client);
  const editable = can(session, NUMBER_RANGE_ACTIVITY);
  const selected = ranges.find((r) => rangeKey(r) === params.edit);
  const historical = ranges.find((r) => rangeKey(r) === params.history);
  const changes = historical ? await withTenant(client, (tx) => changeHistory(tx, client, 'number_range', rangeKey(historical))) : [];
  const allocations = historical ? await rangeAllocations(client, historical) : [];
  const shown = params.object ? ranges.filter((r) => r.objectCode === params.object) : ranges;
  const legacy = selected?.objectCode === 'JOURNAL_ENTRY' && selected.companyCode === '*';

  return <div className="mx-auto max-w-6xl space-y-4 p-6">
    <header className="border-b border-line pb-4">
      <span className="code text-ink-faint">{NUMBER_RANGE_ACTIVITY}</span>
      <div className="mt-0.5 flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-xl font-semibold tracking-tight">{t('nr.title')}</h1>
        <div className="flex gap-2"><Link href="/config" className="btn btn-default">{t('nav.workbench')}</Link>{editable && <Link href="/config/number-ranges?new=1" className="btn btn-primary">{t('nr.create')}</Link>}</div>
      </div>
      <p className="mt-1 max-w-3xl text-sm text-ink-soft">{t('nr.subtitle')}</p>
    </header>

    <section className={`border p-3 ${readiness.ready ? 'border-signal-ok/30 bg-signal-ok-soft' : 'border-signal-warn/30 bg-signal-warn-soft'}`}>
      <div className="flex flex-wrap items-center justify-between gap-2"><h2 className={`text-sm font-semibold ${readiness.ready ? 'text-signal-ok' : 'text-signal-warn'}`}>{t(readiness.ready ? 'nr.ready' : 'nr.setupRequired')}</h2><span className="code text-ink-soft">{readiness.fiscalYear}</span></div>
      {readiness.missing.map((m) => <p key={`${m.companyCode}/${m.subObject}`} className="mt-1 text-sm"><span className="code">{m.companyCode} / {m.subObject}</span> · {t(`nr.state.${m.state}`)}</p>)}
      <p className="mt-2 text-2xs text-ink-soft">{t('nr.assignments')}: {types.filter((type) => type.numberRangeObject === 'JOURNAL_ENTRY').map((type) => `${type.documentType} → ${type.numberRangeSubObject}`).join(' · ')}</p>
      {readiness.ready && <Link href="/finance/journal/new" className="mt-2 inline-block text-sm text-accent underline">{t('journal.postTitle')}</Link>}
    </section>

    {(params.new === '1' || selected) && editable && !legacy && <RangeForm key={selected ? rangeKey(selected) : 'new'}
      initial={selected ?? { objectCode: 'JOURNAL_ENTRY', companyCode: companies[0]?.companyCode ?? '', subObject: 'GENERAL', fiscalYear: 0, prefix: 'JE', fromNumber: 1, toNumber: 999999, currentNumber: 0, numberLength: 6, displayStyle: 'READABLE', status: 'ACTIVE' }}
      companies={companies.filter((c) => c.isActive).map(({ companyCode, name }) => ({ companyCode, name }))} objects={NUMBER_OBJECTS} editing={!!selected} />}
    {!editable && <p className="text-sm text-ink-soft">{t('auth.readOnly', { authority: NUMBER_RANGE_ACTIVITY })}</p>}

    <form className="flex flex-wrap items-end gap-2" method="get"><label><span className="field-label">{t('nr.object')}</span><select className="field-input code" name="object" defaultValue={params.object ?? ''}><option value="">{t('common.all')}</option>{NUMBER_OBJECTS.map((o) => <option key={o} value={o}>{o}</option>)}</select></label><button className="btn btn-default">{t('common.filter')}</button></form>
    <section className="panel overflow-x-auto">
      <table className="grid-table"><thead><tr>
        {['nr.object', 'nr.scope', 'nr.subObject', 'nr.year', 'nr.interval', 'nr.current', 'nr.remaining', 'nr.preview', 'nr.status', 'common.actions'].map((key) => <th key={key}>{t(key)}</th>)}
      </tr></thead><tbody>
        {shown.map((r) => <tr key={rangeKey(r)}>
          <td className="code">{r.objectCode}</td><td className="code">{r.companyCode === '*' ? t('nr.tenantWide') : r.companyCode}</td><td className="code">{r.subObject}</td><td className="tabular">{r.fiscalYear || t('nr.allYears')}</td>
          <td className="tabular whitespace-nowrap">{r.fromNumber}–{r.toNumber}</td><td className="tabular">{r.currentNumber < r.fromNumber ? '—' : r.currentNumber}</td><td className="tabular">{r.toNumber - r.currentNumber}</td>
          <td className="code whitespace-nowrap">{r.currentNumber >= r.toNumber ? '—' : formatNumber({ value: r.currentNumber + 1, prefix: r.prefix, length: r.numberLength, style: r.displayStyle, fiscalYear: r.fiscalYear || readiness.fiscalYear })}</td>
          <td><span className={`chip ${r.status !== 'ACTIVE' ? 'chip-warn' : r.currentNumber >= r.toNumber ? 'chip-error' : 'chip-ok'}`}>{r.status !== 'ACTIVE' ? t('nr.blocked') : r.currentNumber >= r.toNumber ? t('nr.state.EXHAUSTED') : t('nr.active')}</span></td>
          <td className="whitespace-nowrap text-end">{editable && !(r.objectCode === 'JOURNAL_ENTRY' && r.companyCode === '*') && <Link href={`/config/number-ranges?edit=${encodeURIComponent(rangeKey(r))}`} className="me-3 text-accent underline">{t('common.change')}</Link>}<Link href={`/config/number-ranges?history=${encodeURIComponent(rangeKey(r))}`} className="text-accent underline">{t('nr.history')}</Link></td>
        </tr>)}
        {!shown.length && <tr><td colSpan={10} className="text-ink-soft">{t('nr.empty')}</td></tr>}
      </tbody></table>
    </section>
    <p className="text-2xs text-ink-soft">{t('nr.monitorNote')}</p>

    {historical && <section className="panel overflow-x-auto"><div className="panel-header"><h2 className="panel-title">{t('nr.history')} · <span className="code">{rangeKey(historical)}</span></h2></div>
      {changes.map((c) => <div key={c.id} className="border-b border-line p-3 text-sm"><p className="font-medium">{c.changedAt.toISOString()} · {c.changedBy} · {c.changeType}</p><p className="text-ink-soft">{c.reason}</p><ul className="mt-1 text-2xs text-ink-soft">{c.items.map((i) => <li key={i.id}>{i.fieldLabel}: {i.oldValue ?? '—'} → {i.newValue ?? '—'}{i.isSecurityRelevant === 'true' ? ` · ${t('nr.controlChange')}` : ''}</li>)}</ul></div>)}
      {!changes.length && <p className="p-3 text-sm text-ink-soft">{t('nr.noChanges')}</p>}
      <div className="panel-header"><h3 className="panel-title">{t('nr.allocations')}</h3></div>
      <table className="grid-table"><thead><tr>{['nr.number', 'nr.year', 'nr.document', 'nr.by', 'nr.at'].map((k) => <th key={k}>{t(k)}</th>)}</tr></thead><tbody>{allocations.map((a) => <tr key={a.id}><td className="code">{a.displayedNumber}</td><td className="tabular">{a.fiscalYear || '—'}</td><td className="code">{a.documentId && a.objectCode === 'JOURNAL_ENTRY' ? <Link className="text-accent underline" href={`/finance/journal?document=${encodeURIComponent(a.documentId)}`}>{a.documentId}</Link> : a.documentId ?? '—'}</td><td>{a.allocatedBy}</td><td className="tabular">{a.allocatedAt.toISOString()}</td></tr>)}</tbody></table>
      {!allocations.length && <p className="p-3 text-sm text-ink-soft">{t('nr.noAllocations')}</p>}
    </section>}
  </div>;
}
