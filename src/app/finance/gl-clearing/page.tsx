import Link from 'next/link';

import { can, requireSession } from '@/platform/auth/current';
import { GL_CLEARING_CAPABILITY, type GlClearingView } from '@/modules/finance/gl-clearing';
import GlClearing from './GlClearing';

export const dynamic = 'force-dynamic';

const ROUTE = '/finance/gl-clearing';

/**
 * Clear G/L account (SCR-114 / F-03 as a search alias only).
 */
export default async function GlClearingPage() {
  const session = await requireSession(ROUTE);
  const view: GlClearingView | null = null;
  const today = new Date().toISOString().slice(0, 10);

  return (
    <div className="mx-auto max-w-6xl space-y-4 p-3 sm:p-4 lg:p-6">
      <header className="border-b border-line pb-4">
        <span className="code text-ink-faint">FIN.GL.CLEAR · F-03</span>
        <div className="mt-1 flex flex-wrap items-center justify-between gap-3">
          <h1 className="text-xl font-semibold tracking-tight">Clear G/L Account</h1>
          <Link href="/" className="btn btn-default min-h-11 sm:min-h-8">
            Launchpad
          </Link>
        </div>
        <p className="mt-1 max-w-3xl text-sm text-ink-soft">
          Clear open items of an open-item-managed G/L account against each other. The difference must stand at zero before posting.
        </p>
      </header>

      <GlClearing
        view={view}
        loadError={null}
        canClear={can(session, GL_CLEARING_CAPABILITY)}
        today={today}
      />
    </div>
  );
}
