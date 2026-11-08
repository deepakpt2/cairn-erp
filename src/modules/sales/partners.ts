/**
 * Who a sale is made with — the four partner functions (SAP: PARVW, KNVP, VBPA).
 *
 * A sale is made with one customer and answered by up to four. The sold-to orders; the ship-to
 * receives; the bill-to is where the invoice is addressed; the payer is who owes the money. Before
 * this, one column on the order header was all four at once, which is why a receivable could only
 * ever name the company that placed the order — and a group that buys through a subsidiary, ships to
 * a site and pays from a head office could not be written down at all.
 *
 * Three rules carry it.
 *
 * Blank is a value. A row maintained for one sales area stands over the row maintained for all of
 * them, and the row that names no area is what answers for a customer nobody has refined — as it is
 * in revenue determination, and for the same reason: two maintainers reading the same table reach the
 * same partner.
 *
 * A function nobody maintains falls back to the one above it. The ship-to and the bill-to fall back
 * to the sold-to; the payer falls back to the bill-to, because the customer the invoice is addressed
 * to is the first place to look for the customer who pays it.
 *
 * A document carries the partners it was made with, written at creation and never re-derived. An
 * invoice raised in March still names the customer it was addressed to after that customer's master
 * is changed in June, and an order read in a year still says who it was made with.
 */
import { and, asc, eq, sql } from 'drizzle-orm';

import { recordChange } from '../../platform/change';
import { withTenant, type Tx } from '../../platform/db/client';
import { bpRole, businessPartner } from '../foundation/business-partner-schema';
import {
  customerSalesPartner, salesDocumentPartner, salesPartnerFunction,
  PARTNER_FUNCTIONS, type PartnerFunction,
} from './schema';

export const PARTNER_CAPABILITY = 'CFG.SALES.PARTNER.DEFINE';
export const PARTNER_OBJECT_CLASS = 'customer_sales_partner';
export const PARTNER_ROUTE = '/foundation/partners';
export const PARTNER_ALIASES = ['XD01', 'XD02', 'XD03'] as const;

export class PartnerError extends Error {
  remedy?: string;
  constructor(message: string, remedy?: string) {
    super(message);
    this.name = 'PartnerError';
    this.remedy = remedy;
  }
}

/** The four partners a document is made with. */
export interface DocumentPartners {
  soldTo: string;
  shipTo: string;
  billTo: string;
  payer: string;
}

/** Where an assignable function's answer came from. */
export type PartnerSource = 'MASTER' | 'SOLD_TO' | 'BILL_TO';

export interface ResolvedPartners extends DocumentPartners {
  source: { shipTo: PartnerSource; billTo: PartnerSource; payer: PartnerSource };
}

export function isPartnerFunction(value: string): value is PartnerFunction {
  return (PARTNER_FUNCTIONS as readonly string[]).includes(value);
}

/**
 * The sales areas a partner row is searched in, most specific first. A row naming the sales
 * organisation, the distribution channel and the division stands over the row naming none of them —
 * and the row naming none is the one that answers for a customer nobody has refined.
 */
function areasOf(salesOrg: string, distributionChannel: string, division: string) {
  return [
    { salesOrg, distributionChannel, division },
    { salesOrg, distributionChannel, division: '' },
    { salesOrg, distributionChannel: '', division: '' },
    { salesOrg: '', distributionChannel: '', division: '' },
  ];
}

/**
 * Who this sale is made with. The sold-to is the customer the master belongs to and is never
 * assigned; the other three are read most specific first, and each falls back to the one above it.
 */
export async function resolvePartners(
  tx: Tx,
  client: string,
  input: {
    partnerNumber: string;
    salesOrg: string;
    distributionChannel: string;
    division: string;
  },
): Promise<ResolvedPartners> {
  const rows = await tx.select().from(customerSalesPartner).where(and(
    eq(customerSalesPartner.client, client),
    eq(customerSalesPartner.partnerNumber, input.partnerNumber),
    eq(customerSalesPartner.isActive, true),
  ));
  const areas = areasOf(input.salesOrg, input.distributionChannel, input.division);
  const maintained = (fn: PartnerFunction): string | undefined => {
    for (const area of areas) {
      const row = rows.find((candidate) => candidate.functionCode === fn
        && candidate.salesOrg === area.salesOrg
        && candidate.distributionChannel === area.distributionChannel
        && candidate.division === area.division);
      if (row) return row.assignedPartnerNumber;
    }
    return undefined;
  };

  const soldTo = input.partnerNumber;
  const shipToRow = maintained('SH');
  const billToRow = maintained('BP');
  const payerRow = maintained('PY');
  const shipTo = shipToRow ?? soldTo;
  const billTo = billToRow ?? soldTo;
  const payer = payerRow ?? billTo;
  return {
    soldTo, shipTo, billTo, payer,
    source: {
      shipTo: shipToRow ? 'MASTER' : 'SOLD_TO',
      billTo: billToRow ? 'MASTER' : 'SOLD_TO',
      payer: payerRow ? 'MASTER' : (billToRow ? 'BILL_TO' : 'SOLD_TO'),
    },
  };
}

