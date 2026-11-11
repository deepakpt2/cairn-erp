import { and, asc, eq, inArray, sql } from 'drizzle-orm';

import type { OrgScope } from '@/platform/auth/authority';
import type { AuthoritySubject } from '@/platform/auth/authority';
import { t } from '@/platform/i18n';
import { withTenant } from '@/platform/db/client';

import {
  billingDueList, BILLING_CAPABILITY, BILLING_ROUTE,
} from '@/modules/sales/billing';
import {
  listCreditMemoRequests, CREDIT_MEMO_RELEASE_CAPABILITY, CREDIT_MEMO_ROUTE,
} from '@/modules/sales/credit-memo';
import {
  DELIVERY_CAPABILITY, DELIVERY_GOODS_ISSUE_CAPABILITY, DELIVERY_PICK_CAPABILITY,
  DELIVERY_ROUTE, listDeliverableOrderLines, listDeliveries,
} from '@/modules/sales/delivery';
import {
  INCOMPLETION_PROCESS_CAPABILITY, INCOMPLETION_WORKLIST_ROUTE, listIncompleteDocuments,
} from '@/modules/sales/incompletion';
import {
  INVOICE_LIST_CREATE_CAPABILITY, INVOICE_LIST_ROUTE, invoiceListDueDocuments,
} from '@/modules/sales/invoice-list';

import {
  documentRelease, purchaseContract, purchaseOrder, purchaseRequisitionItem,
  schedulingAgreement,
} from '@/modules/purchasing/schema';
import { RELEASE_CAPABILITIES } from '@/modules/purchasing/release';
import { releaseStrategyStep } from '@/modules/foundation/characteristic-schema';

import type { AttentionRow, AttentionSource } from './types';

/**
 * How many rows one source may read. The panel is on the home page and is read
 * on every visit, so no source may read a whole tenant.
 */
export const ATTENTION_QUERY_LIMIT = 200;

// ─────────────────────────────────────────────────────────────────────────────
// Purchasing — the four release queues
// ─────────────────────────────────────────────────────────────────────────────

/** The four document categories that carry a release, and where each one lives. */
const RELEASE_KINDS = [
  {
    category: 'PURCHASE_REQUISITION',
    capability: RELEASE_CAPABILITIES.PURCHASE_REQUISITION,
    label: 'attention.source.prRelease',
    noun: 'attention.noun.requisition',
    route: '/purchasing/requisitions?req=',
  },
  {
    category: 'PURCHASE_ORDER',
    capability: RELEASE_CAPABILITIES.PURCHASE_ORDER,
    label: 'attention.source.poRelease',
    noun: 'attention.noun.purchaseOrder',
    route: '/purchasing/orders?order=',
  },
  {
    category: 'PURCHASE_CONTRACT',
    capability: RELEASE_CAPABILITIES.PURCHASE_CONTRACT,
    label: 'attention.source.contractRelease',
    noun: 'attention.noun.contract',
    route: '/purchasing/contracts?contract=',
  },
  {
    category: 'SCHED_AGREEMENT',
    capability: RELEASE_CAPABILITIES.SCHED_AGREEMENT,
    label: 'attention.source.schedAgreeRelease',
    noun: 'attention.noun.agreement',
    route: '/purchasing/scheduling-agreements?agreement=',
  },
] as const;

/**
 * The organisational places a set of purchasing documents sits in, per document.
 *
 * A purchase requisition's plant lives on its items and not on a header, so one
 * requisition can name several. That is not an edge case to be flattened — a
 * requisition spanning two plants is real work for a manager holding either.
 */
