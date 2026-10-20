import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * SCR-133 / MB21 UI contract: the screen is gated on INV.RESERVATION.CREATE (the
 * frozen roadmap capability), takes its tenant scope from the session, accepts the
 * movement type, the required date and the cost centre, offers up to three item
 * lines with the company code following the plant, and shows each item with what
 * is still open so a withdrawal and a completion can be recorded against it.
 */
const capability = 'INV.RESERVATION.CREATE';
const page = readFileSync('src/app/inventory/reservations/page.tsx', 'utf8');
const shell = readFileSync('src/app/inventory/reservations/Reservations.tsx', 'utf8');
const actions = readFileSync('src/app/inventory/reservations/actions.ts', 'utf8');
const service = readFileSync('src/modules/inventory/reservations.ts', 'utf8');
const messages = readFileSync('src/platform/i18n/index.ts', 'utf8');
const registry = readFileSync('scripts/seed.ts', 'utf8');

describe('SCR-133 reservation UI contract', () => {
  it('gates the screen on the roadmap capability and takes tenant scope from the session', () => {
    expect(service).toContain(`export const RESERVATION_CREATE_CAPABILITY = '${capability}'`);
    expect(page).toContain('can(session, RESERVATION_CREATE_CAPABILITY)');
    expect(page).toContain('session.user.client');
    expect(page).not.toContain('params.client');
    expect(actions).toContain('You do not hold the reservation capability.');
  });

  it('takes the movement type, the required date and the cost centre on the header', () => {
    expect(shell).toMatch(/name="movementTypeCode"/);
    expect(shell).toMatch(/name="baseDate"[^>]*required/);
    expect(shell).toMatch(/name="costCenter"/);
    expect(service).toContain('charges a cost centre');
    expect(page).toContain('RESERVATION_SCENARIOS.map');
  });

  it('offers three item lines with material, plant, quantity, location and the movement flag', () => {
    expect(shell).toContain('name={`material-${line}`}');
    expect(shell).toContain('name={`plant-${line}`}');
    expect(shell).toContain('name={`quantity-${line}`}');
    expect(shell).toContain('name={`sloc-${line}`}');
    expect(shell).toContain('name={`allowed-${line}`} defaultChecked');
  });

  it('shows each item with required, withdrawn and open quantities and its state', () => {
    expect(shell).toContain('data-item={item.itemNumber}');
    expect(shell).toContain('data-open={item.openQuantity}');
    expect(shell).toContain('mb21.columnWithdrawn');
    expect(shell).toContain('mb21.columnOpen');
    expect(shell).toContain('data-completed={item.isCompleted}');
    expect(service).toContain('openQuantity');
    expect(service).toContain('withdrawnQuantity');
  });

  it('records a withdrawal and a completion against an item, and hides them once completed', () => {
    expect(shell).toContain('withdrawReservationAction');
    expect(shell).toContain('completeItemAction');
    expect(shell).toContain('{!item.isCompleted && (');
    expect(service).toContain('exceeds the');
    expect(service).toContain('already completed');
  });

  it('replays a submitted request key instead of writing the reservation twice', () => {
    expect(shell).toContain('name="requestKey"');
    expect(service).toContain('requestKey');
    expect(service).toContain('A replayed request key finds the reservation already standing');
  });

  it('names the missing order master when a 261 is attempted', () => {
    expect(messages).toContain("'mb21.title': 'Create Reservation'");
    expect(service).toContain('PROD.ORDER.CREATE');
    expect(registry).toContain(`'${capability}'`);
    expect(registry).toContain("aliases: ['MB21']");
    expect(registry).toContain("route: '/inventory/reservations'");
  });

  it('keeps a status message outside the conditional that hides the document', () => {
    const createIndex = shell.indexOf('createState.message');
    expect(createIndex).toBeGreaterThan(0);
    expect(shell.slice(createIndex)).toContain('role="status"');
  });
});
