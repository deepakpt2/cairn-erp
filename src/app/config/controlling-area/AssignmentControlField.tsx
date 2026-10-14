'use client';

import { t } from '@/platform/i18n';

interface AssignmentControlFieldProps {
  id: string;
  value: 'SINGLE' | 'MULTIPLE';
  onChange: (value: 'SINGLE' | 'MULTIPLE') => void;
  disabled?: boolean;
  singleDisabled?: boolean;
}

/** Required owner-supplied Assignment Control dropdown and verbatim help copy. */
export function AssignmentControlField({
  id,
  value,
  onChange,
  disabled = false,
  singleDisabled = false,
}: AssignmentControlFieldProps) {
  return (
    <div className="min-w-0 sm:col-span-2">
      <label htmlFor={id} className="field-label">
        {t('controllingArea.assignmentControl')} <span className="ms-1 text-signal-error" aria-hidden="true">*</span>
      </label>
      <select
        id={id}
        name="companyCodeScope"
        required
        value={value}
        disabled={disabled}
        aria-describedby={`${id}-control-copy`}
        onChange={(event) => onChange(event.currentTarget.value as 'SINGLE' | 'MULTIPLE')}
        className="field-input mt-1 min-h-11 w-full sm:min-h-9"
      >
        <option value="SINGLE" disabled={singleDisabled}>{t('controllingArea.optionSingle')}</option>
        <option value="MULTIPLE">{t('controllingArea.optionMultiple')}</option>
      </select>
      {singleDisabled && (
        <p role="status" className="mt-2 text-xs text-signal-warn">{t('controllingArea.singleScopeBlocked')}</p>
      )}
      <div id={`${id}-control-copy`} className="mt-3 space-y-3 border border-line bg-[#f7f9fa] p-3 text-sm text-ink-soft sm:p-4">
        <h3 className="font-semibold text-ink">{t('controllingArea.scopeHeading')}</h3>
        <p>{t('controllingArea.scopeDescription')}</p>
        <ul className="list-disc space-y-2 ps-5">
          <li><strong className="text-ink">{t('controllingArea.optionSingle')}</strong> {t('controllingArea.optionSingleDescription')}</li>
          <li><strong className="text-ink">{t('controllingArea.optionMultiple')}</strong> {t('controllingArea.optionMultipleDescription')}</li>
        </ul>
        <p>{t('controllingArea.scopeHelpIntro')}</p>
        <ul className="list-disc space-y-1 ps-5">
          <li>{t('controllingArea.scopeHelpSingle')}</li>
          <li>{t('controllingArea.scopeHelpMultiple')}</li>
        </ul>
        <p>{t('controllingArea.scopeHelpConclusion')}</p>
      </div>
    </div>
  );
}
