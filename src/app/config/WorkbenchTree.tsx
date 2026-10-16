'use client';

import { useState } from 'react';
import Link from 'next/link';

import { t } from '@/platform/i18n';

export type WorkbenchActivity = {
  code: string;
  area: string;
  title: string;
  activity_kind: string;
  prerequisites: string;
  enables: string | null;
  route_path: string | null;
  status: string | null;
  sequence: number;
};

type Branch = {
  label: string;
  path: string;
  depth: number;
  branches: Map<string, Branch>;
  activities: WorkbenchActivity[];
};

/**
 * The configuration workbench as a collapsible tree — CAIRN.md §7.1.
 *
 * The activity code is already a path: CFG.FIN.COA.COPY says that copying a chart belongs to the
 * chart of accounts, which belongs to finance, which belongs to configuration. Grouping by area
 * showed one of those four levels and left the rest to be read off the code, so a step that had
 * not been registered yet had nowhere to appear. The tree shows every level, which is what makes
 * the plan portable: a reader can see what a branch holds before opening it.
 *
 * Branches start open. Nothing is hidden by default, and a reader who wants one branch collapses
 * it rather than hunting for the one that was closed.
 *
 * Leaves stay table rows in a single table, so the columns line up across the whole plan and a
 * reader can scan the Status column without following the tree.
 */
