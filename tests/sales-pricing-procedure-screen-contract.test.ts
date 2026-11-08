import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { PRICING_DEFINE_CAPABILITY } from '@/modules/sales/pricing-procedure-maintenance';
import { PRICING_PROCEDURE_ROUTE } from '@/modules/sales/pricing-procedure';

/**
 * The maintenance contract for the pricing procedure.
 *
 * The engine refuses with a remedy that names a screen: "Maintain the procedure determination at
 * /config/pricing-procedure". A direction to a place that does not exist is not an answer, and it is the
 * same fault the document type carried before 9236 gave it an address. This file holds the things that
 * make the screen real rather than a page that looks like one:
 *
 * The remedy names a route that stands, and the route is the one constant the refusals are built from.
 *
 * The gate precedes the call on every action. Deciding how a customer's invoice is calculated is a
 * configuration act, so the code is a `CFG.*` code the configurator holds and the sales clerk does not.
 *
 * Nothing is deleted. A step is withdrawn, a type is withdrawn, and the application role is granted no
 * DELETE on any of the tables — the documents already priced keep the rule they were priced under, and a
 * deletion the role cannot perform is a promise it cannot break.
 *
 * And the screen says where the configuration is wrong rather than waiting for a document to fail: a
 * percentage step with no span, a header step reading a cost from a material, a determination naming a
 * sales area that does not stand.
 */
const actions = readFileSync('src/app/config/pricing-procedure/actions.ts', 'utf8');
const page = readFileSync('src/app/config/pricing-procedure/page.tsx', 'utf8');
const setup = readFileSync('src/app/config/pricing-procedure/PricingProcedureSetup.tsx', 'utf8');
const maintenance = readFileSync('src/modules/sales/pricing-procedure-maintenance.ts', 'utf8');
const engine = readFileSync('src/modules/sales/pricing-procedure.ts', 'utf8');
const migration = readFileSync('drizzle/9238_sales_pricing_procedure.sql', 'utf8');
const seed = readFileSync('scripts/seed.ts', 'utf8');
const catalog = readFileSync('src/ui/shell/screen-catalog.ts', 'utf8');

function bodyOf(source: string, exported: string): string {
  const body = source.slice(source.indexOf(exported));
  expect(body, exported).not.toBe(source);
  return body;
}

