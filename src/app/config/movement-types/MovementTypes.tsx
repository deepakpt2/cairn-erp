'use client';

import { useActionState, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';

import type { MovementTypeRow } from '@/modules/inventory/movement-type-configuration';
import {
  MOVEMENT_ASSIGNMENTS,
  MOVEMENT_DIRECTIONS,
  MOVEMENT_KINDS,
  MOVEMENT_NEGATIVE_POLICIES,
  MOVEMENT_REFERENCES,
  MOVEMENT_RULES,
  MOVEMENT_STOCK_TYPES,
} from '@/modules/inventory/movement-type-vocabulary';
import {
  checkMovementTypeAction,
  deleteMovementTypeAction,
  saveMovementTypeAction,
  type MovementTypeActionState,
} from './actions';
import { ClaimFailureNotice, useChangeLockClaim } from '@/ui/lock/ChangeLock';
import { awaitingClaim } from '@/ui/lock/claim';

function RequiredMark() {
  return <span className="ms-1 text-signal-error" aria-hidden="true">*</span>;
}

function Message({ state }: { state: MovementTypeActionState }) {
  if (!state.message) return null;
  return (
    <div role={state.ok ? 'status' : 'alert'} className="border border-line bg-white p-3 text-sm text-ink">
      <p>{state.message}</p>
      {state.remedy && <p className="mt-1 text-xs text-ink-soft">{state.remedy}</p>}
    </div>
  );
}

const empty: MovementTypeActionState = { ok: false };

function citedByHistory(row: MovementTypeRow): boolean {
  return row.documentCount > 0 || row.reservationCount > 0;
}

function cited(row: MovementTypeRow): boolean {
  return citedByHistory(row) || row.namedAsReversal.length > 0;
}

export default function MovementTypes({
  movements,
  canMaintain,
}: {
  movements: MovementTypeRow[];
  canMaintain: boolean;
}) {
  const router = useRouter();
  const [selected, setSelected] = useState<string | null>(null);
  const [mode, setMode] = useState<'CREATE' | 'CHANGE'>('CHANGE');
  const [requestKey, setRequestKey] = useState('');
  const [deleteKey, setDeleteKey] = useState('');
  const [saveState, saveAction, savePending] = useActionState(saveMovementTypeAction, empty);
  const [checkState, checkAction, checkPending] = useActionState(checkMovementTypeAction, empty);
  const [deleteState, deleteAction, deletePending] = useActionState(deleteMovementTypeAction, empty);
  const row = movements.find((movement) => movement.movementType === selected) ?? null;
  const { claim, notice, retry } = useChangeLockClaim(
    'MOVEMENT_TYPE',
    mode === 'CHANGE' ? selected : null,
    'OMJJ',
    canMaintain && mode === 'CHANGE',
  );
  // Waiting for an answer and having none are different facts: the edit form still waits while the claim
  // is in flight, but a claim that never answered no longer hides the section it refuses to let be saved.
  // The reason is on the screen instead, with the one control that asks for the opening again.
  const waitingForLock = canMaintain && mode === 'CHANGE' && Boolean(selected) && awaitingClaim(claim);
  const lockedOut = claim.phase === 'refused';
  const granted = claim.phase === 'open';
  const frozen = mode === 'CHANGE' && row != null && citedByHistory(row);

  useEffect(() => {
    setRequestKey((current) => current || crypto.randomUUID());
    setDeleteKey((current) => current || crypto.randomUUID());
  }, []);

  useEffect(() => {
    if (saveState.replaceRequestKey) setRequestKey(crypto.randomUUID());
    if (!saveState.ok) return;
    if (saveState.movementType) {
      setMode('CHANGE');
      setSelected(saveState.movementType);
    }
    setRequestKey(crypto.randomUUID());
    router.refresh();
  }, [saveState, router]);

  useEffect(() => {
    if (!deleteState.ok) return;
    setSelected(null);
    setMode('CHANGE');
    setDeleteKey(crypto.randomUUID());
    setRequestKey(crypto.randomUUID());
    router.refresh();
  }, [deleteState, router]);

  function openCreate() {
    setMode('CREATE');
    setSelected(null);
    setRequestKey(crypto.randomUUID());
    setDeleteKey(crypto.randomUUID());
  }

  function openChange(movementType: string) {
    setMode('CHANGE');
    setSelected(movementType);
    setRequestKey(crypto.randomUUID());
    setDeleteKey(crypto.randomUUID());
  }

  const value = (field: keyof MovementTypeRow, fallback: string) => {
    if (mode === 'CHANGE' && row) return String(row[field] ?? '');
    return fallback;
  };

  return (
    <div className="space-y-4">
      <Message state={saveState} />
      <Message state={checkState} />
      <Message state={deleteState} />

      <section aria-labelledby="movement-types-heading" className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 id="movement-types-heading" className="text-base font-semibold">Movement types</h2>
          {canMaintain && (
            <button type="button" className="btn btn-default min-h-11" onClick={openCreate}>
              New movement type
            </button>
          )}
        </div>
        {movements.length === 0 ? (
          <p className="text-sm text-ink-soft">
            No movement type stands. Posting services deliver their own catalogue when they first post.
            A movement created here is not posted by this screen, and a posting service uses a movement only when that service already names it.
          </p>
        ) : (
          <div className="overflow-x-auto border border-line">
            <table className="w-full text-sm">
              <thead className="bg-paper text-left text-ink-soft">
                <tr>
                  <th className="px-3 py-2 font-medium">Movement type</th>
                  <th className="px-3 py-2 font-medium">Description</th>
                  <th className="px-3 py-2 font-medium">Direction</th>
                  <th className="px-3 py-2 font-medium">Reference</th>
                  <th className="px-3 py-2 font-medium">Reversal</th>
                  <th className="px-3 py-2 font-medium">Cited</th>
                </tr>
              </thead>
              <tbody>
                {movements.map((movement) => (
                  <tr key={movement.movementType} className="border-t border-line">
                    <td className="px-3 py-2">
                      <button
                        type="button"
                        className="code text-left underline"
                        onClick={() => openChange(movement.movementType)}
                      >
                        {movement.movementType}
                      </button>
                    </td>
                    <td className="px-3 py-2">{movement.description}</td>
                    <td className="px-3 py-2">{movement.direction}</td>
                    <td className="px-3 py-2">{movement.referenceCategory}</td>
                    <td className="px-3 py-2">{movement.reversalMovementType ?? '—'}</td>
                    <td className="px-3 py-2">{citedByHistory(movement) ? 'History' : cited(movement) ? 'Reversal' : 'No'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {lockedOut && notice.message && (
        <p role="status" className="border border-signal-warn/40 bg-amber-50 p-3 text-sm text-amber-800">{notice.message}</p>
      )}
      <ClaimFailureNotice claim={claim} onRetry={retry} />
      {canMaintain && (mode === 'CREATE' || (row && !lockedOut && !waitingForLock)) && (
        <form key={`${mode}-${selected ?? 'new'}`} action={saveAction} className="space-y-3 border border-line p-3">
          <h2 className="text-base font-semibold">
            {mode === 'CREATE' ? 'Create movement type' : `Change ${row?.movementType}`}
          </h2>
          {frozen && (
            <p role="status" className="text-sm text-ink-soft">
              This movement is already cited. The description can change. The posting rules cannot, and a posted document is not rewritten.
            </p>
          )}
          {row && row.namedAsReversal.length > 0 && (
            <p role="status" className="text-sm text-ink-soft">
              Named as the reversal of {row.namedAsReversal.join(', ')}. It cannot be deleted while that pairing stands.
            </p>
          )}
          <input type="hidden" name="mode" value={mode} />
          <input type="hidden" name="requestKey" value={requestKey} />
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <label htmlFor="movement-type-key" className="text-sm font-medium">
                Movement type<RequiredMark />
              </label>
              <input
                id="movement-type-key"
                name="movementType"
                required
                defaultValue={mode === 'CHANGE' ? row?.movementType : ''}
                readOnly={mode === 'CHANGE'}
                maxLength={20}
                className="input mt-1 w-full"
              />
            </div>
            <div>
              <label htmlFor="movement-type-description" className="text-sm font-medium">
                Description<RequiredMark />
              </label>
              <input
                id="movement-type-description"
                name="description"
                required
                maxLength={60}
                defaultValue={value('description', '')}
                className="input mt-1 w-full"
              />
            </div>
            <SelectField id="movement-type-direction" name="direction" label="Direction" options={MOVEMENT_DIRECTIONS} value={value('direction', 'RECEIPT')} frozen={frozen} />
            <SelectField id="movement-type-reference" name="referenceCategory" label="Reference" options={MOVEMENT_REFERENCES} value={value('referenceCategory', 'MATERIAL_DOCUMENT')} frozen={frozen} />
            <div>
              <label htmlFor="movement-type-reversal" className="text-sm font-medium">Reversal movement</label>
              <input
                id="movement-type-reversal"
                name="reversalMovementType"
                defaultValue={value('reversalMovementType', '')}
                readOnly={frozen}
                maxLength={20}
                className="input mt-1 w-full"
              />
            </div>
            <SelectField id="movement-type-kind" name="movementKind" label="Movement kind" options={MOVEMENT_KINDS} value={value('movementKind', 'MATERIAL')} frozen={frozen} />
            <SelectField id="movement-type-source" name="sourceStockType" label="Source stock type" options={['', ...MOVEMENT_STOCK_TYPES]} value={value('sourceStockType', '')} frozen={frozen} />
            <SelectField id="movement-type-destination" name="destinationStockType" label="Destination stock type" options={['', ...MOVEMENT_STOCK_TYPES]} value={value('destinationStockType', '')} frozen={frozen} />
            <SelectField id="movement-type-plant" name="plantRule" label="Plant rule" options={MOVEMENT_RULES} value={value('plantRule', 'ANY')} frozen={frozen} />
            <SelectField id="movement-type-location" name="locationRule" label="Storage location rule" options={MOVEMENT_RULES} value={value('locationRule', 'ANY')} frozen={frozen} />
            <SelectField id="movement-type-negative" name="negativeStockPolicy" label="Negative stock" options={MOVEMENT_NEGATIVE_POLICIES} value={value('negativeStockPolicy', 'LOCATION')} frozen={frozen} />
            <SelectField id="movement-type-assignment" name="accountAssignment" label="Account assignment" options={MOVEMENT_ASSIGNMENTS} value={value('accountAssignment', 'NONE')} frozen={frozen} />
            <div>
              <label htmlFor="movement-type-inventory-event" className="text-sm font-medium">Inventory event</label>
              <input
                id="movement-type-inventory-event"
                name="inventoryEvent"
                defaultValue={value('inventoryEvent', '')}
                readOnly={frozen}
                className="input mt-1 w-full"
              />
            </div>
            <div>
              <label htmlFor="movement-type-offset-event" className="text-sm font-medium">Offset event</label>
              <input
                id="movement-type-offset-event"
                name="offsetEvent"
                defaultValue={value('offsetEvent', '')}
                readOnly={frozen}
                className="input mt-1 w-full"
              />
            </div>
            <div>
              <label htmlFor="movement-type-modifier" className="text-sm font-medium">Account modifier</label>
              <input
                id="movement-type-modifier"
                name="offsetModifier"
                defaultValue={value('offsetModifier', '')}
                readOnly={frozen}
                maxLength={4}
                className="input mt-1 w-full"
              />
              <p className="mt-1 text-xs text-ink-soft">A determination input, not a G/L account.</p>
            </div>
            <div className="flex items-end">
              <label htmlFor="movement-type-valuation" className="flex items-center gap-2 text-sm font-medium">
                <input
                  id="movement-type-valuation"
                  name="valuationRelevant"
                  type="checkbox"
                  defaultChecked={mode === 'CHANGE' && row?.valuationRelevant === true}
                  disabled={frozen}
                />
                Valuation relevant
              </label>
              {frozen && row?.valuationRelevant && <input type="hidden" name="valuationRelevant" value="on" />}
            </div>
          </div>
          <div>
            <label htmlFor="movement-type-reason" className="text-sm font-medium">
              Reason<RequiredMark />
            </label>
            <input id="movement-type-reason" name="reason" required className="input mt-1 w-full" />
          </div>
          <div className="flex flex-wrap gap-2">
            {/* Creation holds no lock and the action does not ask for one; changing a row does, and the
                grant is what says this session may write. */}
            <button
              type="submit"
              className="btn btn-primary min-h-11"
              disabled={savePending || (mode === 'CHANGE' && !granted)}
            >
              Save
            </button>
          </div>
        </form>
      )}

      {canMaintain && row && !lockedOut && (
        <div className="flex flex-wrap gap-2">
          <form action={checkAction}>
            <input type="hidden" name="movementType" value={row.movementType} />
            <button type="submit" className="btn btn-default min-h-11" disabled={checkPending}>
              Check
            </button>
          </form>
          <form action={deleteAction} className="flex flex-wrap items-end gap-2">
            <input type="hidden" name="movementType" value={row.movementType} />
            <input type="hidden" name="requestKey" value={deleteKey} />
            <div>
              <label htmlFor="movement-type-delete-reason" className="text-sm font-medium">
                Delete reason<RequiredMark />
              </label>
              <input id="movement-type-delete-reason" name="reason" required className="input mt-1" />
            </div>
            <button type="submit" className="btn btn-default min-h-11" disabled={deletePending || !granted}>
              Delete
            </button>
          </form>
        </div>
      )}
    </div>
  );
}

function SelectField({
  id,
  name,
  label,
  options,
  value,
  frozen,
}: {
  id: string;
  name: string;
  label: string;
  options: readonly string[];
  value: string;
  frozen: boolean;
}) {
  return (
    <div>
      <label htmlFor={id} className="text-sm font-medium">{label}</label>
      {frozen ? (
        <input id={id} name={name} value={value} readOnly className="input mt-1 w-full" />
      ) : (
        <select id={id} name={name} defaultValue={value} className="input mt-1 w-full">
          {options.map((option) => (
            <option key={option || 'blank'} value={option}>{option || '—'}</option>
          ))}
        </select>
      )}
    </div>
  );
}
