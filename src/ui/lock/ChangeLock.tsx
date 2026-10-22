'use client';

import { useEffect, useState } from 'react';

import {
  heartbeatEnqueueAction,
  openChangeLockAction,
  releaseEnqueueAction,
  type ChangeLockState,
} from '@/app/platform/locks/actions';

/** Keeps a lock this session already holds, and drops it when the screen leaves. */
export function ChangeLock({ lockObject, argument }: { lockObject: string; argument: string }) {
  useEffect(() => {
    if (!argument) return undefined;
    const beat = window.setInterval(() => {
      void heartbeatEnqueueAction(lockObject, argument);
    }, 20_000);
    return () => {
      window.clearInterval(beat);
      void releaseEnqueueAction(lockObject, argument);
    };
  }, [lockObject, argument]);
  return null;
}

/**
 * For a screen that chooses the row in the browser. The first session gets
 * change. A second session is told to display, and the save is refused.
 */
export function useChangeLock(
  lockObject: string,
  argument: string | null,
  transactionCode: string,
  enabled: boolean,
): ChangeLockState | null {
  const [open, setOpen] = useState<ChangeLockState | null>(null);
  useEffect(() => {
    if (!enabled || !argument) {
      setOpen(null);
      return undefined;
    }
    let cancelled = false;
    void openChangeLockAction(lockObject, argument, transactionCode).then((result) => {
      if (!cancelled) setOpen(result);
    });
    const beat = window.setInterval(() => {
      void heartbeatEnqueueAction(lockObject, argument);
    }, 20_000);
    return () => {
      cancelled = true;
      window.clearInterval(beat);
      void releaseEnqueueAction(lockObject, argument);
    };
  }, [lockObject, argument, transactionCode, enabled]);
  return open;
}

export function LockNotice({ message }: { message: string | null | undefined }) {
  if (!message) return null;
  return (
    <p role="status" className="border border-signal-warn/40 bg-signal-warn-soft p-3 text-sm text-signal-warn">
      {message}
    </p>
  );
}