/**
 * The partners a document was created with, or null where a document carries none — which is what
 * every document raised before this stood as, and what the header's own customer number answers for.
 */
export async function documentPartners(
  tx: Tx,
  client: string,
  documentCategory: string,
  documentNumber: string,
): Promise<DocumentPartners | null> {
  const rows = await tx.select().from(salesDocumentPartner).where(and(
    eq(salesDocumentPartner.client, client),
    eq(salesDocumentPartner.documentCategory, documentCategory),
    eq(salesDocumentPartner.documentNumber, documentNumber),
  ));
  if (rows.length === 0) return null;
  const at = (fn: PartnerFunction) => rows.find((row) => row.functionCode === fn)?.partnerNumber;
  const soldTo = at('SP');
  if (!soldTo) return null;
  return {
    soldTo,
    shipTo: at('SH') ?? soldTo,
    billTo: at('BP') ?? soldTo,
    payer: at('PY') ?? at('BP') ?? soldTo,
  };
}

/**
 * Write the partners a document is made with. Upserted rather than deleted and re-inserted: the
 * application role holds no DELETE on what a document was made with, and a change of ship-to is a
 * change of fact, not a second history.
 */
export async function writeDocumentPartners(tx: Tx, input: {
  client: string;
  documentCategory: string;
  documentNumber: string;
  partners: DocumentPartners;
  changedBy: string;
}): Promise<void> {
  const values = (PARTNER_FUNCTIONS as readonly PartnerFunction[]).map((functionCode) => ({
    client: input.client,
    documentCategory: input.documentCategory,
    documentNumber: input.documentNumber,
    functionCode,
    partnerNumber: input.partners[functionCode === 'SP' ? 'soldTo'
      : functionCode === 'SH' ? 'shipTo' : functionCode === 'BP' ? 'billTo' : 'payer'],
    createdBy: input.changedBy,
  }));
  await tx.insert(salesDocumentPartner).values(values).onConflictDoUpdate({
    target: [
      salesDocumentPartner.client, salesDocumentPartner.documentCategory,
      salesDocumentPartner.documentNumber, salesDocumentPartner.functionCode,
    ],
    set: {
      partnerNumber: sql`excluded.partner_number`,
      changedBy: sql`excluded.created_by`,
      changedAt: sql`now()`,
    },
  });
}

/**
 * The partners a document carries, read in its own transaction — for the services that post against a
 * document they have already built, and that therefore stand outside the transaction that wrote it.
 */
export async function partnersForDocument(
  client: string,
  documentCategory: string,
  documentNumber: string,
): Promise<DocumentPartners | null> {
  return withTenant(client, (tx) => documentPartners(tx, client, documentCategory, documentNumber));
}

/** The address a document is delivered or sent to, read from the partner's own master. */
/** The functions a tenant can maintain, with the words that say what each one is for. */
export async function listPartnerFunctions(client: string): Promise<Array<{
  functionCode: string; displayName: string; meaning: string; isActive: boolean;
}>> {
  return withTenant(client, async (tx) => {
    const rows = await tx.select().from(salesPartnerFunction)
      .where(eq(salesPartnerFunction.client, client))
      .orderBy(asc(salesPartnerFunction.functionCode));
    return rows.map((row) => ({
      functionCode: row.functionCode,
      displayName: row.displayName,
      meaning: row.meaning,
      isActive: row.isActive,
    }));
  });
}

export interface CustomerPartnerRow {
  salesOrg: string;
  distributionChannel: string;
  division: string;
  functionCode: string;
  functionName: string;
  assignedPartnerNumber: string;
  assignedPartnerName: string | null;
  isActive: boolean;
  version: number;
}

