/**
 * Real component tests for the replacement panel. Renders the actual PaymentReissuePanel with a mocked fetch and
 * drives it with user events: the all-employee and selected-employee preview → attest → request flows, refusal of
 * an ineligible ALL request, stale-preview rejection, and same-key retry after an ambiguous (lost-response) submit.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { PaymentReissuePanel } from '../src/app/people/payroll-runs/PaymentReissue';

// next/navigation's router is not available in jsdom; refresh() is all this panel uses.
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn() }) }));

const SOURCE = '11111111-2222-4333-8444-555555555555';

function previewBody(over: Partial<Record<string, unknown>> = {}) {
  const employees = [
    { personnelNumber: 'P1', beneficiaryName: 'One', amount: '100.000', maskedAccount: '••••0001', bankName: 'Bank A', predecessorKind: 'FILE', predecessorId: 'pred-1', eligible: true },
    { personnelNumber: 'P2', beneficiaryName: 'Two', amount: '200.000', maskedAccount: '••••0002', bankName: 'Bank B', predecessorKind: 'FILE', predecessorId: 'pred-2', eligible: true },
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

/** Fill every attestation row: outcome, reason, verification date, evidence. */
async function attestAll(user: ReturnType<typeof userEvent.setup>, pns: string[]) {
  // The preview table is the one with an "Outcome" column header; the picker (SELECTED mode) is a checkbox list.
  const previewTable = screen.getByText('Outcome').closest('table')!;
  for (const pn of pns) {
    const row = within(previewTable).getByText(pn).closest('tr')!;
    const outcome = row.querySelector('select')!;
    await user.selectOptions(outcome, 'BANK_REJECTED');
    const inputs = row.querySelectorAll('input');
    await user.type(inputs[0]!, 'rejected by bank'); // reason
    await user.type(inputs[1]!, '2025-05-02'); // verification date
    await user.type(inputs[2]!, 'BANK-REF-1'); // evidence
  }
}

