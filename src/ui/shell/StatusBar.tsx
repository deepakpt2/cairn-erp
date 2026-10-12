import { t } from '@/platform/i18n';
import { getSession } from '@/platform/auth/current';

const DEVELOPMENT_UI_BUILD_CODE = 'DEV-SCR015-ASSIGN-20261012';

/**
 * Status bar — CAIRN.md §19.1.
 *
 * Menu path, current context, and function-key hints. Orientation without
 * decoration: it tells you where you are and what the keys do, and then stops.
 */
export async function StatusBar() {
  const session = await getSession();
  const environment = process.env.CAIRN_ENV ?? 'development';
  const showDevelopmentBuildCode =
    process.env.NODE_ENV === 'development' || process.env.CAIRN_ENV === 'development';

  return (
    <footer className="status-bar">
      <div className="flex items-center gap-3">
        <span>{t('status.ready')}</span>
        <span className="text-line-strong" aria-hidden>
          |
        </span>
        <span className="text-ink-faint">{session ? `${session.user.client} · ${session.user.username}` : t('status.noTenant')}</span>
      </div>

      <div className="flex items-center gap-3">
        <span className="hidden sm:inline">
          <kbd>Enter</kbd> execute
        </span>
        <span className="hidden sm:inline">
          <kbd>F3</kbd> back
        </span>
        <span className="text-line-strong" aria-hidden>
          |
        </span>
        <span>
          {t('status.environment')}: <span className="code">{environment}</span>
        </span>
        {showDevelopmentBuildCode && (
          <span
            className="whitespace-nowrap border border-signal-warn/40 bg-signal-warn-soft px-1.5 py-0.5 text-2xs text-signal-warn"
            data-testid="development-ui-build-code"
            title="Development UI build code"
          >
            DEV UI: <span className="font-mono">{DEVELOPMENT_UI_BUILD_CODE}</span>
          </span>
        )}
      </div>
    </footer>
  );
}
