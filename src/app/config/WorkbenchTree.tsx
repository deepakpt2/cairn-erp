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
  segment: string;
  path: string;
  depth: number;
  branches: Map<string, Branch>;
  activities: WorkbenchActivity[];
};

/**
 * Human names for the code segments the tree is built from. The code stays
 * visible beside the name — it is the address other screens cite — but a
 * reader classifies by the words, not by FIN or COA.
 */
const SEGMENT_LABELS: Record<string, string> = {
  CFG: 'Configuration',
  PLT: 'Platform',
  ORG: 'Organization',
  FIN: 'Financial Accounting',
  COST: 'Controlling',
  PROC: 'Procurement',
  INV: 'Inventory',
  PROD: 'Production',
  SALES: 'Sales',
  PEOPLE: 'People & Payroll',
  CLIENT: 'Clients',
  MAIL: 'Mail',
  NUMBERRANGE: 'Number Ranges',
  ROLE: 'Roles',
  USER: 'Users',
  COMPANYCODE: 'Company Codes',
  PLANT: 'Plants',
  STORAGELOC: 'Storage Locations',
  SALESORG: 'Sales Organizations',
  DISTCHANNEL: 'Distribution Channels',
  DIVISION: 'Divisions',
  SALESAREA: 'Sales Areas',
  COA: 'Chart of Accounts',
  GLACCOUNT: 'G/L Accounts',
  FYV: 'Fiscal Year Variants',
  PPV: 'Posting Period Variants',
  DOCTYPE: 'Document Types',
  TOLERANCE: 'Tolerance Groups',
  ACCTDET: 'Account Determination',
  EXRATE: 'Exchange Rates',
  TAXCODE: 'Tax Codes',
  BANK: 'Banks',
  HOUSEBANK: 'House Banks',
  PAYTERMS: 'Payment Terms',
  PAYMENTMETHOD: 'Payment Methods',
  CREDIT: 'Credit Management',
  INTERCOMPANY: 'Intercompany',
  CONTROLLINGAREA: 'Controlling Areas',
  COSTCENTER: 'Cost Centres',
  COSTCENTERHIER: 'Cost Centre Hierarchy',
  ACTIVITYTYPE: 'Activity Types',
  ACTIVITYRATE: 'Activity Rates',
  PROFITCENTER: 'Profit Centres',
  PURGROUP: 'Purchasing Groups',
  PURORG: 'Purchasing Organizations',
  RELEASE: 'Release Procedures',
  MATERIALGROUP: 'Material Groups',
  MATERIALTYPE: 'Material Types',
  MOVETYPE: 'Movement Types',
  WORKCENTER: 'Work Centres',
  MRPCONTROLLER: 'MRP Controllers',
  SCHEDULING: 'Scheduling',
  LOTSIZE: 'Lot Sizing',
  CONDITION: 'Conditions',
  PRICING: 'Pricing',
  DEDUCTION: 'Deductions',
  PAYCOMPONENT: 'Pay Components',
  RECORDTYPE: 'Record Types',
};

function segmentLabel(segment: string): string {
  return SEGMENT_LABELS[segment] ?? segment.charAt(0) + segment.slice(1).toLowerCase();
}

/** How far one tree level steps in, in pixels. Deep enough to read at a glance. */
const INDENT = 22;

