'use client';

import * as RadixDialog from '@radix-ui/react-dialog';
import { X } from 'lucide-react';
import type { ReactNode } from 'react';

type DialogProps = {
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  trigger?: ReactNode;
  title: string;
  description?: string;
  children: ReactNode;
  footer?: ReactNode;
};

/** Modal dialog: focus-trapped, Esc closes, full-width sheet on phones. */
export function Dialog({ open, onOpenChange, trigger, title, description, children, footer }: DialogProps) {
  return (
    <RadixDialog.Root open={open} onOpenChange={onOpenChange}>
      {trigger && <RadixDialog.Trigger asChild>{trigger}</RadixDialog.Trigger>}
      <RadixDialog.Portal>
        <RadixDialog.Overlay className="fixed inset-0 z-50 bg-black/40" />
        <RadixDialog.Content className="panel fixed z-50 flex max-h-[90vh] w-full flex-col bg-surface max-md:inset-x-0 max-md:bottom-0 md:left-1/2 md:top-1/2 md:max-w-lg md:-translate-x-1/2 md:-translate-y-1/2">
          <div className="flex items-start justify-between gap-3 border-b border-line p-3">
            <div>
              <RadixDialog.Title className="text-base font-semibold">{title}</RadixDialog.Title>
              {description && (
                <RadixDialog.Description className="mt-0.5 text-sm text-ink-soft">{description}</RadixDialog.Description>
              )}
            </div>
            <RadixDialog.Close className="btn btn-default px-2 max-md:min-h-11 max-md:min-w-11" aria-label="Close">
              <X size={16} aria-hidden />
            </RadixDialog.Close>
          </div>
          <div className="overflow-y-auto p-3">{children}</div>
          {footer && <div className="flex flex-wrap justify-end gap-2 border-t border-line p-3">{footer}</div>}
        </RadixDialog.Content>
      </RadixDialog.Portal>
    </RadixDialog.Root>
  );
}
