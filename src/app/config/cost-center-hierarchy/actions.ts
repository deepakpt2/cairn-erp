'use server';

import { revalidatePath } from 'next/cache';

import { requireSession } from '@/platform/auth/current';
import {
  CostCenterHierarchyError,
  addGroupLeaf,
  deleteCostCenterGroup,
  deleteHierarchyNode,
  placeCostCenterPeriod,
  removeGroupLeaf,
  saveCostCenterGroup,
  saveHierarchyHeader,
  saveHierarchyNode,
  unplaceCostCenterPeriod,
} from '@/modules/foundation/cost-center-hierarchy';

export interface HierarchyActionState {
  ok: boolean;
  message?: string;
  remedy?: string;
}

const ROUTE = '/config/cost-center-hierarchy';

function read(form: FormData, name: string): string {
  const value = form.get(name);
  return typeof value === 'string' ? value : '';
}

function unexpected(message: string): HierarchyActionState {
  return {
    ok: false,
    message,
    remedy: 'Nothing was written. Try again, and if it fails again ask an administrator to check the server log.',
  };
}

async function finish(run: () => Promise<HierarchyActionState>): Promise<HierarchyActionState> {
  try {
    const state = await run();
    revalidatePath(ROUTE);
    return state;
  } catch (error) {
    if (error instanceof CostCenterHierarchyError) {
      return { ok: false, message: error.message, remedy: error.remedy };
    }
    return unexpected('The hierarchy entry could not be saved.');
  }
}

export async function saveHierarchyHeaderAction(
  _previous: HierarchyActionState,
  form: FormData,
): Promise<HierarchyActionState> {
  const session = await requireSession(ROUTE);
  const mode = read(form, 'mode') === 'CHANGE' ? 'CHANGE' : 'CREATE';
  return finish(async () => {
    const result = await saveHierarchyHeader({
      client: session.user.client,
      changedBy: session.user.username,
      mode,
      controllingArea: read(form, 'controllingArea'),
      title: read(form, 'title'),
      reason: read(form, 'reason'),
    });
    return {
      ok: true,
      message: result.changed
        ? mode === 'CREATE'
          ? 'The standard hierarchy is defined for this controlling area.'
          : 'The hierarchy title is changed.'
        : 'The hierarchy already carries this title; nothing was changed.',
    };
  });
}

export async function saveHierarchyNodeAction(
  _previous: HierarchyActionState,
  form: FormData,
): Promise<HierarchyActionState> {
  const session = await requireSession(ROUTE);
  const mode = read(form, 'mode') === 'CHANGE' ? 'CHANGE' : 'CREATE';
  const node = read(form, 'node');
  return finish(async () => {
    const result = await saveHierarchyNode({
      client: session.user.client,
      changedBy: session.user.username,
      mode,
      controllingArea: read(form, 'controllingArea'),
      node,
      parentNode: read(form, 'parentNode'),
      title: read(form, 'title'),
      displayOrder: Number(read(form, 'displayOrder') || '0'),
      reason: read(form, 'reason'),
    });
    return {
      ok: true,
      message: result.changed
        ? mode === 'CREATE'
          ? `Node ${node.toUpperCase()} defined.`
          : `Node ${node.toUpperCase()} changed.`
        : `Node ${node.toUpperCase()} already stands so; nothing was changed.`,
    };
  });
}

export async function deleteHierarchyNodeAction(
  _previous: HierarchyActionState,
  form: FormData,
): Promise<HierarchyActionState> {
  const session = await requireSession(ROUTE);
  const node = read(form, 'node');
  return finish(async () => {
    await deleteHierarchyNode({
      client: session.user.client,
      changedBy: session.user.username,
      controllingArea: read(form, 'controllingArea'),
      node,
      reason: read(form, 'reason'),
    });
    return { ok: true, message: `Node ${node.toUpperCase()} deleted.` };
  });
}

