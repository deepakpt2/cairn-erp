import Link from 'next/link';
import { asc } from 'drizzle-orm';
import { requireSession, can } from '@/platform/auth/current';
import { displayOnlyMessage, openChangeForSession } from '@/platform/lock/enqueue';
import { t } from '@/platform/i18n';
import { ChangeLock, LockNotice } from '@/ui/lock/ChangeLock';
import { listPaymentMethods, getPaymentMethod } from '@/modules/foundation/payment-methods';
import { withTenant } from '@/platform/db/client';
import { country } from '@/platform/tables/reference';
import { changeHistory } from '@/platform/change';
import { PaymentMethodForm } from './PaymentMethodForm';
import { RetirePaymentMethodForm } from './RetirePaymentMethodForm';

export const dynamic = 'force-dynamic';

const PAYMENT_METHOD_ACTIVITY = 'CFG.FIN.PAYMENTMETHOD.DEFINE';

export default async function PaymentMethodsPage({ searchParams }: {
  searchParams: Promise<{ country?: string; code?: string; q?: string; history?: string; new?: string; edit?: string }>;
}) {
  const session = await requireSession('/config/payment-methods');
  const client = session.user.client;
  const editable = can(session, PAYMENT_METHOD_ACTIVITY);
  const params = await searchParams;
  const countries = await withTenant(client, (tx) =>
    tx.select({ code: country.code, name: country.name }).from(country).orderBy(asc(country.code)),
  );
  const selectedCountry = countries.some((item) => item.code === params.country) ? params.country! : '';
  const requestedCode = params.code?.trim().toUpperCase() ?? '';
  const validCode = /^[A-Z0-9]{1,2}$/.test(requestedCode);
  const detail = selectedCountry && validCode
    ? await getPaymentMethod(client, selectedCountry, requestedCode)
    : null;
  const creating = params.new === '1' && !!selectedCountry && editable;
  const editing = params.edit === '1' && !!detail && editable;
  const methodArgument = detail ? `${detail.country}/${detail.methodCode}` : '';
  const changeLock = editing && detail
    ? await openChangeForSession(session, { lockObject: 'PAYMENT_METHOD', argument: methodArgument, transactionCode: PAYMENT_METHOD_ACTIVITY })
    : null;
  const held = !editing || changeLock?.mode === 'CHANGE';
  const rows = selectedCountry && !params.code && !creating
    ? (await listPaymentMethods(client, selectedCountry)).filter((row) =>
        !params.q || `${row.methodCode} ${row.description}`.toLowerCase().includes(params.q.toLowerCase()),
      )
    : [];
  const history = detail && !editing && params.history === '1'
    ? await withTenant(client, (tx) => changeHistory(
        tx,
        client,
        'payment_method',
        `${detail.country}/${detail.methodCode}`,
      ))
    : [];

  return (
    <div className="mx-auto max-w-6xl space-y-4 p-3 sm:p-4 lg:p-6">
      <header className="border-b border-line pb-4">
        <span className="code text-ink-faint">{PAYMENT_METHOD_ACTIVITY}</span>
        <div className="mt-0.5 flex flex-wrap items-center justify-between gap-3">
          <h1 className="text-xl font-semibold tracking-tight">{t('pm.title')}</h1>
          <Link href="/config" className="btn btn-default">{t('nav.workbench')}</Link>
        </div>
        <p className="mt-1 max-w-3xl text-sm text-ink-soft">{t('pm.subtitle')}</p>
      </header>

      <form method="get" className="flex flex-wrap items-end gap-2">
        <label>
          <span className="field-label">{t('pm.country')}</span>
          <select name="country" className="field-input" defaultValue={selectedCountry} required>
            <option value="">{t('pm.chooseCountry')}</option>
            {countries.map((item) => <option key={item.code} value={item.code}>{item.code} · {item.name}</option>)}
          </select>
        </label>
        <button className="btn btn-default">{t('common.filter')}</button>
      </form>

      {!selectedCountry && <p className="panel p-4 text-sm text-ink-soft">{t('pm.selectCountry')}</p>}
      {creating && selectedCountry && <PaymentMethodForm
        country={selectedCountry}
        initial={{ methodCode: '', description: '', allowedDirection: 'BOTH', isActive: true, version: 0 }}
        creating
      />}
      {selectedCountry && !params.code && !creating && <>
        <form method="get" className="flex items-end gap-2">
          <input type="hidden" name="country" value={selectedCountry} />
          <label>
            <span className="field-label">{t('pm.search')}</span>
            <input name="q" defaultValue={params.q} className="field-input" />
          </label>
          <button className="btn btn-default">{t('registry.search')}</button>
        </form>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="panel-title">{t('pm.list')}</h2>
          {editable && <Link className="btn btn-primary" href={`/config/payment-methods?country=${encodeURIComponent(selectedCountry)}&new=1`}>{t('pm.create')}</Link>}
        </div>
        <section className="panel overflow-x-auto">
          <table className="grid-table">
            <thead><tr>{['pm.code', 'pm.description', 'pm.direction', 'pm.active', 'pm.version', 'common.actions'].map((key) => <th key={key}>{t(key)}</th>)}</tr></thead>
            <tbody>
              {rows.map((row) => (
                <tr key={`${row.country}/${row.methodCode}`}>
                  <td className="code font-semibold">{row.methodCode}</td>
                  <td>{row.description}</td>
                  <td>{t(`pm.direction.${row.allowedDirection}`)}</td>
                  <td>{t(row.isActive ? 'pt.yes' : 'pt.no')}</td>
                  <td className="tabular">{row.version}</td>
                  <td className="text-end">
                    <Link className="text-accent underline" href={`/config/payment-methods?country=${encodeURIComponent(selectedCountry)}&code=${encodeURIComponent(row.methodCode)}`}>
                      {t('pm.view')}
                    </Link>
                  </td>
                </tr>
              ))}
              {!rows.length && <tr><td colSpan={6} className="text-ink-soft">{t('pm.empty')}</td></tr>}
            </tbody>
          </table>
        </section>
      </>}

      {selectedCountry && params.code && !detail && (
        <section className="panel p-4">
          <p className="text-sm text-signal-error">{t('pm.notFound')}</p>
          <Link className="mt-2 inline-block text-sm text-accent underline" href={`/config/payment-methods?country=${encodeURIComponent(selectedCountry)}`}>
            {t('pm.list')}
          </Link>
        </section>
      )}

      {detail && <>
        {editing && changeLock?.mode === 'CHANGE' && <ChangeLock lockObject="PAYMENT_METHOD" argument={methodArgument} />}
        <LockNotice message={changeLock?.mode === 'DISPLAY' ? displayOnlyMessage(changeLock) : null} />
        {editing && held ? <PaymentMethodForm
          country={detail.country}
          initial={{
            methodCode: detail.methodCode,
            description: detail.description,
            allowedDirection: detail.allowedDirection,
            isActive: detail.isActive,
            version: detail.version,
          }}
          creating={false}
        /> : <section className="panel p-4">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h2 className="panel-title">{t('pm.detail')} · <span className="code">{detail.methodCode}</span></h2>
              <p className="mt-1 text-sm text-ink-soft">{detail.country} · {countries.find((item) => item.code === detail.country)?.name}</p>
            </div>
            <div className="flex gap-3 text-sm">
              <Link className="text-accent underline" href={`/config/payment-methods?country=${encodeURIComponent(detail.country)}`}>
                {t('pm.list')}
              </Link>
              {editable && <Link className="text-accent underline" href={`/config/payment-methods?country=${encodeURIComponent(detail.country)}&code=${encodeURIComponent(detail.methodCode)}&edit=1`}>
                {t('common.change')}
              </Link>}
              <Link className="text-accent underline" href={`/config/payment-methods?country=${encodeURIComponent(detail.country)}&code=${encodeURIComponent(detail.methodCode)}&history=1`}>
                {t('pm.history')}
              </Link>
            </div>
          </div>
          <dl className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            <div><dt className="field-label">{t('pm.description')}</dt><dd>{detail.description}</dd></div>
            <div><dt className="field-label">{t('pm.direction')}</dt><dd>{t(`pm.direction.${detail.allowedDirection}`)}</dd></div>
            <div><dt className="field-label">{t('pm.active')}</dt><dd>{t(detail.isActive ? 'pt.yes' : 'pt.no')}</dd></div>
            <div><dt className="field-label">{t('pm.version')}</dt><dd className="tabular">{detail.version}</dd></div>
            <div><dt className="field-label">{t('pm.changedAt')}</dt><dd className="tabular">{detail.changedAt?.toISOString() ?? '—'}</dd></div>
            <div><dt className="field-label">{t('pm.changedBy')}</dt><dd>{detail.changedBy ?? '—'}</dd></div>
          </dl>
        </section>}
        {!editing && editable && <RetirePaymentMethodForm
          country={detail.country}
          methodCode={detail.methodCode}
          version={detail.version}
          active={detail.isActive}
        />}
        {!editing && params.history === '1' && <section className="panel overflow-x-auto">
          <div className="panel-header"><h2 className="panel-title">{t('pm.history')} · <span className="code">{detail.country}/{detail.methodCode}</span></h2></div>
          {history.map((entry) => (
            <article key={entry.id} className="border-b border-line p-3 text-sm">
              <p className="font-medium">{entry.changedAt.toISOString()} · {entry.changedBy} · {entry.changeType}</p>
              <p className="text-ink-soft">{entry.reason}</p>
              <ul className="mt-1 text-2xs text-ink-soft">
                {entry.items.map((item) => <li key={item.id}>{item.fieldLabel}: {item.oldValue ?? '—'} → {item.newValue ?? '—'}{item.isSecurityRelevant === 'true' ? ` · ${t('nr.controlChange')}` : ''}</li>)}
              </ul>
            </article>
          ))}
          {!history.length && <p className="p-3 text-sm text-ink-soft">{t('pm.noChanges')}</p>}
        </section>}
      </>}
    </div>
  );
}
