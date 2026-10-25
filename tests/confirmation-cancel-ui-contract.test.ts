import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const read = (path: string) => readFileSync(join(__dirname, '..', path), 'utf8');

describe('CO13 screen and migration contract', () => {
  const page = read('src/app/production/confirmation-cancel/page.tsx');
  const form = read('src/app/production/confirmation-cancel/ConfirmationCancelWorkbench.tsx');
  const service = read('src/modules/production/confirmation-cancel.ts');
  const migration = read('drizzle/9172_co13_confirmation_cancel.sql');
  const guard = read('drizzle/9173_co13_cancellation_guard.sql');
  const display = read('src/app/production/production-order-display/page.tsx');
  const ticket = read('src/app/production/time-ticket/TimeTicketWorkbench.tsx');

  it('cancels one confirmation and does not offer a goods movement or an editable quantity', () => {
    expect(service).toContain("CONFIRMATION_CANCEL_ROUTE = '/production/confirmation-cancel'");
    expect(service).toContain("CONFIRMATION_CANCEL_ALIAS = 'CO13'");
    expect(service).toContain("CONFIRMATION_CANCEL_CAPABILITY = 'PROD.CONFIRM.CANCEL'");
    expect(page).toContain('data-co13-gaps');
    expect(page).toContain('>Load<');
    expect(form).toContain('name="confirmCancel"');
    expect(form).toContain('name="reason"');
    expect(form).not.toContain('name="yieldQuantity"');
    expect(form).not.toContain('name="postingDate"');
    expect(form).not.toContain('name="orderStatus"');
    expect(service).not.toContain('postGoodsIssue');
    expect(service).not.toContain('postProductionReceipt');
    expect(service).toContain('holdsConfirmationCancelAuthority');
    expect(display).toContain('cancellationNumber');
    expect(display).not.toContain('cancelConfirmationAction');
    expect(ticket).toContain('cancellationNote');
  });

  it('shows a successful cancellation immediately and does not treat a failure as success', () => {
    const actions = read('src/app/production/confirmation-cancel/actions.ts');
    expect(form).toContain('data-co13-status');
    expect(form).toContain('const succeeded = Boolean(state.ok && state.result)');
    expect(form).toContain('const cancelled = detail.cancelled || succeeded');
    expect(form).toContain('state.result?.cancellationNumber');
    expect(form).toContain('state.result?.confirmationNumber');
    expect(form).toContain('data-co13-cancellation={state.result.cancellationNumber}');
    expect(form).toContain('data-co13-original={state.result.confirmationNumber}');
    expect(form).toContain('Not cancelled.');
    expect(form).toContain("state.ok ? 'text-ink' : 'text-red-700'");
    expect(form).toContain('disabled={blocked || !acknowledged || pending}');
    expect(form).toContain('name="confirmCancel"');
    expect(form).toContain('router.refresh()');
    expect(actions).toContain("confirmed: text(form, 'confirmCancel') === 'on'");
    expect(actions).toContain('ok: false');
    expect(actions).toContain('Cancellation ${result.cancellationNumber}');
    expect(actions).toContain('confirmation ${result.confirmationNumber}');
    expect(display).toContain('cancellationNumber');
    expect(display).not.toContain('cancelConfirmationAction');
  });

  it('stores a cancellation without granting an update of the original confirmation', () => {
    expect(migration).toContain('CREATE TABLE IF NOT EXISTS production_confirmation_cancellation');
    expect(migration).toContain('UNIQUE (client, confirmation_number)');
    expect(migration).toContain('UNIQUE (client, request_key)');
    expect(migration).toContain('FORCE ROW LEVEL SECURITY');
    expect(migration).toContain('GRANT SELECT, INSERT ON production_confirmation_cancellation TO cairn_app');
    expect(migration).not.toContain('GRANT UPDATE ON production_confirmation_cancellation');
    expect(migration).not.toContain('GRANT UPDATE, DELETE ON production_confirmation TO cairn_app');
    expect(migration).toContain('REVOKE UPDATE, DELETE ON production_confirmation FROM cairn_app');
    expect(migration).toContain('DROP INDEX IF EXISTS production_confirmation_final_uq');
    expect(migration).toContain('DROP INDEX IF EXISTS production_confirmation_header_final_uq');
    expect(migration).toContain('DROP INDEX IF EXISTS production_confirmation_operation_final_uq');
    expect(migration).toContain('production_confirmation_reject_second_active_final');
    expect(migration).toContain("'PROD.CONFIRM.CANCEL'");
    expect(migration).toContain("'CO13'");
    expect(migration).not.toContain('material_document');
    expect(guard).toContain('REVOKE UPDATE, DELETE ON production_confirmation_cancellation FROM cairn_app');
    expect(guard).toContain("IF TG_TABLE_NAME = 'production_confirmation' THEN");
  });
});
