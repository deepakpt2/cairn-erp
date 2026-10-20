import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * SCR-123 / ME5A UI contract: the list screen is a read-only report gated on
 * PROC.REQ.LIST, takes its tenant scope from the session (never the query
 * string), carries every selection the contract names, and drills each row
 * down to the standing requisition display.
 */
const capability = 'PROC.REQ.LIST';
const page = readFileSync('src/app/purchasing/requisition-list/page.tsx', 'utf8');
const shell = readFileSync('src/app/purchasing/requisition-list/RequisitionListShell.tsx', 'utf8');
const service = readFileSync('src/modules/purchasing/requisition-list.ts', 'utf8');
const messages = readFileSync('src/platform/i18n/index.ts', 'utf8');
const registry = readFileSync('scripts/seed.ts', 'utf8');

describe('SCR-123 purchase requisition list UI contract', () => {
  it('gates the screen on the exact capability and takes tenant scope from the session', () => {
    expect(service).toContain(`export const PR_LIST_CAPABILITY = '${capability}'`);
    expect(page).toContain('can(session, PR_LIST_CAPABILITY)');
    expect(page).toContain('session.user.client');
    expect(page).not.toContain('params.client');
    expect(page).not.toContain('searchParams.client');
    expect(shell).toContain('reqList.capabilityMissing');
  });

  it('carries every selection field the contract names', () => {
    for (const name of [
      'purchasingGroupFrom', 'purchasingGroupTo', 'plantFrom', 'plantTo',
      'materialFrom', 'materialTo', 'purchasingOrgFrom', 'purchasingOrgTo',
      'requisitioner', 'requisitionDateFrom', 'requisitionDateTo',
      'accountAssignmentCategory', 'maxHits',
    ]) {
      expect(shell, name).toContain(`name="${name}"`);
    }
    expect(shell).toContain('name="displayClosed"');
    expect(shell).toContain('defaultChecked={selection.displayClosed === true}');
    expect(shell).toContain('<option value="COST_CENTER">');
    expect(shell).toContain('<option value="NONE">');
  });

  it('shows every row field the contract names and drills down to the display', () => {
    for (const key of [
      'reqList.requisition', 'reqList.material', 'reqList.shortText', 'reqList.quantity',
      'reqList.unit', 'reqList.ordered', 'reqList.open', 'reqList.requisitionDate',
      'reqList.deliveryDate', 'reqList.plant', 'reqList.purchasingGroup', 'reqList.purchasingOrgs',
      'reqList.accountAssignmentShort', 'reqList.requisitionerShort', 'reqList.estimatedPrice',
      'reqList.currency', 'reqList.noClosedColumn', 'reqList.display',
    ]) {
      expect(shell, key).toContain(key);
    }
    expect(shell).toContain('href={row.drillDown}');
    expect(service).toContain('`/purchasing/requisitions?req=${encodeURIComponent');
  });

  it('indicates truncation and the hidden closed items, never silently', () => {
    expect(shell).toContain('result?.truncated');
    expect(shell).toContain('reqList.truncated');
    expect(shell).toContain('result?.closedHidden');
    expect(shell).toContain('reqList.closedHidden');
    expect(service).toContain('`The list is truncated at ${maxHits} hits');
  });

  it('is registered in the catalogue with the ME5A alias and described as read-only', () => {
    expect(registry).toContain(`code: '${capability}'`);
    expect(registry).toContain(`ourCode: '${capability}', termType: 'TRANSACTION'`);
    expect(registry).toContain("aliases: ['ME5A']");
    expect(registry).toContain("route: '/purchasing/requisition-list'");
    expect(messages).toContain("'reqList.title'");
    expect(messages).toContain("'reqList.subtitle'");
  });

  it('adds no state: the service only reads the standing tables', () => {
    expect(service).not.toMatch(/\binsert into\b/i);
    expect(service).not.toMatch(/\bupdate .* set\b/i);
    expect(service).not.toMatch(/\bdelete from\b/i);
    expect(service).toContain("from purchase_requisition_item r");
    expect(service).toContain('from purchasing_org_plant');
    expect(service).toContain('from purchase_order_item');
  });
});
