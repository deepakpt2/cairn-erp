'use client';

import { useActionState, useState } from 'react';
import { t } from '@/platform/i18n';
import { LockNotice, useChangeLock } from '@/ui/lock/ChangeLock';
import {
  deactivateSalesAreaAction,
  reactivateSalesAreaAction,
  saveSalesAreaAction,
  type SalesAreaActionState,
} from './actions';

export interface SalesAreaListEntry {
  salesOrg: string;
  salesOrgName: string;
  salesOrgActive: boolean;
  distributionChannel: string;
  distributionChannelName: string;
  distributionChannelActive: boolean;
  division: string;
  divisionName: string;
  divisionActive: boolean;
  name: string;
  isActive: boolean;
  version: number;
}

export function SalesAreasList({ areas, canMaintain }: { areas: SalesAreaListEntry[]; canMaintain: boolean }) {
  return (
    <section className="panel overflow-hidden" aria-labelledby="sales-area-list-title">
      <div className="border-b border-line bg-sunken px-4 py-3">
        <h2 id="sales-area-list-title" className="font-semibold">{t('salesArea.listTitle')}</h2>
        <p className="mt-1 text-xs text-ink-soft">{t('salesArea.listRule')}</p>
      </div>
      {areas.length === 0 ? (
        <p role="status" className="px-4 py-8 text-center text-sm text-ink-soft">{t('salesArea.empty')}</p>
      ) : (
        <ul className="divide-y divide-line" role="list" aria-label={t('salesArea.listTitle')}>
          {areas.map((area) => <SalesAreaItem key={`${area.salesOrg}/${area.distributionChannel}/${area.division}`} area={area} canMaintain={canMaintain} />)}
        </ul>
      )}
    </section>
  );
}

