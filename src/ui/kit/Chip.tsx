import type { ReactNode } from 'react';

import { cn } from './cn';

const TONES = {
  ok: 'chip-ok', warn: 'chip-warn', error: 'chip-error', neutral: 'chip-neutral', info: 'chip-info',
} as const;

export type ChipTone = keyof typeof TONES;

/** A status label. The text carries the meaning; the colour only reinforces it. */
export function Chip({ tone = 'neutral', className, children }:
  { tone?: ChipTone; className?: string; children: ReactNode }) {
  return <span className={cn('chip', TONES[tone], className)}>{children}</span>;
}
