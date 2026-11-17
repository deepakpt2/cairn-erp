import type { ReactNode } from 'react';

import { cn } from './cn';

/**
 * A data table. Wraps `.grid-table` in a scroll container so a wide table scrolls inside itself
 * on a phone instead of widening the page. Use `<Th numeric>` / `<Td numeric>` for figures.
 */
export function Table({ children, className, caption }:
  { children: ReactNode; className?: string; caption?: string }) {
  return (
    <div className="table-scroll">
      <table className={cn('grid-table', className)}>
        {caption ? <caption className="sr-only">{caption}</caption> : null}
        {children}
      </table>
    </div>
  );
}

export function Th({ numeric, className, ...rest }: React.ThHTMLAttributes<HTMLTableCellElement> & { numeric?: boolean }) {
  return <th scope="col" className={cn(numeric && 'num', className)} {...rest} />;
}

export function Td({ numeric, className, ...rest }: React.TdHTMLAttributes<HTMLTableCellElement> & { numeric?: boolean }) {
  return <td className={cn(numeric && 'num', className)} {...rest} />;
}

/** The row shown when a table has nothing to list. */
export function EmptyRow({ cols, children = 'Nothing to show.' }: { cols: number; children?: ReactNode }) {
  return <tr><td colSpan={cols} className="px-3 py-4 text-center text-ink-soft">{children}</td></tr>;
}
