'use client';

import Link from 'next/link';
import { useActionState, useState, type ReactNode } from 'react';

import { t } from '@/platform/i18n';
import { ConstrainedField } from '@/ui/fields/ConstrainedField';
import type { SourceListActionState } from './actions';
import {
  changeSourceListAction,
  checkChangeSourceListAction,
  checkSourceListAction,
  createSourceListAction,
} from './actions';
import type { SourceListDocument } from '@/modules/purchasing/source-list';

const ROUTE = '/purchasing/source-list';
const INITIAL: SourceListActionState = { ok: false, message: '' };

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="block min-w-40 flex-1 text-sm">
      <span className="mb-1 block text-ink-soft">{label}</span>
      {children}
    </label>
  );
}

function Notice({ state }: { state: SourceListActionState }) {
  if (!state.message) return null;
  return (
    <div role="status" data-source-list-result className={`mt-3 text-sm ${state.ok ? 'text-ink' : 'text-red-700'}`}>
      <p>{state.message}</p>
      {state.remedy && <p className="mt-1">{state.remedy}</p>}
      {state.ok && state.wrote === false && <p data-source-list-preview className="mt-1">{t('sourceList.previewNote')}</p>}
      {state.changes && state.changes.length > 0 && (
        <ul data-source-list-change-preview className="mt-2 space-y-1">
          {state.changes.map((row) => (
            <li key={row.field}>{row.field}: {row.before} → {row.after}</li>
          ))}
        </ul>
      )}
      {state.ok && state.wrote && state.sourceNumber && (
        <p className="mt-1">
          <Link href={`${ROUTE}?source=${state.sourceNumber}`} data-source-list-open className="underline">
            {t('sourceList.openStanding', { number: state.sourceNumber })}
          </Link>
        </p>
      )}
    </div>
  );
}

