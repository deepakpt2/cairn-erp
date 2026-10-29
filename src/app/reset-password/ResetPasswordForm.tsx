"use client";

/**
 * Reset password form — client component.
 *
 * Collects a new password and confirmation, submits through
 * `completePasswordResetAction`. Receives `client` and `token` as props from
 * the server page wrapper so no `useSearchParams()` is needed (which would
 * require a Suspense boundary during static prerendering).
 */
import { useActionState, useState } from 'react';

import { completePasswordResetAction, type UserActionState } from '../platform/users/actions';

const EMPTY: UserActionState = { ok: true, message: '' };

interface ResetPasswordFormProps {
  client: string;
  token: string;
}

export default function ResetPasswordForm({
  client,
  token,
}: ResetPasswordFormProps) {
  const [state, completeReset] = useActionState(completePasswordResetAction, EMPTY);
  const [submitting, setSubmitting] = useState(false);
  const [passwordMismatch, setPasswordMismatch] = useState(false);

  return (
    <div className="flex min-h-[70vh] items-center justify-center p-6">
      <div className="w-full max-w-sm">
        <div className="mb-6 text-center">
          <div className="text-lg font-semibold tracking-tight text-ink">
            Reset password
          </div>
          <div className="text-xs text-ink-soft">
            Enter your new password. It must be at least 10 characters and
            contain at least one letter and one digit.
          </div>
        </div>

        <form
          action={completeReset}
          className="panel p-5 space-y-3"
          onSubmit={(event) => {
            const form = event.currentTarget;
            const password = form.elements.namedItem('password') as HTMLInputElement;
            const confirmation = form.elements.namedItem(
              'confirmation',
            ) as HTMLInputElement;
            if (password.value !== confirmation.value) {
              event.preventDefault();
              setPasswordMismatch(true);
              return;
            }
            setSubmitting(true);
          }}
        >
          <input type="hidden" name="client" defaultValue={client} />
          <input type="hidden" name="token" defaultValue={token} />

          <div>
            <label
              htmlFor="password"
              className="mb-1 block text-2xs font-medium uppercase tracking-wide text-ink-soft"
            >
              New password
            </label>
            <input
              id="password"
              name="password"
              type="password"
              required
              minLength={10}
              autoComplete="new-password"
              className="field-input w-full"
            />
          </div>

          <div>
            <label
              htmlFor="confirmation"
              className="mb-1 block text-2xs font-medium uppercase tracking-wide text-ink-soft"
            >
              Confirm password
            </label>
            <input
              id="confirmation"
              name="confirmation"
              type="password"
              required
              minLength={10}
              autoComplete="new-password"
              className="field-input w-full"
            />
            {passwordMismatch && (
              <p className="mt-1 text-xs text-chip-error">
                Passwords do not match.
              </p>
            )}
          </div>

          <button
            type="submit"
            className="btn-primary mt-5 w-full"
            disabled={submitting || !token}
          >
            {submitting ? 'Resetting…' : 'Reset password'}
          </button>

          {state?.message && (
            <div className="chip-ok mt-4" role="status">
              <div className="font-medium">{state.message}</div>
              <p className="mt-1 text-2xs text-ink-soft">
                All existing sessions have been revoked. You may sign in with
                your new password.
              </p>
            </div>
          )}

          {state?.remedy && (
            <div className="chip-error mt-2" role="alert">
              <div className="font-medium">{state.remedy}</div>
            </div>
          )}
        </form>

        <p className="mt-4 text-center text-2xs text-ink-faint">
          Remember your password? <a href="/signin" className="link">Sign in</a>.
        </p>
      </div>
    </div>
  );
}
