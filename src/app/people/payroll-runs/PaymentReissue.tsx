'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { PreviewGeneration, SubmissionKey, acceptsPreview, previewSignature, readUnresolved, rememberUnresolved, clearUnresolved } from './reissue-request-lifecycle';

import type { ReissuePreview, ReissueView } from '@/modules/people/payroll-payment-reissue';

const REISSUE_ENDPOINT = '/people/payroll-runs/payment-file/reissue';

const OUTCOMES = [
  { value: 'NOT_UPLOADED', label: 'Not uploaded' },
  { value: 'BANK_REJECTED', label: 'Bank rejected' },
  { value: 'CANCELLED_BEFORE_EXECUTION', label: 'Cancelled before execution' },
  { value: 'RETURNED', label: 'Confirmed returned' },
] as const;

interface Attestation {
  outcome: string;
  reason: string;
  verificationDate: string;
  evidenceReference: string;
  confirmedNoSubmission: boolean;
}

const blankAttestation = (): Attestation => ({ outcome: '', reason: '', verificationDate: '', evidenceReference: '', confirmedNoSubmission: false });

/**
 * The controlled reissue panel: choose all or selected employees, record an attested original outcome for each,
 * request a DRAFT (separate approver releases it), then download. All bank data is masked; all actions are
 * authorized and audited server-side.
 */
