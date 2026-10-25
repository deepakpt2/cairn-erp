import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * SCR-138 / CO01 UI contract: one screen creates an order and releases it, under two
 * capabilities. The header asks for what is produced, where, how much and when; the
 * component list is derived from the production version, never typed; the company
 * code is shown as derived from the plant. Nothing on the screen posts, and nothing
 * moves stock.
 */
const page = readFileSync('src/app/production/orders/page.tsx', 'utf8');
const shell = readFileSync('src/app/production/orders/OrderCreate.tsx', 'utf8');
const actions = readFileSync('src/app/production/orders/actions.ts', 'utf8');
const service = readFileSync('src/modules/inventory/production-orders.ts', 'utf8');
const snapshot = readFileSync('src/modules/production/order-bom-snapshot.ts', 'utf8');
const messages = readFileSync('src/platform/i18n/index.ts', 'utf8');
const registry = readFileSync('scripts/seed.ts', 'utf8');

describe('SCR-138 production order create UI contract', () => {
  it('gates create and release on their own capabilities, from the session tenant', () => {
    expect(service).toContain("export const PRODUCTION_ORDER_CAPABILITY = 'PROD.ORDER.CREATE'");
    expect(service).toContain("export const PRODUCTION_ORDER_RELEASE_CAPABILITY = 'PROD.ORDER.RELEASE'");
    expect(page).toContain('can(session, PRODUCTION_ORDER_CAPABILITY)');
    expect(page).toContain('can(session, PRODUCTION_ORDER_RELEASE_CAPABILITY)');
    expect(actions).toContain('session.user.client');
    expect(page).not.toContain('params.client');
  });

  it('asks for the header the order needs, with dates defaulting to today', () => {
    for (const field of ['materialNumber', 'plant', 'orderQuantity', 'scheduledStart', 'scheduledFinish']) {
      expect(shell).toContain(`name="${field}"`);
    }
    expect(shell).toContain('type="date"');
    expect(shell).toContain('required');
    expect(page).toContain('toISOString().slice(0, 10)');
  });

  it('derives components from the production version and does not take a typed grid', () => {
    expect(shell).toContain('name="productionVersion"');
    expect(shell).toContain('name="intent" value="check"');
    expect(shell).toContain('name="intent" value="create"');
    expect(shell).toContain('data-preview-version');
    expect(shell).toContain('data-production-version');
    expect(shell).toContain('co01.componentsHint');
    expect(shell).not.toContain('componentMaterial-');
    expect(shell).not.toContain('name="bomAlternative"');
    expect(shell).not.toContain('name="bomUsage"');
    expect(service).toContain('resolveOrderBomSnapshot');
    expect(service).toContain('A caller-supplied component list is not re-read from the BOM');
    expect(service).not.toContain('does not read a material BOM');
    expect(snapshot).toContain('selectProductionVersion');
    expect(snapshot).toContain('componentRequirementQuantity');
    expect(snapshot).toContain('does not explode through a phantom');
    expect(actions).toContain('bomAlternative');
    expect(actions).toContain('not accepted');
    expect(actions).not.toContain('components,');
  });

  it('shows the company code as derived from the plant, and the status as an attribute', () => {
    expect(shell).toContain('data-company-code={order.companyCode}');
    expect(shell).toContain('data-status={order.status}');
    expect(shell).toContain('data-order-number={order.orderNumber}');
    expect(service).toContain('Derived from the plant, never typed and never stored');
  });

  it('refuses in the SAP shape and offers the remedy beside the message', () => {
    expect(service).toContain('does not exist.');
    expect(shell).toContain('created.remedy');
    expect(shell).toContain('released.remedy');
    expect(messages).toContain("'co01.title': 'Create Production Order'");
    expect(messages).toContain("'co01.noCreate'");
    expect(messages).toContain("'co01.noRelease'");
  });

  it('writes nothing to stock or the ledger from the screen', () => {
    expect(service).not.toMatch(/postJournalEntry|postGoodsIssue|materialDocument/);
    expect(service).not.toMatch(/stockQuantity/);
    expect(actions).not.toMatch(/postJournalEntry|postGoodsIssue/);
  });

  it('registers PROD.ORDER.CREATE on its route with CO01 as the alias', () => {
    expect(registry).toContain("'PROD.ORDER.CREATE'");
    expect(registry).toContain("route: '/production/orders'");
    expect(registry).toMatch(/PROD\.ORDER\.CREATE[\s\S]{0,600}aliases: \['CO01'\]/);
  });
});
