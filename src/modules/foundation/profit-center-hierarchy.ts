import { and, asc, eq } from 'drizzle-orm';

import { withTenant } from '../../platform/db/client';
import { listCostCenterAreas, type CostCenterArea } from './cost-center-definition';
import {
  profitCenter,
  profitCenterGroup,
  profitCenterGroupLeaf,
  profitCenterHierarchy,
  profitCenterNode,
  profitCenterNodeAssignment,
} from './schema';

export { listCostCenterAreas };
export type { CostCenterArea };

/**
 * Profit centre hierarchy — the read side (SCR-047a stage 1).
 *
 * The deferred step of KE51 (R-94), taken at SAP parity on all four
 * forks (R-95) in the exact shape SCR-042 proved for cost centres: the
 * **standard hierarchy** (KCH5N) — one tree per controlling area into
 * which profit centres are placed, strictly one parent per centre —
 * and **alternative groups** (KCH1) — many-to-many sets whose leaves
 * may be single centres, ranges, or exclusions. Storage keeps this
 * product's own table map (`profit_center_hierarchy`,
 * `profit_center_node`, and peers) rather than the reference set
 * framework and its set classes; group-in-group subsets are not built.
 *
 * Placement is **per validity period**: profit centres are
 * period-keyed since SCR-045, so a centre may stand in different nodes
 * in different eras — but in at most one node of its area at a time.
 * Group leaves resolve dynamically against the centre keys standing in
 * the area, in display order, exclusions removing what inclusions
 * added.
 *
 * Nothing rolls up over this tree yet: reports do not read it. The
 * screen says so.
 */
export const ACTIVITY = 'CFG.COST.PROFITCENTERHIER.DEFINE';

/** The practical depth the tree algorithms guard at (package figure). */
export const MAX_HIERARCHY_DEPTH = 10;

export interface HierarchyNodeRow {
  node: string;
  parentNode: string | null;
  title: string;
  displayOrder: number;
  depth: number;
  assignedPeriods: number;
}

export interface UnplacedPeriod {
  profitCenter: string;
  validFrom: string;
  validTo: string;
}

export interface PlacedPeriod {
  node: string;
  profitCenter: string;
  validFrom: string;
  validTo: string;
}

export interface GroupLeafRow {
  valSign: string;
  valOption: string;
  valFrom: string;
  valTo: string;
  displayOrder: number;
}

export interface GroupRow {
  groupName: string;
  title: string;
  leaves: GroupLeafRow[];
  /** Centre keys the leaves resolve to, in the order they were won. */
  members: string[];
}

export interface HierarchyView {
  hierarchyTitle: string | null;
  nodes: HierarchyNodeRow[];
  placements: PlacedPeriod[];
  unplacedPeriods: UnplacedPeriod[];
  groups: GroupRow[];
}

/** Flatten a sibling-ordered node set into display rows with depths. */
export function flattenNodes(
  nodes: Array<{ node: string; parentNode: string | null; title: string; displayOrder: number }>,
  assignedCounts: Map<string, number>,
): HierarchyNodeRow[] {
  const byParent = new Map<string, typeof nodes>();
  for (const node of nodes) {
    const key = node.parentNode ?? '';
    byParent.set(key, [...(byParent.get(key) ?? []), node]);
  }
  for (const siblings of byParent.values()) {
    siblings.sort((a, b) => a.displayOrder - b.displayOrder || a.node.localeCompare(b.node));
  }
  const rows: HierarchyNodeRow[] = [];
  const walk = (parentKey: string, depth: number) => {
    for (const node of byParent.get(parentKey) ?? []) {
      rows.push({ ...node, depth, assignedPeriods: assignedCounts.get(node.node) ?? 0 });
      if (depth < MAX_HIERARCHY_DEPTH) walk(node.node, depth + 1);
    }
  };
  walk('', 0);
  return rows;
}

/**
 * Resolve group leaves against the centre keys standing in an area:
 * in display order, inclusions add (EQ a single key, BT a code range),
 * exclusions remove. Membership is a resolution, not a stored fact.
 */
export function resolveGroupMembers(centreKeys: string[], leaves: GroupLeafRow[]): string[] {
  const ordered = [...leaves].sort(
    (a, b) => a.displayOrder - b.displayOrder || a.valFrom.localeCompare(b.valFrom),
  );
  const members: string[] = [];
  const matches = (leaf: GroupLeafRow, key: string) =>
    leaf.valOption === 'BT' ? key >= leaf.valFrom && key <= leaf.valTo : key === leaf.valFrom;
  for (const leaf of ordered) {
    for (const key of centreKeys) {
      if (!matches(leaf, key)) continue;
      if (leaf.valSign === 'I' && !members.includes(key)) members.push(key);
      if (leaf.valSign === 'E') {
        const at = members.indexOf(key);
        if (at >= 0) members.splice(at, 1);
      }
    }
  }
  return members;
}

