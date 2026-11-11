'use client';

import { useActionState } from 'react';
import { useFormStatus } from 'react-dom';

import { t } from '@/platform/i18n';

import { cancelRun, retryRun, type JobActionState } from './actions';

const INITIAL: JobActionState = { ok: true };

function Submit({ label, busy }: { label: string; busy: string }) {
  const { pending } = useFormStatus();
  return (
    <button type="submit" className="btn btn-default min-h-11 sm:min-h-8" disabled={pending}>
      {pending ? busy : label}
    </button>
  );
}

/** Cancel and retry for one run, shown only where they would do anything. */
export function JobControls({
  runId,
  canCancel,
  canRetry,
}: {
  runId: string;
  canCancel: boolean;
  canRetry: boolean;
}) {
  const [cancelState, cancelAction] = useActionState(cancelRun, INITIAL);
  const [retryState, retryAction] = useActionState(retryRun, INITIAL);

  return (
    <div className="flex flex-wrap items-center gap-2">
      {canCancel && (
        <form action={cancelAction}>
          <input type="hidden" name="runId" value={runId} />
          <Submit label={t('jobs.cancel')} busy={t('jobs.cancelling')} />
        </form>
      )}
      {canRetry && (
        <form action={retryAction}>
          <input type="hidden" name="runId" value={runId} />
          <Submit label={t('jobs.retry')} busy={t('jobs.retrying')} />
        </form>
      )}
      {!cancelState.ok && cancelState.message && (
        <span role="alert" className="text-xs text-ink-soft">{t(`jobs.${cancelState.message}`)}</span>
      )}
      {!retryState.ok && retryState.message && (
        <span role="alert" className="text-xs text-ink-soft">{t(`jobs.${retryState.message}`)}</span>
      )}
    </div>
  );
}
