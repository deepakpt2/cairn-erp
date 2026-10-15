'use server';

/**
 * Capability-protected FS00 actions (SCR-028).
 *
 * Three capabilities guard one screen, exactly as the modes do: `CREATE` for a new
 * account or a new Account Group, `CHANGE` for editing an account, its blocks, its
 * deletion and the registry, `DISPLAY` for reading. The tenant and the actor come from the
 * session, never from the form.
 *
 * The field status matrix is read here rather than posted by the browser: the screen
 * renders from it and therefore cannot submit a field it was told to suppress, so the
 * server has to know which fields those were. Trusting a posted matrix would let a
 * hand-built request edit a suppressed field the screen never showed.
 */
import { revalidatePath } from 'next/cache';
import { AuthzError, requireCapability, requireSession } from '@/platform/auth/current';
import { t } from '@/platform/i18n';
import {
  ConfigError,
  deleteGlAccount,
  setGlAccountBlocks,
  upsertGlAccount,
} from '@/modules/foundation/services';
import {
  GlAccountGroupMaintenanceError,
  accountGroupFieldStatusMatrices,
  saveAccountGroup,
  saveAccountGroupFieldStatus,
  setAccountGroupActive,
} from '@/modules/finance/gl-account-group-maintenance';
import { GL_ACCOUNT_FIELDS } from '@/modules/finance/gl-account-vocabulary';
import type { AccountType, GlAccountType, ReconciliationType } from '@/modules/finance/gl-account-vocabulary';

const ROUTE = '/config/gl-accounts';
const CREATE_ACTIVITY = 'CFG.FIN.GLACCOUNT.CREATE';
const CHANGE_ACTIVITY = 'CFG.FIN.GLACCOUNT.CHANGE';

export interface GlAccountActionState {
  ok: boolean;
  message?: string;
  remedy?: string;
}

function revalidateGlAccountRoutes() {
  revalidatePath(ROUTE);
  revalidatePath('/config');
  revalidatePath('/config/chart-of-accounts');
}

function mapGlAccountError(error: unknown): GlAccountActionState {
  if (error instanceof ConfigError || error instanceof GlAccountGroupMaintenanceError) {
    return { ok: false, message: error.message, remedy: error.remedy };
  }
  if (error instanceof AuthzError) {
    return {
      ok: false,
      message: t('glAccount.capabilityRequired', { capability: error.capability }),
      remedy: t('glAccount.capabilityRemedy', { capability: error.capability }),
    };
  }
  throw error;
}

/**
 * The version a screen posted back.
 *
 * Absent means "no concurrency check": the account has no version column of its own, and a
 * caller that cannot know the version — provisioning, a seed — must not be refused by a
 * check it never asked for. A present but unusable value stays `NaN`, which fails the
 * comparison and so fails closed, exactly as OB13 treats a malformed version.
 */
function postedVersion(form: FormData): number | undefined {
  const raw = form.get('expectedVersion');
  if (raw === null || String(raw).trim() === '') return undefined;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : Number.NaN;
}

/** The registry carries a real version column, so its forms always owe one. */
function requiredVersion(form: FormData): number {
  return postedVersion(form) ?? 0;
}