export async function listHierarchy(
  clientId: string,
  area: string,
): Promise<HierarchyView> {
  const empty: HierarchyView = {
    hierarchyTitle: null,
    nodes: [],
    placements: [],
    unplacedPeriods: [],
    groups: [],
  };
  if (area === '') return empty;
  return withTenant(clientId, async (tx) => {
    const [hierarchy] = await tx
      .select({ title: profitCenterHierarchy.title })
      .from(profitCenterHierarchy)
      .where(eq(profitCenterHierarchy.controllingArea, area))
      .limit(1);
    const nodeRows = await tx
      .select({
        node: profitCenterNode.node,
        parentNode: profitCenterNode.parentNode,
        title: profitCenterNode.title,
        displayOrder: profitCenterNode.displayOrder,
      })
      .from(profitCenterNode)
      .where(eq(profitCenterNode.controllingArea, area))
      .orderBy(asc(profitCenterNode.node));
    const assignmentRows = await tx
      .select({
        node: profitCenterNodeAssignment.node,
        profitCenter: profitCenterNodeAssignment.profitCenter,
        validFrom: profitCenterNodeAssignment.validFrom,
        validTo: profitCenter.validTo,
      })
      .from(profitCenterNodeAssignment)
      .innerJoin(
        profitCenter,
        and(
          eq(profitCenterNodeAssignment.profitCenter, profitCenter.profitCenter),
          eq(profitCenterNodeAssignment.validFrom, profitCenter.validFrom),
        ),
      )
      .where(eq(profitCenterNodeAssignment.controllingArea, area))
      .orderBy(asc(profitCenterNodeAssignment.profitCenter), asc(profitCenterNodeAssignment.validFrom));

    const periods = await tx
      .select({
        profitCenter: profitCenter.profitCenter,
        validFrom: profitCenter.validFrom,
        validTo: profitCenter.validTo,
      })
      .from(profitCenter)
      .where(eq(profitCenter.controllingArea, area))
      .orderBy(asc(profitCenter.profitCenter), asc(profitCenter.validFrom));

    const assignedCounts = new Map<string, number>();
    for (const row of assignmentRows) {
      assignedCounts.set(row.node, (assignedCounts.get(row.node) ?? 0) + 1);
    }
    const placedKeys = new Set(assignmentRows.map((row) => `${row.profitCenter}:${row.validFrom}`));

    const groupRows = await tx
      .select({ groupName: profitCenterGroup.groupName, title: profitCenterGroup.title })
      .from(profitCenterGroup)
      .where(eq(profitCenterGroup.controllingArea, area))
      .orderBy(asc(profitCenterGroup.groupName));
    const leafRows = await tx
      .select({
        groupName: profitCenterGroupLeaf.groupName,
        valSign: profitCenterGroupLeaf.valSign,
        valOption: profitCenterGroupLeaf.valOption,
        valFrom: profitCenterGroupLeaf.valFrom,
        valTo: profitCenterGroupLeaf.valTo,
        displayOrder: profitCenterGroupLeaf.displayOrder,
      })
      .from(profitCenterGroupLeaf)
      .where(eq(profitCenterGroupLeaf.controllingArea, area))
      .orderBy(asc(profitCenterGroupLeaf.groupName), asc(profitCenterGroupLeaf.displayOrder));

    const centreKeys = [...new Set(periods.map((period) => period.profitCenter))].sort();

    return {
      hierarchyTitle: hierarchy?.title ?? null,
      nodes: flattenNodes(nodeRows, assignedCounts),
      placements: assignmentRows,
      unplacedPeriods: periods.filter(
        (period) => !placedKeys.has(`${period.profitCenter}:${period.validFrom}`),
      ),
      groups: groupRows.map((group) => {
        const leaves = leafRows
          .filter((leaf) => leaf.groupName === group.groupName)
          .map(({ groupName: _group, ...leaf }) => leaf);
        return { ...group, leaves, members: resolveGroupMembers(centreKeys, leaves) };
      }),
    };
  });
}

import { z } from 'zod';
import { count, inArray } from 'drizzle-orm';

import { recordChange } from '../../platform/change';
import { markActivityComplete } from '../../platform/tenancy';
import { configActivityStatus } from '../../platform/tables/registry';
import { controllingArea } from './schema';

/**
 * The write (SCR-047a stage 3; contract R-95).
 *
 * Nine acts over the two structures. The standard hierarchy: define its
 * header (one per controlling area), define and change nodes, delete
 * them, place periods, unplace them. Alternative groups: define and
 * change groups, delete them (their leaves go with them — a group is
 * nothing but its leaves), add and remove leaves.
 *
 * The judgements that matter:
 * — A period stands in **at most one node** of its area. Placing a period
 *   that stands somewhere names where; moving is unplace-then-place, so
 *   the audit trail shows both ends of a move.
 * — Parent links **cannot cycle** and the tree is **guarded at ten
 *   levels**: changing a parent is judged against the new ancestry and
 *   against the whole subtree it would carry down with it.
 * — Exactly **one root** per area: the first node defined is the root
 *   (parentless), and a second parentless node is refused.
 * — A node may be deleted only while **no child node and no placed
 *   period** stands under it, each count stated; deleting a group or
 *   unplacing a period **never touches the profit centre master** — the
 *   centre stands, only its placement goes.
 * — Group leaves are **dynamic**: an EQ leaf may name a centre that does
 *   not stand yet, and a range covers whatever stands between its ends;
 *   membership is what the leaves resolve to, not a stored fact.
 *
 * A **reason is mandatory on every write**, one change document per
 * write; placements are security-relevant (they decide what a rollup
 * charges where), as is a leaf's sign.
 */
export const OBJECT_CLASS_NODE = 'profit_center_node';
export const OBJECT_CLASS_ASSIGNMENT = 'profit_center_node_assignment';
export const OBJECT_CLASS_GROUP = 'profit_center_group';
export const OBJECT_CLASS_LEAF = 'profit_center_group_leaf';
const PREREQUISITES = ['CFG.COST.PROFITCENTER.DEFINE'] as const;

const key4 = (label: string) =>
  z
    .string()
    .trim()
    .transform((value) => value.toUpperCase())
    .pipe(z.string().regex(/^[A-Z0-9]{4}$/, `The ${label} is exactly four letters or digits.`));
const nodeKey = (label: string) =>
  z
    .string()
    .trim()
    .transform((value) => value.toUpperCase())
    .pipe(z.string().regex(/^[A-Z0-9]{1,24}$/, `The ${label} is up to 24 letters or digits.`));
const centreKey = z
  .string()
  .trim()
  .transform((value) => value.toUpperCase())
  .pipe(z.string().regex(/^[A-Z0-9]{1,10}$/, 'The Profit Centre is up to ten letters or digits.'));
const title40 = (label: string) =>
  z.string().trim().min(1, `The ${label} is required.`).max(40, `The ${label} is at most 40 characters.`);
const reasonField = z
  .string()
  .trim()
  .min(1, 'A reason is required.')
  .max(500, 'The reason is at most 500 characters.');
