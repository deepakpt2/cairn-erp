'use client';
import { useActionState } from 'react';
import { t } from '@/platform/i18n';
import type { listSupplierPartnerChoices, listSupplierPartnerFunctions, listSupplierPurchasingPartners } from '@/modules/foundation/supplier-purchasing-partners';
import { removeSupplierPurchasingPartnerAction, saveSupplierPurchasingPartnerAction, type PartnerFunctionActionState } from './partner-function-actions';

type FunctionRow = Pick<Awaited<ReturnType<typeof listSupplierPartnerFunctions>>[number], 'functionCode' | 'displayName' | 'allowsMultiple' | 'isActive'>;
type AssignmentRow = Awaited<ReturnType<typeof listSupplierPurchasingPartners>>[number];
type SupplierChoice = Awaited<ReturnType<typeof listSupplierPartnerChoices>>[number];

/** Partner-function display and, for purchasing maintainers, assignment controls. */
export function SupplierPartnerFunctionsPanel({
  partner, purchasingOrg, functions, assignments, suppliers, editable, maintain, segmentReady,
}: {
  partner: string;
  purchasingOrg: string;
  functions: FunctionRow[];
  assignments: AssignmentRow[];
  suppliers: SupplierChoice[];
  editable: boolean;
  maintain: boolean;
  segmentReady: boolean;
}) {
  return <section className="panel p-4" aria-labelledby="supplier-partner-functions-title">
    <header className="mb-3">
      <h2 id="supplier-partner-functions-title" className="panel-title">{t('spp.title')}</h2>
      <p className="mt-1 text-sm text-ink-soft">{t('spp.description')}</p>
      {maintain && !segmentReady && <p className="mt-2 text-xs text-signal-warn">{t('spp.segmentRequired')}</p>}
    </header>
    {!functions.length ? <p className="text-sm text-ink-soft">{t('spp.noCatalogue')}</p> :
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {functions.map(fn => <FunctionCard
          key={fn.functionCode}
          partner={partner}
          purchasingOrg={purchasingOrg}
          fn={fn}
          rows={assignments.filter(row => row.functionCode === fn.functionCode)}
          suppliers={suppliers}
          editable={editable}
        />)}
      </div>}
  </section>;
}

function FunctionCard({ partner, purchasingOrg, fn, rows, suppliers, editable }: {
  partner: string;
  purchasingOrg: string;
  fn: FunctionRow;
  rows: AssignmentRow[];
  suppliers: SupplierChoice[];
  editable: boolean;
}) {
  const hasDefault = rows.some(row => row.isDefault);
  const used = new Set(rows.map(row => row.assignedPartnerNumber));
  const available = suppliers.filter(supplier => !used.has(supplier.partnerNumber));
  const replace = !fn.allowsMultiple && rows.length === 1 ? rows[0] : undefined;
  const canAdd = editable && fn.isActive && (fn.allowsMultiple || rows.length <= 1);

  return <article className="border border-line p-3">
    <div className="flex flex-wrap items-start justify-between gap-2">
      <div>
        <h3 className="font-medium">{fn.displayName}</h3>
        <p className="code text-2xs text-ink-faint">{fn.functionCode}</p>
      </div>
      <span className="chip">{t(fn.allowsMultiple ? 'spp.cardinality.multiple' : 'spp.cardinality.unique')}</span>
    </div>
    {!fn.isActive && <p className="mt-2 text-xs text-signal-warn">{t('spp.inactiveFunction')}</p>}
    {!rows.length ? <p className="mt-3 text-sm text-ink-soft">{t('spp.noneAssigned')}</p> :
      <ul className="mt-3 space-y-2">
        {rows.map(row => <AssignmentRowView
          key={`${row.assignedPartnerNumber}/${row.version}`}
          partner={partner}
          purchasingOrg={purchasingOrg}
          functionCode={fn.functionCode}
          functionActive={fn.isActive}
          functionAllowsMultiple={fn.allowsMultiple}
          row={row}
          editable={editable}
        />)}
      </ul>}
    {fn.allowsMultiple && rows.length > 0 && !hasDefault &&
      <p className="mt-3 border-t border-line pt-2 text-2xs text-ink-soft">{t('spp.noDefault')}</p>}
    {canAdd && (fn.allowsMultiple || rows.length === 0 || replace) && <SupplierAssignmentForm
          key={`${fn.functionCode}/${replace?.assignedPartnerNumber ?? 'new'}/${replace?.version ?? 0}`}
      partner={partner}
      purchasingOrg={purchasingOrg}
      functionCode={fn.functionCode}
      allowsMultiple={fn.allowsMultiple}
      suppliers={available}
      supplierListLimited={suppliers.length === 200}
      replace={replace}
    />}
    {editable && fn.isActive && !fn.allowsMultiple && rows.length > 1 &&
      <p className="mt-3 text-2xs text-signal-warn">{t('spp.uniqueNeedsCleanup')}</p>}
  </article>;
}