/** Create or change one G/L account master record. */
export async function saveGlAccountAction(
  _previous: GlAccountActionState,
  form: FormData,
): Promise<GlAccountActionState> {
  const session = await requireSession(ROUTE);
  const read = (key: string) => String(form.get(key) ?? '').trim();
  const mode = read('mode') === 'CHANGE' ? 'CHANGE' : 'CREATE';
  const activity = mode === 'CREATE' ? CREATE_ACTIVITY : CHANGE_ACTIVITY;
  const chartOfAccounts = read('chartOfAccounts').toUpperCase();
  const accountNumber = read('accountNumber');
  const accountGroup = read('accountGroup').toUpperCase();

  try {
    await requireCapability(activity, session);

    // The group's matrix is authoritative on the server: it decides which posted fields
    // count and which were suppressed and must keep their stored value.
    const matrices = await accountGroupFieldStatusMatrices(session.user.client, chartOfAccounts);

    const reconciliation = read('reconciliationType');
    const result = await upsertGlAccount({
      client: session.user.client,
      changedBy: session.user.username,
      mode,
      expectedVersion: postedVersion(form),
      reason: read('reason') || undefined,
      fieldStatus: matrices[accountGroup],
      chartOfAccounts,
      accountNumber,
      name: read('name'),
      accountType: read('accountType').toUpperCase() as AccountType,
      accountGroup,
      glAccountType: (read('glAccountType').toUpperCase() || undefined) as GlAccountType | undefined,
      isOpenItemManaged: form.get('isOpenItemManaged') === 'on',
      reconciliationType: (reconciliation.toUpperCase() || null) as ReconciliationType | null,
      requiresCostObject: form.get('requiresCostObject') === 'on',
      isTaxRelevant: form.get('isTaxRelevant') === 'on',
      groupAccountNumber: read('groupAccountNumber') || null,
      languageKey: read('languageKey').toUpperCase() || undefined,
      sortKey: read('sortKey') || undefined,
      isBlockedPosting: form.get('isBlockedPosting') === 'on',
      isBlockedCreation: form.get('isBlockedCreation') === 'on',
    });

    revalidateGlAccountRoutes();

    if (result.created) {
      return { ok: true, message: t('glAccount.created', { account: accountNumber }) };
    }
    return {
      ok: true,
      message: result.changed
        ? t('glAccount.changed', { account: accountNumber })
        : t('glAccount.unchanged', { account: accountNumber }),
    };
  } catch (error) {
    return mapGlAccountError(error);
  }
}

/** Change the posting and creation blocks of one account; the reason is mandatory. */
export async function setGlAccountBlocksAction(
  _previous: GlAccountActionState,
  form: FormData,
): Promise<GlAccountActionState> {
  const session = await requireSession(ROUTE);
  const read = (key: string) => String(form.get(key) ?? '').trim();
  const accountNumber = read('accountNumber');

  try {
    await requireCapability(CHANGE_ACTIVITY, session);
    const result = await setGlAccountBlocks({
      client: session.user.client,
      changedBy: session.user.username,
      chartOfAccounts: read('chartOfAccounts').toUpperCase(),
      accountNumber,
      isBlockedPosting: form.get('isBlockedPosting') === 'on',
      isBlockedCreation: form.get('isBlockedCreation') === 'on',
      reason: read('reason') || undefined,
    });

    revalidateGlAccountRoutes();

    return {
      ok: true,
      message: result.changed
        ? t('glAccount.blocksSaved', { account: accountNumber })
        : t('glAccount.blocksUnchanged', { account: accountNumber }),
    };
  } catch (error) {
    return mapGlAccountError(error);
  }
}

/** Delete an account that was never used; the reason is mandatory and outlives the row. */
export async function deleteGlAccountAction(
  _previous: GlAccountActionState,
  form: FormData,
): Promise<GlAccountActionState> {
  const session = await requireSession(ROUTE);
  const read = (key: string) => String(form.get(key) ?? '').trim();
  const accountNumber = read('accountNumber');

  try {
    await requireCapability(CHANGE_ACTIVITY, session);
    await deleteGlAccount({
      client: session.user.client,
      changedBy: session.user.username,
      chartOfAccounts: read('chartOfAccounts').toUpperCase(),
      accountNumber,
      reason: read('reason'),
    });

    revalidateGlAccountRoutes();

    return { ok: true, message: t('glAccount.deleted', { account: accountNumber }) };
  } catch (error) {
    return mapGlAccountError(error);
  }
}

