/**
 * Demo phase D19_RELEASE: release strategies for every document category that carries one, and
 * documents standing in each state so the release flow can be worked through the UI.
 *
 * Configuration goes through the services the config screens use (characteristic, class, release
 * group, strategy). Documents are created after the strategies stand, so each is judged on creation.
 * Release acts are then given to a few of them; the rest are left waiting.
 *
 * | Category              | Strategy (value)                 | Steps          | Demo documents                               |
 * |-----------------------|----------------------------------|----------------|----------------------------------------------|
 * | Purchase order        | HIGH ≥ 8,000 / MID ≥ 5,000       | MGR,FIN / MGR  | released, pending, and under 5,000 unclaimed |
 * | Purchase requisition  | PR_STD ≥ 2,500                   | MGR            | 1 released, 2 pending, 1 unclaimed           |
 * | Purchase contract     | CT_STD ≥ 25,000                  | MGR,FIN        | 1 at step 1, 1 pending, 1 unclaimed          |
 * | Scheduling agreement  | SA_STD ≥ 15,000                  | MGR            | 1 released, 1 pending, 1 unclaimed           |
 * | Parked journal        | JE_HIGH ≥ 50,000 / JE_STD ≥ 10,000 | CTL,CFO / CTL | 1 released, 1 at step 1, 1 unclaimed       |
 * | Payment run           | RUN_STD ≥ 5,000                  | TRS            | 1 proposal waiting for release               |
 *
 * Finance documents are prepared by DEMO.ACCOUNTANT and released by DEMO.CONTROLLER: the person who
 * prepared a journal or a run cannot release it. Idempotent: configuration that stands is left alone,
 * documents are found by request key or by the category being empty, and release acts are only given
 * to a document that has not reached the step yet.
 */
import { and, asc, eq, sql } from 'drizzle-orm';

import { withTenant } from '../db/client';
import { saveCharacteristic, setCharacteristicStatus } from '../../modules/foundation/characteristic-definition';
import { saveClass, setClassStatus } from '../../modules/foundation/class-definition';
import {
  characteristic, classificationClass, releaseGroup, releaseStrategy,
} from '../../modules/foundation/characteristic-schema';
import {
  saveReleaseGroup, saveReleaseStrategy, setReleaseStrategyStatus,
} from '../../modules/foundation/release-strategy-definition';
import { createPurchaseContract } from '../../modules/purchasing/contract';
import { createRequisitionForProvisioning as createRequisition } from '../../modules/purchasing/requisitions';
import { createSchedulingAgreement } from '../../modules/purchasing/scheduling-agreement';
import { documentRelease, purchaseContract, purchaseOrder, purchaseRequisitionItem, schedulingAgreement } from '../../modules/purchasing/schema';
import {
  getDocumentRelease, orderAttributes, releaseDocumentForProvisioning as releaseDocument, syncDocumentRelease,
} from '../../modules/purchasing/release';
import { parkJournal, completeParkedJournal } from '../../modules/finance/parked-journal';
import { releaseParkedJournalForProvisioning as releaseParkedJournal } from '../../modules/finance/parked-journal-release';
import { createPaymentRun, generateProposal } from '../../modules/finance/payment-run';
import { paymentRun } from '../../modules/finance/schema';
import { DEMO_ACTOR, DEMO_STRUCTURE } from './demo-organisation';
import type { DemoTimeline } from './demo-provisioning';

const REASON = 'Demo release strategies';
// Usernames are stored upper case; a change trail naming anything else cannot be addressed.
const PREPARER = 'DEMO.ACCOUNTANT';
const RELEASER = 'DEMO.CONTROLLER';
const CURRENCY = 'KWD';

interface StrategyDef { code: string; description: string; priority: number; from: string; steps: string[] }
interface CategoryDef {
  category: string;
  group: string;
  groupDescription: string;
  codes: Array<{ code: string; description: string }>;
  className: string;
  classDescription: string;
  strategies: StrategyDef[];
}

