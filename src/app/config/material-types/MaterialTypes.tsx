'use client';

import { useActionState, useState } from 'react';

import type {
  AccountCategoryReferenceRow,
  MaterialTypeRow,
  TypeValuationRow,
} from '@/modules/inventory/material-type-definition';
import type { MaterialRangeGroupOption } from '@/modules/inventory/material-number-range-groups';
import {
  deleteAccountCategoryReferenceAction,
  deleteMaterialTypeAction,
  saveAccountCategoryReferenceAction,
  saveMaterialTypeAction,
  saveTypeValuationAction,
  setMaterialTypeActiveAction,
  type MaterialTypeActionState,
} from './actions';

function RequiredMark() {
  return (
    <span className="ms-1 text-signal-error" aria-hidden="true">*</span>
  );
}

function Message({ state }: { state: MaterialTypeActionState }) {
  if (!state.message) return null;
  return (
    <div
      role={state.ok ? 'status' : 'alert'}
      className="border border-line bg-white p-3 text-sm text-ink"
    >
      <p>{state.message}</p>
      {state.remedy && <p className="mt-1 text-xs text-ink-soft">{state.remedy}</p>}
    </div>
  );
}

const PRICE_WORDS: Record<string, string> = {
  S: 'Standard price',
  V: 'Moving average price',
};
const PROCUREMENT_WORDS: Record<string, string> = {
  BUY: 'Buy',
  MAKE: 'Make',
  BOTH: 'Buy or make',
};
const PO_WORDS: Record<string, string> = {
  '0': 'Not allowed',
  '1': 'Allowed with warning',
  '2': 'Allowed',
};

function ReasonInput({ id }: { id: string }) {
  return (
    <div>
      <label htmlFor={id} className="text-sm font-medium">
        Reason<RequiredMark />
      </label>
      <input id={id} name="reason" required className="input mt-1 w-full" />
    </div>
  );
}

