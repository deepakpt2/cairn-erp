import type { ReactNode } from 'react';

import { cn } from './cn';

/** Label/value pairs for a document header. Two columns on a phone, `cols` from `lg`. */
export function KeyValue({ items, cols = 4, className }: {
  items: Array<{ label: ReactNode; value: ReactNode }>; cols?: 2 | 3 | 4; className?: string;
}) {
  const lg = { 2: 'lg:grid-cols-2', 3: 'lg:grid-cols-3', 4: 'lg:grid-cols-4' }[cols];
  return (
    <dl className={cn('grid grid-cols-2 gap-x-4 gap-y-3', lg, className)}>
      {items.map((item, i) => (
        <div key={i} className="min-w-0">
          <dt className="field-label">{item.label}</dt>
          <dd className="break-words text-sm">{item.value ?? '—'}</dd>
        </div>
      ))}
    </dl>
  );
}