const CATEGORIES: CategoryDef[] = [
  {
    category: 'PURCHASE_ORDER', group: 'PO', groupDescription: 'Purchase order releases',
    codes: [{ code: 'MGR', description: 'Purchasing manager' }, { code: 'FIN', description: 'Finance approver' }],
    className: 'PO_RELEASE', classDescription: 'Purchase order release',
    strategies: [
      { code: 'HIGH', description: 'High value orders', priority: 100, from: '8000', steps: ['MGR', 'FIN'] },
      { code: 'MID', description: 'Mid value orders', priority: 200, from: '5000', steps: ['MGR'] },
    ],
  },
  {
    category: 'PURCHASE_REQUISITION', group: 'PR', groupDescription: 'Purchase requisition releases',
    codes: [{ code: 'MGR', description: 'Purchasing manager' }],
    className: 'PR_RELEASE', classDescription: 'Purchase requisition release',
    strategies: [{ code: 'PR_STD', description: 'Requisitions from 2,500', priority: 100, from: '2500', steps: ['MGR'] }],
  },
  {
    category: 'PURCHASE_CONTRACT', group: 'CT', groupDescription: 'Purchase contract releases',
    codes: [{ code: 'MGR', description: 'Purchasing manager' }, { code: 'FIN', description: 'Finance approver' }],
    className: 'CT_RELEASE', classDescription: 'Purchase contract release',
    strategies: [{ code: 'CT_STD', description: 'Contracts from 25,000', priority: 100, from: '25000', steps: ['MGR', 'FIN'] }],
  },
  {
    category: 'SCHED_AGREEMENT', group: 'SA', groupDescription: 'Scheduling agreement releases',
    codes: [{ code: 'MGR', description: 'Purchasing manager' }],
    className: 'SA_RELEASE', classDescription: 'Scheduling agreement release',
    strategies: [{ code: 'SA_STD', description: 'Agreements from 15,000', priority: 100, from: '15000', steps: ['MGR'] }],
  },
  {
    category: 'JOURNAL_ENTRY', group: 'JE', groupDescription: 'Parked journal releases',
    codes: [{ code: 'CTL', description: 'Financial controller' }, { code: 'CFO', description: 'Finance director' }],
    className: 'JE_RELEASE', classDescription: 'Parked journal release',
    strategies: [
      { code: 'JE_HIGH', description: 'Journals from 50,000', priority: 100, from: '50000', steps: ['CTL', 'CFO'] },
      { code: 'JE_STD', description: 'Journals from 10,000', priority: 200, from: '10000', steps: ['CTL'] },
    ],
  },
  {
    category: 'PAYMENT_RUN', group: 'RUN', groupDescription: 'Payment run releases',
    codes: [{ code: 'TRS', description: 'Treasury approver' }],
    className: 'RUN_RELEASE', classDescription: 'Payment run release',
    strategies: [{ code: 'RUN_STD', description: 'Runs from 5,000', priority: 100, from: '5000', steps: ['TRS'] }],
  },
];

export interface DemoReleaseResult {
  strategies: number;
  documents: number;
  released: number;
  pending: number;
}

