import type { ReactNode } from 'react';

import { cn } from './cn';
import { LinkButton } from './Button';

/**
 * The page frame every screen shares: width, spacing and the header. `code` is the capability or
 * transaction code shown above the title; `actions` sit right of the title and wrap on a phone.
 */
export function Page({ title, code, description, actions, back = { href: '/', label: 'Launchpad' }, wide, children }: {
  title: string;
  code?: string;
  description?: ReactNode;
  actions?: ReactNode;
  /** Pass `null` to drop the default link back to the launchpad. */
  back?: { href: string; label: string } | null;
  wide?: boolean;
  children: ReactNode;
}) {
  return (
    <div className={cn('mx-auto space-y-4 p-3 sm:p-4 lg:p-6', wide ? 'max-w-7xl' : 'max-w-6xl')}>
      <header className="border-b border-line pb-4">
        {code ? <span className="code text-ink-faint">{code}</span> : null}
        <div className="mt-1 flex flex-wrap items-center justify-between gap-3">
          <h1 className="text-xl font-semibold tracking-tight">{title}</h1>
          <div className="flex flex-wrap items-center gap-2">
            {actions}
            {back ? <LinkButton href={back.href}>{back.label}</LinkButton> : null}
          </div>
        </div>
        {description ? <p className="mt-2 max-w-3xl text-sm text-ink-soft">{description}</p> : null}
      </header>
      {children}
    </div>
  );
}
