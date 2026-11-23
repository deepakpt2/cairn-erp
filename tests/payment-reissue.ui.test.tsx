/**
 * Real component tests for the replacement panel. Renders the actual PaymentReissuePanel and drives it with user
 * events against an action-routed fetch mock: the all/selected preview → attest → register → execute flow, an
 * ineligible ALL refusal, stale previews, durable recovery (execute lost after commit, RUNNING/unknown, reload,
 * closed-while-pending), disabled browser storage, legacy marker scrubbing, source switches, and retry of a
 * completed draft whose employees a fresh preview now reports as ineligible.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { PaymentReissuePanel } from '../src/app/people/payroll-runs/PaymentReissue';

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn() }) }));

const SOURCE = '11111111-2222-4333-8444-555555555555';
const SOURCE2 = '99999999-2222-4333-8444-555555555555';
const LEGACY_KEY = 'cairn.paymentReissue.unresolved.v2';

function previewBody(over: Partial<Record<string, unknown>> = {}) {
  const employees = [
    { personnelNumber: 'P1', beneficiaryName: 'One', amount: '100.000', maskedAccount: '••••0001', bankName: 'Bank A', predecessorKind: 'FILE', predecessorId: 'pred-1', predecessorLabel: 'original file SALPAY-1', predecessorStatus: 'prepared', eligible: true },
    { personnelNumber: 'P2', beneficiaryName: 'Two', amount: '200.000', maskedAccount: '••••0002', bankName: 'Bank B', predecessorKind: 'FILE', predecessorId: 'pred-2', predecessorLabel: 'original file SALPAY-1', predecessorStatus: 'prepared', eligible: true },
  ];
  return {
    sourcePreparationId: SOURCE,
    inputSignature: JSON.stringify({ v: 1, source: SOURCE, selection: 'ALL', selected: [], date: '2025-05-01' }),
    sourceFileReference: 'SALPAY-1',
    runId: 'run-1',
    selection: 'ALL',
    intendedPaymentDate: '2025-05-01',
    employeeCount: 2,
    totalAmount: '300.000',
    currency: 'KWD',
    employees,
    ineligible: [],
    warning: 'warn',
    ...over,
  };
}

function renderPanel(over: Partial<Parameters<typeof PaymentReissuePanel>[0]> = {}) {
  return render(
    <PaymentReissuePanel
      preparationId={SOURCE}
      reissues={[]}
      sourceEmployees={[{ personnelNumber: 'P1', beneficiaryName: 'One' }, { personnelNumber: 'P2', beneficiaryName: 'Two' }]}
      canRequest
      canApprove={false}
      canDownload={false}
      canHistorical={false}
      currentUsername="RI.REQ"
      defaultDate="2025-05-01"
      {...over}
    />,
  );
}

async function attestAll(user: ReturnType<typeof userEvent.setup>, pns: string[]) {
  const previewTable = screen.getByText('Outcome').closest('table')!;
  for (const pn of pns) {
    const row = within(previewTable).getByText(pn).closest('tr')!;
    await user.selectOptions(row.querySelector('select')!, 'BANK_REJECTED');
    const inputs = row.querySelectorAll('input');
    await user.type(inputs[0]!, 'rejected by bank');
    await user.type(inputs[1]!, '2025-05-02');
    await user.type(inputs[2]!, 'BANK-REF-1');
  }
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

const intent = (over: Partial<Record<string, unknown>> = {}) => ({
  intentId: 'intent-1', sourcePreparationId: SOURCE, requestKey: 'key-1', status: 'RUNNING',
  reissueId: null, reissueReference: null, draftStatus: null,
  requestedAt: new Date('2025-05-01T00:00:00Z').toISOString(), updatedAt: null, ...over,
});

describe('PaymentReissuePanel', () => {
  type Handler = (form: FormData) => Promise<Response> | Response;
  let handlers: Record<string, Handler>;
  let calls: Array<{ action: string; form: FormData }>;

  const actions = (name: string) => calls.filter((c) => c.action === name);

  beforeEach(() => {
    calls = [];
    sessionStorage.clear();
    handlers = {
      intents: () => json([]),
      preview: () => json(previewBody()),
      register: (form) => json({ ...intent({ status: 'REGISTERED', requestKey: String(form.get('requestKey')) }) }, 201),
      execute: () => json({ reissueId: 'r-1', reissueReference: 'SALPAY-1-R1' }, 201),
      abandon: () => json(intent({ status: 'ABANDONED' })),
      reconcile: () => json({ found: false }),
      reissueStatus: () => json({ found: true, status: 'DRAFT' }),
    };
    vi.stubGlobal('fetch', vi.fn(async (_url: unknown, init?: RequestInit) => {
      const form = init?.body as FormData;
      const action = String(form.get('action'));
      calls.push({ action, form });
      const handler = handlers[action];
      if (!handler) throw new Error(`no handler for ${action}`);
      return handler(form);
    }));
  });
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  const waitForRecovery = async () => waitFor(() => expect(actions('intents').length).toBeGreaterThan(0));

  /** The attestation row for an employee in the displayed preview. */
  const rowOf = (pn: string) => {
    const table = screen.getByText('Outcome').closest('table')!;
    return within(table).getByText(pn).closest('tr')!;
  };

  const fillRow = async (
    user: ReturnType<typeof userEvent.setup>, pn: string,
    values: { outcome: string; reason: string; date: string; evidence: string; confirm?: boolean },
  ) => {
    const row = rowOf(pn);
    await user.selectOptions(row.querySelector('select')!, values.outcome);
    const inputs = row.querySelectorAll('input');
    await user.type(inputs[0]!, values.reason);
    await user.type(inputs[1]!, values.date);
    await user.type(inputs[2]!, values.evidence);
    if (values.outcome === 'NOT_UPLOADED') {
      await waitFor(() => expect(row.querySelectorAll('input')).toHaveLength(4));
      if (values.confirm) await user.click(row.querySelectorAll('input')[3]!);
    }
  };

  const rowValues = (pn: string) => {
    const row = rowOf(pn);
    const inputs = [...row.querySelectorAll('input')] as HTMLInputElement[];
    return {
      outcome: (row.querySelector('select') as HTMLSelectElement).value,
      reason: inputs[0]?.value ?? '',
      date: inputs[1]?.value ?? '',
      evidence: inputs[2]?.value ?? '',
      confirm: inputs[3]?.checked ?? false,
      confirmShown: inputs.length === 4,
    };
  };

  const registeredPayload = (index = 0) => {
    const form = actions('register')[index]?.form;
    expect(form).toBeDefined();
    return {
      attestations: JSON.parse(String(form!.get('attestations'))) as Array<Record<string, unknown>>,
      predecessors: JSON.parse(String(form!.get('predecessors'))) as Array<Record<string, unknown>>,
    };
  };

  const withPredecessor = (over: { pn: string; kind: 'FILE' | 'REISSUE'; id: string; label: string }) =>
    previewBody({
      employees: previewBody().employees.map((e) => (e.personnelNumber === over.pn
        ? { ...e, predecessorKind: over.kind, predecessorId: over.id, predecessorLabel: over.label }
        : e)),
    });

  it('clears every field, including the no-submission tick, when the instruction changes', async () => {
    const user = userEvent.setup();
    let n = 0;
    handlers.preview = () => (n++ === 0 ? json(previewBody()) : json(withPredecessor({ pn: 'P1', kind: 'REISSUE', id: 'r-old', label: 'replacement SALPAY-1-R1 (v1)' })));
    renderPanel();
    await waitForRecovery();
    await user.click(screen.getByRole('button', { name: /preview eligible/i }));
    await screen.findByText('P1');
    await fillRow(user, 'P1', { outcome: 'NOT_UPLOADED', reason: 'never uploaded', date: '2025-05-02', evidence: 'EV-A', confirm: true });
    await fillRow(user, 'P2', { outcome: 'BANK_REJECTED', reason: 'rejected', date: '2025-05-03', evidence: 'EV-B' });
    expect(rowValues('P1')).toMatchObject({ outcome: 'NOT_UPLOADED', confirm: true });

    // The instruction for P1 changed between previews (a competing replacement was approved).
    await user.click(screen.getByRole('button', { name: /preview eligible/i }));
    await waitFor(() => expect(screen.getByTestId('predecessor-P1').textContent).toContain('SALPAY-1-R1'));
    // EVERY field is cleared, including the previously ticked "no copy submitted" confirmation…
    expect(rowValues('P1')).toEqual({ outcome: '', reason: '', date: '', evidence: '', confirm: false, confirmShown: false });
    // …while the unchanged employee keeps their work.
    expect(rowValues('P2')).toMatchObject({ outcome: 'BANK_REJECTED', reason: 'rejected', evidence: 'EV-B' });
    expect(screen.getByRole('status').textContent).toMatch(/earlier answers were cleared/i);

    // Submission cannot register while P1 is incomplete.
    await user.type(screen.getByPlaceholderText(/why a replacement/i), 'changed instruction');
    await user.click(screen.getByRole('button', { name: /create replacement draft/i }));
    await waitFor(() => expect(screen.getByRole('status').textContent).toMatch(/record the full attested outcome.*P1/i));
    expect(actions('register')).toHaveLength(0);

    // Enter a FRESH attestation and submit: the payload pairs the new instruction with the new answers only.
    await fillRow(user, 'P1', { outcome: 'RETURNED', reason: 'returned to sender', date: '2025-05-04', evidence: 'E-NEW' });
    await user.click(screen.getByRole('button', { name: /create replacement draft/i }));
    await waitFor(() => expect(actions('register')).toHaveLength(1));
    const { attestations, predecessors } = registeredPayload();
    expect(predecessors).toContainEqual({ personnelNumber: 'P1', predecessorKind: 'REISSUE', predecessorId: 'r-old' });
    const p1 = attestations.find((a) => a.personnelNumber === 'P1')!;
    expect(p1).toMatchObject({ outcome: 'RETURNED', reason: 'returned to sender', evidenceReference: 'E-NEW', confirmedNoSubmission: false });
    expect(JSON.stringify(attestations)).not.toContain('EV-A');
    expect(JSON.stringify(attestations)).not.toContain('never uploaded');
  });

  it('clears on FILE→REISSUE and REISSUE→REISSUE in both ALL and SELECTED modes', async () => {
    for (const selection of ['ALL', 'SELECTED'] as const) {
      cleanup();
      calls.length = 0;
      const user = userEvent.setup();
      const all = previewBody();
      const selectedBody = (employees: typeof all.employees, predecessor?: { id: string }) => previewBody({
        selection: 'SELECTED',
        inputSignature: JSON.stringify({ v: 1, source: SOURCE, selection: 'SELECTED', selected: ['P1'], date: '2025-05-01' }),
        employees: predecessor ? [{ ...employees[0]!, predecessorKind: 'REISSUE' as const, predecessorId: predecessor.id, predecessorLabel: `replacement ${predecessor.id}` }] : [employees[0]!],
        employeeCount: 1,
        totalAmount: '100.000',
      });
      // ALL keeps both employees; SELECTED previews only P1. The predecessor advances on each later preview.
      const fileA = selection === 'ALL' ? all : selectedBody(all.employees);
      const reissueV1 = selection === 'ALL'
        ? previewBody({ employees: all.employees.map((e) => ({ ...e, predecessorKind: 'REISSUE' as const, predecessorId: 'r-v1', predecessorLabel: 'replacement SALPAY-1-R1 (v1)' })) })
        : selectedBody(all.employees, { id: 'r-v1' });
      const reissueV2 = selection === 'ALL'
        ? previewBody({ employees: all.employees.map((e) => ({ ...e, predecessorKind: 'REISSUE' as const, predecessorId: 'r-v2', predecessorLabel: 'replacement SALPAY-1-R2 (v1)' })) })
        : selectedBody(all.employees, { id: 'r-v2' });
      const sequence = [fileA, reissueV1, reissueV2];
      let n = 0;
      handlers.preview = () => json(sequence[Math.min(n++, sequence.length - 1)]!);

      renderPanel();
      await waitForRecovery();
      if (selection === 'SELECTED') {
        await user.selectOptions(screen.getByLabelText(/which employees/i), 'SELECTED');
        const box = screen.getAllByRole('checkbox').find((c) => c.closest('label')?.textContent?.includes('P1'))!;
        await user.click(box);
      }
      await user.click(screen.getByRole('button', { name: /preview eligible/i }));
      await waitFor(() => expect(rowValues('P1').outcome).toBe(''));
      await fillRow(user, 'P1', { outcome: 'NOT_UPLOADED', reason: 'not sent', date: '2025-05-02', evidence: 'E-1', confirm: true });
      expect(rowValues('P1')).toMatchObject({ outcome: 'NOT_UPLOADED', confirm: true });

      // FILE → approved replacement: cleared.
      await user.click(screen.getByRole('button', { name: /preview eligible/i }));
      await waitFor(() => expect(screen.getByTestId('predecessor-P1').textContent).toMatch(/R1|r-v1/));
      expect(rowValues('P1')).toMatchObject({ outcome: '', reason: '', date: '', evidence: '', confirm: false });

      // REISSUE v1 → REISSUE v2: cleared again.
      await fillRow(user, 'P1', { outcome: 'NOT_UPLOADED', reason: 'not sent 2', date: '2025-05-03', evidence: 'E-2', confirm: true });
      await user.click(screen.getByRole('button', { name: /preview eligible/i }));
      await waitFor(() => expect(screen.getByTestId('predecessor-P1').textContent).toMatch(/R2|r-v2/));
      expect(rowValues('P1')).toMatchObject({ outcome: '', reason: '', date: '', evidence: '', confirm: false });

      // Still nothing registered without a fresh attestation.
      await user.type(screen.getByPlaceholderText(/why a replacement/i), 'switch');
      await user.click(screen.getByRole('button', { name: /create replacement draft/i }));
      await waitFor(() => expect(screen.getByRole('status').textContent).toMatch(/record the full attested outcome.*P1/i));
      expect(actions('register')).toHaveLength(0);
      await fillRow(user, 'P1', { outcome: 'RETURNED', reason: 'returned', date: '2025-05-06', evidence: 'E-3' });
      if (selection === 'ALL') await fillRow(user, 'P2', { outcome: 'RETURNED', reason: 'returned 2', date: '2025-05-06', evidence: 'E-4' });
      await user.click(screen.getByRole('button', { name: /create replacement draft/i }));
      await waitFor(() => expect(actions('register')).toHaveLength(1));
      const { predecessors, attestations } = registeredPayload();
      expect(predecessors).toContainEqual({ personnelNumber: 'P1', predecessorKind: 'REISSUE', predecessorId: 'r-v2' });
      expect(attestations.find((a) => a.personnelNumber === 'P1')).toMatchObject({ outcome: 'RETURNED', evidenceReference: 'E-3' });
    }
  });

  it('never carries an attestation or a no-submission tick across a source switch (away and back)', async () => {
    const user = userEvent.setup();
    handlers.preview = (form) => json(form.get('sourcePreparationId') === SOURCE
      ? previewBody()
      : previewBody({ sourcePreparationId: SOURCE2, inputSignature: JSON.stringify({ v: 1, source: SOURCE2, selection: 'ALL', selected: [], date: '2025-05-01' }) }));
    const view = renderPanel();
    await waitForRecovery();
    await user.click(screen.getByRole('button', { name: /preview eligible/i }));
    await screen.findByText('P1');
    await fillRow(user, 'P1', { outcome: 'NOT_UPLOADED', reason: 'source A answer', date: '2025-05-02', evidence: 'A-EVIDENCE', confirm: true });
    expect(rowValues('P1')).toMatchObject({ confirm: true, evidence: 'A-EVIDENCE' });

    // Switch to a source that contains the SAME personnel number.
    view.rerender(
      <PaymentReissuePanel
        preparationId={SOURCE2} reissues={[]}
        sourceEmployees={[{ personnelNumber: 'P1', beneficiaryName: 'One' }]}
        canRequest canApprove={false} canDownload={false} canHistorical={false}
        currentUsername="RI.REQ" defaultDate="2025-05-01"
      />,
    );
    await user.click(screen.getByRole('button', { name: /preview eligible/i }));
    await screen.findByText('P1');
    // Same employee number, different source: NOTHING is inherited.
    expect(rowValues('P1')).toEqual({ outcome: '', reason: '', date: '', evidence: '', confirm: false, confirmShown: false });

    // And back again: still nothing inherits from the other source.
    view.rerender(
      <PaymentReissuePanel
        preparationId={SOURCE} reissues={[]}
        sourceEmployees={[{ personnelNumber: 'P1', beneficiaryName: 'One' }, { personnelNumber: 'P2', beneficiaryName: 'Two' }]}
        canRequest canApprove={false} canDownload={false} canHistorical={false}
        currentUsername="RI.REQ" defaultDate="2025-05-01"
      />,
    );
    await user.click(screen.getByRole('button', { name: /preview eligible/i }));
    await screen.findByText('P1');
    expect(rowValues('P1')).toEqual({ outcome: '', reason: '', date: '', evidence: '', confirm: false, confirmShown: false });
  });

  it('retains values on an identical re-preview and clears when a removed employee returns changed', async () => {
    const user = userEvent.setup();
    const base = previewBody();
    const sequence = [
      base, // 1st preview
      base, // identical re-preview: values retained
      previewBody({ employees: [base.employees[0]!] }), // P2 leaves the selection
      previewBody({ employees: [base.employees[0]!, { ...base.employees[1]!, predecessorKind: 'REISSUE', predecessorId: 'r-9', predecessorLabel: 'replacement SALPAY-1-R9 (v1)' }] }),
    ];
    let n = 0;
    handlers.preview = () => json(sequence[Math.min(n++, sequence.length - 1)]!);
    renderPanel();
    await waitForRecovery();
    await user.click(screen.getByRole('button', { name: /preview eligible/i }));
    await screen.findByText('P1');
    await fillRow(user, 'P1', { outcome: 'NOT_UPLOADED', reason: 'kept', date: '2025-05-02', evidence: 'K-1', confirm: true });
    // Identical binding: retained.
    await user.click(screen.getByRole('button', { name: /preview eligible/i }));
    await waitFor(() => expect(actions('preview')).toHaveLength(2));
    await waitFor(() => expect(rowValues('P1').outcome).toBe('NOT_UPLOADED'));
    expect(rowValues('P1')).toMatchObject({ reason: 'kept', evidence: 'K-1', confirm: true });
    // P2 leaves the selection…
    await user.click(screen.getByRole('button', { name: /preview eligible/i }));
    await waitFor(() => expect(actions('preview')).toHaveLength(3));
    await waitFor(() => expect(within(screen.getByText('Outcome').closest('table')!).queryByText('P2')).toBeNull());
    // …and returns with a DIFFERENT predecessor: its old answers must not reappear.
    await user.click(screen.getByRole('button', { name: /preview eligible/i }));
    await waitFor(() => expect(actions('preview')).toHaveLength(4));
    await screen.findByText('P2');
    expect(rowValues('P2')).toEqual({ outcome: '', reason: '', date: '', evidence: '', confirm: false, confirmShown: false });
  });

  it('an out-of-order preview response cannot restore, clear or rebind the accepted entries', async () => {
    const user = userEvent.setup();
    let releaseHeld!: () => void;
    const held = new Promise<void>((r) => { releaseHeld = r; });
    let n = 0;
    handlers.preview = (form) => {
      if (form.get('sourcePreparationId') === SOURCE) {
        // The first response for SOURCE is held back so it lands AFTER the source switch.
        n += 1;
        return held.then(() => json(withPredecessor({ pn: 'P1', kind: 'REISSUE', id: 'r-stale', label: 'replacement SALPAY-1-RSTALE (v1)' })));
      }
      return json(previewBody({ sourcePreparationId: SOURCE2, inputSignature: JSON.stringify({ v: 1, source: SOURCE2, selection: 'ALL', selected: [], date: '2025-05-01' }) }));
    };
    const view = renderPanel();
    await waitForRecovery();
    await user.click(screen.getByRole('button', { name: /preview eligible/i }));
    await waitFor(() => expect(actions('preview')).toHaveLength(1));
    // While that response is outstanding, the displayed source switches and its preview is accepted.
    view.rerender(
      <PaymentReissuePanel
        preparationId={SOURCE2} reissues={[]}
        sourceEmployees={[{ personnelNumber: 'P1', beneficiaryName: 'One' }, { personnelNumber: 'P2', beneficiaryName: 'Two' }]}
        canRequest canApprove={false} canDownload={false} canHistorical={false}
        currentUsername="RI.REQ" defaultDate="2025-05-01"
      />,
    );
    await user.click(screen.getByRole('button', { name: /preview eligible/i }));
    await waitFor(() => expect(actions('preview')).toHaveLength(2));
    await waitFor(() => expect(screen.getByTestId('predecessor-P1').textContent).toContain('original file'));
    await fillRow(user, 'P1', { outcome: 'NOT_UPLOADED', reason: 'current', date: '2025-05-02', evidence: 'CUR-1', confirm: true });
    // The stale response now lands. It must change NOTHING: no rebound predecessor, no cleared or restored entry.
    releaseHeld();
    await new Promise((r) => setTimeout(r, 30));
    expect(screen.getByTestId('predecessor-P1').textContent).toContain('original file');
    expect(screen.getByTestId('predecessor-P1').textContent).not.toContain('RSTALE');
    expect(rowValues('P1')).toMatchObject({ outcome: 'NOT_UPLOADED', reason: 'current', evidence: 'CUR-1', confirm: true });
    // Submission uses the ACCEPTED preview only, so it can proceed with the current answers.
    await fillRow(user, 'P2', { outcome: 'RETURNED', reason: 'other', date: '2025-05-03', evidence: 'CUR-2' });
    await user.type(screen.getByPlaceholderText(/why a replacement/i), 'out of order');
    await user.click(screen.getByRole('button', { name: /create replacement draft/i }));
    await waitFor(() => expect(actions('register')).toHaveLength(1));
    const { predecessors } = registeredPayload();
    expect(predecessors.every((p) => p.predecessorId === 'pred-1' || p.predecessorId === 'pred-2')).toBe(true);
  });

  it('the closure scenario: evidence entered for A is never registered against B', async () => {
    const user = userEvent.setup();
    let n = 0;
    handlers.preview = () => json(n++ === 0
      ? previewBody()
      : previewBody({ employees: previewBody().employees.map((e) => ({ ...e, predecessorKind: 'REISSUE' as const, predecessorId: 'r-approved', predecessorLabel: 'replacement SALPAY-1-R1 (v1)' })) }));
    renderPanel();
    await waitForRecovery();
    await user.click(screen.getByRole('button', { name: /preview eligible/i }));
    await screen.findByText('P1');
    await fillRow(user, 'P1', { outcome: 'NOT_UPLOADED', reason: 'OLD-P1', date: '2025-05-02', evidence: 'OLD-EV', confirm: true });
    await fillRow(user, 'P2', { outcome: 'NOT_UPLOADED', reason: 'OLD-P2', date: '2025-05-02', evidence: 'OLD-EV2', confirm: true });
    // A competing approved replacement changed the instruction for BOTH employees while the form was open.
    await user.click(screen.getByRole('button', { name: /preview eligible/i }));
    await waitFor(() => expect(screen.getByTestId('predecessor-P1').textContent).toContain('SALPAY-1-R1'));
    expect(rowValues('P1')).toMatchObject({ outcome: '', confirm: false });
    expect(rowValues('P2')).toMatchObject({ outcome: '', confirm: false });
    // Submitting the untouched form registers nothing.
    await user.type(screen.getByPlaceholderText(/why a replacement/i), 'closure');
    await user.click(screen.getByRole('button', { name: /create replacement draft/i }));
    await waitFor(() => expect(screen.getByRole('status').textContent).toMatch(/record the full attested outcome/i));
    expect(actions('register')).toHaveLength(0);
    await fillRow(user, 'P1', { outcome: 'RETURNED', reason: 'NEW-P1', date: '2025-05-04', evidence: 'NEW-EV' });
    await fillRow(user, 'P2', { outcome: 'RETURNED', reason: 'NEW-P2', date: '2025-05-04', evidence: 'NEW-EV2' });
    await user.click(screen.getByRole('button', { name: /create replacement draft/i }));
    await waitFor(() => expect(actions('register')).toHaveLength(1));
    const { attestations, predecessors } = registeredPayload();
    expect(predecessors.every((p) => p.predecessorId === 'r-approved')).toBe(true);
    const text = JSON.stringify(attestations);
    expect(text).not.toContain('OLD-EV');
    expect(text).not.toContain('OLD-P1');
    expect(attestations.every((a) => a.outcome === 'RETURNED')).toBe(true);
  });

  it('a re-preview reset never abandons or mutates an unresolved registered intent', async () => {
    const user = userEvent.setup();
    let n = 0;
    handlers.intents = () => json([intent({ status: 'REGISTERED' })]);
    handlers.preview = () => json(n++ === 0
      ? previewBody()
      : previewBody({ employees: previewBody().employees.map((e) => ({ ...e, predecessorId: 'pred-changed' })) }));
    renderPanel();
    await screen.findByText(/registered — not yet confirmed executed/i);
    await user.click(screen.getByRole('button', { name: /preview eligible/i }));
    await screen.findByText('P1');
    await fillRow(user, 'P1', { outcome: 'NOT_UPLOADED', reason: 'x', date: '2025-05-02', evidence: 'X-1', confirm: true });
    await user.click(screen.getByRole('button', { name: /preview eligible/i }));
    await waitFor(() => expect(rowValues('P1').outcome).toBe(''));
    // Nothing about the durable attempt was touched by the editable-form reset.
    expect(actions('abandon')).toHaveLength(0);
    expect(actions('execute')).toHaveLength(0);
    expect(actions('register')).toHaveLength(0);
    expect(screen.getByText(/registered — not yet confirmed executed/i)).toBeTruthy();
  });

  it('shows and submits the exact instruction each attestation is about', async () => {
    const user = userEvent.setup();
    renderPanel();
    await waitForRecovery();
    await user.click(screen.getByRole('button', { name: /preview eligible/i }));
    await screen.findByText('P1');
    expect(screen.getByTestId('predecessor-P1').textContent).toContain('original file SALPAY-1');
    expect(screen.getByTestId('predecessor-P2').textContent).toContain('original file SALPAY-1');

    await attestAll(user, ['P1', 'P2']);
    await user.type(screen.getByPlaceholderText(/why a replacement/i), 'binding');
    await user.click(screen.getByRole('button', { name: /create replacement draft/i }));
    await waitFor(() => expect(screen.getByRole('status').textContent).toMatch(/replacement draft/i));
    const predecessors = JSON.parse(String(actions('register')[0]!.form.get('predecessors'))) as Array<{ personnelNumber: string; predecessorKind: string; predecessorId: string }>;
    expect(predecessors).toEqual([
      { personnelNumber: 'P1', predecessorKind: 'FILE', predecessorId: 'pred-1' },
      { personnelNumber: 'P2', predecessorKind: 'FILE', predecessorId: 'pred-2' },
    ]);
  });

  it('a registered intent blocks a different overlapping submission before dispatch', async () => {
    const user = userEvent.setup();
    handlers.intents = () => json([intent({ status: 'REGISTERED' })]);
    renderPanel();
    await screen.findByText(/registered — not yet confirmed executed/i);
    await user.click(screen.getByRole('button', { name: /preview eligible/i }));
    await screen.findByText('P1');
    await attestAll(user, ['P1', 'P2']);
    await user.type(screen.getByPlaceholderText(/why a replacement/i), 'overlap');
    await user.click(screen.getByRole('button', { name: /create replacement draft/i }));
    await waitFor(() => expect(screen.getByRole('status').textContent).toMatch(/still registered or executing/i));
    expect(actions('register')).toHaveLength(0);
    expect(actions('execute')).toHaveLength(0);
  });

  it('a server-side overlap refusal is shown truthfully and creates nothing', async () => {
    const user = userEvent.setup();
    renderPanel();
    await waitForRecovery();
    await user.click(screen.getByRole('button', { name: /preview eligible/i }));
    await screen.findByText('P1');
    await attestAll(user, ['P1', 'P2']);
    await user.type(screen.getByPlaceholderText(/why a replacement/i), 'server overlap');
    // Another requester's unresolved attempt wins the race: registration is refused by the server.
    handlers.register = () => new Response('Another replacement request is already unresolved for at least one of these employees.', { status: 409 });
    handlers.intents = () => json([]);
    await user.click(screen.getByRole('button', { name: /create replacement draft/i }));
    await waitFor(() => expect(screen.getByRole('status').textContent).toMatch(/already unresolved/i));
    expect(actions('execute')).toHaveLength(0);
    // The message does not leak who holds it.
    expect(screen.getByRole('status').textContent).not.toMatch(/RI\./);
  });

  it('ALL: previews every employee, then registers and executes the exact request', async () => {
    const user = userEvent.setup();
    renderPanel();
    await waitForRecovery();
    await user.click(screen.getByRole('button', { name: /preview eligible/i }));
    await screen.findByText('P1');
    expect(screen.getByText('P2')).toBeTruthy();

    await attestAll(user, ['P1', 'P2']);
    await user.type(screen.getByPlaceholderText(/why a replacement/i), 'duplicate payment');
    await user.click(screen.getByRole('button', { name: /create replacement draft/i }));
    await waitFor(() => expect(screen.getByRole('status').textContent).toMatch(/replacement draft/i));

    // Registration first (creates no draft), then execution of the registered intent.
    expect(actions('register')).toHaveLength(1);
    expect(actions('execute')).toHaveLength(1);
    const reg = actions('register')[0]!.form;
    expect(reg.get('selection')).toBe('ALL');
    const att = JSON.parse(String(reg.get('attestations'))) as Array<{ personnelNumber: string }>;
    expect(att.map((a) => a.personnelNumber).sort()).toEqual(['P1', 'P2']);
    expect(actions('execute')[0]!.form.get('intentId')).toBe('intent-1');
    expect(actions('execute')[0]!.form.get('intentId')).not.toBe(reg.get('requestKey'));
  });

  it('SELECTED: previews only the chosen employee and registers that set', async () => {
    const user = userEvent.setup();
    renderPanel();
    await waitForRecovery();
    await user.selectOptions(screen.getByLabelText(/which employees/i), 'SELECTED');
    const pickerGroup = screen.getByText(/employees to replace/i).closest('div')!;
    await user.click(within(pickerGroup).getByText('P2').closest('label')!.querySelector('input[type="checkbox"]')!);
    const employees = [{ personnelNumber: 'P2', beneficiaryName: 'Two', amount: '200.000', maskedAccount: '••••0002', bankName: 'Bank B', predecessorKind: 'FILE', predecessorId: 'pred-2', eligible: true }];
    handlers.preview = () => json(previewBody({
      selection: 'SELECTED', employeeCount: 1, totalAmount: '200.000', employees,
      inputSignature: JSON.stringify({ v: 1, source: SOURCE, selection: 'SELECTED', selected: ['P2'], date: '2025-05-01' }),
    }));
    await user.click(screen.getByRole('button', { name: /preview eligible/i }));
    await screen.findByRole('button', { name: /create replacement draft/i });
    await attestAll(user, ['P2']);
    await user.type(screen.getByPlaceholderText(/why a replacement/i), 'returned');
    await user.click(screen.getByRole('button', { name: /create replacement draft/i }));
    await waitFor(() => expect(screen.getByRole('status').textContent).toMatch(/replacement draft/i));
    const reg = actions('register')[0]!.form;
    expect(reg.get('selection')).toBe('SELECTED');
    expect(reg.get('personnelNumbers')).toBe('P2');
  });

  it('ALL with an ineligible employee refuses the WHOLE request and dispatches nothing', async () => {
    const user = userEvent.setup();
    renderPanel();
    await waitForRecovery();
    const employees = [
      { personnelNumber: 'P1', beneficiaryName: 'One', amount: '100.000', maskedAccount: '••••0001', bankName: 'Bank A', predecessorKind: 'FILE', predecessorId: 'pred-1', eligible: true },
      { personnelNumber: 'P2', beneficiaryName: 'Two', amount: '200.000', maskedAccount: '••••', bankName: '', predecessorKind: 'FILE', predecessorId: 'pred-2', eligible: false, blocker: 'No bank account is effective on 2025-05-01' },
    ];
    handlers.preview = () => json(previewBody({ employees, employeeCount: 1, totalAmount: '100.000', ineligible: [{ personnelNumber: 'P2', blocker: 'No bank account is effective on 2025-05-01' }] }));
    await user.click(screen.getByRole('button', { name: /preview eligible/i }));
    await screen.findByText('P1');
    await attestAll(user, ['P1']);
    await user.type(screen.getByPlaceholderText(/why a replacement/i), 'x');
    await user.click(screen.getByRole('button', { name: /create replacement draft/i }));
    await waitFor(() => expect(screen.getByRole('status').textContent).toMatch(/refusing the whole request/i));
    expect(actions('register')).toHaveLength(0);
    expect(actions('execute')).toHaveLength(0);
  });

  it('changing the date after a preview requires a fresh preview', async () => {
    const user = userEvent.setup();
    renderPanel();
    await waitForRecovery();
    await user.click(screen.getByRole('button', { name: /preview eligible/i }));
    await screen.findByText('P1');
    const dateInput = screen.getByLabelText(/intended payment date/i);
    await user.clear(dateInput);
    await user.type(dateInput, '2025-06-01');
    expect(screen.queryByRole('button', { name: /create replacement draft/i })).toBeNull();
  });

  it('an execute 5xx AFTER a commit is resolved as COMPLETED from durable state, not "nothing was saved"', async () => {
    const user = userEvent.setup();
    renderPanel();
    await waitForRecovery();
    await user.click(screen.getByRole('button', { name: /preview eligible/i }));
    await screen.findByText('P1');
    await attestAll(user, ['P1', 'P2']);
    await user.type(screen.getByPlaceholderText(/why a replacement/i), 'proxy loss');
    handlers.execute = () => new Response('bad gateway', { status: 502 });
    handlers.intents = () => json([intent({ status: 'COMPLETED', reissueId: 'r-502', reissueReference: 'SALPAY-1-R1', draftStatus: 'DRAFT' })]);
    await user.click(screen.getByRole('button', { name: /create replacement draft/i }));
    await waitFor(() => expect(screen.getByRole('status').textContent).toMatch(/salpay-1-r1/i));
    expect(screen.queryByText(/nothing was saved/i)).toBeNull();
    expect(actions('register')).toHaveLength(1);
  });

  it('an execute 5xx with a RUNNING intent is UNKNOWN and a retry reuses the SAME intent', async () => {
    const user = userEvent.setup();
    renderPanel();
    await waitForRecovery();
    await user.click(screen.getByRole('button', { name: /preview eligible/i }));
    await screen.findByText('P1');
    await attestAll(user, ['P1', 'P2']);
    await user.type(screen.getByPlaceholderText(/why a replacement/i), 'unknown');
    handlers.execute = () => new Response('bad gateway', { status: 502 });
    handlers.intents = () => json([intent({ status: 'RUNNING' })]);
    await user.click(screen.getByRole('button', { name: /create replacement draft/i }));
    await waitFor(() => expect(screen.getByText(/executing — outcome unknown/i)).toBeTruthy());
    expect(screen.getByRole('status').textContent).toMatch(/outcome is unknown/i);
    expect(screen.queryByText(/nothing was saved/i)).toBeNull();

    handlers.execute = () => json({ reissueId: 'r-1', reissueReference: 'SALPAY-1-R1' }, 201);
    await user.click(screen.getByRole('button', { name: /retry this request/i }));
    await waitFor(() => expect(screen.getByRole('status').textContent).toMatch(/replacement draft/i));
    expect(actions('execute')).toHaveLength(2);
    expect(actions('execute')[1]!.form.get('intentId')).toBe(actions('execute')[0]!.form.get('intentId'));
    expect(actions('register')).toHaveLength(1);
  });

  it('closing while execution is pending: reopening recovers the committed draft from the server list', async () => {
    const user = userEvent.setup();
    const first = renderPanel();
    await waitForRecovery();
    await user.click(screen.getByRole('button', { name: /preview eligible/i }));
    await screen.findByText('P1');
    await attestAll(user, ['P1', 'P2']);
    await user.type(screen.getByPlaceholderText(/why a replacement/i), 'close');
    // Execution hangs; the user closes the tab before any response.
    handlers.execute = () => new Promise<Response>(() => {});
    await user.click(screen.getByRole('button', { name: /create replacement draft/i }));
    await waitFor(() => expect(actions('execute')).toHaveLength(1));
    first.unmount();

    // Reopen: the server committed the draft; the durable list is the recovery source (no browser storage).
    handlers.intents = () => json([intent({ status: 'COMPLETED', reissueId: 'r-9', reissueReference: 'SALPAY-1-R9', draftStatus: 'DRAFT' })]);
    renderPanel();
    await screen.findByText(/completed — draft exists/i);
    expect(screen.getByText(/SALPAY-1-R9/)).toBeTruthy();
    // No duplicate execution was dispatched on reopening.
    expect(actions('execute')).toHaveLength(1);
  });

  it('recovers a draft whose fresh preview now reports the employees as ineligible', async () => {
    const user = userEvent.setup();
    handlers.intents = () => json([intent({ status: 'REGISTERED' })]);
    renderPanel();
    await screen.findByText(/registered — not yet confirmed executed/i);
    // A fresh preview would block submission: the draft already exists for both employees.
    handlers.preview = () => json(previewBody({
      employees: [
        { personnelNumber: 'P1', beneficiaryName: 'One', amount: '100.000', maskedAccount: '••••0001', bankName: 'Bank A', predecessorKind: 'FILE', predecessorId: 'pred-1', eligible: false, blocker: 'Another replacement draft already exists' },
        { personnelNumber: 'P2', beneficiaryName: 'Two', amount: '200.000', maskedAccount: '••••0002', bankName: 'Bank B', predecessorKind: 'FILE', predecessorId: 'pred-2', eligible: false, blocker: 'Another replacement draft already exists' },
      ],
      employeeCount: 0, ineligible: [{ personnelNumber: 'P1', blocker: 'Another replacement draft already exists' }],
    }));
    await user.click(screen.getByRole('button', { name: /preview eligible/i }));
    await screen.findAllByText(/another replacement draft already exists/i);
    // Recovery does NOT depend on an eligible preview: retrying the registered intent returns the same draft.
    await user.click(screen.getByRole('button', { name: /retry this request/i }));
    await waitFor(() => expect(screen.getByRole('status').textContent).toMatch(/replacement draft/i));
    expect(actions('execute')[0]!.form.get('intentId')).toBe('intent-1');
    expect(actions('register')).toHaveLength(0);
  });

  it('editing the inputs while an outcome is unresolved blocks a different submission', async () => {
    const user = userEvent.setup();
    renderPanel();
    await waitForRecovery();
    await user.click(screen.getByRole('button', { name: /preview eligible/i }));
    await screen.findByText('P1');
    await attestAll(user, ['P1', 'P2']);
    await user.type(screen.getByPlaceholderText(/why a replacement/i), 'first attempt');
    handlers.execute = () => Promise.reject(new TypeError('network down'));
    handlers.intents = () => json([intent({ status: 'RUNNING' })]);
    await user.click(screen.getByRole('button', { name: /create replacement draft/i }));
    await waitFor(() => expect(screen.getByText(/executing — outcome unknown/i)).toBeTruthy());

    const dateInput = screen.getByLabelText(/intended payment date/i);
    await user.clear(dateInput);
    await user.type(dateInput, '2025-06-15');
    handlers.preview = () => json(previewBody({ intendedPaymentDate: '2025-06-15', inputSignature: JSON.stringify({ v: 1, source: SOURCE, selection: 'ALL', selected: [], date: '2025-06-15' }) }));
    await user.click(screen.getByRole('button', { name: /preview eligible/i }));
    await screen.findByRole('button', { name: /create replacement draft/i });
    await user.click(screen.getByRole('button', { name: /create replacement draft/i }));
    // A different overlapping request is refused before dispatch, naming the unresolved attempt.
    await waitFor(() => expect(screen.getByRole('status').textContent).toMatch(/still registered or executing/i));
    expect(actions('register')).toHaveLength(1);
  });

  it('an untrusted 4xx on execute stays UNKNOWN; only the durable REFUSED state is final', async () => {
    const user = userEvent.setup();
    renderPanel();
    await waitForRecovery();
    await user.click(screen.getByRole('button', { name: /preview eligible/i }));
    await screen.findByText('P1');
    await attestAll(user, ['P1', 'P2']);
    await user.type(screen.getByPlaceholderText(/why a replacement/i), '4xx');
    // A gateway can produce a 4xx after forwarding; the list still shows RUNNING, so the outcome is unknown.
    handlers.execute = () => new Response('upstream rejected', { status: 400 });
    handlers.intents = () => json([intent({ status: 'RUNNING' })]);
    await user.click(screen.getByRole('button', { name: /create replacement draft/i }));
    await waitFor(() => expect(screen.getByRole('status').textContent).toMatch(/outcome is unknown/i));
    expect(screen.queryByText(/nothing was saved/i)).toBeNull();
    expect(screen.getByText(/executing — outcome unknown/i)).toBeTruthy();
  });

  it('a proven REFUSED outcome is final and clears the unresolved state', async () => {
    const user = userEvent.setup();
    handlers.intents = () => json([intent({ status: 'REGISTERED' })]);
    renderPanel();
    await screen.findByText(/registered — not yet confirmed executed/i);
    handlers.execute = () => new Response('attestation invalid', { status: 400 });
    handlers.intents = () => json([intent({ status: 'REFUSED' })]);
    await user.click(screen.getByRole('button', { name: /retry this request/i }));
    await waitFor(() => expect(screen.getByRole('status').textContent).toMatch(/refused and no draft exists/i));
    // The refused intent is no longer offered for retry.
    await waitFor(() => expect(screen.queryByRole('button', { name: /retry this request/i })).toBeNull());
    expect(screen.getByText(/refused — no draft/i)).toBeTruthy();
  });

  it('approval/cancel never claim non-commit: a 502 is reconciled against the durable status', async () => {
    const user = userEvent.setup();
    const draft = {
      reissueId: 'r-appr', reissueReference: 'SALPAY-1-R2', version: 2, sourcePreparationId: SOURCE, selection: 'SELECTED' as const,
      employeeCount: 1, totalAmount: '100.000', currency: 'KWD', intendedPaymentDate: '2025-05-01', status: 'DRAFT' as const,
      reason: 'x', requestedBy: 'RI.OTH', approvedBy: null, superseded: false, downloadable: false, snapshotDigest: 'd',
      lines: [{
        lineNo: 1, personnelNumber: 'P1', beneficiaryName: 'One', maskedAccount: '••••0001', bankName: 'Bank A',
        amount: '100.000', currency: 'KWD', attestationOutcome: 'BANK_REJECTED' as const, attestationReason: 'rejected',
        verificationDate: '2025-05-02', evidenceReference: 'REF-1', predecessorKind: 'FILE' as const,
        predecessorId: 'pred-1', predecessorLabel: 'original file SALPAY-1',
      }],
    };
    renderPanel({ canApprove: true, reissues: [draft] });
    await waitForRecovery();
    await user.click(screen.getByRole('button', { name: /^review$/i }));
    expect(screen.getByTestId('line-predecessor-P1').textContent).toContain('original file SALPAY-1');
    handlers.approve = () => new Response('bad gateway', { status: 502 });
    handlers.reissueStatus = () => json({ found: true, status: 'APPROVED' });
    const check = screen.getByRole('checkbox');
    await user.click(check);
    await user.click(screen.getByRole('button', { name: /approve snapshot/i }));
    await waitFor(() => expect(screen.getByRole('status').textContent).toMatch(/replacement approved/i));
    expect(screen.queryByText(/nothing was saved/i)).toBeNull();
  });

  it('an approval 502 that the durable status proves did NOT commit is reported as refused, not approved', async () => {
    const user = userEvent.setup();
    const draft = {
      reissueId: 'r-appr2', reissueReference: 'SALPAY-1-R3', version: 3, sourcePreparationId: SOURCE, selection: 'SELECTED' as const,
      employeeCount: 1, totalAmount: '100.000', currency: 'KWD', intendedPaymentDate: '2025-05-01', status: 'DRAFT' as const,
      reason: 'x', requestedBy: 'RI.OTH', approvedBy: null, superseded: false, downloadable: false, snapshotDigest: 'd', lines: [],
    };
    renderPanel({ canApprove: true, reissues: [draft] });
    await waitForRecovery();
    handlers.approve = () => new Response('forbidden', { status: 403 });
    handlers.reissueStatus = () => json({ found: true, status: 'DRAFT' });
    await user.click(screen.getByRole('button', { name: /^review$/i }));
    await user.click(screen.getByRole('checkbox'));
    await user.click(screen.getByRole('button', { name: /approve snapshot/i }));
    await waitFor(() => expect(screen.getByRole('status').textContent).toMatch(/forbidden|refused/i));
    expect(screen.getByRole('status').textContent).not.toMatch(/replacement approved/i);
  });

  it('a failed recovery check blocks dispatch until it succeeds', async () => {
    const user = userEvent.setup();
    handlers.intents = () => new Response('check failed', { status: 503 });
    renderPanel();
    await screen.findByText(/recovery check for this file failed/i);
    await user.click(screen.getByRole('button', { name: /preview eligible/i }));
    await screen.findByText('P1');
    await attestAll(user, ['P1', 'P2']);
    await user.type(screen.getByPlaceholderText(/why a replacement/i), 'blocked');
    // The submit control is disabled while recovery is unknown, and a direct call cannot dispatch either.
    const submit = screen.getByRole('button', { name: /create replacement draft/i }) as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
    await user.click(submit);
    expect(actions('register')).toHaveLength(0);
    expect(actions('execute')).toHaveLength(0);
    // Once the check succeeds, dispatch is allowed again.
    handlers.intents = () => json([]);
    await user.click(screen.getByRole('button', { name: /retry recovery check/i }));
    await waitFor(() => expect((screen.getByRole('button', { name: /create replacement draft/i }) as HTMLButtonElement).disabled).toBe(false));
    await user.click(screen.getByRole('button', { name: /create replacement draft/i }));
    await waitFor(() => expect(screen.getByRole('status').textContent).toMatch(/replacement draft/i));
    expect(actions('register')).toHaveLength(1);
  });

  it('disabled browser storage: legacy check is honest, no payload is written, and server recovery still works', async () => {
    const user = userEvent.setup();
    const setItem = vi.fn(() => { throw new Error('storage full'); });
    vi.stubGlobal('sessionStorage', { getItem: () => { throw new Error('blocked'); }, setItem, removeItem: () => { throw new Error('blocked'); } });
    handlers.intents = () => json([intent({ status: 'COMPLETED', reissueId: 'r-s', reissueReference: 'SALPAY-1-RS', draftStatus: 'DRAFT' })]);
    renderPanel();
    await screen.findByText(/older local recovery record could not be read/i);
    await screen.findByText(/completed — draft exists/i);
    // Nothing was ever written to browser storage by the new flow.
    expect(setItem).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: /preview eligible/i }));
    await screen.findByText('P1');
    await attestAll(user, ['P1', 'P2']);
    await user.type(screen.getByPlaceholderText(/why a replacement/i), 'no storage');
    await user.click(screen.getByRole('button', { name: /create replacement draft/i }));
    await waitFor(() => expect(screen.getByRole('status').textContent).toMatch(/replacement draft/i));
    expect(actions('register')).toHaveLength(1);
    expect(actions('execute')).toHaveLength(1);
  });

  it('scrubs the legacy browser record to an opaque key and reconciles it without replaying its payload', async () => {
    const user = userEvent.setup();
    sessionStorage.setItem(LEGACY_KEY, JSON.stringify({
      [SOURCE]: { key: 'legacy-key-1', payload: { reason: 'SECRET-REASON', attestations: '[{"evidenceReference":"SECRET-EVIDENCE"}]' }, at: '2025-05-01T00:00:00Z' },
    }));
    renderPanel();
    await screen.findByText(/earlier version of this screen/i);
    const scrubbed = sessionStorage.getItem(LEGACY_KEY) ?? '';
    expect(scrubbed).toContain('legacy-key-1');
    expect(scrubbed).not.toContain('SECRET-REASON');
    expect(scrubbed).not.toContain('SECRET-EVIDENCE');

    handlers.reconcile = () => json({ found: true, status: 'DRAFT', reissueReference: 'LEGACY-R1' });
    await user.click(screen.getByRole('button', { name: /check older attempt/i }));
    await waitFor(() => expect(screen.getByRole('status').textContent).toMatch(/legacy-r1/i));
    expect(sessionStorage.getItem(LEGACY_KEY)).toBeNull();
    expect(calls.filter((c) => c.action === 'reconcile')[0]!.form.get('requestKey')).toBe('legacy-key-1');
  });

  it('a late response for a previous source never overwrites the current source recovery state', async () => {
    let releaseFirst!: (v: Response) => void;
    const firstPending = new Promise<Response>((resolve) => { releaseFirst = resolve; });
    handlers.intents = () => firstPending;
    const view = renderPanel();
    await waitFor(() => expect(actions('intents')).toHaveLength(1));

    handlers.intents = () => json([intent({ intentId: 'intent-2', sourcePreparationId: SOURCE2, status: 'COMPLETED', reissueId: 'r-2', reissueReference: 'SOURCE2-R1', draftStatus: 'DRAFT' })]);
    view.rerender(
      <PaymentReissuePanel
        preparationId={SOURCE2} reissues={[]} sourceEmployees={[]} canRequest canApprove={false}
        canDownload={false} canHistorical={false} currentUsername="RI.REQ" defaultDate="2025-05-01"
      />,
    );
    await screen.findByText(/completed — draft exists/i);
    expect(screen.getByText(/SOURCE2-R1/)).toBeTruthy();

    // The previous source's request resolves LAST; it must be discarded, not shown for SOURCE2.
    releaseFirst(json([intent({ intentId: 'intent-1', sourcePreparationId: SOURCE, status: 'RUNNING' })]));
    await new Promise((r) => setTimeout(r, 0));
    expect(screen.queryByText(/executing — outcome unknown/i)).toBeNull();
    expect(screen.getByText(/SOURCE2-R1/)).toBeTruthy();
  });
});
