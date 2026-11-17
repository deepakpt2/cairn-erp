/**
 * Second factor — AUTH-01 §8.3. Public, no session, no JavaScript. Not a catalogue screen.
 * Also the enrolment screen when the tenant requires two-factor and this user has none yet.
 */
import { redirect } from 'next/navigation';

import { challengeView } from '@/platform/auth/mfa';

export const dynamic = 'force-dynamic';

const REASONS: Record<string, string> = {
  CODE_WRONG: 'That code is not correct.',
};

export default async function MfaChallengePage({
  searchParams,
}: {
  searchParams: Promise<{ challenge?: string; client?: string; enrol?: string; next?: string; error?: string; left?: string }>;
}) {
  const p = await searchParams;
  const client = (p.client ?? '').toUpperCase();
  if (!/^[A-Z0-9]{4}$/.test(client) || !/^[0-9a-f-]{36}$/i.test(p.challenge ?? '')) redirect('/signin');
  const view = await challengeView({ client, challengeId: p.challenge! });
  if (!view.live) redirect('/signin?error=CAIRN_AUTH_MFA_ENDED');
  const enrolling = view.enrolment !== null;
  const secretGroups = view.enrolment?.secretBase32.match(/.{1,4}/g)?.join(' ') ?? '';

  return (
    <div className="flex min-h-[70vh] items-center justify-center p-6">
      <div className="w-full max-w-sm">
        <div className="mb-6 text-center">
          <div className="text-lg font-semibold tracking-tight text-ink">{enrolling ? 'Set up two-factor authentication' : 'Two-factor authentication'}</div>
          <div className="text-xs text-ink-soft">
            {enrolling
              ? 'This tenant requires a second factor. Add the key below to an authenticator app, then enter the six-digit code it shows.'
              : 'Enter the six-digit code from your authenticator app.'}
          </div>
        </div>

        <form method="post" action="/api/auth/mfa" className="panel space-y-3 p-5">
          <input type="hidden" name="challenge" value={p.challenge} />
          <input type="hidden" name="client" value={client} />
          {enrolling && <input type="hidden" name="enrol" value="1" />}
          <input type="hidden" name="next" value={p.next ?? '/'} />

          {p.error && (
            <div role="alert" className="rounded border border-signal-error/30 bg-signal-error-soft p-3 text-sm text-signal-error">
              <p>{REASONS[p.error] ?? 'That code could not be accepted.'}</p>
              {p.left && <p className="mt-1 text-xs">{p.left} attempt{p.left === '1' ? '' : 's'} left before you must sign in again.</p>}
            </div>
          )}

          {view.enrolment && (
            <div className="space-y-2 text-sm">
              {view.enrolment.qrDataUri && (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={view.enrolment.qrDataUri} alt="QR code for your authenticator app" width={192} height={192} className="mx-auto bg-white" />
              )}
              <p className="text-xs text-ink-soft">Or enter this key by hand:</p>
              <p className="code select-all break-all text-center">{secretGroups}</p>
            </div>
          )}

          <label htmlFor="code" className="block text-2xs font-medium uppercase tracking-wide text-ink-soft">Code</label>
          <input id="code" name="code" required autoFocus autoComplete="one-time-code" inputMode="numeric" className="field-input code w-full" placeholder="123456" />
          {!enrolling && (
            <details className="text-xs text-ink-soft">
              <summary className="cursor-pointer">Use a recovery code instead</summary>
              <p className="mt-1">Type a recovery code into the same box, for example <span className="code">abcde-fghij</span>. Each works once.</p>
            </details>
          )}
          <button type="submit" className="btn btn-primary w-full">{enrolling ? 'Confirm and sign in' : 'Verify'}</button>
          <p className="text-center text-2xs text-ink-faint"><a href="/signin">Start again</a></p>
        </form>
      </div>
    </div>
  );
}
