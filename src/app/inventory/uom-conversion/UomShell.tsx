'use client';

/**
 * SCR-144 / INV.STOCK.UOM — the conversion table, kept deliberately plain.
 *
 * A conversion is a statement about one material: how many base units one alternative unit
 * carries. The screen therefore shows the ratio it imported, never a decimal it computed —
 * 1/3 stays 1/3 — and the delete button removes exactly the row it sits on.
 */
import { useActionState, useState } from 'react';
import { LockNotice, useChangeLock } from '@/ui/lock/ChangeLock';

import { t } from '@/platform/i18n';
import type { UomConversionRow } from '@/modules/inventory/unit-conversion';
import {
  defineConversionAction,
  deleteConversionAction,
  type DeleteConversionState,
  type UomActionState,
} from './actions';

const INITIAL: UomActionState = { ok: false, message: '' };
const INITIAL_DELETE: DeleteConversionState = { ok: false, message: '' };

export default function UomShell({
  canMaintain,
  rows,
  units,
}: {
  canMaintain: boolean;
  rows: UomConversionRow[];
  units: Array<{ code: string; name: string }>;
}) {
  const [state, action, saving] = useActionState(defineConversionAction, INITIAL);
  const [removal, removeAction, removing] = useActionState(deleteConversionAction, INITIAL_DELETE);
  const [material, setMaterial] = useState('');
  const [unit, setUnit] = useState('');
  const [engaged, setEngaged] = useState(false);
  const pair = `${material.trim().toUpperCase()}/${unit.trim().toUpperCase()}`;
  const changing = Boolean(material.trim() && unit.trim()) && rows.some((row) => `${row.materialNumber}/${row.alternativeUnit}`.toUpperCase() === pair);
  const defineLock = useChangeLock('UOM_CONVERSION', pair, 'INV.STOCK.UOM', engaged && changing && canMaintain);

  return (
    <>
      <section aria-labelledby="uom-define" className="rounded-card border border-line bg-surface p-4 shadow-card">
        <h2 id="uom-define" className="text-sm font-semibold">{t('uom.defineHeader')}</h2>
        <p className="mt-1 text-sm text-ink-soft">{t('uom.defineHint')}</p>
        <p role="status" className={`mt-2 text-sm ${state.ok ? 'text-ink' : 'text-red-700'}`}>
          {state.message}{state.remedy ? ` ${state.remedy}` : ''}
        </p>
        <form
          action={action}
          onFocus={() => setEngaged(true)}
          onSubmit={(event) => {
            if (changing && defineLock?.mode !== 'CHANGE') event.preventDefault();
          }}
        >
          <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <label className="block">
              <span className="field-label">{t('uom.material')}</span>
              <input name="materialNumber" className="input w-full" placeholder="MAT-…" required value={material} onChange={(event) => setMaterial(event.target.value)} />
            </label>
            <label className="block">
              <span className="field-label">{t('uom.alternativeUnit')}</span>
              <select name="alternativeUnit" className="input w-full" value={unit} required onChange={(event) => setUnit(event.target.value)}>
                <option value="" disabled>{t('uom.chooseUnit')}</option>
                {units.map((unit) => (
                  <option key={unit.code} value={unit.code}>{unit.code} — {unit.name}</option>
                ))}
              </select>
            </label>
            <label className="block">
              <span className="field-label">{t('uom.numerator')}</span>
              <input name="numerator" type="number" min="1" step="1" className="input w-full text-right" required />
            </label>
            <label className="block">
              <span className="field-label">{t('uom.denominator')}</span>
              <input name="denominator" type="number" min="1" step="1" className="input w-full text-right" defaultValue="1" required />
            </label>
          </div>
          <div className="mt-3 flex flex-wrap items-center gap-3">
            <LockNotice message={changing && defineLock?.mode === 'DISPLAY' ? defineLock.message : null} />
            <button type="submit" className="btn btn-primary min-h-11 sm:min-h-8" disabled={!canMaintain || saving || (changing && defineLock?.mode === 'DISPLAY')}>
              {saving ? t('uom.saving') : t('uom.save')}
            </button>
            {!canMaintain && <p className="text-sm text-ink-soft">{t('uom.noMaintain')}</p>}
          </div>
        </form>
      </section>

      <section aria-labelledby="uom-list" className="rounded-card border border-line bg-surface p-4 shadow-card">
        <h2 id="uom-list" className="text-sm font-semibold">{t('uom.listHeader')}</h2>
        <p role="status" className={`mt-2 text-sm ${removal.ok ? 'text-ink' : 'text-red-700'}`}>
          {removal.message}
        </p>
        {rows.length === 0 ? (
          <p className="mt-2 text-sm text-ink-soft">{t('uom.empty')}</p>
        ) : (
          <table className="mt-3 w-full text-sm">
            <thead>
              <tr className="text-left text-xs uppercase tracking-wide text-ink-faint">
                <th className="py-1">{t('uom.material')}</th>
                <th className="py-1">{t('uom.description')}</th>
                <th className="py-1">{t('uom.baseUnit')}</th>
                <th className="py-1">{t('uom.alternativeUnit')}</th>
                <th className="py-1 text-right">{t('uom.ratio')}</th>
                <th className="py-1" />
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr
                  key={`${row.materialNumber}/${row.alternativeUnit}`}
                  className="border-t border-line"
                  data-conversion={`${row.materialNumber}/${row.alternativeUnit}`}
                >
                  <td className="py-1 code">{row.materialNumber}</td>
                  <td className="py-1">{row.materialDescription}</td>
                  <td className="py-1 code">{row.baseUnit}</td>
                  <td className="py-1 code" data-alternative-unit={row.alternativeUnit}>{row.alternativeUnit}</td>
                  <td className="py-1 text-right tabular" data-ratio={row.factor}>
                    1 {row.alternativeUnit} = {row.numerator}/{row.denominator} {row.baseUnit}
                  </td>
                  <td className="py-1 text-right">
                    <RemoveConversion row={row} action={removeAction} canMaintain={canMaintain} pending={removing} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </>
  );
}

function RemoveConversion({
  row,
  action,
  canMaintain,
  pending,
}: {
  row: UomConversionRow;
  action: (form: FormData) => void;
  canMaintain: boolean;
  pending: boolean;
}) {
  const [engaged, setEngaged] = useState(false);
  const lock = useChangeLock(
    'UOM_CONVERSION',
    `${row.materialNumber}/${row.alternativeUnit}`,
    'INV.STOCK.UOM',
    engaged && canMaintain,
  );
  return (
    <form
      action={action}
      onFocus={() => setEngaged(true)}
      onSubmit={(event) => {
        if (lock?.mode !== 'CHANGE') event.preventDefault();
      }}
    >
      <input type="hidden" name="materialNumber" value={row.materialNumber} />
      <input type="hidden" name="alternativeUnit" value={row.alternativeUnit} />
      <LockNotice message={lock?.mode === 'DISPLAY' ? lock.message : null} />
      <button
        type="submit"
        className="btn min-h-11 sm:min-h-8"
        disabled={!canMaintain || pending || lock?.mode === 'DISPLAY'}
        data-remove-conversion
      >
        {t('uom.remove')}
      </button>
    </form>
  );
}
