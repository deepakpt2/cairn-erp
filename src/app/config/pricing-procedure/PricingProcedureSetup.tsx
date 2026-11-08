'use client';

import { useActionState, useState } from 'react';

import {
  addStepAction,
  changeConditionTypeAction,
  changeDeterminationAction,
  changeProcedureAction,
  changeStepAction,
  defineConditionTypeAction,
  defineDeterminationAction,
  defineProcedureAction,
  type PricingActionState,
} from './actions';
import type { ConditionTypeRow, DeterminationRow, ProcedureRow } from '@/modules/sales/pricing-procedure-maintenance';

const INITIAL: PricingActionState = { ok: false, message: '' };

function Notice({ state }: { state: PricingActionState }) {
  if (!state.message) return null;
  return (
    <p role="status" className={`mt-3 text-sm ${state.ok ? 'text-ink' : 'text-red-700'}`}>
      {state.message}
      {state.remedy ? ` ${state.remedy}` : ''}
    </p>
  );
}

function Field({ label, help, children }: { label: string; help?: string; children: React.ReactNode }) {
  return (
    <label className="block text-sm">
      <span className="mb-1 block font-medium">{label}</span>
      {children}
      {help ? <span className="mt-1 block text-xs text-ink-faint">{help}</span> : null}
    </label>
  );
}

