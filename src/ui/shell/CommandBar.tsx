import Link from 'next/link';
import { t } from '@/platform/i18n';
import { executeCommand } from '@/app/command';

/**
 * The command bar — CAIRN.md §19.1.
 *
 * Kept as a plain form so it works with no client-side JavaScript at all, which
 * means it works the same on a slow warehouse terminal as on a desktop. Enter
 * executes, exactly as an experienced user expects.
 */
export function CommandBar() {
  return (
    <header className="sticky top-0 z-20">
      <div className="flex flex-wrap items-stretch border-b border-line bg-sunken">
        <Link
          href="/"
          className="flex items-center gap-2 border-e border-line px-4 py-2 hover:bg-paper"
        >
          {/* Placeholder mark (§27 item 10) — neutral, ours, swappable. */}
          <span
            aria-hidden
            className="flex h-5 w-5 items-center justify-center border border-accent bg-accent text-2xs font-bold text-white"
          >
            C
          </span>
          <span className="text-sm font-semibold tracking-tight">{t('app.name')}</span>
        </Link>

        <form action={executeCommand} className="command-bar min-w-0 flex-1 border-0">
          <label htmlFor="command-input" className="sr-only">
            {t('command.label')}
          </label>
          <input
            id="command-input"
            name="term"
            type="text"
            className="min-w-0 flex-1"
            autoComplete="off"
            autoFocus
            placeholder={t('command.placeholder')}
            aria-describedby="command-help"
          />
          <button type="submit" className="btn btn-default border-0 border-s border-line">
            {t('command.execute')}
          </button>
        </form>

        <nav className="flex w-full shrink-0 items-stretch border-t border-line sm:w-auto sm:border-t-0 sm:border-s">
          <Link href="/clients" className="flex min-h-10 flex-1 items-center justify-center px-2 text-center text-xs hover:bg-paper sm:min-h-0 sm:flex-none sm:justify-start sm:px-3 sm:text-left sm:text-sm">
            {t('nav.tenants')}
          </Link>
          <Link href="/config" className="flex min-h-10 flex-1 items-center justify-center px-2 text-center text-xs hover:bg-paper sm:min-h-0 sm:flex-none sm:justify-start sm:px-3 sm:text-left sm:text-sm">
            {t('nav.workbench')}
          </Link>
          <Link href="/registry" className="flex min-h-10 flex-1 items-center justify-center px-2 text-center text-xs hover:bg-paper sm:min-h-0 sm:flex-none sm:justify-start sm:px-3 sm:text-left sm:text-sm">
            {t('nav.registry')}
          </Link>
        </nav>
      </div>
    </header>
  );
}
