'use client';

/**
 * The printable region of an output document (MAIL-03 §7.2, §8).
 *
 * `DocumentLetterhead` and `DocumentFooter` are the same markup the print stylesheet targets, so the
 * on-screen preview is also what the browser prints. Nothing here imports the PDF library: that is a
 * server-side module, and a client import would bundle it into the browser.
 */
import { useState, useTransition } from 'react';

import type { LetterheadView } from '@/modules/output/document-layout';

export interface PdfDownloadState {
  ok: boolean;
  message?: string;
  remedy?: string;
  fileName?: string;
  base64?: string;
  warning?: string | null;
}

export function DocumentLetterhead({ layout, title }: { layout: LetterheadView | null | undefined; title: string }) {
  if (!layout) return null;
  return (
    <header data-letterhead className="flex flex-wrap items-start justify-between gap-3 border-b border-line pb-3">
      <div className="flex items-start gap-3">
        {layout.logoDataUri ? (
          // A data: URI from the tenant's own upload; there is nothing for next/image to optimise.
          // eslint-disable-next-line @next/next/no-img-element
          <img src={layout.logoDataUri} alt="" className="h-10 w-auto max-w-40 object-contain" />
        ) : null}
        <div>
          <p className="text-sm font-semibold">{layout.name}</p>
          {layout.addressLines.map((line, index) => (
            <p key={index} className="text-xs text-ink-soft">{line}</p>
          ))}
          {layout.taxRegistrationNumber ? (
            <p className="text-xs text-ink-soft">Tax registration: {layout.taxRegistrationNumber}</p>
          ) : null}
        </div>
      </div>
      <p className="text-sm">{layout.headerText || title}</p>
    </header>
  );
}

export function DocumentFooter({ layout }: { layout: LetterheadView | null | undefined }) {
  if (!layout || (layout.footerLines.length === 0 && !layout.showPageNumbers)) return null;
  return (
    <footer data-letterfoot className="mt-3 border-t border-line pt-2 text-center text-2xs text-ink-soft">
      {layout.footerLines.map((line, index) => (
        <p key={index}>{line}</p>
      ))}
    </footer>
  );
}

/**
 * Print the document: the class is added around `window.print()` and always removed again — on
 * `afterprint`, and in a timer for browsers that never fire it — because a stuck class hides the
 * whole screen.
 */
export function PrintButton() {
  return (
    <button
      type="button"
      data-print-hide
      className="btn btn-default min-h-9"
      onClick={(event) => {
        const root = event.currentTarget.closest('[data-print-root]');
        const body = document.body;
        let done = false;
        const cleanup = () => {
          if (done) return;
          done = true;
          body.classList.remove('printing');
          root?.removeAttribute('data-print-active');
          window.removeEventListener('afterprint', cleanup);
        };
        root?.setAttribute('data-print-active', '');
        body.classList.add('printing');
        window.addEventListener('afterprint', cleanup);
        try {
          window.print();
        } finally {
          // print() blocks in most browsers; where it returns early the timer still lets go.
          window.setTimeout(cleanup, 3000);
        }
      }}
    >
      Print
    </button>
  );
}

/** Says, near the button, what a browser print cannot do. */
export function PrintNote() {
  return (
    <p data-print-hide className="text-xs text-ink-faint">
      A browser print puts the letterhead on the first sheet only; the PDF is the authoritative multi-page
      output. A reprint uses today&apos;s letterhead on that day&apos;s text; what was originally sent is in the mail
      queue.
    </p>
  );
}

function download(fileName: string, base64: string) {
  const bytes = Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
  const url = URL.createObjectURL(new Blob([bytes], { type: 'application/pdf' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/** Download PDF: calls the server action with the message key and saves the bytes it returns. */
export function DownloadPdfButton({ action, fields, disabled }: {
  action: (form: FormData) => Promise<PdfDownloadState>;
  fields: Record<string, string | number>;
  disabled?: boolean;
}) {
  const [state, setState] = useState<PdfDownloadState | null>(null);
  const [pending, start] = useTransition();
  return (
    <span data-print-hide className="inline-flex flex-col gap-1">
      <button
        type="button"
        className="btn btn-default min-h-9"
        disabled={disabled || pending}
        onClick={() => start(async () => {
          const form = new FormData();
          for (const [name, value] of Object.entries(fields)) form.set(name, String(value));
          const result = await action(form);
          setState(result);
          if (result.ok && result.base64 && result.fileName) download(result.fileName, result.base64);
        })}
      >
        {pending ? 'Building PDF…' : 'Download PDF'}
      </button>
      {state && !state.ok ? (
        <span role="alert" className="text-xs text-signal-error">{state.message}{state.remedy ? ` ${state.remedy}` : ''}</span>
      ) : null}
      {state?.ok && state.warning ? (
        <span role="status" data-pdf-warning className="text-xs text-signal-warn">{state.warning}</span>
      ) : null}
    </span>
  );
}
