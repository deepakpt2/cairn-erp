'use client';

import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import { suggestRegistryTerms } from '@/app/registry/actions';
import type { RegistrySuggestion } from '@/platform/registry/suggest';
import { t } from '@/platform/i18n';

/**
 * The registry search box. The form submits without JavaScript. The list is
 * only an extra: as you type, the same ranking the results page uses.
 */
export function RegistrySearch({ initialQuery }: { initialQuery: string }) {
  const listId = useId();
  const [query, setQuery] = useState(initialQuery);
  const [items, setItems] = useState<RegistrySuggestion[]>([]);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const request = useRef(0);
  const touched = useRef(false);

  useEffect(() => {
    if (!touched.current) return;
    const trimmed = query.trim();
    if (trimmed.length < 2) {
      request.current += 1;
      setItems([]);
      setOpen(false);
      setActive(-1);
      return;
    }
    const id = ++request.current;
    const timer = window.setTimeout(() => {
      suggestRegistryTerms(trimmed)
        .then((next) => {
          if (id !== request.current) return;
          setItems(next);
          setOpen(next.length > 0);
          setActive(-1);
        })
        .catch(() => {
          if (id !== request.current) return;
          setItems([]);
          setOpen(false);
        });
    }, 150);
    return () => window.clearTimeout(timer);
  }, [query]);

  function destination(item: RegistrySuggestion): string {
    if (item.routePath) return item.routePath;
    const term = item.ourCode ?? item.ourTable ?? item.title;
    return `?q=${encodeURIComponent(term)}`;
  }

  function onKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === 'Escape') {
      setOpen(false);
      setActive(-1);
      return;
    }
    if (!open || items.length === 0) return;
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setActive((current) => Math.min(current + 1, items.length - 1));
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      setActive((current) => Math.max(current - 1, -1));
    } else if (event.key === 'Enter' && active >= 0) {
      event.preventDefault();
      window.location.assign(destination(items[active]));
    }
  }

  function reason(item: RegistrySuggestion): string {
    const kind = t(item.kind === 'NEAREST' ? 'registry.suggest.nearest' : 'registry.suggest.matched');
    const field = t(item.field === 'ALIAS' ? 'registry.aliases' : `registry.suggest.field.${item.field}`);
    const alias = item.field === 'ALIAS' ? ` ${item.matchedText}` : '';
    return `${kind} · ${field}${alias}`;
  }

  return (
    <form method="get" role="search" className="mb-4">
      <div className="flex gap-2">
        <div className="relative min-w-0 flex-1">
          <label htmlFor="registry-q" className="sr-only">
            {t('registry.search')}
          </label>
          <input
            id="registry-q"
            name="q"
            type="text"
            defaultValue={initialQuery}
            placeholder={t('registry.searchPlaceholder')}
            className="field-input w-full"
            autoFocus
            autoComplete="off"
            spellCheck={false}
            role="combobox"
            aria-autocomplete="list"
            aria-expanded={open}
            aria-controls={listId}
            aria-activedescendant={active >= 0 ? `${listId}-${active}` : undefined}
            onChange={(event) => {
              touched.current = true;
              setQuery(event.target.value);
            }}
            onKeyDown={onKeyDown}
            onBlur={(event) => {
              const next = event.relatedTarget;
              if (next instanceof Node && event.currentTarget.parentElement?.contains(next)) return;
              window.setTimeout(() => setOpen(false), 200);
            }}
          />
          {open && items.length > 0 && (
            <ul
              id={listId}
              role="listbox"
              aria-label={t('registry.suggest.list')}
              className="absolute inset-x-0 top-full z-30 mt-1 max-h-80 overflow-auto border border-line-strong bg-surface"
            >
              {items.map((item, index) => (
                <li key={item.id} id={`${listId}-${index}`} role="option" aria-selected={index === active}>
                  <a
                    href={destination(item)}
                    className={`block px-2 py-1.5 ${index === active ? 'bg-accent-soft' : 'hover:bg-accent-soft/40'}`}
                    onMouseEnter={() => setActive(index)}
                  >
                    <div className="flex items-baseline justify-between gap-3">
                      <span className="code text-sm font-semibold">{item.ourCode ?? item.ourTable}</span>
                      <span className="shrink-0 text-2xs uppercase tracking-wide text-ink-faint">{reason(item)}</span>
                    </div>
                    <div className="text-sm text-ink">{item.title}</div>
                  </a>
                </li>
              ))}
            </ul>
          )}
        </div>
        <button type="submit" className="btn btn-primary">
          {t('registry.search')}
        </button>
      </div>
      <p className="field-hint">{t('registry.suggest.hint')}</p>
    </form>
  );
}