/** The functions maintained for one customer, with the names a maintainer reads. */
export async function listCustomerPartners(
  client: string,
  partnerNumber: string,
): Promise<{ rows: CustomerPartnerRow[]; functions: Array<{ functionCode: string; displayName: string; meaning: string }> }> {
  return withTenant(client, async (tx) => {
    const rows = await tx.select({
      salesOrg: customerSalesPartner.salesOrg,
      distributionChannel: customerSalesPartner.distributionChannel,
      division: customerSalesPartner.division,
      functionCode: customerSalesPartner.functionCode,
      assignedPartnerNumber: customerSalesPartner.assignedPartnerNumber,
      isActive: customerSalesPartner.isActive,
      version: customerSalesPartner.version,
      functionName: salesPartnerFunction.displayName,
      assignedPartnerName: businessPartner.name,
    }).from(customerSalesPartner)
      .innerJoin(salesPartnerFunction, and(
        eq(salesPartnerFunction.client, customerSalesPartner.client),
        eq(salesPartnerFunction.functionCode, customerSalesPartner.functionCode),
      ))
      .leftJoin(businessPartner, and(
        eq(businessPartner.client, customerSalesPartner.client),
        eq(businessPartner.partnerNumber, customerSalesPartner.assignedPartnerNumber),
      ))
      .where(and(
        eq(customerSalesPartner.client, client),
        eq(customerSalesPartner.partnerNumber, partnerNumber),
      ))
      .orderBy(
        asc(customerSalesPartner.functionCode),
        asc(customerSalesPartner.salesOrg),
        asc(customerSalesPartner.distributionChannel),
        asc(customerSalesPartner.division),
      );
    const functions = await listPartnerFunctions(client);
    return {
      rows: rows.map((row) => ({ ...row, functionName: row.functionName ?? row.functionCode })),
      functions: functions.filter((row) => row.functionCode !== 'SP')
        .map((row) => ({ functionCode: row.functionCode, displayName: row.displayName, meaning: row.meaning })),
    };
  });
}

export interface SaveCustomerPartnerInput {
  client: string;
  changedBy: string;
  partnerNumber: string;
  salesOrg?: string;
  distributionChannel?: string;
  division?: string;
  functionCode: string;
  assignedPartnerNumber: string;
  expectedVersion?: number;
}

/**
 * Name who plays a function for a customer. Both sides must stand as customers: a ship-to that is
 * not a customer cannot receive a delivery, and a payer that is not a customer has no reconciliation
 * account for the receivable to be posted to.
 */
export async function saveCustomerPartner(input: SaveCustomerPartnerInput): Promise<{ version: number }> {
  const client = input.client;
  const partnerNumber = input.partnerNumber.trim().toUpperCase();
  const assigned = input.assignedPartnerNumber.trim().toUpperCase();
  const functionCode = input.functionCode.trim().toUpperCase();
  const salesOrg = (input.salesOrg ?? '').trim().toUpperCase();
  const distributionChannel = (input.distributionChannel ?? '').trim().toUpperCase();
  const division = (input.division ?? '').trim().toUpperCase();

  if (functionCode === 'SP') {
    throw new PartnerError(
      'The sold-to is not assigned to a customer.',
      'The sold-to is the customer the sale is made with, which is the customer whose master this is. Assign the ship-to, the bill-to or the payer instead.',
    );
  }
  if (!isPartnerFunction(functionCode)) {
    throw new PartnerError(
      `Partner function ${functionCode || '(blank)'} is not one this package determines.`,
      `Use one of the delivered functions — SH, BP, PY — which are the ones a document is made with.`,
    );
  }
  if (!assigned) {
    throw new PartnerError(
      'A partner function names the customer that plays it.',
      'Name the customer that ships to, is billed to, or pays.',
    );
  }

  return withTenant(client, async (tx) => {
    const standing = await tx.select().from(customerSalesPartner).where(and(
      eq(customerSalesPartner.client, client),
      eq(customerSalesPartner.partnerNumber, partnerNumber),
      eq(customerSalesPartner.salesOrg, salesOrg),
      eq(customerSalesPartner.distributionChannel, distributionChannel),
      eq(customerSalesPartner.division, division),
      eq(customerSalesPartner.functionCode, functionCode),
    )).limit(1);
    const before = standing[0];
    if (before && input.expectedVersion !== undefined && before.version !== input.expectedVersion) {
      throw new PartnerError(
        `The partner function was changed since it was read (version ${before.version}, expected ${input.expectedVersion}).`,
        'Reload the customer and apply the change to what stands now.',
      );
    }
    for (const [number, role] of [[partnerNumber, 'this customer'], [assigned, 'the assigned partner']] as const) {
      const [row] = await tx.select({ partnerNumber: bpRole.partnerNumber }).from(bpRole).where(and(
        eq(bpRole.client, client), eq(bpRole.partnerNumber, number),
        eq(bpRole.roleCode, 'CUSTOMER'), eq(bpRole.isActive, true),
      )).limit(1);
      if (!row) {
        throw new PartnerError(
          `${number} does not stand as a customer, so ${role} cannot carry a partner function.`,
          `Maintain ${number} as a customer first: a ship-to that is not a customer cannot receive a delivery, and a payer that is not a customer has no reconciliation account.`,
        );
      }
    }

    const values = {
      client, partnerNumber, salesOrg, distributionChannel, division, functionCode,
      assignedPartnerNumber: assigned,
      partnerRoleCode: 'CUSTOMER', assignedRoleCode: 'CUSTOMER',
      isActive: true, createdBy: input.changedBy,
    };
    const [written] = await tx.insert(customerSalesPartner).values(values).onConflictDoUpdate({
      target: [
        customerSalesPartner.client, customerSalesPartner.partnerNumber, customerSalesPartner.salesOrg,
        customerSalesPartner.distributionChannel, customerSalesPartner.division,
        customerSalesPartner.functionCode,
      ],
      set: {
        assignedPartnerNumber: assigned,
        isActive: true,
        version: before ? before.version + 1 : 1,
        changedBy: input.changedBy,
        changedAt: new Date(),
      },
    }).returning({ version: customerSalesPartner.version });

    await recordChange(tx, {
      client, objectClass: PARTNER_OBJECT_CLASS,
      objectKey: `${partnerNumber}/${salesOrg || '*'}/${distributionChannel || '*'}/${division || '*'}/${functionCode}`,
      changeType: before ? 'CHANGE' : 'CREATE', changedBy: input.changedBy,
      before: before ? { assignedPartnerNumber: before.assignedPartnerNumber } : undefined,
      after: { assignedPartnerNumber: assigned },
      securityRelevantFields: ['assignedPartnerNumber'],
    });
    return { version: written?.version ?? 1 };
  });
}

