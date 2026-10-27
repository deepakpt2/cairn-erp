/**
 * The failure half of the change-lock contract: what an operator is told, and what they can do about it.
 *
 * Pass 34 gave the shared claim its phases; this file holds the two things that made those phases worth
 * having, and that a pin on source text alone would not catch:
 *
 * - the notice. `failureNoticeView` in `src/ui/lock/claim.ts` decides what a failed claim says — the
 *   catalogue's own sentence, the platform's line when an operator may be shown it, the recovery line, and
 *   the label of the one action offered — and `ClaimFailureNotice` is pinned to rendering exactly that and
 *   nothing else: an alert, a `type="button"` retry, no copy of its own.
 * - the three consumers that used to read a failed claim as something else. `MovementTypes` and
 *   `ValuationClasses` treated "no answer" as a reason to hide their forms, silently; `DocumentForm`
 *   treated it as a licence to edit. Each is pinned to the claim it now reads, the whole boolean-guard
 *   family they belong to is proved closed against the rest of `src`, and each gate is checked against the
 *   server rule it mirrors — including the read-only actions that must NOT be gated by a lock.
 *
 * What is deliberately not here: a rewrite of the fifteen other `lock?.mode !== 'DISPLAY'` screens. They
 * keep their gates because their actions answer a pressed save with the platform's own refusal and remedy,
 * which is asserted above from those action files and tested at the server boundary by `tests/action-security.test.ts`
 * and the lock suites. The remaining gap is stated in the readiness report, §19.8.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { awaitingClaim, changeLockClaim, failureNoticeView, IDLE_CLAIM, type ChangeLockClaim } from '../src/ui/lock/claim';
import { LOCALES, t } from '../src/platform/i18n';

const KEY = 'CONTROLLING_AREA_COMPANY\u0000M210/M201\u0000CFG.COST.CONTROLLINGAREA.DEFINE';

function claim(...events: Parameters<typeof changeLockClaim>[1][]): ChangeLockClaim {
  return events.reduce(changeLockClaim, IDLE_CLAIM);
}

const begin = { type: 'begin', key: KEY } as const;
const granted = { type: 'resolve', key: KEY, state: { mode: 'CHANGE', message: null, remedy: null } } as const;
const refused = {
  type: 'resolve',
  key: KEY,
  state: { mode: 'DISPLAY', message: 'CONTROLLING_AREA_COMPANY M210/M201 is being changed by x. This opening is display only.', remedy: 're-open it' },
} as const;
const failed = (error: string | null) => claim(begin, { type: 'reject', key: KEY, error });

/** The screens whose lock state a press can change, one per form architecture. */
const MIGRATED = [
  'src/app/config/movement-types/MovementTypes.tsx',
  'src/app/config/valuation-classes/ValuationClasses.tsx',
  'src/app/config/batch-document-management/DocumentForm.tsx',
  'src/app/config/controlling-area/ControllingAreaCompanyAssignmentUI.tsx',
];

