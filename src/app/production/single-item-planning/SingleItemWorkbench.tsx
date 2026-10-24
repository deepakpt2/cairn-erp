'use client';

import { useActionState, useEffect, useState } from 'react';
import Link from 'next/link';

import { t } from '@/platform/i18n';
import type { MrpRunView } from '@/modules/production/mrp-run';
import { planSingleItemAction, type SingleItemActionState } from './actions';

const INITIAL: SingleItemActionState = { ok: false, message: '' };

function newRequestKey(): string {
  return `md02-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export default function SingleItemWorkbench({
  canPlan,
  canRegenerate,
  run,
  material,
  plant,
}: {
  canPlan: boolean;
  canRegenerate: boolean;
  run: MrpRunView | null;
  material: string;
  plant: string;
}) {
  const [state, action, pending] = useActionState(planSingleItemAction, INITIAL);
  const [requestKey, setRequestKey] = useState(newRequestKey);
  const shown = state.run ?? run;

  useEffect(() => {
    if (state.ok) setRequestKey(newRequestKey());
  }, [state]);

  return (
    <div className="space-y-4">
      <form action={action} className="rounded-card border border-line bg-surface p-4 shadow-card">
        <input type="hidden" name="requestKey" value={requestKey} />
        <input type="hidden" name="planningMode" value="1" />
        <input type="hidden" name="schedulingMode" value="BASIC" />
        <div className="grid gap-3 sm:grid-cols-3">
          <label className="block text-sm">
            <span className="mb-1 block text-ink-soft">{t('md02.material')}</span>
            <input name="materialNumber" required maxLength={40} defaultValue={material} className="input w-full" />
          </label>
          <label className="block text-sm">
            <span className="mb-1 block text-ink-soft">{t('md02.plant')}</span>
            <input name="plant" required maxLength={10} defaultValue={plant || '1000'} className="input w-full" />
          </label>
          <label className="block text-sm">
            <span className="mb-1 block text-ink-soft">{t('md02.version')}</span>
            <input name="productionVersion" maxLength={4} className="input w-full" />
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
          <label className="flex items-end gap-2 text-sm">
            <input type="checkbox" name="confirmRegenerative" disabled={!canRegenerate} />
            <span>{t('md01.confirm')}</span>
          </label>
        </div>
        <p className="mt-3 text-sm text-ink-soft">{t('md01.nothingPosted')} A check does not replace a standing proposal.</p>
        <div className="mt-3 flex flex-wrap gap-2">
          <button type="submit" name="intent" value="check" className="btn btn-default min-h-11 sm:min-h-8" disabled={!canPlan || pending}>
            {pending ? t('md01.checking') : t('md01.check')}
          </button>
          <button type="submit" name="intent" value="plan" className="btn btn-default min-h-11 sm:min-h-8" disabled={!canPlan || pending}>
            {pending ? t('md01.planning') : t('md01.plan')}
          </button>
        </div>
        {state.message && (
          <p role="status" className={`mt-2 text-sm ${state.ok ? 'text-ink' : 'text-red-700'}`}>
            {state.message}{state.remedy ? ` ${state.remedy}` : ''}
          </p>
        )}
      </form>

      {shown && (
        <section className="rounded-card border border-line bg-surface p-4 shadow-card" data-md02-run={shown.runNumber}>
          <h2 className="text-sm font-semibold">{t('md01.run')} {shown.runNumber}</h2>
          <dl className="mt-2 grid gap-2 text-sm sm:grid-cols-4">
            <div><dt className="text-ink-soft">{t('md01.status')}</dt><dd>{shown.status}</dd></div>
            <div><dt className="text-ink-soft">{t('md01.selected')}</dt><dd>{shown.materialsSelected}</dd></div>
            <div><dt className="text-ink-soft">{t('md01.created')}</dt><dd>{shown.proposalsCreated}</dd></div>
            <div><dt className="text-ink-soft">{t('md01.retained')}</dt><dd>{shown.proposalsRetained}</dd></div>
          </dl>
          <table className="mt-3 w-full text-sm">
            <thead>
              <tr className="text-left text-ink-faint">
                <th>{t('md02.level')}</th>
                <th>{t('md01.materials')}</th>
                <th>{t('md01.status')}</th>
                <th>{t('md01.diagnostics')}</th>
              </tr>
            </thead>
            <tbody>
              {shown.materials.map((row) => (
                <tr key={`${row.plant}/${row.materialNumber}`}>
                  <td className="py-1">{row.bomLevel}</td>
                  <td>
                    <Link href={`/production/stock-requirements?material=${encodeURIComponent(row.materialNumber)}&plant=${encodeURIComponent(row.plant)}`}>
                      {row.materialNumber}
                    </Link>
                  </td>
                  <td>{row.status}</td>
                  <td>{row.message}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {shown.dependents.length > 0 && (
            <table className="mt-3 w-full text-sm" data-md02-dependents>
              <thead>
                <tr className="text-left text-ink-faint">
                  <th>{t('md02.dependents')}</th>
                  <th>{t('md01.created')}</th>
                  <th>{t('md01.horizonStart')}</th>
                </tr>
              </thead>
              <tbody>
                {shown.dependents.map((row) => (
                  <tr key={`${row.parentOrderNumber ?? 'preview'}/${row.componentMaterial}/${row.requirementDate}`}>
                    <td className="py-1">{row.componentMaterial}</td>
                    <td>{row.quantity} {row.unit}</td>
                    <td>{row.requirementDate}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {shown.proposals.length > 0 && (
            <table className="mt-3 w-full text-sm">
              <thead>
                <tr className="text-left text-ink-faint">
                  <th>{t('md01.proposals')}</th>
                  <th>{t('md01.created')}</th>
                  <th>{t('md01.status')}</th>
                </tr>
              </thead>
              <tbody>
                {shown.proposals.map((row) => (
                  <tr key={row.lineNumber}>
                    <td className="py-1">{row.materialNumber} {row.proposalType} {row.documentNumber ?? '—'}</td>
                    <td>{row.action} {row.quantity}</td>
                    <td>{row.status}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {shown.diagnostics.length > 0 && (
            <ul className="mt-3 space-y-1 text-sm">
              {shown.diagnostics.map((row) => (
                <li key={row.lineNumber}>{row.severity} {row.diagnosticCode}: {row.message}</li>
              ))}
            </ul>
          )}
        </section>
      )}
    </div>
  );
}