function SalesAreaItem({ area, canMaintain }: { area: SalesAreaListEntry; canMaintain: boolean }) {
  const [confirmDeactivate, setConfirmDeactivate] = useState(false);
  const [changeState, changeAction, changePending] = useActionState<SalesAreaActionState, FormData>(saveSalesAreaAction, { ok: true });
  const [deactivateState, deactivateAction, deactivatePending] = useActionState<SalesAreaActionState, FormData>(deactivateSalesAreaAction, { ok: true });
  const [reactivateState, reactivateAction, reactivatePending] = useActionState<SalesAreaActionState, FormData>(reactivateSalesAreaAction, { ok: true });
  const key = `${area.salesOrg}/${area.distributionChannel}/${area.division}`;
  const [engaged, setEngaged] = useState(false);
  const areaLock = useChangeLock('SALES_AREA', key, 'CFG.ORG.SALESAREA.DEFINE', engaged && canMaintain);
  const held = !engaged || areaLock?.mode === 'CHANGE';

  return (
    <li className="p-3 sm:p-4">
      <article className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(18rem,0.8fr)] lg:items-start">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className="code font-semibold text-ink">{area.salesOrg}/{area.distributionChannel}/{area.division}</span>
            <span className={`chip ${area.isActive ? 'chip-ok' : 'chip-neutral'}`}>{t(area.isActive ? 'salesArea.active' : 'salesArea.inactive')}</span>
          </div>
          <p className="mt-2 break-words text-base font-medium">{area.name}</p>
          <dl className="mt-3 grid grid-cols-1 gap-x-4 gap-y-2 text-sm sm:grid-cols-3">
            <div>
              <dt className="text-xs font-medium text-ink-faint">{t('salesArea.salesOrgField')}</dt>
              <dd className="mt-0.5 break-words">{area.salesOrg} · {area.salesOrgName} <DefinitionStatus active={area.salesOrgActive} /></dd>
            </div>
            <div>
              <dt className="text-xs font-medium text-ink-faint">{t('salesArea.distributionChannelField')}</dt>
              <dd className="mt-0.5 break-words">{area.distributionChannel} · {area.distributionChannelName} <DefinitionStatus active={area.distributionChannelActive} /></dd>
            </div>
            <div>
              <dt className="text-xs font-medium text-ink-faint">{t('salesArea.divisionField')}</dt>
              <dd className="mt-0.5 break-words">{area.division} · {area.divisionName} <DefinitionStatus active={area.divisionActive} /></dd>
            </div>
          </dl>
        </div>

        {canMaintain && (
          <div className="space-y-3 border-t border-line pt-3 lg:border-l lg:border-t-0 lg:pl-4 lg:pt-0" onFocus={() => setEngaged(true)}>
            <LockNotice message={areaLock?.mode === 'DISPLAY' ? areaLock.message : null} remedy={areaLock?.remedy} />
            <form action={changeAction} className="flex flex-col gap-2 sm:flex-row sm:items-end" onSubmit={(event) => { if (areaLock?.mode !== 'CHANGE') { event.preventDefault(); setEngaged(true); } }}>
              <input type="hidden" name="mode" value="CHANGE" />
              <input type="hidden" name="expectedVersion" value={area.version} />
              <input type="hidden" name="salesOrg" value={area.salesOrg} />
              <input type="hidden" name="distributionChannel" value={area.distributionChannel} />
              <input type="hidden" name="division" value={area.division} />
              <div className="min-w-0 flex-1">
                <label htmlFor={`sales-area-name-${key}`} className="field-label">{t('salesArea.nameField')}</label>
                <input id={`sales-area-name-${key}`} name="name" type="text" required maxLength={160} defaultValue={area.name} className="field-input mt-1 min-h-11 w-full sm:min-h-9" disabled={changePending || !held} />
              </div>
              <button type="submit" className="btn btn-default min-h-11 sm:min-h-9" disabled={changePending || !held}>{changePending ? t('common.saving') : t('salesArea.saveName')}</button>
            </form>
            {changeState.message && <ActionMessage state={changeState} />}

            {area.isActive ? (
              <>
                {confirmDeactivate ? (
                  <form action={deactivateAction} className="border border-signal-warn/40 bg-signal-warn-soft p-3" onSubmit={(event) => { if (areaLock?.mode !== 'CHANGE') { event.preventDefault(); setEngaged(true); } }}>
                    <input type="hidden" name="expectedVersion" value={area.version} />
                    <input type="hidden" name="salesOrg" value={area.salesOrg} />
                    <input type="hidden" name="distributionChannel" value={area.distributionChannel} />
                    <input type="hidden" name="division" value={area.division} />
                    <p className="text-sm">{t('salesArea.confirmDeactivateText', { key })}</p>
                    <div className="mt-3 flex flex-wrap gap-2">
                      <button type="submit" className="btn btn-danger min-h-11 sm:min-h-9" disabled={deactivatePending || !held}>{deactivatePending ? t('common.saving') : t('salesArea.confirmDeactivate')}</button>
                      <button type="button" className="btn btn-default min-h-11 sm:min-h-9" onClick={() => setConfirmDeactivate(false)} disabled={deactivatePending}>{t('salesArea.cancelDeactivate')}</button>
                    </div>
                    {deactivateState.message && <div className="mt-3"><ActionMessage state={deactivateState} /></div>}
                  </form>
                ) : (
                  <button type="button" className="btn btn-default min-h-11 sm:min-h-9" onClick={() => setConfirmDeactivate(true)}>{t('salesArea.deactivate')}</button>
                )}
              </>
            ) : (
              <form action={reactivateAction} className="flex flex-wrap items-center gap-2" onSubmit={(event) => { if (areaLock?.mode !== 'CHANGE') { event.preventDefault(); setEngaged(true); } }}>
                <input type="hidden" name="expectedVersion" value={area.version} />
                <input type="hidden" name="salesOrg" value={area.salesOrg} />
                <input type="hidden" name="distributionChannel" value={area.distributionChannel} />
                <input type="hidden" name="division" value={area.division} />
                <button type="submit" className="btn btn-default min-h-11 sm:min-h-9" disabled={reactivatePending || !held}>{reactivatePending ? t('common.saving') : t('salesArea.reactivate')}</button>
                {reactivateState.message && <ActionMessage state={reactivateState} />}
              </form>
            )}
          </div>
        )}
      </article>
    </li>
  );
}

function DefinitionStatus({ active }: { active: boolean }) {
  return <span className={`ms-1 chip ${active ? 'chip-ok' : 'chip-neutral'}`}>{t(active ? 'salesArea.definitionActive' : 'salesArea.definitionInactive')}</span>;
}

function ActionMessage({ state }: { state: SalesAreaActionState }) {
  return (
    <p role={state.ok ? 'status' : 'alert'} className={`text-sm ${state.ok ? 'text-signal-ok' : 'text-signal-error'}`}>
      {state.message}{state.remedy ? ` ${state.remedy}` : ''}
    </p>
  );
}