describe('the notice a failed claim shows', () => {
  it('exists for a failed claim and for nothing else', () => {
    expect(failureNoticeView(IDLE_CLAIM)).toBeNull();
    expect(failureNoticeView(claim(begin))).toBeNull();
    expect(failureNoticeView(claim(begin, granted))).toBeNull();
    // A refusal is answered by its own notice, naming the other session, with no retry offered: refusing an
    // opening is not a failure of this one, and "Try again" would be an invitation to fight over the row.
    expect(failureNoticeView(claim(begin, refused))).toBeNull();
    expect(failureNoticeView(failed('Failed to fetch'))).not.toBeNull();
  });

  it('says the catalogue sentence, its recovery line, and offers the one action that can restart a claim', () => {
    const view = failureNoticeView(failed('Failed to fetch'))!;
    expect(view.lines).toEqual([t('lock.claimFailed'), 'Failed to fetch', t('lock.claimFailedRecovery')]);
    expect(view.action.label).toBe(t('lock.claimRetry'));
    const said = view.lines.join(' ');
    expect(said).not.toMatch(/is being changed by|display only|has been opened for change|saved/i);
    expect(said).not.toMatch(/lock monitor|sign out|three minutes/i);
    // A claim with nothing to report is still fully explained, in two lines and in the catalogue's words.
    expect(failureNoticeView(failed(null))!.lines).toEqual([t('lock.claimFailed'), t('lock.claimFailedRecovery')]);
  });

  it('keeps a stack trace, a query, a path, a credential or a refusal wording off the screen', () => {
    const unsafe = [
      'HTTP 500\n    at Object.<anonymous> (/home/cairn/cairn-erp/src/app/x/page.tsx:9:1)',
      'select client, token from user_session where password = x',
      'connect ECONNREFUSED postgresql://cairn_app:pw@127.0.0.1:5432/cairn',
      'M210/M201 is being changed by someone',
      'x'.repeat(240),
    ];
    for (const error of unsafe) {
      expect(failureNoticeView(failed(error))!.lines, error.slice(0, 42)).toEqual([
        t('lock.claimFailed'),
        t('lock.claimFailedRecovery'),
      ]);
    }
    expect(failureNoticeView(failed('HTTP 503 Service Unavailable'))!.lines[1]).toBe('HTTP 503 Service Unavailable');
  });

  it('is rendered by the shared component, which adds no copy and never submits a form', () => {
    const source = readFileSync('src/ui/lock/ChangeLock.tsx', 'utf8');
    const body = /export function ClaimFailureNotice[\s\S]*?\n}/.exec(source)?.[0] ?? '';
    expect(body).not.toBe('');
    expect(body).toContain('failureNoticeView(claim)');
    expect(body).toContain('if (!view) return null;');
    expect(body).toContain('role="alert"');
    expect(body).toContain('view.lines.map(');
    expect(body).toContain('type="button"');
    expect(body).toContain('onClick={onRetry}');
    expect(body).toContain('view.action.label');
    expect(body).not.toMatch(/'[A-Z][a-z]+ [a-z]+/);
    expect(body).not.toContain('type="submit"');
    expect(body).toContain('border-signal-error/30 bg-signal-error-soft');
    // The module owns five exports and no screen reaches past them for a failure.
    expect((source.match(/export function \w+/g) ?? []).sort()).toEqual([
      'export function ChangeLock',
      'export function ClaimFailureNotice',
      'export function LockNotice',
      'export function useChangeLock',
      'export function useChangeLockClaim',
    ].sort());
  });

  it('is the notice every screen that can fail shows, not a copy each screen keeps', () => {
    for (const file of MIGRATED) {
      const source = readFileSync(file, 'utf8');
      expect(source, file).toContain('<ClaimFailureNotice claim={');
      expect(source, file).toContain('onRetry={');
      expect(source, file).toContain('useChangeLockClaim');
      // No screen keeps its own wording for a failure, and none borrows the generic error label for it.
      expect(source, file).not.toMatch(/phase === 'failed' && \(/);
      expect(source, file).not.toContain("t('common.error')");
    }
  });
});

describe('the consumers that read a failed claim as an answer', () => {
  const movement = readFileSync('src/app/config/movement-types/MovementTypes.tsx', 'utf8');
  const valuation = readFileSync('src/app/config/valuation-classes/ValuationClasses.tsx', 'utf8');
  const document = readFileSync('src/app/config/batch-document-management/DocumentForm.tsx', 'utf8');

  it('waits for an answer in Movement Types without hiding the reason for not having one', () => {
    // The old gate was `!changeLock`: a claim that failed hid the edit form and said nothing. The form
    // still waits while an answer is owed, and a failure now shows the notice with the way back.
    expect(movement).toContain("const waitingForLock = canMaintain && mode === 'CHANGE' && Boolean(selected) && awaitingClaim(claim);");
    expect(movement).toContain("const lockedOut = claim.phase === 'refused';");
    expect(movement).toContain('<ClaimFailureNotice claim={claim} onRetry={retry} />');
    expect(movement).toContain("import { awaitingClaim } from '@/ui/lock/claim';");
    expect(movement).not.toContain('!changeLock');
    expect(movement).not.toContain('useChangeLock(');
    // The refusal keeps this screen's own words and styling: only the source of the text moved.
    expect(movement).toContain('border border-signal-warn/40 bg-amber-50 p-3 text-sm text-amber-800');
    expect(movement).toContain('{lockedOut && notice.message && (');
  });

  it('keeps a Movement Types change behind the grant, and its read-only check outside it', () => {
    expect(movement).toContain("disabled={savePending || (mode === 'CHANGE' && !granted)}");
    expect(movement).toContain('disabled={deletePending || !granted}');
    // `checkMovementTypeAction` asks for no lock, so gating it would refuse a read the server allows.
    expect(movement).toContain('disabled={checkPending}');
    const actions = readFileSync('src/app/config/movement-types/actions.ts', 'utf8');
    const save = actions.slice(actions.indexOf('export async function saveMovementTypeAction'), actions.indexOf('export async function checkMovementTypeAction'));
    expect(save).toContain("if (mode === 'CHANGE') {");
    expect(save).toContain("await assertChangeForSession(session, { lockObject: 'MOVEMENT_TYPE'");
    const check = actions.slice(actions.indexOf('export async function checkMovementTypeAction'), actions.indexOf('export async function deleteMovementTypeAction'));
    expect(check).not.toContain('assertChangeForSession');
    expect(actions).toContain("await assertChangeForSession(session, { lockObject: 'MOVEMENT_TYPE'");
  });

  it('answers each Valuation Classes section from its own claim, three locks and one rule', () => {
    for (const name of ['reference', 'class', 'type']) {
      expect(valuation, name).toContain(`const { claim: ${name}Claim, notice: ${name}Notice, retry: ${name}Retry } = useChangeLockClaim(`);
      expect(valuation, name).toContain(`const ${name}Locked = ${name}Claim.phase === 'refused';`);
      expect(valuation, name).toContain(`const ${name}Granted = ${name}Claim.phase === 'open';`);
      expect(valuation, name).toContain(`<ClaimFailureNotice claim={${name}Claim} onRetry={${name}Retry} />`);
      expect(valuation, name).toContain(`{${name}Locked && ${name}Notice.message && (`);
      expect(valuation, name).not.toMatch(new RegExp(`&& ${name}Lock\\b`));
    }
    expect(valuation).not.toContain('useChangeLock(');
    // A section is worked on from a grant and from nothing else, so a failed claim leaves nothing to press.
    expect(valuation).toContain('(referenceRow && !referenceLocked && referenceGranted))');
    expect(valuation).toContain('(classRow && !classLocked && classGranted))');
    expect(valuation).toContain('canMaintain && typeRow && !typeLocked && typeGranted && (');
    expect(valuation).toContain('canMaintain && referenceRow && !referenceLocked && referenceGranted && (');
    expect(valuation).toContain('canMaintain && classRow && !classLocked && classGranted && (');
    const actions = readFileSync('src/app/config/valuation-classes/actions.ts', 'utf8');
    for (const lockObject of ['ACCOUNT_CATEGORY_REFERENCE', 'VALUATION_CLASS', 'MATERIAL_TYPE']) {
      expect(actions).toContain(`lockObject: '${lockObject}'`);
    }
    expect(actions.slice(actions.indexOf('export async function checkValuationAction'))).not.toContain('assertChangeForSession');
  });

  it('leaves the Document Form read-only on a failure it used to treat as permission', () => {
    expect(document).toContain("const writable = canMaintain && !refused && claim.phase !== 'failed';");
    expect(document).toContain("const refused = claim.phase === 'refused';");
    expect(document).toContain('<ClaimFailureNotice claim={claim} onRetry={retry} />');
    // The gate that consumes `writable` is untouched, so the failure closes the form and nothing else:
    // fieldset, reason input and save button all follow the one derivation.
    expect(document).toContain('<fieldset className="space-y-2 text-sm" disabled={!writable}>');
    expect(document).toContain('disabled={!writable || pending || selected === undefined}');
    expect(document).not.toContain("mode !== 'DISPLAY'");
    expect(document).not.toContain('useChangeLock(');
    // It also gains the recovery sentence the display-only screens were given in Pass 28.
    expect(document).toContain('<LockNotice message={refused ? notice.message : null} remedy={refused ? notice.remedy : null} />');
    expect(document).toContain('import { saveDocumentManagementAction');
    const actions = readFileSync('src/app/config/batch-document-management/actions.ts', 'utf8');
    expect(actions).toContain('await assertChangeForSession(session, { lockObject: LOCK_OBJECT, argument: session.user.client })');
    expect(actions).toContain('if (error instanceof BatchDocumentError || error instanceof EnqueueError || error instanceof AuthzError) {');
  });

  it('runs each migrated gate expression against the real claim phases', () => {
    // Not a re-implementation: the condition is read out of the shipped file and evaluated against claims
    // the shared reducer produced, so a screen that starts treating an ungranted claim as permission to
    // write fails here rather than in front of an operator.
    const phases = {
      idle: IDLE_CLAIM,
      pending: claim(begin),
      open: claim(begin, granted),
      refused: claim(begin, refused),
      failed: claim(begin, { type: 'reject', key: KEY, error: 'Failed to fetch' }),
    };
    type Phase = keyof typeof phases;
    const evaluate = (
      file: string,
      definition: string,
      expression: string,
      locals: Record<string, unknown> = {},
      claimName = 'claim',
    ) => {
      const source = readFileSync(file, 'utf8');
      const derived = source.match(new RegExp(`const ${definition} = ([^;]*);`))?.[1];
      const gate = source.match(new RegExp(`const ${expression} = ([^;]*);`))?.[1];
      expect(derived, `${file}: ${definition}`).toBeTruthy();
      expect(gate, `${file}: ${expression}`).toBeTruthy();
      // `awaitingClaim` is handed in rather than restated, so the expression is evaluated with the shared
      // helper it calls and not with a copy of it that could drift.
      const body = `"use strict"; const ${definition} = ${derived}; return (${gate});`;
      const names = ['claim', 'awaitingClaim', ...(claimName === 'claim' ? [] : [claimName]), ...Object.keys(locals)];
      const run = (name: Phase): boolean =>
        (new Function(...names, body) as (...args: unknown[]) => boolean)(
          phases[name],
          awaitingClaim,
          ...(claimName === 'claim' ? [] : [phases[name]]),
          ...Object.values(locals),
        );
      return run;
    };

    const documentGate = evaluate('src/app/config/batch-document-management/DocumentForm.tsx', 'refused', 'writable', {
      canMaintain: true,
    });
    expect([documentGate('idle'), documentGate('open')], 'an unasked claim and a grant leave the form open').toEqual([true, true]);
    expect(documentGate('pending'), 'a claim in flight is not a refusal; the action still answers it').toBe(true);
    expect([documentGate('refused'), documentGate('failed')], 'a refusal and a failure are both closed').toEqual([false, false]);

    const movementGate = evaluate('src/app/config/movement-types/MovementTypes.tsx', 'granted', 'waitingForLock', {
      canMaintain: true,
      mode: 'CHANGE',
      selected: 'M12A',
    });
    expect([movementGate('idle'), movementGate('pending')], 'the section waits for an answer').toEqual([true, true]);
    expect([movementGate('open'), movementGate('refused'), movementGate('failed')], 'a failure is shown, not hidden')
      .toEqual([false, false, false]);

    // and the save control: a change needs the grant, a create needs nothing it did not need before
    const movementSource = readFileSync('src/app/config/movement-types/MovementTypes.tsx', 'utf8');
    const save = /disabled=\{(savePending \|\| \([^}]*\))\}/.exec(movementSource)?.[1];
    expect(save).toBeTruthy();
    const saveGate = (name: Phase, mode: string) =>
      (new Function('granted', 'mode', 'savePending', `"use strict"; return (${save});`) as (g: boolean, m: string, p: boolean) => boolean)(
        phases[name].phase === 'open',
        mode,
        false,
      );
    expect([saveGate('pending', 'CHANGE'), saveGate('refused', 'CHANGE'), saveGate('failed', 'CHANGE')], 'an ungranted change cannot be pressed')
      .toEqual([true, true, true]);
    expect(saveGate('open', 'CHANGE'), 'a grant lets the change through').toBe(false);
    expect([saveGate('idle', 'CREATE'), saveGate('pending', 'CREATE'), saveGate('failed', 'CREATE')], 'creation never waits on a lock')
      .toEqual([false, false, false]);

    const valuationGate = evaluate('src/app/config/valuation-classes/ValuationClasses.tsx', 'referenceLocked', 'referenceGranted', {}, 'referenceClaim');
    expect([valuationGate('idle'), valuationGate('pending'), valuationGate('refused'), valuationGate('failed')], 'a section is worked on from a grant alone')
      .toEqual([false, false, false, false]);
    expect(valuationGate('open')).toBe(true);
  });

  it('has closed the family that used the projected answer as a boolean guard', () => {
    // The shape was `… && lock` / `!lock`: it hides a section for as long as the platform owes an answer,
    // which is right while a claim is pending and wrong once one has failed, because a failure then had no
    // notice to show. Two files used it; both are migrated above. The walk fails if a third appears, or if
    // either returns to the shape.
    const files: string[] = [];
    const visit = (dir: string) => {
      for (const entry of readdirSync(dir)) {
        const path = join(dir, entry);
        if (statSync(path).isDirectory()) visit(path);
        else if (path.endsWith('.tsx') || path.endsWith('.ts')) files.push(path);
      }
    }
    visit('src');
    const bound = new Map<string, string[]>();
    const guards = new Map<string, string[]>();
    for (const file of files) {
      const source = readFileSync(file, 'utf8');
      for (const match of source.matchAll(/const (\w*[Ll]ock\w*) = useChangeLock\(/g)) {
        bound.set(file, [...(bound.get(file) ?? []), match[1]]);
        const name = match[1];
        const used = new RegExp(`&&\\s*${name}\\s*[)&}]|!\\s*${name}\\b`);
        const hits = source.split('\n').filter((line) => used.test(line)).map((line) => line.trim().slice(0, 90));
        if (hits.length) guards.set(file, hits);
      }
    }
    // The scan is not vacuous: the hook is still bound in most lock screens, which is exactly why this
    // family, and not the whole of it, is what had to be closed here.
    expect(bound.size).toBeGreaterThan(80);
    expect([...guards.keys()].sort()).toEqual([]);
  });

  it('leaves no migrated submit that an ungranted claim can drive', () => {
    // Two shapes are allowed, and both are the claim's: the control is disabled by an expression that
    // reads the phase, or the form it belongs to is not rendered until the grant arrives. What is not
    // allowed is a control enabled by the absence of a refusal, which is how this family read a failure.
    const sources = new Map(MIGRATED.map((file) => [file, readFileSync(file, 'utf8')]));
    for (const [file, source] of sources) {
      for (const gate of source.match(/disabled=\{([^}]*)\}/g) ?? []) {
        expect(gate, `${file}: ${gate}`).not.toMatch(/!== 'DISPLAY'/);
        expect(gate, `${file}: ${gate}`).not.toMatch(/&&\s*\w*[Ll]ock\s*[)&}]/);
      }
      for (const gate of source.match(/const (?:writable|\w+Granted|lockedOut|waitingForLock)[^;]*;/g) ?? []) {
        expect(gate, `${file}: ${gate}`).toMatch(/claim\.phase|Claim\.phase|awaitingClaim/);
      }
    }
    // The Valuation Classes sections are the second shape: the form appears from a grant and nothing else,
    // so its own buttons need no extra condition. Each guard is checked to open the block its form sits in.
    const valuation = sources.get('src/app/config/valuation-classes/ValuationClasses.tsx')!;
    for (const [guard, form] of [
      ['(referenceRow && !referenceLocked && referenceGranted)) && (', 'action={saveReference}'],
      ['referenceRow && !referenceLocked && referenceGranted && (', 'action={deleteReference}'],
      ['(classRow && !classLocked && classGranted)) && (', 'action={saveClass}'],
      ['classRow && !classLocked && classGranted && (', 'action={deleteClass}'],
      ['typeRow && !typeLocked && typeGranted && (', 'action={assignType}'],
    ] as const) {
      const at = valuation.indexOf(guard);
      expect(at, guard).toBeGreaterThanOrEqual(0);
      const offset = valuation.indexOf(form) - at;
      expect(offset, `${guard} then ${form}`).toBeGreaterThan(0);
      expect(offset, `${guard} opens the block holding ${form}`).toBeLessThan(420);
    }
    // The Check sections read the record and are not lock-gated anywhere, in the screen or in the action.
    expect(valuation).toContain('disabled={checkPending}');
  });
});