/** The configuration of every category: characteristic, class, group, strategies. */
async function ensureConfiguration(client: string, actor: string): Promise<number> {
  const base = { client, changedBy: actor, reason: REASON };
  const [char] = await withTenant(client, (tx) => tx.select().from(characteristic).where(and(
    eq(characteristic.client, client), eq(characteristic.characteristicName, 'TOTAL_VALUE'))));
  if (!char) {
    await saveCharacteristic({
      ...base, mode: 'CREATE', characteristicName: 'TOTAL_VALUE', description: 'Total document value',
      dataFormat: 'NUM', valueLength: 13, decimalPlaces: 2, unit: '', currency: '',
      negativeValuesAllowed: false, caseSensitive: false, intervalsAllowed: false,
      additionalValuesAllowed: true, valueAssignment: 'SINGLE', requiredEntry: false, values: [],
    });
  }
  if (!char || char.lifecycleStatus !== 'ACTIVE') {
    await setCharacteristicStatus({ ...base, characteristicName: 'TOTAL_VALUE', status: 'ACTIVE' });
  }

  let strategies = 0;
  for (const def of CATEGORIES) {
    const [clazz, group, standing] = await withTenant(client, async (tx) => [
      (await tx.select().from(classificationClass).where(and(
        eq(classificationClass.client, client), eq(classificationClass.classType, def.category),
        eq(classificationClass.className, def.className)))).at(0),
      (await tx.select().from(releaseGroup).where(and(
        eq(releaseGroup.client, client), eq(releaseGroup.groupCode, def.group)))).at(0),
      await tx.select().from(releaseStrategy).where(and(
        eq(releaseStrategy.client, client), eq(releaseStrategy.groupCode, def.group))),
    ] as const);
    if (!clazz) {
      await saveClass({
        ...base, mode: 'CREATE', classType: def.category, className: def.className,
        description: def.classDescription,
        assignments: [{ characteristicName: 'TOTAL_VALUE', requiredForClassification: false }],
      });
    }
    if (!clazz || clazz.lifecycleStatus !== 'ACTIVE') {
      await setClassStatus({ ...base, classType: def.category, className: def.className, status: 'ACTIVE' });
    }
    if (!group) {
      await saveReleaseGroup({
        ...base, mode: 'CREATE', groupCode: def.group, documentCategory: def.category,
        description: def.groupDescription, codes: def.codes,
      });
    }
    for (const strategy of def.strategies) {
      const existing = standing.find((s) => s.strategyCode === strategy.code);
      if (!existing) {
        await saveReleaseStrategy({
          ...base, mode: 'CREATE', groupCode: def.group, strategyCode: strategy.code,
          description: strategy.description, className: def.className, priority: strategy.priority,
          steps: strategy.steps,
          criteria: [{ characteristicName: 'TOTAL_VALUE', operator: 'GE', valueFrom: strategy.from, valueTo: '' }],
        });
      }
      if (!existing || existing.lifecycleStatus !== 'ACTIVE') {
        await setReleaseStrategyStatus({ ...base, groupCode: def.group, strategyCode: strategy.code, status: 'ACTIVE' });
      }
      strategies += 1;
    }
  }
  return strategies;
}

/** Give release acts until the document stands at `through` steps (or is fully released). */
async function releaseThrough(
  client: string, category: string, number: string, through: number,
  act: (releaseCode: string) => Promise<unknown>,
): Promise<void> {
  for (;;) {
    const state = await getDocumentRelease(client, category, number);
    if (state.status !== 'PENDING' || state.currentStep >= through) return;
    await act(state.steps[state.currentStep]);
  }
}

const KG = 'KG';
const PC = 'PC';
const addDays = (date: string, days: number) => {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};

async function isEmpty(client: string, table: 'requisition' | 'contract' | 'agreement'): Promise<boolean> {
  return withTenant(client, async (tx) => {
    const rows = table === 'requisition'
      ? await tx.select({ n: purchaseRequisitionItem.requisitionNumber }).from(purchaseRequisitionItem).where(eq(purchaseRequisitionItem.client, client)).limit(1)
      : table === 'contract'
        ? await tx.select({ n: purchaseContract.contractNumber }).from(purchaseContract).where(eq(purchaseContract.client, client)).limit(1)
        : await tx.select({ n: schedulingAgreement.agreementNumber }).from(schedulingAgreement).where(eq(schedulingAgreement.client, client)).limit(1);
    return rows.length === 0;
  });
}

