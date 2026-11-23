import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const incoming = readFileSync('src/app/finance/incoming-payment/IncomingPayment.tsx', 'utf8');
const outgoing = readFileSync('src/app/finance/outgoing-payment/OutgoingPayment.tsx', 'utf8');
const run = readFileSync('src/app/finance/payment-run/PaymentRun.tsx', 'utf8');
const runActions = readFileSync('src/app/finance/payment-run/actions.ts', 'utf8');

describe('Actual bank-amount entry UI contract', () => {
  it('offers an optional actual bank amount on both payment forms without adding a screen', () => {
    for (const source of [incoming, outgoing]) {
      expect(source).toContain('name="bankAmount"');
      expect(source).toContain('Actual bank amount');
      expect(source).toContain('held in the company local currency');
    }
  });

  it('ties each payment-run group amount to its company, supplier and currency', () => {
    expect(run).toContain('bankAmount~${g.companyCode}~${g.accountId}~${g.currency}');
    expect(run).toContain('Actual bank amount · ');
    expect(runActions).toContain("name.startsWith('bankAmount~')");
    expect(runActions).toContain("name.split('~')");
    expect(runActions).toContain('bankAmounts,');
  });

  it('shows the posted bank movement and its provenance in the run result', () => {
    expect(run).toContain('Bank movement');
    expect(run).toContain('p.bankAmount');
    expect(run).toContain('p.bankCurrency');
    expect(run).toContain('p.bankAmountSource');
  });
});