export function WorkbenchTree({
  rows,
  completed,
  builtRoutes,
}: {
  rows: WorkbenchActivity[];
  completed: string[];
  builtRoutes: string[];
}) {
  const done = new Set(completed);
  const routes = new Set(builtRoutes);
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());

  const root = buildTree(rows);
  const visible = flatten(root, collapsed);

  const toggle = (path: string) => {
    setCollapsed((current) => {
      const next = new Set(current);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  };

  return (
    <section className="panel overflow-hidden">
      <div className="panel-header">
        <h2 className="panel-title">{t('workbench.treeTitle')}</h2>
        <span className="text-2xs text-ink-faint">
          {t('workbench.treeHint', { total: String(rows.length), done: String(done.size) })}
        </span>
      </div>
      <table className="grid-table">
        <thead>
          <tr>
            <th className="w-16">{t('workbench.column.step')}</th>
            <th className="w-20">{t('workbench.column.kind')}</th>
            <th>{t('workbench.column.activity')}</th>
            <th className="w-72">{t('workbench.enables')}</th>
            <th className="w-28">{t('workbench.prerequisites')}</th>
            <th className="w-24" />
            <th className="w-24" />
          </tr>
        </thead>
        <tbody>
          {visible.map((node) =>
            node.kind === 'branch' ? (
              <tr key={`branch:${node.branch.path}`} className="bg-sunken" data-branch={node.branch.path}>
                <td colSpan={7} className="px-2 py-1">
                  <button
                    type="button"
                    aria-expanded={!collapsed.has(node.branch.path)}
                    onClick={() => toggle(node.branch.path)}
                    className="flex min-h-9 w-full items-center gap-2 text-start text-xs font-semibold tracking-wide text-ink-soft hover:text-accent"
                  >
                    <span aria-hidden="true" className="w-3 text-center">
                      {collapsed.has(node.branch.path) ? '▸' : '▾'}
                    </span>
                    <span style={{ paddingInlineStart: `${node.branch.depth * 12}px` }}>
                      {node.branch.label}
                    </span>
                    <span className="text-2xs font-normal text-ink-faint">
                      {countDone(node.branch, done)} / {countActivities(node.branch)}
                    </span>
                  </button>
                </td>
              </tr>
            ) : (
              <ActivityRow
                key={node.activity.code}
                item={node.activity}
                depth={node.depth}
                done={done}
                routes={routes}
              />
            ),
          )}
        </tbody>
      </table>
    </section>
  );
}

function ActivityRow({
  item,
  depth,
  done,
  routes,
}: {
  item: WorkbenchActivity;
  depth: number;
  done: Set<string>;
  routes: Set<string>;
}) {
  const prereqs = item.prerequisites
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
  const blocked = !done.has(item.code) && prereqs.some((entry) => !done.has(entry));
  const missing = prereqs.filter((entry) => !done.has(entry));

  return (
    <tr>
      <td className="tabular text-ink-faint" style={{ paddingInlineStart: `${depth * 12 + 8}px` }}>
        {item.sequence}
      </td>
      <td>
        <span className={`chip ${item.activity_kind === 'DEFINE' ? 'chip-info' : 'chip-neutral'}`}>
          {item.activity_kind === 'DEFINE' ? t('workbench.kind.define') : t('workbench.kind.assign')}
        </span>
      </td>
      <td>
        <div className="font-medium">{item.title}</div>
        <div className="code text-ink-faint">{item.code}</div>
      </td>
      <td className="text-ink-soft">{item.enables ?? '—'}</td>
      <td className="text-2xs text-ink-faint">{missing.length === 0 ? '—' : missing.join(', ')}</td>
      <td className="text-end">
        {item.route_path && routes.has(item.route_path) ? (
          <Link href={item.route_path} className="text-accent hover:underline">
            {t('workbench.open')}
          </Link>
        ) : (
          <span className="text-2xs text-ink-faint">{t('workbench.screenPending')}</span>
        )}
      </td>
      <td className="text-end">
        {done.has(item.code) ? (
          <span className="chip chip-ok">{t('workbench.status.completed')}</span>
        ) : blocked ? (
          <span className="chip chip-warn" title={`Waiting for: ${missing.join(', ')}`}>
            {t('workbench.status.blocked')}
          </span>
        ) : (
          <span className="chip chip-neutral">{t('workbench.status.notStarted')}</span>
        )}
      </td>
    </tr>
  );
}

/**
 * Nest the activities by their own code. The last segment names the activity, so it stays a leaf;
 * everything before it is a branch. Order follows the sequence the rows arrived in, which is the
 * order the plan is meant to be read.
 */
function buildTree(rows: WorkbenchActivity[]): Branch {
  const root: Branch = { label: '', path: '', depth: 0, branches: new Map(), activities: [] };
  for (const row of rows) {
    const segments = row.code.split('.').filter(Boolean);
    const branchSegments = segments.slice(0, -1);
    let node = root;
    let path = '';
    for (const [index, segment] of branchSegments.entries()) {
      path = path ? `${path}.${segment}` : segment;
      const existing = node.branches.get(segment);
      if (existing) {
        node = existing;
        continue;
      }
      const created: Branch = { label: segment, path, depth: index + 1, branches: new Map(), activities: [] };
      node.branches.set(segment, created);
      node = created;
    }
    node.activities.push(row);
  }
  return root;
}

type VisibleNode =
  | { kind: 'branch'; branch: Branch }
  | { kind: 'activity'; activity: WorkbenchActivity; depth: number };

/** Depth-first, in insertion order, skipping whatever is collapsed. */
function flatten(root: Branch, collapsed: ReadonlySet<string>): VisibleNode[] {
  const out: VisibleNode[] = [];
  const walk = (branch: Branch) => {
    for (const child of branch.branches.values()) {
      out.push({ kind: 'branch', branch: child });
      if (collapsed.has(child.path)) continue;
      walk(child);
      for (const activity of child.activities) out.push({ kind: 'activity', activity, depth: child.depth + 1 });
    }
    if (branch === root) {
      for (const activity of branch.activities) out.push({ kind: 'activity', activity, depth: 1 });
    }
  };
  walk(root);
  return out;
}

function countActivities(branch: Branch): number {
  let total = branch.activities.length;
  for (const child of branch.branches.values()) total += countActivities(child);
  return total;
}

function countDone(branch: Branch, done: Set<string>): number {
  let total = branch.activities.filter((activity) => done.has(activity.code)).length;
  for (const child of branch.branches.values()) total += countDone(child, done);
  return total;
}
