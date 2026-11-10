import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import {
  RETURNS_CONFIGURATION_ROUTE,
  RETURNS_DEFINE_CAPABILITY,
} from '@/modules/sales/returns-configuration';

/**
 * The returns chain configuration contract.
 *
 * Two claims are made by this increment, and both are the kind that a screen can make while being untrue.
 *
 * The first is that the chain is configured rather than carried as constants. The only way to hold that is
 * to assert the constants are *gone*: `returns.ts` and `credit-memo.ts` must read the chain, and must not
 * name `RE`, `LR`, `CR` or `G2` any more. A screen that writes a row nobody reads is a configuration that
 * changes nothing, which is the fault the document type remedy had before 9236 gave it an address.
 *
 * The second is that the configuration is refused when it contradicts itself, and that the refusal lands
 * where it was made. The receipt movement is the sharp case: the posting re-reads that it receives into
 * returns stock and carries no value, so a configuration naming a movement that does otherwise is a
 * contradiction the goods-in door would only repeat.
 *
 * And as on the document type, there is no delete: the row is what the services read, and a chain with no
 * configuration is a refusal the screen can explain — which a deleted row is not.
 */
const actions = readFileSync('src/app/config/sales-returns/actions.ts', 'utf8');
const page = readFileSync('src/app/config/sales-returns/page.tsx', 'utf8');
const setup = readFileSync('src/app/config/sales-returns/ReturnsChainSetup.tsx', 'utf8');
const module = readFileSync('src/modules/sales/returns-configuration.ts', 'utf8');
const returns = readFileSync('src/modules/sales/returns.ts', 'utf8');
const creditMemo = readFileSync('src/modules/sales/credit-memo.ts', 'utf8');
const package_ = readFileSync('src/modules/foundation/standard-config.ts', 'utf8');
const migration = readFileSync('drizzle/history/9237_sales_returns_configuration.sql', 'utf8');
const seed = readFileSync('scripts/seed.ts', 'utf8');

describe('returns chain configuration contract', () => {
  it('is a configuration code, at the route it built', () => {
    expect(RETURNS_DEFINE_CAPABILITY).toBe('CFG.SALES.RETURNS.DEFINE');
    expect(RETURNS_CONFIGURATION_ROUTE).toBe('/config/sales-returns');
    expect(migration).toContain("'CFG.SALES.RETURNS.DEFINE'");
    // Declared in the seed as well, for the tenant created after the migration as for the one before it.
    expect(seed).toContain('CFG.SALES.RETURNS.DEFINE');
    expect(migration).toContain("'SALES', 'CONFIGURE', false");
  });

  it('registers the activity after the document type, and says it depends on it', () => {
    expect(migration).toContain('insert into config_activity');
    expect(migration).toContain("'/config/sales-returns'");
    expect(migration).toContain("'SALES_AND_DISTRIBUTION'");
    // Which types the chain uses cannot be said before the types stand.
    expect(migration).toContain("'CFG.SALES.DOCTYPE.DEFINE'");
    expect(migration).toContain('on conflict (code) do update set');
  });

  it('grants the writes the screen needs, and no delete', () => {
    expect(migration).toContain('grant select, insert, update on table sales_returns_configuration to cairn_app');
    const grants = migration.split('\n').filter((line) => /^\s*grant\b/i.test(line));
    expect(grants.length).toBeGreaterThan(0);
    expect(grants.some((line) => /\bdelete\b/i.test(line)), grants.join(' | ')).toBe(false);
    expect(module).not.toMatch(/export async function delete/);
  });

  it('gates the save before the configuration is written', () => {
    const body = actions.slice(actions.indexOf('export async function saveReturnsConfigurationAction'));
    expect(body, 'the action').not.toBe(actions);
    const gate = body.indexOf(`can(session, ${'RETURNS_DEFINE_CAPABILITY'})`);
    const call = body.indexOf('saveReturnsConfiguration(');
    expect(gate, 'gate').toBeGreaterThan(-1);
    expect(call, 'call').toBeGreaterThan(gate);
    expect(page).toContain('Maintenance requires an explicit exact-code role grant for');
  });

  it('is read by the services, which carry none of the types any more', () => {
    // The point of the increment: a screen that writes a row nobody reads is a configuration that changes
    // nothing, so the constants have to be gone from the two modules that used to carry them.
    expect(returns).toContain("from './returns-configuration'");
    expect(creditMemo).toContain("from './returns-configuration'");
    expect(returns).not.toMatch(/STANDARD_RETURNS_(ORDER|DELIVERY)_TYPE/);
    expect(creditMemo).not.toMatch(/STANDARD_CREDIT_MEMO_(REQUEST_)?TYPE/);
    expect(returns).toContain('chain.returnsOrderType');
    expect(returns).toContain('chain.returnsDeliveryType');
    expect(returns).toContain('chain.receiptMovementType');
    expect(creditMemo).toContain('complaintType');
    expect(creditMemo).toContain('creditMemoType');
  });

  it('refuses a tenant that has never configured the chain, and names the screen', () => {
    expect(module).toContain('The returns chain is not configured for this tenant');
    expect(module).toContain('`Name the document types and the receipt movement at ${RETURNS_CONFIGURATION_ROUTE}');
  });

  it('offers only a movement that could receive a return', () => {
    // The four facts the posting re-reads. A movement that contradicts them is not a choice.
    for (const fact of [
      "eq(movementType.direction, 'RECEIPT')",
      "eq(movementType.referenceCategory, 'SALES_DELIVERY')",
      'eq(movementType.destinationStockType, RETURNS)',
      'eq(movementType.valuationRelevant, false)',
    ]) {
      expect(module, fact).toContain(fact);
    }
    // And the same four, checked when the configuration is written.
    for (const refusal of [
      'and a return takes goods back in',
      'and a customer return references the delivery the goods left on',
      'and a customer return is received into returns stock',
      'and a return into returns stock carries none',
    ]) {
      expect(module, refusal).toContain(refusal);
    }
  });

  it('is delivered with every tenant, before anything asks for it', () => {
    // The configuration carries a foreign key to the receipt movement, so the movement is written first.
    expect(package_).toContain('ensureReturnsMovements(tx, client, activatedBy)');
    expect(package_).toContain('salesReturnsConfiguration');
    const seeded = package_.slice(package_.indexOf('await tx\n    .insert(salesReturnsConfiguration)'));
    expect(seeded.slice(0, 400)).toContain('STANDARD_RETURNS_ORDER_TYPE');
  });

  it('says what the four documents are for, so the form is not four boxes', () => {
    expect(page).toContain('The complaint, recorded against the invoice');
    expect(page).toContain('What the goods come back on');
    expect(setup).toContain('held with a block until somebody releases it');
  });
});
