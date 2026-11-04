import { sql } from 'drizzle-orm';

import { PRODUCTION_GOODS_MOVEMENT_REPROCESS_CAPABILITY } from '../../platform/auth/capability-policy';
import {
  hasCapability,
  hasOrgAccess,
  loadCapabilities,
  loadOrgRestrictions,
  type OrgRestriction,
} from '../../platform/auth/session';
import type { Tx } from '../../platform/db/client';

export const PRODUCTION_COGI_CAPABILITY = PRODUCTION_GOODS_MOVEMENT_REPROCESS_CAPABILITY;
export const PRODUCTION_COGI_ROUTE = '/production/cogi';
export const PRODUCTION_COGI_ALIAS = 'COGI';

export interface ProductionCogiAuthorizationContext {
  /** Supplied only from the authenticated server session, never from form data. */
  userId: string;
  sessionId: string;
}

export class ProductionCogiAuthorizationError extends Error {
  readonly remedy?: string;

  constructor(message: string, remedy?: string) {
    super(message);
    this.name = 'ProductionCogiAuthorizationError';
    this.remedy = remedy;
  }
}

export function holdsProductionCogiAuthority(held: readonly string[]): boolean {
  return hasCapability([...held], PRODUCTION_COGI_CAPABILITY);
}

export async function requireProductionCogiAuthorityInTx(
  tx: Tx,
  client: string,
  authorization: ProductionCogiAuthorizationContext | undefined,
): Promise<{ username: string; restrictions: OrgRestriction[] }> {
  if (!authorization?.userId || !authorization.sessionId) {
    throw new ProductionCogiAuthorizationError('You are not authorised to use COGI.', 'Sign in again with an active account.');
  }
  const sessions = await tx.execute(sql`
    select u.username
      from user_session s
      join app_user u on u.client = s.client and u.id = s.user_id
     where s.client = ${client}
       and s.id = ${authorization.sessionId}
       and s.user_id = ${authorization.userId}
       and s.revoked_at is null
       and s.expires_at > now()
       and u.is_active = true
       and u.is_locked = false
     for share of s, u
  `) as unknown as Array<{ username: string }>;
  const actor = sessions[0];
  if (!actor) {
    throw new ProductionCogiAuthorizationError('You are not authorised to use COGI.', 'Your session or account is no longer active. Sign in again.');
  }
  await tx.execute(sql`select code from capability where code = ${PRODUCTION_COGI_CAPABILITY} for share`);
  await tx.execute(sql`
    select ur.role_code, rc.capability_code
      from user_role ur
      join role r on r.client = ur.client and r.code = ur.role_code and r.is_active = true and r.is_read_only = false
      join role_capability rc on rc.client = ur.client and rc.role_code = ur.role_code
     where ur.client = ${client}
       and ur.user_id = ${authorization.userId}
       and (ur.valid_from is null or ur.valid_from <= now())
       and (ur.valid_to is null or ur.valid_to >= now())
     for share of ur, r, rc
  `);
  const capabilities = await loadCapabilities(tx, client, authorization.userId);
  if (!hasCapability(capabilities, PRODUCTION_COGI_CAPABILITY)) {
    throw new ProductionCogiAuthorizationError(
      `You do not hold the authority ${PRODUCTION_COGI_CAPABILITY}.`,
      'Ask an administrator to assign the COGI recovery capability to an active role.',
    );
  }
  await tx.execute(sql`
    select id from auth_org_restriction
     where client = ${client} and user_id = ${authorization.userId}
     for share
  `);
  const restrictions = await loadOrgRestrictions(tx, client, authorization.userId);
  const hasCompanyScope = restrictions.some((scope) => scope.scopeType === 'COMPANY_CODE' && scope.scopeValue.trim());
  const hasPlantScope = restrictions.some((scope) => scope.scopeType === 'PLANT' && scope.scopeValue.trim());
  if (!hasCompanyScope || !hasPlantScope) {
    throw new ProductionCogiAuthorizationError(
      'You are not authorised to use COGI.',
      'Explicit Company Code and Plant scope are required.',
    );
  }
  return { username: String(actor.username), restrictions };
}

/** Verify order/plant consistency and the user's current organizational scope. */
export async function requireProductionCogiFailureScopeInTx(
  tx: Tx,
  client: string,
  failure: { orderNumber: string; plant: string },
  restrictions: readonly OrgRestriction[],
): Promise<{ companyCode: string; plant: string }> {
  const rows = await tx.execute(sql`
    select o.plant as order_plant,
           o.company_code as order_company,
           p.plant as plant,
           p.company_code as plant_company
      from production_order o
      join plant p on p.client = o.client and p.plant = o.plant
     where o.client = ${client} and o.order_number = ${failure.orderNumber}
     for share of o, p
  `) as unknown as Array<{ order_plant: string; order_company: string | null; plant: string; plant_company: string | null }>;
  const row = rows[0];
  const companyCode = row?.plant_company?.trim() ?? '';
  const orderCompany = row?.order_company?.trim() ?? '';
  if (!row || row.plant !== failure.plant || !companyCode || (orderCompany && orderCompany !== companyCode)) {
    throw new ProductionCogiAuthorizationError(
      'The failed movement does not have a consistent production order, plant, and company assignment.',
      'Ask an administrator to review the order and plant configuration.',
    );
  }
  if (!hasOrgAccess(restrictions, 'COMPANY_CODE', companyCode)
    || !hasOrgAccess(restrictions, 'PLANT', row.plant)) {
    throw new ProductionCogiAuthorizationError(
      'You are not authorised to access this failed movement.',
      'Your Company Code or Plant scope does not cover this movement.',
    );
  }
  return { companyCode, plant: row.plant };
}
