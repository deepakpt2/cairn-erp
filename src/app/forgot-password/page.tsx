"use client";

export const dynamic = 'force-dynamic';

/**
 * Forgot password — CAIRN.md §23.
 *
 * Public self-service password-reset request. Accepts tenant and username,
 * submits through `requestPasswordResetAction`, and returns the same generic
 * acceptance message whether the account exists or not — preventing username
 * enumeration.
 *
 * No email transport exists yet (D-033), so recovery tokens remain out-of-band.
 * An administrator who sees the audit log can deliver the token to the user.
 */
import { useActionState, useState } from 'react';

import { requestPasswordResetAction, type UserActionState } from '../platform/users/actions';

const EMPTY: UserActionState = { ok: true, message: '' };

export default async function ForgotPasswordPage() {
  const [state, requestReset] = useActionState(requestPasswordResetAction, EMPTY);
  const [submitting, setSubmitting] = useState(false);

  return (
    <div className="flex min-h-[70vh] items-center justify-center p-6">
      <div className="w-full max-w-sm">
        <div className="mb-6 text-center">
          <div className="text-lg font-semibold tracking-tight text-ink">Forgot password</div>
          <div className="text-xs text-ink-soft">
            Enter your tenant and username. If this account stands in this
            tenant and is active, a reset link will be created and delivered
            out of band.
          </div>
        </div>

        <form
          action={requestReset}
          className="panel p-5 space-y-3"
          onSubmit={() => setSubmitting(true)}
        >
          <div>
            <label
              htmlFor="client"
              className="mb-1 block text-2xs font-medium uppercase tracking-wide text-ink-soft"
            >
              Tenant
            </label>
            <input
              id="client"
              name="client"
              required
              maxLength={4}
              autoComplete="off"
              className="field-input code w-full uppercase"
              placeholder="0100"
            />
          </div>

          <div>
            <label
              htmlFor="username"
              className="mb-1 block text-2xs font-medium uppercase tracking-wide text-ink-soft"
            >
              Username
            </label>
            <input
              id="username"
              name="username"
              required
              autoComplete="username"
              className="field-input w-full"
            />
          </div>

          <button
            type="submit"
            className="btn-primary mt-5 w-full"
            disabled={submitting}
          >
            {submitting ? 'Requesting reset…' : 'Request reset'}
          </button>

          {state?.message && (
            <div className="chip-ok mt-4" role="status">
              <div className="font-medium">{state.message}</div>
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