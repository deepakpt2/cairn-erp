'use client';
import { useActionState } from 'react';
import { t } from '@/platform/i18n';
import type { listCustomerPartners } from '@/modules/sales/partners';
import {
  changeCustomerPartnerStatusAction,
  saveCustomerPartnerAction,
  type CustomerPartnerActionState,
} from './customer-partner-actions';

type Row = Awaited<ReturnType<typeof listCustomerPartners>>['rows'][number];
type FunctionRow = Awaited<ReturnType<typeof listCustomerPartners>>['functions'][number];

const EMPTY: CustomerPartnerActionState = { ok: false };

/**
 * Who a sale is made with (SAP: KNVP). Three functions are assignable; the sold-to is the customer
 * whose master this is and is never assigned. Each row is maintained for a sales area or for all of
 * them, and the row naming the area is the one that answers.
 */
export function CustomerPartnerPanel({
  partner, area, rows, functions, editable,
}: {
  partner: string;
  area: { org: string; channel: string; division: string };
  rows: Row[];
  functions: FunctionRow[];
  editable: boolean;
}) {
  return <section className="panel p-4" aria-labelledby="customer-partner-functions-title">
    <header className="mb-3">
      <h2 id="customer-partner-functions-title" className="panel-title">{t('csp.title')}</h2>
      <p className="mt-1 text-sm text-ink-soft">{t('csp.description')}</p>
    </header>
    {!functions.length ? <p className="text-sm text-ink-soft">{t('csp.noCatalogue')}</p> :
      <div className="grid gap-3 lg:grid-cols-3">
        {functions.map(fn => <FunctionCard
          key={fn.functionCode}
          partner={partner}
          area={area}
          fn={fn}
          rows={rows.filter(row => row.functionCode === fn.functionCode)}
          editable={editable}
        />)}
      </div>}
  </section>;
}

function FunctionCard({ partner, area, fn, rows, editable }: {
  partner: string;
  area: { org: string; channel: string; division: string };
  fn: FunctionRow;
  rows: Row[];
  editable: boolean;
}) {
  const [saved, saveAction] = useActionState(saveCustomerPartnerAction, EMPTY);
  const specific = rows.filter(row => row.salesOrg === area.org
    && row.distributionChannel === area.channel && row.division === area.division);
  const answering = specific[0] ?? rows.filter(row => row.salesOrg === '')[0] ?? null;

  return <article className="border border-line p-3">
    <div className="flex flex-wrap items-start justify-between gap-2">
      <div>
        <h3 className="font-medium">{fn.displayName}</h3>
        <p className="code text-2xs text-ink-faint">{fn.functionCode}</p>
      </div>
    </div>
    <p className="mt-2 text-xs text-ink-soft">{fn.meaning}</p>

    {answering ? <p className="mt-3 text-sm">
      <span className="field-label">{t('csp.answers')}</span>{' '}
      <span className="code">{answering.assignedPartnerNumber}</span>{answering.assignedPartnerName ? ` · ${answering.assignedPartnerName}` : ''}
      {!answering.isActive ? ` · ${t('csp.withdrawn')}` : ''}
    </p> : <p className="mt-3 text-sm text-ink-soft">{t('csp.noneAssigned')}</p>}

    {rows.length > 1 && <ul className="mt-2 space-y-1 text-2xs text-ink-faint">
      {rows.filter(row => row !== answering).map(row => <li key={`${row.salesOrg}/${row.distributionChannel}/${row.division}`}>
        {row.salesOrg || t('csp.anyArea')}/{row.distributionChannel || '—'}/{row.division || '—'}: {row.assignedPartnerNumber}
        {row.isActive ? '' : ` (${t('csp.withdrawn')})`}
      </li>)}
    </ul>}

    {editable && <>
      <form action={saveAction} className="mt-3 grid gap-2">
        <input type="hidden" name="partnerNumber" value={partner} />
        <input type="hidden" name="functionCode" value={fn.functionCode} />
        <input type="hidden" name="expectedVersion" value={answering?.version ?? 0} />
        <input type="hidden" name="areaOrg" value={area.org} />
        <input type="hidden" name="areaChannel" value={area.channel} />
        <input type="hidden" name="areaDivision" value={area.division} />
        <label>
          <span className="field-label">{t('csp.scope')}</span>
          <select name="scope" defaultValue={specific.length > 0 ? 'AREA' : 'ALL'} className="field-input">
            <option value="AREA">{t('csp.forArea')} {area.org} / {area.channel} / {area.division}</option>
            <option value="ALL">{t('csp.forAllAreas')}</option>
          </select>
        </label>
        <label>
          <span className="field-label">{t('csp.assign')}</span>
          <input name="assignedPartnerNumber" defaultValue={answering?.assignedPartnerNumber ?? ''} className="field-input" />
        </label>
        <button className="btn btn-default">{t('csp.save')}</button>
      </form>
      {answering && <form action={changeCustomerPartnerStatusAction.bind(null, {
        partnerNumber: partner, functionCode: fn.functionCode, salesOrg: answering.salesOrg,
        distributionChannel: answering.distributionChannel, division: answering.division,
        isActive: !answering.isActive,
      })} className="mt-2">
        <button className="btn btn-default">{answering.isActive ? t('csp.withdraw') : t('csp.restore')}</button>
      </form>}
    </>}
    {!saved.ok && saved.message && <p className="mt-2 text-xs text-signal-warn">{saved.message}{saved.remedy ? ` ${saved.remedy}` : ''}</p>}
    {saved.ok && saved.message && <p className="mt-2 text-xs">{saved.message}</p>}
  </article>;
}