export default function SourceListWorkbench({
  list,
  opened,
  requestedSource,
  requestedMaterial,
  requestedPlant,
  requestedOrg,
  recent,
  canMaintain,
}: {
  list: SourceListDocument | null;
  opened: {
    sourceNumber: string;
    partnerNumber: string;
    purchasingOrg: string;
    validFrom: string;
    validTo: string;
    fixedSource: boolean;
    blockedSource: boolean;
    mrpRelevant: boolean;
    markedForDeletion: boolean;
    version: number;
  } | null;
  requestedSource: string;
  requestedMaterial: string;
  requestedPlant: string;
  requestedOrg: string;
  recent: Array<{ sourceNumber: string; materialNumber: string; plant: string; partnerNumber: string; markedForDeletion: boolean }>;
  canMaintain: boolean;
}) {
  const [lookupOrg, setLookupOrg] = useState(requestedOrg || opened?.purchasingOrg || '');
  const [createOrg, setCreateOrg] = useState(requestedOrg || list?.entries[0]?.purchasingOrg || '');
  const [createPlant, setCreatePlant] = useState(requestedPlant || list?.plant || '');
  const [checkState, checkAction, checking] = useActionState(checkSourceListAction, INITIAL);
  const [createState, createAction, creating] = useActionState(createSourceListAction, INITIAL);
  const [changeState, changeAction, changing] = useActionState(changeSourceListAction, INITIAL);
  const [changeCheckState, changeCheckAction, changeChecking] = useActionState(checkChangeSourceListAction, INITIAL);

  return (
    <>
      <section aria-labelledby="source-list-lookup" className="rounded-card border border-line bg-surface p-4 shadow-card">
        <h2 id="source-list-lookup" className="text-sm font-semibold">{t('sourceList.lookupTitle')}</h2>
        <form method="get" action={ROUTE} className="mt-3 flex flex-wrap items-end gap-3">
          <Field label={t('sourceList.number')}>
            <input name="source" className="input w-full" defaultValue={opened?.sourceNumber ?? requestedSource} />
          </Field>
          <Field label={t('sourceList.material')}>
            <ConstrainedField kind="material-info" name="material" defaultValue={requestedMaterial || list?.materialNumber || ''} context={{ plant: requestedPlant || list?.plant }} />
          </Field>
          <Field label={t('sourceList.purchasingOrg')}>
            <ConstrainedField kind="purchasing-org" name="org" value={lookupOrg} onChange={setLookupOrg} />
          </Field>
          <Field label={t('sourceList.plant')}>
            <ConstrainedField kind="plant" name="plant" defaultValue={requestedPlant || list?.plant || ''} context={{ purchasingOrg: lookupOrg }} />
          </Field>
          <button type="submit" className="btn btn-default min-h-11 sm:min-h-8">{t('sourceList.load')}</button>
          <Link href={ROUTE} className="btn btn-default min-h-11 sm:min-h-8">{t('sourceList.newEntry')}</Link>
        </form>
        {requestedSource && !opened && (
          <p role="status" className="mt-2 text-sm text-red-700">{t('sourceList.notFound', { number: requestedSource })}</p>
        )}
        {requestedMaterial && requestedPlant && !list && (
          <p className="mt-2 text-sm text-ink-soft">{t('sourceList.noList', { material: requestedMaterial, plant: requestedPlant })}</p>
        )}
        <p className="mt-2 text-xs text-ink-soft">{t('sourceList.scopeHint')}</p>
        {recent.length > 0 && (
          <ul className="mt-3 flex flex-wrap gap-2 text-sm">
            {recent.map((row) => (
              <li key={row.sourceNumber}>
                <Link href={`${ROUTE}?source=${row.sourceNumber}`} className="underline">
                  {row.sourceNumber} · {row.partnerNumber} · {row.materialNumber}/{row.plant}{row.markedForDeletion ? ` · ${t('sourceList.inactive')}` : ''}
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>

      {list && (
        <section aria-labelledby="source-list-standing" data-source-list-standing className="rounded-card border border-line bg-surface p-4 shadow-card">
          <h2 id="source-list-standing" className="text-sm font-semibold">{list.materialNumber} · {list.plant}</h2>
          <p className="mt-1 text-sm text-ink-soft" data-source-list-required={list.sourceListRequired ? 'yes' : 'no'}>
            {list.sourceListRequired ? t('sourceList.required') : t('sourceList.notRequired')}
            {' · '}
            {t('sourceList.listVersion', { version: String(list.version) })}
          </p>
          <table className="mt-3 w-full text-sm">
            <thead>
              <tr className="text-left text-ink-soft">
                <th>{t('sourceList.number')}</th>
                <th>{t('sourceList.supplier')}</th>
                <th>{t('sourceList.purchasingOrg')}</th>
                <th>{t('sourceList.validity')}</th>
                <th>{t('sourceList.marks')}</th>
              </tr>
            </thead>
            <tbody>
              {list.entries.map((entry) => (
                <tr key={entry.sourceNumber} data-source-list-entry={entry.sourceNumber}>
                  <td><Link href={`${ROUTE}?source=${entry.sourceNumber}`} className="underline">{entry.sourceNumber}</Link></td>
                  <td>{entry.partnerNumber}</td>
                  <td>{entry.purchasingOrg}</td>
                  <td>{entry.validFrom} – {entry.validTo}</td>
                  <td>
                    {entry.fixedSource ? t('sourceList.fixed') : ''}
                    {entry.blockedSource ? ` ${t('sourceList.blocked')}` : ''}
                    {entry.mrpRelevant ? ` ${t('sourceList.mrp')}` : ''}
                    {entry.markedForDeletion ? ` ${t('sourceList.inactive')}` : ''}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}

      {opened && list && (
        <section aria-labelledby="source-list-change" className="rounded-card border border-line bg-surface p-4 shadow-card">
          <h2 id="source-list-change" className="text-sm font-semibold">{opened.sourceNumber}</h2>
          <p className="mt-1 text-sm text-ink-soft" data-source-list-identity>
            {list.materialNumber} · {list.plant} · {opened.partnerNumber} · {opened.purchasingOrg}
            {' · '}
            {t('sourceList.version', { version: String(opened.version) })}
          </p>
          <p className="mt-1 text-xs text-ink-soft">{t('sourceList.notRetargeted')}</p>
          <form action={changeAction} className="mt-3 space-y-3">
            <input type="hidden" name="sourceNumber" value={opened.sourceNumber} />
            <input type="hidden" name="expectedVersion" value={opened.version} />
            <input type="hidden" name="expectedListVersion" value={list.version} />
            <input type="hidden" name="sourceListRequiredField" value="1" />
            <div className="flex flex-wrap gap-3">
              <Field label={t('sourceList.validFrom')}>
                <input name="validFrom" type="date" className="input w-full" defaultValue={opened.validFrom} required />
              </Field>
              <Field label={t('sourceList.validTo')}>
                <input name="validTo" type="date" className="input w-full" defaultValue={opened.validTo} required />
              </Field>
              <Field label={t('sourceList.reason')}>
                <input name="reason" className="input w-full" required minLength={3} />
              </Field>
            </div>
            <div className="flex flex-wrap gap-4 text-sm">
              <label><input type="checkbox" name="fixedSource" defaultChecked={opened.fixedSource} /> {t('sourceList.fixed')}</label>
              <label><input type="checkbox" name="blockedSource" defaultChecked={opened.blockedSource} /> {t('sourceList.blocked')}</label>
              <label><input type="checkbox" name="mrpRelevant" defaultChecked={opened.mrpRelevant} /> {t('sourceList.mrp')}</label>
              <label><input type="checkbox" name="sourceListRequired" defaultChecked={list.sourceListRequired} /> {t('sourceList.requirement')}</label>
            </div>
            <div className="flex flex-wrap gap-2">
              <button type="submit" formAction={changeCheckAction} className="btn btn-default min-h-11 sm:min-h-8" disabled={!canMaintain || changeChecking} data-source-list-change-check>
                {changeChecking ? t('sourceList.checking') : t('sourceList.changeCheck')}
              </button>
              <button type="submit" name="intent" value="change" className="btn btn-primary min-h-11 sm:min-h-8" disabled={!canMaintain || changing} data-source-list-change>
                {changing ? t('sourceList.saving') : t('sourceList.saveChange')}
              </button>
              {opened.markedForDeletion ? (
                <button type="submit" name="intent" value="reactivate" className="btn btn-default min-h-11 sm:min-h-8" disabled={!canMaintain || changing} data-source-list-reactivate>
                  {t('sourceList.reactivate')}
                </button>
              ) : (
                <button type="submit" name="intent" value="deactivate" className="btn btn-default min-h-11 sm:min-h-8" disabled={!canMaintain || changing} data-source-list-deactivate>
                  {t('sourceList.deactivate')}
                </button>
              )}
            </div>
            <Notice state={changeCheckState} />
            <Notice state={changeState} />
          </form>
        </section>
      )}

      <section aria-labelledby="source-list-create" className="rounded-card border border-line bg-surface p-4 shadow-card">
        <h2 id="source-list-create" className="text-sm font-semibold">{t('sourceList.createTitle')}</h2>
        <p className="mt-1 text-xs text-ink-soft">{t('sourceList.createHint')}</p>
        <form action={createAction} className="mt-3 space-y-3">
          <div className="flex flex-wrap gap-3">
            <Field label={t('sourceList.purchasingOrg')}>
              <ConstrainedField kind="purchasing-org" name="purchasingOrg" required value={createOrg} onChange={setCreateOrg} />
            </Field>
            <Field label={t('sourceList.plant')}>
              <ConstrainedField kind="plant" name="plant" required value={createPlant} onChange={setCreatePlant} context={{ purchasingOrg: createOrg }} />
            </Field>
            <Field label={t('sourceList.material')}>
              <ConstrainedField kind="material-info" name="materialNumber" required defaultValue={list?.materialNumber ?? requestedMaterial} context={{ plant: createPlant }} />
            </Field>
            <Field label={t('sourceList.supplier')}>
              <ConstrainedField kind="supplier-purchasing" name="partnerNumber" required context={{ purchasingOrg: createOrg }} />
            </Field>
          </div>
          <div className="flex flex-wrap gap-3">
            <Field label={t('sourceList.validFrom')}>
              <input name="validFrom" type="date" className="input w-full" required />
            </Field>
            <Field label={t('sourceList.validTo')}>
              <input name="validTo" type="date" className="input w-full" required />
            </Field>
          </div>
          <div className="flex flex-wrap gap-4 text-sm">
            <label><input type="checkbox" name="fixedSource" /> {t('sourceList.fixed')}</label>
            <label><input type="checkbox" name="blockedSource" /> {t('sourceList.blocked')}</label>
            <label><input type="checkbox" name="mrpRelevant" /> {t('sourceList.mrp')}</label>
            {!list && (
              <label><input type="checkbox" name="sourceListRequired" /> {t('sourceList.requirement')}</label>
            )}
          </div>
          <p className="text-xs text-ink-soft">{t('sourceList.requirementHint')}</p>
          <div className="flex flex-wrap gap-2">
            <button type="submit" formAction={checkAction} className="btn btn-default min-h-11 sm:min-h-8" disabled={!canMaintain || checking} data-source-list-check>
              {checking ? t('sourceList.checking') : t('sourceList.check')}
            </button>
            <button type="submit" className="btn btn-primary min-h-11 sm:min-h-8" disabled={!canMaintain || creating} data-source-list-create>
              {creating ? t('sourceList.saving') : t('sourceList.save')}
            </button>
          </div>
          <Notice state={checkState} />
          <Notice state={createState} />
        </form>
        {!canMaintain && <p className="mt-3 text-sm text-red-700">{t('sourceList.capabilityMissing')}</p>}
      </section>
    </>
  );
}