export function PricingProcedureSetup({
  types,
  procedures,
  determinations,
}: {
  types: ConditionTypeRow[];
  procedures: ProcedureRow[];
  determinations: DeterminationRow[];
}) {
  // The form action each form below is driven by. They are named for the form rather than for the
  // action they wrap, so a reader can tell the dispatcher from the thing dispatched.
  const [defineTypeState, defineTypeForm, defineTypePending] = useActionState(defineConditionTypeAction, INITIAL);
  const [changeTypeState, changeTypeForm, changeTypePending] = useActionState(changeConditionTypeAction, INITIAL);
  const [defineProcedureState, defineProcedureForm, defineProcedurePending] = useActionState(defineProcedureAction, INITIAL);
  const [changeProcedureState, changeProcedureForm, changeProcedurePending] = useActionState(changeProcedureAction, INITIAL);
  const [addStepState, addStepForm, addStepPending] = useActionState(addStepAction, INITIAL);
  const [changeStepState, changeStepForm, changeStepPending] = useActionState(changeStepAction, INITIAL);
  const [defineDetState, defineDetForm, defineDetPending] = useActionState(defineDeterminationAction, INITIAL);
  const [changeDetState, changeDetForm, changeDetPending] = useActionState(changeDeterminationAction, INITIAL);

  const [selectedType, setSelectedType] = useState('');
  const [selectedProcedure, setSelectedProcedure] = useState('');
  const [selectedStep, setSelectedStep] = useState('');
  const [selectedDetermination, setSelectedDetermination] = useState('');

  const type = types.find((row) => row.conditionType === selectedType);
  const procedure = procedures.find((row) => row.procedureCode === selectedProcedure);
  const step = procedure?.steps.find((row) => String(row.stepNumber) === selectedStep);
  const determination = determinations.find(
    (row) => `${row.salesOrg}/${row.distributionChannel}/${row.division}/${row.documentPricingProcedure}/${row.customerPricingProcedure}`
      === selectedDetermination,
  );

  return (
    <div className="space-y-4">
      <section aria-labelledby="pricing-maintain-types" className="border border-line bg-surface p-4">
        <h2 id="pricing-maintain-types" className="text-sm font-semibold">The condition types</h2>
        <p className="mt-1 max-w-3xl text-sm text-ink-soft">
          What a figure on a document <em>is</em>. The class decides whether it is revenue, a deduction, a
          charge or a tax; the calculation decides how it becomes an amount; the account key is what the
          ledger account will be found by. A type that carries records or stands in a procedure is
          withdrawn from nothing: it is still the type the documents standing were priced by.
        </p>

        <div className="mt-4 grid gap-6 md:grid-cols-2">
          <form action={defineTypeForm} className="space-y-3">
            <h3 className="text-sm font-medium">Define a type that does not stand</h3>
            <Field label="Condition type" help="Four letters or digits, as the delivered master uses: PR00, K007, KF00, HD00, VPRS, MWST.">
              <input name="conditionType" required maxLength={4} pattern="[A-Za-z0-9]{4}" className="field w-full font-mono uppercase" />
            </Field>
            <Field label="Name" help="What the printout and this screen show.">
              <input name="name" required maxLength={40} className="field w-full" />
            </Field>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Class">
                <select name="conditionClass" required className="field w-full" defaultValue="PRICE">
                  <option value="PRICE">PRICE</option>
                  <option value="DISCOUNT">DISCOUNT</option>
                  <option value="FREIGHT">FREIGHT</option>
                  <option value="TAX">TAX</option>
                  <option value="COST">COST</option>
                </select>
              </Field>
              <Field label="Calculated as">
                <select name="calculationType" required className="field w-full" defaultValue="FIXED">
                  <option value="FIXED">FIXED — a figure per price unit</option>
                  <option value="PERCENTAGE">PERCENTAGE — of a span of steps</option>
                  <option value="MATERIAL_COST">MATERIAL_COST — read from the valuation</option>
                </select>
              </Field>
            </div>
            <Field label="Account key" help="Three characters: ERL revenue, ERS deduction, ERF freight, MWS output tax. Blank for a statistical cost.">
              <input name="accountKey" maxLength={3} className="field w-full font-mono uppercase" placeholder="(none)" />
            </Field>
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" name="isNegative" className="h-4 w-4" />
              Takes away from the value it is calculated on
            </label>
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" name="isStatistical" className="h-4 w-4" />
              Statistical — shown on the document, in no total and no ledger line
            </label>
            <button type="submit" disabled={defineTypePending} className="btn btn-primary min-h-11 w-full">
              {defineTypePending ? 'Defining…' : 'Define the type'}
            </button>
            <Notice state={defineTypeState} />
          </form>

          <div className="space-y-3">
            <h3 className="text-sm font-medium">Redefine a type that stands</h3>
            {types.length === 0 ? (
              <p className="text-sm text-ink-soft">No condition types stand for this tenant yet.</p>
            ) : (
              <>
                <Field label="Condition type">
                  <select value={selectedType} onChange={(event) => setSelectedType(event.target.value)} className="field w-full font-mono">
                    <option value="">(select a type)</option>
                    {types.map((row) => (
                      <option key={row.conditionType} value={row.conditionType}>
                        {row.conditionType} — {row.name}
                      </option>
                    ))}
                  </select>
                </Field>
                {type && (
                  <>
                    <dl className="grid grid-cols-2 gap-x-3 gap-y-1 border border-line p-3 text-sm">
                      <dt className="text-ink-faint">Class</dt>
                      <dd className="font-mono">{type.conditionClass}</dd>
                      <dt className="text-ink-faint">Calculated as</dt>
                      <dd className="font-mono">{type.calculationType}</dd>
                      <dt className="text-ink-faint">Account key</dt>
                      <dd className="font-mono">{type.accountKey ?? '—'}</dd>
                      <dt className="text-ink-faint">Records standing</dt>
                      <dd>{type.recordsStanding}</dd>
                      <dt className="text-ink-faint">Steps standing</dt>
                      <dd>{type.stepsStanding}</dd>
                      <dt className="text-ink-faint">Status</dt>
                      <dd>{type.isActive ? 'Offered' : 'Withdrawn'}</dd>
                    </dl>
                    <p className="text-xs text-ink-faint">
                      The class and the calculation are not changed here: they are what the engine executes.
                      A type that needs another calculation is another type.
                    </p>
                    <form action={changeTypeForm} className="space-y-3">
                      <input type="hidden" name="conditionType" value={type.conditionType} />
                      <Field label="Name">
                        <input name="name" maxLength={40} defaultValue={type.name} key={`name-${type.conditionType}`} className="field w-full" />
                      </Field>
                      <Field label="Account key">
                        <input
                          name="accountKey" maxLength={3} defaultValue={type.accountKey ?? ''}
                          key={`key-${type.conditionType}`} className="field w-full font-mono uppercase" placeholder="(none)"
                        />
                      </Field>
                      <label className="flex items-center gap-2 text-sm">
                        <input type="checkbox" name="isNegative" defaultChecked={type.isNegative} className="h-4 w-4" />
                        Takes away from the value it is calculated on
                      </label>
                      <label className="flex items-center gap-2 text-sm">
                        <input type="checkbox" name="isStatistical" defaultChecked={type.isStatistical} className="h-4 w-4" />
                        Statistical — in no total and no ledger line
                      </label>
                      <button type="submit" disabled={changeTypePending} className="btn btn-default min-h-11 w-full">
                        {changeTypePending ? 'Saving…' : 'Save the type'}
                      </button>
                    </form>
                    <Notice state={changeTypeState} />
                    <form action={changeTypeForm}>
                      <input type="hidden" name="conditionType" value={type.conditionType} />
                      <input type="hidden" name="isActive" value={type.isActive ? 'false' : 'true'} />
                      <input type="hidden" name="name" value={type.name} />
                      <input type="hidden" name="accountKey" value={type.accountKey ?? ''} />
                      {type.isNegative ? <input type="hidden" name="isNegative" value="true" /> : null}
                      {type.isStatistical ? <input type="hidden" name="isStatistical" value="true" /> : null}
                      <button type="submit" disabled={changeTypePending} className="btn btn-default min-h-11 w-full">
                        {type.isActive ? 'Withdraw the type' : 'Offer the type again'}
                      </button>
                      <p className="mt-1 text-xs text-ink-faint">
                        A type carrying records or standing in a procedure is not withdrawn: withdrawing it
                        would change how every future document is priced, and nobody would be told.
                      </p>
                    </form>
                  </>
                )}
              </>
            )}
          </div>
        </div>
      </section>

      <section aria-labelledby="pricing-maintain-procedure" className="border border-line bg-surface p-4">
        <h2 id="pricing-maintain-procedure" className="text-sm font-semibold">The procedures and their steps</h2>
        <p className="mt-1 max-w-3xl text-sm text-ink-soft">
          A procedure is an ordered set of steps, and the order is the arithmetic: a discount at step 20 is
          taken on the price at step 10, and a tax at step 40 is charged on what survived everything before
          it. A percentage step names the span of steps it is calculated on — a tax on the gross would be a
          tax on a discount the customer never paid.
        </p>

        <div className="mt-4 grid gap-6 md:grid-cols-2">
          <form action={defineProcedureForm} className="space-y-3">
            <h3 className="text-sm font-medium">Define a procedure</h3>
            <Field label="Procedure" help="Up to six characters, as the delivered procedure is: RVAA01.">
              <input name="procedureCode" required maxLength={6} pattern="[A-Za-z0-9]{1,6}" className="field w-full font-mono uppercase" />
            </Field>
            <Field label="Name">
              <input name="name" required maxLength={40} className="field w-full" />
            </Field>
            <button type="submit" disabled={defineProcedurePending} className="btn btn-primary min-h-11 w-full">
              {defineProcedurePending ? 'Defining…' : 'Define the procedure'}
            </button>
            <Notice state={defineProcedureState} />
          </form>

          <form action={addStepForm} className="space-y-3">
            <h3 className="text-sm font-medium">Add a step to a procedure</h3>
            <Field label="Procedure">
              <select name="procedureCode" required className="field w-full font-mono" defaultValue="">
                <option value="">(select a procedure)</option>
                {procedures.map((row) => (
                  <option key={row.procedureCode} value={row.procedureCode}>
                    {row.procedureCode} — {row.name}
                  </option>
                ))}
              </select>
            </Field>
            <div className="grid gap-3 sm:grid-cols-3">
              <Field label="Step">
                <input name="stepNumber" required type="number" min={1} step={1} className="field w-full font-mono" placeholder="10" />
              </Field>
              <Field label="Condition type">
                <select name="conditionType" required className="field w-full font-mono" defaultValue="">
                  <option value="">(select)</option>
                  {types.filter((row) => row.isActive).map((row) => (
                    <option key={row.conditionType} value={row.conditionType}>{row.conditionType}</option>
                  ))}
                </select>
              </Field>
              <Field label="Level">
                <select name="conditionLevel" className="field w-full" defaultValue="ITEM">
                  <option value="ITEM">ITEM</option>
                  <option value="HEADER">HEADER</option>
                </select>
              </Field>
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="From step" help="Blank where the step needs no base.">
                <input name="fromStep" type="number" min={1} step={1} className="field w-full font-mono" placeholder="(none)" />
              </Field>
              <Field label="To step">
                <input name="toStep" type="number" min={1} step={1} className="field w-full font-mono" placeholder="(none)" />
              </Field>
            </div>
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" name="isRequired" className="h-4 w-4" />
              The document may not go without it
            </label>
            <p className="text-xs text-ink-faint">
              A required step with no record standing refuses the document — the price is one. A discount
              nobody maintains is a sale at list price, not a refusal.
            </p>
            <button type="submit" disabled={addStepPending} className="btn btn-primary min-h-11 w-full">
              {addStepPending ? 'Adding…' : 'Add the step'}
            </button>
            <Notice state={addStepState} />
          </form>
        </div>

        <div className="mt-6 grid gap-6 md:grid-cols-2">
          <div className="space-y-3">
            <h3 className="text-sm font-medium">Redefine a procedure</h3>
            <Field label="Procedure">
              <select
                value={selectedProcedure}
                onChange={(event) => { setSelectedProcedure(event.target.value); setSelectedStep(''); }}
                className="field w-full font-mono"
              >
                <option value="">(select a procedure)</option>
                {procedures.map((row) => (
                  <option key={row.procedureCode} value={row.procedureCode}>
                    {row.procedureCode} — {row.name}
                  </option>
                ))}
              </select>
            </Field>
            {procedure && (
              <>
                <dl className="grid grid-cols-2 gap-x-3 gap-y-1 border border-line p-3 text-sm">
                  <dt className="text-ink-faint">Steps standing</dt>
                  <dd>{procedure.steps.filter((row) => row.isActive).length}</dd>
                  <dt className="text-ink-faint">Documents priced</dt>
                  <dd>{procedure.documentsStanding}</dd>
                  <dt className="text-ink-faint">Status</dt>
                  <dd>{procedure.isActive ? 'Offered' : 'Withdrawn'}</dd>
                </dl>
                <form action={changeProcedureForm} className="space-y-3">
                  <input type="hidden" name="procedureCode" value={procedure.procedureCode} />
                  <Field label="Name">
                    <input name="name" maxLength={40} defaultValue={procedure.name} key={`pname-${procedure.procedureCode}`} className="field w-full" />
                  </Field>
                  <button type="submit" disabled={changeProcedurePending} className="btn btn-default min-h-11 w-full">
                    {changeProcedurePending ? 'Saving…' : 'Save the procedure'}
                  </button>
                </form>
                <Notice state={changeProcedureState} />
                <form action={changeProcedureForm}>
                  <input type="hidden" name="procedureCode" value={procedure.procedureCode} />
                  <input type="hidden" name="name" value={procedure.name} />
                  <input type="hidden" name="isActive" value={procedure.isActive ? 'false' : 'true'} />
                  <button type="submit" disabled={changeProcedurePending} className="btn btn-default min-h-11 w-full">
                    {procedure.isActive ? 'Withdraw the procedure' : 'Offer the procedure again'}
                  </button>
                </form>
              </>
            )}
          </div>

          <div className="space-y-3">
            <h3 className="text-sm font-medium">Redefine a step</h3>
            {!procedure ? (
              <p className="text-sm text-ink-soft">Choose a procedure first.</p>
            ) : procedure.steps.length === 0 ? (
              <p className="text-sm text-ink-soft">This procedure carries no steps, so it prices nothing.</p>
            ) : (
              <>
                <Field label="Step">
                  <select value={selectedStep} onChange={(event) => setSelectedStep(event.target.value)} className="field w-full font-mono">
                    <option value="">(select a step)</option>
                    {procedure.steps.map((row) => (
                      <option key={row.stepNumber} value={String(row.stepNumber)}>
                        {row.stepNumber} · {row.conditionType} {row.conditionTypeName}
                        {row.isActive ? '' : ' (withdrawn)'}
                      </option>
                    ))}
                  </select>
                </Field>
                {step && (
                  <>
                    <dl className="grid grid-cols-2 gap-x-3 gap-y-1 border border-line p-3 text-sm">
                      <dt className="text-ink-faint">Condition type</dt>
                      <dd className="font-mono">{step.conditionType}</dd>
                      <dt className="text-ink-faint">Class</dt>
                      <dd className="font-mono">{step.conditionClass}</dd>
                      <dt className="text-ink-faint">Calculated as</dt>
                      <dd className="font-mono">{step.calculationType}</dd>
                      <dt className="text-ink-faint">Level</dt>
                      <dd className="font-mono">{step.conditionLevel}</dd>
                    </dl>
                    <form action={changeStepForm} className="space-y-3">
                      <input type="hidden" name="procedureCode" value={procedure.procedureCode} />
                      <input type="hidden" name="stepNumber" value={step.stepNumber} />
                      <div className="grid gap-3 sm:grid-cols-2">
                        <Field label="From step">
                          <input name="fromStep" type="number" min={1} step={1} defaultValue={step.fromStep ?? ''} key={`from-${step.stepNumber}`} className="field w-full font-mono" placeholder="(none)" />
                        </Field>
                        <Field label="To step">
                          <input name="toStep" type="number" min={1} step={1} defaultValue={step.toStep ?? ''} key={`to-${step.stepNumber}`} className="field w-full font-mono" placeholder="(none)" />
                        </Field>
                      </div>
                      <Field label="Level">
                        <select name="conditionLevel" defaultValue={step.conditionLevel} key={`level-${step.stepNumber}`} className="field w-full">
                          <option value="ITEM">ITEM — priced on every line</option>
                          <option value="HEADER">HEADER — priced on the document, distributed to the lines</option>
                        </select>
                      </Field>
                      <label className="flex items-center gap-2 text-sm">
                        <input type="checkbox" name="isRequired" defaultChecked={step.isRequired} className="h-4 w-4" />
                        The document may not go without it
                      </label>
                      <button type="submit" disabled={changeStepPending} className="btn btn-default min-h-11 w-full">
                        {changeStepPending ? 'Saving…' : 'Save the step'}
                      </button>
                    </form>
                    <Notice state={changeStepState} />
                    <form action={changeStepForm}>
                      <input type="hidden" name="procedureCode" value={procedure.procedureCode} />
                      <input type="hidden" name="stepNumber" value={step.stepNumber} />
                      <input type="hidden" name="fromStep" value={step.fromStep ?? ''} />
                      <input type="hidden" name="toStep" value={step.toStep ?? ''} />
                      <input type="hidden" name="conditionLevel" value={step.conditionLevel} />
                      {step.isRequired ? <input type="hidden" name="isRequired" value="true" /> : null}
                      <input type="hidden" name="isActive" value={step.isActive ? 'false' : 'true'} />
                      <button type="submit" disabled={changeStepPending} className="btn btn-default min-h-11 w-full">
                        {step.isActive ? 'Withdraw the step' : 'Execute the step again'}
                      </button>
                      <p className="mt-1 text-xs text-ink-faint">
                        A withdrawn step is not executed and not deleted: the documents priced by this
                        procedure keep the rule they were priced under, and can still be read against it.
                      </p>
                    </form>
                  </>
                )}
              </>
            )}
          </div>
        </div>
      </section>

      <section aria-labelledby="pricing-maintain-determination" className="border border-line bg-surface p-4">
        <h2 id="pricing-maintain-determination" className="text-sm font-semibold">Which procedure answers</h2>
        <p className="mt-1 max-w-3xl text-sm text-ink-soft">
          A document is priced by the procedure this determination names — sales area, the pricing procedure
          the document type carries, and the one the customer carries. A blank sales area means every area
          and <span className="font-mono">*</span> means every customer procedure; both are rows and not
          fallbacks, so what the wildcard grants can be read. Where no row answers, no document is priced,
          and the refusal names this screen.
        </p>

        <div className="mt-4 grid gap-6 md:grid-cols-2">
          <form action={defineDetForm} className="space-y-3">
            <h3 className="text-sm font-medium">Define a determination</h3>
            <div className="grid gap-3 sm:grid-cols-3">
              <Field label="Sales org" help="Blank for every area.">
                <input name="salesOrg" maxLength={4} className="field w-full font-mono uppercase" placeholder="(any)" />
              </Field>
              <Field label="Channel">
                <input name="distributionChannel" maxLength={2} className="field w-full font-mono uppercase" placeholder="(any)" />
              </Field>
              <Field label="Division">
                <input name="division" maxLength={2} className="field w-full font-mono uppercase" placeholder="(any)" />
              </Field>
            </div>
            <div className="grid gap-3 sm:grid-cols-3">
              <Field label="Document procedure" help="What the document type carries, as VOV8 does.">
                <input name="documentPricingProcedure" required maxLength={6} defaultValue="A" className="field w-full font-mono uppercase" />
              </Field>
              <Field label="Customer procedure" help="* for every customer.">
                <input name="customerPricingProcedure" maxLength={6} defaultValue="*" className="field w-full font-mono uppercase" />
              </Field>
              <Field label="Prices by">
                <select name="procedureCode" required className="field w-full font-mono" defaultValue="">
                  <option value="">(select)</option>
                  {procedures.filter((row) => row.isActive).map((row) => (
                    <option key={row.procedureCode} value={row.procedureCode}>{row.procedureCode}</option>
                  ))}
                </select>
              </Field>
            </div>
            <button type="submit" disabled={defineDetPending} className="btn btn-primary min-h-11 w-full">
              {defineDetPending ? 'Defining…' : 'Define the determination'}
            </button>
            <Notice state={defineDetState} />
          </form>

          <div className="space-y-3">
            <h3 className="text-sm font-medium">Repoint a determination</h3>
            {determinations.length === 0 ? (
              <p className="text-sm text-ink-soft">No determination stands, so no document in this tenant can be priced.</p>
            ) : (
              <>
                <Field label="Determination">
                  <select value={selectedDetermination} onChange={(event) => setSelectedDetermination(event.target.value)} className="field w-full font-mono">
                    <option value="">(select a row)</option>
                    {determinations.map((row) => (
                      <option
                        key={`${row.salesOrg}/${row.distributionChannel}/${row.division}/${row.documentPricingProcedure}/${row.customerPricingProcedure}`}
                        value={`${row.salesOrg}/${row.distributionChannel}/${row.division}/${row.documentPricingProcedure}/${row.customerPricingProcedure}`}
                      >
                        {row.salesOrg || '(any)'}/{row.distributionChannel || '..'}/{row.division || '..'} · {row.documentPricingProcedure} · {row.customerPricingProcedure}
                      </option>
                    ))}
                  </select>
                </Field>
                {determination && (
                  <>
                    <dl className="grid grid-cols-2 gap-x-3 gap-y-1 border border-line p-3 text-sm">
                      <dt className="text-ink-faint">Sales area</dt>
                      <dd className="font-mono">
                        {determination.salesOrg || '(any)'}/{determination.distributionChannel || '(any)'}/{determination.division || '(any)'}
                      </dd>
                      <dt className="text-ink-faint">Area stands</dt>
                      <dd>{determination.areaStands ? 'Yes' : <span className="text-red-700">No — the area named does not exist</span>}</dd>
                      <dt className="text-ink-faint">Prices by</dt>
                      <dd className="font-mono">{determination.procedureCode}</dd>
                    </dl>
                    <form action={changeDetForm} className="space-y-3">
                      <input type="hidden" name="salesOrg" value={determination.salesOrg} />
                      <input type="hidden" name="distributionChannel" value={determination.distributionChannel} />
                      <input type="hidden" name="division" value={determination.division} />
                      <input type="hidden" name="documentPricingProcedure" value={determination.documentPricingProcedure} />
                      <input type="hidden" name="customerPricingProcedure" value={determination.customerPricingProcedure} />
                      <Field label="Prices by">
                        <select name="procedureCode" required defaultValue={determination.procedureCode} key={`det-${selectedDetermination}`} className="field w-full font-mono">
                          {procedures.filter((row) => row.isActive).map((row) => (
                            <option key={row.procedureCode} value={row.procedureCode}>
                              {row.procedureCode} — {row.name}
                            </option>
                          ))}
                        </select>
                      </Field>
                      <button type="submit" disabled={changeDetPending} className="btn btn-default min-h-11 w-full">
                        {changeDetPending ? 'Saving…' : 'Point it at this procedure'}
                      </button>
                    </form>
                    <Notice state={changeDetState} />
                  </>
                )}
              </>
            )}
          </div>
        </div>
      </section>
    </div>
  );
}
