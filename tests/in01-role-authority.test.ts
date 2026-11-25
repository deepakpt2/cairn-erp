import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { loadFixtures } from '../src/platform/tenancy/in01-fixtures';
import { hasCapability } from '../src/platform/auth/pattern';

/**
 * Every authority the UAT guide's Phase 3 and Phase 4 steps ask for, held by the account the
 * guide names to do them.
 *
 * This is the guard ID-003 lacked. The demo warehouse clerks could ship a delivery but not pick
 * one, because `1819f764` added `SALES.DELIVERY.PICK` to the service and the role definition
 * never followed. Nothing failed until an installer ran into it at D3_SALES. The India UAT roles
 * are built from the same fixture the demo now reads, so the same class of drift would stop a
 * tester mid-guide rather than an installer mid-run.
 *
 * The step table is transcribed from `docs/uat-india/05-uat-guide.md`: section, the account the
 * guide says does the work, and the authority the service actually checks — read out of
 * `src/modules`, not guessed. `needsPlant` is the second half of the same question: several sales
 * services call `verifyServiceAuthorityInTx` without `requirePlantScope: false`, which fails closed
 * for an actor holding no Plant grant, so a capability alone is not enough.
 *
 * Display and report steps are here too. A tester who can post but cannot read the trial balance
 * is stuck at 4.6 just as surely as one who lacks a posting authority.
 */

const FIXTURES = join(process.cwd(), 'fixtures');

interface Step {
  /** Section of `05-uat-guide.md`. */
  section: string;
  /** The account the guide assigns. */
  user: string;
  /** The authority the service checks. */
  capability: string;
  /** The service also requires a Plant grant, and fails closed without one. */
  needsPlant?: boolean;
  /** What the step does, for the failure message. */
  what: string;
}

/**
 * Phase 3 and Phase 4, one entry per authority a step asks for.
 *
 * A step that needs several authorities has several rows: a tester who holds the pick but not the
 * goods issue still cannot complete 3.3.3.
 */
