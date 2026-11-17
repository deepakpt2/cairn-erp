import type { ReactNode } from 'react';

import { cn } from './cn';

/**
 * Label, control, hint and error as one unit. The control is passed as children; give it
 * `className="field-input"` (or the older `input`). `htmlFor` should match the control's id.
 */
export function Field({ label, htmlFor, hint, error, children, className }: {
  label: ReactNode; htmlFor?: string; hint?: ReactNode; error?: ReactNode; children: ReactNode; className?: string;
}) {
  return (
    <div className={cn('block', className)}>
      <label htmlFor={htmlFor} className="field-label">{label}</label>
      {children}
      {hint ? <p className="field-hint">{hint}</p> : null}
      {error ? <p className="mt-0.5 text-2xs text-signal-error" role="alert">{error}</p> : null}
    </div>
  );
}

/** A responsive grid for fields: one column on a phone, two from `sm`, `cols` from `lg`. */
export function FormGrid({ cols = 3, children, className }:
  { cols?: 2 | 3 | 4; children: ReactNode; className?: string }) {
  const lg = { 2: 'lg:grid-cols-2', 3: 'lg:grid-cols-3', 4: 'lg:grid-cols-4' }[cols];
  return <div className={cn('grid grid-cols-1 gap-3 sm:grid-cols-2', lg, className)}>{children}</div>;
}

/** The buttons that submit or cancel a form. Sticks to the bottom of the screen on a phone. */
export function ActionRow({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn('action-row md:mt-3 md:flex md:flex-wrap md:items-center md:gap-2', className)}>{children}</div>;
}
