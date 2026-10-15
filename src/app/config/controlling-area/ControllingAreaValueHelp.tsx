'use client';

import { useState } from 'react';
import { t } from '@/platform/i18n';

export interface ControllingAreaChoice {
  code: string;
  name: string;
  isActive?: boolean;
  /** Existing records remain visible in F4 but may be nonselectable for a field's format. */
  selectable?: boolean;
}

interface ControllingAreaValueHelpProps {
  id: string;
  name: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  choices: ControllingAreaChoice[];
  dialogTitle: string;
  openLabel: string;
  emptyText: string;
  rule: string;
  maxLength: number;
  pattern: string;
  required?: boolean;
  readOnly?: boolean;
  disabled?: boolean;
}

/** Keyboard F4 and button-based value help, usable at both desktop and phone widths. */
export function ControllingAreaValueHelp({
  id,
  name,
  label,
  value,
  onChange,
  choices,
  dialogTitle,
  openLabel,
  emptyText,
  rule,
  maxLength,
  pattern,
  required = true,
  readOnly = false,
  disabled = false,
}: ControllingAreaValueHelpProps) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const titleId = `${id}-value-help-title`;
  const canOpen = !disabled && !readOnly && choices.length > 0;
  const normalizedSearch = search.trim().toLocaleLowerCase();
  const visibleChoices = choices.filter((choice) =>
    `${choice.code} ${choice.name}`.toLocaleLowerCase().includes(normalizedSearch),
  );

  function openDialog() {
    if (!canOpen) return;
    setSearch('');
    setOpen(true);
  }

  return (
    <>
      <div className="min-w-0">
        <label htmlFor={id} className="field-label">
          {label}{required && <span className="ms-1 text-signal-error" aria-hidden="true">*</span>}
        </label>
        <div className="mt-1 flex gap-2">
          <input
            id={id}
            name={name}
            type="text"
            required={required}
            minLength={maxLength}
            maxLength={maxLength}
            pattern={pattern}
            title={rule}
            autoComplete="off"
            autoCapitalize="characters"
            value={value}
            readOnly={readOnly}
            disabled={disabled}
            onChange={(event) => onChange(event.currentTarget.value.toUpperCase().slice(0, maxLength))}
            onKeyDown={(event) => {
              if (event.key === 'F4') {
                event.preventDefault();
                openDialog();
              }
            }}
            className={`field-input code min-h-11 min-w-0 flex-1 uppercase sm:min-h-9 ${readOnly ? 'cursor-not-allowed bg-sunken text-ink-soft' : ''}`}
            aria-label={label}
          />
          <button
            type="button"
            className="inline-flex min-h-11 min-w-12 items-center justify-center border border-line bg-sunken px-3 font-mono text-sm font-semibold text-accent hover:bg-white disabled:cursor-not-allowed disabled:opacity-50 sm:min-h-9"
            aria-label={openLabel}
            title={openLabel}
            onClick={openDialog}
            disabled={!canOpen}
          >F4</button>
        </div>
        <p className="mt-1 text-xs text-ink-faint">{rule}</p>
      </div>

      {open && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-3 sm:p-6" onClick={() => setOpen(false)}>
          <section
            role="dialog"
            aria-modal="true"
            aria-labelledby={titleId}
            className="max-h-[92vh] w-full max-w-2xl overflow-y-auto border border-[#8faabd] bg-white shadow-xl"
            onClick={(event) => event.stopPropagation()}
            onKeyDown={(event) => { if (event.key === 'Escape') setOpen(false); }}
          >
            <header className="flex items-center gap-3 border-b border-[#9eb6c8] bg-[#c9dce9] px-4 py-3 text-[#28445b]">
              <h2 id={titleId} className="min-w-0 flex-1 font-semibold">{dialogTitle}</h2>
              <button
                type="button"
                className="inline-flex h-11 w-11 shrink-0 items-center justify-center border border-[#8faabd] bg-white text-lg hover:bg-[#eef3f7] sm:h-9 sm:w-9"
                aria-label={t('common.close')}
                onClick={() => setOpen(false)}
              >×</button>
            </header>
            <div className="border-b border-[#d6dce1] bg-[#eef3f7] p-3">
              <label htmlFor={`${id}-value-help-search`} className="field-label">{t('controllingArea.lookupSearch')}</label>
              <input
                id={`${id}-value-help-search`}
                type="search"
                className="field-input mt-1 min-h-11 w-full sm:min-h-9"
                value={search}
                autoFocus
                onChange={(event) => setSearch(event.currentTarget.value)}
              />
            </div>
            {visibleChoices.length > 0 ? (
              <ul className="divide-y divide-[#d6dce1]">
                {visibleChoices.map((choice) => (
                  <li key={choice.code}>
                    <button
                      type="button"
                      className="flex min-h-14 w-full flex-wrap items-center gap-2 px-4 py-3 text-left hover:bg-[#f4f8fa] disabled:cursor-not-allowed disabled:bg-[#f6f7f8] disabled:text-ink-faint"
                      disabled={choice.selectable === false}
                      onClick={() => {
                        onChange(choice.code);
                        setOpen(false);
                      }}
                    >
                      <span className="code w-20 shrink-0 font-semibold">{choice.code}</span>
                      <span className="min-w-0 flex-1 break-words text-sm">{choice.name}</span>
                      {choice.isActive !== undefined && (
                        <span className={`chip ${choice.isActive ? 'chip-ok' : 'chip-neutral'}`}>
                          {t(choice.isActive ? 'controllingArea.active' : 'controllingArea.inactive')}
                        </span>
                      )}
                      {choice.selectable === false && (
                        <span className="chip chip-warn">{t('controllingArea.valueHelpFormatUnavailable')}</span>
                      )}
                    </button>
                  </li>
                ))}
              </ul>
            ) : (
              <p role="status" className="p-5 text-center text-sm text-ink-soft">{emptyText}</p>
            )}
            <footer className="flex justify-end border-t border-[#d6dce1] p-3">
              <button type="button" className="btn btn-default min-h-11 sm:min-h-9" onClick={() => setOpen(false)}>{t('common.cancel')}</button>
            </footer>
          </section>
        </div>
      )}
    </>
  );
}