const STEPS: readonly Step[] = [
  // ── 3.1 Procure to pay ──────────────────────────────────────────────────────
  { section: '3.1.1', user: 'in01.buyer', capability: 'PROC.PR.CREATE', what: 'raise the requisition' },
  { section: '3.1.1', user: 'in01.buyer', capability: 'PROC.PR.RELEASE', what: 'release the requisition' },
  { section: '3.1.2', user: 'in01.buyer', capability: 'PROC.PO.CREATE', what: 'raise the purchase order' },
  { section: '3.1.2', user: 'in01.buyer', capability: 'PROC.PO.RELEASE', what: 'release the purchase order' },
  { section: '3.1.3', user: 'in01.storekeeper', capability: 'INV.GR.POST', needsPlant: true, what: 'post the goods receipt' },
  { section: '3.1.4', user: 'in01.ap', capability: 'PROC.INV.RECORD', what: 'record the supplier invoice' },
  { section: '3.1.5', user: 'in01.ap', capability: 'FIN.AP.PAYMENT.POST', what: 'pay the supplier' },
  // 3.1.6: the inspector decides, the storekeeper returns.
  { section: '3.1.6', user: 'in01.qc', capability: 'QM.LOT.CREATE', needsPlant: true, what: 'create the inspection lot' },
  { section: '3.1.6', user: 'in01.qc', capability: 'QM.INSPECTION.RECORD', needsPlant: true, what: 'record the inspection result' },
  { section: '3.1.6', user: 'in01.qc', capability: 'QM.USAGE.DECIDE', needsPlant: true, what: 'take the rejection decision' },
  { section: '3.1.6', user: 'in01.qc', capability: 'QM.STOCK.POST', needsPlant: true, what: 'move the rejected stock to blocked' },
  // The vendor return is screen-guarded only (`can(session, INV.RETURN.POST)`); the service posts
  // without judging a plant, so no Plant grant is required of this step.
  { section: '3.1.6', user: 'in01.storekeeper', capability: 'INV.RETURN.POST', what: 'return the goods to the vendor' },

  // ── 3.2 Production ──────────────────────────────────────────────────────────
  { section: '3.2.1', user: 'in01.planner', capability: 'PROD.MRP.RUN', what: 'run MRP' },
  { section: '3.2.2', user: 'in01.planner', capability: 'PROD.ORDER.CREATE', what: 'raise the production order' },
  { section: '3.2.2', user: 'in01.planner', capability: 'PROD.ORDER.RELEASE', what: 'release the production order' },
  { section: '3.2.2', user: 'in01.supervisor', capability: 'PROD.ORDER.GI', needsPlant: true, what: 'issue the components' },
  { section: '3.2.2', user: 'in01.supervisor', capability: 'INV.GI.POST', needsPlant: true, what: 'post the component issue movement' },
  { section: '3.2.3', user: 'in01.supervisor', capability: 'PROD.CONFIRM.ORDER', needsPlant: true, what: 'confirm the operation' },
  { section: '3.2.4', user: 'in01.supervisor', capability: 'PROD.ORDER.GR', needsPlant: true, what: 'receive the finished goods' },
  { section: '3.2.4', user: 'in01.qc', capability: 'QM.INSPECTION.RECORD', needsPlant: true, what: 'inspect the finished goods' },
  { section: '3.2.5', user: 'in01.controller', capability: 'PROD.ORDER.SETTLE', what: 'display the order settlement' },

  // ── 3.3 Order to cash ───────────────────────────────────────────────────────
  { section: '3.3.1', user: 'in01.sales', capability: 'SALES.QUOTATION.CREATE', needsPlant: true, what: 'raise the quotation' },
  { section: '3.3.2', user: 'in01.sales', capability: 'SALES.ORDER.CREATE', needsPlant: true, what: 'raise the sales order' },
  { section: '3.3.2', user: 'in01.sales', capability: 'SALES.ORDER.RELEASE', needsPlant: true, what: 'release the credit-held order' },
  { section: '3.3.3', user: 'in01.sales', capability: 'SALES.DELIVERY.CREATE', needsPlant: true, what: 'create the delivery' },
  { section: '3.3.3', user: 'in01.dispatch', capability: 'SALES.DELIVERY.PICK', what: 'pick the delivery' },
  { section: '3.3.3', user: 'in01.dispatch', capability: 'SALES.GI.POST', needsPlant: true, what: 'post the goods issue' },
  { section: '3.3.4', user: 'in01.sales', capability: 'SALES.BILLING.CREATE', needsPlant: true, what: 'bill the delivery' },
  { section: '3.3.5', user: 'in01.ar', capability: 'FIN.AR.PAYMENT.ENTER', what: 'receive the customer payment' },
  { section: '3.3.6', user: 'in01.sales', capability: 'SALES.RETURNS.ORDER.CREATE', what: 'raise the returns order' },
  { section: '3.3.6', user: 'in01.storekeeper', capability: 'SALES.RETURNS.RECEIPT.POST', what: 'receive the goods back' },

  // ── 3.4 Import: the same three roles, one foreign order ─────────────────────
  { section: '3.4', user: 'in01.buyer', capability: 'PROC.PO.CREATE', what: 'raise the import order' },
  { section: '3.4', user: 'in01.storekeeper', capability: 'INV.GR.POST', needsPlant: true, what: 'receive the import' },
  { section: '3.4', user: 'in01.ap', capability: 'PROC.INV.RECORD', what: 'record the import invoice' },
  { section: '3.4', user: 'in01.ap', capability: 'FIN.AP.PAYMENT.POST', what: 'pay the import invoice' },

  // ── 3.5 HR and payroll ──────────────────────────────────────────────────────
  { section: '3.5', user: 'in01.hr', capability: 'PEOPLE.TIME.ENTER', what: 'enter the attendance' },
  { section: '3.5', user: 'in01.admin', capability: 'PEOPLE.PAYROLLRUN.EXECUTE', what: 'run the payroll' },
  { section: '3.5', user: 'in01.admin', capability: 'PEOPLE.PAYROLL.POST', what: 'post the payroll' },
  { section: '4.8', user: 'in01.admin', capability: 'PEOPLE.PAYROLL.RESULT', what: 'read the payroll results' },

  // ── Phase 4 Month-end close ─────────────────────────────────────────────────
  { section: '4.1', user: 'in01.controller', capability: 'PROC.GRIR.MAINTAIN.POST', what: 'clear GR/IR' },
  { section: '4.2', user: 'in01.controller', capability: 'FIN.ASSET.DEPRECIATE', what: 'run depreciation' },
  { section: '4.2', user: 'in01.controller', capability: 'FIN.JOURNAL.POST', what: 'post the depreciation journal' },
  { section: '4.3', user: 'in01.ap', capability: 'FIN.ACCRUAL.POST', what: 'post the accruals' },
  { section: '4.4', user: 'in01.controller', capability: 'CFG.COST.ALLOCATION.DEFINE', what: 'define the allocation cycle' },
  { section: '4.4', user: 'in01.controller', capability: 'CO.ASSESSMENT.EXECUTE', what: 'run the assessment' },
  { section: '4.6', user: 'in01.controller', capability: 'FIN.CLOSE.COCKPIT', what: 'work the close cockpit' },
  { section: '4.6', user: 'in01.controller', capability: 'FIN.RPT.TRIALBALANCE', what: 'read the trial balance' },
  { section: '4.6', user: 'in01.controller', capability: 'FIN.RPT.PROFITLOSS', what: 'read the P&L' },
  { section: '4.6', user: 'in01.controller', capability: 'FIN.RPT.BALANCESHEET', what: 'read the balance sheet' },
  { section: '4.7', user: 'in01.ap', capability: 'FIN.TAX.REPORT', what: 'file the GST summary' },
];

