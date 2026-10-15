'use client';

import { useState } from 'react';
import { t } from '@/platform/i18n';

export interface AccountChoice {
  code: string;
  name: string;
}

/**
 * Searchable F4 help for account-number-shaped keys.
 *
 * OB13's value help is fixed at four characters because it selects charts; FS00 needs
 * the same dialog for up to ten alphanumeric characters with leading zeros preserved,
 * so the length and the input pattern are parameters rather than constants. Values are
 * never case-folded or stripped: `0010` and `010` are different accounts.
 */
export function GlAccountValueHelp({
  id,
  name,
  label,
  value,
  onChange,
  choices,
  dialogTitle,
  emptyText,
  rule,
  maxLength,
  disabled = false,
  required = false,
  readOnly = false,
}: {
  id: string;
  name: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  choices: AccountChoice[];
  dialogTitle: string;
  emptyText: string;
  rule: string;
  maxLength: number;
  disabled?: boolean;
  required?: boolean;
  readOnly?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const titleId = `${id}-lookup-title`;
  const term = search.trim().toLocaleLowerCase();
  const filtered = choices.filter((choice) =>
    `${choice.code} ${choice.name}`.toLocaleLowerCase().includes(term),
  );

  function openLookup() {
    if (disabled || readOnly || choices.length === 0) return;
    setSearch('');
    setOpen(true);
  }

  return (
    <>
      <div className="min-w-0">
        <label htmlFor={id} className="field-label">
          {label}
          {required && <span className="ms-1 text-signal-error" aria-hidden="true">*</span>}
        </label>
        <div className="mt-1 flex gap-2">
          <input
            id={id}
            name={name}
            type="text"
            inputMode="text"
            autoComplete="off"
            maxLength={maxLength}
            required={required}
            readOnly={readOnly}
            disabled={disabled}
            value={value}
            onChange={(event) => onChange(event.currentTarget.value.replace(/[^A-Za-z0-9]/g, '').slice(0, maxLength))}
            onKeyDown={(event) => {
              if (event.key === 'F4') {
                event.preventDefault();
                openLookup();
              }
            }}
            className="field-input code min-h-11 min-w-0 flex-1 sm:min-h-9"
            aria-label={label}
          />
          <button
            type="button"
            className="inline-flex min-h-11 min-w-12 items-center justify-center border border-line bg-sunken px-3 font-mono text-sm font-semibold text-accent hover:bg-white disabled:cursor-not-allowed disabled:opacity-50 sm:min-h-9"
            aria-label={`${dialogTitle} (F4)`}
            title={`${dialogTitle} (F4)`}
            onClick={openLookup}
            disabled={disabled || readOnly || choices.length === 0}
          >
            F4
          </button>
        </div>
        <p className="mt-1 text-xs text-ink-faint">{rule}</p>
      </div>

      {open && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-3 sm:p-6"
          onClick={() => setOpen(false)}
        >
          <section
            role="dialog"
            aria-modal="true"
            aria-labelledby={titleId}
            className="max-h-[92vh] w-full max-w-2xl overflow-y-auto border border-[#8faabd] bg-white shadow-xl"
            onClick={(event) => event.stopPropagation()}
            onKeyDown={(event) => {
              if (event.key === 'Escape') setOpen(false);
            }}
          >
            <header className="flex items-center gap-3 border-b border-[#9eb6c8] bg-[#c9dce9] px-4 py-3 text-[#28445b]">
              <h2 id={titleId} className="min-w-0 flex-1 font-semibold">{dialogTitle}</h2>
              <button
                type="button"
                className="inline-flex h-11 w-11 shrink-0 items-center justify-center border border-[#8faabd] bg-white text-lg hover:bg-[#eef3f7] sm:h-9 sm:w-9"
                aria-label={t('common.close')}
                onClick={() => setOpen(false)}
              >
                ×
              </button>
            </header>
            <div className="border-b border-[#d6dce1] bg-[#eef3f7] p-3">
              <label htmlFor={`${id}-search`} className="field-label">{t('chartOfAccounts.lookupSearch')}</label>
              <input
                id={`${id}-search`}
                type="search"
                className="field-input mt-1 min-h-11 w-full sm:min-h-9"
                value={search}
                autoFocus
                onChange={(event) => setSearch(event.currentTarget.value)}
              />
            </div>
            {filtered.length > 0 ? (
              <ul className="divide-y divide-[#d6dce1]">
                {filtered.map((choice) => (
                  <li key={choice.code}>
                    <button
                      type="button"
                      className="flex min-h-14 w-full flex-wrap items-center gap-2 px-4 py-3 text-left hover:bg-[#f4f8fa]"
                      onClick={() => {
                        onChange(choice.code);
                        setOpen(false);
                      }}
                    >
                      <span className="code w-24 shrink-0 font-semibold">{choice.code}</span>
                      <span className="min-w-0 flex-1 break-words text-sm">{choice.name}</span>
                    </button>
                  </li>
                ))}
              </ul>
            ) : (
              <p role="status" className="p-5 text-center text-sm text-ink-soft">{emptyText}</p>
            )}
            <footer className="flex justify-end border-t border-[#d6dce1] p-3">
              <button type="button" className="btn btn-default min-h-11 sm:min-h-9" onClick={() => setOpen(false)}>
                {t('common.cancel')}
              </button>
            </footer>
          </section>
        </div>
      )}
    </>
  );
}
