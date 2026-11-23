'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { PreviewGeneration, SubmissionKey, acceptsPreview, previewSignature, readAndScrubLegacyKeys, clearLegacyRecovery, type LegacyRecovery } from './reissue-request-lifecycle';

import type { ReissueIntentView, ReissuePreview, ReissueView } from '@/modules/people/payroll-payment-reissue';

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
  // The source this render belongs to, so an out-of-order response for another source is discarded, never applied.
  const sourceRef = useRef(preparationId);
  sourceRef.current = preparationId;
  // Server-side durable recovery state for THIS source; the browser stores no payload at all.
  const [intents, setIntents] = useState<ReissueIntentView[]>([]);
  const [recovery, setRecovery] = useState<'loading' | 'ready' | 'failed'>('loading');
  const [legacy, setLegacy] = useState<LegacyRecovery>({ keys: [], unreadable: false });

  // Invalidate any in-flight preview when the SOURCE changes via props, then load THIS source's durable recovery
  // list from the server. Browser storage holds nothing but a legacy opaque key (scrubbed on read).
  useEffect(() => {
    previewGen.current.invalidate();
    setPreview(null);
    previewSig.current = null;
    previewEmployees.current = [];
    // A new source gets its own in-memory key. Durable recovery comes from the server list, not the browser.
    submission.current = new SubmissionKey(() => crypto.randomUUID());
    setMessage(null);
    setLegacy(readAndScrubLegacyKeys());
    setRecovery('loading');
    setIntents([]);
    void refreshIntents();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [preparationId]);

  const formOf = (fields: Record<string, string>) => {
    const form = new FormData();
    for (const [k, v] of Object.entries(fields)) form.set(k, v);
    return form;
  };

  /**
   * POST and classify only the TRANSPORT. An HTTP status alone never proves a mutation's final outcome (an
   * intermediary can answer 4xx/5xx after forwarding), so callers consult durable server state before concluding.
   */
  const postFields = async (fields: Record<string, string>): Promise<{ kind: 'ok'; data: unknown } | { kind: 'http'; status: number; text: string } | { kind: 'transport' }> => {
    setPending(true);
    try {
      const response = await fetch(REISSUE_ENDPOINT, { method: 'POST', body: formOf(fields) });
      const text = await response.text();
      if (!response.ok) return { kind: 'http', status: response.status, text };
      try {
        return { kind: 'ok', data: JSON.parse(text) };
      } catch {
        // A 2xx with an unreadable body is ambiguous, not a success and not a refusal.
        return { kind: 'http', status: response.status, text: '' };
      }
    } catch {
      return { kind: 'transport' };
    } finally {
      setPending(false);
    }
  };

  /** The requester's OWN durable intents for this source. Null means the check itself cannot be trusted. */
  const refreshIntents = async (): Promise<ReissueIntentView[] | null> => {
    const source = preparationId;
    try {
      const response = await fetch(REISSUE_ENDPOINT, { method: 'POST', body: formOf({ action: 'intents', sourcePreparationId: source }) });
      const text = await response.text();
      // Out-of-order source switch: never let an old source's answer overwrite the current one.
      if (source !== sourceRef.current) return null;
      if (!response.ok) { setRecovery('failed'); return null; }
      const data = JSON.parse(text) as ReissueIntentView[];
      setIntents(data);
      setRecovery('ready');
      return data;
    } catch {
      if (source === sourceRef.current) setRecovery('failed');
      return null;
    }
  };

  const findIntent = (list: ReissueIntentView[] | null, match: { intentId?: string; requestKey?: string }) =>
    list?.find((i) => (match.intentId ? i.intentId === match.intentId : i.requestKey === match.requestKey)) ?? null;

  const signature = () => previewSignature(inputsRef.current);

  const runPreview = async () => {
    const inputs = inputsRef.current;
    const token = previewGen.current.issue();
    const sentSig = previewSignature(inputs);
    setPending(true);
    try {
      const response = await fetch(REISSUE_ENDPOINT, {
        method: 'POST',
        body: formOf({
          action: 'preview', sourcePreparationId: inputs.source, selection: inputs.selection,
          personnelNumbers: inputs.selection === 'SELECTED' ? inputs.selected.join(',') : '', intendedPaymentDate: inputs.date,
        }),
      });
      const text = await response.text();
      if (!response.ok) { setMessage({ ok: false, text }); return; }
      const data = JSON.parse(text) as ReissuePreview;
      // Accept only the NEWEST response for the CURRENT inputs; a later request always wins.
      if (!acceptsPreview(token, previewGen.current, sentSig, signature())) return;
      previewGen.current.accept(token);
      previewSig.current = data.inputSignature ?? sentSig;
      previewEmployees.current = data.employees.map((e) => e.personnelNumber);
      setPreview(data);
      // Functional update: keep anything already entered for these employees (a re-preview must not wipe typed
      // attestations by reading a stale closure), and add a blank row for anyone new.
      setAttest((prev) => {
        const map: Record<string, Attestation> = {};
        for (const e of data.employees) map[e.personnelNumber] = prev[e.personnelNumber] ?? blankAttestation();
        return map;
      });
      setMessage(null);
    } catch {
      setMessage({ ok: false, text: 'The preview could not be loaded. No replacement request was sent.' });
    } finally {
      setPending(false);
    }
  };

  const onCreated = (reference?: string) => {
    submission.current!.resolve();
    setMessage({
      ok: true,
      text: reference
        ? `Replacement draft ${reference} is ready. A different authorized approver must release it.`
        : 'Replacement draft created. A different authorized approver must release it.',
    });
    setPreview(null); previewSig.current = null; previewEmployees.current = []; setReason('');
    void refreshIntents();
    router.refresh();
  };

  /**
   * Execute (or replay) a registered intent. A completed intent is returned even when a fresh preview would now
   * show the employees as ineligible because the draft already exists. Any non-2xx is resolved against the durable
   * intent list: only an explicit REFUSED intent is final; "not found" cannot prove a delayed commit will not land.
   */
  const executeIntent = async (intentId: string): Promise<boolean> => {
    const source = preparationId;
    const result = await postFields({ action: 'execute', intentId });
    if (source !== sourceRef.current) return false;
    if (result.kind === 'ok') { onCreated((result.data as ReissueView).reissueReference); return true; }
    const list = await refreshIntents();
    if (source !== sourceRef.current) return false;
    const found = findIntent(list, { intentId });
    if (found?.status === 'COMPLETED') { onCreated(found.reissueReference ?? undefined); return true; }
    if (found?.status === 'REFUSED') {
      submission.current!.resolve();
      setMessage({ ok: false, text: 'This request was refused and no draft exists for it. Start a new request if the situation has changed.' });
      return false;
    }
    submission.current!.markUnresolved();
    setMessage({
      ok: false,
      text: list === null
        ? 'The outcome is unknown and the recovery check is unavailable. Do not start a different request; reload and check this file first.'
        : 'The outcome is unknown: the draft may still be created. Check this request in the recovery panel before retrying; a retry reuses the same request and cannot create a second draft.',
    });
    return false;
  };

  const submitRequest = async () => {
    if (!preview) return;
    // Never dispatch without knowing whether an earlier attempt for this source is unresolved.
    if (recovery !== 'ready') {
      setMessage({ ok: false, text: 'The recovery check for this file could not be completed. Reload the screen before submitting; no request was sent.' });
      return;
    }
    // Submit only the EXACT previewed inputs. In ALL mode the employee set is server-derived.
    if (previewSig.current === null || previewSig.current !== signature()) {
      setMessage({ ok: false, text: 'The selection or date changed since this preview. Review the current preview again before creating the draft.' });
      setPreview(null); previewSig.current = null; previewEmployees.current = [];
      return;
    }
    const ineligible = preview.employees.filter((e) => !e.eligible);
    if (ineligible.length > 0) {
      setMessage({ ok: false, text: `Refusing the whole request: ${ineligible.map((e) => `${e.personnelNumber} (${e.blocker})`).join('; ')}. Resolve these first; no partial draft is created.` });
      return;
    }
    const previewPns = previewEmployees.current;
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
      setMessage({ ok: false, text: 'An earlier replacement request has an unknown outcome. Check it in the recovery panel before submitting a different one.' });
      return;
    }

    // STEP 1 — register durably. This creates NO draft. Do not execute anything until it is acknowledged or the
    // durable list proves it exists.
    const sourceAtSubmit = preparationId;
    const reg = await postFields({ ...fields, action: 'register', requestKey: key });
    if (sourceAtSubmit !== sourceRef.current) return;
    let intentId: string | null = null;
    if (reg.kind === 'ok') {
      intentId = String((reg.data as ReissueIntentView).intentId);
    } else {
      const list = await refreshIntents();
      const found = findIntent(list, { requestKey: key });
      if (found) {
        intentId = found.intentId;
      } else if (reg.kind === 'transport' || reg.status >= 500 || reg.status === 408 || reg.status === 200 || list === null) {
        // Not proven refused, and no durable confirmation: nothing was dispatched. Reuse the same key to retry.
        submission.current!.markUnresolved();
        setMessage({ ok: false, text: 'Registration outcome is unknown. No draft was requested; retry the same details (the same key is reused) or reload and check this file first.' });
        return;
      } else {
        // The durable list proves no intent exists: registration was refused and no draft can exist.
        submission.current!.resolve();
        setMessage({ ok: false, text: reg.text || 'The request was refused.' });
        return;
      }
    }

    // STEP 2 — execute the registered intent (its exact stored payload and key).
    await executeIntent(intentId);
  };

  const checkRecovery = async () => {
    const list = await refreshIntents();
    if (list === null) {
      setMessage({ ok: false, text: 'The recovery check failed. The outcome remains unknown; check again before retrying.' });
      return;
    }
    const active = list.find((i) => i.status === 'COMPLETED' || i.status === 'RUNNING' || i.status === 'REGISTERED');
    setMessage(active
      ? { ok: true, text: 'Request status refreshed.' }
      : { ok: false, text: 'No registered or completed request is visible for this file right now. A delayed attempt could still commit; check again before starting a different request.' });
  };

  const discardIntent = async (intentId: string) => {
    const result = await postFields({ action: 'abandon', intentId });
    await refreshIntents();
    if (result.kind === 'ok') {
      submission.current!.resolve();
      setMessage({ ok: false, text: 'The attempt was marked discarded. That does not undo it: if it created a draft, cancel that draft from the history above.' });
    } else {
      setMessage({ ok: false, text: 'The discard outcome is unknown. Check the request state before starting a different request.' });
    }
  };

  /** Legacy (previous-version) browser record: reconcile by its opaque key only; the old payload is never replayed. */
  const reconcileLegacyKey = async (key: string) => {
    const source = preparationId;
    setPending(true);
    try {
      const response = await fetch(REISSUE_ENDPOINT, { method: 'POST', body: formOf({ action: 'reconcile', sourcePreparationId: preparationId, requestKey: key }) });
      const text = await response.text();
      if (!response.ok) {
        setMessage({ ok: false, text: response.status >= 500 ? 'The check failed (server error). The outcome is still unknown; check again later.' : text });
        return;
      }
      if (source !== sourceRef.current) return;
      const data = JSON.parse(text) as { found?: boolean; status?: string; reissueReference?: string };
      if (data.found) {
        submission.current!.resolve();
        clearLegacyRecovery();
        setLegacy({ keys: [], unreadable: false });
        setMessage({ ok: true, text: `The earlier attempt was confirmed: ${data.reissueReference ?? 'a draft'} is ${String(data.status ?? '').toLowerCase()}. Reload the history to act on it.` });
        void refreshIntents();
        router.refresh();
      } else {
        setMessage({ ok: false, text: 'No draft is visible for that older attempt right now. It cannot be retried exactly and the outcome is not final; check the file history before requesting a replacement.' });
      }
    } catch {
      setMessage({ ok: false, text: 'The outcome check could not be completed. The outcome is still unknown; check again before retrying.' });
    } finally {
      setPending(false);
    }
  };

  const decide = async (reissueId: string, action: 'approve' | 'cancel', cancelReason = '', confirmDigest = '') => {
    const result = await postFields({ action, reissueId, reason: cancelReason, confirmDigest, confirmReviewed: action === 'approve' ? 'yes' : '' });
    if (result.kind === 'ok') {
      setMessage({ ok: true, text: action === 'approve' ? 'Replacement approved.' : 'Draft cancelled.' });
      router.refresh();
      return;
    }
    // A non-2xx is not proof of non-commit. Ask the durable record what actually happened.
    let status: string | null = null;
    try {
      const response = await fetch(REISSUE_ENDPOINT, { method: 'POST', body: formOf({ action: 'reissueStatus', reissueId }) });
      if (response.ok) status = (JSON.parse(await response.text()) as { status?: string | null }).status ?? null;
    } catch {
      status = null;
    }
    if (action === 'approve' && status === 'APPROVED') { setMessage({ ok: true, text: 'Replacement approved.' }); router.refresh(); return; }
    if (action === 'cancel' && status === 'CANCELLED') { setMessage({ ok: true, text: 'Draft cancelled.' }); router.refresh(); return; }
    if (status === 'DRAFT' && result.kind === 'http' && result.status < 500 && result.status !== 408) {
      setMessage({ ok: false, text: result.text || 'The action was refused; the draft is unchanged.' });
      return;
    }
    setMessage({ ok: false, text: 'The outcome is unknown: the connection or a gateway failed after the request was sent. Reload the file history to confirm whether the replacement was released or cancelled; do not repeat the action blindly.' });
  };

  const updateAttest = (pn: string, patch: Partial<Attestation>) => setAttest((prev) => ({ ...prev, [pn]: { ...(prev[pn] ?? blankAttestation()), ...patch } }));

  const intentLabel = (status: ReissueIntentView['status']): string => ({
    REGISTERED: 'registered — not yet confirmed executed',
    RUNNING: 'executing — outcome unknown',
    COMPLETED: 'completed — draft exists',
    REFUSED: 'refused — no draft',
    ABANDONED: 'discarded — a draft may still exist',
  })[status];

  const intentGuidance = (status: ReissueIntentView['status']): string => ({
    REGISTERED: 'Registration creates no draft. Retrying execution is safe and reuses the exact registered request.',
    RUNNING: 'The draft may still be created by the earlier attempt. A retry reuses the same request and cannot create a second draft; do not start a different one.',
    COMPLETED: 'This request already created the draft shown. Approve or cancel it in the history above.',
    REFUSED: 'The original request was refused before any draft was created. Start a new request if the situation has changed.',
    ABANDONED: 'You discarded this attempt locally. That does not undo it: if a draft exists, cancel it in the history above.',
  })[status];

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

      {recovery === 'failed' && (
        <div role="alert" className="rounded border border-signal-danger/50 bg-signal-danger/10 p-3 text-xs">
          <p>The recovery check for this file failed, so an earlier request may still be unresolved. Do not submit a new request until this check succeeds.</p>
          <button type="button" className="btn btn-default mt-2 min-h-9" disabled={pending} onClick={() => void refreshIntents()}>Retry recovery check</button>
        </div>
      )}

      {recovery === 'ready' && intents.length > 0 && (
        <div role="alert" className="rounded border border-signal-warn/50 bg-signal-warn/10 p-3 text-xs">
          <p className="font-semibold">Your earlier replacement requests for this file</p>
          <ul className="mt-2 space-y-2">
            {intents.map((i) => (
              <li key={i.intentId} className="border-t border-line/50 pt-2 first:border-0 first:pt-0">
                <p>
                  <span className="code">{i.intentId.slice(0, 8)}…</span> — <strong>{intentLabel(i.status)}</strong>
                  {i.reissueReference ? <> · draft <span className="code">{i.reissueReference}</span> ({String(i.draftStatus ?? '').toLowerCase()})</> : null}
                </p>
                <p className="mt-1 text-ink-soft">{intentGuidance(i.status)}</p>
                <div className="mt-2 flex flex-wrap gap-2">
                  {(i.status === 'REGISTERED' || i.status === 'RUNNING') && (
                    <button type="button" className="btn btn-default min-h-9" disabled={pending} onClick={() => void executeIntent(i.intentId)}>Retry this request</button>
                  )}
                  {i.status === 'COMPLETED' && (
                    <button type="button" className="btn btn-default min-h-9" disabled={pending} onClick={() => void refreshIntents()}>Refresh draft status</button>
                  )}
                  {(i.status === 'REGISTERED' || i.status === 'RUNNING') && (
                    <button type="button" className="btn btn-default min-h-9" disabled={pending} onClick={() => void discardIntent(i.intentId)}>Discard (does not undo)</button>
                  )}
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}

      {legacy.unreadable && (
        <div role="alert" className="rounded border border-signal-warn/50 bg-signal-warn/10 p-3 text-xs">
          <p>An older local recovery record could not be read. If you had an unresolved attempt on this file, check the history above before requesting a replacement.</p>
        </div>
      )}

      {legacy.keys.length > 0 && (
        <div role="alert" className="rounded border border-signal-warn/50 bg-signal-warn/10 p-3 text-xs">
          <p>An earlier version of this screen recorded an unresolved attempt in this tab. Its details are <strong>not</strong> replayed for safety, and the old stored copy has been stripped of sensitive fields. If it created a draft, it will appear in the history above.</p>
          <div className="mt-2 flex flex-wrap gap-2">
            {legacy.keys.map((k) => (
              <button key={k} type="button" className="btn btn-default min-h-9" disabled={pending} onClick={() => void reconcileLegacyKey(k)}>
                Check older attempt <span className="code">{k.slice(0, 8)}…</span>
              </button>
            ))}
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
              <button type="button" className="btn btn-primary min-h-11 sm:min-h-8" disabled={pending || !reason || preview.employeeCount === 0 || recovery !== 'ready'} onClick={submitRequest}>Create replacement draft</button>
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