async function seedPurchasingDocuments(client: string, actor: string, today: string): Promise<void> {
  const release = (category: string, number: string, through: number) => releaseThrough(
    client, category, number, through,
    (releaseCode) => releaseDocument({ client, changedBy: actor, documentCategory: category, documentNumber: number, releaseCode }),
  );
  const year = today.slice(0, 4);
  const validity = { validityStart: `${year}-01-01`, validityEnd: `${year}-12-31` };
  const header = { purchasingOrg: DEMO_STRUCTURE.purchasingOrg, purchasingGroup: '001', companyCode: DEMO_STRUCTURE.companyCode, currency: CURRENCY };

  if (await isEmpty(client, 'requisition')) {
    const requisition = (material: string, unit: string, quantity: number, price: number) => createRequisition({
      client, changedBy: actor,
      items: [{
        materialNumber: material, quantity, unit, deliveryDate: addDays(today, 21),
        plant: DEMO_STRUCTURE.manufacturingPlant, purchasingGroup: '001', estimatedPrice: price, priceUnit: 1, currency: CURRENCY,
      }],
    });
    await requisition('PACK-WRAP', PC, 500, 1.2); // 600: no strategy claims it
    const released = await requisition('RAW-SUGAR', KG, 4000, 0.8); // 3,200
    await requisition('RAW-FAT', KG, 12000, 0.8); // 9,600, waits
    await requisition('PACK-CARTON', PC, 3000, 1); // 3,000, waits
    await release('PURCHASE_REQUISITION', released.requisitionNumber, 1);
  }

  if (await isEmpty(client, 'contract')) {
    const contract = (supplier: string, material: string, unit: string, quantity: number, price: number) => createPurchaseContract({
      client, changedBy: actor, documentType: 'MK', supplierNumber: supplier, ...header, ...validity,
      items: [{ materialNumber: material, targetQuantity: quantity, unit, netPrice: price }],
    });
    const started = await contract('SUP-1000', 'RAW-FLOUR', KG, 100000, 0.4); // 40,000: MGR then FIN
    await contract('SUP-3000', 'PACK-CARTON', PC, 60000, 0.5); // 30,000, waits at step 1
    await contract('SUP-1000', 'RAW-SUGAR', KG, 10000, 0.5); // 5,000: no strategy claims it
    await release('PURCHASE_CONTRACT', started.contractNumber, 1);
  }

  if (await isEmpty(client, 'agreement')) {
    const agreement = (supplier: string, material: string, unit: string, quantity: number, price: number) => createSchedulingAgreement({
      client, changedBy: actor, documentType: 'LP', supplierNumber: supplier, ...header, ...validity,
      items: [{ materialNumber: material, targetQuantity: quantity, unit, netPrice: price, plant: DEMO_STRUCTURE.manufacturingPlant }],
    });
    const released = await agreement('SUP-2000', 'RAW-FAT', KG, 20000, 1); // 20,000
    await agreement('SUP-3000', 'PACK-WRAP', PC, 30000, 0.6); // 18,000, waits
    await agreement('SUP-1000', 'RAW-COCOA', KG, 2000, 2); // 4,000: no strategy claims it
    await release('SCHED_AGREEMENT', released.agreementNumber, 1);
  }
}

async function seedJournals(client: string, postingDate: string): Promise<void> {
  const park = (key: string, text: string, expense: string, liability: string, amount: number) => parkJournal({
    client, changedBy: PREPARER, requestKey: `demo-release-${key}`,
    companyCode: DEMO_STRUCTURE.companyCode, documentDate: postingDate, postingDate, documentType: 'SA', currency: CURRENCY,
    headerText: text,
    lines: [
      { glAccount: expense, debitCredit: 'S', amount, costCenter: 'CC3000' },
      { glAccount: liability, debitCredit: 'H', amount },
    ],
  });
  const small = await park('j1', 'Utilities accrual', '510100', '230200', 1200);
  const standard = await park('j2', 'Quarter rent accrual', '510000', '230000', 25000);
  const high = await park('j3', 'Annual insurance accrual', '550000', '230000', 60000);
  for (const view of [small, standard, high]) {
    await completeParkedJournal({ client, changedBy: PREPARER, parkedNumber: view.parkedNumber });
  }
  const act = (number: string) => (releaseCode: string) => releaseParkedJournal({
    client, changedBy: RELEASER, parkedNumber: number, releaseCode,
  });
  await releaseThrough(client, 'JOURNAL_ENTRY', standard.parkedNumber, 1, act(standard.parkedNumber));
  await releaseThrough(client, 'JOURNAL_ENTRY', high.parkedNumber, 1, act(high.parkedNumber));
}