const actorFields = {
  client: z.string().regex(/^[A-Za-z0-9]{2,4}$/),
  changedBy: z.string().trim().min(1).max(60),
};
const dateValue = z
  .string()
  .trim()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Valid From is a date (YYYY-MM-DD).')
  .refine((value) => {
    const [year, month, day] = value.split('-').map(Number);
    const date = new Date(Date.UTC(year, month - 1, day));
    return (
      date.getUTCFullYear() === year &&
      date.getUTCMonth() === month - 1 &&
      date.getUTCDate() === day
    );
  }, 'Valid From is a real calendar date.');

export class ProfitCenterHierarchyError extends Error {
  readonly code = 'CAIRN_CONFIG';

  constructor(
    message: string,
    readonly remedy = 'Review the hierarchy and try again.',
  ) {
    super(message);
    this.name = 'ProfitCenterHierarchyError';
  }
}

type Tx = Parameters<Parameters<typeof withTenant>[1]>[0];

async function assertPrerequisites(tx: Tx, clientId: string): Promise<void> {
  const rows = await tx
    .select({ activityCode: configActivityStatus.activityCode })
    .from(configActivityStatus)
    .where(and(
      eq(configActivityStatus.client, clientId),
      inArray(configActivityStatus.activityCode, [...PREREQUISITES]),
      eq(configActivityStatus.status, 'COMPLETED'),
    ));
  const completed = new Set(rows.map((row) => row.activityCode));
  const missing = PREREQUISITES.filter((code) => !completed.has(code));
  if (missing.length > 0) {
    throw new ProfitCenterHierarchyError(
      `Hierarchy prerequisites are incomplete: ${missing.join(', ')}.`,
      'Define profit centres first: a hierarchy places profit centre periods, and there is nothing to place until they stand.',
    );
  }
}

async function assertArea(tx: Tx, clientId: string, area: string): Promise<void> {
  const [row] = await tx
    .select({ controllingArea: controllingArea.controllingArea })
    .from(controllingArea)
    .where(and(eq(controllingArea.client, clientId), eq(controllingArea.controllingArea, area)))
    .limit(1);
  if (!row) {
    throw new ProfitCenterHierarchyError(
      `Controlling Area ${area} is not defined in this tenant.`,
      'Choose a controlling area that stands; hierarchies live inside controlling areas.',
    );
  }
}

interface NodeShape {
  node: string;
  parentNode: string | null;
  title: string;
  displayOrder: number;
}

async function readNodes(tx: Tx, clientId: string, area: string): Promise<NodeShape[]> {
  return tx
    .select({
      node: profitCenterNode.node,
      parentNode: profitCenterNode.parentNode,
      title: profitCenterNode.title,
      displayOrder: profitCenterNode.displayOrder,
    })
    .from(profitCenterNode)
    .where(and(eq(profitCenterNode.client, clientId), eq(profitCenterNode.controllingArea, area)));
}

/** Depth of a node in a proposed tree (its own level, root = 1), or -1 on a cycle. */
function depthOf(parentMap: Map<string, string | null>, node: string): number {
  let depth = 1;
  let current: string | null = node;
  const seen = new Set<string>();
  while (current !== null) {
    if (seen.has(current)) return -1;
    seen.add(current);
    current = parentMap.get(current) ?? null;
    if (current !== null) depth += 1;
  }
  return depth;
}

/** Height of the subtree under a node in a proposed tree (the node itself = 1). */
function subtreeHeight(parentMap: Map<string, string | null>, node: string): number {
  const children = new Map<string, string[]>();
  for (const [child, parent] of parentMap) {
    if (parent) children.set(parent, [...(children.get(parent) ?? []), child]);
  }
  const walk = (current: string, seen: Set<string>): number => {
    if (seen.has(current)) return 0;
    seen.add(current);
    const below = children.get(current) ?? [];
    return 1 + (below.length ? Math.max(...below.map((child) => walk(child, seen))) : 0);
  };
  return walk(node, new Set());
}

/** Judge a proposed parent for a node against cycles, root uniqueness, and depth. */
function judgePlacement(
  nodes: NodeShape[],
  node: string,
  parentNode: string | null,
): ProfitCenterHierarchyError | null {
  const parentMap = new Map(nodes.map((entry) => [entry.node, entry.parentNode]));
  parentMap.set(node, parentNode);
  if (parentNode === null) {
    const otherRoot = nodes.find((entry) => entry.parentNode === null && entry.node !== node);
    if (otherRoot) {
      return new ProfitCenterHierarchyError(
        `The hierarchy already has root ${otherRoot.node}; Node ${node} cannot also stand parentless.`,
        'A standard hierarchy has exactly one root; place the node under an existing node instead.',
      );
    }
  }
  const depth = depthOf(parentMap, node);
  if (depth < 0) {
    return new ProfitCenterHierarchyError(
      `Placing Node ${node} under ${parentNode} would make the tree cycle through itself.`,
      'Choose a parent outside this node\'s own subtree; a hierarchy is a tree, not a loop.',
    );
  }
  const total = depth + subtreeHeight(parentMap, node) - 1;
  if (total > MAX_HIERARCHY_DEPTH) {
    return new ProfitCenterHierarchyError(
      `This placement would take the tree to ${total} levels; the hierarchy is guarded at ${MAX_HIERARCHY_DEPTH}.`,
      'Attach the node higher up, or move part of its subtree elsewhere first.',
    );
  }
  return null;
}

/* ── The hierarchy header ─────────────────────────────────────────────── */

export const hierarchyHeaderInputSchema = z
  .object({
    mode: z.enum(['CREATE', 'CHANGE']),
    controllingArea: key4('Controlling Area'),
    title: title40('Title'),
    reason: reasonField,
  })
  .extend(actorFields)
  .strict();
export type HierarchyHeaderInput = z.input<typeof hierarchyHeaderInputSchema>;