function DialogShell({
  title,
  children,
  onClose,
}: {
  title: string;
  children: React.ReactNode;
  onClose: () => void;
}) {
  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/30 p-4">
      <div className="w-full max-w-md space-y-3 border border-line bg-white p-4 shadow-lg">
        <div className="flex items-center justify-between">
          <h3 className="text-base font-semibold">{title}</h3>
          <button type="button" className="btn btn-default" onClick={onClose}>
            Close
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

export default function MaterialTypes({
  types,
  references,
  valuation,
  rangeGroups,
  canMaintain,
}: {
  types: MaterialTypeRow[];
  references: AccountCategoryReferenceRow[];
  valuation: TypeValuationRow[];
  rangeGroups: MaterialRangeGroupOption[];
  canMaintain: boolean;
}) {
  const [selected, setSelected] = useState<MaterialTypeRow | null>(null);
  const [selectedReference, setSelectedReference] =
    useState<AccountCategoryReferenceRow | null>(null);
  const [dialog, setDialog] = useState<
    | { kind: 'active'; row: MaterialTypeRow }
    | { kind: 'delete'; row: MaterialTypeRow }
    | { kind: 'deleteReference'; row: AccountCategoryReferenceRow }
    | null
  >(null);

  const [typeState, typeAction, typePending] = useActionState<
    MaterialTypeActionState,
    FormData
  >(saveMaterialTypeAction, { ok: true });
  const [referenceState, referenceAction, referencePending] = useActionState<
    MaterialTypeActionState,
    FormData
  >(saveAccountCategoryReferenceAction, { ok: true });
  const [activeState, activeAction] = useActionState<MaterialTypeActionState, FormData>(
    setMaterialTypeActiveAction,
    { ok: true },
  );
  const [deleteState, deleteAction] = useActionState<MaterialTypeActionState, FormData>(
    deleteMaterialTypeAction,
    { ok: true },
  );
  const [deleteRefState, deleteRefAction] = useActionState<
    MaterialTypeActionState,
    FormData
  >(deleteAccountCategoryReferenceAction, { ok: true });
  const [valuationState, valuationAction] = useActionState<
    MaterialTypeActionState,
    FormData
  >(saveTypeValuationAction, { ok: true });

  const formKey = selected ? selected.materialType : 'new';

  return (
    <div className="space-y-6">
      <section aria-labelledby="material-types-grid" className="space-y-3">
        <h2 id="material-types-grid" className="text-base font-semibold">
          Material types
        </h2>
        {types.length === 0 ? (
          <p className="text-sm text-ink-faint">No material types stand yet.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="border-b border-line text-ink-soft">
                  <th className="py-2 pe-3">Type</th>
                  <th className="py-2 pe-3">Description</th>
                  <th className="py-2 pe-3">Price control</th>
                  <th className="py-2 pe-3">Ranges (int / ext)</th>
                  <th className="py-2 pe-3">Account ref.</th>
                  <th className="py-2 pe-3">Purchase orders (ext / int)</th>
                  <th className="py-2 pe-3">Configurable</th>
                  <th className="py-2 pe-3">Materials</th>
                  <th className="py-2 pe-3">Status</th>
                  {canMaintain && <th className="py-2">Actions</th>}
                </tr>
              </thead>
              <tbody>
                {types.map((row) => (
                  <tr key={row.materialType} className="border-b border-line/60 align-top">
                    <td className="py-2 pe-3 font-medium">{row.materialType}</td>
                    <td className="py-2 pe-3">{row.name}</td>
                    <td className="py-2 pe-3">
                      {PRICE_WORDS[row.defaultPriceControl] ?? row.defaultPriceControl}
                    </td>
                    <td className="py-2 pe-3">
                      {row.internalNumberRange ?? '—'} / {row.externalNumberRange ?? '—'}
                      {row.rangeGroup && (
                        <span className="block text-xs text-ink-soft">{row.rangeGroup}</span>
                      )}
                    </td>
                    <td className="py-2 pe-3">{row.accountCategoryReference}</td>
                    <td className="py-2 pe-3">
                      {PO_WORDS[row.externalPurchaseOrders]} /{' '}
                      {PO_WORDS[row.internalPurchaseOrders]}
                    </td>
                    <td className="py-2 pe-3">{row.isConfigurable ? 'Yes' : 'No'}</td>
                    <td className="py-2 pe-3">{row.materialCount}</td>
                    <td className="py-2 pe-3">{row.isActive ? 'Active' : 'Inactive'}</td>
                    {canMaintain && (
                      <td className="py-2">
                        <div className="flex flex-wrap gap-2">
                          <button
                            type="button"
                            className="btn btn-default"
                            onClick={() => setSelected(row)}
                          >
                            Change
                          </button>
                          <button
                            type="button"
                            className="btn btn-default"
                            onClick={() => setDialog({ kind: 'active', row })}
                          >
                            {row.isActive ? 'Deactivate' : 'Reactivate'}
                          </button>
                          <button
                            type="button"
                            className="btn btn-default"
                            onClick={() => setDialog({ kind: 'delete', row })}
                          >
                            Delete
                          </button>
                        </div>
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {canMaintain && (
          <form
            key={formKey}
            action={typeAction}
            className="space-y-3 border border-line bg-white p-4"
          >
            <h3 className="text-sm font-semibold">
              {selected ? `Change material type ${selected.materialType}` : 'New material type'}
            </h3>
            <input type="hidden" name="mode" value={selected ? 'CHANGE' : 'CREATE'} />
            <div className="grid gap-3 sm:grid-cols-3">
              <div>
                <label htmlFor="mt-key" className="text-sm font-medium">
                  Material type<RequiredMark />
                </label>
                <input
                  id="mt-key"
                  name="materialType"
                  required
                  maxLength={4}
                  defaultValue={selected?.materialType ?? ''}
                  readOnly={!!selected}
                  className="input mt-1 w-full uppercase"
                />
              </div>
              <div className="sm:col-span-2">
                <label htmlFor="mt-name" className="text-sm font-medium">
                  Description<RequiredMark />
                </label>
                <input
                  id="mt-name"
                  name="name"
                  required
                  maxLength={25}
                  defaultValue={selected?.name ?? ''}
                  className="input mt-1 w-full"
                />
              </div>
              <div>
                <label htmlFor="mt-price" className="text-sm font-medium">
                  Default price control<RequiredMark />
                </label>
                <select
                  id="mt-price"
                  name="defaultPriceControl"
                  defaultValue={selected?.defaultPriceControl ?? 'V'}
                  className="input mt-1 w-full"
                >
                  <option value="S">Standard price</option>
                  <option value="V">Moving average price</option>
                </select>
              </div>
              <div>
                <label htmlFor="mt-procurement" className="text-sm font-medium">
                  Internal procurement default<RequiredMark />
                </label>
                <select
                  id="mt-procurement"
                  name="defaultProcurementType"
                  defaultValue={selected?.defaultProcurementType ?? 'BUY'}
                  className="input mt-1 w-full"
                >
                  {Object.entries(PROCUREMENT_WORDS).map(([code, word]) => (
                    <option key={code} value={code}>
                      {word}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label htmlFor="mt-ref" className="text-sm font-medium">
                  Account category reference<RequiredMark />
                </label>
                <select
                  id="mt-ref"
                  name="accountCategoryReference"
                  defaultValue={selected?.accountCategoryReference ?? references[0]?.reference ?? ''}
                  className="input mt-1 w-full"
                >
                  {references.map((r) => (
                    <option key={r.reference} value={r.reference}>
                      {r.reference} — {r.name}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label htmlFor="mt-range-group" className="text-sm font-medium">
                  Number range group
                </label>
                <select
                  id="mt-range-group"
                  defaultValue={
                    selected?.internalNumberRange && selected?.externalNumberRange
                      ? `${selected.internalNumberRange}/${selected.externalNumberRange}`
                      : ''
                  }
                  onChange={(e) => {
                    const group = rangeGroups.find(
                      (g) => `${g.internalKey}/${g.externalKey}` === e.target.value,
                    );
                    if (!group) return;
                    const internal = document.getElementById(
                      'mt-int-range',
                    ) as HTMLInputElement | null;
                    const external = document.getElementById(
                      'mt-ext-range',
                    ) as HTMLInputElement | null;
                    if (internal) internal.value = group.internalKey;
                    if (external) external.value = group.externalKey;
                  }}
                  className="input mt-1 w-full"
                >
                  <option value="">Fill both keys from a group</option>
                  {rangeGroups.map((g) => (
                    <option
                      key={`${g.internalKey}/${g.externalKey}`}
                      value={`${g.internalKey}/${g.externalKey}`}
                    >
                      {g.description} ({g.internalKey} / {g.externalKey})
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label htmlFor="mt-int-range" className="text-sm font-medium">
                  Internal number range<RequiredMark />
                </label>
                <input
                  id="mt-int-range"
                  name="internalNumberRange"
                  required
                  maxLength={2}
                  defaultValue={selected?.internalNumberRange ?? ''}
                  className="input mt-1 w-full uppercase"
                />
              </div>
              <div>
                <label htmlFor="mt-ext-range" className="text-sm font-medium">
                  External number range<RequiredMark />
                </label>
                <input
                  id="mt-ext-range"
                  name="externalNumberRange"
                  required
                  maxLength={2}
                  defaultValue={selected?.externalNumberRange ?? ''}
                  className="input mt-1 w-full uppercase"
                />
              </div>
              <div>
                <label htmlFor="mt-ext-po" className="text-sm font-medium">
                  External purchase orders<RequiredMark />
                </label>
                <select
                  id="mt-ext-po"
                  name="externalPurchaseOrders"
                  defaultValue={selected?.externalPurchaseOrders ?? '2'}
                  className="input mt-1 w-full"
                >
                  {Object.entries(PO_WORDS).map(([code, word]) => (
                    <option key={code} value={code}>
                      {word}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label htmlFor="mt-int-po" className="text-sm font-medium">
                  Internal purchase orders<RequiredMark />
                </label>
                <select
                  id="mt-int-po"
                  name="internalPurchaseOrders"
                  defaultValue={selected?.internalPurchaseOrders ?? '1'}
                  className="input mt-1 w-full"
                >
                  {Object.entries(PO_WORDS).map(([code, word]) => (
                    <option key={code} value={code}>
                      {word}
                    </option>
                  ))}
                </select>
              </div>
              <div className="flex items-end gap-2 pb-1">
                <input
                  id="mt-configurable"
                  name="isConfigurable"
                  type="checkbox"
                  defaultChecked={selected?.isConfigurable ?? false}
                  className="h-4 w-4"
                />
                <label htmlFor="mt-configurable" className="text-sm">
                  Configurable materials
                </label>
              </div>
              <div className="sm:col-span-2">
                <ReasonInput id="mt-reason" />
              </div>
            </div>
            <p className="max-w-3xl text-xs text-ink-soft">
              Number ranges are judged against the ranges standing for object MATERIAL on the
              number ranges screen, internal against internal and external against external.
            </p>
            <div className="flex gap-2">
              <button type="submit" className="btn btn-primary" disabled={typePending}>
                {selected ? 'Save changes' : 'Define material type'}
              </button>
              {selected && (
                <button
                  type="button"
                  className="btn btn-default"
                  onClick={() => setSelected(null)}
                >
                  New material type
                </button>
              )}
            </div>
            <Message state={typeState} />
          </form>
        )}
      </section>

      <section aria-labelledby="account-category-references" className="space-y-3">
        <h2 id="account-category-references" className="text-base font-semibold">
          Account category references
        </h2>
        {references.length === 0 ? (
          <p className="text-sm text-ink-faint">No references stand yet.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="border-b border-line text-ink-soft">
                  <th className="py-2 pe-3">Reference</th>
                  <th className="py-2 pe-3">Name</th>
                  <th className="py-2 pe-3">Types naming it</th>
                  {canMaintain && <th className="py-2">Actions</th>}
                </tr>
              </thead>
              <tbody>
                {references.map((row) => (
                  <tr key={row.reference} className="border-b border-line/60">
                    <td className="py-2 pe-3 font-medium">{row.reference}</td>
                    <td className="py-2 pe-3">{row.name}</td>
                    <td className="py-2 pe-3">{row.typeCount}</td>
                    {canMaintain && (
                      <td className="py-2">
                        <div className="flex gap-2">
                          <button
                            type="button"
                            className="btn btn-default"
                            onClick={() => setSelectedReference(row)}
                          >
                            Change
                          </button>
                          <button
                            type="button"
                            className="btn btn-default"
                            onClick={() => setDialog({ kind: 'deleteReference', row })}
                          >
                            Delete
                          </button>
                        </div>
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {canMaintain && (
          <form
            key={selectedReference ? selectedReference.reference : 'new-ref'}
            action={referenceAction}
            className="space-y-3 border border-line bg-white p-4"
          >
            <h3 className="text-sm font-semibold">
              {selectedReference
                ? `Change reference ${selectedReference.reference}`
                : 'New account category reference'}
            </h3>
            <input
              type="hidden"
              name="mode"
              value={selectedReference ? 'CHANGE' : 'CREATE'}
            />
            <div className="grid gap-3 sm:grid-cols-3">
              <div>
                <label htmlFor="ref-key" className="text-sm font-medium">
                  Reference<RequiredMark />
                </label>
                <input
                  id="ref-key"
                  name="reference"
                  required
                  maxLength={4}
                  defaultValue={selectedReference?.reference ?? ''}
                  readOnly={!!selectedReference}
                  className="input mt-1 w-full uppercase"
                />
              </div>
              <div>
                <label htmlFor="ref-name" className="text-sm font-medium">
                  Name<RequiredMark />
                </label>
                <input
                  id="ref-name"
                  name="name"
                  required
                  maxLength={40}
                  defaultValue={selectedReference?.name ?? ''}
                  className="input mt-1 w-full"
                />
              </div>
              <ReasonInput id="ref-reason" />
            </div>
            <div className="flex gap-2">
              <button type="submit" className="btn btn-primary" disabled={referencePending}>
                {selectedReference ? 'Save changes' : 'Define reference'}
              </button>
              {selectedReference && (
                <button
                  type="button"
                  className="btn btn-default"
                  onClick={() => setSelectedReference(null)}
                >
                  New reference
                </button>
              )}
            </div>
            <Message state={referenceState} />
          </form>
        )}
      </section>

      <section aria-labelledby="material-type-valuation" className="space-y-3">
        <h2 id="material-type-valuation" className="text-base font-semibold">
          Quantity and value updating
        </h2>
        <p className="max-w-3xl text-sm text-ink-soft">
          Updating is decided per type and plant. A change is refused while materials of the
          type stand at the plant, so standing materials never change behaviour silently.
        </p>
        {valuation.length === 0 ? (
          <p className="text-sm text-ink-faint">
            No updating rows stand: either no types or no plants stand yet.
          </p>
        ) : (
          <div className="space-y-2">
            {valuation.map((row) => (
              <form
                key={`${row.materialType}-${row.plant}`}
                action={valuationAction}
                className="flex flex-wrap items-end gap-3 border border-line bg-white p-3"
              >
                <input type="hidden" name="materialType" value={row.materialType} />
                <input type="hidden" name="plant" value={row.plant} />
                <span className="text-sm font-medium">
                  {row.materialType} at {row.plant}
                  <span className="block text-xs font-normal text-ink-soft">
                    {row.plantName} · {row.materialCount} materials standing
                    {row.stands ? '' : ' · updating stands as the default until saved'}
                  </span>
                </span>
                <label className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    name="quantityUpdating"
                    defaultChecked={row.quantityUpdating}
                    disabled={!canMaintain}
                    className="h-4 w-4"
                  />
                  Quantity updating
                </label>
                <label className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    name="valueUpdating"
                    defaultChecked={row.valueUpdating}
                    disabled={!canMaintain}
                    className="h-4 w-4"
                  />
                  Value updating
                </label>
                {canMaintain && (
                  <>
                    <div className="min-w-48 flex-1">
                      <ReasonInput id={`val-reason-${row.materialType}-${row.plant}`} />
                    </div>
                    <button type="submit" className="btn btn-default">
                      Save updating
                    </button>
                  </>
                )}
              </form>
            ))}
            <Message state={valuationState} />
          </div>
        )}
      </section>

      {dialog?.kind === 'active' && (
        <DialogShell
          title={`${dialog.row.isActive ? 'Deactivate' : 'Reactivate'} material type ${dialog.row.materialType}`}
          onClose={() => setDialog(null)}
        >
          <form action={activeAction} className="space-y-3">
            <input type="hidden" name="materialType" value={dialog.row.materialType} />
            <input type="hidden" name="active" value={dialog.row.isActive ? 'false' : 'true'} />
            <p className="text-sm text-ink-soft">
              {dialog.row.isActive
                ? 'A deactivated type stops new materials; its standing materials keep it. Reactivate it here at any time.'
                : 'The type becomes available to new materials again.'}
            </p>
            <ReasonInput id="dlg-active-reason" />
            <button type="submit" className="btn btn-primary">
              {dialog.row.isActive ? 'Deactivate' : 'Reactivate'}
            </button>
            <Message state={activeState} />
          </form>
        </DialogShell>
      )}
      {dialog?.kind === 'delete' && (
        <DialogShell
          title={`Delete material type ${dialog.row.materialType}`}
          onClose={() => setDialog(null)}
        >
          <form action={deleteAction} className="space-y-3">
            <input type="hidden" name="materialType" value={dialog.row.materialType} />
            <p className="text-sm text-ink-soft">
              Deletion is refused while materials carry the type —{' '}
              {dialog.row.materialCount} stand against it now. Its updating rows go with it;
              references and materials stand.
            </p>
            <ReasonInput id="dlg-delete-reason" />
            <button type="submit" className="btn btn-primary">
              Delete
            </button>
            <Message state={deleteState} />
          </form>
        </DialogShell>
      )}
      {dialog?.kind === 'deleteReference' && (
        <DialogShell
          title={`Delete account category reference ${dialog.row.reference}`}
          onClose={() => setDialog(null)}
        >
          <form action={deleteRefAction} className="space-y-3">
            <input type="hidden" name="reference" value={dialog.row.reference} />
            <p className="text-sm text-ink-soft">
              Deletion is refused while material types name the reference —{' '}
              {dialog.row.typeCount} name it now.
            </p>
            <ReasonInput id="dlg-delete-ref-reason" />
            <button type="submit" className="btn btn-primary">
              Delete
            </button>
            <Message state={deleteRefState} />
          </form>
        </DialogShell>
      )}
    </div>
  );
}