function fixtures() {
  return loadFixtures({ countryCode: 'IN', companyKey: 'IN01', root: FIXTURES });
}

describe('IN01 roles hold every authority a Phase 3/4 step needs', () => {
  it('grants the authority the guide\'s step asks for, to the account it names', () => {
    // Read the fixture the installer builds from, not a copy: this is what the tenant will hold.
    const { core, company } = fixtures();
    const roles = new Map(core.roles.map((role) => [role.code, role.capabilities]));
    const accounts = new Map(company.users.map((user) => [user.username, user]));

    const failures: string[] = [];
    for (const step of STEPS) {
      const account = accounts.get(step.user);
      if (!account) {
        failures.push(`${step.section} ${step.user}: no such account`);
        continue;
      }
      // `in01.admin` is the tenant ADMINISTRATOR, whose pattern is `*`: it holds everything the
      // catalogue carries, so it needs no row in the twelve custom roles.
      if (account.role === 'ADMINISTRATOR' || account.role === 'PLATFORM_ADMIN') continue;
      const capabilities = roles.get(account.role);
      if (!capabilities) {
        failures.push(`${step.section} ${step.user}: role ${account.role} is not defined`);
        continue;
      }
      if (!hasCapability(capabilities, step.capability)) {
        failures.push(
          `${step.section} ${step.user} (${account.role}) cannot ${step.what}: lacks ${step.capability}`,
        );
      }
      // The service fails closed without a Plant grant when it judges one.
      if (step.needsPlant && !(account.plants ?? []).length) {
        failures.push(
          `${step.section} ${step.user} (${account.role}) cannot ${step.what}: no Plant scope, and the service requires one`,
        );
      }
    }

    expect(failures, `\n  ${failures.join('\n  ')}\n`).toEqual([]);
  });

  it('reaches every plant the guide ships from', () => {
    // 3.3.3 delivers from plant 2000 and 3.1.3 receives into 1000. An account scoped to the wrong
    // plant is refused for want of a scope, which reads as a missing document rather than a
    // missing grant — the failure a tester would report as "it says the delivery does not exist".
    const { company } = fixtures();
    const plants = new Map(company.users.map((user) => [user.username, user.plants ?? []]));
    expect(plants.get('in01.sales')).toEqual(expect.arrayContaining(['1000', '2000']));
    expect(plants.get('in01.dispatch')).toContain('2000');
    expect(plants.get('in01.storekeeper')).toContain('1000');
    expect(plants.get('in01.supervisor')).toContain('1000');
    expect(plants.get('in01.planner')).toContain('1000');
    expect(plants.get('in01.qc')).toContain('1000');
  });

  it('keeps the controller out of raising and receiving documents', () => {
    // The owner's constraint: the six authorities added for Phase 4 must not turn the controller
    // into a second buyer or a second storekeeper. These are the ones a settlement, a close and a
    // depreciation run must never imply.
    const { core } = fixtures();
    const controller = core.roles.find((role) => role.code === 'DEMO_CONTROLLER')!;
    for (const forbidden of [
      'PROC.PO.CREATE', 'PROC.PR.CREATE', 'PROC.INV.RECORD',
      'INV.GR.POST', 'INV.GI.POST', 'INV.RETURN.POST',
      'SALES.ORDER.CREATE', 'SALES.DELIVERY.CREATE', 'SALES.GI.POST', 'SALES.BILLING.CREATE',
      'PEOPLE.PAYROLL.POST',
    ]) {
      expect(hasCapability(controller.capabilities, forbidden), `controller must not hold ${forbidden}`).toBe(false);
    }
  });

  it('separates preparing from releasing by person, not by role', () => {
    // Segregation of duties, as the product actually enforces it: `releaseDocument` refuses a
    // releaser who is the document's preparer (`release.ts`, "was prepared by you; you cannot
    // release it"). It is a person-level rule, so `FIN.*` on the accountant — which includes
    // FIN.JOURNAL.RELEASE — is not a breach: the person who parked the journal still cannot release
    // it, and the demo's D19_RELEASE depends on exactly that.
    const release = readFileSync(join(process.cwd(), 'src/modules/purchasing/release.ts'), 'utf8');
    expect(release).toContain('was prepared by you; you cannot release it');
    expect(release).toContain('input.preparedBy');

    // What the accountant must not hold is the authority to do the other person's *job*: posting
    // what it does not own, or moving stock. Those are not release acts and no person-level rule
    // covers them.
    const { core } = fixtures();
    const accountant = core.roles.find((role) => role.code === 'DEMO_ACCOUNTANT')!;
    for (const forbidden of ['INV.GR.POST', 'INV.GI.POST', 'INV.RETURN.POST', 'SALES.GI.POST', 'PROC.PO.CREATE', 'SALES.ORDER.CREATE']) {
      expect(hasCapability(accountant.capabilities, forbidden), `accountant must not hold ${forbidden}`).toBe(false);
    }
  });
});

