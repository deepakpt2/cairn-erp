'use client';

import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { ChevronDown, LogOut, User } from 'lucide-react';

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
  accountLabel: string;
  accountHref: string;
};

export function SessionMenu({
  fullName,
  username,
  signOutLabel,
  signOutAction,
  accountLabel,
  accountHref,
}: SessionMenuProps) {
  const shown = fullName ? `${fullName} (${username})` : username;

  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <button
          type="button"
          className="inline-flex max-w-[16rem] items-center gap-1 rounded-sm px-1 text-2xs text-ink hover:text-accent max-md:min-h-11"
        >
          <User aria-hidden size={14} className="text-ink-faint" />
          <span className="truncate">{shown}</span>
          <ChevronDown aria-hidden size={12} className="text-ink-faint" />
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          align="end"
          sideOffset={4}
          className="z-50 min-w-[10rem] rounded border border-line bg-surface py-1 text-sm shadow-sm"
        >
          {/* A plain link: the one screen a forced user is sent to must not need a script. */}
          <DropdownMenu.Item asChild>
            <a
              href={accountHref}
              className="flex items-center gap-2 px-3 py-1.5 text-ink-soft outline-none data-[highlighted]:bg-sunken data-[highlighted]:text-accent max-md:min-h-11"
            >
              <User aria-hidden size={14} />
              {accountLabel}
            </a>
          </DropdownMenu.Item>
          <form method="post" action={signOutAction}>
            <DropdownMenu.Item asChild>
              <button
                type="submit"
                className="flex w-full items-center gap-2 px-3 py-1.5 text-start text-ink-soft outline-none data-[highlighted]:bg-sunken data-[highlighted]:text-accent max-md:min-h-11"
              >
                <LogOut aria-hidden size={14} />
                {signOutLabel}
              </button>
            </DropdownMenu.Item>
          </form>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}
