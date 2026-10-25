import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const read = (path: string) => readFileSync(join(__dirname, '..', path), 'utf8');

describe('CO11N screen contract', () => {
  const page = read('src/app/production/time-ticket/page.tsx');
  const form = read('src/app/production/time-ticket/TimeTicketWorkbench.tsx');
  const actions = read('src/app/production/time-ticket/actions.ts');
  const service = read('src/modules/production/time-ticket.ts');

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

  it('posts through the goods-movement services inside its own transaction', () => {
    // The screen does not open a second unit of work: it hands its transaction to the
    // services MIGO uses, so a refused movement takes the confirmation with it.
    expect(service).toContain('postGoodsIssue({');
    expect(service).toContain("}, 'MIGO', { tx })");
    expect(service).toContain('postProductionReceipt({');
    expect(service).toContain('}, { tx })');
    // One key per document, derived from the confirmation's own request key.
    expect(service).toContain("movementRequestKey(requestKey, 'ISSUE')");
    expect(service).toContain("movementRequestKey(requestKey, 'RECEIPT')");
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
    expect(actions).toContain('The confirmation was not saved, because the goods movement it causes was refused.');
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