describe('the twelve custom roles are defined once', () => {
  it('has no second copy of the role definitions in the demo module', () => {
    // The defect behind ID-003: two lists, one edited, one not. The demo reads the fixture, so a
    // `capabilities: [` block in the module is the drift coming back.
    const source = readFileSync(join(process.cwd(), 'src/platform/tenancy/demo-people.ts'), 'utf8');
    expect(source).not.toMatch(/code:\s*'DEMO_[A-Z_]+',\s*\n\s*name:/);
    expect(source).toContain("'core', 'organisation.json'");
  });

  it('names the same twelve roles the installer builds', () => {
    const { core } = fixtures();
    const codes = core.roles.map((role) => role.code).sort();
    expect(new Set(codes).size).toBe(codes.length);
    expect(codes.length).toBe(12);
    for (const code of codes) expect(code).toMatch(/^DEMO_/);
  });

  it('states every role\'s authority in the fixture, and only real capabilities', () => {
    // A pattern that matches nothing in the catalogue is a silent no-op: the role is created and
    // holds less than the fixture claims. Wildcards are checked by resolving them against the
    // capability table the migrations build, which is the same thing `expandCapabilities` does.
    const sql = readFileSync(join(process.cwd(), 'drizzle/0000_baseline.sql'), 'utf8');
    const { core } = fixtures();
    const granted = new Set<string>();
    for (const role of core.roles) {
      expect(role.capabilities.length, `${role.code} holds nothing`).toBeGreaterThan(0);
      // What the installer would actually grant for each pattern.
      const expanded = [...sql.matchAll(/INSERT INTO public\.capability VALUES \('([A-Z0-9._]+)'/g)]
        .map((match) => match[1]!)
        .filter((code) => role.capabilities.some((pattern) => hasCapability([pattern], code)));
      expect(expanded.length, `${role.code}'s patterns match no capability`).toBeGreaterThan(0);
      for (const code of expanded) granted.add(code);
    }
    // Spot-check the authorities the guide's steps depend on are real, not invented here.
    for (const required of ['SALES.DELIVERY.PICK', 'PROC.INV.RECORD', 'FIN.CLOSE.COCKPIT', 'FIN.JOURNAL.POST']) {
      expect(granted.has(required), `${required} is held by no role`).toBe(true);
    }
  });
});
