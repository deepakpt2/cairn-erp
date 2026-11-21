/**
 * Reach over a sales document: its company code is inside the actor's Company Code scope, its sales area (Sales Org,
 * Distribution Channel, Division) is inside any such restriction the actor holds, and every plant it ships from is
 * inside the Plant scope when one is held. A document outside the reach answers as a missing one.
 */
import { type AnyColumn, type SQL, and, eq, sql } from 'drizzle-orm';
import { salesOrg as salesOrgTable } from '../foundation/schema';
import type { Tx } from '../../platform/db/client';
import type { CompanyAuthority } from '../../platform/auth/company-scope';
import type { ServiceAuthorityContext } from '../../platform/auth/service-authority';
import {
  orgLevelsAllow, plantsAllow, purchasingActor, type ScopeFailure,
} from '../../platform/auth/scope-actor';
import { hasOrgAccess } from '../../platform/auth/session';

export interface SalesDocumentReach {
  companyCode: string;
  salesOrg: string;
  distributionChannel: string;
  division: string;
  plants?: readonly string[];
}

export async function salesActor(
  tx: Tx, client: string, authorization: ServiceAuthorityContext | undefined,
  capabilities: readonly string[], failure: ScopeFailure,
): Promise<CompanyAuthority> {
  return purchasingActor(tx, client, authorization, capabilities, failure);
}

export function salesDocumentReachable(actor: CompanyAuthority, doc: SalesDocumentReach): boolean {
  return hasOrgAccess(actor.restrictions, 'COMPANY_CODE', doc.companyCode.trim())
    && orgLevelsAllow(actor, {
      SALES_ORG: doc.salesOrg, DISTRIBUTION_CHANNEL: doc.distributionChannel, DIVISION: doc.division,
    })
    && plantsAllow(actor, doc.plants ?? []);
}

/** A sales area on its own (a master or a choice list): the company is the area's sales org's company, when known. */
export function salesAreaReachable(
  actor: CompanyAuthority, area: { salesOrg: string; distributionChannel: string; division: string },
): boolean {
  return orgLevelsAllow(actor, {
    SALES_ORG: area.salesOrg, DISTRIBUTION_CHANNEL: area.distributionChannel, DIVISION: area.division,
  });
}

/** The columns of one sales document table that carry its company and sales area. */
export interface SalesReachColumns {
  companyCode: SQL | AnyColumn;
  salesOrg: SQL | AnyColumn;
  distributionChannel: SQL | AnyColumn;
  division: SQL | AnyColumn;
}

/**
 * The company and sales-area part of the actor's reach as a SQL condition over one document table: the company is
 * one of the actor's Company Codes, and each sales-area level is one the actor holds when a restriction of that
 * level is held. Plant reach is not expressed here (a document can span plants); a plant-limited actor is judged
 * per document, or refused an aggregate.
 */
export function salesReachSql(actor: CompanyAuthority, columns: SalesReachColumns): SQL {
  const held = (type: string) => actor.restrictions
    .filter((r) => r.scopeType === type).map((r) => r.scopeValue.trim());
  const within = (column: SQL | AnyColumn, values: string[]) => (
    values.length ? sql`${column} in (${sql.join(values.map((v) => sql`${v}`), sql`, `)})` : sql`false`
  );
  const parts = [within(columns.companyCode, held('COMPANY_CODE'))];
  const levels: Array<[string, SQL | AnyColumn]> = [
    ['SALES_ORG', columns.salesOrg], ['DISTRIBUTION_CHANNEL', columns.distributionChannel], ['DIVISION', columns.division],
  ];
  for (const [type, column] of levels) {
    const values = held(type);
    if (values.length) parts.push(within(column, values));
  }
  return sql`(${sql.join(parts, sql` and `)})`;
}

/** Whether the actor holds a Plant restriction, which an aggregate over many documents cannot honour. */
export function plantLimited(actor: CompanyAuthority): boolean {
  return actor.restrictions.some((r) => r.scopeType === 'PLANT');
}

/** A sales area inside the actor's reach: its sales org's company is inside the Company Code scope (an org with no company is unreachable). */
export async function salesAreaInReach(
  tx: Tx, client: string, actor: CompanyAuthority,
  area: { salesOrg: string; distributionChannel: string; division: string },
): Promise<boolean> {
  const [org] = await tx.select({ companyCode: salesOrgTable.companyCode }).from(salesOrgTable).where(and(
    eq(salesOrgTable.client, client), eq(salesOrgTable.salesOrg, area.salesOrg),
  )).limit(1);
  if (!org?.companyCode) return false;
  return salesDocumentReachable(actor, { companyCode: org.companyCode, ...area });
}