export async function saveHierarchyHeader(raw: HierarchyHeaderInput): Promise<{ changed: boolean }> {
  const parsed = hierarchyHeaderInputSchema.safeParse(raw);
  if (!parsed.success) throw invalid(parsed.error.issues[0]?.message);
  const { client, changedBy, reason, ...values } = parsed.data;

  return withTenant(client, async (tx) => {
    await assertPrerequisites(tx, client);
    await assertArea(tx, client, values.controllingArea);
    const [existing] = await tx
      .select()
      .from(profitCenterHierarchy)
      .where(and(
        eq(profitCenterHierarchy.client, client),
        eq(profitCenterHierarchy.controllingArea, values.controllingArea),
      ))
      .for('update');
    if (values.mode === 'CREATE' && existing) {
      throw new ProfitCenterHierarchyError(
        `A hierarchy is already defined for Controlling Area ${values.controllingArea}.`,
        'Change the hierarchy that exists; there is one standard hierarchy per controlling area.',
      );
    }
    if (values.mode === 'CHANGE' && !existing) {
      throw new ProfitCenterHierarchyError(
        `No hierarchy is defined for Controlling Area ${values.controllingArea}.`,
        'Define the hierarchy first; its header cannot be changed into existence.',
      );
    }
    const objectKey = values.controllingArea;
    if (values.mode === 'CREATE') {
      await tx.insert(profitCenterHierarchy).values({
        client,
        controllingArea: values.controllingArea,
        title: values.title,
        createdBy: changedBy,
      });
      await recordChange(tx, {
        client,
        objectClass: 'profit_center_hierarchy',
        objectKey,
        changeType: 'CREATE',
        changedBy,
        transactionCode: ACTIVITY,
        reason,
        after: { controllingArea: values.controllingArea, title: values.title },
        fieldLabels: { controllingArea: 'Controlling area', title: 'Title' },
      });
      await markActivityComplete(tx, client, ACTIVITY, changedBy);
      return { changed: true };
    }
    if (existing.title === values.title) {
      await markActivityComplete(tx, client, ACTIVITY, changedBy);
      return { changed: false };
    }
    await tx
      .update(profitCenterHierarchy)
      .set({ title: values.title, changedBy, changedAt: new Date() })
      .where(and(
        eq(profitCenterHierarchy.client, client),
        eq(profitCenterHierarchy.controllingArea, values.controllingArea),
      ));
    await recordChange(tx, {
      client,
      objectClass: 'profit_center_hierarchy',
      objectKey,
      changeType: 'CHANGE',
      changedBy,
      transactionCode: ACTIVITY,
      reason,
      before: { title: existing.title },
      after: { title: values.title },
      fieldLabels: { title: 'Title' },
    });
    await markActivityComplete(tx, client, ACTIVITY, changedBy);
    return { changed: true };
  });
}

/* ── Nodes ────────────────────────────────────────────────────────────── */

export const hierarchyNodeInputSchema = z
  .object({
    mode: z.enum(['CREATE', 'CHANGE']),
    controllingArea: key4('Controlling Area'),
    node: nodeKey('Node'),
    parentNode: z
      .string()
      .trim()
      .transform((value) => value.toUpperCase())
      .pipe(z.string().regex(/^([A-Z0-9]{1,24})?$/, 'The Parent Node is up to 24 letters or digits, or blank for the root.'))
      .transform((value) => (value === '' ? null : value)),
    title: title40('Title'),
    displayOrder: z.coerce.number().int().min(-9999).max(9999),
    reason: reasonField,
  })
  .extend(actorFields)
  .strict();
export type HierarchyNodeInput = z.input<typeof hierarchyNodeInputSchema>;

const NODE_LABELS = { parentNode: 'Parent node', title: 'Title', displayOrder: 'Display order' } as const;

export async function saveHierarchyNode(raw: HierarchyNodeInput): Promise<{ changed: boolean }> {
  const parsed = hierarchyNodeInputSchema.safeParse(raw);
  if (!parsed.success) throw invalid(parsed.error.issues[0]?.message);
  const { client, changedBy, reason, ...values } = parsed.data;

  return withTenant(client, async (tx) => {
    await assertPrerequisites(tx, client);
    await assertArea(tx, client, values.controllingArea);
    await assertHierarchy(tx, client, values.controllingArea);

    const nodes = await readNodes(tx, client, values.controllingArea);
    const existing = nodes.find((entry) => entry.node === values.node);
    if (values.mode === 'CREATE' && existing) {
      throw new ProfitCenterHierarchyError(
        `Node ${values.node} is already defined in this hierarchy.`,
        'Change the node that exists, or choose another node key.',
      );
    }
    if (values.mode === 'CHANGE' && !existing) {
      throw new ProfitCenterHierarchyError(
        `Node ${values.node} is not defined in this hierarchy.`,
        'Define the node first; a node key cannot be changed into existence.',
      );
    }
    if (values.parentNode !== null && values.parentNode === values.node) {
      throw new ProfitCenterHierarchyError(
        `Node ${values.node} cannot be its own parent.`,
        'Choose another parent, or leave the parent blank for the root.',
      );
    }
    if (values.parentNode !== null && !nodes.some((entry) => entry.node === values.parentNode)) {
      throw new ProfitCenterHierarchyError(
        `Parent Node ${values.parentNode} is not defined in this hierarchy.`,
        'Define the parent first, or choose a node that stands.',
      );
    }
    const placementError = judgePlacement(nodes, values.node, values.parentNode);
    if (placementError) throw placementError;

    const objectKey = `${values.controllingArea}/${values.node}`;
    const stored = {
      parentNode: values.parentNode,
      title: values.title,
      displayOrder: values.displayOrder,
    };
    if (values.mode === 'CREATE') {
      await tx.insert(profitCenterNode).values({
        client,
        controllingArea: values.controllingArea,
        node: values.node,
        ...stored,
        createdBy: changedBy,
      });
      await recordChange(tx, {
        client,
        objectClass: OBJECT_CLASS_NODE,
        objectKey,
        changeType: 'CREATE',
        changedBy,
        transactionCode: ACTIVITY,
        reason,
        after: { controllingArea: values.controllingArea, node: values.node, ...stored },
        fieldLabels: { controllingArea: 'Controlling area', node: 'Node', ...NODE_LABELS },
      });
      await markActivityComplete(tx, client, ACTIVITY, changedBy);
      return { changed: true };
    }
    if (!existing) throw invalid('The node changed under this request.');
    if (
      existing.parentNode === stored.parentNode &&
      existing.title === stored.title &&
      existing.displayOrder === stored.displayOrder
    ) {
      await markActivityComplete(tx, client, ACTIVITY, changedBy);
      return { changed: false };
    }
    await tx
      .update(profitCenterNode)
      .set({ ...stored, changedBy, changedAt: new Date() })
      .where(and(
        eq(profitCenterNode.client, client),
        eq(profitCenterNode.controllingArea, values.controllingArea),
        eq(profitCenterNode.node, values.node),
      ));
    await recordChange(tx, {
      client,
      objectClass: OBJECT_CLASS_NODE,
      objectKey,
      changeType: 'CHANGE',
      changedBy,
      transactionCode: ACTIVITY,
      reason,
      before: {
        parentNode: existing.parentNode,
        title: existing.title,
        displayOrder: existing.displayOrder,
      },
      after: { ...stored },
      fieldLabels: NODE_LABELS,
      securityRelevantFields: ['parentNode'],
    });
    await markActivityComplete(tx, client, ACTIVITY, changedBy);
    return { changed: true };
  });
}

