/**
 * Who is signed in, and where — CAIRN.md §19.1.
 *
 * The tenant and user are shown on every screen because in a multi-company
 * install they are the two facts a user must never have to guess. Posting into
 * the wrong company code is the classic costly mistake, and the reference model
 * answers it the same way: the current client is always visible.
 */
import { getSession } from '@/platform/auth/current';
import { t } from '@/platform/i18n';

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

  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1 border-b border-line bg-sunken px-4 py-1 text-2xs text-ink-soft">
      <span className="text-ink-faint">{t('auth.tenant')}</span>
      <span className="code font-medium text-ink">{session.user.client}</span>
      <span className="text-line-strong" aria-hidden>
        |
      </span>
      <span className="text-ink">{session.user.fullName}</span>
      <span className="text-ink-faint">({session.user.username})</span>
      <span className="text-line-strong" aria-hidden>
        |
      </span>
      <span className="text-ink-faint">
        {session.user.capabilities.includes('*') ? t('auth.fullAccess') : `${session.user.capabilities.length} ${t('auth.authorities')}`}
      </span>

      <form method="post" action="/api/auth/signout" className="ms-auto">
        <button type="submit" className="text-accent hover:underline">
          {t('auth.signOut')}
        </button>
      </form>
    </div>
  );
}
