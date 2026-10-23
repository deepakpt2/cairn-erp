'use client';

import { useActionState, useState, type ReactNode } from 'react';

import { t } from '@/platform/i18n';
import type { PriceChangeState } from './actions';
import { releaseFuturePriceAction, savePriceChangeAction } from './actions';

const INITIAL: PriceChangeState = { ok: false, message: '' };

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="block min-w-40 flex-1 text-sm">
      <span className="mb-1 block text-ink-soft">{label}</span>
      {children}
    </label>
  );
}

function Notice({ state }: { state: PriceChangeState }) {
  if (!state.message) return null;
  return (
    <div role="status" className={`mt-3 text-sm ${state.ok ? 'text-ink' : 'text-red-700'}`}>
      <p>{state.message}</p>
      {state.remedy && <p className="mt-1">{state.remedy}</p>}
      {state.warnings?.map((warning) => <p key={warning} className="mt-1">{warning}</p>)}
    </div>
  );
}

export default function PriceChange({
  today,
  canPost,
  future,
}: {
  today: string;
  canPost: boolean;
  future: Array<{
    materialNumber: string;
    plant: string;
    futurePrice: string;
    futurePriceUnit: string;
    futureValidFrom: string;
    currency: string;
  }>;
}) {
  const [lines, setLines] = useState([0]);
  const [saveState, saveAction, saving] = useActionState(savePriceChangeAction, INITIAL);
  const [releaseState, releaseAction, releasing] = useActionState(releaseFuturePriceAction, INITIAL);
  const [requestKey] = useState(() => (typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `price-${today}`));

  return (
    <>
      <section className="rounded-card border border-line bg-surface p-4 shadow-card">
        <h2 className="text-sm font-semibold">{t('priceChange.title')}</h2>
        <p className="mt-1 text-xs text-ink-soft">{t('priceChange.subtitle')}</p>
        <form action={saveAction} className="mt-3 space-y-3">
          <input type="hidden" name="lineCount" value={lines.length} />
          <input type="hidden" name="requestKey" value={requestKey} />
          <div className="flex flex-wrap gap-3">
            <Field label={t('priceChange.company')}>
              <input name="companyCode" className="input w-full" required maxLength={10} />
            </Field>
            <Field label={t('priceChange.date')}>
              <input name="postingDate" type="date" className="input w-full" required defaultValue={today} />
            </Field>
            <Field label={t('priceChange.when')}>
              <select name="when" className="input w-full" defaultValue="CURRENT">
                <option value="CURRENT">{t('priceChange.current')}</option>
                <option value="PREVIOUS">{t('priceChange.previous')}</option>
                <option value="FUTURE">{t('priceChange.future')}</option>
              </select>
            </Field>
            <Field label={t('priceChange.reason')}>
              <input name="reason" className="input w-full" required maxLength={200} />
            </Field>
          </div>
          {lines.map((key, index) => (
            <div key={key} className="flex flex-wrap items-end gap-3 border-t border-line pt-3">
              <Field label={t('priceChange.material')}>
                <input name={`line${index}Material`} className="input w-full" required maxLength={40} />
              </Field>
              <Field label={t('priceChange.plant')}>
                <input name={`line${index}Plant`} className="input w-full" required maxLength={10} />
              </Field>
              <Field label={t('priceChange.price')}>
                <input name={`line${index}Price`} className="input w-full" required inputMode="decimal" />
              </Field>
              <Field label={t('priceChange.priceUnit')}>
                <input name={`line${index}PriceUnit`} className="input w-full" defaultValue="1" inputMode="decimal" />
              </Field>
            </div>
          ))}
          <button type="button" className="btn btn-default min-h-11 sm:min-h-8" onClick={() => setLines((current) => [...current, current.length])}>
            {t('requestForQuotation.addLine')}
          </button>
          <button type="submit" className="btn btn-primary min-h-11 sm:min-h-8" disabled={!canPost || saving}>
            {saving ? t('priceChange.saving') : t('priceChange.save')}
          </button>
          <Notice state={saveState} />
        </form>
        {!canPost && <p className="mt-3 text-sm text-red-700">{t('priceChange.capabilityMissing')}</p>}
      </section>

      {future.length > 0 && (
        <section className="rounded-card border border-line bg-surface p-4 shadow-card">
          <h2 className="text-sm font-semibold">{t('priceChange.futureList')}</h2>
          <form action={releaseAction} className="mt-3 space-y-3">
            <input type="hidden" name="requestKey" value={`${requestKey}-release`} />
            <div className="flex flex-wrap gap-3">
              <Field label={t('priceChange.company')}>
                <input name="companyCode" className="input w-full" required maxLength={10} />
              </Field>
              <Field label={t('priceChange.date')}>
                <input name="postingDate" type="date" className="input w-full" required defaultValue={today} />
              </Field>
              <Field label={t('priceChange.reason')}>
                <input name="reason" className="input w-full" required maxLength={200} defaultValue="Release future price" />
              </Field>
            </div>
            <ul className="space-y-2 text-sm">
              {future.map((row) => (
                <li key={`${row.materialNumber}-${row.plant}`}>
                  <label className="flex items-center gap-2">
                    <input type="checkbox" name="release" value={`${row.materialNumber}|${row.plant}`} />
                    <span>
                      {row.materialNumber} · {row.plant} · {row.futurePrice} / {row.futurePriceUnit} {row.currency} · {row.futureValidFrom}
                    </span>
                  </label>
                </li>
              ))}
            </ul>
            <button type="submit" className="btn btn-primary min-h-11 sm:min-h-8" disabled={!canPost || releasing}>
              {t('priceChange.release')}
            </button>
            <Notice state={releaseState} />
          </form>
        </section>
      )}
    </>
  );
}
