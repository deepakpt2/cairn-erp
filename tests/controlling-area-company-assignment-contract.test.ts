import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { controllingAreaCompanyAssignmentInputSchema } from '../src/modules/foundation/controlling-area-company-assignment';

const page = readFileSync('src/app/config/controlling-area/assign-company-code/page.tsx', 'utf8');
const actions = readFileSync('src/app/config/controlling-area/assign-company-code/actions.ts', 'utf8');
const ui = readFileSync('src/app/config/controlling-area/ControllingAreaCompanyAssignmentUI.tsx', 'utf8');
const compatibility = readFileSync('src/modules/foundation/controlling-area-company-compatibility.ts', 'utf8');
const assignment = readFileSync('src/modules/foundation/controlling-area-company-assignment.ts', 'utf8');
const okkp = readFileSync('src/modules/foundation/controlling-area-maintenance.ts', 'utf8');
const companyCodeCoa = readFileSync('src/modules/foundation/company-code-coa-assignment.ts', 'utf8');
const foundationServices = readFileSync('src/modules/foundation/services.ts', 'utf8');
const standardConfig = readFileSync('src/modules/foundation/standard-config.ts', 'utf8');
const standardStructure = readFileSync('src/platform/tenancy/standard-structure.ts', 'utf8');
const workbench = readFileSync('src/app/config/page.tsx', 'utf8');
const workbenchTree = readFileSync('src/app/config/WorkbenchTree.tsx', 'utf8');
const seed = readFileSync('scripts/seed.ts', 'utf8');
const migration = readFileSync('drizzle/0032_controlling_area_company_ox19.sql', 'utf8');
const locale = readFileSync('src/platform/i18n/index.ts', 'utf8');

const valid = {
  client: 'T025',
  changedBy: 'test.operator',
  controllingArea: ' a000 ',
  companyCode: ' aBc1 ',
};

