/**
 * The authority a business service acts under — CAIRN.md §23.
 *
 * A service that writes a document is answerable for who wrote it. The inventory
 * posting paths (`goods-issue`, `goods-receipt`, `initial-stock`) and the two
 * production recovery paths (`production-cogi-auth`, `confirmation-cancel`) always
 * asked inside their own transaction; the production services and the sales services
 * did not, which left an order, a delivery, a billing document or a payment writable
 * by a caller with no session at all, for a plant the caller had no mandate for.
 *
 * This module states the answer once, so every service asks the same three questions
 * in the same order and refuses in the same words.
 *
 * **Three questions, in this order.**
 *
 * 1. *Who is acting?* The session must stand, be unrevoked, unexpired, and belong to
 *    an account that is active and unlocked. The identity comes from the caller's
 *    authenticated session and never from a form field, an order field, or a string
 *    the caller typed.
 * 2. *Does the actor hold the authority?* Capabilities are re-read inside this
 *    transaction, after the role and grant rows have been locked, so a concurrent
 *    revocation cannot be observed as a grant that has already been withdrawn.
 * 3. *Does the actor's reach cover the plant?* An absent Company Code or Plant grant
 *    is not "unrestricted" here: it is a mandate the administrator never gave, and it
 *    fails closed. The plant's company code is taken from the plant master, never
 *    from the document.
 *
 * The module returns a verdict rather than throwing, so each service refuses in the
 * words its own callers already catch: a production order answers with
 * `ProductionOrderError`, a sales order with `SalesOrderError`, a payment with the
 * payment's own error. One authority rule, spoken in each service's voice.
 */
import { sql } from 'drizzle-orm';

import {
  hasCapability,
  hasOrgAccess,
  loadCapabilities,
  loadOrgRestrictions,
  type OrgRestriction,
} from './session';
import type { Tx } from '../db/client';

/** Who the service acts for. Supplied from the authenticated session, never from a form. */
export interface ServiceAuthorityContext {
  userId: string;
  sessionId: string;
}

/** A refusal, in the caller's voice: what is wrong, and what the actor does next. */
export interface ServiceAuthorityRefusal {
  message: string;
  remedy: string;
}

export type ServiceAuthorityVerdict =
  | { ok: true; username: string; restrictions: OrgRestriction[] }
  | { ok: false; refusal: ServiceAuthorityRefusal };

function refusal(message: string, remedy: string): ServiceAuthorityVerdict {
  return { ok: false, refusal: { message, remedy } };
}

/**
 * Verify the acting session, one named authority, and the presence of the
 * organisational grants the action needs — all inside the caller's transaction.
 *
 * The locks are not decoration: `user_role`, `role` and `role_capability` are held
 * `for share` so an administrator removing the role in a second transaction cannot
 * commit between this read and the service's write, and the restriction rows are held
 * the same way so a narrowed scope cannot land in between.
 *
 * `requirePlantScope` is the difference between a plant and a company: a goods
 * movement, a production order and a delivery happen in a plant, so an actor with no
 * plant grant holds a mandate nobody gave. A payment is a company's, not a plant's —
 * it settles a receivable the company code owns — so a service that names a company
 * code and no plant passes `false` and is judged on the company code alone.
 */
export async function verifyServiceAuthorityInTx(
  tx: Tx,
  client: string,
  authorization: ServiceAuthorityContext | undefined,
  capability: string,
  options: { requirePlantScope?: boolean } = {},
): Promise<ServiceAuthorityVerdict> {
  if (!authorization?.userId || !authorization.sessionId) {
    return refusal(
      'This action needs a signed-in user. Nothing was saved.',
      'Sign in again with an active account.',
    );
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
    return refusal(
      'Your session or account is no longer active. Nothing was saved.',
      'Sign in again with an active account.',
    );
  }

  await tx.execute(sql`select code from capability where code = ${capability} for share`);
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
  if (!hasCapability(capabilities, capability)) {
    return refusal(
      `You do not hold the authority ${capability}.`,
      `Ask an administrator to assign the authority ${capability} to one of your roles.`,
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
  if (!hasCompanyScope) {
    return refusal(
      'This action needs an explicit Company Code scope.',
      'Ask an administrator to grant the Company Code scope your role needs.',
    );
  }
  if (options.requirePlantScope !== false && !hasPlantScope) {
    return refusal(
      'This action needs an explicit Company Code and Plant scope.',
      'Ask an administrator to grant the Company Code and Plant scope your role needs.',
    );
  }

  return { ok: true, username: String(actor.username), restrictions };
}

/**
 * Does the actor's reach cover this plant? The company code is the plant's own, read
 * from the plant master: a document that names a company code of its own is not
 * believed here.
 *
 * A blank company code is the caller's business, not the authority's — the service
 * that read the plant already refuses a plant with no company code, and it says so in
 * its own words. Call this only once a company code stands.
 */
export function scopeRefusal(
  restrictions: readonly OrgRestriction[],
  companyCode: string,
  plant: string,
): ServiceAuthorityRefusal | null {
  if (!hasOrgAccess(restrictions, 'COMPANY_CODE', companyCode) || !hasOrgAccess(restrictions, 'PLANT', plant)) {
    return {
      message: `Your Company Code or Plant scope does not cover plant ${plant}.`,
      remedy: 'Ask an administrator to extend your Company Code or Plant scope, then repeat the action.',
    };
  }
  return null;
}

/**
 * Resolve a plant's company code for an authority check, and refuse when the actor's
 * grants do not reach it. One query and one answer, for a service that holds no plant
 * row of its own yet.
 */
export async function refusePlantOutsideScopeInTx(
  tx: Tx,
  client: string,
  plant: string,
  restrictions: readonly OrgRestriction[],
): Promise<ServiceAuthorityRefusal | null> {
  const rows = await tx.execute(sql`
    select p.plant, p.company_code as "companyCode"
      from plant p
     where p.client = ${client} and p.plant = ${plant}
     for share
  `) as unknown as Array<{ plant: string; companyCode: string | null }>;
  const row = rows[0];
  if (!row) {
    return { message: `Plant ${plant} does not exist.`, remedy: 'Enter a plant that stands in this company.' };
  }
  const companyCode = row.companyCode?.trim() ?? '';
  if (!companyCode) {
    return {
      message: `Plant ${plant} carries no company code.`,
      remedy: 'Assign the plant to a company code, then repeat the action.',
    };
  }
  return scopeRefusal(restrictions, companyCode, row.plant);
}
