'use client';

import { useState } from 'react';

import { t } from '@/platform/i18n';
import { LockNotice, useChangeLock } from '@/ui/lock/ChangeLock';
import { cancelListedAction } from './actions';

/** Cancel one listed document. The lock is taken when this confirm opens, not when the list renders. */
export function CancelListed({ number, year }: { number: string; year: string | number }) {
  const argument = `${number.trim()}/${year}`;
  const [open, setOpen] = useState(false);
  const lock = useChangeLock('PHYSICAL_INVENTORY', argument, 'INV.PHYINV.CANCEL', open);
  const held = lock?.mode === 'CHANGE';

  return (
    <details className="min-w-24" onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary className="min-h-11 cursor-pointer py-2 text-sm text-accent sm:min-h-8">{t('mi01.cancel')}</summary>
      <form action={cancelListedAction} className="mt-2 space-y-2">
        <input type="hidden" name="inventoryDocumentNumber" value={number} />
        <input type="hidden" name="fiscalYear" value={year} />
        <LockNotice message={lock?.mode === 'DISPLAY' ? lock.message : null} />
        <button type="submit" className="btn btn-default min-h-11 sm:min-h-8" data-cancel={number} disabled={!held}>
          {t('mi01.cancel')}
        </button>
      </form>
    </details>
  );
}