/** Create or change one Account Group registry row. */
export async function saveAccountGroupAction(
  _previous: GlAccountActionState,
  form: FormData,
): Promise<GlAccountActionState> {
  const session = await requireSession(ROUTE);
  const read = (key: string) => String(form.get(key) ?? '').trim();
  const mode = read('mode') === 'CHANGE' ? 'CHANGE' : 'CREATE';
  const activity = mode === 'CREATE' ? CREATE_ACTIVITY : CHANGE_ACTIVITY;
  const accountGroup = read('accountGroup').toUpperCase();

  try {
    await requireCapability(activity, session);
    const result = await saveAccountGroup({
      client: session.user.client,
      changedBy: session.user.username,
      mode,
      expectedVersion: requiredVersion(form),
      reason: read('reason') || undefined,
      chartOfAccounts: read('chartOfAccounts').toUpperCase(),
      accountGroup,
      description: read('description'),
      fromAccountNumber: read('fromAccountNumber'),
      toAccountNumber: read('toAccountNumber'),
    });

    revalidateGlAccountRoutes();

    if (mode === 'CREATE') {
      return {
        ok: true,
        message: result.created
          ? t('glAccount.groupCreated', { group: accountGroup })
          : t('glAccount.groupAlreadyExists', { group: accountGroup }),
      };
    }
    return {
      ok: true,
      message: result.changed
        ? t('glAccount.groupChanged', { group: accountGroup })
        : t('glAccount.groupUnchanged', { group: accountGroup }),
    };
  } catch (error) {
    return mapGlAccountError(error);
  }
}

/** Deactivate or reactivate an Account Group; deactivating owes a reason. */
export async function setAccountGroupActiveAction(
  _previous: GlAccountActionState,
  form: FormData,
): Promise<GlAccountActionState> {
  const session = await requireSession(ROUTE);
  const read = (key: string) => String(form.get(key) ?? '').trim();
  const accountGroup = read('accountGroup').toUpperCase();
  const isActive = read('isActive') === 'true';

  try {
    await requireCapability(CHANGE_ACTIVITY, session);
    const result = await setAccountGroupActive({
      client: session.user.client,
      changedBy: session.user.username,
      chartOfAccounts: read('chartOfAccounts').toUpperCase(),
      accountGroup,
      isActive,
      expectedVersion: requiredVersion(form),
      reason: read('reason') || undefined,
    });

    revalidateGlAccountRoutes();

    if (!result.changed) {
      return {
        ok: true,
        message: t('glAccount.groupAlreadyInState', {
          group: accountGroup,
          state: isActive ? t('glAccount.active') : t('chartOfAccounts.deactivated'),
        }),
      };
    }
    return {
      ok: true,
      message: isActive
        ? t('glAccount.groupReactivated', { group: accountGroup })
        : t('glAccount.groupDeactivated', {
            group: accountGroup,
            count: String(result.accountCount),
          }),
    };
  } catch (error) {
    return mapGlAccountError(error);
  }
}

/** Replace one group's field status matrix. */
export async function saveAccountGroupFieldStatusAction(
  _previous: GlAccountActionState,
  form: FormData,
): Promise<GlAccountActionState> {
  const session = await requireSession(ROUTE);
  const read = (key: string) => String(form.get(key) ?? '').trim();
  const accountGroup = read('accountGroup').toUpperCase();

  try {
    await requireCapability(CHANGE_ACTIVITY, session);

    // Every controlled field arrives, so a field the panel did not post is a field the
    // caller meant to leave at the baseline rather than a field to keep as it was.
    const statuses: Record<string, string> = {};
    for (const field of GL_ACCOUNT_FIELDS) {
      const posted = read(`status_${field}`);
      if (posted !== '') statuses[field] = posted.toUpperCase();
    }

    const result = await saveAccountGroupFieldStatus({
      client: session.user.client,
      changedBy: session.user.username,
      chartOfAccounts: read('chartOfAccounts').toUpperCase(),
      accountGroup,
      expectedVersion: requiredVersion(form),
      statuses,
      reason: read('reason') || undefined,
    });

    revalidateGlAccountRoutes();

    return {
      ok: true,
      message: result.changed
        ? t('glAccount.matrixSaved', { group: accountGroup })
        : t('glAccount.matrixUnchanged', { group: accountGroup }),
    };
  } catch (error) {
    return mapGlAccountError(error);
  }
}
