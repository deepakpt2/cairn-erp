'use client';

import { useEffect, useId, useRef, useState } from 'react';

import { suggestConstrainedAction } from '@/app/constrained-values/actions';
import { CLOSED_KINDS, type ConstrainedContext, type ConstrainedKind, type ConstrainedValue } from '@/modules/foundation/constrained-kinds';
import { t } from '@/platform/i18n';
import { SearchIcon } from './SearchIcon';

interface ConstrainedFieldProps {
  kind: ConstrainedKind;
  name?: string;
  context?: ConstrainedContext;
  value?: string;
  defaultValue?: string;
  onChange?: (value: string) => void;
  onLoaded?: (rows: ConstrainedValue[]) => void;
  required?: boolean;
  disabled?: boolean;
  readOnly?: boolean;
  className?: string;
  placeholder?: string;
  maxLength?: number;
  id?: string;
  /** Uppercase the typed code, as the masters store it. */
  uppercase?: boolean;
}

/**
 * A field the save already constrains.
 *
 * A small set is a dropdown of the legal values. A larger set shows five
 * matches as the user types, and a search icon opens the rest of that match.
 * The list is the same cut the write uses. A typed value is still submitted
 * if the list does not load.
 */
export function ConstrainedField(props: ConstrainedFieldProps) {
  if (CLOSED_KINDS.has(props.kind)) return <ClosedField {...props} />;
  return <SuggestField {...props} />;
}

function useConstrained(kind: ConstrainedKind, query: string, context: ConstrainedContext | undefined, limit: number, enabled: boolean) {
  const [rows, setRows] = useState<ConstrainedValue[]>([]);
  const [pending, setPending] = useState(false);
  const company = context?.companyCode ?? '';
  const plant = context?.plant ?? '';
  const org = context?.purchasingOrg ?? '';
  const material = context?.materialNumber ?? '';
  const dimension = context?.dimension ?? '';
  const postingDate = context?.postingDate ?? '';
  const request = useRef(0);

  useEffect(() => {
    if (!enabled) return undefined;
    const current = ++request.current;
    const handle = setTimeout(() => {
      setPending(true);
      void suggestConstrainedAction({
        kind,
        query,
        limit,
        context: { companyCode: company, plant, purchasingOrg: org, materialNumber: material, dimension, postingDate },
      }).then((next) => {
        if (request.current !== current) return;
        setRows(next);
        setPending(false);
      }).catch(() => {
        if (request.current !== current) return;
        setRows([]);
        setPending(false);
      });
    }, query === '' ? 0 : 180);
    return () => clearTimeout(handle);
  }, [kind, query, limit, enabled, company, plant, org, material, dimension, postingDate]);

  return { rows, pending };
}

function ClosedField({
  kind, name, context, value, defaultValue, onChange, onLoaded, required, disabled, readOnly, className, id,
}: ConstrainedFieldProps) {
  const [internal, setInternal] = useState(value ?? defaultValue ?? '');
  const current = value ?? internal;
  const { rows } = useConstrained(kind, '', context, 200, !disabled && !readOnly);
  const loaded = useRef(onLoaded);
  loaded.current = onLoaded;
  useEffect(() => { loaded.current?.(rows); }, [rows]);
  const known = rows.some((row) => row.code === current);

  return (
    <select
      id={id}
      name={name}
      required={required}
      disabled={disabled || readOnly}
      className={className ?? 'input w-full'}
      value={current}
      onChange={(event) => {
        setInternal(event.target.value);
        onChange?.(event.target.value);
      }}
    >
      <option value="">{t('constrained.choose')}</option>
      {current && !known && <option value={current}>{current}</option>}
      {rows.map((row) => (
        <option key={row.code} value={row.code}>{row.label ? `${row.code} · ${row.label}` : row.code}</option>
      ))}
    </select>
  );
}

