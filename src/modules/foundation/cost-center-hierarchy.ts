import { and, asc, eq } from 'drizzle-orm';

import { withTenant } from '../../platform/db/client';
import { listCostCenterAreas, type CostCenterArea } from './cost-center-definition';
import {
  costCenter,
  costCenterGroup,
  costCenterGroupLeaf,
  costCenterHierarchy,
  costCenterNode,
  costCenterNodeAssignment,
} from './schema';

export { listCostCenterAreas };
export type { CostCenterArea };

/**
 * Cost centre hierarchy — the read side (SCR-042 stage 1).
 *
 * The reference system carries hierarchy twice, and the owner took parity
 * in both shapes (R-91): the **standard hierarchy** (OKEON) — one tree per
 * controlling area into which cost centres are placed, strictly one parent
 * per centre — and **alternative groups** (KSH1) — many-to-many sets whose
 * leaves may be single centres, ranges, or exclusions. Storage keeps this
 * product's own table map (`cost_center_hierarchy`, `cost_center_node`,
 * per §10's design) rather than the generic set framework and its set
 * classes; group-in-group subsets are not built.
 *
 * Placement is **per validity period**: cost centres are period-keyed
 * since SCR-041, and in the reference each period row carries its own
 * hierarchy area, so a centre may stand in different nodes in different
 * eras — but in at most one node of its area at a time. Group leaves
 * resolve dynamically against the centre keys standing in the area, in
 * display order, exclusions removing what inclusions added.
 *
 * Nothing rolls up over this tree yet: reports do not read it. The screen
 * says so.
 */
export const ACTIVITY = 'CFG.COST.COSTCENTERHIER.DEFINE';

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
  costCenter: string;
  validFrom: string;
  validTo: string;
}

export interface PlacedPeriod {
  node: string;
  costCenter: string;
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
      .select({ title: costCenterHierarchy.title })
      .from(costCenterHierarchy)
      .where(eq(costCenterHierarchy.controllingArea, area))
      .limit(1);
    const nodeRows = await tx
      .select({
        node: costCenterNode.node,
        parentNode: costCenterNode.parentNode,
        title: costCenterNode.title,
        displayOrder: costCenterNode.displayOrder,
      })
      .from(costCenterNode)
      .where(eq(costCenterNode.controllingArea, area))
      .orderBy(asc(costCenterNode.node));
    const assignmentRows = await tx
      .select({
        node: costCenterNodeAssignment.node,
        costCenter: costCenterNodeAssignment.costCenter,
        validFrom: costCenterNodeAssignment.validFrom,
        validTo: costCenter.validTo,
      })
      .from(costCenterNodeAssignment)
      .innerJoin(
        costCenter,
        and(
          eq(costCenterNodeAssignment.costCenter, costCenter.costCenter),
          eq(costCenterNodeAssignment.validFrom, costCenter.validFrom),
        ),
      )
      .where(eq(costCenterNodeAssignment.controllingArea, area))
      .orderBy(asc(costCenterNodeAssignment.costCenter), asc(costCenterNodeAssignment.validFrom));

    const periods = await tx
      .select({
        costCenter: costCenter.costCenter,
        validFrom: costCenter.validFrom,
        validTo: costCenter.validTo,
      })
      .from(costCenter)
      .where(eq(costCenter.controllingArea, area))
      .orderBy(asc(costCenter.costCenter), asc(costCenter.validFrom));

    const assignedCounts = new Map<string, number>();
    for (const row of assignmentRows) {
      assignedCounts.set(row.node, (assignedCounts.get(row.node) ?? 0) + 1);
    }
    const placedKeys = new Set(assignmentRows.map((row) => `${row.costCenter}:${row.validFrom}`));

    const groupRows = await tx
      .select({ groupName: costCenterGroup.groupName, title: costCenterGroup.title })
      .from(costCenterGroup)
      .where(eq(costCenterGroup.controllingArea, area))
      .orderBy(asc(costCenterGroup.groupName));
    const leafRows = await tx
      .select({
        groupName: costCenterGroupLeaf.groupName,
        valSign: costCenterGroupLeaf.valSign,
        valOption: costCenterGroupLeaf.valOption,
        valFrom: costCenterGroupLeaf.valFrom,
        valTo: costCenterGroupLeaf.valTo,
        displayOrder: costCenterGroupLeaf.displayOrder,
      })
      .from(costCenterGroupLeaf)
      .where(eq(costCenterGroupLeaf.controllingArea, area))
      .orderBy(asc(costCenterGroupLeaf.groupName), asc(costCenterGroupLeaf.displayOrder));

    const centreKeys = [...new Set(periods.map((period) => period.costCenter))].sort();

    return {
      hierarchyTitle: hierarchy?.title ?? null,
      nodes: flattenNodes(nodeRows, assignedCounts),
      placements: assignmentRows,
      unplacedPeriods: periods.filter(
        (period) => !placedKeys.has(`${period.costCenter}:${period.validFrom}`),
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