describe('pricing procedure maintenance contract', () => {
  it('is a configuration code, and the route the refusals name is the route that stands', () => {
    expect(PRICING_DEFINE_CAPABILITY).toBe('CFG.SALES.PRICING.DEFINE');
    expect(PRICING_PROCEDURE_ROUTE).toBe('/config/pricing-procedure');
    // The route is a constant the engine builds its remedies from, so a sentence cannot drift away from
    // the screen it points at.
    expect(engine).toContain("export const PRICING_PROCEDURE_ROUTE = '/config/pricing-procedure'");
    expect(catalog).toContain('"/config/pricing-procedure"');
    expect(seed).toContain("'/config/pricing-procedure'");
    expect(migration).toContain("'/config/pricing-procedure'");
  });

  it('registers the capability and the workbench activity, in the migration and in the seed', () => {
    expect(migration).toContain("'CFG.SALES.PRICING.DEFINE'");
    expect(migration).toContain("'SALES', 'CONFIGURE', false");
    expect(migration).toContain('insert into config_activity');
    expect(migration).toContain("'SALES_AND_DISTRIBUTION'");
    expect(migration).toContain('on conflict (code) do update set');
    // A tenant created after the migration and a tenant that stood before it both hold the code.
    expect(seed).toContain("code: 'CFG.SALES.PRICING.DEFINE'");
    // The seed's activity row names the same screen; it would otherwise point the workbench at the
    // condition-record screen while every refusal points here.
    const activity = seed.split('\n').find((line) => line.includes("code: 'CFG.SALES.PRICING.DEFINE'")) ?? '';
    expect(activity).toContain("route: '/config/pricing-procedure'");
  });

  it('grants the writes the screen needs, and no delete', () => {
    // The tables are granted in a loop over the five the configuration stands in, and the grant is the
    // same three verbs: the screen maintains, it does not remove.
    expect(migration).toContain("grant select, insert, update on table %I to cairn_app");
    // Every one of the five tables the configuration stands in, and no other.
    for (const table of [
      'sales_condition_type', 'sales_pricing_procedure', 'sales_pricing_procedure_step',
      'sales_procedure_determination', 'sales_document_condition',
    ]) {
      expect(migration, table).toContain(`'${table}'`);
    }
    // No grant of DELETE anywhere in the migration, in the loop or out of it. Only lines that actually
    // grant something are read, so a comment that merely mentions the word counts for nothing.
    const granted = migration.split('\n').filter((line) => /grant (select|insert|update|delete|all)\b/i.test(line));
    expect(granted.length).toBeGreaterThan(0);
    expect(granted.some((line) => /\bdelete\b/i.test(line)), granted.join(' | ')).toBe(false);
    expect(maintenance).not.toMatch(/export async function delete/);
    expect(setup).not.toMatch(/deleteStep|deleteProcedure|deleteConditionType/);
  });

  it('gates every action before the service is called', () => {
    const gated = [
      'export async function defineConditionTypeAction',
      'export async function changeConditionTypeAction',
      'export async function defineProcedureAction',
      'export async function changeProcedureAction',
      'export async function addStepAction',
      'export async function changeStepAction',
      'export async function defineDeterminationAction',
      'export async function changeDeterminationAction',
    ];
    for (const exported of gated) {
      const body = bodyOf(actions, exported);
      const gate = body.indexOf('can(session, PRICING_DEFINE_CAPABILITY)');
      const denied = body.indexOf('return denied()');
      expect(gate, `${exported} gate`).toBeGreaterThan(-1);
      expect(denied, `${exported} refusal`).toBeGreaterThan(gate);
      // The gate stands before the first service call, not after it.
      const firstCall = Math.min(
        ...['defineConditionType(', 'changeConditionType(', 'definePricingProcedure(', 'changePricingProcedure(',
          'addPricingProcedureStep(', 'changePricingProcedureStep(', 'defineProcedureDetermination(',
          'changeProcedureDetermination(']
          .map((service) => (body.indexOf(service) === -1 ? Number.MAX_SAFE_INTEGER : body.indexOf(service))),
      );
      expect(firstCall, `${exported} call`).toBeGreaterThan(gate);
    }
  });

  it('says which authority is missing, and that a wildcard does not grant it', () => {
    expect(actions).toContain('Ask an administrator for an exact-code role assignment');
    expect(actions).toContain('wildcard role patterns do not grant this authority');
    // A reader with no grant still sees the configuration: the screen is read-only, not absent.
    expect(page).toContain('Maintenance requires an explicit exact-code role grant for');
  });

  it('refuses a step the engine could not execute, at the moment it is written', () => {
    // A percentage step with no span has nothing to be calculated on.
    expect(maintenance).toContain('is calculated as a percentage, and step');
    expect(maintenance).toContain('names no span to calculate it on');
    // A header condition names no material, so it cannot read a cost from one.
    expect(maintenance).toContain('a header condition names no material to read it from');
    expect(engine).toContain('a header condition names no material to read it from');
    // Both ends of the span, or neither.
    expect(maintenance).toContain('names both ends of the span it is calculated on, or neither');
  });

  it('offers withdrawal rather than removal, and says what it does not do', () => {
    expect(setup).toContain('Withdraw the step');
    expect(setup).toContain('A withdrawn step is not executed and not deleted');
    expect(setup).toContain('A type carrying records or standing in a procedure is not withdrawn');
    // A withdrawn step is still listed: it is part of what the procedure once said.
    expect(maintenance).toContain('The withdrawn steps are listed too');
  });

  it('shows the fault where it was made, rather than where it surfaces', () => {
    // A determination naming a sales area that does not stand is the one that fails silently everywhere
    // else: no document in that area is priced, and the refusal names a procedure rather than the area.
    expect(maintenance).toContain('area_stands');
    expect(page).toContain('No — no document in that area is priced');
    expect(page).toContain('row.areaStands');
    // A procedure with no step that stands prices nothing, and the screen says so on the row.
    expect(page).toContain('No steps stand, so this procedure prices nothing');
  });

  it('names the screen in the remedy every pricing refusal offers', () => {
    for (const sentence of [
      'Maintain the procedure determination at ${PRICING_PROCEDURE_ROUTE}',
      'Maintain the steps of ${procedureCode} at ${PRICING_PROCEDURE_ROUTE}',
      'Name the span the step is calculated on at ${PRICING_PROCEDURE_ROUTE}',
    ]) {
      expect(engine, sentence).toContain(sentence);
    }
    for (const sentence of [
      'Define the condition type at ${PRICING_PROCEDURE_ROUTE} first',
      'Define the procedure at ${PRICING_PROCEDURE_ROUTE} first',
      'Add the step at ${PRICING_PROCEDURE_ROUTE} first',
    ]) {
      expect(maintenance, sentence).toContain(sentence);
    }
  });

  it('is reachable from the sales order that is priced by it', () => {
    // The order service is refused in the engine's words and refuses nothing of its own invention.
    const order = readFileSync('src/modules/sales/sales-order.ts', 'utf8');
    expect(order).toContain('PricingProcedureError');
    expect(order).toContain('priceDocument(');
    expect(order).toContain('writeDocumentConditions(');
  });
});
