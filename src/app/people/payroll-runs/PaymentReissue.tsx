'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';

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
      setMessage({ ok: false, text: 'The request failed. Nothing was saved.' });
      return null;
    } finally {
      setPending(false);
    }
  };

  const runPreview = async () => {
    const data = await post({ action: 'preview', sourcePreparationId: preparationId, selection, personnelNumbers: selected.join(','), intendedPaymentDate: date });
    if (data) {
      setPreview(data as ReissuePreview);
      const map: Record<string, Attestation> = {};
      for (const e of (data as ReissuePreview).employees) map[e.personnelNumber] = attest[e.personnelNumber] ?? blankAttestation();
      setAttest(map);
      setMessage(null);
    }
  };

  const submitRequest = async () => {
    if (!preview) return;
    const eligible = preview.employees.filter((e) => e.eligible);
    const attestations = eligible.map((e) => ({ personnelNumber: e.personnelNumber, ...attest[e.personnelNumber] }));
    const data = await post({
      action: 'request', sourcePreparationId: preparationId, selection, personnelNumbers: selected.join(','),
      intendedPaymentDate: date, reason, attestations: JSON.stringify(attestations), requestKey: crypto.randomUUID(),
    });
    if (data) { setMessage({ ok: true, text: 'Replacement draft created. A different authorized approver must release it.' }); setPreview(null); setReason(''); router.refresh(); }
  };

  const decide = async (reissueId: string, action: 'approve' | 'cancel', cancelReason = '') => {
    const data = await post({ action, reissueId, reason: cancelReason });
    if (data) { setMessage({ ok: true, text: action === 'approve' ? 'Replacement approved.' : 'Draft cancelled.' }); router.refresh(); }
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
                    {r.status === 'APPROVED' && canDownload && (
                      <a className="btn btn-default min-h-9" href={`${REISSUE_ENDPOINT}?reissue=${encodeURIComponent(r.reissueId)}`}>Download</a>
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
                        <p>Intended payment date <span className="code">{r.intendedPaymentDate}</span> · {r.employeeCount} employee{r.employeeCount === 1 ? '' : 's'} · total <span className="code">{r.totalAmount} {r.currency}</span> · source {r.sourcePreparationId.slice(0, 8)} · requested by {r.requestedBy}</p>
                        <div className="overflow-x-auto">
                          <table className="grid-table">
                            <thead><tr><th>Employee</th><th>Amount</th><th>Bank (masked)</th><th>Predecessor</th><th>Attested original outcome</th><th>Verified</th><th>Evidence</th></tr></thead>
                            <tbody>
                              {r.lines.map((l) => (
                                <tr key={l.lineNo}>
                                  <td className="code">{l.personnelNumber}</td>
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
                        <button type="button" className="btn btn-primary min-h-9" disabled={pending || !confirmed} onClick={() => decide(r.reissueId, 'approve')}>Approve snapshot</button>
                      </div>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {canRequest && (
        <div className="space-y-3 border-t border-line pt-3">
          <h3 className="text-sm font-semibold">Request a replacement</h3>
          <div className="grid gap-3 sm:grid-cols-3">
            <label>
              <span className="field-label">Which employees</span>
              <select className="field-input w-full" value={selection} onChange={(e) => { setSelection(e.target.value as 'ALL' | 'SELECTED'); setPreview(null); }}>
                <option value="ALL">All employees of the file</option>
                <option value="SELECTED">Only selected employees</option>
              </select>
            </label>
            <label>
              <span className="field-label">Intended payment date</span>
              <input type="date" className="field-input w-full" value={date} onChange={(e) => { setDate(e.target.value); setPreview(null); }} />
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
                          setPreview(null);
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
          historical evidence (marked do-not-upload) for authorized auditors at{' '}
          <span className="code">{REISSUE_ENDPOINT}?historical=1&amp;file=…</span>.
        </p>
      )}

      {message && <p role="status" className={`text-sm ${message.ok ? 'text-ink' : 'text-signal-error'}`}>{message.text}</p>}
    </section>
  );
}