describe('PaymentReissuePanel', () => {
  let replies: Array<() => Promise<Response>>;
  beforeEach(() => {
    replies = [];
    sessionStorage.clear();
    vi.stubGlobal('fetch', vi.fn(async () => {
      const next = replies.shift();
      if (!next) throw new Error('no queued reply');
      return next();
    }));
  });
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  const json = (body: unknown, status = 200) => () => Promise.resolve(new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } }));
  const network = () => () => Promise.reject(new TypeError('network down'));

  it('ALL: previews every employee, attests, and submits a request (not blocked as "changed")', async () => {
    const user = userEvent.setup();
    renderPanel();
    replies.push(json(previewBody()));
    await user.click(screen.getByRole('button', { name: /preview eligible/i }));
    await screen.findByText('P1');
    expect(screen.getByText('P2')).toBeTruthy();

    await attestAll(user, ['P1', 'P2']);
    await user.type(screen.getByPlaceholderText(/why a replacement/i), 'duplicate payment');
    replies.push(json({ reissueId: 'r-1' }, 201));
    await user.click(screen.getByRole('button', { name: /create replacement draft/i }));

    await waitFor(() => expect(screen.getByRole('status').textContent).toMatch(/draft created/i));
    // The request POST was actually made for ALL with both previewed employees as attestations.
    const calls = (fetch as unknown as { mock: { calls: unknown[][] } }).mock.calls;
    const requestCall = calls.at(-1)![1] as { body: FormData };
    const form = requestCall.body;
    expect(form.get('action')).toBe('request');
    expect(form.get('selection')).toBe('ALL');
    const att = JSON.parse(String(form.get('attestations')));
    expect(att.map((a: { personnelNumber: string }) => a.personnelNumber).sort()).toEqual(['P1', 'P2']);
  });

  it('SELECTED: previews only the chosen employee and submits that set', async () => {
    const user = userEvent.setup();
    renderPanel();
    await user.selectOptions(screen.getByLabelText(/which employees/i), 'SELECTED');
    // Click the picker checkbox (the only checkbox group at this point).
    const pickerGroup = screen.getByText(/employees to replace/i).closest('div')!;
    await user.click(within(pickerGroup).getByText('P2').closest('label')!.querySelector('input[type="checkbox"]')!);
    const employees = [{ personnelNumber: 'P2', beneficiaryName: 'Two', amount: '200.000', maskedAccount: '••••0002', bankName: 'Bank B', predecessorKind: 'FILE', predecessorId: 'pred-2', eligible: true }];
    replies.push(json(previewBody({
      selection: 'SELECTED', employeeCount: 1, totalAmount: '200.000', employees,
      inputSignature: JSON.stringify({ v: 1, source: SOURCE, selection: 'SELECTED', selected: ['P2'], date: '2025-05-01' }),
    })));
    await user.click(screen.getByRole('button', { name: /preview eligible/i }));
    await screen.findByRole('button', { name: /create replacement draft/i });
    await attestAll(user, ['P2']);
    await user.type(screen.getByPlaceholderText(/why a replacement/i), 'returned');
    replies.push(json({ reissueId: 'r-2' }, 201));
    await user.click(screen.getByRole('button', { name: /create replacement draft/i }));
    await waitFor(() => expect(screen.getByRole('status').textContent).toMatch(/draft created/i));
    const form = ((fetch as unknown as { mock: { calls: unknown[][] } }).mock.calls.at(-1)![1] as { body: FormData }).body;
    expect(form.get('selection')).toBe('SELECTED');
    expect(form.get('personnelNumbers')).toBe('P2');
  });

  it('ALL with an ineligible employee refuses the WHOLE request and sends nothing', async () => {
    const user = userEvent.setup();
    renderPanel();
    const employees = [
      { personnelNumber: 'P1', beneficiaryName: 'One', amount: '100.000', maskedAccount: '••••0001', bankName: 'Bank A', predecessorKind: 'FILE', predecessorId: 'pred-1', eligible: true },
      { personnelNumber: 'P2', beneficiaryName: 'Two', amount: '200.000', maskedAccount: '••••', bankName: '', predecessorKind: 'FILE', predecessorId: 'pred-2', eligible: false, blocker: 'No bank account is effective on 2025-05-01' },
    ];
    replies.push(json(previewBody({ employees, employeeCount: 1, totalAmount: '100.000', ineligible: [{ personnelNumber: 'P2', blocker: 'No bank account is effective on 2025-05-01' }] })));
    await user.click(screen.getByRole('button', { name: /preview eligible/i }));
    await screen.findByText('P1');
    await attestAll(user, ['P1']);
    await user.type(screen.getByPlaceholderText(/why a replacement/i), 'x');
    const before = (fetch as unknown as { mock: { calls: unknown[] } }).mock.calls.length;
    await user.click(screen.getByRole('button', { name: /create replacement draft/i }));
    await waitFor(() => expect(screen.getByRole('status').textContent).toMatch(/refusing the whole request/i));
    expect((fetch as unknown as { mock: { calls: unknown[] } }).mock.calls.length).toBe(before);
  });

  it('changing the date after a preview requires a fresh preview (submit refused)', async () => {
    const user = userEvent.setup();
    renderPanel();
    replies.push(json(previewBody()));
    await user.click(screen.getByRole('button', { name: /preview eligible/i }));
    await screen.findByText('P1');
    // Change the date AFTER previewing: the displayed preview is now stale.
    const dateInput = screen.getByLabelText(/intended payment date/i);
    await user.clear(dateInput);
    await user.type(dateInput, '2025-06-01');
    expect(screen.queryByRole('button', { name: /create replacement draft/i })).toBeNull();
  });

  it('a lost response after submit shows UNKNOWN and retries with the SAME request key', async () => {
    const user = userEvent.setup();
    renderPanel();
    replies.push(json(previewBody()));
    await user.click(screen.getByRole('button', { name: /preview eligible/i }));
    await screen.findByText('P1');
    await attestAll(user, ['P1', 'P2']);
    await user.type(screen.getByPlaceholderText(/why a replacement/i), 'dup');
    replies.push(network()); // first submit: connection drops after the request was sent
    await user.click(screen.getByRole('button', { name: /create replacement draft/i }));
    await waitFor(() => expect(screen.getByRole('alert').textContent).toMatch(/unknown outcome/i));

    const firstForm = ((fetch as unknown as { mock: { calls: unknown[][] } }).mock.calls.find((c) => (c[1] as { body: FormData }).body.get('action') === 'request')![1] as { body: FormData }).body;
    const firstKey = firstForm.get('requestKey');

    // Retry the same details: the key must be identical (same logical submission), not a new one.
    replies.push(json({ reissueId: 'r-3' }, 201));
    await user.click(screen.getByRole('button', { name: /create replacement draft/i }));
    await waitFor(() => expect(screen.getByRole('status').textContent).toMatch(/draft created/i));
    const requestCalls = (fetch as unknown as { mock: { calls: unknown[][] } }).mock.calls.filter((c) => (c[1] as { body: FormData }).body.get('action') === 'request');
    const lastKey = (requestCalls.at(-1)![1] as { body: FormData }).body.get('requestKey');
    expect(lastKey).toBe(firstKey);
    expect(requestCalls.length).toBe(2);
  });
});
