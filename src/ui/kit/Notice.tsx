import { AlertTriangle, CheckCircle2, Info, XCircle } from 'lucide-react';
import type { ReactNode } from 'react';

import { cn } from './cn';

const TONES = {
  ok: { box: 'border-signal-ok/30 bg-signal-ok-soft', icon: CheckCircle2, color: 'text-signal-ok' },
  warn: { box: 'border-signal-warn/30 bg-signal-warn-soft', icon: AlertTriangle, color: 'text-signal-warn' },
  error: { box: 'border-signal-error/30 bg-signal-error-soft', icon: XCircle, color: 'text-signal-error' },
  info: { box: 'border-signal-info/30 bg-signal-info-soft', icon: Info, color: 'text-signal-info' },
} as const;

export type NoticeTone = keyof typeof TONES;

/**
 * A message about what just happened or what the reader must know. Errors use role="alert", the
 * rest role="status". `remedy` is the "what to do about it" line the action state carries.
 */
export function Notice({ tone = 'info', title, remedy, children, className }: {
  tone?: NoticeTone; title?: ReactNode; remedy?: ReactNode; children?: ReactNode; className?: string;
}) {
  const t = TONES[tone];
  const Icon = t.icon;
  return (
    <div role={tone === 'error' ? 'alert' : 'status'}
      className={cn('flex gap-2 rounded border p-3 text-sm', t.box, className)}>
      <Icon aria-hidden className={cn('mt-0.5 h-4 w-4 shrink-0', t.color)} />
      <div className="min-w-0 flex-1">
        {title ? <p className="font-medium">{title}</p> : null}
        {children ? <div className={title ? 'mt-1' : ''}>{children}</div> : null}
        {remedy ? <p className="mt-1 text-ink-soft">{remedy}</p> : null}
      </div>
    </div>
  );
}