/**
 * The configuration workbench as a collapsible tree — CAIRN.md §7.1.
 *
 * The activity code is already a path: CFG.FIN.COA.COPY says that copying a
 * chart belongs to the chart of accounts, which belongs to finance, which
 * belongs to configuration. The tree shows every level of that path with a
 * human name beside the segment, the leaves stepped in under their branch
 * behind a guide rail, and each branch carrying its own completion count —
 * so a reader can classify the whole plan, fold away what is not being
 * worked on, and still scan one Status column across all of it.
 *
 * Branches start open. Nothing is hidden by default; folding is for the
 * reader who has found their branch, and the header can fold or unfold the
 * whole tree at once. Leaves stay table rows in a single table, so the
 * columns line up across the whole plan.
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
  const allPaths = collectPaths(root);

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
        <div className="flex items-center gap-3">
          <span className="text-2xs text-ink-faint">
            {t('workbench.treeHint', { total: String(rows.length), done: String(done.size) })}
          </span>
          <button
            type="button"
            className="btn btn-default min-h-7 px-2 py-0.5 text-2xs"
            onClick={() => setCollapsed(new Set())}
          >
            {t('workbench.expandAll')}
          </button>
          <button
            type="button"
            className="btn btn-default min-h-7 px-2 py-0.5 text-2xs"
            onClick={() => setCollapsed(new Set(allPaths))}
          >
            {t('workbench.collapseAll')}
          </button>
        </div>
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
              <BranchRow
                key={`branch:${node.branch.path}`}
                branch={node.branch}
                collapsed={collapsed.has(node.branch.path)}
                done={done}
                onToggle={() => toggle(node.branch.path)}
              />
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

function BranchRow({
  branch,
  collapsed,
  done,
  onToggle,
}: {
  branch: Branch;
  collapsed: boolean;
  done: Set<string>;
  onToggle: () => void;
}) {
  const total = countActivities(branch);
  const finished = countDone(branch, done);
  const percent = total === 0 ? 0 : Math.round((finished / total) * 100);
  const depth = branch.depth;
  return (
    <tr
      data-branch={branch.path}
      className={
        depth === 1
          ? 'bg-sunken'
          : depth === 2
            ? 'bg-sunken/55'
            : 'bg-surface'
      }
    >
      <td colSpan={7} className="px-2 py-0">
        <div
          className="flex items-stretch gap-2"
          style={{ paddingInlineStart: `${(depth - 1) * INDENT}px` }}
        >
          <span
            aria-hidden="true"
            className={`my-1 w-1 shrink-0 ${depth === 1 ? 'bg-accent' : depth === 2 ? 'bg-line-strong' : 'bg-line'}`}
          />
          <button
            type="button"
            aria-expanded={!collapsed}
            aria-label={`${collapsed ? 'Expand' : 'Collapse'} ${branch.label}`}
            onClick={onToggle}
            className="flex min-h-10 flex-1 items-center gap-2.5 py-1 text-start hover:text-accent"
          >
            <span
              aria-hidden="true"
              className={`flex h-6 w-6 shrink-0 items-center justify-center border text-xs transition-transform ${
                collapsed ? 'border-line-strong bg-surface text-ink-soft' : 'border-accent bg-accent text-white'
              }`}
              style={collapsed ? undefined : { transform: 'rotate(90deg)' }}
            >
              ▸
            </span>
            <span
              className={
                depth === 1
                  ? 'text-sm font-bold tracking-tight text-ink'
                  : depth === 2
                    ? 'text-sm font-semibold text-ink'
                    : 'text-sm font-medium text-ink-soft'
              }
            >
              {branch.label}
            </span>
            <span className="code text-2xs font-normal text-ink-faint">{branch.path}</span>
            <span className="ms-auto flex shrink-0 items-center gap-2">
              <span className="hidden h-1.5 w-24 bg-line sm:block" aria-hidden="true">
                <span
                  className={`block h-full ${finished === total ? 'bg-signal-ok' : 'bg-accent'}`}
                  style={{ width: `${percent}%` }}
                />
              </span>
              <span
                className={`chip ${finished === total && total > 0 ? 'chip-ok' : 'chip-neutral'}`}
              >
                {finished} / {total}
              </span>
            </span>
          </button>
        </div>
      </td>
    </tr>
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
      <td className="tabular text-ink-faint">{item.sequence}</td>
      <td>
        <span className={`chip ${item.activity_kind === 'DEFINE' ? 'chip-info' : 'chip-neutral'}`}>
          {item.activity_kind === 'DEFINE' ? t('workbench.kind.define') : t('workbench.kind.assign')}
        </span>
      </td>
      <td>
        <div
          className="border-s-2 border-line ps-3"
          style={{ marginInlineStart: `${Math.max(0, depth - 2) * INDENT}px` }}
        >
          <div className="font-medium">{item.title}</div>
          <div className="code text-ink-faint">{item.code}</div>
        </div>
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
  const root: Branch = { label: '', segment: '', path: '', depth: 0, branches: new Map(), activities: [] };
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
      const created: Branch = {
        label: segmentLabel(segment),
        segment,
        path,
        depth: index + 1,
        branches: new Map(),
        activities: [],
      };
      node.branches.set(segment, created);
      node = created;
    }
    node.activities.push(row);
  }
  return root;
}

function collectPaths(root: Branch): string[] {
  const paths: string[] = [];
  const walk = (branch: Branch) => {
    for (const child of branch.branches.values()) {
      paths.push(child.path);
      walk(child);
    }
  };
  walk(root);
  return paths;
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
