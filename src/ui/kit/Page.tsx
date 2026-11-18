import type { ReactNode } from 'react';

import { cn } from './cn';
import { LinkButton } from './Button';

/** Page widths in use across the app. Full class names so Tailwind can see them. */
const WIDTHS = {
  '3xl': 'max-w-3xl',
  '4xl': 'max-w-4xl',
  '5xl': 'max-w-5xl',
  '6xl': 'max-w-6xl',
  '7xl': 'max-w-7xl',
  '100rem': 'max-w-[100rem]',
  '120rem': 'max-w-[120rem]',
} as const;

export type PageWidth = keyof typeof WIDTHS;

/**
 * The page frame every screen shares: width, spacing and the header. `code` is the capability or
 * transaction code shown above the title; `actions` sit right of the title and wrap on a phone.
 * `description` is a string, or paragraphs (`<p className="max-w-3xl text-sm text-ink-soft">`).
 */
export function Page({ title, code, description, actions, back = { href: '/', label: 'Launchpad' }, width = '6xl', wide, children }: {
  title: ReactNode;
  code?: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  /** Pass `null` to drop the default link back to the launchpad. */
  back?: { href: string; label: string } | null;
  width?: PageWidth;
  /** Same as `width="7xl"`. */
  wide?: boolean;
  children: ReactNode;
}) {
  return (
    <div className={cn('mx-auto space-y-4 p-3 sm:p-4 lg:p-6', WIDTHS[wide ? '7xl' : width])}>
      <header className="border-b border-line pb-4">
        {code ? <span className="code text-ink-faint">{code}</span> : null}
        <div className="mt-1 flex flex-wrap items-center justify-between gap-3">
          <h1 className="text-xl font-semibold tracking-tight">{title}</h1>
          {actions || back ? (
            <div className="flex flex-wrap items-center gap-2">
              {actions}
              {back ? <LinkButton href={back.href}>{back.label}</LinkButton> : null}
            </div>
          ) : null}
        </div>
        {description ? (
          typeof description === 'string'
            ? <p className="mt-2 max-w-3xl text-sm text-ink-soft">{description}</p>
            : <div className="mt-2 space-y-2">{description}</div>
        ) : null}
      </header>
      {children}
    </div>
  );
}