async function seedPaymentRun(client: string, today: string): Promise<void> {
  const [standing] = await withTenant(client, (tx) => tx.select().from(paymentRun).where(and(
    eq(paymentRun.client, client), eq(paymentRun.runId, 'DEMO1'))).limit(1));
  if (standing) return;
  await withTenant(client, async (tx) => {
    await tx.execute(sql`
      insert into payment_method (client, country, method_code, description, allowed_direction, created_by)
      select ${client}, c.country, m.code, m.description, 'OUTGOING', ${DEMO_ACTOR}
        from company_code c
        cross join (values ('T', 'Bank transfer'), ('C', 'Cheque')) as m(code, description)
       where c.client = ${client} and c.company_code = ${DEMO_STRUCTURE.companyCode}
      on conflict do nothing
    `);
  });
  await createPaymentRun({
    client, changedBy: PREPARER, runDate: today, runId: 'DEMO1',
    postingDate: today, documentCutoffDate: today, nextPaymentDate: addDays(today, 30),
    companies: [{ companyCode: DEMO_STRUCTURE.companyCode, payingCompanyCode: DEMO_STRUCTURE.companyCode }],
    methods: ['T'],
  });
  await generateProposal({ client, changedBy: PREPARER, runDate: today, runId: 'DEMO1' });
}

/** Determine the purchase orders that stand, then release some of the claimed ones. */
async function seedOrders(client: string, actor: string): Promise<void> {
  const fresh = await withTenant(client, async (tx) => {
    const numbers = (await tx.select({ n: purchaseOrder.orderNumber }).from(purchaseOrder)
      .where(eq(purchaseOrder.client, client)).orderBy(asc(purchaseOrder.orderNumber))).map((r) => r.n);
    const held = new Set((await tx.select({ n: documentRelease.documentNumber }).from(documentRelease).where(and(
      eq(documentRelease.client, client), eq(documentRelease.documentCategory, 'PURCHASE_ORDER')))).map((r) => r.n));
    const added: string[] = [];
    for (const number of numbers) {
      if (held.has(number)) continue;
      await syncDocumentRelease(tx, client, 'PURCHASE_ORDER', number, await orderAttributes(tx, client, number), actor);
      added.push(number);
    }
    return added;
  });
  let mid = 0;
  let high = false;
  for (const number of fresh) {
    const state = await getDocumentRelease(client, 'PURCHASE_ORDER', number);
    if (state.status !== 'PENDING') continue;
    const act = (releaseCode: string) => releaseDocument({
      client, changedBy: actor, documentCategory: 'PURCHASE_ORDER', documentNumber: number, releaseCode,
    });
    if (state.strategyCode === 'HIGH' && !high) {
      await act('MGR');
      high = true;
    } else if (state.strategyCode === 'MID' && mid < 4) {
      await act('MGR');
      mid += 1;
    }
  }
}

export async function ensureDemoRelease(
  client: string, actor: string, dates: { today: string; postingDate: string },
): Promise<DemoReleaseResult> {
  const strategies = await ensureConfiguration(client, actor);
  await seedOrders(client, actor);
  await seedPurchasingDocuments(client, actor, dates.today);
  await seedJournals(client, dates.postingDate);
  await seedPaymentRun(client, dates.today);

  const rows = await withTenant(client, (tx) => tx.select().from(documentRelease).where(eq(documentRelease.client, client)));
  return {
    strategies,
    documents: rows.length,
    released: rows.filter((r) => r.status === 'RELEASED').length,
    pending: rows.filter((r) => r.status === 'PENDING').length,
  };
}

/** Phase D19_RELEASE. Journals post on the last day of the last open period the dataset may write to. */
export async function buildDemoRelease(input: { client: string; timeline: DemoTimeline }): Promise<DemoReleaseResult> {
  return ensureDemoRelease(input.client, DEMO_ACTOR, {
    today: input.timeline.endDate,
    postingDate: input.timeline.endDate,
  });
}
