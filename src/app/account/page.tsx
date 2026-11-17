import Link from 'next/link';
import { redirect } from 'next/navigation';

import { requireSession } from '@/platform/auth/current';
import {
  ACCOUNT_ROUTE, ACCOUNT_SECTIONS, listOwnSessions, pendingAccountActions, readOwnPreferences,
  registeredLogonLanguages, safeNextPath, type AccountSection,
} from '@/modules/platform/personal-account';
import { logonLanguageKeyFromPreferences } from '@/platform/auth/session';
import { mfaStatus, mfaEnrolmentOutstanding, pendingEnrolment, isMfaRequired, MFA_POLICY_CAPABILITY } from '@/platform/auth/mfa';
import { can } from '@/platform/auth/current';
import { ConfirmPanel, DisablePanel, RegeneratePanel } from './MfaPanels';
import { beginEnrolmentAction, setMfaRequiredAction } from './mfa-actions';
import { changePasswordAction, revokeSessionAction, savePreferencesAction } from './actions';

export const dynamic = 'force-dynamic';

const LABEL: Record<AccountSection, string> = {
  password: 'Password', security: 'Two-factor', sessions: 'Sessions', preferences: 'Preferences',
};

type Params = Promise<Record<string, string | string[] | undefined>>;
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

export default async function AccountPage({ searchParams }: { searchParams: Params }) {
  const q = await searchParams;
  const session = await requireSession(ACCOUNT_ROUTE);
  const requested = one(q.section);
  const section: AccountSection = (ACCOUNT_SECTIONS as readonly string[]).includes(requested ?? '') ? (requested as AccountSection) : 'password';
  const forced = session.user.mustChangePassword;

  // The second gate: /account is on the allow-list, so without this a forced user could wander into the other sections.
  if (forced && section !== 'password') redirect(`${ACCOUNT_ROUTE}?section=password`);

  const next = safeNextPath(one(q.next));
  const pending = pendingAccountActions(session.user, { mfaEnrolmentOutstanding: await mfaEnrolmentOutstanding(session.user.client, session.user.userId) });
  const { ok, error, remedy } = { ok: one(q.ok), error: one(q.error), remedy: one(q.remedy) };

  return (
    <main className="mx-auto max-w-4xl space-y-4 p-3 sm:p-4 lg:p-6">
      <header className="border-b border-line pb-4">
        <h1 className="text-xl font-semibold tracking-tight">My account</h1>
        <p className="mt-1 text-sm text-ink-soft">{session.user.fullName ? `${session.user.fullName} (${session.user.username})` : session.user.username} · tenant {session.user.client}</p>
      </header>

      {pending.length > 0 && (
        <section role="alert" className="panel border-signal-warn/40 p-3">
          {pending.map((p) => (
            <div key={p.key} className="flex flex-wrap items-center justify-between gap-2 text-sm">
              <span>{p.message}</span>
              <Link href={p.href} className="btn btn-default">{p.actionLabel}</Link>
            </div>
          ))}
        </section>
      )}

      <nav aria-label="Account sections" className="flex flex-wrap gap-2 text-sm">
        {ACCOUNT_SECTIONS.map((s) => forced && s !== 'password' ? (
          <span key={s} aria-disabled className="btn btn-default opacity-50" title="Change your password first">{LABEL[s]}</span>
        ) : (
          <Link key={s} href={`${ACCOUNT_ROUTE}?section=${s}`} aria-current={s === section ? 'page' : undefined}
            className={`btn ${s === section ? 'btn-primary' : 'btn-default'}`}>{LABEL[s]}</Link>
        ))}
      </nav>

      {ok && <p role="status" className="rounded border border-signal-ok/30 p-3 text-sm text-signal-ok">{ok}</p>}
      {error && (
        <div role="alert" className="rounded border border-signal-error/30 bg-signal-error-soft p-3 text-sm text-signal-error">
          <p>{error}</p>{remedy && <p className="mt-1 text-xs">{remedy}</p>}
        </div>
      )}

      {section === 'password' && (
        <section className="panel p-4">
          <h2 className="panel-title">Change password</h2>
          <form action={changePasswordAction} className="mt-3 max-w-sm space-y-3">
            {next && <input type="hidden" name="next" value={next} />}
            {([['currentPassword', 'Current password', 'current-password'], ['newPassword', 'New password', 'new-password'], ['confirmation', 'Confirm new password', 'new-password']] as const).map(([name, label, auto]) => (
              <label key={name} className="block text-xs font-medium uppercase tracking-wide text-ink-soft">{label}
                <input name={name} type="password" required autoComplete={auto} className="field-input mt-1 w-full normal-case" />
              </label>
            ))}
            <p className="text-xs text-ink-soft">At least 10 characters, with a letter and a digit. Your other sessions are signed out; this one stays.</p>
            <button type="submit" className="btn btn-primary">Change password</button>
          </form>
        </section>
      )}

      {section === 'security' && <SecuritySection session={session} setup={one(q.setup) === '1'} />}
      {section === 'sessions' && <SessionsSection session={session} />}
      {section === 'preferences' && <PreferencesSection session={session} />}
    </main>
  );
}