async function purchasingOrgsFor(
  tx: Parameters<Parameters<typeof withTenant>[1]>[0],
  client: string,
  category: string,
  numbers: string[],
): Promise<Map<string, OrgScope[]>> {
  const out = new Map<string, OrgScope[]>();
  const entries: Array<[string, OrgScope]> = [];

  if (category === 'PURCHASE_REQUISITION') {
    const rows = await tx.select({
      number: purchaseRequisitionItem.requisitionNumber,
      plant: purchaseRequisitionItem.plant,
      purchasingGroup: purchaseRequisitionItem.purchasingGroup,
    }).from(purchaseRequisitionItem).where(and(
      eq(purchaseRequisitionItem.client, client),
      inArray(purchaseRequisitionItem.requisitionNumber, numbers),
    ));
    for (const row of rows) {
      entries.push([row.number, { plant: row.plant, purchasingGroup: row.purchasingGroup }]);
    }
  } else if (category === 'PURCHASE_ORDER') {
    const rows = await tx.select({
      number: purchaseOrder.orderNumber,
      purchasingOrg: purchaseOrder.purchasingOrg,
      purchasingGroup: purchaseOrder.purchasingGroup,
      companyCode: purchaseOrder.companyCode,
    }).from(purchaseOrder).where(and(
      eq(purchaseOrder.client, client),
      inArray(purchaseOrder.orderNumber, numbers),
    ));
    for (const row of rows) {
      entries.push([row.number, {
        purchasingOrg: row.purchasingOrg,
        purchasingGroup: row.purchasingGroup,
        companyCode: row.companyCode,
      }]);
    }
  } else if (category === 'PURCHASE_CONTRACT') {
    const rows = await tx.select({
      number: purchaseContract.contractNumber,
      purchasingOrg: purchaseContract.purchasingOrg,
      purchasingGroup: purchaseContract.purchasingGroup,
      companyCode: purchaseContract.companyCode,
    }).from(purchaseContract).where(and(
      eq(purchaseContract.client, client),
      inArray(purchaseContract.contractNumber, numbers),
    ));
    for (const row of rows) {
      entries.push([row.number, {
        purchasingOrg: row.purchasingOrg,
        purchasingGroup: row.purchasingGroup,
        companyCode: row.companyCode,
      }]);
    }
  } else {
    const rows = await tx.select({
      number: schedulingAgreement.agreementNumber,
      purchasingOrg: schedulingAgreement.purchasingOrg,
      purchasingGroup: schedulingAgreement.purchasingGroup,
      companyCode: schedulingAgreement.companyCode,
    }).from(schedulingAgreement).where(and(
      eq(schedulingAgreement.client, client),
      inArray(schedulingAgreement.agreementNumber, numbers),
    ));
    for (const row of rows) {
      entries.push([row.number, {
        purchasingOrg: row.purchasingOrg,
        purchasingGroup: row.purchasingGroup,
        companyCode: row.companyCode,
      }]);
    }
  }

  // One entry per document, with every place it names. Duplicates collapse —
  // two items in the same plant are one answer to "where can this be released".
  for (const [number, org] of entries) {
    const seen = out.get(number) ?? [];
    if (!seen.some((known) => sameOrg(known, org))) seen.push(org);
    out.set(number, seen);
  }
  return out;
}

function sameOrg(a: OrgScope, b: OrgScope): boolean {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]) as Set<keyof OrgScope>;
  for (const key of keys) if (a[key] !== b[key]) return false;
  return true;
}

/** A `timestamptz` answers to a plain `YYYY-MM-DD`. */
function isoDate(value: Date | string | null | undefined): string {
  if (value == null) return '';
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value).slice(0, 10);
}

const releaseSources: AttentionSource[] = RELEASE_KINDS.map((kind) => ({
  code: kind.capability,
  label: kind.label,
  async due(who: AuthoritySubject): Promise<AttentionRow[]> {
    return withTenant(who.client, async (tx) => {
      const pending = await tx.select({
        number: documentRelease.documentNumber,
        groupCode: documentRelease.groupCode,
        strategyCode: documentRelease.strategyCode,
        currentStep: documentRelease.currentStep,
        waitingSince: documentRelease.createdAt,
      }).from(documentRelease).where(and(
        eq(documentRelease.client, who.client),
        eq(documentRelease.documentCategory, kind.category),
        eq(documentRelease.status, 'PENDING'),
      )).orderBy(asc(documentRelease.createdAt)).limit(ATTENTION_QUERY_LIMIT);

      if (pending.length === 0) return [];

      // How many approvals the strategy asks for, batched rather than one query
      // a document: the panel is on the home page and is read on every visit.
      const steps = await tx.select({
        groupCode: releaseStrategyStep.groupCode,
        strategyCode: releaseStrategyStep.strategyCode,
        steps: sql<number>`count(*)::int`,
      }).from(releaseStrategyStep).where(and(
        eq(releaseStrategyStep.client, who.client),
        inArray(releaseStrategyStep.groupCode, [...new Set(pending.map((r) => r.groupCode))]),
      )).groupBy(releaseStrategyStep.groupCode, releaseStrategyStep.strategyCode);

      const totalFor = new Map(
        steps.map((row) => [`${row.groupCode}/${row.strategyCode}`, row.steps]),
      );

      const orgs = await purchasingOrgsFor(
        tx, who.client, kind.category, pending.map((row) => row.number),
      );

      return pending.map((row) => {
        const total = totalFor.get(`${row.groupCode}/${row.strategyCode}`) ?? 0;
        return {
          source: kind.capability,
          title: t(kind.noun, { number: row.number }),
          detail: total > 0
            ? t('attention.releaseStep', { step: row.currentStep + 1, total })
            : t('attention.releasePlain'),
          href: `${kind.route}${encodeURIComponent(row.number)}`,
          waitingSince: isoDate(row.waitingSince),
          orgs: orgs.get(row.number) ?? [],
        };
      });
    });
  },
}));

