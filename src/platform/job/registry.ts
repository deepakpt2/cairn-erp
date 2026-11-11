/**
 * The job registry.
 *
 * Handlers register themselves; the worker looks them up by code. Nothing here
 * knows what any job does, and nothing the worker does depends on there being
 * any particular job — so a new long-running process is a new file that calls
 * `registerJob`, and no change to the runtime.
 *
 * Registration is deliberately permissive about *when* it happens and strict
 * about duplicates. Two handlers claiming the same code is a bug that should
 * stop the process at startup, not a race resolved silently by import order.
 */

import type { JobHandler } from './types';

const handlers = new Map<string, JobHandler>();

export function registerJob(handler: JobHandler): void {
  const existing = handlers.get(handler.code);
  if (existing && existing !== handler) {
    throw new Error(
      `Two job handlers registered for ${handler.code}. A job code identifies exactly one handler.`,
    );
  }
  handlers.set(handler.code, handler);
}

/** The handler for a code, or undefined when nobody has registered one. */
export function handlerFor(code: string): JobHandler | undefined {
  return handlers.get(code);
}

export function registeredJobs(): string[] {
  return [...handlers.keys()].sort();
}

/**
 * Forget every handler. Tests call this so one file's registrations cannot
 * leak into the next; production never needs it.
 */
export function clearJobRegistry(): void {
  handlers.clear();
}
