'use server';

import { revalidatePath } from 'next/cache';

import { can, requireSession } from '@/platform/auth/current';
import {
  CONSOLIDATION_CAPABILITY, ConsolidationError,
  activateArea, assignUnit, saveArea, saveDataBasis, saveGroup,
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
  if (error instanceof ConsolidationError) return { ok: false, message: error.message, remedy: error.remedy };
  throw error;
}

function handler(fn: (form: FormData, actor: { client: string; changedBy: string; reason: string }) => Promise<string>) {
  return async (_prev: ConsolidationActionState, form: FormData): Promise<ConsolidationActionState> => {
    const session = await requireSession(ROUTE);
    if (!can(session, CONSOLIDATION_CAPABILITY)) {
      return { ok: false, message: 'You do not hold the consolidation workbench capability.' };
    }
    try {
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
});

export const saveAreaAction = handler(async (form, actor) => {
  await saveArea({
    ...actor, area: text(form, 'area'), title: text(form, 'title'),
    dataBasis: text(form, 'dataBasis').toUpperCase(), consChart: text(form, 'consChart'),
    fiscalYearVariant: text(form, 'fiscalYearVariant').toUpperCase(),
  });
  return `Consolidation area ${text(form, 'area').toUpperCase()} saved.`;
});

export const saveUnitAction = handler(async (form, actor) => {
  await saveUnit({
    ...actor, area: text(form, 'area'), unit: text(form, 'unit'),
    title: text(form, 'title'), companyCode: text(form, 'companyCode'),
  });
  return `Unit ${text(form, 'unit').toUpperCase()} saved.`;
});

export const saveGroupAction = handler(async (form, actor) => {
  await saveGroup({
    ...actor, area: text(form, 'area'), group: text(form, 'group'),
    title: text(form, 'title'), parentGroup: text(form, 'parentGroup'),
  });
  return `Group ${text(form, 'group').toUpperCase()} saved.`;
});

export const assignUnitAction = handler(async (form, actor) => {
  await assignUnit({
    ...actor, area: text(form, 'area'), group: text(form, 'group').toUpperCase(),
    unit: text(form, 'unit').toUpperCase(), validFrom: text(form, 'validFrom'), validTo: text(form, 'validTo'),
  });
  return `Unit ${text(form, 'unit').toUpperCase()} assigned.`;
});

export const saveGroupAccountAction = handler(async (form, actor) => {
  await saveGroupAccount({ ...actor, consChart: text(form, 'consChart'), account: text(form, 'account'), title: text(form, 'title') });
  return `Group account ${text(form, 'account')} saved.`;
});

export const saveMappingAction = handler(async (form, actor) => {
  await saveMapping({
    ...actor, consChart: text(form, 'consChart'), sourceChart: text(form, 'sourceChart').toUpperCase(),
    sourceFrom: text(form, 'sourceFrom'), sourceTo: text(form, 'sourceTo'), groupAccount: text(form, 'groupAccount'),
  });
  return 'Account mapping saved.';
});

export const saveMethodAction = handler(async (form, actor) => {
  await saveMethod({
    ...actor, area: text(form, 'area'), method: text(form, 'method'),
    kind: text(form, 'kind') as MethodKind, title: text(form, 'title'),
  });
  return `Method ${text(form, 'method').toUpperCase()} saved.`;
});

export const saveVersionAction = handler(async (form, actor) => {
  await saveVersion({ ...actor, area: text(form, 'area'), version: text(form, 'version'), title: text(form, 'title') });
  return `Version ${text(form, 'version').toUpperCase()} saved.`;
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
});

export const activateAreaAction = handler(async (form, actor) => {
  await activateArea({ ...actor, area: text(form, 'area') });
  return `Area ${text(form, 'area').toUpperCase()} activated.`;
});