describe('SCR-025 / OX19 assignment contract', () => {
  it('normalizes the Controlling Area but preserves the existing Company Code key case', () => {
    expect(controllingAreaCompanyAssignmentInputSchema.parse(valid)).toMatchObject({
      client: 'T025',
      changedBy: 'test.operator',
      controllingArea: 'A000',
      companyCode: 'aBc1',
    });
    expect(() => controllingAreaCompanyAssignmentInputSchema.parse({ ...valid, companyCode: 'AB1' })).toThrow();
    expect(() => controllingAreaCompanyAssignmentInputSchema.parse({ ...valid, companyCode: 'AB-1' })).toThrow();
    expect(() => controllingAreaCompanyAssignmentInputSchema.parse({ ...valid, reassignment: true })).toThrow();
  });

  it('offers all tenant-local source masters, including inactive records, with four-character format selection', () => {
    expect(page).toContain('.where(eq(controllingArea.client, client))');
    expect(page).toContain('.where(eq(companyCode.client, client))');
    expect(page).not.toContain('eq(controllingArea.isActive, true)');
    expect(page).not.toContain('eq(companyCode.isActive, true)');
    expect(page).toContain('selectable: /^[A-Za-z0-9]{4}$/.test(code)');
    expect(ui).toContain('pattern="[A-Za-z0-9]{4}"');
    expect(ui).toContain('normalizeUppercase={false}');
  });

  it('requires both owner-approved capabilities before each mutation and derives tenant and actor from session', () => {
    const assignAction = actions.slice(
      actions.indexOf('export async function assignControllingAreaCompanyAction'),
      actions.indexOf('export async function unassignControllingAreaCompanyAction'),
    );
    const unassignAction = actions.slice(actions.indexOf('export async function unassignControllingAreaCompanyAction'));
    for (const [source, serviceCall] of [
      [assignAction, 'await assignCompanyCodeToControllingArea({'],
      [unassignAction, 'await unassignCompanyCodeFromControllingArea({'],
    ]) {
      expect(source).toContain('await requireSession(ROUTE)');
      expect(source).toContain('await requireCapability(CONTROLLING_AREA_DEFINE, session)');
      expect(source).toContain('await requireCapability(COMPANY_CODE_DEFINE, session)');
      expect(source.indexOf('await requireCapability(CONTROLLING_AREA_DEFINE, session)')).toBeLessThan(source.indexOf(serviceCall));
      expect(source.indexOf('await requireCapability(COMPANY_CODE_DEFINE, session)')).toBeLessThan(source.indexOf(serviceCall));
      expect(source).toContain('client: session.user.client');
      expect(source).toContain('changedBy: session.user.username');
      expect(source).not.toMatch(/client:\s*read\(/);
      expect(source).not.toMatch(/changedBy:\s*read\(/);
    }
  });

  it('wires Add and Unassign to server actions and renders pending, success, duplicate and error feedback', () => {
    expect(ui).toContain('useActionState<ControllingAreaCompanyAssignmentActionState, FormData>');
    expect(ui).toContain('<form action={assignAction}');
    // Each layout hands `unassignAction` to one shared `UnassignPair`, and the component renders
    // the form around it (SM12 gave it the lock's props). Counted through the component the
    // contract is the same one this line was written for: one unassign form per layout, wired to
    // the server action, and no unassign control outside it.
    expect((ui.match(/<UnassignPair\b/g) ?? []).length).toBe(2);
    expect((ui.match(/action=\{unassignAction\}/g) ?? []).length).toBe(2);
    // The row's own form, addressed so a press held for the opening can be replayed into it.
    expect(ui).toMatch(/<form\s+ref=\{formRef\}\s+action=\{action\}/);
    expect(ui).toContain('disabled={!canMaintain || assignmentPending}');
    expect(ui).toContain("role={assignmentState.ok ? 'status' : 'alert'}");
    expect(ui).toContain("role={unassignmentState.ok ? 'status' : 'alert'}");
    // The unassign controls moved into the shared component both layouts hand their flags to, so
    // each refusal is expressed once, in the component, against its own props: the pending flag,
    // the capability, and the change lock SM12 added — whose display-only mode also refuses the
    // form's own submit. The same refusals the six literals above used to read off the file.
    expect((ui.match(/pending=\{unassignmentPending\}/g) ?? []).length).toBe(2);
    // The refusals the row has always had — no capability, and a display-only opening. A claim in
    // flight must NOT disable the control: that would eat the press between mousedown and mouseup,
    // which is the failure this round is about, rediscovered in the first attempt at fixing it.
    expect(ui).toContain('disabled={!canMaintain || pending || refused}');
    expect(ui).not.toContain('const opening =');
    expect(ui).not.toMatch(/disabled=\{[^}]*opening/);
    expect(ui).toContain('<input type="hidden" name="controllingArea" value={controllingArea} />');
    expect(ui).toContain('<input type="hidden" name="companyCode" value={companyCode} />');
    expect(ui).not.toContain('keepPreviewLocal');
    expect(actions).toContain("t('controllingArea.assignmentDuplicate'");
    expect(locale).toContain('controllingArea.assignmentAdded');
    expect(locale).toContain('controllingArea.assignmentDuplicate');
    expect(locale).toContain('controllingArea.assignmentRemoved');
  });

  it('keeps the press that opens a row lock without loosening the gate it has to pass', () => {
    // Why a row form needs a queue at all: unlike every other lock screen, it has no field to
    // focus before its button, so the click that claims the opening is the same click the gate
    // refuses. The browser round found it exactly there — the press acquired
    // `CONTROLLING_AREA_COMPANY M210/M201`, filed no submit, and left the control enabled and
    // silent, so an operator had to press again for no stated reason.
    expect(ui).toContain('const { claim, notice, retry, reportPress, dispatched } = useChangeLockClaim(');
    expect((ui.match(/useChangeLock\w*\(/g) ?? []).length).toBe(1);
    expect(ui).not.toContain('const lock = ');
    expect(ui).toContain("const refused = claim.phase === 'refused';");
    // The press is replayed only once the claim has been granted, and it is spent by the shared rule
    // rather than by a condition the screen has to remember to get right.
    expect(ui).toMatch(/if \(!shouldDispatch\(claim\)\) return;/);
    expect(ui).toContain('dispatched();');
    expect(ui).toMatch(/if \(form\) action\(new FormData\(form\)\);/);
    // A press that arrives before the answer is kept, not submitted unauthenticated: the only thing
    // the early press does is start the claim and hand the intent to it.
    expect(ui).toMatch(/if \(claim\.phase === 'open'\) return;\s*event\.preventDefault\(\);\s*setEngaged\(true\);\s*reportPress\(\);/);
    expect(ui).toContain('onFocus={() => setEngaged(true)}');
    // Exactly one dispatch path, and the form itself still owns the ordinary press.
    expect((ui.match(/new FormData\(form\)/g) ?? []).length).toBe(1);
    expect(ui).not.toContain('requestSubmit');
    // No timer stands in for the answer: the claim says whether a reply is owed.
    expect(ui).not.toMatch(/setTimeout|setInterval/);
    // Opening the row is what the interaction does, and the queue cannot widen it: the queue lives in
    // the claim this condition would decide, so the condition reads only the interaction.
    expect(ui).toContain('engaged && canMaintain,');
    // Both refusals stay: display-only still speaks through the shared notice with its remedy, and
    // the action re-checks the lock, so a submit forced past the client gate is refused server-side.
    expect(ui).toContain('message={refused ? notice.message : null}');
    expect(ui).toContain('remedy={refused ? notice.remedy : null}');
    expect(actions).toContain('await assertChangeForSession(session, {');
    expect(actions).toContain("lockObject: 'CONTROLLING_AREA_COMPANY',");
    expect(actions).toContain('argument: `${controllingArea}/${companyCode}`,');
  });

  it('tells an unreachable claim apart from a refused one, and retries only on an explicit request', () => {
    // The failure path the shared contract adds, pinned where the queue is pinned: a claim that never
    // answered is announced as a failure in the platform's own words, never as somebody else holding
    // the row; the screen claims no lock and no saved change; and the way back is the operator's next
    // press, not a timer and not the queue replaying itself.
    // The failure notice is the shared one, so a screen cannot reword or forget the retry affordance.
    expect(ui).toContain('<ClaimFailureNotice claim={claim} onRetry={retry} />');
    expect(ui).toContain("if (claim.phase === 'open') return;");
    expect(ui).not.toMatch(/setTimeout|setInterval|retry\(\)/);
    expect(ui).not.toMatch(/role="alert"/);
    expect(ui).not.toContain("t('common.error')");
    // The refusal keeps its copy and its recovery sentence; the failure never borrows them.
    expect(ui).toContain('message={refused ? notice.message : null}');
    expect(ui).toContain('remedy={refused ? notice.remedy : null}');
    expect(ui).toContain("{pending ? t('common.saving') : t('controllingArea.assignmentUnassignButton')}");
    // The retry is not a replay: a press kept by the failed attempt is gone, and the notice's button is the
    // only other way a claim restarts. Both are the claim's rules, not this screen's.
    expect(ui).not.toMatch(/setQueued\(true\)[\s\S]*retry/);
    expect(ui.match(/<ClaimFailureNotice/g)).toHaveLength(1);
  });

  it('enforces exact currency/Fiscal Year Variant matches and current-assignment CoA baseline', () => {
    expect(assignment).toContain('companyCurrency !== areaCurrency');
    expect(assignment).toContain('companyFiscalYearVariant !== areaFiscalYearVariant');
    expect(assignment).toContain('chartBaseline !== null && chartBaseline !== companyChartOfAccounts');
    expect(assignment).toContain('async function validateCurrentAreaAssignments');
    expect(assignment).toContain('recordDuplicateAssignmentEvent');
    expect(assignment).toContain("newValue: 'DUPLICATE_NO_OP'");
    expect(assignment).toContain("changeType: 'DELETE'");
    expect(assignment).toContain('export async function unassignCompanyCodeFromControllingArea');
    expect(assignment).not.toContain('isActive');
  });

  it('coordinates assignment and source-master locks, and guards every in-repo financial-setting write path', () => {
    expect(compatibility).toContain('pg_advisory_xact_lock');
    expect(compatibility).toContain('controlling_area_company_code/${companyCodeKey}');
    expect(compatibility).toContain('controlling_area/${areaCode}');
    expect(compatibility).toContain(".for('share')");
    expect(compatibility).toContain('year !== areaFiscalYearVariant');
    expect(compatibility).toContain('currency !== areaCurrency');
    expect(compatibility).toContain("area.companyCodeScope === 'MULTIPLE' && currentCharts.size > 1");
    expect(assignment).toContain('lockCompanyCodeOxxAssignments(tx, client, companyCodeKey, [areaCode])');
    expect(companyCodeCoa).toContain('assertCompanyCodeFinancialSettingsCompatible');
    expect(foundationServices).toContain('assertCompanyCodeFinancialSettingsCompatible');
    // The standard package no longer writes company financial settings at all — SCR-032
    // removed its company-specific half — so the write path this inventory tracks moved
    // to the structure builder. The builder does not call the compatibility assert
    // itself: it only ever inserts a company code that cannot already exist, and it
    // reaches the controlling area through the OX19 service below, which validates the
    // chart baseline against the area's other assignments.
    expect(standardConfig).not.toContain('assertCompanyCodeFinancialSettingsCompatible');
    expect(standardStructure).toContain('assignCompanyCodeToControllingAreaInTransaction(tx, {');
    expect(okkp).toContain('row.currency.trim() !== areaCurrency');
    expect(okkp).toContain("scope === 'MULTIPLE' && chartBaseline !== null && chartBaseline !== chart");
  });

  it('keeps the OX19 route discoverable from the workbench and the migration fail-closed', () => {
    expect(workbench).toContain("'/config/controlling-area/assign-company-code'");
    // The workbench renders as a tree, so the rule that a route is offered only when its screen
    // exists lives in the component that draws the link, fed by the page's list of built routes.
    expect(workbench).toContain('builtRoutes={[...BUILT_ROUTES]}');
    expect(workbenchTree).toContain('item.route_path && routes.has(item.route_path)');
    expect(workbench).not.toContain('PENDING_ACTIVITY_CODES');
    expect(seed).toContain("code: 'CFG.COST.CONTROLLINGAREA.ASSIGN_COMPANY'");
    expect(seed).toContain("route: '/config/controlling-area/assign-company-code'");
    expect(migration).toContain('0032 refuses OX19 compatibility validation');
    expect(migration).toContain('controlling_area_company_code_unique_idx');
    expect(migration).toContain('controlling_area_company_area_fk');
    expect(migration).toContain('controlling_area_company_company_code_fk');
  });
});
