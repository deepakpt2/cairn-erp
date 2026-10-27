'use client';

import { useActionState, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';

import type {
  TypeReferenceRow,
  ValuationClassRow,
  ValuationReferenceRow,
} from '@/modules/inventory/valuation-class-definition';
import { ClaimFailureNotice, useChangeLockClaim } from '@/ui/lock/ChangeLock';
import {
  assignTypeAction,
  checkValuationAction,
  deleteClassAction,
  deleteReferenceAction,
  saveClassAction,
  saveReferenceAction,
  type ValuationClassActionState,
} from './actions';

function RequiredMark() {
  return <span className="ms-1 text-signal-error" aria-hidden="true">*</span>;
}

function Message({ state }: { state: ValuationClassActionState }) {
  if (!state.message) return null;
  return (
    <div role={state.ok ? 'status' : 'alert'} className="border border-line bg-white p-3 text-sm text-ink">
      <p>{state.message}</p>
      {state.remedy && <p className="mt-1 text-xs text-ink-soft">{state.remedy}</p>}
    </div>
  );
}

const empty: ValuationClassActionState = { ok: false };

export default function ValuationClasses({
  references,
  classes,
  types,
  gaps,
  canMaintain,
}: {
  references: ValuationReferenceRow[];
  classes: ValuationClassRow[];
  types: TypeReferenceRow[];
  gaps: string[];
  canMaintain: boolean;
}) {
  const router = useRouter();
  const [referenceMode, setReferenceMode] = useState<'CREATE' | 'CHANGE'>('CHANGE');
  const [selectedReference, setSelectedReference] = useState<string | null>(null);
  const [classMode, setClassMode] = useState<'CREATE' | 'CHANGE'>('CHANGE');
  const [selectedClass, setSelectedClass] = useState<string | null>(null);
  const [selectedType, setSelectedType] = useState<string | null>(null);
  const [requestKey, setRequestKey] = useState('');
  const [saveReferenceState, saveReference, referencePending] = useActionState(saveReferenceAction, empty);
  const [deleteReferenceState, deleteReference, deleteReferencePending] = useActionState(deleteReferenceAction, empty);
  const [saveClassState, saveClass, classPending] = useActionState(saveClassAction, empty);
  const [deleteClassState, deleteClass, deleteClassPending] = useActionState(deleteClassAction, empty);
  const [assignState, assignType, assignPending] = useActionState(assignTypeAction, empty);
  const [checkState, checkConfig, checkPending] = useActionState(checkValuationAction, empty);

  const referenceRow = references.find((row) => row.reference === selectedReference) ?? null;
  const classRow = classes.find((row) => row.valuationClass === selectedClass) ?? null;
  const typeRow = types.find((row) => row.materialType === selectedType) ?? null;
  const { claim: referenceClaim, notice: referenceNotice, retry: referenceRetry } = useChangeLockClaim(
    'ACCOUNT_CATEGORY_REFERENCE',
    referenceMode === 'CHANGE' ? selectedReference : null,
    'CFG.INV.VALCLASS.DEFINE',
    canMaintain && referenceMode === 'CHANGE',
  );
  const { claim: classClaim, notice: classNotice, retry: classRetry } = useChangeLockClaim(
    'VALUATION_CLASS',
    classMode === 'CHANGE' ? selectedClass : null,
    'CFG.INV.VALCLASS.DEFINE',
    canMaintain && classMode === 'CHANGE',
  );
  const { claim: typeClaim, notice: typeNotice, retry: typeRetry } = useChangeLockClaim(
    'MATERIAL_TYPE',
    selectedType,
    'CFG.INV.VALCLASS.DEFINE',
    canMaintain && !!selectedType,
  );
  // The three sections are refused, granted and failed on their own, so each reads its own claim: a
  // display-only answer is another session's opening, with its recovery sentence, and a claim that never
  // answered is a failure of this one. Only a grant lets a section be worked on, which is what the
  // conditions below already enforced through the projected answer, now said in the words the claim owns.
  const referenceLocked = referenceClaim.phase === 'refused';
  const classLocked = classClaim.phase === 'refused';
  const typeLocked = typeClaim.phase === 'refused';
  const referenceGranted = referenceClaim.phase === 'open';
  const classGranted = classClaim.phase === 'open';
  const typeGranted = typeClaim.phase === 'open';

  useEffect(() => {
    setRequestKey((current) => current || crypto.randomUUID());
  }, []);

  useEffect(() => {
    if (saveReferenceState.replaceRequestKey || saveClassState.replaceRequestKey || assignState.replaceRequestKey) {
      setRequestKey(crypto.randomUUID());
    }
    if (saveReferenceState.ok && saveReferenceState.reference) {
      setReferenceMode('CHANGE');
      setSelectedReference(saveReferenceState.reference);
      setRequestKey(crypto.randomUUID());
      router.refresh();
    }
  }, [saveReferenceState, saveClassState.replaceRequestKey, assignState.replaceRequestKey, router]);

  useEffect(() => {
    if (!saveClassState.ok) return;
    if (saveClassState.valuationClass) {
      setClassMode('CHANGE');
      setSelectedClass(saveClassState.valuationClass);
    }
    setRequestKey(crypto.randomUUID());
    router.refresh();
  }, [saveClassState, router]);

  useEffect(() => {
    if (!deleteReferenceState.ok && !deleteClassState.ok && !assignState.ok) return;
    if (deleteReferenceState.ok) setSelectedReference(null);
    if (deleteClassState.ok) setSelectedClass(null);
    setRequestKey(crypto.randomUUID());
    router.refresh();
  }, [deleteReferenceState, deleteClassState, assignState.ok, router]);

  return (
    <div className="space-y-6">
      <Message state={saveReferenceState} />
      <Message state={deleteReferenceState} />
      <Message state={saveClassState} />
      <Message state={deleteClassState} />
      <Message state={assignState} />
      <Message state={checkState} />

      <section aria-labelledby="valuation-gaps" className="space-y-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 id="valuation-gaps" className="text-base font-semibold">Consistency</h2>
          <form action={checkConfig}>
            <button type="submit" className="btn btn-default min-h-11" disabled={checkPending}>
              {checkPending ? 'Checking' : 'Check'}
            </button>
          </form>
        </div>
        {gaps.length === 0 ? (
          <p className="text-sm text-ink-soft">No gap stands. A check writes nothing, and a closed posting period does not block this screen.</p>
        ) : (
          <ul className="space-y-1 text-sm text-ink">
            {gaps.map((gap) => <li key={gap}>{gap}</li>)}
          </ul>
        )}
      </section>

      <section aria-labelledby="account-references" className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 id="account-references" className="text-base font-semibold">Account category references</h2>
          {canMaintain && (
            <button type="button" className="btn btn-default min-h-11" onClick={() => { setReferenceMode('CREATE'); setSelectedReference(null); setRequestKey(crypto.randomUUID()); }}>
              New reference
            </button>
          )}
        </div>
        <div className="overflow-x-auto border border-line">
          <table className="w-full text-sm">
            <thead className="bg-paper text-left text-ink-soft">
              <tr>
                <th className="px-3 py-2 font-medium">Reference</th>
                <th className="px-3 py-2 font-medium">Description</th>
                <th className="px-3 py-2 font-medium">Active</th>
                <th className="px-3 py-2 font-medium">Version</th>
                <th className="px-3 py-2 font-medium">Types</th>
                <th className="px-3 py-2 font-medium">Classes</th>
              </tr>
            </thead>
            <tbody>
              {references.map((row) => (
                <tr key={row.reference} className="border-t border-line">
                  <td className="px-3 py-2">
                    <button type="button" className="code text-left underline" onClick={() => { setReferenceMode('CHANGE'); setSelectedReference(row.reference); setRequestKey(crypto.randomUUID()); }}>
                      {row.reference}
                    </button>
                  </td>
                  <td className="px-3 py-2">{row.name}</td>
                  <td className="px-3 py-2">{row.isActive ? 'Yes' : 'No'}</td>
                  <td className="px-3 py-2">{row.version}</td>
                  <td className="px-3 py-2">{row.typeCount}</td>
                  <td className="px-3 py-2">{row.classCount}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {referenceLocked && referenceNotice.message && (
          <p role="status" className="border border-signal-warn/40 bg-amber-50 p-3 text-sm text-amber-800">{referenceNotice.message}</p>
        )}
        <ClaimFailureNotice claim={referenceClaim} onRetry={referenceRetry} />
        {canMaintain && (referenceMode === 'CREATE' || (referenceRow && !referenceLocked && referenceGranted)) && (
          <form key={`reference-${referenceMode}-${selectedReference ?? 'new'}-${referenceRow?.version ?? 0}`} action={saveReference} className="space-y-3 border border-line p-3">
            <h3 className="text-sm font-semibold">{referenceMode === 'CREATE' ? 'Create reference' : `Change reference ${referenceRow?.reference}`}</h3>
            <input type="hidden" name="mode" value={referenceMode} />
            <input type="hidden" name="requestKey" value={requestKey} />
            <input type="hidden" name="expectedVersion" value={referenceMode === 'CHANGE' ? referenceRow?.version ?? 0 : 0} />
            <div className="grid gap-3 sm:grid-cols-2">
              <div>
                <label htmlFor="reference-key" className="text-sm font-medium">Account category reference<RequiredMark /></label>
                <input id="reference-key" name="reference" required maxLength={4} defaultValue={referenceMode === 'CHANGE' ? referenceRow?.reference : ''} readOnly={referenceMode === 'CHANGE'} className="input mt-1 w-full" />
              </div>
              <div>
                <label htmlFor="reference-name" className="text-sm font-medium">Description<RequiredMark /></label>
                <input id="reference-name" name="name" required maxLength={60} defaultValue={referenceRow?.name ?? ''} className="input mt-1 w-full" />
              </div>
            </div>
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" name="isActive" defaultChecked={referenceRow?.isActive ?? true} />
              Active
            </label>
            <div>
              <label htmlFor="reference-reason" className="text-sm font-medium">Reason<RequiredMark /></label>
              <input id="reference-reason" name="reason" required maxLength={500} className="input mt-1 w-full" />
            </div>
            <button type="submit" className="btn btn-primary min-h-11" disabled={referencePending}>Save reference</button>
          </form>
        )}
        {canMaintain && referenceRow && !referenceLocked && referenceGranted && (
          <form action={deleteReference} className="space-y-3 border border-line p-3">
            <p className="text-sm text-ink-soft">Delete is refused while a material type or a valuation class names this reference. Nothing is rewritten.</p>
            <input type="hidden" name="reference" value={referenceRow.reference} />
            <input type="hidden" name="expectedVersion" value={referenceRow.version} />
            <input type="hidden" name="requestKey" value={requestKey} />
            <div>
              <label htmlFor="reference-delete-reason" className="text-sm font-medium">Reason for deletion<RequiredMark /></label>
              <input id="reference-delete-reason" name="reason" required maxLength={500} className="input mt-1 w-full" />
            </div>
            <button type="submit" className="btn btn-default min-h-11" disabled={deleteReferencePending}>Delete reference</button>
          </form>
        )}
      </section>

      <section aria-labelledby="valuation-classes" className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 id="valuation-classes" className="text-base font-semibold">Valuation classes</h2>
          {canMaintain && (
            <button type="button" className="btn btn-default min-h-11" onClick={() => { setClassMode('CREATE'); setSelectedClass(null); setRequestKey(crypto.randomUUID()); }}>
              New valuation class
            </button>
          )}
        </div>
        <div className="overflow-x-auto border border-line">
          <table className="w-full text-sm">
            <thead className="bg-paper text-left text-ink-soft">
              <tr>
                <th className="px-3 py-2 font-medium">Class</th>
                <th className="px-3 py-2 font-medium">Description</th>
                <th className="px-3 py-2 font-medium">References</th>
                <th className="px-3 py-2 font-medium">Types</th>
                <th className="px-3 py-2 font-medium">Active</th>
                <th className="px-3 py-2 font-medium">Version</th>
                <th className="px-3 py-2 font-medium">Materials</th>
              </tr>
            </thead>
            <tbody>
              {classes.map((row) => (
                <tr key={row.valuationClass} className="border-t border-line">
                  <td className="px-3 py-2">
                    <button type="button" className="code text-left underline" onClick={() => { setClassMode('CHANGE'); setSelectedClass(row.valuationClass); setRequestKey(crypto.randomUUID()); }}>
                      {row.valuationClass}
                    </button>
                  </td>
                  <td className="px-3 py-2">{row.name}</td>
                  <td className="px-3 py-2">{row.references.join(', ') || '—'}</td>
                  <td className="px-3 py-2">{row.allowedMaterialTypes || 'Every type on the references'}</td>
                  <td className="px-3 py-2">{row.isActive ? 'Yes' : 'No'}</td>
                  <td className="px-3 py-2">{row.version}</td>
                  <td className="px-3 py-2">{row.materialCount}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {classLocked && classNotice.message && (
          <p role="status" className="border border-signal-warn/40 bg-amber-50 p-3 text-sm text-amber-800">{classNotice.message}</p>
        )}
        <ClaimFailureNotice claim={classClaim} onRetry={classRetry} />
        {canMaintain && (classMode === 'CREATE' || (classRow && !classLocked && classGranted)) && (
          <form key={`class-${classMode}-${selectedClass ?? 'new'}-${classRow?.version ?? 0}`} action={saveClass} className="space-y-3 border border-line p-3">
            <h3 className="text-sm font-semibold">{classMode === 'CREATE' ? 'Create valuation class' : `Change ${classRow?.valuationClass}`}</h3>
            {classRow && (classRow.materialCount > 0 || classRow.determinationCount > 0) && (
              <p role="status" className="text-sm text-ink-soft">
                This class is already cited by {classRow.materialCount} material valuation{classRow.materialCount === 1 ? '' : 's'} and {classRow.determinationCount} account-determination row{classRow.determinationCount === 1 ? '' : 's'}. The description can change. Deactivation and a change that would leave those materials without this class are refused. A material is not rewritten.
              </p>
            )}
            <input type="hidden" name="mode" value={classMode} />
            <input type="hidden" name="requestKey" value={requestKey} />
            <input type="hidden" name="expectedVersion" value={classMode === 'CHANGE' ? classRow?.version ?? 0 : 0} />
            <div className="grid gap-3 sm:grid-cols-2">
              <div>
                <label htmlFor="class-key" className="text-sm font-medium">Valuation class<RequiredMark /></label>
                <input id="class-key" name="valuationClass" required maxLength={20} defaultValue={classMode === 'CHANGE' ? classRow?.valuationClass : ''} readOnly={classMode === 'CHANGE'} className="input mt-1 w-full" />
              </div>
              <div>
                <label htmlFor="class-name" className="text-sm font-medium">Description<RequiredMark /></label>
                <input id="class-name" name="name" required maxLength={60} defaultValue={classRow?.name ?? ''} className="input mt-1 w-full" />
              </div>
            </div>
            <fieldset className="space-y-1">
              <legend className="text-sm font-medium">Account category references<RequiredMark /></legend>
              <p className="text-xs text-ink-soft">A class may belong to more than one reference. An inactive reference cannot be newly assigned.</p>
              {references.map((row) => (
                <label key={row.reference} className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    name="reference"
                    value={row.reference}
                    defaultChecked={classRow?.references.includes(row.reference) ?? false}
                  />
                  <span className="code">{row.reference}</span>
                  <span>{row.name}{row.isActive ? '' : ' (inactive)'}</span>
                </label>
              ))}
            </fieldset>
            <fieldset className="space-y-1">
              <legend className="text-sm font-medium">Material types this class names</legend>
              <p className="text-xs text-ink-soft">Leave every type unchecked to permit every type that uses an assigned reference. Name types to keep a delivered class with those types only.</p>
              {types.map((row) => (
                <label key={row.materialType} className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    name="materialType"
                    value={row.materialType}
                    defaultChecked={classRow ? classRow.allowedMaterialTypes.split(',').includes(row.materialType) : false}
                  />
                  <span className="code">{row.materialType}</span>
                  <span>{row.name} · reference {row.accountCategoryReference}</span>
                </label>
              ))}
            </fieldset>
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" name="isActive" defaultChecked={classRow?.isActive ?? true} />
              Active
            </label>
            <div>
              <label htmlFor="class-reason" className="text-sm font-medium">Reason<RequiredMark /></label>
              <input id="class-reason" name="reason" required maxLength={500} className="input mt-1 w-full" />
            </div>
            <button type="submit" className="btn btn-primary min-h-11" disabled={classPending}>Save valuation class</button>
          </form>
        )}
        {canMaintain && classRow && !classLocked && classGranted && (
          <form action={deleteClass} className="space-y-3 border border-line p-3">
            <p className="text-sm text-ink-soft">Delete is refused while a material or an account determination names this class.</p>
            <input type="hidden" name="valuationClass" value={classRow.valuationClass} />
            <input type="hidden" name="expectedVersion" value={classRow.version} />
            <input type="hidden" name="requestKey" value={requestKey} />
            <div>
              <label htmlFor="class-delete-reason" className="text-sm font-medium">Reason for deletion<RequiredMark /></label>
              <input id="class-delete-reason" name="reason" required maxLength={500} className="input mt-1 w-full" />
            </div>
            <button type="submit" className="btn btn-default min-h-11" disabled={deleteClassPending}>Delete valuation class</button>
          </form>
        )}
      </section>

      <section aria-labelledby="type-references" className="space-y-3">
        <h2 id="type-references" className="text-base font-semibold">Material type assignment</h2>
        <p className="text-sm text-ink-soft">Each material type names one account category reference. Changing it does not rewrite a material valuation class.</p>
        <div className="overflow-x-auto border border-line">
          <table className="w-full text-sm">
            <thead className="bg-paper text-left text-ink-soft">
              <tr>
                <th className="px-3 py-2 font-medium">Material type</th>
                <th className="px-3 py-2 font-medium">Description</th>
                <th className="px-3 py-2 font-medium">Reference</th>
                <th className="px-3 py-2 font-medium">Materials</th>
              </tr>
            </thead>
            <tbody>
              {types.map((row) => (
                <tr key={row.materialType} className="border-t border-line">
                  <td className="px-3 py-2">
                    <button type="button" className="code text-left underline" onClick={() => { setSelectedType(row.materialType); setRequestKey(crypto.randomUUID()); }}>
                      {row.materialType}
                    </button>
                  </td>
                  <td className="px-3 py-2">{row.name}</td>
                  <td className="px-3 py-2">{row.accountCategoryReference}{row.referenceActive ? '' : ' (inactive)'}</td>
                  <td className="px-3 py-2">{row.materialCount}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {typeLocked && typeNotice.message && (
          <p role="status" className="border border-signal-warn/40 bg-amber-50 p-3 text-sm text-amber-800">{typeNotice.message}</p>
        )}
        <ClaimFailureNotice claim={typeClaim} onRetry={typeRetry} />
        {canMaintain && typeRow && !typeLocked && typeGranted && (
          <form key={`type-${typeRow.materialType}`} action={assignType} className="space-y-3 border border-line p-3">
            <h3 className="text-sm font-semibold">Assign {typeRow.materialType}</h3>
            <input type="hidden" name="materialType" value={typeRow.materialType} />
            <input type="hidden" name="requestKey" value={requestKey} />
            <div>
              <label htmlFor="type-reference" className="text-sm font-medium">Account category reference<RequiredMark /></label>
              <select id="type-reference" name="reference" defaultValue={typeRow.accountCategoryReference} className="input mt-1 w-full">
                {references.filter((row) => row.isActive).map((row) => (
                  <option key={row.reference} value={row.reference}>{row.reference} — {row.name}</option>
                ))}
              </select>
            </div>
            <div>
              <label htmlFor="type-reason" className="text-sm font-medium">Reason<RequiredMark /></label>
              <input id="type-reason" name="reason" required maxLength={500} className="input mt-1 w-full" />
            </div>
            <button type="submit" className="btn btn-primary min-h-11" disabled={assignPending}>Save assignment</button>
          </form>
        )}
      </section>
    </div>
  );
}