async function assertHierarchy(tx: Tx, clientId: string, area: string): Promise<void> {
  const [row] = await tx
    .select({ controllingArea: profitCenterHierarchy.controllingArea })
    .from(profitCenterHierarchy)
    .where(and(
      eq(profitCenterHierarchy.client, clientId),
      eq(profitCenterHierarchy.controllingArea, area),
    ))
    .limit(1);
  if (!row) {
    throw new ProfitCenterHierarchyError(
      `No hierarchy is defined for Controlling Area ${area}.`,
      'Define the hierarchy header first; nodes and groups hang from it.',
    );
  }
}

export const hierarchyDeleteInputSchema = z
  .object({
    controllingArea: key4('Controlling Area'),
    node: nodeKey('Node'),
    reason: reasonField,
  })
  .extend(actorFields)
  .strict();
export type HierarchyNodeDeleteInput = z.input<typeof hierarchyDeleteInputSchema>;

export async function deleteHierarchyNode(raw: HierarchyNodeDeleteInput): Promise<{ deleted: true }> {
  const parsed = hierarchyDeleteInputSchema.safeParse(raw);
  if (!parsed.success) throw invalid(parsed.error.issues[0]?.message);
  const { client, changedBy, reason, ...values } = parsed.data;

  return withTenant(client, async (tx) => {
    await assertPrerequisites(tx, client);
    const nodes = await readNodes(tx, client, values.controllingArea);
    const existing = nodes.find((entry) => entry.node === values.node);
    if (!existing) {
      throw new ProfitCenterHierarchyError(
        `Node ${values.node} is not defined in this hierarchy.`,
        'Reload the hierarchy; the node may already have been deleted.',
      );
    }
    const children = nodes.filter((entry) => entry.parentNode === values.node).length;
    if (children > 0) {
      throw new ProfitCenterHierarchyError(
        `Node ${values.node} still carries ${children} child node${children === 1 ? '' : 's'} and cannot be deleted.`,
        'Delete or reparent the child nodes first; a node goes only when nothing stands under it.',
      );
    }
    const [{ placed }] = await tx
      .select({ placed: count() })
      .from(profitCenterNodeAssignment)
      .where(and(
        eq(profitCenterNodeAssignment.client, client),
        eq(profitCenterNodeAssignment.controllingArea, values.controllingArea),
        eq(profitCenterNodeAssignment.node, values.node),
      ));
    if (placed > 0) {
      throw new ProfitCenterHierarchyError(
        `Node ${values.node} still carries ${placed} placed period${placed === 1 ? '' : 's'} and cannot be deleted.`,
        'Unassign the periods first; deleting a node never touches the profit centres themselves, only their placement.',
      );
    }
    await tx
      .delete(profitCenterNode)
      .where(and(
        eq(profitCenterNode.client, client),
        eq(profitCenterNode.controllingArea, values.controllingArea),
        eq(profitCenterNode.node, values.node),
      ));
    await recordChange(tx, {
      client,
      objectClass: OBJECT_CLASS_NODE,
      objectKey: `${values.controllingArea}/${values.node}`,
      changeType: 'DELETE',
      changedBy,
      transactionCode: ACTIVITY,
      reason,
      before: {
        controllingArea: values.controllingArea,
        node: values.node,
        parentNode: existing.parentNode,
        title: existing.title,
        displayOrder: existing.displayOrder,
      },
      fieldLabels: { controllingArea: 'Controlling area', node: 'Node', ...NODE_LABELS },
    });
    await markActivityComplete(tx, client, ACTIVITY, changedBy);
    return { deleted: true as const };
  });
}

/* ── Period placement ─────────────────────────────────────────────────── */

export const periodPlacementInputSchema = z
  .object({
    controllingArea: key4('Controlling Area'),
    node: nodeKey('Node'),
    profitCenter: centreKey,
    validFrom: dateValue,
    reason: reasonField,
  })
  .extend(actorFields)
  .strict();
export type PeriodPlacementInput = z.input<typeof periodPlacementInputSchema>;