// ─────────────────────────────────────────────────────────────────────────────
// Warehouse — picks, goods issues, and what credit is holding up
// ─────────────────────────────────────────────────────────────────────────────

function deliveryHref(deliveryNumber: string): string {
  return `${DELIVERY_ROUTE}?delivery=${encodeURIComponent(deliveryNumber)}`;
}

const deliveriesToPick: AttentionSource = {
  code: DELIVERY_PICK_CAPABILITY,
  label: 'attention.source.pick',
  async due(who) {
    const rows = await listDeliveries(who.client, { status: 'OPEN' });
    return rows
      // A delivery credit has blocked is not waiting on the picker; it is waiting
      // on the credit controller, and it has its own queue below.
      .filter((row) => !row.blockedForCredit)
      .map((row) => ({
        source: DELIVERY_PICK_CAPABILITY,
        title: t('attention.noun.delivery', { number: row.deliveryNumber }),
        detail: t('attention.pickDetail', { customer: row.customerNumber, order: row.orderNumber }),
        href: deliveryHref(row.deliveryNumber),
        waitingSince: row.deliveryDate,
        orgs: [{ plant: row.plant }],
      }));
  },
};

const deliveriesToIssue: AttentionSource = {
  code: DELIVERY_GOODS_ISSUE_CAPABILITY,
  label: 'attention.source.goodsIssue',
  async due(who) {
    const rows = await listDeliveries(who.client, { status: 'PICKED' });
    return rows
      .filter((row) => !row.blockedForCredit)
      .map((row) => ({
        source: DELIVERY_GOODS_ISSUE_CAPABILITY,
        title: t('attention.noun.delivery', { number: row.deliveryNumber }),
        detail: t('attention.issueDetail', { customer: row.customerNumber }),
        href: deliveryHref(row.deliveryNumber),
        waitingSince: row.deliveryDate,
        orgs: [{ plant: row.plant }],
      }));
  },
};

