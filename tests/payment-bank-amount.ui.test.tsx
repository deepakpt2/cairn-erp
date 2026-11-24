/**
 * Real interaction tests for the actual-bank-amount fields:
 * - the payment run labels the entry in the selected bank's currency, not the payment currency;
 * - changing the bank or the released proposal discards a previously typed amount;
 * - a payment entry clears its actual bank amount when any other material field changes.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

afterEach(cleanup);

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock('@/ui/lock/ChangeLock', () => ({
  LockNotice: () => null,
  useChangeLock: () => ({ mode: 'CHANGE' }),
}));
vi.mock('@/ui/release/ReleasePanel', () => ({ ReleasePanel: () => <div data-testid="release-panel" /> }));
vi.mock('../src/app/finance/payment-run/actions', () => ({
  cancelOperationAction: vi.fn(async () => ({ ok: true, message: '' })),
  paymentOperationStatusAction: vi.fn(async () => null),
  cancelRunAction: vi.fn(async () => ({ ok: true, message: '' })),
  cancelRunReleaseAction: vi.fn(async () => ({ ok: true, message: '' })),
  createRunAction: vi.fn(async () => ({ ok: true, message: '' })),
  executeAction: vi.fn(async () => ({ ok: true, message: '' })),
  proposalAction: vi.fn(async () => ({ ok: true, message: '' })),
  releaseRunAction: vi.fn(async () => ({ ok: true, message: '' })),
}));
vi.mock('../src/app/finance/incoming-payment/actions', () => ({
  postPaymentAction: vi.fn(async () => ({ ok: true, message: '' })),
}));
vi.mock('@/app/constrained-values/actions', () => ({
  suggestConstrainedAction: vi.fn(async () => []),
}));

import PaymentRun from '../src/app/finance/payment-run/PaymentRun';
import IncomingPayment from '../src/app/finance/incoming-payment/IncomingPayment';
import type { BankChoice, PaymentRunView } from '../src/modules/finance/payment-run';

const BANKS = [
  { companyCode: '1000', houseBankKey: 'HB01', accountId: 'KWD1', currency: 'KWD', glAccount: '103000' },
  { companyCode: '1000', houseBankKey: 'HB02', accountId: 'USD1', currency: 'USD', glAccount: '102000' },
];

function runView(
  amount = '100.0000',
  overrides: Partial<PaymentRunView['proposal'][number]> = {},
): PaymentRunView {
  return {
    runDate: '2026-10-05', runId: 'FXR1', postingDate: '2026-10-16',
    documentCutoffDate: '2026-10-16', nextPaymentDate: '2026-11-16',
    supplierFrom: null, supplierTo: null, status: 'PROPOSAL',
    companies: [{ companyCode: '1000', payingCompanyCode: '1000' }], methods: ['T'],
    proposal: [{
      itemNumber: 1, companyCode: '1000', accountId: 'V10000',
      journalDocumentNumber: '1000/2026/1', journalFiscalYear: 2026, journalLineNumber: 1,
      invoiceNumber: 'INV-1', currency: 'USD', amount, dueDate: '2026-10-01',
      paymentMethod: 'T', exceptionCode: null, exceptionText: null,
      ...overrides,
    }],
    payments: [], payableTotal: Number(amount), exceptionCount: 0,
  };
}

function renderRun(amount = '100.0000', overrides: Partial<PaymentRunView['proposal'][number]> = {}) {
  return render(
    <PaymentRun
      run={runView(amount, overrides)}
      runs={[]}
      banks={BANKS as BankChoice[]}
      canExecute
      today="2026-10-05"
      release={null}
      canRelease={false}
    />,
  );
}

describe('payment-run actual bank amount binding', () => {
  it('labels the entry in the selected bank currency and discards it when the bank changes', async () => {
    const user = userEvent.setup();
    const rendered = renderRun();
    const bankChoice = rendered.container.querySelector('[data-bank-choice]') as HTMLSelectElement;
    await user.selectOptions(bankChoice, 'HB01/KWD1');
    expect(await screen.findByText(/payment USD → bank KWD/)).toBeTruthy();

    const amount = screen.getByLabelText('Actual bank amount in KWD for supplier V10000 paying USD');
    await user.type(amount, '32.500');
    expect((amount as HTMLInputElement).value).toBe('32.500');

    await user.selectOptions(bankChoice, 'HB02/USD1');
    expect(await screen.findByText(/payment USD → bank USD/)).toBeTruthy();
    expect(screen.getByText(/Same currency — the bank movement is the payment amount/)).toBeTruthy();
    expect(screen.queryByLabelText('Actual bank amount in USD for supplier V10000 paying USD')).toBeNull();

    // A→B→A must not resurrect A's old amount; the instruction component remounts each time.
    await user.selectOptions(bankChoice, 'HB01/KWD1');
    const returned = screen.getByLabelText('Actual bank amount in KWD for supplier V10000 paying USD') as HTMLInputElement;
    expect(returned.value).toBe('');
  });

  it('requires fresh entry when a same-looking invoice is substituted', async () => {
    const user = userEvent.setup();
    const view = renderRun();
    const bankChoice = view.container.querySelector('[data-bank-choice]') as HTMLSelectElement;
    await user.selectOptions(bankChoice, 'HB01/KWD1');
    const amount = screen.getByLabelText('Actual bank amount in KWD for supplier V10000 paying USD');
    await user.type(amount, '32.500');
    expect((amount as HTMLInputElement).value).toBe('32.500');
    const keyBefore = (view.container.querySelector('input[name="instructionKey"]') as HTMLInputElement).value;
    expect(keyBefore).not.toBe('');

    view.rerender(
      <PaymentRun
        run={runView('100.0000', { journalDocumentNumber: '1000/2026/2', journalLineNumber: 2 })}
        runs={[]}
        banks={BANKS as BankChoice[]}
        canExecute
        today="2026-10-05"
        release={null}
        canRelease={false}
      />,
    );
    const refreshed = screen.getByLabelText('Actual bank amount in KWD for supplier V10000 paying USD') as HTMLInputElement;
    expect(refreshed.value).toBe('');
    const keyAfter = (view.container.querySelector('input[name="instructionKey"]') as HTMLInputElement).value;
    expect(keyAfter).not.toBe(keyBefore);
  });

  it('discards a typed amount when the released proposal changes', async () => {
    const user = userEvent.setup();
    const view = renderRun();
    const bankChoice = view.container.querySelector('[data-bank-choice]') as HTMLSelectElement;
    await user.selectOptions(bankChoice, 'HB01/KWD1');
    const amount = screen.getByLabelText('Actual bank amount in KWD for supplier V10000 paying USD');
    await user.type(amount, '32.500');
    expect((amount as HTMLInputElement).value).toBe('32.500');

    view.rerender(
      <PaymentRun
        run={runView('120.0000')}
        runs={[]}
        banks={BANKS as BankChoice[]}
        canExecute
        today="2026-10-05"
        release={null}
        canRelease={false}
      />,
    );
    await waitFor(() => {
      const refreshed = screen.getByLabelText('Actual bank amount in KWD for supplier V10000 paying USD') as HTMLInputElement;
      expect(refreshed.value).toBe('');
    });
  });
});

describe('payment-entry actual bank amount invalidation', () => {
  it('clears the actual bank amount when the payment amount changes', async () => {
    const user = userEvent.setup();
    render(
      <IncomingPayment
        decimals={{ USD: 2, KWD: 3 }}
        view={{
          customer: 'C10000', companyCode: '1000',
          openItems: [{
            documentNumber: '1000/2026/1', fiscalYear: 2026, lineNumber: 1,
            postingDate: '2026-10-01', dueDate: '2026-10-31', currency: 'USD',
            amount: '100.0000', signed: 100, termsCode: null,
            discountPercent: 0, discountAmount: 0,
          }],
          openBalance: 100,
        }}
        loadError={null}
        canEnter
        today="2026-10-16"
      />,
    );
    const bankAmount = screen.getByPlaceholderText('Only if the bank is held in local currency') as HTMLInputElement;
    await user.type(bankAmount, '32.500');
    expect(bankAmount.value).toBe('32.500');

    const paymentAmount = screen.getByLabelText('Incoming amount') as HTMLInputElement;
    await user.type(paymentAmount, '100');
    expect(bankAmount.value).toBe('');

    // Changing the bank account is also a material instruction change.
    await user.type(bankAmount, '32.500');
    expect(bankAmount.value).toBe('32.500');
    await user.type(screen.getByPlaceholderText('101000'), '116000');
    expect(bankAmount.value).toBe('');
  });
});