export async function placeProfitCenterPeriod(raw: PeriodPlacementInput): Promise<{ placed: true }> {
  const parsed = periodPlacementInputSchema.safeParse(raw);
  if (!parsed.success) throw invalid(parsed.error.issues[0]?.message);
  const { client, changedBy, reason, ...values } = parsed.data;

  return withTenant(client, async (tx) => {
    await assertPrerequisites(tx, client);
    await assertHierarchy(tx, client, values.controllingArea);
    const nodes = await readNodes(tx, client, values.controllingArea);
    if (!nodes.some((entry) => entry.node === values.node)) {
      throw new ProfitCenterHierarchyError(
        `Node ${values.node} is not defined in this hierarchy.`,
        'Choose a node that stands.',
      );
    }
    const [period] = await tx
      .select({ profitCenter: profitCenter.profitCenter })
      .from(profitCenter)
      .where(and(
        eq(profitCenter.client, client),
        eq(profitCenter.controllingArea, values.controllingArea),
        eq(profitCenter.profitCenter, values.profitCenter),
        eq(profitCenter.validFrom, values.validFrom),
      ))
      .limit(1);
    if (!period) {
      throw new ProfitCenterHierarchyError(
        `Profit Centre ${values.profitCenter} has no period from ${values.validFrom} in Controlling Area ${values.controllingArea}.`,
        'Place a period that stands; the hierarchy places periods, not centre names.',
      );
    }
    const [standing] = await tx
      .select({ node: profitCenterNodeAssignment.node })
      .from(profitCenterNodeAssignment)
      .where(and(
        eq(profitCenterNodeAssignment.client, client),
        eq(profitCenterNodeAssignment.controllingArea, values.controllingArea),
        eq(profitCenterNodeAssignment.profitCenter, values.profitCenter),
        eq(profitCenterNodeAssignment.validFrom, values.validFrom),
      ))
      .limit(1);
    if (standing) {
      throw new ProfitCenterHierarchyError(
        `Profit Centre ${values.profitCenter} from ${values.validFrom} already stands in Node ${standing.node}.`,
        'A period stands in one node; unassign it there first, then place it here — the trail shows both ends of the move.',
      );
    }
    await tx.insert(profitCenterNodeAssignment).values({
      client,
      controllingArea: values.controllingArea,
      node: values.node,
      profitCenter: values.profitCenter,
      validFrom: values.validFrom,
      createdBy: changedBy,
    });
    await recordChange(tx, {
      client,
      objectClass: OBJECT_CLASS_ASSIGNMENT,
      objectKey: `${values.controllingArea}/${values.profitCenter}/${values.validFrom}`,
      changeType: 'CREATE',
      changedBy,
      transactionCode: ACTIVITY,
      reason,
      after: {
        controllingArea: values.controllingArea,
        node: values.node,
        profitCenter: values.profitCenter,
        validFrom: values.validFrom,
      },
      fieldLabels: {
        controllingArea: 'Controlling area',
        node: 'Node',
        profitCenter: 'Profit centre',
        validFrom: 'Valid from',
      },
      securityRelevantFields: ['node'],
    });
    await markActivityComplete(tx, client, ACTIVITY, changedBy);
    return { placed: true as const };
  });
}

export async function unplaceProfitCenterPeriod(raw: PeriodPlacementInput): Promise<{ removed: true }> {
  const parsed = periodPlacementInputSchema.safeParse(raw);
  if (!parsed.success) throw invalid(parsed.error.issues[0]?.message);
  const { client, changedBy, reason, ...values } = parsed.data;

  return withTenant(client, async (tx) => {
    await assertPrerequisites(tx, client);
    const [standing] = await tx
      .select({ node: profitCenterNodeAssignment.node })
      .from(profitCenterNodeAssignment)
      .where(and(
        eq(profitCenterNodeAssignment.client, client),
        eq(profitCenterNodeAssignment.controllingArea, values.controllingArea),
        eq(profitCenterNodeAssignment.profitCenter, values.profitCenter),
        eq(profitCenterNodeAssignment.validFrom, values.validFrom),
      ))
      .limit(1);
    if (!standing || standing.node !== values.node) {
      throw new ProfitCenterHierarchyError(
        `Profit Centre ${values.profitCenter} from ${values.validFrom} does not stand in Node ${values.node}.`,
        'Reload the placements; the period may already have been unassigned or moved.',
      );
    }
    await tx
      .delete(profitCenterNodeAssignment)
      .where(and(
        eq(profitCenterNodeAssignment.client, client),
        eq(profitCenterNodeAssignment.controllingArea, values.controllingArea),
        eq(profitCenterNodeAssignment.node, values.node),
        eq(profitCenterNodeAssignment.profitCenter, values.profitCenter),
        eq(profitCenterNodeAssignment.validFrom, values.validFrom),
      ));
    await recordChange(tx, {
      client,
      objectClass: OBJECT_CLASS_ASSIGNMENT,
      objectKey: `${values.controllingArea}/${values.profitCenter}/${values.validFrom}`,
      changeType: 'DELETE',
      changedBy,
      transactionCode: ACTIVITY,
      reason,
      before: {
        controllingArea: values.controllingArea,
        node: values.node,
        profitCenter: values.profitCenter,
        validFrom: values.validFrom,
      },
      fieldLabels: {
        controllingArea: 'Controlling area',
        node: 'Node',
        profitCenter: 'Profit centre',
        validFrom: 'Valid from',
      },
      securityRelevantFields: ['node'],
    });
    await markActivityComplete(tx, client, ACTIVITY, changedBy);
    return { removed: true as const };
  });
}

/* ── Alternative groups ───────────────────────────────────────────────── */

export const profitCenterGroupInputSchema = z
  .object({
    mode: z.enum(['CREATE', 'CHANGE']),
    controllingArea: key4('Controlling Area'),
    groupName: nodeKey('Group'),
    title: title40('Title'),
    reason: reasonField,
  })
  .extend(actorFields)
  .strict();
export type ProfitCenterGroupInput = z.input<typeof profitCenterGroupInputSchema>;

