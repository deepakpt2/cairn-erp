import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const read = (path: string) => readFileSync(join(__dirname, '..', path), 'utf8');

describe('CO11N screen contract', () => {
  const page = read('src/app/production/time-ticket/page.tsx');
  const form = read('src/app/production/time-ticket/TimeTicketWorkbench.tsx');
  const actions = read('src/app/production/time-ticket/actions.ts');
  const service = read('src/modules/production/time-ticket.ts');
  const movementService = read('src/modules/production/production-goods-movement-failures.ts');

  it('is a time ticket and does not offer an unimplemented control', () => {
    expect(service).toContain("TIME_TICKET_ROUTE = '/production/time-ticket'");
    expect(service).toContain("TIME_TICKET_ALIAS = 'CO11N'");
    expect(page).toContain('timeTicketRefusal');
    expect(page).toContain('data-co11n-gaps');
    expect(form).not.toContain('name="backflush"');
    expect(form).not.toContain('name="personnel"');
    expect(form).not.toContain('value="AUTOMATIC"');
    expect(form).not.toContain('name="confirmationNumber"');
  });

  it('commits durable movement intents with the confirmation and attempts them through MIGO posting services', () => {
    // The confirmation and immutable intents commit first; each actual posting runs in its own transaction.
    expect(service).toContain('persistConfirmationMovementIntents(tx, {');
    expect(service).toContain('processPendingConfirmationMovements({');
    expect(service).toContain('waitForConfirmationMovementSettlement({');
    expect(movementService).toContain("postGoodsIssue(issueInput(locked, actor, effectivePayload), 'MIGO', { tx })");
    expect(movementService).toContain('postProductionReceipt(receiptInput(locked, actor, effectivePayload), { tx })');
    // The UI states that a refused posting leaves a durable confirmation available to COGI.
    expect(page).toContain('The confirmation and its movement intents are saved together');
    expect(page).toContain('available in COGI without rolling back the confirmation');
    expect(page).not.toContain('it posts with the confirmation');
    // One idempotency key per movement, derived from the original confirmation request key.
    expect(movementService).toContain("movementRequestKey(input.confirmationRequestKey, 'ISSUE')");
    expect(movementService).toContain("movementRequestKey(input.confirmationRequestKey, 'RECEIPT')");
    // It is a time ticket, not a goods-movement screen: no movement fields are offered.
    expect(form).not.toContain('name="movementType"');
    expect(form).not.toContain('name="storageLocation"');
    expect(form).not.toContain('name="materialDocumentNumber"');
  });

  it('states the movements before saving, names the documents after it, and separates the outcomes', () => {
    expect(form).toContain('data-co11n-movement-config');
    expect(form).toContain('data-co11n-movements');
    expect(form).toContain('data-co11n-movement-skipped');
    // The preview says what would move; the saved view says what moved and links the document.
    expect(form).toContain('this confirmation would cause');
    expect(form).toContain('posted with this confirmation');
    expect(form).toContain('not posted yet');
    expect(form).toContain('/inventory/material-documents?document=');
    expect(form).toContain("' — reversed'");
    // A replay, a refusal, and a rolled-back movement are three different sentences.
    expect(form).toContain('data-co11n-replay');
    expect(actions).toContain('was already saved for this request');
    expect(actions).toContain('The confirmation is durable. Do not submit a new request; open COGI to review and reprocess the saved movement intent.');
    expect(actions).toContain('remedy: error.remedy');
    // The preview is read from the server, and nothing in the panel is computed in the browser.
    expect(form).not.toMatch(/Math\.(round|floor|min|max)\(/);
  });

  it('keeps the permissions and the accessibility of the ticket', () => {
    expect(form).toContain('disabled={!canConfirm || !operation.confirmable || pending}');
    expect(form).toContain('aria-label="Goods movements caused by this confirmation"');
    expect(form).toContain('<th scope="col">Movement</th>');
    expect(form).toContain('role="status"');
  });
});
