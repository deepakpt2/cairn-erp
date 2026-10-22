'use server';

import { revalidatePath } from 'next/cache';

import { can, requireSession } from '@/platform/auth/current';
import { EnqueueError, assertChangeForSession } from '@/platform/lock/enqueue';
import {
  CONSOLIDATION_CAPABILITY, ConsolidationError,
  activateArea, assignUnit, getConsolidationWorkbench, listConsolidationAreas, saveArea, saveDataBasis, saveGroup,
  saveGroupAccount, saveMapping, saveMethod, saveTask, saveUnit, saveVersion,
  type MethodKind, type TaskType,
} from '@/modules/finance/consolidation-workbench';

export interface ConsolidationActionState {
  ok: boolean;
  message: string;
  remedy?: string;
}

const ROUTE = '/config/consolidation';

function text(form: FormData, name: string): string {
  const value = form.get(name);
  return typeof value === 'string' ? value.trim() : '';
}

function wrap(error: unknown): ConsolidationActionState {
  if (error instanceof ConsolidationError || error instanceof EnqueueError) return { ok: false, message: error.message, remedy: error.remedy };
  throw error;
}

function same(left: string, right: string) {
  return left.trim().toUpperCase() === right.trim().toUpperCase();
}

function handler(
  fn: (form: FormData, actor: { client: string; changedBy: string; reason: string }) => Promise<string>,
  lock?: (form: FormData, session: { sessionId?: string; user: { client: string } }) => Promise<void>,
) {
  return async (_prev: ConsolidationActionState, form: FormData): Promise<ConsolidationActionState> => {
    const session = await requireSession(ROUTE);
    if (!can(session, CONSOLIDATION_CAPABILITY)) {
      return { ok: false, message: 'You do not hold the consolidation workbench capability.' };
    }
    try {
      if (lock) await lock(form, session);
      const message = await fn(form, {
        client: session.user.client, changedBy: session.user.username, reason: text(form, 'reason'),
      });
      revalidatePath(ROUTE);
      return { ok: true, message };
    } catch (error) {
      return wrap(error);
    }
  };
}

export const saveBasisAction = handler(async (form, actor) => {
  const dimensions = text(form, 'dimensions').split(',').map((d) => d.trim()).filter(Boolean)
    .map((dimension) => ({ dimension: dimension.toUpperCase() }));
  await saveDataBasis({ ...actor, basis: text(form, 'basis'), title: text(form, 'title'), dimensions });
  return `Data basis ${text(form, 'basis').toUpperCase()} saved.`;
}, async (form, session) => {
  const basis = text(form, 'basis');
  const areas = await listConsolidationAreas(session.user.client);
  if (areas.some((entry) => same(entry.dataBasis, basis))) {
    await assertChangeForSession(session, { lockObject: 'CONSOLIDATION_BASIS', argument: basis });
  }
});

export const saveAreaAction = handler(async (form, actor) => {
  await saveArea({
    ...actor, area: text(form, 'area'), title: text(form, 'title'),
    dataBasis: text(form, 'dataBasis').toUpperCase(), consChart: text(form, 'consChart'),
    fiscalYearVariant: text(form, 'fiscalYearVariant').toUpperCase(),
  });
  return `Consolidation area ${text(form, 'area').toUpperCase()} saved.`;
}, async (form, session) => {
  const area = text(form, 'area');
  const areas = await listConsolidationAreas(session.user.client);
  if (areas.some((entry) => same(entry.area, area))) {
    await assertChangeForSession(session, { lockObject: 'CONSOLIDATION_AREA', argument: area });
  }
});

export const saveUnitAction = handler(async (form, actor) => {
  await saveUnit({
    ...actor, area: text(form, 'area'), unit: text(form, 'unit'),
    title: text(form, 'title'), companyCode: text(form, 'companyCode'),
  });
  return `Unit ${text(form, 'unit').toUpperCase()} saved.`;
}, async (form, session) => {
  const area = text(form, 'area');
  const unit = text(form, 'unit');
  const view = await getConsolidationWorkbench(session.user.client, area);
  if (view?.units.some((row) => same(row.unit, unit))) {
    await assertChangeForSession(session, { lockObject: 'CONSOLIDATION_UNIT', argument: `${area}/${unit}` });
  }
});

export const saveGroupAction = handler(async (form, actor) => {
  await saveGroup({
    ...actor, area: text(form, 'area'), group: text(form, 'group'),
    title: text(form, 'title'), parentGroup: text(form, 'parentGroup'),
  });
  return `Group ${text(form, 'group').toUpperCase()} saved.`;
}, async (form, session) => {
  const area = text(form, 'area');
  const group = text(form, 'group');
  const view = await getConsolidationWorkbench(session.user.client, area);
  if (view?.groups.some((row) => same(row.group, group))) {
    await assertChangeForSession(session, { lockObject: 'CONSOLIDATION_GROUP', argument: `${area}/${group}` });
  }
});

