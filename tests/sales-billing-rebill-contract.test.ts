import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { BILLING_CAPABILITY } from '@/modules/sales/billing';

/**
 * The re-bill path contract.
 *
 * A cancelled invoice used to be a dead end: the delivery stayed occupied by a document that no longer
 * meant anything, so the corrected value could not be billed and the customer was left with nothing.
 * Since 9227 a cancelled document stops occupying the delivery's slot — one *live* billing document per
 * delivery, enforced by a partial unique index — and the delivery is billable again.
 *
 * The service side has stood since then. What this file holds the screen to is the two things that make
 * the path a path rather than a possibility: that the offer to bill again appears where the cancellation
 * is, and that the chain names what each document is, so a reader can tell the live invoice from the
 * cancelled one and from the cancellation that undid it.
 */
const actions = readFileSync('src/app/sales/billing/actions.ts', 'utf8');
const shell = readFileSync('src/app/sales/billing/Billing.tsx', 'utf8');

describe('billing re-bill contract', () => {
  it('gates the correction on the billing capability, not on a new one', () => {
    const body = actions.slice(actions.indexOf('export async function rebillDeliveryAction'));
    expect(body).not.toBe(actions);
    const gate = body.indexOf(`can(session, ${'BILLING_CAPABILITY'})`);
    const call = body.indexOf('postBillingDocument(');
    expect(gate, 'gate').toBeGreaterThan(-1);
    // The gate is read before the service is called, as it is everywhere else on this screen.
    expect(call, 'service').toBeGreaterThan(gate);
    // Correcting is not a new power over the customer's account: it is the same power exercised again
    // after the previous exercise was undone. A second code would say otherwise.
    expect(body).toContain('Ask for SALES.BILLING.CREATE.');
    expect(actions).not.toMatch(/SALES\.BILLING\.REBILL|SALES\.BILLING\.CORRECT/);
  });

  it('offers the corrected bill only where a document stands cancelled', () => {
    // Offering it beside a live document would be an invitation to be refused.
    expect(shell).toContain("selected.status === 'CANCELLED'");
    expect(shell).toContain('name="replacesBillingNumber"');
    expect(shell).toContain('name="deliveryNumber"');
  });

  it('says what the cancellation did, and that the delivery carries one live document', () => {
    expect(shell).toContain('is billable again');
    expect(shell).toContain('two live documents at once');
    // The cancelled row is not edited away: the chain remembers what was sent.
    expect(shell).toContain('The cancelled row stays');
  });

  it('names what each document in the chain is, so a corrected chain is readable', () => {
    // An invoice, its cancellation and the corrected invoice are three rows of the same delivery;
    // without the type, the status and what it cancels, a reader has to guess which is live.
    for (const column of ['billingDocumentType', 'billingStatus', 'billingCancels']) {
      expect(shell, column).toContain(`row.${column}`);
    }
    expect(shell).toContain('What it is');
    expect(shell).toContain('Cancels');
  });

  it('bills through the retry-aware entry point, never a second document of its own', () => {
    // postBillingDocument answers a delivery that already has an unbilled document standing with that
    // document rather than raising another, which is what keeps "one live document" true end to end.
    expect(actions).not.toMatch(/createBillingFromDelivery\(/);
    expect(actions).toContain('postBillingDocument(');
  });

  it('reports a credit-held correction as a refusal that names the way through', () => {
    const body = actions.slice(actions.indexOf('export async function rebillDeliveryAction'));
    expect(body).toContain('result.heldForCredit');
    expect(body).toContain('/finance/credit-release');
    expect(BILLING_CAPABILITY).toBe('SALES.BILLING.CREATE');
  });
});