const deliveriesHeldForCredit: AttentionSource = {
  code: CREDIT_MEMO_RELEASE_CAPABILITY,
  label: 'attention.source.creditHeld',
  async due(who) {
    const [open, picked] = await Promise.all([
      listDeliveries(who.client, { status: 'OPEN' }),
      listDeliveries(who.client, { status: 'PICKED' }),
    ]);
    return [...open, ...picked]
      .filter((row) => row.blockedForCredit)
      .map((row) => ({
        source: CREDIT_MEMO_RELEASE_CAPABILITY,
        title: t('attention.noun.delivery', { number: row.deliveryNumber }),
        detail: row.status === 'OPEN'
          ? t('attention.creditOpenDetail', { customer: row.customerNumber })
          : t('attention.creditPickedDetail', { customer: row.customerNumber }),
        href: deliveryHref(row.deliveryNumber),
        waitingSince: row.deliveryDate,
        // The credit controller works in a credit control area, not a plant.
        // Nothing here names one, so only somebody unrestricted sees these —
        // which is the honest answer until a source that knows the customer's
        // control area is written.
        orgs: [],
        severity: 'BLOCKED' as const,
      }));
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// Sales — due lists, invoice lists, incomplete documents, held credit memos
// ─────────────────────────────────────────────────────────────────────────────

const deliveryDueList: AttentionSource = {
  code: DELIVERY_CAPABILITY,
  label: 'attention.source.deliver',
  async due(who) {
    const rows = await listDeliverableOrderLines(who.client);
    return rows.map((row) => ({
      source: DELIVERY_CAPABILITY,
      title: t('attention.noun.salesOrder', { number: row.orderNumber }),
      detail: t('attention.lineDetail', {
        material: row.materialNumber,
        quantity: row.remainingQuantity,
        unit: row.quantityUnit,
      }),
      href: `${DELIVERY_ROUTE}?order=${encodeURIComponent(row.orderNumber)}`,
      waitingSince: row.requestedDeliveryDate ?? row.orderDate,
      orgs: [{ plant: row.plant }],
    }));
  },
};

const billingDueListSource: AttentionSource = {
  code: BILLING_CAPABILITY,
  label: 'attention.source.bill',
  async due(who) {
    const rows = await billingDueList(who.client);
    return rows.map((row) => ({
      source: BILLING_CAPABILITY,
      title: t('attention.noun.delivery', { number: row.deliveryNumber }),
      detail: t('attention.billingDetail', {
        payer: row.payer, value: row.value, currency: row.currency,
      }),
      href: `${BILLING_ROUTE}?delivery=${encodeURIComponent(row.deliveryNumber)}`,
      waitingSince: row.goodsMovementDate ?? '',
      orgs: [{
        plant: row.plant,
        salesOrg: row.salesOrg,
        distributionChannel: row.distributionChannel,
        division: row.division,
        companyCode: row.companyCode,
      }],
    }));
  },
};

const invoiceListsToCreate: AttentionSource = {
  code: INVOICE_LIST_CREATE_CAPABILITY,
  label: 'attention.source.invoiceList',
  async due(who) {
    const rows = await invoiceListDueDocuments(who.client);

    // What a clerk creates is one list, for one payer, for one list date — not
    // one per document. Grouping here is what makes the row a unit of work
    // rather than a line of a report.
    const byList = new Map<string, {
      payer: string; invoiceListType: string; invoiceListDate: string;
      salesOrg: string; companyCode: string; currency: string;
      count: number; gross: number;
    }>();
    for (const row of rows) {
      const key = `${row.invoiceListType}/${row.invoiceListDate}/${row.payer}`;
      const held = byList.get(key);
      if (held) {
        held.count += 1;
        held.gross += row.grossValue;
        continue;
      }
      byList.set(key, {
        payer: row.payer,
        invoiceListType: row.invoiceListType,
        invoiceListDate: row.invoiceListDate,
        salesOrg: row.salesOrg,
        companyCode: row.companyCode,
        currency: row.currency,
        count: 1,
        gross: row.grossValue,
      });
    }

    return [...byList.values()].map((list) => ({
      source: INVOICE_LIST_CREATE_CAPABILITY,
      title: list.invoiceListType
        ? t('attention.invoiceListTitle', { type: list.invoiceListType, payer: list.payer })
        : t('attention.invoiceListPlainTitle', { payer: list.payer }),
      detail: t('attention.invoiceListDetail', {
        count: list.count, gross: list.gross.toFixed(2), currency: list.currency,
      }),
      href: INVOICE_LIST_ROUTE,
      waitingSince: list.invoiceListDate,
      orgs: [{ salesOrg: list.salesOrg, companyCode: list.companyCode }],
    }));
  },
};

const incompleteDocuments: AttentionSource = {
  code: INCOMPLETION_PROCESS_CAPABILITY,
  label: 'attention.source.incomplete',
  async due(who) {
    const rows = await listIncompleteDocuments(who.client);
    return rows.map((row) => ({
      source: INCOMPLETION_PROCESS_CAPABILITY,
      title: row.documentCategory === 'ORDER'
        ? t('attention.incompleteOrder', { number: row.documentNumber })
        : t('attention.incompleteDelivery', { number: row.documentNumber }),
      detail: row.blocking > 0
        ? t(row.blocking === 1 ? 'attention.blockingDetail' : 'attention.blockingDetailMany', { n: row.blocking })
        : t(row.missing === 1 ? 'attention.missingDetail' : 'attention.missingDetailMany', { n: row.missing }),
      href: INCOMPLETION_WORKLIST_ROUTE,
      waitingSince: row.documentDate,
      // The incompletion log names no organisation of its own; the document it
      // points at does, and that lookup is not worth a query on every home page
      // visit. Unrestricted holders only, until somebody asks for it.
      orgs: [],
      severity: row.blocking > 0 ? 'BLOCKED' as const : 'OPEN' as const,
    }));
  },
};

const creditMemosHeld: AttentionSource = {
  code: CREDIT_MEMO_RELEASE_CAPABILITY,
  label: 'attention.source.creditMemo',
  async due(who) {
    const rows = await listCreditMemoRequests(who.client);
    return rows
      .filter((row) => row.billingBlock != null)
      .map((row) => ({
        source: CREDIT_MEMO_RELEASE_CAPABILITY,
        title: t('attention.noun.creditMemo', { number: row.orderNumber }),
        detail: t('attention.creditMemoDetail', {
          customer: row.customerNumber, block: row.billingBlock ?? '',
        }),
        href: `${CREDIT_MEMO_ROUTE}?request=${encodeURIComponent(row.orderNumber)}`,
        waitingSince: row.orderDate,
        orgs: [],
        severity: 'BLOCKED' as const,
      }));
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// The registry
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Every kind of work the panel asks about.
 *
 * The order of this array is the order groups appear on the screen. Adding a
 * source is one entry here and nothing else — the panel reads the registry, so
 * there is no second place to remember.
 */
export const ATTENTION_SOURCES: AttentionSource[] = [
  ...releaseSources,
  deliveriesToPick,
  deliveriesToIssue,
  deliveriesHeldForCredit,
  deliveryDueList,
  billingDueListSource,
  invoiceListsToCreate,
  incompleteDocuments,
  creditMemosHeld,
];
