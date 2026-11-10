import { withTenant, type Tx } from '../../platform/db/client';

/**
 * The organisation chart of authority — CAIRN.md §23, and the human control the
 * plan puts *before* delegation.
 *
 * ## What this screen is for
 *
 * Delegation hands one person's authority to another, and in this design the
 * check on that is a person: a superior reads what the delegate already holds,
 * where it applies, and what is already delegated, and only then decides. Built
 * the other way round — delegation first — a superior is asked to approve blind.
 * That is the whole reason this precedes Phase 5.
 *
 * ## The one rule that decides what you may see
 *
 * A viewer sees **their own reporting line and nobody else's**. Not "everyone in
 * the tenant who holds a role", which would be a user list by another name, and
 * not "whoever I can find a user id for". The line is derived: the positions the
 * viewer holds, everything hanging below them, and the people standing in those
 * positions. That set is computed here, never taken from the caller, so a
 * crafted user id in the query string cannot widen it.
 *
 * A viewer holding no position sees an empty line. That is correct rather than
 * an error: authority in this system runs through the structure, so someone
 * standing outside it has no line to read.
 *
 * ## What is deliberately absent
 *
 * The three delegation sections are empty and typed as empty. Delegation does
 * not exist until Phase 5, and the honest thing is to show a superior an empty
 * panel that says so, rather than a panel of invented rows. The shapes are
 * declared now so Phase 5 fills them rather than reshaping them.
 *
 * A grant's `pattern` is also shown as held rather than expanded against the
 * capability catalogue: `PROC.*` is one row a superior can read, where three
 * hundred expanded codes is a wall nobody reads.
 */

import { sql } from 'drizzle-orm';

import { effectiveGrants, type AuthorityGrant, type ScopeKey } from '../../platform/auth/authority';
import {
  chainAbove,
  holdersOfPosition,
  orgUnitOfPosition,
  positionsBelow,
  positionsOfUser,
  type PositionRef,
} from './chain-of-command';

export const AUTHORITY_CHART_ROUTE = '/people/authority';

/** Read-only, and deliberately its own authority: seeing authority is not maintaining it. */
export const AUTHORITY_CHART_CAPABILITY = 'PEOPLE.AUTHORITY.VIEW';

/**
 * Where a grant applies, for display.
 *
 * `TENANT` is not one of the nine levels — it is what an unrestricted grant
 * means, and naming it stops "unrestricted" rendering as a blank the reader has
 * to guess at.
 */
export type GrantLevel = ScopeKey | 'TENANT';

/** One grant, as a superior needs to read it. */
export interface GrantLine {
  source: AuthorityGrant['source'];
  /** The pattern as held, not expanded. */
  pattern: string;
  /** What it came from: the role code, the position code, or the grant id. */
  via: string;
  level: GrantLevel;
  values: string[];
  /** Direct grants only: why it was given, and who gave it. */
  reason?: string;
  granter?: string;
  validFrom: string | null;
  validTo: string | null;
}

/** A position the subject holds, and the unit it stands in. */
export interface PositionLine {
  code: string;
  title: string;
  orgUnitCode: string | null;
  orgUnitName: string | null;
}

/** One person in the line, as a row to pick from. */
export interface SubjectSummary {
  userId: string;
  username: string;
  fullName: string;
  positionCount: number;
  /**
   * Grant *lines*, not grants: one per level, so this is the number of rows the
   * reader will find when they open the person. Counting raw grants here would
   * show a smaller number than the panel beneath it.
   */
  grantCount: number;
}

/** Everything about one person. */
export interface SubjectCard {
  userId: string;
  username: string;
  fullName: string;
  positions: PositionLine[];
  /** The reporting line above them, nearest first, ending at its org unit. */
  superiorLine: { kind: 'POSITION' | 'ORG_UNIT'; label: string }[];
  grants: GrantLine[];
  /** Empty until Phase 5. Typed, not invented. */
  delegatedToThem: DelegationLine[];
  delegatedAway: DelegationLine[];
  pendingAcceptance: DelegationLine[];
}

/** The shape Phase 5 will fill. Declared now so that phase fills rather than reshapes. */
export interface DelegationLine {
  delegationId: string;
  counterpartyName: string;
  capabilityPattern: string;
  granter: string;
  validFrom: string;
  validTo: string | null;
  status: string;
}

export interface AuthorityChart {
  viewer: { userId: string; fullName: string; positions: PositionLine[] };
  /** Everyone the viewer may look at. Empty when they hold no position. */
  subjects: SubjectSummary[];
  selected: SubjectCard | null;
}

const LEVEL_LABEL: Record<ScopeKey, string> = {
  plant: 'Plant',
  companyCode: 'Company code',
  purchasingOrg: 'Purchasing org',
  purchasingGroup: 'Purchasing group',
  salesOrg: 'Sales org',
  distributionChannel: 'Distribution channel',
  division: 'Division',
  creditControlArea: 'Credit control area',
  controllingArea: 'Controlling area',
};

/**
 * One grant becomes one line per level it names, and a single `TENANT` line when
 * it names none. A level's values stay together on that line rather than
 * becoming one row each: a grant covering forty plants is one row a superior
 * can read, where forty rows is the same wall of noise as expanding a `PROC.*`
 * pattern into three hundred capability codes.
 */
export function grantLines(grant: AuthorityGrant): GrantLine[] {
  const shared = {
    source: grant.source,
    pattern: grant.pattern,
    via: grant.roleCode ?? grant.positionCode ?? grant.grantId ?? '',
    reason: grant.reason,
    granter: grant.granter,
    validFrom: grant.validFrom,
    validTo: grant.validTo,
  };

  const levels = Object.keys(grant.scope) as ScopeKey[];
  if (levels.length === 0) {
    return [{ ...shared, level: 'TENANT', values: [] }];
  }

  return levels.flatMap((level) => {
    const values = grant.scope[level] ?? [];
    if (values.length === 0) return [];
    return [{ ...shared, level: level as GrantLevel, values }];
  });
}

