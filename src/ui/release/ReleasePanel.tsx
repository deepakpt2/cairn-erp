'use client';

import { useActionState } from 'react';

import type { DocumentReleaseState } from '@/modules/purchasing/release';

export interface ReleaseActionState {
  ok: boolean;
  message: string;
  remedy?: string;
}

type ReleaseAction = (previous: ReleaseActionState, form: FormData) => Promise<ReleaseActionState>;

const INITIAL: ReleaseActionState = { ok: true, message: '' };

/**
 * The release block of a document screen: where the document stands in its strategy, the release
 * act for the next step, and cancel. `fields` are the hidden values the actions need to find the
 * document. `label` is what the document is called in the sentences ("parked document").
 */
export function ReleasePanel({ id, label, fields, state, canRelease, releaseAction, cancelAction, hint }: {
  id: string;
  label: string;
  fields: Record<string, string>;
  state: DocumentReleaseState;
  canRelease: boolean;
  releaseAction: ReleaseAction;
  cancelAction: ReleaseAction;
  hint?: string;
}) {
  const [releaseState, release] = useActionState(releaseAction, INITIAL);
  const [cancelState, cancel] = useActionState(cancelAction, INITIAL);
  const message = cancelState.message ? cancelState : releaseState;
  const hidden = Object.entries(fields).map(([name, value]) => (
    <input key={name} type="hidden" name={name} value={value} />
  ));

  return (
    <section aria-labelledby={id} className="border border-line bg-surface p-4">
      <h2 id={id} className="text-sm font-semibold">Release</h2>
      {state.status === 'NOT_REQUIRED' ? (
        <p className="mt-2 text-sm text-ink-soft">
          No release strategy claims this {label}; it needs no release.
        </p>
      ) : (
        <>
          <p className="mt-2 text-sm text-ink-soft">
            Strategy {state.groupCode} / {state.strategyCode}:{' '}
            {state.status === 'RELEASED'
              ? 'fully released'
              : `released through step ${state.currentStep} of ${state.steps.length}`}
            {' '}({state.steps.map((code, i) => `${i + 1}. ${code}`).join(' · ')}).
            {hint ? ` ${hint}` : ''}
          </p>
          {message.message && (
            <p role="status" className={`mt-2 text-sm ${message.ok ? 'text-ink' : 'text-red-700'}`}>
              {message.message}
              {message.remedy ? ` ${message.remedy}` : ''}
            </p>
          )}
          <div className="mt-3 flex flex-wrap items-end gap-2">
            {state.status === 'PENDING' && (
              <form action={release}>
                {hidden}
                <label className="block">
                  <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-ink-faint">Release code</span>
                  <select name="releaseCode" className="input w-48" defaultValue={state.steps[state.currentStep]}>
                    {state.steps.map((code) => (
                      <option key={code} value={code}>{code}</option>
                    ))}
                  </select>
                </label>
                <button type="submit" className="btn btn-primary mt-2 min-h-11 sm:min-h-8" disabled={!canRelease}>
                  Release step {state.currentStep + 1}
                </button>
              </form>
            )}
            {(state.currentStep > 0 || state.status === 'RELEASED') && (
              <form action={cancel}>
                {hidden}
                <button type="submit" className="btn btn-default min-h-11 sm:min-h-8" disabled={!canRelease}>
                  Cancel release
                </button>
              </form>
            )}
          </div>
        </>
      )}
    </section>
  );
}