export async function placePeriodAction(
  _previous: HierarchyActionState,
  form: FormData,
): Promise<HierarchyActionState> {
  const session = await requireSession(ROUTE);
  const [costCenter = '', validFrom = ''] = read(form, 'period').split(':');
  const node = read(form, 'node');
  return finish(async () => {
    await placeCostCenterPeriod({
      client: session.user.client,
      changedBy: session.user.username,
      controllingArea: read(form, 'controllingArea'),
      node,
      costCenter,
      validFrom,
      reason: read(form, 'reason'),
    });
    return {
      ok: true,
      message: `Cost Centre ${costCenter.toUpperCase()} from ${validFrom} placed in Node ${node.toUpperCase()}.`,
    };
  });
}

export async function unplacePeriodAction(
  _previous: HierarchyActionState,
  form: FormData,
): Promise<HierarchyActionState> {
  const session = await requireSession(ROUTE);
  const node = read(form, 'node');
  const costCenter = read(form, 'costCenter');
  const validFrom = read(form, 'validFrom');
  return finish(async () => {
    await unplaceCostCenterPeriod({
      client: session.user.client,
      changedBy: session.user.username,
      controllingArea: read(form, 'controllingArea'),
      node,
      costCenter,
      validFrom,
      reason: read(form, 'reason'),
    });
    return {
      ok: true,
      message: `Cost Centre ${costCenter.toUpperCase()} from ${validFrom} unassigned from Node ${node.toUpperCase()}; the centre itself stands.`,
    };
  });
}

export async function saveGroupAction(
  _previous: HierarchyActionState,
  form: FormData,
): Promise<HierarchyActionState> {
  const session = await requireSession(ROUTE);
  const mode = read(form, 'mode') === 'CHANGE' ? 'CHANGE' : 'CREATE';
  const groupName = read(form, 'groupName');
  return finish(async () => {
    const result = await saveCostCenterGroup({
      client: session.user.client,
      changedBy: session.user.username,
      mode,
      controllingArea: read(form, 'controllingArea'),
      groupName,
      title: read(form, 'title'),
      reason: read(form, 'reason'),
    });
    return {
      ok: true,
      message: result.changed
        ? mode === 'CREATE'
          ? `Group ${groupName.toUpperCase()} defined.`
          : `Group ${groupName.toUpperCase()} changed.`
        : `Group ${groupName.toUpperCase()} already stands so; nothing was changed.`,
    };
  });
}

export async function deleteGroupAction(
  _previous: HierarchyActionState,
  form: FormData,
): Promise<HierarchyActionState> {
  const session = await requireSession(ROUTE);
  const groupName = read(form, 'groupName');
  return finish(async () => {
    const result = await deleteCostCenterGroup({
      client: session.user.client,
      changedBy: session.user.username,
      controllingArea: read(form, 'controllingArea'),
      groupName,
      reason: read(form, 'reason'),
    });
    return {
      ok: true,
      message: `Group ${groupName.toUpperCase()} deleted with its ${result.leaves} leaf${result.leaves === 1 ? '' : 'ves'}; the cost centres stand.`,
    };
  });
}

function leafFromForm(form: FormData, session: { user: { client: string; username: string } }) {
  return {
    client: session.user.client,
    changedBy: session.user.username,
    controllingArea: read(form, 'controllingArea'),
    groupName: read(form, 'groupName'),
    valSign: read(form, 'valSign') === 'E' ? ('E' as const) : ('I' as const),
    valOption: read(form, 'valOption') === 'BT' ? ('BT' as const) : ('EQ' as const),
    valFrom: read(form, 'valFrom'),
    valTo: read(form, 'valTo'),
    displayOrder: Number(read(form, 'displayOrder') || '0'),
    reason: read(form, 'reason'),
  };
}

export async function addLeafAction(
  _previous: HierarchyActionState,
  form: FormData,
): Promise<HierarchyActionState> {
  const session = await requireSession(ROUTE);
  return finish(async () => {
    await addGroupLeaf(leafFromForm(form, session));
    return { ok: true, message: 'The leaf stands in the group.' };
  });
}

export async function removeLeafAction(
  _previous: HierarchyActionState,
  form: FormData,
): Promise<HierarchyActionState> {
  const session = await requireSession(ROUTE);
  return finish(async () => {
    await removeGroupLeaf(leafFromForm(form, session));
    return { ok: true, message: 'The leaf is removed; the cost centres it named stand.' };
  });
}