/** Human label for a level. */
export function levelLabel(level: GrantLevel): string {
  return level === 'TENANT' ? 'Tenant' : LEVEL_LABEL[level];
}

/** A position plus the unit it hangs in, which is what the screen shows. */
async function withUnit(tx: Tx, client: string, position: PositionRef): Promise<PositionLine> {
  const unit = await orgUnitOfPosition(tx, client, position.code);
  return {
    code: position.code,
    title: position.title,
    orgUnitCode: unit?.code ?? null,
    orgUnitName: unit?.name ?? null,
  };
}

/**
 * The chart for one viewer.
 *
 * `subjectUserId` is validated against the computed line rather than trusted. A
 * person outside it yields no selection — never an error, which would tell the
 * caller that the user exists.
 */
export async function authorityChart(
  tx: Tx,
  client: string,
  viewerUserId: string,
  subjectUserId?: string,
): Promise<AuthorityChart> {
  const viewerPositions = await positionsOfUser(tx, client, viewerUserId);

  // The positions they hold and everything hanging below them.
  //
  // The viewer's own positions are in the set deliberately. Delegation is the act
  // of giving away authority you hold, so a superior who cannot open their own
  // card cannot see what they have to give; and the two panels that matter most
  // later — what they delegated away, and what is waiting on them to accept —
  // are mostly read about yourself.
  const below = new Set<string>(viewerPositions.map((p) => p.code));
  for (const held of viewerPositions) {
    for (const lower of await positionsBelow(tx, client, held.code)) {
      below.add(lower.code);
    }
  }

  // The people standing in those positions, the viewer among them.
  const people = new Map<string, { userId: string; username: string; fullName: string }>();
  for (const code of below) {
    for (const holder of await holdersOfPosition(tx, client, code)) {
      people.set(holder.userId, {
        userId: holder.userId,
        username: holder.username,
        fullName: holder.fullName,
      });
    }
  }

  const chart: AuthorityChart = {
    viewer: {
      userId: viewerUserId,
      fullName: (await displayName(tx, client, viewerUserId)) ?? viewerUserId,
      positions: await Promise.all(viewerPositions.map((p) => withUnit(tx, client, p))),
    },
    subjects: [],
    selected: null,
  };

  for (const person of people.values()) {
    const held = await positionsOfUser(tx, client, person.userId);
    const grants = await effectiveGrants(tx, client, person.userId);
    chart.subjects.push({
      userId: person.userId,
      username: person.username,
      fullName: person.fullName,
      positionCount: held.length,
      // Counted as lines, not grants, so the number beside a name in the list is
      // exactly the number of rows the reader finds when they open that person.
      // A grant covering two plants is two of both, or one of neither.
      grantCount: grants.reduce((total, grant) => total + grantLines(grant).length, 0),
    });
  }
  chart.subjects.sort((a, b) => a.fullName.localeCompare(b.fullName));

  if (!subjectUserId || !people.has(subjectUserId)) return chart;

  const subject = people.get(subjectUserId)!;
  const held = await positionsOfUser(tx, client, subjectUserId);
  const grants = await effectiveGrants(tx, client, subjectUserId);

  // The line above the nearest position held. Someone holding two positions has
  // two lines, and enumerating both would be noise on a screen whose question is
  // "who is above this person", so the first is the one shown.
  const superiorLine: SubjectCard['superiorLine'] = [];
  if (held.length > 0) {
    const line = await chainAbove(tx, client, held[0]!.code);
    for (const step of line.positions) {
      superiorLine.push({ kind: 'POSITION', label: `${step.code} · ${step.title}` });
    }
    if (line.orgUnit) {
      superiorLine.push({ kind: 'ORG_UNIT', label: `${line.orgUnit.code} · ${line.orgUnit.name}` });
    }
  }

  chart.selected = {
    userId: subject.userId,
    username: subject.username,
    fullName: subject.fullName,
    positions: await Promise.all(held.map((p) => withUnit(tx, client, p))),
    superiorLine,
    grants: grants.flatMap(grantLines),
    delegatedToThem: [],
    delegatedAway: [],
    pendingAcceptance: [],
  };

  return chart;
}

/**
 * The screen's entry point: opens the tenant-scoped transaction and reads the chart.
 *
 * This is deliberately a single transaction. The numbers on screen must agree
 * with each other — a person's grant count and the grants listed under them come
 * from the same instant — and one transaction is what makes that true without
 * any extra work.
 *
 * The cost is N+1 by construction: one round of queries per position below the
 * viewer, then two per person. That is correct for a reporting line, which is
 * tens of people, and it is the reason the line is bounded the way it is. A
 * tenant-wide read would need a different query, not a faster version of this
 * one, and belongs with the background work of a later phase rather than here.
 */
export function authorityChartFor(
  client: string,
  viewerUserId: string,
  subjectUserId?: string,
): Promise<AuthorityChart> {
  return withTenant(client, (tx) => authorityChart(tx, client, viewerUserId, subjectUserId));
}

/** The name to show for a user, or null when there is no such person. */
async function displayName(tx: Tx, client: string, userId: string): Promise<string | null> {
  const result = await tx.execute(sql`
    select full_name
      from app_user
     where id = ${userId} and client = ${client}
     limit 1
  `);
  const rows = (Array.isArray(result) ? result : []) as { full_name?: string }[];
  return rows[0]?.full_name ?? null;
}