export async function saveProfitCenterGroup(raw: ProfitCenterGroupInput): Promise<{ changed: boolean }> {
  const parsed = profitCenterGroupInputSchema.safeParse(raw);
  if (!parsed.success) throw invalid(parsed.error.issues[0]?.message);
  const { client, changedBy, reason, ...values } = parsed.data;

  return withTenant(client, async (tx) => {
    await assertPrerequisites(tx, client);
    await assertArea(tx, client, values.controllingArea);
    const [existing] = await tx
      .select()
      .from(profitCenterGroup)
      .where(and(
        eq(profitCenterGroup.client, client),
        eq(profitCenterGroup.controllingArea, values.controllingArea),
        eq(profitCenterGroup.groupName, values.groupName),
      ))
      .for('update');
    if (values.mode === 'CREATE' && existing) {
      throw new ProfitCenterHierarchyError(
        `Group ${values.groupName} is already defined in Controlling Area ${values.controllingArea}.`,
        'Change the group that exists, or choose another group name.',
      );
    }
    if (values.mode === 'CHANGE' && !existing) {
      throw new ProfitCenterHierarchyError(
        `Group ${values.groupName} is not defined in Controlling Area ${values.controllingArea}.`,
        'Define the group first; a group name cannot be changed into existence.',
      );
    }
    const objectKey = `${values.controllingArea}/${values.groupName}`;
    if (values.mode === 'CREATE') {
      await tx.insert(profitCenterGroup).values({
        client,
        controllingArea: values.controllingArea,
        groupName: values.groupName,
        title: values.title,
        createdBy: changedBy,
      });
      await recordChange(tx, {
        client,
        objectClass: OBJECT_CLASS_GROUP,
        objectKey,
        changeType: 'CREATE',
        changedBy,
        transactionCode: ACTIVITY,
        reason,
        after: {
          controllingArea: values.controllingArea,
          groupName: values.groupName,
          title: values.title,
        },
        fieldLabels: { controllingArea: 'Controlling area', groupName: 'Group', title: 'Title' },
      });
      await markActivityComplete(tx, client, ACTIVITY, changedBy);
      return { changed: true };
    }
    if (existing.title === values.title) {
      await markActivityComplete(tx, client, ACTIVITY, changedBy);
      return { changed: false };
    }
    await tx
      .update(profitCenterGroup)
      .set({ title: values.title, changedBy, changedAt: new Date() })
      .where(and(
        eq(profitCenterGroup.client, client),
        eq(profitCenterGroup.controllingArea, values.controllingArea),
        eq(profitCenterGroup.groupName, values.groupName),
      ));
    await recordChange(tx, {
      client,
      objectClass: OBJECT_CLASS_GROUP,
      objectKey,
      changeType: 'CHANGE',
      changedBy,
      transactionCode: ACTIVITY,
      reason,
      before: { title: existing.title },
      after: { title: values.title },
      fieldLabels: { title: 'Title' },
    });
    await markActivityComplete(tx, client, ACTIVITY, changedBy);
    return { changed: true };
  });
}

export const profitCenterGroupDeleteInputSchema = z
  .object({
    controllingArea: key4('Controlling Area'),
    groupName: nodeKey('Group'),
    reason: reasonField,
  })
  .extend(actorFields)
  .strict();
export type ProfitCenterGroupDeleteInput = z.input<typeof profitCenterGroupDeleteInputSchema>;

export async function deleteProfitCenterGroup(
  raw: ProfitCenterGroupDeleteInput,
): Promise<{ deleted: true; leaves: number }> {
  const parsed = profitCenterGroupDeleteInputSchema.safeParse(raw);
  if (!parsed.success) throw invalid(parsed.error.issues[0]?.message);
  const { client, changedBy, reason, ...values } = parsed.data;

  return withTenant(client, async (tx) => {
    await assertPrerequisites(tx, client);
    const [existing] = await tx
      .select()
      .from(profitCenterGroup)
      .where(and(
        eq(profitCenterGroup.client, client),
        eq(profitCenterGroup.controllingArea, values.controllingArea),
        eq(profitCenterGroup.groupName, values.groupName),
      ))
      .for('update');
    if (!existing) {
      throw new ProfitCenterHierarchyError(
        `Group ${values.groupName} is not defined in Controlling Area ${values.controllingArea}.`,
        'Reload the groups; the group may already have been deleted.',
      );
    }
    const leaves = await tx
      .select()
      .from(profitCenterGroupLeaf)
      .where(and(
        eq(profitCenterGroupLeaf.client, client),
        eq(profitCenterGroupLeaf.controllingArea, values.controllingArea),
        eq(profitCenterGroupLeaf.groupName, values.groupName),
      ));
    // A group is nothing but its leaves: they go with it, in the one document.
    await tx
      .delete(profitCenterGroupLeaf)
      .where(and(
        eq(profitCenterGroupLeaf.client, client),
        eq(profitCenterGroupLeaf.controllingArea, values.controllingArea),
        eq(profitCenterGroupLeaf.groupName, values.groupName),
      ));
    await tx
      .delete(profitCenterGroup)
      .where(and(
        eq(profitCenterGroup.client, client),
        eq(profitCenterGroup.controllingArea, values.controllingArea),
        eq(profitCenterGroup.groupName, values.groupName),
      ));
    await recordChange(tx, {
      client,
      objectClass: OBJECT_CLASS_GROUP,
      objectKey: `${values.controllingArea}/${values.groupName}`,
      changeType: 'DELETE',
      changedBy,
      transactionCode: ACTIVITY,
      reason,
      before: {
        controllingArea: values.controllingArea,
        groupName: values.groupName,
        title: existing.title,
        leaves: leaves.length,
      },
      fieldLabels: {
        controllingArea: 'Controlling area',
        groupName: 'Group',
        title: 'Title',
        leaves: 'Leaves removed',
      },
    });
    await markActivityComplete(tx, client, ACTIVITY, changedBy);
    return { deleted: true as const, leaves: leaves.length };
  });
}

export const groupLeafInputSchema = z
  .object({
    controllingArea: key4('Controlling Area'),
    groupName: nodeKey('Group'),
    valSign: z.enum(['I', 'E']),
    valOption: z.enum(['EQ', 'BT']),
    valFrom: centreKey,
    valTo: z
      .string()
      .trim()
      .transform((value) => value.toUpperCase())
      .pipe(z.string().regex(/^([A-Z0-9]{1,10})?$/, 'To Centre is up to ten letters or digits.')),
    displayOrder: z.coerce.number().int().min(-9999).max(9999),
    reason: reasonField,
  })
  .extend(actorFields)
  .strict();
export type GroupLeafInput = z.input<typeof groupLeafInputSchema>;

const LEAF_LABELS = {
  valSign: 'Sign (I include / E exclude)',
  valOption: 'Option (EQ single / BT range)',
  valFrom: 'From centre',
  valTo: 'To centre',
  displayOrder: 'Display order',
} as const;

function leafKey(values: { controllingArea: string; groupName: string; valSign: string; valOption: string; valFrom: string; valTo: string }): string {
  return `${values.controllingArea}/${values.groupName}/${values.valSign}${values.valOption}:${values.valFrom}${values.valTo ? `..${values.valTo}` : ''}`;
}