function SupplierAssignmentForm({ partner, purchasingOrg, functionCode, allowsMultiple, suppliers, supplierListLimited, replace }: {
  partner: string;
  purchasingOrg: string;
  functionCode: FunctionRow['functionCode'];
  allowsMultiple: boolean;
  suppliers: SupplierChoice[];
  supplierListLimited: boolean;
  replace?: AssignmentRow;
}) {
  const [state, action, pending] = useActionState(saveSupplierPurchasingPartnerAction, { ok: true });
  if (!suppliers.length) return <div className="mt-3 border-t border-line pt-3 text-xs text-ink-soft">
    <p>{t('spp.noAvailableSupplier')}</p>
    {supplierListLimited && <p className="mt-1">{t('spp.supplierLimit')}</p>}
  </div>;
  return <div className="mt-3 border-t border-line pt-3">
    <Feedback state={state}/>
    <form key={`${replace?.version ?? 0}/${suppliers.length}`} action={action} className="space-y-2">
      <input type="hidden" name="partnerNumber" value={partner}/>
      <input type="hidden" name="purchasingOrg" value={purchasingOrg}/>
      <input type="hidden" name="functionCode" value={functionCode}/>
      <input type="hidden" name="expectedVersion" value={replace?.version ?? 0}/>
      {replace && <input type="hidden" name="replaceAssignedPartnerNumber" value={replace.assignedPartnerNumber}/>}
      <label className="block">
        <span className="field-label">{t(replace ? 'spp.replaceSupplier' : 'spp.addSupplier')}</span>
        <select name="assignedPartnerNumber" required defaultValue="" className="field-input">
          <option value="">{t('spp.chooseSupplier')}</option>
          {suppliers.map(supplier => <option key={supplier.partnerNumber} value={supplier.partnerNumber}>
            {supplier.partnerNumber} · {supplier.name} · {t(`bp.status.${supplier.isBlocked ? 'BLOCKED' : supplier.generalStatus}`)}
          </option>)}
        </select>
      </label>
      {supplierListLimited && <p className="text-2xs text-ink-soft">{t('spp.supplierLimit')}</p>}
      {allowsMultiple && <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" name="isDefault" className="accent-accent"/>{t('spp.makeDefault')}
      </label>}
      <ReasonField/>
      <button className="btn btn-primary" disabled={pending}>{pending ? t('common.saving') : t(replace ? 'spp.replace' : 'spp.add')}</button>
    </form>
  </div>;
}

function AssignmentRowView({ partner, purchasingOrg, functionCode, functionActive, functionAllowsMultiple, row, editable }: {
  partner: string;
  purchasingOrg: string;
  functionCode: FunctionRow['functionCode'];
  functionActive: boolean;
  functionAllowsMultiple: boolean;
  row: AssignmentRow;
  editable: boolean;
}) {
  const [saveState, saveAction, savePending] = useActionState(saveSupplierPurchasingPartnerAction, { ok: true });
  const [removeState, removeAction, removePending] = useActionState(removeSupplierPurchasingPartnerAction, { ok: true });
  return <li className="border-t border-line pt-2">
    <div className="flex flex-wrap items-center gap-2">
      <span className="code text-sm">{row.assignedPartnerNumber}</span>
      {row.isDefault && <span className="chip chip-ok">{t('spp.default')}</span>}
      {row.assignedPartnerIsBlocked && <span className="chip chip-warn">{t('bp.status.BLOCKED')}</span>}
      {!row.assignedSupplierIsActive && <span className="chip chip-warn">{t('spp.inactiveSupplierRole')}</span>}
    </div>
    <p className="text-sm">{row.assignedPartnerName || t('bp.notSet')}</p>
    <p className="text-2xs text-ink-soft">{t(`bp.status.${row.assignedPartnerIsBlocked ? 'BLOCKED' : row.assignedPartnerStatus}`)}</p>
    {editable && functionActive && functionAllowsMultiple && <>
      <Feedback state={saveState}/>
      <form key={row.version} action={saveAction} className="mt-2 flex flex-wrap items-end gap-2">
        <input type="hidden" name="partnerNumber" value={partner}/>
        <input type="hidden" name="purchasingOrg" value={purchasingOrg}/>
        <input type="hidden" name="functionCode" value={functionCode}/>
        <input type="hidden" name="assignedPartnerNumber" value={row.assignedPartnerNumber}/>
        <input type="hidden" name="expectedVersion" value={saveState.version ?? row.version}/>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" name="isDefault" defaultChecked={row.isDefault} className="accent-accent"/>{t('spp.makeDefault')}
        </label>
        <ReasonField/>
        <button className="btn btn-default" disabled={savePending}>{savePending ? t('common.saving') : t('common.save')}</button>
      </form>
    </>}
    {editable && <>
      <Feedback state={removeState} removal/>
      <form action={removeAction} className="mt-2 flex flex-wrap items-end gap-2">
        <input type="hidden" name="partnerNumber" value={partner}/>
        <input type="hidden" name="purchasingOrg" value={purchasingOrg}/>
        <input type="hidden" name="functionCode" value={functionCode}/>
        <input type="hidden" name="assignedPartnerNumber" value={row.assignedPartnerNumber}/>
        <input type="hidden" name="expectedVersion" value={row.version}/>
        <ReasonField/>
        <button className="btn btn-default" disabled={removePending}>{removePending ? t('common.saving') : t('spp.remove')}</button>
      </form>
    </>}
  </li>;
}

function ReasonField() {
  return <label className="block min-w-40 flex-1">
    <span className="field-label">{t('bp.reason')}</span>
    <input name="reason" required minLength={3} maxLength={500} className="field-input"/>
  </label>;
}

function Feedback({ state, removal = false }: { state: PartnerFunctionActionState; removal?: boolean }) {
  const message = !state.ok ? state.message : removal && state.removedVersion !== undefined
    ? t('spp.removed') : state.changed === true ? t('spp.saved') : state.changed === false ? t('spp.unchanged') : undefined;
  if (!message) return null;
  return <div role="status" className={`mt-2 border p-2 text-xs ${state.ok ? 'border-signal-ok/30 bg-signal-ok-soft text-signal-ok' : 'border-signal-error/30 bg-signal-error-soft text-signal-error'}`}>
    <p>{message}</p>{state.remedy && <p>{state.remedy}</p>}
  </div>;
}
