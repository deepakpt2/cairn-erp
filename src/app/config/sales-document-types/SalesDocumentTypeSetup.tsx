'use client';

import { useActionState, useState } from 'react';

import {
  changeDocumentTypeAction,
  defineDocumentTypeAction,
  setDocumentTypeActiveAction,
  type DocumentTypeActionState,
} from './actions';

const INITIAL: DocumentTypeActionState = { ok: false, message: '' };

export interface SalesDocumentTypeChoice {
  documentType: string;
  name: string;
  numberRangeObject: string;
  numberRangeSubObject: string;
  cancellationDocumentType: string | null;
  isActive: boolean;
  documentsStanding: number;
}

function Notice({ state }: { state: DocumentTypeActionState }) {
  if (!state.message) return null;
  return (
    <p role="status" className={`mt-3 text-sm ${state.ok ? 'text-ink' : 'text-red-700'}`}>
      {state.message}
      {state.remedy ? ` ${state.remedy}` : ''}
    </p>
  );
}

export function SalesDocumentTypeSetup({ types }: { types: SalesDocumentTypeChoice[] }) {
  const [defineState, defineAction, definePending] = useActionState(defineDocumentTypeAction, INITIAL);
  const [changeState, changeAction, changePending] = useActionState(changeDocumentTypeAction, INITIAL);
  const [activeState, activeAction, activePending] = useActionState(setDocumentTypeActiveAction, INITIAL);

  const [selected, setSelected] = useState('');
  const chosen = types.find((type) => type.documentType === selected);

  return (
    <section aria-labelledby="doctype-maintain" className="border border-line bg-surface p-4">
      <h2 id="doctype-maintain" className="text-sm font-semibold">Maintain the types</h2>
      <p className="mt-1 max-w-3xl text-sm text-ink-soft">
        Define a type, and it is offered from the moment it stands. Redefine one, and the documents already
        created under it keep reading it — what changes is what the next document gets. Deactivate one
        rather than deleting it: history keeps reading the type a document was created with, and there is
        no delete here to break that with.
      </p>

      <div className="mt-4 grid gap-6 md:grid-cols-2">
        <form action={defineAction} className="space-y-3">
          <h3 className="text-sm font-medium">Define a type that does not stand</h3>

          <label className="block text-sm">
            <span className="mb-1 block font-medium">Document type</span>
            <input
              name="documentType"
              required
              maxLength={4}
              pattern="[A-Za-z0-9]{2,4}"
              className="field w-full font-mono uppercase"
              aria-describedby="doctype-code-help"
            />
            <span id="doctype-code-help" className="mt-1 block text-xs text-ink-faint">
              Two to four letters or digits, as the documents will carry it — for example ZOR.
            </span>
          </label>

          <label className="block text-sm">
            <span className="mb-1 block font-medium">Name</span>
            <input name="name" required maxLength={40} className="field w-full" />
            <span className="mt-1 block text-xs text-ink-faint">What a screen shows for the type.</span>
          </label>

          <div className="grid gap-3 sm:grid-cols-2">
            <label className="block text-sm">
              <span className="mb-1 block font-medium">Number range object</span>
              <input
                name="numberRangeObject"
                required
                maxLength={10}
                className="field w-full font-mono uppercase"
              />
            </label>
            <label className="block text-sm">
              <span className="mb-1 block font-medium">Sub-object</span>
              <input
                name="numberRangeSubObject"
                required
                maxLength={10}
                className="field w-full font-mono uppercase"
              />
            </label>
          </div>
          <p className="text-xs text-ink-faint">
            The interval must stand before the type can: a document type that cannot draw a number is a
            type that would refuse every document created against it.
          </p>

          <label className="block text-sm">
            <span className="mb-1 block font-medium">Cancels into</span>
            <input
              name="cancellationDocumentType"
              maxLength={4}
              className="field w-full font-mono uppercase"
              placeholder="(none)"
            />
            <span className="mt-1 block text-xs text-ink-faint">
              The type a document of this one cancels into. It must stand first, and it cannot be this type.
            </span>
          </label>

          <button type="submit" disabled={definePending} className="btn btn-primary min-h-11 w-full">
            {definePending ? 'Defining…' : 'Define the type'}
          </button>
          <Notice state={defineState} />
        </form>

        <div className="space-y-3">
          <h3 className="text-sm font-medium">Redefine a type that stands</h3>

          {types.length === 0 ? (
            <p className="text-sm text-ink-soft">
              No document types stand for this tenant, so there is nothing to redefine yet.
            </p>
          ) : (
            <>
              <label className="block text-sm">
                <span className="mb-1 block font-medium">Document type</span>
                <select
                  value={selected}
                  onChange={(event) => setSelected(event.target.value)}
                  className="field w-full font-mono"
                >
                  <option value="">(select a type)</option>
                  {types.map((type) => (
                    <option key={type.documentType} value={type.documentType}>
                      {type.documentType} — {type.name}
                    </option>
                  ))}
                </select>
              </label>

              {chosen && (
                <>
                  <dl className="grid grid-cols-2 gap-x-3 gap-y-1 border border-line p-3 text-sm">
                    <dt className="text-ink-faint">Number range</dt>
                    <dd className="font-mono">
                      {chosen.numberRangeObject} / {chosen.numberRangeSubObject}
                    </dd>
                    <dt className="text-ink-faint">Cancels into</dt>
                    <dd className="font-mono">{chosen.cancellationDocumentType ?? '—'}</dd>
                    <dt className="text-ink-faint">Status</dt>
                    <dd>{chosen.isActive ? 'Offered' : 'Withdrawn'}</dd>
                    <dt className="text-ink-faint">Documents standing</dt>
                    <dd>{chosen.documentsStanding}</dd>
                  </dl>

                  <form action={changeAction} className="space-y-3">
                    <label className="block text-sm">
                      <span className="mb-1 block font-medium">Name</span>
                      <input
                        name="name"
                        required
                        maxLength={40}
                        defaultValue={chosen.name}
                        key={`name-${chosen.documentType}`}
                        className="field w-full"
                      />
                    </label>
                    <label className="block text-sm">
                      <span className="mb-1 block font-medium">Cancels into</span>
                      <input
                        name="cancellationDocumentType"
                        maxLength={4}
                        defaultValue={chosen.cancellationDocumentType ?? ''}
                        key={`cancels-${chosen.documentType}`}
                        className="field w-full font-mono uppercase"
                        placeholder="(none)"
                      />
                    </label>
                    <input type="hidden" name="documentType" value={chosen.documentType} />
                    <button type="submit" disabled={changePending} className="btn btn-default min-h-11 w-full">
                      {changePending ? 'Saving…' : 'Save the type'}
                    </button>
                  </form>
                  <Notice state={changeState} />

                  <form action={activeAction}>
                    <input type="hidden" name="documentType" value={chosen.documentType} />
                    <input
                      type="hidden"
                      name="isActive"
                      value={chosen.isActive ? 'false' : 'true'}
                    />
                    <button type="submit" disabled={activePending} className="btn btn-default min-h-11 w-full">
                      {activePending
                        ? 'Saving…'
                        : chosen.isActive
                          ? 'Withdraw the type from new documents'
                          : 'Offer the type again'}
                    </button>
                    <p className="mt-1 text-xs text-ink-faint">
                      {chosen.isActive
                        ? 'The type stops being offered. Documents already created keep reading it.'
                        : 'The type is offered to new documents again.'}
                    </p>
                  </form>
                  <Notice state={activeState} />
                </>
              )}
            </>
          )}
        </div>
      </div>
    </section>
  );
}
