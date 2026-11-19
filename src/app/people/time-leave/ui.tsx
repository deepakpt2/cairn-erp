'use client';

import type { ReactNode } from 'react';

import type { LeaveActionState } from '@/app/people/leave-live';

export const INPUT = 'w-full border rounded px-2 py-1 text-sm';

export function Notice({ state }: { state: LeaveActionState }) {
  if (!state.message) return null;
  return (
    <div className={state.ok ? 'panel panel-success mt-2 p-3 text-sm' : 'panel panel-danger mt-2 p-3 text-sm'} role="status">
      <p className="font-medium">{state.message}</p>
      {state.remedy ? <p className="mt-1 text-ink-soft">{state.remedy}</p> : null}
    </div>
  );
}

export function L({ label, children, span = 1 }: { label: string; children: ReactNode; span?: 1 | 2 | 4 }) {
  return (
    <label className={`block ${span === 2 ? 'sm:col-span-2' : span === 4 ? 'sm:col-span-4' : ''}`}>
      <span className="block text-xs text-ink-soft mb-1">{label}</span>{children}
    </label>
  );
}

export function Section({ title, hint, children }: { title: string; hint?: string; children: ReactNode }) {
  return (
    <section className="mt-4 border panel p-3">
      <h2 className="text-sm font-semibold mb-2">{title}</h2>
      {hint ? <p className="text-sm text-ink-soft mb-2">{hint}</p> : null}
      {children}
    </section>
  );
}
