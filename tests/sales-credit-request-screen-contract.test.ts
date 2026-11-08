import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { SCREENS } from '@/ui/shell/screen-catalog';
import { screenTerms } from '@/app/registry/screen-terms';
import {
  CREDIT_MEMO_POST_CAPABILITY,
  CREDIT_MEMO_RELEASE_CAPABILITY,
  CREDIT_MEMO_REQUEST_CAPABILITY,
  CREDIT_MEMO_ROUTE,
} from '@/modules/sales/credit-memo';

/**
 * The credit memo request screen contract.
 *
 * A credit memo is money leaving the company, and the control SAP puts on it — and this system now
 * carries — is that the complaint is recorded held and no credit can be raised from it until somebody
 * releases the block. A control whose release is the same permission as the complaint is a formality,
 * so this file asks, first and hardest, that the two are different codes held by different gates.
 *
 * The rest is the DI-014 lesson again: a capability the screen asks for has to be a capability that
 * exists, or every user is refused by a screen that looks finished.
 */
const actions = readFileSync('src/app/sales/credit-memo-request/actions.ts', 'utf8');
const page = readFileSync('src/app/sales/credit-memo-request/page.tsx', 'utf8');
const shell = readFileSync('src/app/sales/credit-memo-request/CreditMemoRequest.tsx', 'utf8');
const seed = readFileSync('scripts/seed.ts', 'utf8');
const migration = readFileSync('drizzle/9235_sales_credit_request_capabilities.sql', 'utf8');

const ACTS: Array<{ capability: string; constant: string; action: string; service: string }> = [
  {
    capability: CREDIT_MEMO_REQUEST_CAPABILITY, constant: 'CREDIT_MEMO_REQUEST_CAPABILITY',
    action: 'createCreditMemoRequestAction', service: 'createCreditMemoRequest(',
  },
  {
    capability: CREDIT_MEMO_RELEASE_CAPABILITY, constant: 'CREDIT_MEMO_RELEASE_CAPABILITY',
    action: 'releaseBillingBlockAction', service: 'releaseBillingBlock(',
  },
  {
    capability: CREDIT_MEMO_POST_CAPABILITY, constant: 'CREDIT_MEMO_POST_CAPABILITY',
    action: 'createCreditMemoAction', service: 'createCreditMemo(',
  },
  {
    capability: CREDIT_MEMO_POST_CAPABILITY, constant: 'CREDIT_MEMO_POST_CAPABILITY',
    action: 'postCreditMemoAction', service: 'postCreditMemo(',
  },
];

describe('credit memo request screen contract', () => {
  it('registers the screen in the catalogue, at the route the module names', () => {
    const screen = SCREENS.find((entry) => entry.path === CREDIT_MEMO_ROUTE);
    expect(screen).toBeDefined();
    expect(screen?.area).toBe('sales');
    expect(screen?.code).toBe(CREDIT_MEMO_REQUEST_CAPABILITY);
    expect(screen?.accepts).toEqual(expect.arrayContaining(['request']));
  });

  it('opens the screen when its code is typed into the command bar', () => {
    const hits = screenTerms(CREDIT_MEMO_REQUEST_CAPABILITY);
    expect(hits.map((hit) => hit.routePath)).toContain(CREDIT_MEMO_ROUTE);
  });

  it('holds the release apart from the complaint, which is the whole point of the block', () => {
    // One code for both would let whoever asks for the money also agree to giving it.
    expect(CREDIT_MEMO_RELEASE_CAPABILITY).not.toBe(CREDIT_MEMO_REQUEST_CAPABILITY);
    expect(CREDIT_MEMO_RELEASE_CAPABILITY).not.toBe(CREDIT_MEMO_POST_CAPABILITY);
    const asking = actions.slice(actions.indexOf('export async function createCreditMemoRequestAction'));
    const releasing = actions.slice(actions.indexOf('export async function releaseBillingBlockAction'));
    expect(asking.indexOf(`can(session, ${'CREDIT_MEMO_REQUEST_CAPABILITY'})`)).toBeGreaterThan(-1);
    expect(releasing.indexOf('can(session, CREDIT_MEMO_RELEASE_CAPABILITY)')).toBeGreaterThan(-1);
    // The screen says why, in so many words: a control nobody understands is a control that gets removed.
    expect(shell).toContain('separate capability from raising the complaint');
  });

  it('asks for each capability before it does the act that capability guards', () => {
    for (const act of ACTS) {
      const body = actions.slice(actions.indexOf(`export async function ${act.action}`));
      expect(body, act.action).not.toBe(actions);
      const gate = body.indexOf(`can(session, ${act.constant})`);
      const call = body.indexOf(act.service);
      expect(gate, `${act.action} gate`).toBeGreaterThan(-1);
      expect(call, `${act.action} service`).toBeGreaterThan(gate);
      // The refusal names the code to ask for, so a reader knows what to request and not just that
      // they were refused.
      expect(actions, act.capability).toContain(`Ask for ${act.capability}.`);
    }
  });

  it('reads the session, and hands the client the three permissions it holds', () => {
    expect(page).toContain('requireSession(CREDIT_MEMO_ROUTE)');
    for (const act of ACTS) expect(page).toContain(`can(session, ${act.constant})`);
    for (const flag of ['canRaiseRequest', 'canRelease', 'canCredit']) {
      expect(page, flag).toContain(`${flag}={can(session,`);
      expect(shell, flag).toContain(flag);
    }
  });

  it('declares every capability the screen gates on, in the seed and in the migration', () => {
    for (const capability of [
      CREDIT_MEMO_REQUEST_CAPABILITY, CREDIT_MEMO_RELEASE_CAPABILITY, CREDIT_MEMO_POST_CAPABILITY,
    ]) {
      expect(seed, capability).toContain(`code: '${capability}'`);
      expect(migration, capability).toContain(`'${capability}'`);
    }
  });

  it('raises the credit from the request, which is what bounds it', () => {
    // A credit raised straight from an invoice is a credit with nothing behind it.
    expect(actions).toContain('creditMemoRequestNumber: text(form, \'creditMemoRequestNumber\')');
    expect(shell).toContain('name="creditMemoRequestNumber"');
  });

  it('takes no price from the form, and posts against the version the document stands at', () => {
    expect(actions).not.toMatch(/netPrice|conditionNumber|taxRate/);
    // The post is guarded by the version the screen read, not by a guess in a hidden field.
    expect(actions).toContain('expectedVersion: Number(text(form, \'expectedVersion\')');
    expect(shell).toContain('name="expectedVersion"');
    expect(actions).toContain('version: raised?.version');
  });
});