function SuggestField({
  kind, name, context, value, defaultValue, onChange, required, disabled, readOnly, className, placeholder, maxLength, id, uppercase,
}: ConstrainedFieldProps) {
  const generatedId = useId();
  const fieldId = id ?? generatedId;
  const listId = `${fieldId}-matches`;
  const [internal, setInternal] = useState(value ?? defaultValue ?? '');
  const current = value ?? internal;
  const [open, setOpen] = useState(false);
  const [modal, setModal] = useState(false);
  const [modalQuery, setModalQuery] = useState('');
  const box = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const [place, setPlace] = useState<{ top: number; left: number; width: number } | null>(null);
  const typed = current.trim();
  const { rows, pending } = useConstrained(kind, typed, context, 5, open && typed !== '' && !disabled);
  const modalSearch = useConstrained(kind, modalQuery, context, 50, modal);

  useEffect(() => {
    function close(event: MouseEvent) {
      if (!box.current?.contains(event.target as Node)) setOpen(false);
    }
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, []);

  function placeList() {
    const rect = input.current?.getBoundingClientRect();
    if (!rect) return;
    setPlace({ top: rect.bottom + 4, left: rect.left, width: Math.max(rect.width, 280) });
  }

  function commit(next: string) {
    const code = uppercase ? next.toUpperCase() : next;
    setInternal(code);
    onChange?.(code);
  }

  function choose(code: string) {
    commit(code);
    setOpen(false);
    setModal(false);
  }

  return (
    <div ref={box} className="relative min-w-0">
      <div className="flex gap-1">
        <input
          ref={input}
          id={fieldId}
          name={name}
          required={required}
          disabled={disabled}
          readOnly={readOnly}
          maxLength={maxLength}
          autoComplete="off"
          placeholder={placeholder}
          className={className ?? 'input w-full'}
          value={current}
          role="combobox"
          aria-expanded={open && rows.length > 0}
          aria-controls={listId}
          aria-autocomplete="list"
          onChange={(event) => {
            commit(event.target.value);
            setOpen(true);
            placeList();
          }}
          onFocus={() => { if (typed) { setOpen(true); placeList(); } }}
        />
        <button
          type="button"
          className="inline-flex min-h-11 min-w-11 shrink-0 items-center justify-center border border-line bg-sunken text-accent hover:bg-white disabled:opacity-50 sm:min-h-9 sm:min-w-9"
          aria-label={t('constrained.search')}
          title={t('constrained.search')}
          disabled={disabled || readOnly}
          onClick={() => {
            setModalQuery(typed);
            setModal(true);
            setOpen(false);
          }}
        >
          <SearchIcon />
        </button>
      </div>
      {open && typed !== '' && place && (
        <ul
          id={listId}
          role="listbox"
          className="fixed z-40 max-h-60 overflow-y-auto border border-line bg-white shadow-card"
          style={{ top: place.top, left: place.left, width: place.width }}
        >
          {rows.length === 0 && (
            <li className="px-3 py-2 text-sm text-ink-soft">{pending ? t('constrained.searching') : t('constrained.none')}</li>
          )}
          {rows.map((row) => (
            <li key={row.code} role="option">
              <button type="button" className="flex w-full gap-2 px-3 py-2 text-left text-sm hover:bg-sunken" onMouseDown={(event) => event.preventDefault()} onClick={() => choose(row.code)}>
                <span className="code shrink-0 font-semibold">{row.code}</span>
                <span className="min-w-0 flex-1 truncate text-ink-soft">{row.label}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
      {modal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-3 sm:p-6" onClick={() => setModal(false)}>
          <section
            role="dialog"
            aria-modal="true"
            aria-label={t('constrained.search')}
            className="flex max-h-[92vh] w-full max-w-2xl flex-col overflow-hidden border border-[#8faabd] bg-white shadow-xl"
            onClick={(event) => event.stopPropagation()}
            onKeyDown={(event) => { if (event.key === 'Escape') setModal(false); }}
          >
            <header className="flex items-center gap-3 border-b border-[#9eb6c8] bg-[#c9dce9] px-4 py-3 text-[#28445b]">
              <h2 className="min-w-0 flex-1 font-semibold">{t('constrained.search')}</h2>
              <button type="button" className="inline-flex h-11 w-11 items-center justify-center border border-[#8faabd] bg-white text-lg hover:bg-[#eef3f7] sm:h-9 sm:w-9" aria-label={t('common.close')} onClick={() => setModal(false)}>×</button>
            </header>
            <div className="border-b border-[#d6dce1] bg-[#eef3f7] p-3">
              <input
                type="search"
                autoFocus
                className="field-input min-h-11 w-full sm:min-h-9"
                value={modalQuery}
                placeholder={t('constrained.searchHint')}
                onChange={(event) => setModalQuery(uppercase ? event.target.value.toUpperCase() : event.target.value)}
              />
            </div>
            {modalQuery.trim() === '' ? (
              <p className="p-5 text-sm text-ink-soft">{t('constrained.typeToSearch')}</p>
            ) : modalSearch.rows.length === 0 ? (
              <p role="status" className="p-5 text-center text-sm text-ink-soft">{modalSearch.pending ? t('constrained.searching') : t('constrained.none')}</p>
            ) : (
              <ul className="min-h-0 flex-1 divide-y divide-[#d6dce1] overflow-y-auto">
                {modalSearch.rows.map((row) => (
                  <li key={`${row.code}-${row.meta ?? ''}`}>
                    <button type="button" className="flex min-h-12 w-full items-center gap-3 px-4 py-2 text-left hover:bg-[#f4f8fa]" onClick={() => choose(row.code)}>
                      <span className="code w-28 shrink-0 font-semibold">{row.code}</span>
                      <span className="min-w-0 flex-1 text-sm">{row.label}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>
      )}
    </div>
  );
}
