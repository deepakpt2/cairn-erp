'use client';

import { useActionState } from 'react';

import { t } from '@/platform/i18n';

import { deleteEnqueueAction, type LockDeleteState } from './actions';

const empty: LockDeleteState = { ok: false };

export function DeleteLock() {
  const [state, action, pending] = useActionState(deleteEnqueueAction, empty);
  return (
    <form action={action} className="panel space-y-3 p-4">
      <h2 className="panel-title">{t('enqueue.delete')}</h2>
      <p className="text-sm text-ink-soft">{t('enqueue.deleteHint')}</p>
      <div className="grid gap-3 sm:grid-cols-3">
        <label>
          <span className="field-label">{t('enqueue.object')}</span>
          <input name="lockObject" className="field-input code" required maxLength={40} />
        </label>
        <label>
          <span className="field-label">{t('enqueue.argument')}</span>
          <input name="argument" className="field-input code" required maxLength={200} />
        </label>
        <label>
          <span className="field-label">{t('enqueue.reason')}</span>
          <input name="reason" className="field-input" required minLength={3} maxLength={200} />
        </label>
      </div>
      <button type="submit" className="btn btn-default min-h-11 sm:min-h-8" disabled={pending}>
        {t('enqueue.delete')}
      </button>
      {state.message && (
        <p role="status" className={`text-sm ${state.ok ? 'text-ink' : 'text-signal-error'}`}>
          {state.message}{state.remedy ? ` ${state.remedy}` : ''}
        </p>
      )}
    </form>
  );
}
