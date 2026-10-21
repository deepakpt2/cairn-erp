'use client';

import Link from 'next/link';
import { useActionState, useState, type ReactNode } from 'react';

import { t } from '@/platform/i18n';
import { ConstrainedField } from '@/ui/fields/ConstrainedField';
import type { QuotaActionState } from './actions';
import {
  changeQuotaAction,
  checkChangeQuotaAction,
  checkQuotaAction,
  createQuotaAction,
  rateQuotaAction,
} from './actions';
import type { QuotaRating, StandingArrangement } from '@/modules/purchasing/quota-arrangement';

const ROUTE = '/purchasing/quota-arrangement';
const INITIAL: QuotaActionState = { ok: false, message: '' };

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="block min-w-40 flex-1 text-sm">
      <span className="mb-1 block text-ink-soft">{label}</span>
      {children}
    </label>
  );
}

function Ratings({ ratings, preferred }: { ratings: QuotaRating[]; preferred?: string | null }) {
  if (ratings.length === 0) return null;
  return (
    <table className="mt-3 w-full text-sm" data-quota-ratings>
      <thead>
        <tr className="text-left text-ink-soft">
          <th className="py-1 pr-3">{t('quotaArrangement.item')}</th>
          <th className="py-1 pr-3">{t('quotaArrangement.supplier')}</th>
          <th className="py-1 pr-3">{t('quotaArrangement.purchasingOrg')}</th>
          <th className="py-1 pr-3">{t('quotaArrangement.quota')}</th>
          <th className="py-1 pr-3">{t('quotaArrangement.base')}</th>
          <th className="py-1 pr-3">{t('quotaArrangement.allocated')}</th>
          <th className="py-1 pr-3">{t('quotaArrangement.rating')}</th>
          <th className="py-1">{t('quotaArrangement.eligible')}</th>
        </tr>
      </thead>
      <tbody>
        {ratings.map((row) => (
          <tr key={row.itemNumber} data-quota-rating={row.itemNumber} data-quota-preferred={preferred === row.itemNumber ? 'yes' : 'no'}>
            <td className="py-1 pr-3">{row.itemNumber}</td>
            <td className="py-1 pr-3">{row.partnerNumber}</td>
            <td className="py-1 pr-3">{row.purchasingOrg}</td>
            <td className="py-1 pr-3">{row.quota}</td>
            <td className="py-1 pr-3">{row.baseQuantity}</td>
            <td className="py-1 pr-3">{row.allocatedQuantity}</td>
            <td className="py-1 pr-3">{row.rating}</td>
            <td className="py-1">{row.eligible ? t('quotaArrangement.yes') : row.reason}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function Notice({ state }: { state: QuotaActionState }) {
  if (!state.message) return null;
  return (
    <div role="status" data-quota-result className={`mt-3 text-sm ${state.ok ? 'text-ink' : 'text-red-700'}`}>
      <p>{state.message}</p>
      {state.remedy && <p className="mt-1">{state.remedy}</p>}
      {state.ok && state.wrote === false && (
        <p data-quota-preview className="mt-1">{t('quotaArrangement.previewNote')}</p>
      )}
      {state.ok && state.wrote === false && (
        <p data-quota-nothing-allocated className="mt-1">{t('quotaArrangement.nothingAllocated')}</p>
      )}
      {state.changes && state.changes.length > 0 && (
        <ul data-quota-change-preview className="mt-2 space-y-1">
          {state.changes.map((row) => (
            <li key={row.field}>{row.field}: {row.before} → {row.after}</li>
          ))}
        </ul>
      )}
      {state.ratings && <Ratings ratings={state.ratings} preferred={state.selection?.preferredItemNumber} />}
      {state.ok && state.wrote && state.quotaNumber && (
        <p className="mt-1">
          <Link href={`${ROUTE}?quota=${state.quotaNumber}`} data-quota-open className="underline">
            {t('quotaArrangement.openStanding', { number: state.quotaNumber })}
          </Link>
        </p>
      )}
    </div>
  );
}

export default function QuotaWorkbench({
  opened,
  arrangements,
  requestedQuota,
  requestedMaterial,
  requestedPlant,
  recent,
  canMaintain,
}: {
  opened: StandingArrangement | null;
  arrangements: StandingArrangement[];
  requestedQuota: string;
  requestedMaterial: string;
  requestedPlant: string;
  recent: Array<{ quotaNumber: string; materialNumber: string; plant: string; markedForDeletion: boolean }>;
  canMaintain: boolean;
}) {
  const [plant, setPlant] = useState(requestedPlant || opened?.plant || '');
  const [rows, setRows] = useState<Array<{ org: string }>>([{ org: '' }]);
  const chosenOrgs = rows.map((row) => row.org).filter((org) => org !== '');
  const sharedOrg = chosenOrgs.length > 0 && chosenOrgs.every((org) => org === chosenOrgs[0]) ? chosenOrgs[0] : '';
  const [added, setAdded] = useState({ org: '' });
  const [checkState, checkAction, checking] = useActionState(checkQuotaAction, INITIAL);
  const [createState, createAction, creating] = useActionState(createQuotaAction, INITIAL);
  const [changeState, changeAction, changing] = useActionState(changeQuotaAction, INITIAL);
  const [changeCheckState, changeCheckAction, changeChecking] = useActionState(checkChangeQuotaAction, INITIAL);
  const [rateState, rateAction, rating] = useActionState(rateQuotaAction, INITIAL);

  return (
    <>
      <section aria-labelledby="quota-lookup" className="rounded-card border border-line bg-surface p-4 shadow-card">
        <h2 id="quota-lookup" className="text-sm font-semibold">{t('quotaArrangement.lookupTitle')}</h2>
        <form method="get" action={ROUTE} className="mt-3 flex flex-wrap items-end gap-3">
          <Field label={t('quotaArrangement.number')}>
            <input name="quota" className="input w-full" defaultValue={opened?.quotaNumber ?? requestedQuota} />
          </Field>
          <Field label={t('quotaArrangement.material')}>
            <ConstrainedField kind="material-info" name="material" defaultValue={requestedMaterial || opened?.materialNumber || ''} context={{ plant: requestedPlant || opened?.plant }} />
          </Field>
          <Field label={t('quotaArrangement.plant')}>
            <ConstrainedField kind="plant" name="plant" defaultValue={requestedPlant || opened?.plant || ''} />
          </Field>
          <button type="submit" className="btn btn-default min-h-11 sm:min-h-8">{t('quotaArrangement.load')}</button>
          <Link href={ROUTE} className="btn btn-default min-h-11 sm:min-h-8">{t('quotaArrangement.newArrangement')}</Link>
        </form>
        {requestedQuota && !opened && (
          <p role="status" className="mt-2 text-sm text-red-700">{t('quotaArrangement.notFound', { number: requestedQuota })}</p>
        )}
        {requestedMaterial && requestedPlant && arrangements.length === 0 && !opened && (
          <p className="mt-2 text-sm text-ink-soft">{t('quotaArrangement.noArrangement', { material: requestedMaterial, plant: requestedPlant })}</p>
        )}
        <p className="mt-2 text-xs text-ink-soft">{t('quotaArrangement.scopeHint')}</p>
        {recent.length > 0 && (
          <ul className="mt-3 flex flex-wrap gap-2 text-sm">
            {recent.map((row) => (
              <li key={row.quotaNumber}>
                <Link href={`${ROUTE}?quota=${row.quotaNumber}`} className="underline">
                  {row.quotaNumber} · {row.materialNumber}/{row.plant}{row.markedForDeletion ? ` · ${t('quotaArrangement.inactive')}` : ''}
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>

      {arrangements.length > 0 && (
        <section aria-labelledby="quota-standing" data-quota-standing className="rounded-card border border-line bg-surface p-4 shadow-card">
          <h2 id="quota-standing" className="text-sm font-semibold">
            {arrangements[0].materialNumber} · {arrangements[0].plant}
          </h2>
          <p className="mt-1 text-xs text-ink-soft">{t('quotaArrangement.standingHint')}</p>
          <table className="mt-3 w-full text-sm">
            <thead>
              <tr className="text-left text-ink-soft">
                <th className="py-1 pr-3">{t('quotaArrangement.number')}</th>
                <th className="py-1 pr-3">{t('quotaArrangement.validFrom')}</th>
                <th className="py-1 pr-3">{t('quotaArrangement.validTo')}</th>
                <th className="py-1 pr-3">{t('quotaArrangement.item')}</th>
                <th className="py-1 pr-3">{t('quotaArrangement.supplier')}</th>
                <th className="py-1 pr-3">{t('quotaArrangement.quota')}</th>
                <th className="py-1">{t('quotaArrangement.base')}</th>
              </tr>
            </thead>
            <tbody>
              {arrangements.flatMap((arrangement) => arrangement.items.map((item) => (
                <tr key={`${arrangement.quotaNumber}-${item.itemNumber}`} data-quota-item={item.itemNumber}>
                  <td className="py-1 pr-3">
                    <Link href={`${ROUTE}?quota=${arrangement.quotaNumber}`} className="underline">{arrangement.quotaNumber}</Link>
                    {arrangement.markedForDeletion ? ` · ${t('quotaArrangement.inactive')}` : ''}
                  </td>
                  <td className="py-1 pr-3">{arrangement.validFrom}</td>
                  <td className="py-1 pr-3">{arrangement.validTo}</td>
                  <td className="py-1 pr-3">{item.itemNumber}{item.markedForDeletion ? ` · ${t('quotaArrangement.inactive')}` : ''}</td>
                  <td className="py-1 pr-3">{item.partnerNumber} · {item.purchasingOrg}</td>
                  <td className="py-1 pr-3">{item.quota}</td>
                  <td className="py-1">{item.quotaBaseQuantity}</td>
                </tr>
              )))}
            </tbody>
          </table>
        </section>
      )}

      {opened && (
        <section aria-labelledby="quota-change" className="rounded-card border border-line bg-surface p-4 shadow-card">
          <h2 id="quota-change" className="text-sm font-semibold">{opened.quotaNumber}</h2>
          <p className="mt-1 text-sm text-ink-soft" data-quota-identity>
            {opened.materialNumber} · {opened.plant}
            {' · '}
            {t('quotaArrangement.version', { version: String(opened.version) })}
            {opened.markedForDeletion ? ` · ${t('quotaArrangement.inactive')}` : ''}
          </p>
          <p className="mt-1 text-xs text-ink-soft">{t('quotaArrangement.notRetargeted')}</p>
          <form action={changeAction} className="mt-3 space-y-3">
            <input type="hidden" name="quotaNumber" value={opened.quotaNumber} />
            <input type="hidden" name="expectedVersion" value={opened.version} />
            <input type="hidden" name="itemCount" value={opened.items.length + 1} />
            <div className="flex flex-wrap gap-3">
              <Field label={t('quotaArrangement.validFrom')}>
                <input name="validFrom" type="date" className="input w-full" defaultValue={opened.validFrom} required />
              </Field>
              <Field label={t('quotaArrangement.validTo')}>
                <input name="validTo" type="date" className="input w-full" defaultValue={opened.validTo} required />
              </Field>
              <Field label={t('quotaArrangement.reason')}>
                <input name="reason" className="input w-full" required minLength={3} maxLength={500} />
              </Field>
            </div>
            <div className="space-y-3">
              {opened.items.map((item, index) => (
                <div key={item.itemNumber} data-quota-change-item={item.itemNumber} className="flex flex-wrap items-end gap-3 border-t border-line pt-3">
                  <input type="hidden" name={`item${index}Number`} value={item.itemNumber} />
                  <p className="min-w-40 flex-1 text-sm">
                    <span className="mb-1 block text-ink-soft">{t('quotaArrangement.item')} {item.itemNumber}</span>
                    {item.partnerNumber} · {item.purchasingOrg}
                    {item.markedForDeletion ? ` · ${t('quotaArrangement.inactive')}` : ''}
                  </p>
                  <Field label={t('quotaArrangement.quota')}>
                    <input name={`item${index}Quota`} type="number" min={1} step={1} className="input w-full" defaultValue={item.quota} required />
                  </Field>
                  <Field label={t('quotaArrangement.base')}>
                    <input name={`item${index}Base`} type="number" min={0} step="0.001" className="input w-full" defaultValue={item.quotaBaseQuantity} required />
                  </Field>
                  <label className="pb-2 text-sm">
                    {item.markedForDeletion ? (
                      <><input type="checkbox" name={`item${index}Reactivate`} /> {t('quotaArrangement.reactivateItem')}</>
                    ) : (
                      <><input type="checkbox" name={`item${index}Deactivate`} /> {t('quotaArrangement.deactivateItem')}</>
                    )}
                  </label>
                </div>
              ))}
              <div data-quota-new-item className="flex flex-wrap items-end gap-3 border-t border-line pt-3">
                <Field label={t('quotaArrangement.purchasingOrg')}>
                  <ConstrainedField kind="purchasing-org" name={`item${opened.items.length}Org`} value={added.org} onChange={(org) => setAdded({ org })} />
                </Field>
                <Field label={t('quotaArrangement.supplier')}>
                  <ConstrainedField kind="supplier-purchasing" name={`item${opened.items.length}Partner`} context={{ purchasingOrg: added.org }} />
                </Field>
                <Field label={t('quotaArrangement.quota')}>
                  <input name={`item${opened.items.length}Quota`} type="number" min={1} step={1} className="input w-full" />
                </Field>
                <Field label={t('quotaArrangement.base')}>
                  <input name={`item${opened.items.length}Base`} type="number" min={0} step="0.001" className="input w-full" defaultValue="0" />
                </Field>
              </div>
              <p className="text-xs text-ink-soft">{t('quotaArrangement.addItemHint')}</p>
            </div>
            <div className="flex flex-wrap gap-2">
              <button type="submit" formAction={changeCheckAction} className="btn btn-default min-h-11 sm:min-h-8" disabled={!canMaintain || changeChecking} data-quota-change-check>
                {changeChecking ? t('quotaArrangement.checking') : t('quotaArrangement.changeCheck')}
              </button>
              <button type="submit" name="intent" value="change" className="btn btn-primary min-h-11 sm:min-h-8" disabled={!canMaintain || changing} data-quota-change>
                {changing ? t('quotaArrangement.saving') : t('quotaArrangement.saveChange')}
              </button>
              {opened.markedForDeletion ? (
                <button type="submit" name="intent" value="reactivate" className="btn btn-default min-h-11 sm:min-h-8" disabled={!canMaintain || changing} data-quota-reactivate>
                  {t('quotaArrangement.reactivate')}
                </button>
              ) : (
                <button type="submit" name="intent" value="deactivate" className="btn btn-default min-h-11 sm:min-h-8" disabled={!canMaintain || changing} data-quota-deactivate>
                  {t('quotaArrangement.deactivate')}
                </button>
              )}
            </div>
            <Notice state={changeCheckState} />
            <Notice state={changeState} />
          </form>
        </section>
      )}

      {opened && (
        <section aria-labelledby="quota-rate" className="rounded-card border border-line bg-surface p-4 shadow-card">
          <h2 id="quota-rate" className="text-sm font-semibold">{t('quotaArrangement.rateTitle')}</h2>
          <p className="mt-1 text-xs text-ink-soft">{t('quotaArrangement.rateHint')}</p>
          <form action={rateAction} className="mt-3 flex flex-wrap items-end gap-3">
            <input type="hidden" name="materialNumber" value={opened.materialNumber} />
            <input type="hidden" name="plant" value={opened.plant} />
            <Field label={t('quotaArrangement.documentDate')}>
              <input name="documentDate" type="date" className="input w-full" required />
            </Field>
            <button type="submit" className="btn btn-default min-h-11 sm:min-h-8" disabled={!canMaintain || rating} data-quota-rate>
              {rating ? t('quotaArrangement.checking') : t('quotaArrangement.rate')}
            </button>
          </form>
          <Notice state={rateState} />
        </section>
      )}

      <section aria-labelledby="quota-create" className="rounded-card border border-line bg-surface p-4 shadow-card">
        <h2 id="quota-create" className="text-sm font-semibold">{t('quotaArrangement.createTitle')}</h2>
        <p className="mt-1 text-xs text-ink-soft">{t('quotaArrangement.createHint')}</p>
        <form action={createAction} className="mt-3 space-y-3">
          <input type="hidden" name="itemCount" value={rows.length} />
          <div className="flex flex-wrap gap-3">
            <Field label={t('quotaArrangement.plant')}>
              <ConstrainedField kind="plant" name="plant" required value={plant} onChange={setPlant} context={{ purchasingOrg: sharedOrg }} />
            </Field>
            <Field label={t('quotaArrangement.material')}>
              <ConstrainedField kind="material-info" name="materialNumber" required defaultValue={opened?.materialNumber ?? requestedMaterial} context={{ plant }} />
            </Field>
            <Field label={t('quotaArrangement.validFrom')}>
              <input name="validFrom" type="date" className="input w-full" required />
            </Field>
            <Field label={t('quotaArrangement.validTo')}>
              <input name="validTo" type="date" className="input w-full" required />
            </Field>
          </div>
          <div className="space-y-3">
            {rows.map((row, index) => (
              <div key={index} className="flex flex-wrap items-end gap-3 border-t border-line pt-3">
                <Field label={t('quotaArrangement.purchasingOrg')}>
                  <ConstrainedField kind="purchasing-org" name={`item${index}Org`} required value={row.org} onChange={(org) => setRows((current) => current.map((entry, at) => at === index ? { org } : entry))} />
                </Field>
                <Field label={t('quotaArrangement.supplier')}>
                  <ConstrainedField kind="supplier-purchasing" name={`item${index}Partner`} required context={{ purchasingOrg: row.org }} />
                </Field>
                <Field label={t('quotaArrangement.quota')}>
                  <input name={`item${index}Quota`} type="number" min={1} step={1} className="input w-full" required />
                </Field>
                <Field label={t('quotaArrangement.base')}>
                  <input name={`item${index}Base`} type="number" min={0} step="0.001" className="input w-full" defaultValue="0" required />
                </Field>
              </div>
            ))}
          </div>
          <button type="button" className="btn btn-default min-h-11 sm:min-h-8" onClick={() => setRows((current) => [...current, { org: '' }])}>
            {t('quotaArrangement.addItem')}
          </button>
          <div className="flex flex-wrap gap-2">
            <button type="submit" formAction={checkAction} className="btn btn-default min-h-11 sm:min-h-8" disabled={!canMaintain || checking} data-quota-check>
              {checking ? t('quotaArrangement.checking') : t('quotaArrangement.check')}
            </button>
            <button type="submit" className="btn btn-primary min-h-11 sm:min-h-8" disabled={!canMaintain || creating} data-quota-create>
              {creating ? t('quotaArrangement.saving') : t('quotaArrangement.save')}
            </button>
          </div>
          <Notice state={checkState} />
          <Notice state={createState} />
        </form>
        {!canMaintain && <p className="mt-3 text-sm text-red-700">{t('quotaArrangement.capabilityMissing')}</p>}
      </section>
    </>
  );
}
