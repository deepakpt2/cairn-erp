/**
 * Logon — CAIRN.md §23, §19.
 *
 * Tenant, user, password. The same three fields, in the same order, as the
 * reference model's logon screen — an experienced user should not have to learn
 * this screen, and the tenant key is a working piece of information in a
 * multi-company install rather than a login detail.
 *
 * A plain form. No client-side JavaScript is required to sign in, and the error
 * message is rendered from a code in the query string, so the wording lives in one
 * place and can be translated (R-19).
 */
import type { Metadata } from 'next';
import { t } from '@/platform/i18n';

export const metadata: Metadata = { title: `${t('app.name')} — ${t('auth.signIn')}` };

const MESSAGES: Record<string, { title: string; detail: string }> = {
  CAIRN_AUTH_INVALID: {
    title: 'The tenant, user or password is not correct.',
    detail: 'Check all three fields and try again.',
  },
  CAIRN_AUTH_INACTIVE: {
    title: 'This user is not active.',
    detail: 'Ask an administrator to activate the user before signing in.',
  },
  CAIRN_AUTH_LOCKED: {
    title: 'This user is locked after too many failed attempts.',
    detail: 'An administrator must unlock the user before you can sign in again.',
  },
  CAIRN_AUTH: {
    title: 'Sign-in could not be completed.',
    detail: 'Try again. If it keeps failing, check that the tenant key is correct.',
  },
};

export default async function SignInPage({
  searchParams,
}: {
  searchParams: Promise<{
    error?: string;
    client?: string;
    username?: string;
    next?: string;
    created?: string;
  }>;
}) {
  const params = await searchParams;
  const failure = params.error ? (MESSAGES[params.error] ?? MESSAGES.CAIRN_AUTH) : null;

  return (
    <div className="flex min-h-[70vh] items-center justify-center p-6">
      <div className="w-full max-w-sm">
        <div className="mb-6 text-center">
          <div className="text-lg font-semibold tracking-tight text-ink">{t('app.name')}</div>
          <div className="text-xs text-ink-soft">{t('app.tagline')}</div>
        </div>

        <form method="post" action="/api/auth/signin" className="panel p-5">
          <input type="hidden" name="next" value={params.next ?? '/'} />

          <div className="space-y-3">
            <div>
              <label htmlFor="client" className="mb-1 block text-2xs font-medium uppercase tracking-wide text-ink-soft">
                Tenant
              </label>
              <input
                id="client"
                name="client"
                required
                autoComplete="off"
                autoFocus
                maxLength={4}
                defaultValue={params.client ?? ''}
                className="field-input code w-full uppercase"
                placeholder="0100"
              />
            </div>

            <div>
              <label htmlFor="username" className="mb-1 block text-2xs font-medium uppercase tracking-wide text-ink-soft">
                User
              </label>
              <input
                id="username"
                name="username"
                required
                autoComplete="username"
                defaultValue={params.username ?? ''}
                className="field-input w-full"
              />
            </div>

            <div>
              <label htmlFor="password" className="mb-1 block text-2xs font-medium uppercase tracking-wide text-ink-soft">
                Password
              </label>
              <input
                id="password"
                name="password"
                type="password"
                required
                autoComplete="current-password"
                className="field-input w-full"
              />
            </div>
          </div>

          {failure ? (
            <div className="chip-error mt-4" role="alert">
              <div className="font-medium">{failure.title}</div>
              <div className="mt-0.5">{failure.detail}</div>
            </div>
          ) : null}

          {params.created === '1' ? (
            <div className="chip-ok mt-4" role="status">
              <div className="font-medium">Tenant created.</div>
              <div className="mt-0.5">
                Sign in with the administrator account you just defined to open the
                configuration workbench.
              </div>
            </div>
          ) : null}

          <button type="submit" className="btn-primary mt-5 w-full">
            {t('auth.signIn')}
          </button>
        </form>

        <p className="mt-4 text-center text-2xs text-ink-faint">
          Sessions end after twelve hours of inactivity.
        </p>
      </div>
    </div>
  );
}