/**
 * Withdraw a partner function, or restore one. A withdrawn row is not gone: it stops answering, so
 * the function falls back to the one above it, and it still says who used to play it — which is what
 * an auditor reads when the master was changed and not invented.
 */
export async function changeCustomerPartnerStatus(input: {
  client: string; changedBy: string; partnerNumber: string; salesOrg: string;
  distributionChannel: string; division: string; functionCode: string; isActive: boolean;
}): Promise<{ version: number }> {
  return withTenant(input.client, async (tx) => {
    const [updated] = await tx.update(customerSalesPartner).set({
      isActive: input.isActive, changedBy: input.changedBy, changedAt: new Date(),
    }).where(and(
      eq(customerSalesPartner.client, input.client),
      eq(customerSalesPartner.partnerNumber, input.partnerNumber),
      eq(customerSalesPartner.salesOrg, input.salesOrg),
      eq(customerSalesPartner.distributionChannel, input.distributionChannel),
      eq(customerSalesPartner.division, input.division),
      eq(customerSalesPartner.functionCode, input.functionCode),
    )).returning({ version: customerSalesPartner.version });
    if (!updated) {
      throw new PartnerError(
        `No partner function ${input.functionCode} stands for that customer and sales area.`,
        'Maintain the function first; a function that was never named cannot be withdrawn.',
      );
    }
    await recordChange(tx, {
      client: input.client, objectClass: PARTNER_OBJECT_CLASS,
      objectKey: `${input.partnerNumber}/${input.salesOrg || '*'}/${input.distributionChannel || '*'}/${input.division || '*'}/${input.functionCode}`,
      changeType: 'CHANGE', changedBy: input.changedBy,
      after: { isActive: input.isActive },
      securityRelevantFields: ['isActive'],
    });
    return { version: updated.version };
  });
}

/** The address a document is delivered or sent to, read from the partner's own master. */
export async function partnerAddress(client: string, partnerNumber: string): Promise<{
  partnerNumber: string; name: string; street: string | null; city: string | null;
  region: string | null; postalCode: string | null; country: string | null;
} | null> {
  return withTenant(client, async (tx) => {
    const [row] = await tx.select().from(businessPartner).where(and(
      eq(businessPartner.client, client), eq(businessPartner.partnerNumber, partnerNumber),
    )).limit(1);
    if (!row) return null;
    return {
      partnerNumber: row.partnerNumber, name: row.name, street: row.street, city: row.city,
      region: row.region, postalCode: row.postalCode, country: row.country,
    };
  });
}