async function SessionsSection({ session }: { session: Awaited<ReturnType<typeof requireSession>> }) {
  const rows = await listOwnSessions({ client: session.user.client, userId: session.user.userId, currentSessionId: session.sessionId ?? '' });
  return (
    <section className="panel overflow-x-auto">
      <div className="panel-header"><h2 className="panel-title">Signed-in sessions</h2></div>
      <table className="grid-table">
        <thead><tr><th>Signed in</th><th>Expires</th><th>Address</th><th>Browser</th><th /></tr></thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id}>
              <td className="tabular whitespace-nowrap">{r.issuedAt.slice(0, 19).replace('T', ' ')}{r.isCurrent && <span className="chip chip-ok ms-2">This session</span>}</td>
              <td className="tabular whitespace-nowrap">{r.expiresAt.slice(0, 19).replace('T', ' ')}</td>
              <td>{r.ipAddress ?? '—'}</td>
              <td className="max-w-xs truncate text-xs text-ink-soft">{r.userAgent ?? '—'}</td>
              <td>
                <form action={revokeSessionAction}>
                  <input type="hidden" name="sessionId" value={r.id} />
                  <button type="submit" className="btn btn-default">{r.isCurrent ? 'Sign out of this session' : 'Close'}</button>
                </form>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

async function PreferencesSection({ session }: { session: Awaited<ReturnType<typeof requireSession>> }) {
  const prefs = await readOwnPreferences(session.user.client, session.user.userId);
  const current = logonLanguageKeyFromPreferences(prefs);
  return (
    <section className="panel p-4">
      <h2 className="panel-title">Preferences</h2>
      <form action={savePreferencesAction} className="mt-3 max-w-sm space-y-3">
        <label className="block text-xs font-medium uppercase tracking-wide text-ink-soft">Logon language
          <select name="logonLanguage" defaultValue={current} className="field-input mt-1 w-full normal-case">
            {registeredLogonLanguages().map((k) => <option key={k} value={k}>{k === 'E' ? 'English (E)' : k}</option>)}
          </select>
        </label>
        <p className="text-xs text-ink-soft">Date and number formats are set for the whole tenant; nothing in the product reads a personal override yet, so none is offered.</p>
        <button type="submit" className="btn btn-primary">Save</button>
      </form>
    </section>
  );
}

async function SecuritySection({ session, setup }: { session: Awaited<ReturnType<typeof requireSession>>; setup: boolean }) {
  const { client, userId } = session.user;
  const status = await mfaStatus({ client, userId });
  const draft = !status.enrolled && (setup || status.pending) ? await pendingEnrolment({ client, userId }) : null;
  const required = await isMfaRequired(client);
  const canPolicy = can(session, MFA_POLICY_CAPABILITY);
  return (
    <>
      <section className="panel p-4">
        <h2 className="panel-title">Two-factor authentication</h2>
        {status.enrolled ? (
          <>
            <p className="mt-2 text-sm">On since {status.confirmedAt?.slice(0, 10)} · {status.remainingRecoveryCodes} recovery code{status.remainingRecoveryCodes === 1 ? '' : 's'} left.</p>
            <h3 className="mt-4 text-sm font-semibold">Recovery codes</h3>
            <RegeneratePanel />
            <h3 className="mt-4 text-sm font-semibold">Turn off</h3>
            <p className="text-xs text-ink-soft">Needs your password and a current code.</p>
            <DisablePanel />
          </>
        ) : draft ? (
          <div className="mt-2 space-y-2 text-sm">
            <p>Scan the QR code with an authenticator app, or enter the key by hand, then confirm with the code it shows. Nothing is protected until you confirm.</p>
            {draft.qrDataUri && (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={draft.qrDataUri} alt="QR code for your authenticator app" width={192} height={192} className="bg-white" />
            )}
            <p className="code select-all break-all">{draft.secretBase32.match(/.{1,4}/g)?.join(' ')}</p>
            <p className="break-all text-xs text-ink-faint">URI: <span className="select-all">{draft.otpauthUri}</span></p>
            <ConfirmPanel />
          </div>
        ) : (
          <>
            <p className="mt-2 text-sm text-ink-soft">Not set up. Sign-in asks for a password only.</p>
            <form action={beginEnrolmentAction} className="mt-3"><button type="submit" className="btn btn-primary">Set up</button></form>
          </>
        )}
      </section>

      {canPolicy && (
        <section className="panel p-4">
          <h2 className="panel-title">Tenant policy</h2>
          <form action={setMfaRequiredAction} className="mt-3 space-y-2">
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" name="required" value="1" defaultChecked={required} />
              Require two-factor authentication for everyone in this tenant.
            </label>
            <p className="text-xs text-ink-soft">Off by default. When on, a user who has none is taken to set it up after the password and before any session exists.</p>
            <button type="submit" className="btn btn-primary">Save</button>
          </form>
        </section>
      )}
    </>
  );
}
