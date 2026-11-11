/**
 * Who is signed in, and where — CAIRN.md §19.1.
 *
 * The tenant and user are shown on every screen because in a multi-company
 * install they are the two facts a user must never have to guess. Posting into
 * the wrong company code is the classic costly mistake, and the reference model
 * answers it the same way: the current client is always visible.
 *
 * The two halves answer different questions, which is why they sit at opposite
 * ends. On the leading edge: which company am I posting into, and how wide is
 * my authority here. On the trailing edge: who am I, what is waiting for me,
 * and how do I leave. Putting the user beside the tenant invited reading the
 * two as one phrase and mistaking the client code for part of the name.
 */
import { getSession } from '@/platform/auth/current';
import { t } from '@/platform/i18n';
import { NotificationBell } from '@/ui/shell/NotificationBell';
import { SessionMenu } from '@/ui/shell/SessionMenu';

const SIGNOUT_ACTION = '/api/auth/signout';

export async function SessionBar() {
  const session = await getSession();

  if (!session) {
    return (
      <div className="flex items-center gap-3 border-b border-line bg-sunken px-4 py-1 text-2xs text-ink-soft">
        <span>{t('auth.signIn')}</span>
        <a href="/signin" className="text-accent hover:underline">
          {t('auth.signIn')}
        </a>
      </div>
    );
  }

  const authority = session.user.capabilities.includes('*')
    ? t('auth.fullAccess')
    : `${session.user.capabilities.length} ${t('auth.authorities')}`;

  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1 border-b border-line bg-sunken px-4 py-1 text-2xs text-ink-soft">
      <span className="text-ink-faint">{t('auth.tenant')}</span>
      <span className="code font-medium text-ink">{session.user.client}</span>
      <span className="text-line-strong" aria-hidden>
        |
      </span>
      <span className="text-ink-faint">{authority}</span>

      <div className="ms-auto flex items-center gap-3">
        <NotificationBell />
        <SessionMenu
          fullName={session.user.fullName}
          username={session.user.username}
          signOutLabel={t('auth.signOut')}
          signOutAction={SIGNOUT_ACTION}
        />
      </div>
    </div>
  );
}
