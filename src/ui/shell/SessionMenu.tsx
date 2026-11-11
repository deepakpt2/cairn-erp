'use client';

import { useEffect, useRef, useState } from 'react';

/**
 * The signed-in user's menu — Phase 7.
 *
 * Sign-out is a plain form post, so it works even if this component never
 * hydrates. Everything the script adds is the opening and closing of the
 * panel: decoration on top of a control that already works without it. A menu
 * you cannot open is an annoyance; a sign-out that depends on JavaScript is a
 * way to be locked into a session you want to end.
 *
 * Labels arrive as props rather than through `t()` because the catalogue is
 * the whole application's text. Importing it here would ship every string in
 * the product to the browser to render two words.
 *
 * Positioning uses logical utilities (`end-0`, `ms-auto`), not `right`/`left`,
 * so the menu opens toward the trailing edge in Arabic as well as English
 * without a second branch (R-19, §19.4).
 */

export type SessionMenuProps = {
  fullName: string;
  username: string;
  signOutLabel: string;
  signOutAction: string;
};

export function SessionMenu({
  fullName,
  username,
  signOutLabel,
  signOutAction,
}: SessionMenuProps) {
  const [open, setOpen] = useState(false);
  const container = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!container.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  const shown = fullName ? `${fullName} (${username})` : username;

  return (
    <div className="relative" ref={container}>
      <button
        type="button"
        onClick={() => setOpen((was) => !was)}
        aria-haspopup="menu"
        aria-expanded={open}
        className="inline-flex max-w-[16rem] items-center gap-1 truncate text-2xs text-ink hover:text-accent"
      >
        <span className="truncate">{shown}</span>
        <span aria-hidden className="text-ink-faint">
          {open ? '▴' : '▾'}
        </span>
      </button>

      {open ? (
        <div
          role="menu"
          className="absolute end-0 top-full z-40 mt-1 min-w-[9rem] border border-line bg-surface py-1 text-2xs shadow-sm"
        >
          <form method="post" action={signOutAction}>
            <button
              type="submit"
              role="menuitem"
              className="block w-full px-3 py-1 text-start text-ink-soft hover:bg-sunken hover:text-accent"
            >
              {signOutLabel}
            </button>
          </form>
        </div>
      ) : null}
    </div>
  );
}
