import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { changeLockClaim, claimKey, IDLE_CLAIM, shouldDispatch } from '../src/ui/lock/claim';
import type { ChangeLockState } from '../src/app/platform/locks/actions';

const page = readFileSync('src/app/config/purchasing-orgs/assign-company/page.tsx', 'utf8');
const form = readFileSync('src/app/config/purchasing-orgs/assign-company/PurchasingOrgCompanyCodeAssignmentForm.tsx', 'utf8');
const definitions = readFileSync('src/app/config/purchasing-orgs/page.tsx', 'utf8');
const workbench = readFileSync('src/app/config/page.tsx', 'utf8');
const messages = readFileSync('src/platform/i18n/index.ts', 'utf8');

describe('SCR-018 Purchasing Organisation Company Code assignment UI', () => {
  it('uses a dedicated assignment route and exposes it from the definition page/workbench', () => {
    expect(page).toContain("requireSession('/config/purchasing-orgs/assign-company')");
    expect(page).toContain("const ASSIGNMENT = 'CFG.PROC.PURORG.ASSIGN_COMPANY'");
    expect(definitions).toContain('PURCHASING_ORG_ASSIGN_COMPANY');
    expect(definitions).toContain('/config/purchasing-orgs/assign-company');
    expect(workbench).toContain("'/config/purchasing-orgs/assign-company'");
  });

  it('shows only active Company Code choices and only for active unassigned organisations with authority', () => {
    expect(page).toContain('canAssign && hasEligibleOrganisations');
    expect(page).toContain('eq(companyCode.isActive, true)');
    expect(page).toContain('organisation.isActive && organisation.companyCode === null');
    expect(page).toContain('purchasingOrg.companyCode');
  });

  it('posts only the Purchasing Organisation and selected Company Code from the browser', () => {
    expect(form).toContain('name="purchasingOrg"');
    expect(form).toContain('name="companyCode"');
    expect(form).not.toContain('name="client"');
    expect(form).not.toContain('name="changedBy"');
  });

  it('keeps the assignment boundary and lock-state feedback in English messages', () => {
    for (const key of [
      'purchasingOrg.companyAssignmentTitle',
      'purchasingOrg.companyAssignmentInitialOnly',
      'purchasingOrg.companyLockIdle',
      'purchasingOrg.companyLockPending',
      'purchasingOrg.companyLockPendingSubmit',
      'purchasingOrg.companyLockAcquired',
      'purchasingOrg.reopenCompanyLock',
      'purchasingOrg.retryCompanyAssignment',
    ]) expect(messages).toContain(`'${key}':`);
    expect(messages).toContain("'purchasingOrg.companyAssigned': 'Purchasing Organisation {org} assigned to Company Code {company}; change history recorded.'");
  });

  it('keeps a submit made while acquisition is pending and never dispatches before CHANGE', () => {
    const key = claimKey('PURCHASING_ORG_COMPANY', '1000', 'CFG.PROC.PURORG.ASSIGN_COMPANY');
    const pending = changeLockClaim(IDLE_CLAIM, { type: 'begin', key });
    const pressed = changeLockClaim(pending, { type: 'press' });
    expect(pressed.phase).toBe('pending');
    expect(pressed.queued).toBe(true);
    expect(shouldDispatch(pressed)).toBe(false);
    expect(form).toContain("if (claim.phase === 'idle' || claim.phase === 'pending')");
    expect(form).toContain('reportPress();');
    expect(form).toContain("t(claim.queued ? 'purchasingOrg.companyLockPendingSubmit' : 'purchasingOrg.companyLockPending')");
    expect(form).toContain('disabled={cannotSubmit}');
  });

  it('shows acquisition failure with a one-press retry and does not carry the old submit', () => {
    const key = claimKey('PURCHASING_ORG_COMPANY', '1000', 'CFG.PROC.PURORG.ASSIGN_COMPANY');
    const pending = changeLockClaim(IDLE_CLAIM, { type: 'begin', key });
    const failed = changeLockClaim(pending, { type: 'reject', key, error: 'Failed to fetch' });
    const retried = changeLockClaim(failed, { type: 'retry', key });
    expect(failed.phase).toBe('failed');
    expect(failed.queued).toBe(false);
    expect(retried.phase).toBe('pending');
    expect(retried.queued).toBe(false);
    expect(form).toContain('<ClaimFailureNotice claim={claim} onRetry={retry} />');
    expect(form).toContain('setReopenRequested(true)');
    expect(form).toContain('state.lockFailure');
  });

  it('dispatches one assignment only after acquisition; the server action reasserts this session lock first', () => {
    const key = claimKey('PURCHASING_ORG_COMPANY', '1000', 'CFG.PROC.PURORG.ASSIGN_COMPANY');
    const pending = changeLockClaim(IDLE_CLAIM, { type: 'begin', key });
    const queued = changeLockClaim(pending, { type: 'press' });
    const granted: ChangeLockState = { mode: 'CHANGE', message: null, remedy: null };
    const open = changeLockClaim(queued, { type: 'resolve', key, state: granted });
    expect(open.phase).toBe('open');
    expect(shouldDispatch(open)).toBe(true);
    expect(shouldDispatch(changeLockClaim(open, { type: 'dispatched' }))).toBe(false);
    expect(form).toContain('if (!shouldDispatch(claim)) return;');
    expect(form.indexOf('dispatched();')).toBeLessThan(form.indexOf('action(new FormData(form))'));
    const actions = readFileSync('src/app/config/purchasing-orgs/assign-company/actions.ts', 'utf8');
    expect(actions.indexOf('await assertChangeForSession')).toBeLessThan(actions.indexOf('await assignPurchasingOrgCompanyCode('));
    expect(actions).toContain('lockFailure: true');
  });
});
