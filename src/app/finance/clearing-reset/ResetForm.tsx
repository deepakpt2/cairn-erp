'use client';

import { LockNotice, useChangeLock } from '@/ui/lock/ChangeLock';

/** The opened clearing document, not the search screen. */
export function ResetForm({
  action,
  companyCode,
  clearingDocument,
  fiscalYear,
}: {
  action: (formData: FormData) => void | Promise<void>;
  companyCode: string;
  clearingDocument: string;
  fiscalYear: number;
}) {
  const argument = `${companyCode}/${clearingDocument}/${fiscalYear}`;
  const lock = useChangeLock('CLEARING_DOCUMENT', argument, 'FIN.CLEARING.RESET', true);
  return (
    <form
      action={action}
      className="mt-4 grid gap-3 sm:grid-cols-2"
      onSubmit={(event) => {
        if (lock?.mode !== 'CHANGE') event.preventDefault();
      }}
    >
      <input type="hidden" name="companyCode" value={companyCode} />
      <input type="hidden" name="clearingDocument" value={clearingDocument} />
      <input type="hidden" name="fiscalYear" value={fiscalYear} />
      <input type="hidden" name="requestKey" value={`cr-${companyCode}-${clearingDocument}-${fiscalYear}`} />
      <label className="block">
        <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-ink-faint">Reason (required)</span>
        <input name="reason" className="input w-full" maxLength={500} required />
      </label>
      <div className="flex flex-wrap items-end gap-3">
        <LockNotice message={lock?.mode === 'DISPLAY' ? lock.message : null} />
        <button type="submit" className="btn btn-primary min-h-11 sm:min-h-8" disabled={lock?.mode !== 'CHANGE'}>
          Reset clearing
        </button>
      </div>
    </form>
  );
}
