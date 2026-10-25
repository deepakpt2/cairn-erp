'use client';

import { useActionState, useEffect, useState } from 'react';
import Link from 'next/link';

import { t } from '@/platform/i18n';
import type { MrpRunView } from '@/modules/production/mrp-run';
import { cancelMrpRunAction, planMaterialsAction, type MrpActionState } from './actions';

const INITIAL: MrpActionState = { ok: false, message: '' };

function newRequestKey(): string {
  return `md01-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export default function MrpRunWorkbench({
  canPlan,
  canRegenerate,
  run,
}: {
  canPlan: boolean;
  canRegenerate: boolean;
  run: MrpRunView | null;
}) {
  const [state, action, pending] = useActionState(planMaterialsAction, INITIAL);
  const [cancelState, cancelAction, cancelling] = useActionState(cancelMrpRunAction, INITIAL);
  const [requestKey, setRequestKey] = useState(newRequestKey);
  const shown = state.run ?? cancelState.run ?? run;

  useEffect(() => {
    if (state.ok) setRequestKey(newRequestKey());
  }, [state]);

  return (
    <div className="space-y-4">
      <form action={action} className="rounded-card border border-line bg-surface p-4 shadow-card">
        <input type="hidden" name="requestKey" value={requestKey} />
        <div className="grid gap-3 sm:grid-cols-3">
          <label className="block text-sm">
            <span className="mb-1 block text-ink-soft">{t('md01.plantFrom')}</span>
            <input name="plantFrom" required maxLength={10} className="input w-full" defaultValue="1000" />
          </label>
          <label className="block text-sm">
            <span className="mb-1 block text-ink-soft">{t('md01.plantTo')}</span>
            <input name="plantTo" maxLength={10} className="input w-full" defaultValue="1000" />
          </label>
          <label className="block text-sm">
            <span className="mb-1 block text-ink-soft">{t('md01.processingKey')}</span>
            <select name="processingKey" className="input w-full" defaultValue="NETCH">
              <option value="NETCH">{t('md01.netch')}</option>
              <option value="NETPL">{t('md01.netpl')}</option>
              <option value="NEUPL">{t('md01.neupl')}</option>
            </select>
          </label>
          <label className="block text-sm">
            <span className="mb-1 block text-ink-soft">{t('md01.horizonStart')}</span>
            <input type="date" name="horizonStart" className="input w-full" />
          </label>
          <label className="block text-sm">
            <span className="mb-1 block text-ink-soft">{t('md01.horizonEnd')}</span>
            <input type="date" name="horizonEnd" className="input w-full" />
          </label>
          <label className="block text-sm">
            <span className="mb-1 block text-ink-soft">{t('md01.controller')}</span>
            <input name="mrpController" maxLength={3} className="input w-full" />
          </label>
          <label className="block text-sm">
            <span className="mb-1 block text-ink-soft">{t('md01.materialFrom')}</span>
            <input name="materialFrom" maxLength={40} className="input w-full" />
          </label>
          <label className="block text-sm">
            <span className="mb-1 block text-ink-soft">{t('md01.materialTo')}</span>
            <input name="materialTo" maxLength={40} className="input w-full" />
          </label>
          <label className="flex items-end gap-2 text-sm">
            <input type="checkbox" name="confirmRegenerative" disabled={!canRegenerate} />
            <span>{t('md01.confirm')}</span>
          </label>
        </div>
        <p className="mt-3 text-sm text-ink-soft">{t('md01.nothingPosted')}</p>
        <div className="mt-3 flex flex-wrap gap-2">
          <button type="submit" name="intent" value="check" className="btn btn-default min-h-11 sm:min-h-8" disabled={!canPlan || pending}>
            {pending ? t('md01.checking') : t('md01.check')}
          </button>
          <button type="submit" name="intent" value="plan" className="btn btn-default min-h-11 sm:min-h-8" disabled={!canPlan || pending}>
            {pending ? t('md01.planning') : t('md01.plan')}
          </button>
        </div>
        {state.message && (
          <p role="status" data-mrp-message className={`mt-2 text-sm ${state.ok ? 'text-ink' : 'text-red-700'}`}>
            {state.message}{state.remedy ? ` ${state.remedy}` : ''}
          </p>
        )}
      </form>

      {shown && (
        <section aria-labelledby="mrp-result" className="rounded-card border border-line bg-surface p-4 shadow-card" data-mrp-run={shown.runNumber}>
          <h2 id="mrp-result" className="text-sm font-semibold">{t('md01.run')} {shown.runNumber}</h2>
          <dl className="mt-2 grid gap-2 text-sm sm:grid-cols-4">
            <div><dt className="text-ink-soft">{t('md01.status')}</dt><dd data-mrp-status>{shown.status}</dd></div>
            <div><dt className="text-ink-soft">{t('md01.selected')}</dt><dd data-mrp-selected>{shown.materialsSelected}</dd></div>
            <div><dt className="text-ink-soft">{t('md01.created')}</dt><dd data-mrp-created>{shown.proposalsCreated}</dd></div>
            <div><dt className="text-ink-soft">{t('md01.retained')}</dt><dd data-mrp-retained>{shown.proposalsRetained}</dd></div>
          </dl>
          {shown.materials[0] && (
            <p className="mt-2 text-sm" data-mrp-company>{t('md01.companyCode')} {shown.materials[0].companyCode}</p>
          )}
          <table className="mt-3 w-full text-sm">
            <thead>
              <tr className="text-left text-ink-faint">
                <th>{t('md01.materials')}</th>
                <th>{t('md01.status')}</th>
                <th>{t('md01.diagnostics')}</th>
              </tr>
            </thead>
            <tbody>
              {shown.materials.map((row) => (
                <tr key={`${row.plant}/${row.materialNumber}`} data-mrp-material={row.materialNumber}>
                  <td className="py-1">
                    <Link href={`/production/stock-requirements?material=${encodeURIComponent(row.materialNumber)}&plant=${encodeURIComponent(row.plant)}`}>
                      {row.materialNumber}
                    </Link>
                    {' '}{row.plant}
                  </td>
                  <td>{row.status}</td>
                  <td>{row.message}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {shown.dependents.length > 0 && (
            <table className="mt-3 w-full text-sm" data-mrp-dependents>
              <thead>
                <tr className="text-left text-ink-faint">
                  <th>{t('md01.dependents')}</th>
                  <th>{t('md01.component')}</th>
                  <th>{t('md01.created')}</th>
                </tr>
              </thead>
              <tbody>
                {shown.dependents.map((row) => (
                  <tr key={`${row.parentOrderNumber ?? row.parentMaterial}/${row.componentMaterial}/${row.requirementDate}`} data-mrp-dependent={row.componentMaterial}>
                    <td className="py-1">{row.parentMaterial} {row.parentOrderNumber ?? '—'}</td>
                    <td>{row.componentMaterial} {row.quantity} {row.unit}</td>
                    <td>{row.requirementDate}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {shown.diagnostics.some((row) => row.severity === 'WARNING' || row.severity === 'ERROR') && (
            <ul className="mt-3 space-y-1 text-sm" data-mrp-diagnostics>
              {shown.diagnostics.filter((row) => row.severity === 'WARNING' || row.severity === 'ERROR').map((row) => (
                <li key={row.lineNumber} data-mrp-diagnostic={row.diagnosticCode}>
                  {row.materialNumber ?? '—'} {row.message}
                </li>
              ))}
            </ul>
          )}
          {shown.proposals.length > 0 && (
            <table className="mt-3 w-full text-sm" data-mrp-proposals>
              <thead>
                <tr className="text-left text-ink-faint">
                  <th>{t('md01.proposals')}</th>
                  <th>{t('md01.created')}</th>
                  <th>{t('md01.status')}</th>
                </tr>
              </thead>
              <tbody>
                {shown.proposals.map((row) => (
                  <tr key={row.lineNumber} data-mrp-proposal={row.documentNumber ?? row.lineNumber}>
                    <td className="py-1">{row.proposalType} {row.documentNumber ?? '—'}</td>
                    <td>{row.action} {row.quantity}</td>
                    <td>{row.status}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {(shown.status === 'RUNNING' || shown.status === 'QUEUED' || shown.status === 'CANCELLING') ? (
            <form action={cancelAction} className="mt-3">
              <input type="hidden" name="runNumber" value={shown.runNumber} />
              <button type="submit" className="btn btn-default min-h-11 sm:min-h-8" disabled={!canPlan || cancelling}>{t('md01.cancel')}</button>
              {cancelState.message && <p role="status" className="mt-2 text-sm">{cancelState.message}</p>}
            </form>
          ) : null}
        </section>
      )}
    </div>
  );
}