export const assignUnitAction = handler(async (form, actor) => {
  await assignUnit({
    ...actor, area: text(form, 'area'), group: text(form, 'group').toUpperCase(),
    unit: text(form, 'unit').toUpperCase(), validFrom: text(form, 'validFrom'), validTo: text(form, 'validTo'),
  });
  return `Unit ${text(form, 'unit').toUpperCase()} assigned.`;
}, async (form, session) => {
  const area = text(form, 'area');
  const group = text(form, 'group');
  const unit = text(form, 'unit');
  const validFrom = text(form, 'validFrom');
  const view = await getConsolidationWorkbench(session.user.client, area);
  if (view?.assignments.some((row) => same(row.group, group) && same(row.unit, unit) && row.validFrom === validFrom)) {
    await assertChangeForSession(session, { lockObject: 'CONSOLIDATION_ASSIGNMENT', argument: `${area}/${group}/${unit}/${validFrom}` });
  }
});

export const saveGroupAccountAction = handler(async (form, actor) => {
  await saveGroupAccount({ ...actor, consChart: text(form, 'consChart'), account: text(form, 'account'), title: text(form, 'title') });
  return `Group account ${text(form, 'account')} saved.`;
}, async (form, session) => {
  const consChart = text(form, 'consChart');
  const account = text(form, 'account');
  const areas = await listConsolidationAreas(session.user.client);
  const match = areas.find((entry) => same(entry.consChart, consChart));
  const view = match ? await getConsolidationWorkbench(session.user.client, match.area) : null;
  if (view?.groupAccounts.some((row) => same(row.consChart, consChart) && same(row.account, account))) {
    await assertChangeForSession(session, { lockObject: 'CONSOLIDATION_GROUP_ACCOUNT', argument: `${consChart}/${account}` });
  }
});

export const saveMappingAction = handler(async (form, actor) => {
  await saveMapping({
    ...actor, consChart: text(form, 'consChart'), sourceChart: text(form, 'sourceChart').toUpperCase(),
    sourceFrom: text(form, 'sourceFrom'), sourceTo: text(form, 'sourceTo'), groupAccount: text(form, 'groupAccount'),
  });
  return 'Account mapping saved.';
}, async (form, session) => {
  const sourceChart = text(form, 'sourceChart');
  const sourceFrom = text(form, 'sourceFrom');
  const sourceTo = text(form, 'sourceTo');
  const consChart = text(form, 'consChart');
  const areas = await listConsolidationAreas(session.user.client);
  const match = areas.find((entry) => same(entry.consChart, consChart));
  const view = match ? await getConsolidationWorkbench(session.user.client, match.area) : null;
  if (view?.mappings.some((row) => same(row.sourceChart, sourceChart) && same(row.sourceAccountFrom, sourceFrom) && same(row.sourceAccountTo, sourceTo))) {
    await assertChangeForSession(session, { lockObject: 'CONSOLIDATION_MAPPING', argument: `${sourceChart}/${sourceFrom}/${sourceTo}` });
  }
});

export const saveMethodAction = handler(async (form, actor) => {
  await saveMethod({
    ...actor, area: text(form, 'area'), method: text(form, 'method'),
    kind: text(form, 'kind') as MethodKind, title: text(form, 'title'),
  });
  return `Method ${text(form, 'method').toUpperCase()} saved.`;
}, async (form, session) => {
  const area = text(form, 'area');
  const method = text(form, 'method');
  const view = await getConsolidationWorkbench(session.user.client, area);
  if (view?.methods.some((row) => same(row.method, method))) {
    await assertChangeForSession(session, { lockObject: 'CONSOLIDATION_METHOD', argument: `${area}/${method}` });
  }
});

export const saveVersionAction = handler(async (form, actor) => {
  await saveVersion({ ...actor, area: text(form, 'area'), version: text(form, 'version'), title: text(form, 'title') });
  return `Version ${text(form, 'version').toUpperCase()} saved.`;
}, async (form, session) => {
  const area = text(form, 'area');
  const version = text(form, 'version');
  const view = await getConsolidationWorkbench(session.user.client, area);
  if (view?.versions.some((row) => same(row.version, version))) {
    await assertChangeForSession(session, { lockObject: 'CONSOLIDATION_VERSION', argument: `${area}/${version}` });
  }
});

export const saveTaskAction = handler(async (form, actor) => {
  await saveTask({
    ...actor, area: text(form, 'area'), version: text(form, 'version').toUpperCase(),
    task: text(form, 'task'), parentTask: text(form, 'parentTask'),
    sequence: Number(text(form, 'sequence')) || 10, taskType: text(form, 'taskType') as TaskType,
    method: text(form, 'method').toUpperCase(), unit: text(form, 'unit').toUpperCase(),
    group: text(form, 'group').toUpperCase(), validFrom: text(form, 'validFrom'), validTo: text(form, 'validTo'),
  });
  return `Task ${text(form, 'task').toUpperCase()} saved.`;
}, async (form, session) => {
  const area = text(form, 'area');
  const version = text(form, 'version');
  const task = text(form, 'task');
  const view = await getConsolidationWorkbench(session.user.client, area);
  if (view?.tasks.some((row) => same(row.task, task))) {
    await assertChangeForSession(session, { lockObject: 'CONSOLIDATION_TASK', argument: `${area}/${version}/${task}` });
  }
});

export const activateAreaAction = handler(async (form, actor) => {
  await activateArea({ ...actor, area: text(form, 'area') });
  return `Area ${text(form, 'area').toUpperCase()} activated.`;
}, async (form, session) => {
  await assertChangeForSession(session, { lockObject: 'CONSOLIDATION_AREA', argument: text(form, 'area') });
});
