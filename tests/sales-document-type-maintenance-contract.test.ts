import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { DOCUMENT_TYPE_ROUTE } from '@/modules/sales/document-type';
import { DOCUMENT_TYPE_DEFINE_CAPABILITY } from '@/modules/sales/document-type-maintenance';

/**
 * The maintenance contract for a sales document type.
 *
 * 9226 moved what a document *is* into a row, and every refusal since has told the reader to put the type
 * back "in the sales document type configuration" — a configuration no screen maintained, so the sentence
 * was a direction without a destination. 9236 supplies the destination. This file holds the four things
 * that make it real rather than a page that looks like one:
 *
 * The remedy names the screen. Every document service offers the same remedy when its type does not stand,
 * and the remedy has to carry a route — a refusal that says where to go but not how to get there is half
 * an answer.
 *
 * The gate precedes the call, on all three actions. Maintaining what a document *is* is a configuration
 * act, so the code is a `CFG.*` code the configurator holds and the sales clerk does not.
 *
 * The screen says when a type cannot be numbered rather than waiting for a document to fail. A type whose
 * number range has no interval is the one configuration error that presents everywhere except where it was
 * made, and a list that shows the fault is the difference between a configuration and a hunt.
 *
 * And there is no delete. The application role is granted no DELETE on the table and the module exports no
 * function that removes a type, because history keeps reading the type a document was created with. A
 * withdrawal that can be undone is the only withdrawal a configuration needs.
 */
const actions = readFileSync('src/app/config/sales-document-types/actions.ts', 'utf8');
const page = readFileSync('src/app/config/sales-document-types/page.tsx', 'utf8');
const setup = readFileSync('src/app/config/sales-document-types/SalesDocumentTypeSetup.tsx', 'utf8');
const maintenance = readFileSync('src/modules/sales/document-type-maintenance.ts', 'utf8');
const resolver = readFileSync('src/modules/sales/document-type.ts', 'utf8');
const migration = readFileSync('drizzle/history/9236_sales_document_type_maintenance.sql', 'utf8');
const seed = readFileSync('scripts/seed.ts', 'utf8');

function bodyOf(source: string, exported: string): string {
  const body = source.slice(source.indexOf(exported));
  expect(body, exported).not.toBe(source);
  return body;
}

describe('sales document type maintenance contract', () => {
  it('is a configuration code, not a sales one', () => {
    expect(DOCUMENT_TYPE_DEFINE_CAPABILITY).toBe('CFG.SALES.DOCTYPE.DEFINE');
    expect(DOCUMENT_TYPE_ROUTE).toBe('/config/sales-document-types');
    expect(migration).toContain("'CFG.SALES.DOCTYPE.DEFINE'");
    // Declared in the seed as well as the migration: a tenant created after the migration and a tenant
    // that stood before it both have to hold the code.
    expect(seed).toContain('CFG.SALES.DOCTYPE.DEFINE');
    expect(migration).toContain("'SALES', 'CONFIGURE', false");
  });

  it('registers the activity in the workbench tree, at the route it built', () => {
    expect(migration).toContain('insert into config_activity');
    expect(migration).toContain("'/config/sales-document-types'");
    // A sales area of its own: what a document is, is the first thing a sales configuration says.
    expect(migration).toContain("'SALES_AND_DISTRIBUTION'");
    expect(migration).toContain('on conflict (code) do update set');
  });

  it('grants the screen the writes it needs, and no delete', () => {
    expect(migration).toContain('grant select, insert, update on table public.sales_document_type to cairn_app');
    // No grant of DELETE, and no function that removes a type: documents already created keep reading the
    // type they were created with, and a deletion the role cannot perform is a promise it cannot break.
    const grants = migration.split('\n').filter((line) => /^\s*grant\b/i.test(line));
    expect(grants.length).toBeGreaterThan(0);
    expect(grants.some((line) => /\bdelete\b/i.test(line)), grants.join(' | ')).toBe(false);
    expect(maintenance).not.toMatch(/export async function delete/);
    expect(setup).not.toMatch(/deleteDocumentType/);
  });

  it('gates all three actions before the service is called', () => {
    for (const [exported, service] of [
      ['export async function defineDocumentTypeAction', 'defineSalesDocumentType('],
      ['export async function changeDocumentTypeAction', 'changeSalesDocumentType('],
      ['export async function setDocumentTypeActiveAction', 'setSalesDocumentTypeActive('],
    ] as const) {
      const body = bodyOf(actions, exported);
      const gate = body.indexOf(`can(session, ${'DOCUMENT_TYPE_DEFINE_CAPABILITY'})`);
      const call = body.indexOf(service);
      expect(gate, `${exported} gate`).toBeGreaterThan(-1);
      expect(call, `${exported} call`).toBeGreaterThan(gate);
    }
  });

  it('says which authority is missing, and that a wildcard does not grant it', () => {
    expect(actions).toContain('Ask an administrator for an exact-code role assignment');
    expect(actions).toContain('wildcard role patterns do not grant this authority');
    // A reader with no grant still sees the types: the screen is read-only, not absent.
    expect(page).toContain('Maintenance requires an explicit exact-code role grant for');
  });

  it('shows the fault where it was made, rather than where it surfaces', () => {
    // A type whose interval does not stand is refused at definition, and the list says so afterwards.
    expect(maintenance).toContain('No active number range interval stands');
    expect(page).toContain('no document of this type can be numbered');
    expect(page).toContain('type.rangeStands');
  });

  it('offers withdrawal rather than removal, and says what it does not do', () => {
    expect(setup).toContain('Withdraw the type from new documents');
    expect(setup).toContain('Documents already created keep reading it');
    expect(page).toContain('type.documentsStanding');
  });

  it('names the screen in the remedy every document service offers', () => {
    // The remedy is assembled from the route constant, so the sentence cannot drift away from the screen.
    expect(resolver).toContain("export const DOCUMENT_TYPE_ROUTE = '/config/sales-document-types'");
    expect(resolver).toContain('Restore or redefine the document type at ${DOCUMENT_TYPE_ROUTE}');
    for (const service of ['billing.ts', 'credit-memo.ts', 'delivery.ts', 'sales-order.ts']) {
      const source = readFileSync(`src/modules/sales/${service}`, 'utf8');
      expect(source, service).toContain('DOCUMENT_TYPE_REMEDY');
    }
  });
});