export async function addGroupLeaf(raw: GroupLeafInput): Promise<{ added: true }> {
  const parsed = groupLeafInputSchema.safeParse(raw);
  if (!parsed.success) throw invalid(parsed.error.issues[0]?.message);
  const { client, changedBy, reason, ...values } = parsed.data;

  if (values.valOption === 'EQ' && values.valTo !== '') {
    throw new ProfitCenterHierarchyError(
      'A single-centre leaf (EQ) names no upper end.',
      'Clear To Centre, or choose the range option (BT) to span centres.',
    );
  }
  if (values.valOption === 'BT' && (values.valTo === '' || values.valTo < values.valFrom)) {
    throw new ProfitCenterHierarchyError(
      'A range leaf (BT) names an ordered pair of centres.',
      'Set To Centre on or after From Centre.',
    );
  }

  return withTenant(client, async (tx) => {
    await assertPrerequisites(tx, client);
    const [group] = await tx
      .select({ groupName: profitCenterGroup.groupName })
      .from(profitCenterGroup)
      .where(and(
        eq(profitCenterGroup.client, client),
        eq(profitCenterGroup.controllingArea, values.controllingArea),
        eq(profitCenterGroup.groupName, values.groupName),
      ))
      .limit(1);
    if (!group) {
      throw new ProfitCenterHierarchyError(
        `Group ${values.groupName} is not defined in Controlling Area ${values.controllingArea}.`,
        'Define the group first; leaves hang from groups.',
      );
    }
    const [existing] = await tx
      .select({ valFrom: profitCenterGroupLeaf.valFrom })
      .from(profitCenterGroupLeaf)
      .where(and(
        eq(profitCenterGroupLeaf.client, client),
        eq(profitCenterGroupLeaf.controllingArea, values.controllingArea),
        eq(profitCenterGroupLeaf.groupName, values.groupName),
        eq(profitCenterGroupLeaf.valSign, values.valSign),
        eq(profitCenterGroupLeaf.valOption, values.valOption),
        eq(profitCenterGroupLeaf.valFrom, values.valFrom),
        eq(profitCenterGroupLeaf.valTo, values.valTo),
      ))
      .limit(1);
    if (existing) {
      throw new ProfitCenterHierarchyError(
        'This leaf already stands in the group.',
        'Remove the leaf first, or add a different one; a leaf stands once per group.',
      );
    }
    await tx.insert(profitCenterGroupLeaf).values({
      client,
      controllingArea: values.controllingArea,
      groupName: values.groupName,
      valSign: values.valSign,
      valOption: values.valOption,
      valFrom: values.valFrom,
      valTo: values.valTo,
      displayOrder: values.displayOrder,
      createdBy: changedBy,
    });
    await recordChange(tx, {
      client,
      objectClass: OBJECT_CLASS_LEAF,
      objectKey: leafKey(values),
      changeType: 'CREATE',
      changedBy,
      transactionCode: ACTIVITY,
      reason,
      after: { controllingArea: values.controllingArea, groupName: values.groupName, ...pickLeaf(values) },
      fieldLabels: { controllingArea: 'Controlling area', groupName: 'Group', ...LEAF_LABELS },
      securityRelevantFields: ['valSign'],
    });
    await markActivityComplete(tx, client, ACTIVITY, changedBy);
    return { added: true as const };
  });
}

function pickLeaf(values: { valSign: string; valOption: string; valFrom: string; valTo: string; displayOrder: number }) {
  return {
    valSign: values.valSign,
    valOption: values.valOption,
    valFrom: values.valFrom,
    valTo: values.valTo,
    displayOrder: values.displayOrder,
  };
}

export async function removeGroupLeaf(raw: GroupLeafInput): Promise<{ removed: true }> {
  const parsed = groupLeafInputSchema.safeParse(raw);
  if (!parsed.success) throw invalid(parsed.error.issues[0]?.message);
  const { client, changedBy, reason, ...values } = parsed.data;

  return withTenant(client, async (tx) => {
    await assertPrerequisites(tx, client);
    const [existing] = await tx
      .select()
      .from(profitCenterGroupLeaf)
      .where(and(
        eq(profitCenterGroupLeaf.client, client),
        eq(profitCenterGroupLeaf.controllingArea, values.controllingArea),
        eq(profitCenterGroupLeaf.groupName, values.groupName),
        eq(profitCenterGroupLeaf.valSign, values.valSign),
        eq(profitCenterGroupLeaf.valOption, values.valOption),
        eq(profitCenterGroupLeaf.valFrom, values.valFrom),
        eq(profitCenterGroupLeaf.valTo, values.valTo),
      ))
      .limit(1);
    if (!existing) {
      throw new ProfitCenterHierarchyError(
        'This leaf does not stand in the group.',
        'Reload the group; the leaf may already have been removed.',
      );
    }
    await tx
      .delete(profitCenterGroupLeaf)
      .where(and(
        eq(profitCenterGroupLeaf.client, client),
        eq(profitCenterGroupLeaf.controllingArea, values.controllingArea),
        eq(profitCenterGroupLeaf.groupName, values.groupName),
        eq(profitCenterGroupLeaf.valSign, values.valSign),
        eq(profitCenterGroupLeaf.valOption, values.valOption),
        eq(profitCenterGroupLeaf.valFrom, values.valFrom),
        eq(profitCenterGroupLeaf.valTo, values.valTo),
      ));
    await recordChange(tx, {
      client,
      objectClass: OBJECT_CLASS_LEAF,
      objectKey: leafKey(values),
      changeType: 'DELETE',
      changedBy,
      transactionCode: ACTIVITY,
      reason,
      before: { controllingArea: values.controllingArea, groupName: values.groupName, ...pickLeaf(values) },
      fieldLabels: { controllingArea: 'Controlling area', groupName: 'Group', ...LEAF_LABELS },
      securityRelevantFields: ['valSign'],
    });
    await markActivityComplete(tx, client, ACTIVITY, changedBy);
    return { removed: true as const };
  });
}

function invalid(message?: string): ProfitCenterHierarchyError {
  return new ProfitCenterHierarchyError(
    message ?? 'The hierarchy entry is not valid.',
    'Correct the indicated value and submit again.',
  );
}
