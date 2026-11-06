'use client';

import { useActionState } from 'react';

import { t } from '@/platform/i18n';
import {
  setDeliveryCompletionPlantAction,
  setDeliveryCompletionPolicyAction,
  type DeliveryCompletionActionState,
} from './actions';

interface CompanyRow {
  companyCode: string;
  name: string;
  autoClose: boolean;
}

interface PlantRow {
  plant: string;
  name: string;
  companyCode: string | null;
  autoClose: boolean | null;
}

const BLANK: DeliveryCompletionActionState = { ok: false };

function RuleSelect({ name, value, allowInherit }: { name: string; value: string; allowInherit: boolean }) {
  return (
    <select name={name} defaultValue={value} className="input w-full" aria-label={t('deliveryCompletion.rule')}>
      {allowInherit && <option value="">{t('deliveryCompletion.inherit')}</option>}
      <option value="true">{t('deliveryCompletion.yes')}</option>
      <option value="false">{t('deliveryCompletion.no')}</option>
    </select>
  );
}

function Result({ state }: { state: DeliveryCompletionActionState }) {
  if (!state.message) return null;
  return (
    <p role={state.ok ? 'status' : 'alert'} className="text-xs text-ink-soft">
      {state.message}
    </p>
  );
}

function CompanyRule({ row, canMaintain }: { row: CompanyRow; canMaintain: boolean }) {
  const [state, action, pending] = useActionState(setDeliveryCompletionPolicyAction, BLANK);
  return (
    <tr className="border-t border-line">
      <td className="px-2 py-2 align-top">
        <span className="code">{row.companyCode}</span>
        <p className="text-xs text-ink-soft">{row.name}</p>
      </td>
      <td className="px-2 py-2 align-top">
        <form action={action} className="space-y-1">
          <input type="hidden" name="companyCode" value={row.companyCode} />
          <RuleSelect name="autoClose" value={row.autoClose ? 'true' : 'false'} allowInherit={false} />
          <button
            type="submit"
            className="btn btn-default min-h-11 w-full sm:min-h-8"
            disabled={!canMaintain || pending}
          >
            {t('deliveryCompletion.save')}
          </button>
          <Result state={state} />
        </form>
      </td>
    </tr>
  );
}

function PlantRule({ row, canMaintain }: { row: PlantRow; canMaintain: boolean }) {
  const [state, action, pending] = useActionState(setDeliveryCompletionPlantAction, BLANK);
  return (
    <tr className="border-t border-line">
      <td className="px-2 py-2 align-top">
        <span className="code">{row.plant}</span>
        <p className="text-xs text-ink-soft">{row.name}</p>
      </td>
      <td className="px-2 py-2 align-top text-sm text-ink-soft">{row.companyCode ?? '—'}</td>
      <td className="px-2 py-2 align-top">
        <form action={action} className="space-y-1">
          <input type="hidden" name="plant" value={row.plant} />
          <RuleSelect
            name="autoClose"
            value={row.autoClose == null ? '' : row.autoClose ? 'true' : 'false'}
            allowInherit
          />
          <button
            type="submit"
            className="btn btn-default min-h-11 w-full sm:min-h-8"
            disabled={!canMaintain || pending}
          >
            {t('deliveryCompletion.save')}
          </button>
          <Result state={state} />
        </form>
      </td>
    </tr>
  );
}

export default function DeliveryCompletion({
  companies,
  plants,
  canMaintain,
}: {
  companies: CompanyRow[];
  plants: PlantRow[];
  canMaintain: boolean;
}) {
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <section className="border border-line bg-white">
        <h2 className="border-b border-line px-3 py-2 text-sm font-semibold">
          {t('deliveryCompletion.companySection')}
        </h2>
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-xs uppercase tracking-wide text-ink-faint">
              <th className="px-2 py-2">{t('deliveryCompletion.companyColumn')}</th>
              <th className="px-2 py-2">{t('deliveryCompletion.rule')}</th>
            </tr>
          </thead>
          <tbody>
            {companies.map((row) => (
              <CompanyRule key={row.companyCode} row={row} canMaintain={canMaintain} />
            ))}
          </tbody>
        </table>
      </section>

      <section className="border border-line bg-white">
        <h2 className="border-b border-line px-3 py-2 text-sm font-semibold">
          {t('deliveryCompletion.plantSection')}
        </h2>
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-xs uppercase tracking-wide text-ink-faint">
              <th className="px-2 py-2">{t('deliveryCompletion.plantColumn')}</th>
              <th className="px-2 py-2">{t('deliveryCompletion.companyColumn')}</th>
              <th className="px-2 py-2">{t('deliveryCompletion.rule')}</th>
            </tr>
          </thead>
          <tbody>
            {plants.map((row) => (
              <PlantRule key={row.plant} row={row} canMaintain={canMaintain} />
            ))}
          </tbody>
        </table>
      </section>
    </div>
  );
}
