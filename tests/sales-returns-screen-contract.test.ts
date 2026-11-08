import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { SCREENS } from '@/ui/shell/screen-catalog';
import { screenTerms } from '@/app/registry/screen-terms';
import {
  RETURNS_DELIVERY_CAPABILITY,
  RETURNS_ORDER_CAPABILITY,
  RETURNS_RECEIPT_CAPABILITY,
  RETURNS_ROUTE,
} from '@/modules/sales/returns';

/**
 * The returns screen contract.
 *
 * A screen that gates on a capability is making a promise it can only keep if the capability exists:
 * a code with no row in `capability` can never be granted to a role, so every user is refused by a
 * screen that looks complete. That is the DI-014 lesson, and it is the reason this file asks, for each
 * of the three acts, that the code the action asks for is the code the seed and the migration declare.
 *
 * The three acts are gated separately on purpose. Raising the complaint is commercial, raising the
 * delivery is an instruction, and receiving the goods moves stock; one code for all three would let
 * whoever may say "the customer is sending something back" also post the movement that puts it in
 * stock.
 */
const actions = readFileSync('src/app/sales/returns/actions.ts', 'utf8');
const page = readFileSync('src/app/sales/returns/page.tsx', 'utf8');
const shell = readFileSync('src/app/sales/returns/Returns.tsx', 'utf8');
const seed = readFileSync('scripts/seed.ts', 'utf8');
const roles = readFileSync('src/platform/tenancy/index.ts', 'utf8');
const migration = readFileSync('drizzle/9234_sales_returns_capabilities.sql', 'utf8');

const ACTS: Array<{ capability: string; constant: string; action: string; service: string }> = [
  {
    capability: RETURNS_ORDER_CAPABILITY, constant: 'RETURNS_ORDER_CAPABILITY',
    action: 'createReturnsOrderAction', service: 'createReturnsOrder(',
  },
  {
    capability: RETURNS_DELIVERY_CAPABILITY, constant: 'RETURNS_DELIVERY_CAPABILITY',
    action: 'createReturnsDeliveryAction', service: 'createReturnsDelivery(',
  },
  {
    capability: RETURNS_RECEIPT_CAPABILITY, constant: 'RETURNS_RECEIPT_CAPABILITY',
    action: 'receiveReturnsDeliveryAction', service: 'postReturnsDelivery(',
  },
];

describe('returns screen contract', () => {
  it('registers the screen in the catalogue, at the route the module names', () => {
    const screen = SCREENS.find((entry) => entry.path === RETURNS_ROUTE);
    expect(screen).toBeDefined();
    expect(screen?.area).toBe('sales');
    expect(screen?.code).toBe(RETURNS_ORDER_CAPABILITY);
    // What the screen can be opened on: a returns order, a returns delivery, or a customer's returns.
    expect(screen?.accepts).toEqual(expect.arrayContaining(['order', 'delivery']));
  });

  it('opens the screen when its code is typed into the command bar', () => {
    // A code no screen answers is a code nobody can reach: findable is what makes the grant usable.
    const hits = screenTerms(RETURNS_ORDER_CAPABILITY);
    expect(hits.map((hit) => hit.routePath)).toContain(RETURNS_ROUTE);
  });

  it('asks for each capability before it does the act that capability guards', () => {
    for (const act of ACTS) {
      // Inside the action, and not merely somewhere in the file: the gate is read before the service is
      // called, so a session without the capability never reaches the service at all.
      const body = actions.slice(actions.indexOf(`export async function ${act.action}`));
      expect(body, act.capability).not.toBe(actions);
      const gate = body.indexOf(`can(session, ${act.constant})`);
      const call = body.indexOf(act.service);
      expect(gate, `${act.action} gate`).toBeGreaterThan(-1);
      expect(call, `${act.action} service`).toBeGreaterThan(gate);
      // The refusal is written out in full, and names the code to ask for.
      expect(actions, act.capability).toContain(`'Ask for ${act.capability}.'`);
    }
  });

  it('reads the session, and hands the client the three permissions it holds', () => {
    expect(page).toContain('requireSession(RETURNS_ROUTE)');
    for (const act of ACTS) expect(page).toContain(`can(session, ${act.constant})`);
    for (const flag of ['canRaiseOrder', 'canRaiseDelivery', 'canReceive']) {
      expect(page, flag).toContain(`${flag}={can(session,`);
      expect(shell, flag).toContain(flag);
    }
  });

  it('declares every capability the screen gates on, in the seed and in the migration', () => {
    for (const act of ACTS) {
      expect(seed, act.capability).toContain(`code: '${act.capability}'`);
      expect(migration, act.capability).toContain(`'${act.capability}'`);
    }
  });

  it('grants the receipt to the warehouse, in the role catalogue and for tenants that already stand', () => {
    // Receiving the lorry is a warehouse act, and `INV.*` does not reach into SALES: without an
    // explicit grant the goods wait at the door for somebody at a desk.
    expect(roles).toContain(`'${RETURNS_RECEIPT_CAPABILITY}'`);
    expect(migration).toContain(`'WAREHOUSE_CLERK', '${RETURNS_RECEIPT_CAPABILITY}'`);
    // The sales clerk holds SALES.*, so the pattern reaches all three without a second grant.
    expect(roles).toContain("'SALES.*'");
  });

  it('takes no price from the form: the return is priced from the line the goods were billed on', () => {
    expect(actions).not.toMatch(/netPrice|conditionNumber|taxRate/);
    expect(shell).not.toMatch(/name="netPrice"|name="conditionNumber"/);
  });

  it('says on the screen that the receipt posts no accounting document', () => {
    // Returns stock is not valuated. A screen that promised a journal would be read as a bug later, and
    // a screen that stayed silent about it would be read as one that forgot.
    expect(page).toContain('Returns stock is not valuated');
    expect(shell).toContain('no accounting document');
    expect(migration).toContain('Returns stock is not valuated');
  });
});
