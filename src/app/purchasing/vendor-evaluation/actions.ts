'use server';

/**
 * SCR-165 — the vendor-evaluation screen's door.
 *
 * Check is a read. Save stores one manual score. A named company code, material,
 * purchasing document, sub-criterion, run, status, weight, or overall score is
 * passed through, so the service refuses it by name rather than the action
 * quietly dropping it. This action does not post.
 */
import { can, requireSession } from '@/platform/auth/current';
import { EnqueueError, assertChangeForSession } from '@/platform/lock/enqueue';
import {
  VENDOR_EVALUATION_CAPABILITY,
  VENDOR_EVALUATION_ROUTE,
  VendorEvaluationError,
  saveManualScore,
} from '@/modules/purchasing/vendor-evaluation';

export interface VendorEvaluationActionState {
  ok: boolean;
  message: string;
  remedy?: string;
  wrote?: boolean;
  criterionCode?: string;
  score?: string;
  version?: number;
}

const ALLOWED = new Set([
  'supplier',
  'purchasingOrg',
  'periodFrom',
  'periodTo',
  'criterionCode',
  'score',
  'reason',
  'requestKey',
  'expectedVersion',
]);

function text(form: FormData, name: string): string {
  const value = form.get(name);
  return typeof value === 'string' ? value.trim() : '';
}

function named(form: FormData): Record<string, string> {
  const extra: Record<string, string> = {};
  for (const key of form.keys()) {
    if (ALLOWED.has(key) || key.startsWith('$') || !text(form, key)) continue;
    extra[key] = text(form, key);
  }
  return extra;
}

function missing(): VendorEvaluationActionState {
  return {
    ok: false,
    message: `You do not hold the vendor evaluation capability (${VENDOR_EVALUATION_CAPABILITY}). A purchase-order permission does not score a supplier.`,
  };
}

export async function saveManualScoreAction(
  _previous: VendorEvaluationActionState,
  form: FormData,
): Promise<VendorEvaluationActionState> {
  const session = await requireSession(VENDOR_EVALUATION_ROUTE);
  if (!can(session, VENDOR_EVALUATION_CAPABILITY)) return missing();
  const versionText = text(form, 'expectedVersion');
  try {
    await assertChangeForSession(session, {
      lockObject: 'VENDOR_EVALUATION',
      argument: `${text(form, 'supplier')}/${text(form, 'purchasingOrg')}/${text(form, 'periodFrom')}/${text(form, 'periodTo')}`,
    });
    const saved = await saveManualScore({
      client: session.user.client,
      changedBy: session.user.username,
      supplier: text(form, 'supplier'),
      purchasingOrg: text(form, 'purchasingOrg'),
      periodFrom: text(form, 'periodFrom'),
      periodTo: text(form, 'periodTo'),
      criterionCode: text(form, 'criterionCode'),
      score: text(form, 'score'),
      reason: text(form, 'reason'),
      requestKey: text(form, 'requestKey'),
      expectedVersion: versionText === '' ? null : Number(versionText),
      named: named(form),
    });
    return {
      ok: true,
      wrote: saved.wrote,
      criterionCode: saved.criterionCode,
      score: saved.score,
      version: saved.version,
      message: saved.wrote
        ? `${saved.criterionCode} stands at ${saved.score}. The overall score is still derived. Nothing was posted.`
        : `${saved.criterionCode} already stood at ${saved.score}. Nothing was written.`,
    };
  } catch (caught) {
    if (caught instanceof VendorEvaluationError || caught instanceof EnqueueError) {
      return { ok: false, message: caught.message, remedy: caught.remedy };
    }
    throw caught;
  }
}