export function PaymentReissuePanel({
  preparationId,
  reissues,
  sourceEmployees,
  canRequest,
  canApprove,
  canDownload,
  canHistorical,
  currentUsername,
  defaultDate,
}: {
  preparationId: string;
  reissues: ReissueView[];
  /** The employees in the source file, so a SELECTED request can name them. */
  sourceEmployees: Array<{ personnelNumber: string; beneficiaryName: string }>;
  canRequest: boolean;
  canApprove: boolean;
  canDownload: boolean;
  canHistorical: boolean;
  currentUsername: string;
  defaultDate: string;
}) {
  const router = useRouter();
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [selection, setSelection] = useState<'ALL' | 'SELECTED'>('ALL');
  const [selected, setSelected] = useState<string[]>([]);
  const [date, setDate] = useState(defaultDate);
  const [reason, setReason] = useState('');
  const [preview, setPreview] = useState<ReissuePreview | null>(null);
  const [attest, setAttest] = useState<Record<string, Attestation>>({});
  const [pending, setPending] = useState(false);
  const [reviewId, setReviewId] = useState<string | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  // A MUTABLE generation (a ref, not state): each preview request gets a NEW increasing token, so among
  // overlapping requests the newest response wins. Any input change calls invalidate().
  const previewGen = useRef(new PreviewGeneration());
  // One retained key per logical submission, retained even across edits while its outcome is unknown.
  const submission = useRef<SubmissionKey | null>(null);
  if (!submission.current) submission.current = new SubmissionKey(() => crypto.randomUUID());
  // The signature the currently displayed preview answered; submission requires it to still equal the inputs.
  const previewSig = useRef<string | null>(null);
  // The previewed normalized employee set, so a SELECTED submit sends exactly what was previewed.
  const previewEmployees = useRef<string[]>([]);
  // Current inputs in a ref, so an in-flight closure reads the LATEST values (not the render's captured ones).
  const inputsRef = useRef({ source: preparationId, selection, selected, date });
  inputsRef.current = { source: preparationId, selection, selected, date };
  const [unresolved, setUnresolved] = useState<{ key: string } | null>(null);

  // Invalidate any in-flight preview when the SOURCE changes via props, and restore that source's unresolved
  // submission (same key AND exact payload), so a reload retry is truthfully the same logical request. The record
  // is per-source and per-tab, so switching sources or another tab cannot overwrite it.
  useEffect(() => {
    previewGen.current.invalidate();
    setPreview(null);
    previewSig.current = null;
    previewEmployees.current = [];
    // A new source gets its own key; a prior source's untracked state stays in this tab's recovery map.
    submission.current = new SubmissionKey(() => crypto.randomUUID());
    const recovered = readUnresolved(preparationId);
    if (recovered) {
      submission.current.seed(recovered);
      setUnresolved({ key: recovered.key });
    } else {
      setUnresolved(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [preparationId]);

  const post = async (fields: Record<string, string>) => {
    setPending(true);
    try {
      const form = new FormData();
      for (const [k, v] of Object.entries(fields)) form.set(k, v);
      const response = await fetch(REISSUE_ENDPOINT, { method: 'POST', body: form });
      const text = await response.text();
      if (!response.ok) { setMessage({ ok: false, text }); return null; }
      return JSON.parse(text);
    } catch {
      setMessage({ ok: false, text: 'The preview could not be loaded. No replacement request was sent.' });
      return null;
    } finally {
      setPending(false);
    }
  };

  const signature = () => previewSignature(inputsRef.current);
  /**
   * A mutating POST. Only a 4xx with an application refusal is treated as a DEFINITE pre-commit refusal; a
   * transport error, an unreadable body, a 5xx (a proxy can return it AFTER the app committed) or 408 is an
   * UNKNOWN outcome. An unknown outcome never claims "nothing was saved" and keeps the retained key so a retry
   * replays the same logical request.
   */
  const submit = async (fields: Record<string, string>): Promise<{ ok: boolean; unknown?: boolean; data?: unknown }> => {
    setPending(true);
    try {
      const form = new FormData();
      for (const [k, v] of Object.entries(fields)) form.set(k, v);
      const response = await fetch(REISSUE_ENDPOINT, { method: 'POST', body: form });
      const text = await response.text();
      if (!response.ok) {
        if (response.status >= 500 || response.status === 408) return { ok: false, unknown: true };
        setMessage({ ok: false, text });
        return { ok: false };
      }
      try {
        return { ok: true, data: JSON.parse(text) };
      } catch {
        // The server answered 2xx but the body is unreadable/truncated: the change may have committed.
        return { ok: false, unknown: true };
      }
    } catch {
      return { ok: false, unknown: true };
    } finally {
      setPending(false);
    }
  };

  const runPreview = async () => {
    const inputs = inputsRef.current;
    const token = previewGen.current.issue();
    const sentSig = previewSignature(inputs);
    const data = await post({
      action: 'preview', sourcePreparationId: inputs.source, selection: inputs.selection,
      personnelNumbers: inputs.selection === 'SELECTED' ? inputs.selected.join(',') : '', intendedPaymentDate: inputs.date,
    });
    // Accept only the NEWEST response for the CURRENT inputs; a later request always wins, identical inputs or not.
    if (!acceptsPreview(token, previewGen.current, sentSig, signature())) return;
    if (data) {
      previewGen.current.accept(token);
      const typed = data as ReissuePreview;
      previewSig.current = typed.inputSignature ?? sentSig;
      previewEmployees.current = typed.employees.map((e) => e.personnelNumber);
      setPreview(typed);
      // Functional update: keep anything already entered for these employees (a re-preview must not wipe typed
      // attestations by reading a stale closure), and add a blank row for anyone new.
      setAttest((prev) => {
        const map: Record<string, Attestation> = {};
        for (const e of typed.employees) map[e.personnelNumber] = prev[e.personnelNumber] ?? blankAttestation();
        return map;
      });
      setMessage(null);
    }
  };

  const submitRequest = async () => {
    if (!preview) return;
    // Submit only the EXACT previewed inputs: source, mode, date and the previewed employee set. The preview's
    // own signature (computed by the service on the same normalized inputs) must still equal the current inputs.
    // In ALL mode the employee set is server-derived, so the client-side selected array is irrelevant.
    if (previewSig.current === null || previewSig.current !== signature()) {
      setMessage({ ok: false, text: 'The selection or date changed since this preview. Review the current preview again before creating the draft.' });
      setPreview(null); previewSig.current = null; previewEmployees.current = [];
      return;
    }
    // Never silently drop an ineligible employee: refuse the whole request if the preview contains one.
    const ineligible = preview.employees.filter((e) => !e.eligible);
    if (ineligible.length > 0) {
      setMessage({ ok: false, text: `Refusing the whole request: ${ineligible.map((e) => `${e.personnelNumber} (${e.blocker})`).join('; ')}. Resolve these first; no partial draft is created.` });
      return;
    }
    const previewPns = previewEmployees.current;
    // Attestations cover exactly the previewed employees; refuse locally if any is incomplete (server re-checks).
    const incomplete = previewPns.filter((pn) => {
      const a = attest[pn];
      return !a || !a.outcome || !a.reason.trim() || !a.verificationDate || !(a.evidenceReference ?? '').trim()
        || (a.outcome === 'NOT_UPLOADED' && !a.confirmedNoSubmission);
    });
    if (incomplete.length > 0) {
      setMessage({ ok: false, text: `Record the full attested outcome (outcome, reason, verification date, evidence${incomplete.length ? ', and no-submission confirmation where needed' : ''}) for: ${incomplete.join(', ')}.` });
      return;
    }
    const attestations = previewPns.map((pn) => ({ personnelNumber: pn, ...attest[pn] }));
    const fields: Record<string, string> = {
      action: 'request', sourcePreparationId: preview.sourcePreparationId, selection: preview.selection,
      personnelNumbers: preview.selection === 'SELECTED' ? previewPns.join(',') : '',
      intendedPaymentDate: preview.intendedPaymentDate, reason, attestations: JSON.stringify(attestations),
    };
    const payload = JSON.stringify(fields);
    let key: string;
    try {
      key = submission.current!.keyFor(payload, fields);
    } catch {
      setMessage({ ok: false, text: 'An earlier replacement request has an unknown outcome. Reload to check the file history, or explicitly discard that attempt, before submitting a different one.' });
      return;
    }
    const result = await submit({ ...fields, requestKey: key });
    if (result.ok) {
      submission.current!.resolve();
      clearUnresolved(preparationId);
      setUnresolved(null);
      setMessage({ ok: true, text: 'Replacement draft created. A different authorized approver must release it.' });
      setPreview(null); previewSig.current = null; previewEmployees.current = []; setReason(''); router.refresh();
      return;
    }
    if (result.unknown) {
      // Ambiguous: the server may have committed. Retain the key + payload; warn; offer a same-key retry.
      submission.current!.markUnresolved();
      rememberUnresolved(preparationId, key, fields);
      setUnresolved({ key });
    }
  };

  const abandonUnresolved = () => {
    submission.current!.abandon();
    clearUnresolved(preparationId);
    setUnresolved(null);
    setMessage({ ok: false, text: 'The earlier request was marked as abandoned locally. If it did create a draft, cancel it from the history above so it cannot be approved.' });
  };

  /**
   * Ask the server, under the same request-key lock, whether this key created a draft. Only the requester can see
   * it; another user's key answers "not found". A "not found" is NOT proof that a delayed original cannot still
   * commit, so the warning is kept unless a draft is actually found.
   */
  const reconcile = async () => {
    if (!unresolved) return;
    setPending(true);
    try {
      const form = new FormData();
      form.set('action', 'reconcile');
      form.set('sourcePreparationId', preparationId);
      form.set('requestKey', unresolved.key);
      const response = await fetch(REISSUE_ENDPOINT, { method: 'POST', body: form });
      const text = await response.text();
      if (!response.ok) {
        setMessage({ ok: false, text: response.status >= 500 ? 'The outcome check failed (server error). The outcome is still unknown; check again later.' : text });
        return;
      }
      const data = JSON.parse(text) as { found?: boolean; status?: string; reissueReference?: string };
      if (data.found) {
        submission.current!.resolve();
        clearUnresolved(preparationId);
        setUnresolved(null);
        setMessage({ ok: true, text: `The earlier request was confirmed: ${data.reissueReference ?? 'the draft'} is ${String(data.status ?? '').toLowerCase()}. Reload the history to act on it.` });
        router.refresh();
      } else {
        setMessage({ ok: false, text: 'No draft exists for this request key right now. A delayed attempt would still reuse this key, so the outcome remains unresolved: retry the same details (the same key is reused) or discard this attempt after checking the history.' });
      }
    } catch {
      setMessage({ ok: false, text: 'The outcome check could not be completed. The outcome is still unknown; check again before retrying.' });
    } finally {
      setPending(false);
    }
  };

  const decide = async (reissueId: string, action: 'approve' | 'cancel', cancelReason = '', confirmDigest = '') => {
    // Use the unknown-aware path: a lost response after a commit must not claim "nothing was saved".
    const result = await submit({ action, reissueId, reason: cancelReason, confirmDigest, confirmReviewed: action === 'approve' ? 'yes' : '' });
    if (result.ok) {
      setMessage({ ok: true, text: action === 'approve' ? 'Replacement approved.' : 'Draft cancelled.' });
      router.refresh();
    } else if (result.unknown) {
      setMessage({ ok: false, text: 'The outcome is unknown: the connection failed after the request was sent. Reload the file history to confirm whether the replacement was released or cancelled; do not repeat the action blindly.' });
    }
  };

  const updateAttest = (pn: string, patch: Partial<Attestation>) => setAttest((prev) => ({ ...prev, [pn]: { ...(prev[pn] ?? blankAttestation()), ...patch } }));

  return (
    <section className="panel space-y-3 p-4" aria-label="Replacement payment file">
      <h2 className="panel-title">Replacement payment file</h2>
      <p role="note" className="rounded border border-signal-warn/40 bg-signal-warn/10 p-3 text-xs text-ink">
        A replacement is a new generic working file — not a bank format. Review and convert it to your bank’s required
        format before uploading it. The ERP does not send it to the bank; downloading is not sending and is not proof of
        payment. Uploading it again can pay employees twice — control every copy.
      </p>

      {reissues.length > 0 && (
        <div className="overflow-x-auto">
          <table className="grid-table">
            <thead><tr><th>Version</th><th>Reference</th><th>Selection</th><th>Employees</th><th>Total</th><th>Date</th><th>Status</th><th>Requested / approved</th><th>Action</th></tr></thead>
            <tbody>
              {reissues.map((r) => (
                <tr key={r.reissueId}>
                  <td className="code">v{r.version}</td>
                  <td className="code text-xs">{r.reissueReference}</td>
                  <td className="text-xs">{r.selection === 'ALL' ? 'All employees' : `${r.employeeCount} selected`}</td>
                  <td>{r.employeeCount}</td>
                  <td className="code">{r.totalAmount} {r.currency}</td>
                  <td className="text-xs">{r.intendedPaymentDate}</td>
                  <td className="text-xs">{r.status.toLowerCase()}</td>
                  <td className="text-xs">{r.requestedBy}{r.approvedBy ? ` / ${r.approvedBy}` : ''}</td>
                  <td className="space-x-2">
                    {r.status === 'APPROVED' && canDownload && r.downloadable && (
                      <a className="btn btn-default min-h-9" href={`${REISSUE_ENDPOINT}?reissue=${encodeURIComponent(r.reissueId)}`}>Download</a>
                    )}
                    {r.status === 'APPROVED' && r.superseded && (
                      <span className="chip chip-warn" title="A later approved replacement supersedes at least one employee in this file">superseded — do not upload</span>
                    )}
                    {r.status === 'APPROVED' && r.superseded && canHistorical && (
                      <a className="btn btn-default min-h-9" href={`${REISSUE_ENDPOINT}?historical=1&reissue=${encodeURIComponent(r.reissueId)}`}>Historical evidence</a>
                    )}
                    {r.status === 'DRAFT' && canApprove && r.requestedBy.toLowerCase() !== currentUsername.toLowerCase() && (
                      <button type="button" className="btn btn-default min-h-9" disabled={pending} onClick={() => { setReviewId(reviewId === r.reissueId ? null : r.reissueId); setConfirmed(false); }}>{reviewId === r.reissueId ? 'Hide review' : 'Review'}</button>
                    )}
                    {r.status === 'DRAFT' && (canRequest || canApprove) && (
                      <button type="button" className="btn btn-default min-h-9" disabled={pending} onClick={() => decide(r.reissueId, 'cancel', 'Cancelled before approval')}>Cancel</button>
                    )}
                    {reviewId === r.reissueId && (
                      <div className="mt-3 space-y-2 rounded border border-line p-3 text-xs" aria-label="Approver review">
                        <p className="font-semibold">Review this frozen replacement before approval</p>
                        <p>Intended payment date <span className="code">{r.intendedPaymentDate}</span> · {r.employeeCount} employee{r.employeeCount === 1 ? '' : 's'} · total <span className="code">{r.totalAmount} {r.currency}</span> · source {r.sourcePreparationId.slice(0, 8)} · requested by {r.requestedBy} · reason: {r.reason}</p>
                        <div className="overflow-x-auto">
                          <table className="grid-table">
                            <thead><tr><th>Employee</th><th>Frozen beneficiary</th><th>Amount</th><th>Bank (masked)</th><th>Predecessor</th><th>Attested original outcome</th><th>Verified</th><th>Evidence</th></tr></thead>
                            <tbody>
                              {r.lines.map((l) => (
                                <tr key={l.lineNo}>
                                  <td className="code">{l.personnelNumber}</td>
                                  <td className="text-xs">{l.beneficiaryName}</td>
                                  <td className="code">{l.amount} {l.currency}</td>
                                  <td className="text-xs">{l.bankName}<div className="code">{l.maskedAccount}</div></td>
                                  <td className="code text-xs">{l.predecessorKind} {l.predecessorId.slice(0, 8)}</td>
                                  <td className="text-xs">{l.attestationOutcome.toLowerCase().replaceAll('_', ' ')}<div className="text-ink-soft">{l.attestationReason}</div></td>
                                  <td className="text-xs">{l.verificationDate}</td>
                                  <td className="text-xs">{l.evidenceReference}</td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                        <label className="flex items-start gap-2">
                          <input type="checkbox" className="mt-1" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} />
                          <span>I have reviewed the frozen employees, amounts, masked bank details, intended date and each attested outcome above, and I approve this snapshot.</span>
                        </label>
                        <button type="button" className="btn btn-primary min-h-9" disabled={pending || !confirmed} onClick={() => decide(r.reissueId, 'approve', '', r.snapshotDigest)}>Approve snapshot</button>
                      </div>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {unresolved && (
        <div role="alert" className="rounded border border-signal-warn/50 bg-signal-warn/10 p-3 text-xs">
          <p>A previous replacement request has an <strong>unknown outcome</strong>. It may have created a draft. If you retry <em>exactly</em> the same details, the same request key is reused and no second draft is created; a different request is blocked until this is resolved.</p>
          <p className="mt-1">Request key <span className="code">{unresolved.key.slice(0, 8)}…</span>. Check the file history above, or ask the server to confirm this key.</p>
          <div className="mt-2 flex flex-wrap gap-2">
            <button type="button" className="btn btn-default min-h-9" disabled={pending} onClick={reconcile}>Check this request key</button>
            <button type="button" className="btn btn-default min-h-9" disabled={pending} onClick={abandonUnresolved}>Discard this unknown attempt</button>
          </div>
        </div>
      )}

      {canRequest && (
        <div className="space-y-3 border-t border-line pt-3">
          <h3 className="text-sm font-semibold">Request a replacement</h3>
          <div className="grid gap-3 sm:grid-cols-3">
            <label>
              <span className="field-label">Which employees</span>
              <select className="field-input w-full" value={selection} onChange={(e) => { setSelection(e.target.value as 'ALL' | 'SELECTED'); setPreview(null); previewGen.current.invalidate(); previewSig.current = null; previewEmployees.current = []; }}>
                <option value="ALL">All employees of the file</option>
                <option value="SELECTED">Only selected employees</option>
              </select>
            </label>
            <label>
              <span className="field-label">Intended payment date</span>
              <input type="date" className="field-input w-full" value={date} onChange={(e) => { setDate(e.target.value); setPreview(null); previewGen.current.invalidate(); previewSig.current = null; previewEmployees.current = []; }} />
            </label>
            <label>
              <span className="field-label">Reason</span>
              <input className="field-input w-full" value={reason} maxLength={200} onChange={(e) => setReason(e.target.value)} placeholder="Why a replacement is needed" />
            </label>
          </div>
          {selection === 'SELECTED' && (
            <div className="space-y-1 rounded border border-line p-3">
              <p className="field-label">Employees to replace ({selected.length} selected)</p>
              {sourceEmployees.length === 0 ? (
                <p className="text-xs text-ink-soft">This file has no employees to select.</p>
              ) : (
                <div className="grid gap-1 sm:grid-cols-2">
                  {sourceEmployees.map((e) => (
                    <label key={e.personnelNumber} className="flex items-center gap-2 text-sm">
                      <input
                        type="checkbox"
                        checked={selected.includes(e.personnelNumber)}
                        onChange={(ev) => {
                          setPreview(null); previewGen.current.invalidate(); previewSig.current = null; previewEmployees.current = [];
                          setSelected((prev) => ev.target.checked ? [...prev, e.personnelNumber] : prev.filter((n) => n !== e.personnelNumber));
                        }}
                      />
                      <span className="code">{e.personnelNumber}</span>
                      <span className="text-xs text-ink-soft">{e.beneficiaryName}</span>
                    </label>
                  ))}
                </div>
              )}
            </div>
          )}
          <button type="button" className="btn btn-default min-h-11 sm:min-h-8" disabled={pending || !date || (selection === 'SELECTED' && selected.length === 0)} onClick={runPreview}>Preview eligible employees</button>

          {preview && (
            <div className="space-y-3">
              <p className="text-sm">
                {preview.employeeCount} employee{preview.employeeCount === 1 ? '' : 's'}, total <span className="code">{preview.totalAmount} {preview.currency}</span>,
                intended {preview.intendedPaymentDate}.
                {preview.ineligible.length > 0 && <span className="text-signal-error"> {preview.ineligible.length} ineligible and NOT included: {preview.ineligible.map((i) => `${i.personnelNumber} (${i.blocker})`).join('; ')}.</span>}
              </p>
              <p className="text-xs text-ink-soft">For each selected employee, record the actual original outcome — your attestation, not a bank-verified status. “Not uploaded” needs an explicit confirmation that no copy was submitted.</p>
              <div className="overflow-x-auto">
                <table className="grid-table">
                  <thead><tr><th>Employee</th><th>Amount</th><th>Bank (masked)</th><th>Outcome</th><th>Reason</th><th>Verified on</th><th>Evidence / reference</th><th>No copy submitted?</th></tr></thead>
                  <tbody>
                    {preview.employees.map((e) => (
                      <tr key={e.personnelNumber} className={e.eligible ? '' : 'opacity-60'}>
                        <td className="code">{e.personnelNumber}{!e.eligible && <div className="text-xs text-signal-error">{e.blocker}</div>}</td>
                        <td className="code">{e.amount}</td>
                        <td className="text-xs">{e.bankName}<div className="code">{e.maskedAccount}</div></td>
                        <td>
                          <select className="field-input" disabled={!e.eligible} value={attest[e.personnelNumber]?.outcome ?? ''} onChange={(ev) => updateAttest(e.personnelNumber, { outcome: ev.target.value })}>
                            <option value="">Choose outcome…</option>
                            {OUTCOMES.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                          </select>
                        </td>
                        <td><input className="field-input" disabled={!e.eligible} value={attest[e.personnelNumber]?.reason ?? ''} onChange={(ev) => updateAttest(e.personnelNumber, { reason: ev.target.value })} /></td>
                        <td><input type="date" className="field-input" disabled={!e.eligible} value={attest[e.personnelNumber]?.verificationDate ?? ''} onChange={(ev) => updateAttest(e.personnelNumber, { verificationDate: ev.target.value })} /></td>
                        <td><input className="field-input" disabled={!e.eligible} value={attest[e.personnelNumber]?.evidenceReference ?? ''} onChange={(ev) => updateAttest(e.personnelNumber, { evidenceReference: ev.target.value })} placeholder="Bank/external reference or explanation" /></td>
                        <td className="text-center">{attest[e.personnelNumber]?.outcome === 'NOT_UPLOADED' ? <input type="checkbox" checked={attest[e.personnelNumber]?.confirmedNoSubmission ?? false} onChange={(ev) => updateAttest(e.personnelNumber, { confirmedNoSubmission: ev.target.checked })} /> : '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <button type="button" className="btn btn-primary min-h-11 sm:min-h-8" disabled={pending || !reason || preview.employeeCount === 0} onClick={submitRequest}>Create replacement draft</button>
            </div>
          )}
        </div>
      )}

      {canHistorical && (
        <p className="text-xs text-ink-soft">
          A file with superseded instructions is blocked from ordinary download but stays readable as protected
          historical evidence (marked do-not-upload):{' '}
          <a className="underline" href={`${REISSUE_ENDPOINT}?historical=1&file=${encodeURIComponent(preparationId)}`}>historical copy of the original file</a>.
          Labels cannot prevent a manual upload; copies already downloaded or converted cannot be recalled.
        </p>
      )}

      {message && <p role="status" className={`text-sm ${message.ok ? 'text-ink' : 'text-signal-error'}`}>{message.text}</p>}
    </section>
  );
}
