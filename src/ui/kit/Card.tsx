import type { ReactNode } from 'react';

import { cn } from './cn';

/** A bordered block with an optional header row (title left, actions right). Content stays open. */
export function Card({ title, actions, children, className, bodyClassName }: {
  title?: ReactNode; actions?: ReactNode; children: ReactNode; className?: string; bodyClassName?: string;
}) {
  return (
    <section className={cn('panel', className)}>
      {title || actions ? (
        <div className="panel-header flex-wrap gap-2">
          <h2 className="panel-title">{title}</h2>
          {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
        </div>
      ) : null}
      <div className={cn('p-3 sm:p-4', bodyClassName)}>{children}</div>
    </section>
  );
}
