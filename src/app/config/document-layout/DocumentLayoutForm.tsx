'use client';

import { useActionState, useState } from 'react';

import type { DocumentLayoutView } from '@/modules/output/document-layout';
import { DocumentFooter, DocumentLetterhead } from '@/ui/output/DocumentPrint';
import {
  removeLogoAction,
  saveDocumentLayoutAction,
  type DocumentLayoutActionState,
} from './actions';

const EMPTY: DocumentLayoutActionState = { ok: false };

const SAMPLE_BODY = [
  'INVOICE 90000123                                              Page 1',
  '==============================================================================',
  'Customer  C-1001  Sample customer',
  '------------------------------------------------------------------------------',
  ' 1  Sample material                             2         25.00        50.00',
  '                                                          Net value      50.00',
  '==============================================================================',
].join('\n');

function Notice({ state }: { state: DocumentLayoutActionState }) {
  if (!state.message) return null;
  return (
    <div className={state.ok ? 'panel panel-success p-3 text-sm' : 'panel panel-danger p-3 text-sm'} role="status">
      <p className="font-medium">{state.message}</p>
      {state.remedy ? <p className="mt-1 text-ink-soft">{state.remedy}</p> : null}
    </div>
  );
}

export function DocumentLayoutForm({ layout }: { layout: DocumentLayoutView }) {
  const [saveState, save, saving] = useActionState(saveDocumentLayoutAction, EMPTY);
  const [removeState, remove, removing] = useActionState(removeLogoAction, EMPTY);
  // The preview follows what is typed, so the owner sees the letterhead without saving anything.
  const [displayName, setDisplayName] = useState(layout.displayName);
  const [address, setAddress] = useState(layout.addressOverride);
  const [headerText, setHeaderText] = useState(layout.headerText);
  const [footerText, setFooterText] = useState(layout.footerText);
  const [pageNumbers, setPageNumbers] = useState(layout.showPageNumbers);

  const preview = {
    name: displayName.trim() || layout.companyName,
    addressLines: address.trim() ? address.split(/\r?\n/).map((line) => line.trim()).filter(Boolean) : [],
    taxRegistrationNumber: null,
    headerText: headerText.trim(),
    footerLines: footerText.split(/\r?\n/).filter((line) => line.trim() !== ''),
    showPageNumbers: pageNumbers,
    logoDataUri: layout.logoDataUri,
  };

  return (
    <>
      <section aria-labelledby="layout-form" className="panel p-4">
        <h2 id="layout-form" className="text-sm font-semibold">{layout.companyCode} · {layout.companyName}</h2>
        <form action={save} className="mt-3 grid gap-3 sm:grid-cols-2">
          <input type="hidden" name="companyCode" value={layout.companyCode} />
          <label className="block">
            <span className="field-label">Display name</span>
            <input
              name="displayName" className="input w-full" maxLength={160} value={displayName}
              onChange={(event) => setDisplayName(event.target.value)} placeholder={layout.companyName}
            />
            <span className="text-xs text-ink-faint">Empty uses the company code&apos;s name.</span>
          </label>
          <label className="block">
            <span className="field-label">Header text</span>
            <input
              name="headerText" className="input w-full" maxLength={200} value={headerText}
              onChange={(event) => setHeaderText(event.target.value)} placeholder="Tax invoice"
            />
            <span className="text-xs text-ink-faint">One line, right-aligned under the letterhead.</span>
          </label>
          <label className="block sm:col-span-2">
            <span className="field-label">Address override</span>
            <textarea
              name="addressOverride" className="input w-full" rows={3} value={address}
              onChange={(event) => setAddress(event.target.value)}
            />
            <span className="text-xs text-ink-faint">Empty uses the company code&apos;s address, city and country.</span>
          </label>
          <label className="block sm:col-span-2">
            <span className="field-label">Footer text</span>
            <textarea
              name="footerText" className="input w-full" rows={4} value={footerText}
              onChange={(event) => setFooterText(event.target.value)}
              placeholder={'Bank: …\nRegistered in …'}
            />
            <span className="text-xs text-ink-faint">Literal text; each line is printed as written. There are no template variables.</span>
          </label>
          <label className="block sm:col-span-2">
            <span className="field-label">Logo</span>
            <input name="logo" type="file" accept="image/png,image/jpeg" className="input w-full" />
            <span className="text-xs text-ink-faint">
              PNG or JPEG, up to 256 KB and 2000 × 2000. Checked by content, not by name. Leave empty to keep the current logo.
            </span>
          </label>
          <label className="flex items-center gap-2 sm:col-span-2">
            <input
              type="checkbox" name="showPageNumbers" value="1" checked={pageNumbers}
              onChange={(event) => setPageNumbers(event.target.checked)}
            />
            <span className="text-sm">Print “Page n of m” in the footer</span>
          </label>
          <div className="sm:col-span-2">
            <button type="submit" className="btn btn-primary min-h-11 sm:min-h-8" disabled={saving}>
              {saving ? 'Saving…' : 'Save layout'}
            </button>
          </div>
        </form>
        <div className="mt-3"><Notice state={saveState} /></div>

        {layout.hasLogo ? (
          <div className="mt-4 flex flex-wrap items-center gap-3 border-t border-line pt-3">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={layout.logoDataUri ?? ''} alt="Current logo" className="h-10 w-auto max-w-40 object-contain" />
            <span className="text-xs text-ink-soft">{layout.logoFileName}</span>
            <form action={remove}>
              <input type="hidden" name="companyCode" value={layout.companyCode} />
              <button type="submit" className="btn btn-default min-h-9" disabled={removing}>Remove logo</button>
            </form>
          </div>
        ) : null}
        <div className="mt-3"><Notice state={removeState} /></div>
      </section>

      <section aria-labelledby="layout-preview" className="panel p-4">
        <h2 id="layout-preview" className="text-sm font-semibold">Preview</h2>
        <p className="mt-1 text-xs text-ink-faint">
          HTML, not a PDF: the same markup the browser prints. The company code&apos;s address and tax number are added
          where the override is empty.
        </p>
        <div data-print-root className="mt-3 border border-line p-3">
          <DocumentLetterhead layout={{ ...preview, addressLines: preview.addressLines.length ? preview.addressLines : ['(the company code’s address)'] }} title="Document" />
          <pre className="mt-3 overflow-x-auto border border-line bg-surface-muted p-3 text-xs leading-5">{SAMPLE_BODY}</pre>
          <DocumentFooter layout={preview} />
        </div>
      </section>
    </>
  );
}
