import Link from 'next/link';
import { getSession } from '@/platform/auth/current';
import { t } from '@/platform/i18n';
import { launchpadFor } from './launchpad';

const LINK =
  'flex min-h-10 flex-1 items-center justify-center px-2 text-center text-xs hover:bg-paper sm:min-h-0 sm:flex-none sm:justify-start sm:px-3 sm:text-left sm:text-sm';

/**
 * The links at the right of the command bar, decided on the server from what the reader holds.
 *
 * Tenants and the configuration workbench are setup areas: they are offered only to a reader who holds the
 * authority behind them (the same test as the launchpad's setup tiles). The term registry is a lookup open to
 * any signed-in reader. Signed out there is nothing to offer, except in local development, where there is
 * no session by design and the links stay as they were. Hiding a link is a courtesy; each page still enforces
 * its own authority.
 */
export async function CommandBarLinks() {
  const session = await getSession();
  const setup = session ? launchpadFor(session.user.capabilities).setup : [];
  const dev = !session && process.env.CAIRN_ENV === 'development';
  const links = [
    { href: '/clients', label: t('nav.tenants'), show: dev || setup.includes('tenants') },
    { href: '/config', label: t('nav.workbench'), show: dev || setup.includes('workbench') },
    { href: '/registry', label: t('nav.registry'), show: dev || session !== null },
  ].filter((l) => l.show);
  if (links.length === 0) return null;
  return (
    <nav className="flex w-full shrink-0 items-stretch border-t border-line sm:w-auto sm:border-t-0 sm:border-s">
      {links.map((l) => (
        <Link key={l.href} href={l.href} className={LINK}>{l.label}</Link>
      ))}
    </nav>
  );
}
