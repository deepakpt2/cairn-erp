/**
 * SCR-122 / B-822 stage 1 — intercompany schema contract.
 *
 * The OBYA clearing account already stands per company code; the new
 * records are the pair override, the document pairing and the
 * trading-partner stamp. These assertions pin that shape.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const migration = readFileSync('drizzle/9064_intercompany.sql', 'utf8');
const schema = readFileSync('src/modules/finance/schema.ts', 'utf8');
const foundation = readFileSync('src/modules/foundation/schema.ts', 'utf8');

describe('SCR-122 stage 1: intercompany records', () => {
  it('adds the pair configuration, the document pairing and the trading-partner stamp', () => {
    expect(migration).toContain('create table public.intercompany_clearing_config');
    expect(migration).toContain('create table public.intercompany_document_header');
    expect(migration).toContain('add column trading_partner_company varchar(10)');
    expect(migration).toContain('intercompany_clearing_config_distinct');
    expect(migration).toContain('intercompany_document_header_partner_idx');
  });

  it('forces tenant isolation on both new tables', () => {
    for (const table of ['intercompany_clearing_config', 'intercompany_document_header']) {
      expect(migration).toContain(`alter table public.${table} enable row level security`);
      expect(migration).toContain(`alter table public.${table} force row level security`);
      expect(migration).toContain(`create policy tenant_isolation on public.${table}`);
      expect(migration).toContain(`grant select, insert, update, delete on public.${table} to cairn_app`);
    }
  });

  it('carries the Drizzle definitions the service reads', () => {
    expect(schema).toContain("export const intercompanyClearingConfig = pgTable('intercompany_clearing_config'");
    expect(schema).toContain("export const intercompanyDocumentHeader = pgTable('intercompany_document_header'");
    expect(schema).toContain("tradingPartnerCompany: varchar('trading_partner_company', { length: 10 })");
    expect(schema).toContain("partnerDocumentNumber: varchar('partner_document_number', { length: 40 })");
  });

  it('reuses the standing OBYA clearing account rather than duplicating it', () => {
    // The company master already carries the OBYA account; the pair table's
    // clearing columns are optional overrides.
    expect(foundation).toContain("intercompanyClearingAccount: varchar('intercompany_clearing_account', { length: 10 })");
    expect(migration).toContain('sending_clearing_gl varchar(10),');
    expect(migration).toContain('receiving_clearing_gl varchar(10),');
  });
});
