import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * SCR-135 / MB90 UI contract: the screen is gated on INV.MATERIALDOC.RECEIVEPRINT
 * (the frozen roadmap capability), takes its tenant scope from the session, offers
 * the selection the package lists (output type, medium, dispatch time, document and
 * plant ranges, year, posting dates, status), runs determination and dispatch,
 * shows the queue with SAP's digits beside the names, and lets a row be dispatched,
 * given a recipient or previewed.
 */
const capability = 'INV.MATERIALDOC.RECEIVEPRINT';
const page = readFileSync('src/app/inventory/material-document-output/page.tsx', 'utf8');
const shell = readFileSync('src/app/inventory/material-document-output/MaterialDocumentOutput.tsx', 'utf8');
const actions = readFileSync('src/app/inventory/material-document-output/actions.ts', 'utf8');
const service = readFileSync('src/modules/inventory/material-document-output.ts', 'utf8');
const messages = readFileSync('src/platform/i18n/index.ts', 'utf8');
const registry = readFileSync('scripts/seed.ts', 'utf8');

describe('SCR-135 material document output UI contract', () => {
  it('gates the screen on the roadmap capability and takes tenant scope from the session', () => {
    expect(service).toContain(`export const MATERIAL_DOC_OUTPUT_CAPABILITY = '${capability}'`);
    expect(page).toContain('can(session, MATERIAL_DOC_OUTPUT_CAPABILITY)');
    expect(page).toContain('session.user.client');
    expect(page).not.toContain('params.client');
    expect(actions).toContain('You do not hold the material document output capability.');
  });

  it('offers the whole selection: type, medium, dispatch time, status and the ranges', () => {
    for (const name of [
      'outputType', 'transmissionMedium', 'dispatchTime', 'status',
      'documentFrom', 'documentTo', 'documentYear', 'plantFrom', 'plantTo',
      'postingDateFrom', 'postingDateTo',
    ]) {
      expect(shell, name).toContain(`name="${name}"`);
    }
  });

  it('runs determination and dispatch, and says what it did', () => {
    expect(shell).toContain('runOutputsAction');
    expect(actions).toContain('determineOutputs(');
    expect(actions).toContain('dispatchPending(');
    expect(messages).toContain("'mb90.run'");
    expect(shell).toContain('role="status"');
  });

  it('shows SAP’s digits beside the named states, media and dispatch times', () => {
    expect(shell).toContain("const STATUS_ALIAS: Record<string, string> = { PENDING: '0', PROCESSED: '1', ERROR: '2' }");
    expect(shell).toContain("PRINT: '1', EMAIL: '5'");
    expect(shell).toContain("IMMEDIATE: '1', PERIODIC: '3'");
    expect(service).toContain('statusCode');
  });

  it('shows every queue row with its document, year, output, status, sends and last attempt', () => {
    expect(shell).toContain('data-document={row.documentNumber}');
    expect(shell).toContain('data-status={row.status}');
    expect(shell).toContain('data-sends={row.sendCount}');
    expect(shell).toContain('mb90.columnLast');
    expect(shell).toContain('row.errorText');
  });

  it('lets a row be dispatched, given a recipient, and previewed', () => {
    expect(shell).toContain('dispatchOneAction');
    expect(shell).toContain('recipientAction');
    expect(shell).toContain('?preview=');
    expect(page).toContain('renderSlip({');
    expect(shell).toContain('data-slip={slip.documentNumber}');
  });

  it('refuses FAX and EDI by name rather than offering them', () => {
    expect(service).toContain('FAX');
    expect(service).toContain('EDI');
    expect(service).toMatch(/refused by name/i);
    expect(shell).not.toMatch(/value="FAX"|value="EDI"/);
  });

  it('says what it does not do: no spool, no transport', () => {
    expect(messages).toContain("'mb90.footnote'");
    expect(service).toContain('spool and transport are deferred by name');
    expect(service).not.toMatch(/nodemailer|smtp|createTransport/i);
  });

  it('registers the capability with its route and alias', () => {
    expect(registry).toContain(`'${capability}'`);
    expect(registry).toContain("aliases: ['MB90']");
    expect(registry).toContain("route: '/inventory/material-document-output'");
    expect(messages).toContain("'mb90.title': 'Material Document Output'");
  });
});