describe('the copy a failed claim speaks', () => {
  it('is in the catalogue, in every locale there is, and not hardcoded in a screen', () => {
    expect(LOCALES).toEqual(['en']);
    const catalogue = readFileSync('src/platform/i18n/index.ts', 'utf8');
    for (const key of ['lock.claimFailed', 'lock.claimFailedRecovery', 'lock.claimRetry']) {
      expect(catalogue, key).toContain(`'${key}':`);
      expect(t(key), key).not.toBe(key);
    }
    expect(t('lock.claimFailed')).toBe('The change lock for this record could not be opened.');
    expect(t('lock.claimFailed')).not.toMatch(/locked by|is being changed|saved|written/i);
    expect(t('lock.claimRetry')).toBe('Try again');
    // The recovery line is the established one for an operation that wrote nothing: the same opening words
    // as the `x.unexpectedRemedy` sentences every other configuration screen already answers with.
    const family = /^Nothing was written\. Try again, and if it fails again /;
    expect(t('lock.claimFailedRecovery')).toMatch(family);
    for (const other of ['fiscalYearVariant.unexpectedRemedy', 'chartCopy.unexpectedRemedy', 'taxCode.unexpectedRemedy']) {
      expect(t(other), other).toMatch(family);
    }
    // The catalogue's own convention, kept: an unknown key is visible in the UI rather than blank.
    expect(t('lock.thisKeyDoesNotExist')).toBe('lock.thisKeyDoesNotExist');
  });

  it('resolves every lock key the shared hook and its migrated screens use', () => {
    const files = [
      'src/ui/lock/ChangeLock.tsx',
      'src/ui/lock/claim.ts',
      'src/ui/lock/remedy.ts',
      'src/app/config/movement-types/MovementTypes.tsx',
      'src/app/config/valuation-classes/ValuationClasses.tsx',
      'src/app/config/batch-document-management/DocumentForm.tsx',
      'src/app/config/controlling-area/ControllingAreaCompanyAssignmentUI.tsx',
    ];
    const keys = new Set<string>();
    for (const file of files) {
      for (const match of readFileSync(file, 'utf8').matchAll(/\bt\(\s*'([a-zA-Z0-9_.]+)'/g)) keys.add(match[1]);
    }
    expect(keys.size).toBeGreaterThan(12);
    for (const key of keys) expect(t(key), `${key} used in the lock surface`).not.toBe(key);
  });
});
