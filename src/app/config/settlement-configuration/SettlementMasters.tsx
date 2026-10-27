'use client';

/**
 * The settlement masters, on one screen.
 *
 * Every form here writes a shared row, so every form submits the version it was rendered with and opens
 * a change session on the row's own key before it saves. A refusal from the server is shown with its
 * remedy, unchanged: where a save needs a confirmation, the confirmation box is on the same form as the
 * change it confirms, and nothing is stored until the user ticks it and submits again.
 */
import { type ReactNode, useEffect, useActionState, useState } from 'react';

import { LockNotice, useChangeLock } from '@/ui/lock/ChangeLock';
import { SETTLEMENT_CONFIG_LOCKS } from '@/modules/foundation/settlement-configuration-keys';
import {
  removeAssignmentAction,
  removeOrderTypeAction,
  saveAssignmentAction,
  saveOrderTypeAction,
  saveProfileAction,
  saveStructureAction,
  type SettlementConfigActionState,
} from './actions';

const ACTIVITY = 'CFG.COST.SETTLEMENT.DEFINE';
const CATEGORIES = ['COST_CENTER', 'INTERNAL_ORDER', 'GL_ACCOUNT'] as const;

export interface AssignmentEntry {
  sourceAccount: string;
  /** The stored category, as the database holds it; the form's own select offers the three values. */
  receiverCategory: string;
  byOriginalAccount: boolean;
  settlementAccount: string | null;
  version: number;
}

export interface StructureEntry {
  structureCode: string;
  description: string;
  profiles: number;
  orderTypes: number;
  version: number;
  assignments: AssignmentEntry[];
  profilesUsedBy: Array<{ profileCode: string; isActive: boolean }>;
}

export interface ProfileEntry {
  profileCode: string;
  description: string;
  allocationStructure: string;
  documentType: string;
  percentageAllowed: boolean;
  equivalenceAllowed: boolean;
  amountAllowed: boolean;
  isActive: boolean;
  orderTypes: string[];
  version: number;
}

export interface OrderTypeEntry {
  orderType: string;
  description: string;
  profileCode: string | null;
  orders: number;
  ordersWithRules: number;
  ordersWithSettlementDocuments: number;
  version: number;
}

export function SettlementMasters({
  structures,
  profiles,
  orderTypes,
  documentTypes,
  canMaintain,
}: {
  structures: StructureEntry[];
  profiles: ProfileEntry[];
  orderTypes: OrderTypeEntry[];
  documentTypes: Array<{ documentType: string; name: string }>;
  canMaintain: boolean;
}) {
  return (
    <div className="space-y-4">
      <AllocationStructures structures={structures} canMaintain={canMaintain} />
      <SettlementProfiles profiles={profiles} structures={structures} documentTypes={documentTypes} canMaintain={canMaintain} />
      <OrderTypeAssignments orderTypes={orderTypes} profiles={profiles} canMaintain={canMaintain} />
    </div>
  );
}

function Panel({ title, hint, children }: { title: string; hint: string; children: ReactNode }) {
  return (
    <section className="overflow-hidden border border-line bg-white" aria-label={title}>
      <div className="border-b border-line bg-sunken px-4 py-3">
        <h2 className="font-semibold">{title}</h2>
        <p className="mt-1 text-sm text-ink-soft">{hint}</p>
      </div>
      <div className="space-y-4 p-3 sm:p-5">{children}</div>
    </section>
  );
}

function Message({ state }: { state: SettlementConfigActionState }) {
  if (!state.message) return null;
  const tone = state.ok ? 'border-line bg-sunken text-ink-soft' : 'border-signal-error/30 bg-signal-error-soft text-signal-error';
  return (
    <p role="status" className={`border p-3 text-sm ${tone}`}>
      <span className="block">{state.message}</span>
      {state.remedy && <span className="mt-1 block text-xs">{state.remedy}</span>}
    </p>
  );
}

function Label({ text, required }: { text: string; required?: boolean }) {
  return (
    <span className="field-label">
      {text}
      {required && <span className="ms-1 text-signal-error" aria-hidden="true">*</span>}
    </span>
  );
}

function Check({
  name,
  label,
  hint,
  checked,
  onChange,
  disabled,
}: {
  name: string;
  label: string;
  hint?: string;
  checked: boolean;
  onChange: (value: boolean) => void;
  disabled: boolean;
}) {
  return (
    <label className="flex items-start gap-2 text-sm">
      <input
        type="checkbox"
        name={name}
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange(event.currentTarget.checked)}
        className="mt-1 h-4 w-4"
      />
      <span>
        <span className="block">{label}</span>
        {hint && <span className="block text-xs text-ink-faint">{hint}</span>}
      </span>
    </label>
  );
}

function Code({ value }: { value: string }) {
  return <span className="code text-sm">{value}</span>;
}

function AllocationStructures({ structures, canMaintain }: { structures: StructureEntry[]; canMaintain: boolean }) {
  const [create, createAction, createPending] = useActionState<SettlementConfigActionState, FormData>(saveStructureAction, { ok: true });
  const [edit, editAction, editPending] = useActionState<SettlementConfigActionState, FormData>(saveStructureAction, { ok: true });
  const [addAssignment, assignmentAction, assignmentPending] = useActionState<SettlementConfigActionState, FormData>(saveAssignmentAction, { ok: true });
  const [removeAssignmentRow, removeAction, removePending] = useActionState<SettlementConfigActionState, FormData>(removeAssignmentAction, { ok: true });

  const [newCode, setNewCode] = useState('');
  const [newDescription, setNewDescription] = useState('');
  const [selected, setSelected] = useState<string | null>(null);
  const [description, setDescription] = useState('');
  const [assignment, setAssignment] = useState({ sourceAccount: '', receiverCategory: 'COST_CENTER', byOriginalAccount: true, settlementAccount: '' });
  const [confirmChange, setConfirmChange] = useState(false);
  const [confirmRemoval, setConfirmRemoval] = useState(false);

  const current = structures.find((row) => row.structureCode === selected) ?? null;
  const [selectedAssignment, setSelectedAssignment] = useState<string | null>(null);
  const assignmentRow = current?.assignments.find((row) => `${row.sourceAccount}/${row.receiverCategory}` === selectedAssignment) ?? null;

  const lock = useChangeLock(SETTLEMENT_CONFIG_LOCKS.structure, current?.structureCode ?? null, ACTIVITY, canMaintain && current !== null);
  const canEdit = canMaintain && lock?.mode === 'CHANGE';

  useEffect(() => {
    setDescription(current?.description ?? '');
    setSelectedAssignment(null);
    setConfirmChange(false);
    setConfirmRemoval(false);
    setAssignment((value) => (current ? value : { sourceAccount: '', receiverCategory: 'COST_CENTER', byOriginalAccount: true, settlementAccount: '' }));
  }, [current?.structureCode, current?.description]);

  useEffect(() => {
    if (!assignmentRow) return;
    setAssignment({
      sourceAccount: assignmentRow.sourceAccount,
      receiverCategory: assignmentRow.receiverCategory,
      byOriginalAccount: assignmentRow.byOriginalAccount,
      settlementAccount: assignmentRow.settlementAccount ?? '',
    });
  }, [assignmentRow?.sourceAccount, assignmentRow?.receiverCategory, assignmentRow?.byOriginalAccount, assignmentRow?.settlementAccount]);

  return (
    <Panel
      title="Allocation structures"
      hint="Where an account settles to. Every order that reads a profile of this structure shares these rows."
    >
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-line text-start text-xs text-ink-faint">
            <th className="py-2 text-start">Structure</th>
            <th className="py-2 text-start">Description</th>
            <th className="py-2 text-end">Assignments</th>
            <th className="py-2 text-end">Profiles</th>
            <th className="py-2 text-end">Order types</th>
            <th className="py-2" />
          </tr>
        </thead>
        <tbody>
          {structures.length === 0 && (
            <tr><td colSpan={6} className="py-3 text-ink-faint">No allocation structure is defined yet.</td></tr>
          )}
          {structures.map((row) => (
            <tr key={row.structureCode} className={`border-b border-line ${selected === row.structureCode ? 'bg-sunken' : ''}`}>
              <td className="py-2"><Code value={row.structureCode} /></td>
              <td className="py-2">{row.description}</td>
              <td className="py-2 text-end tabular">{row.assignments.length}</td>
              <td className="py-2 text-end tabular">{row.profiles}</td>
              <td className="py-2 text-end tabular">{row.orderTypes}</td>
              <td className="py-2 text-end">
                {canMaintain && (
                  <button
                    type="button"
                    className="btn btn-secondary min-h-11 px-3 text-sm sm:min-h-9"
                    onClick={() => setSelected(selected === row.structureCode ? null : row.structureCode)}
                  >
                    {selected === row.structureCode ? 'Close' : 'Edit'}
                  </button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      {canMaintain && (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          <form action={createAction} className="space-y-3 border border-line p-3">
            <h3 className="font-medium">New structure</h3>
            <Message state={create} />
            <input type="hidden" name="mode" value="CREATE" />
            <input type="hidden" name="expectedVersion" value="0" />
            <label className="block">
              <Label text="Structure" required />
              <input
                name="structureCode"
                type="text"
                required
                minLength={2}
                maxLength={6}
                pattern="[A-Za-z0-9]{2,6}"
                autoComplete="off"
                className="field-input code mt-1 min-h-11 w-full uppercase sm:min-h-9"
                value={newCode}
                onChange={(event) => setNewCode(event.currentTarget.value.toUpperCase())}
              />
            </label>
            <label className="block">
              <Label text="Description" required />
              <input
                name="description"
                type="text"
                required
                maxLength={40}
                className="field-input mt-1 min-h-11 w-full sm:min-h-9"
                value={newDescription}
                onChange={(event) => setNewDescription(event.currentTarget.value.slice(0, 40))}
              />
            </label>
            <button type="submit" className="btn btn-primary min-h-11 px-4 sm:min-h-9" disabled={createPending}>
              Create structure
            </button>
            <p className="text-xs text-ink-faint">
              A structure is never deleted: its rows are the history of what settled where.
            </p>
          </form>

          <form action={editAction} className="space-y-3 border border-line p-3">
            <h3 className="font-medium">Description of {current ? <Code value={current.structureCode} /> : 'the selected structure'}</h3>
            <Message state={edit} />
            <LockNotice message={lock?.mode === 'DISPLAY' ? lock.message : null} />
            <input type="hidden" name="mode" value="CHANGE" />
            <input type="hidden" name="structureCode" value={current?.structureCode ?? ''} />
            <input type="hidden" name="expectedVersion" value={current?.version ?? 0} />
            <label className="block">
              <Label text="Description" required />
              <input
                name="description"
                type="text"
                required
                maxLength={40}
                disabled={!canEdit || editPending}
                className="field-input mt-1 min-h-11 w-full sm:min-h-9"
                value={description}
                onChange={(event) => setDescription(event.currentTarget.value.slice(0, 40))}
              />
            </label>
            <button type="submit" className="btn btn-primary min-h-11 px-4 sm:min-h-9" disabled={!current || !canEdit || editPending}>
              Save description
            </button>
          </form>

          <form action={assignmentAction} className="space-y-3 border border-line p-3">
            <p className="text-xs text-ink-faint">
              Read by {current ? `${current.profiles} profile(s)` : 'no profile yet'}
              {current && current.profilesUsedBy.length > 0 && <>: {current.profilesUsedBy.map((row) => `${row.profileCode}${row.isActive ? '' : ' (inactive)'}`).join(', ')}</>}
            </p>
            <h3 className="font-medium">
              {assignmentRow ? 'Change assignment' : 'Add assignment'}
              {current && <span className="ms-2 text-sm text-ink-faint">in <Code value={current.structureCode} /></span>}
            </h3>
            <Message state={addAssignment} />
            <input type="hidden" name="structureCode" value={current?.structureCode ?? ''} />
            <input type="hidden" name="expectedVersion" value={assignmentRow?.version ?? 0} />
            <label className="block">
              <Label text="Source account" required />
              <input
                name="sourceAccount"
                type="text"
                required
                maxLength={10}
                disabled={!current || !canEdit || assignmentPending}
                className="field-input code mt-1 min-h-11 w-full uppercase sm:min-h-9"
                value={assignment.sourceAccount}
                onChange={(event) => {
                  // Read the event now: React releases it before the updater below runs, and currentTarget is
                  // null by then.
                  const typed = event.currentTarget.value.toUpperCase();
                  setAssignment((state) => ({ ...state, sourceAccount: typed }));
                }}
              />
            </label>
            <label className="block">
              <Label text="Receiver category" required />
              <select
                name="receiverCategory"
                required
                disabled={!current || !canEdit || assignmentPending}
                className="field-input mt-1 min-h-11 w-full sm:min-h-9"
                value={assignment.receiverCategory}
                onChange={(event) => {
                  const picked = event.currentTarget.value;
                  setAssignment((state) => ({ ...state, receiverCategory: picked }));
                }}
              >
                {CATEGORIES.map((category) => <option key={category} value={category}>{category}</option>)}
              </select>
            </label>
            <Check
              name="byOriginalAccount"
              label="Settle to the original account"
              hint="The debit stays on the account the cost was posted to. Leave this unticked to settle to the account named below."
              checked={assignment.byOriginalAccount}
              disabled={!current || !canEdit || assignmentPending}
              onChange={(value) => setAssignment((state) => ({ ...state, byOriginalAccount: value }))}
            />
            <label className="block">
              <Label text="Settlement account" />
              <input
                name="settlementAccount"
                type="text"
                maxLength={10}
                disabled={!current || !canEdit || assignment.byOriginalAccount || assignmentPending}
                className="field-input code mt-1 min-h-11 w-full uppercase sm:min-h-9"
                value={assignment.settlementAccount}
                onChange={(event) => {
                  const typed = event.currentTarget.value.toUpperCase();
                  setAssignment((state) => ({ ...state, settlementAccount: typed }));
                }}
              />
            </label>
            <Check
              name="confirmed"
              label="Accept the change although orders of this structure already have settlement documents"
              checked={confirmChange}
              disabled={!current || !canEdit || assignmentPending}
              onChange={setConfirmChange}
            />
            <button type="submit" className="btn btn-primary min-h-11 px-4 sm:min-h-9" disabled={!current || !canEdit || assignmentPending}>
              Save assignment
            </button>
          </form>

          <form action={removeAction} className="space-y-3 border border-line p-3">
            <h3 className="font-medium">Remove an assignment</h3>
            <Message state={removeAssignmentRow} />
            <input type="hidden" name="structureCode" value={current?.structureCode ?? ''} />
            <input type="hidden" name="sourceAccount" value={assignmentRow?.sourceAccount ?? ''} />
            <input type="hidden" name="receiverCategory" value={assignmentRow?.receiverCategory ?? ''} />
            <ul className="space-y-1 text-sm">
              {(current?.assignments ?? []).map((row) => {
                const key = `${row.sourceAccount}/${row.receiverCategory}`;
                return (
                  <li key={key}>
                    <button
                      type="button"
                      className={selectedAssignment === key ? 'font-semibold' : 'text-ink-soft'}
                      disabled={!canEdit || removePending}
                      onClick={() => setSelectedAssignment(key)}
                    >
                      <Code value={row.sourceAccount} /> · {row.receiverCategory}
                      {row.byOriginalAccount ? ' · original account' : ` · to ${row.settlementAccount ?? ''}`}
                    </button>
                  </li>
                );
              })}
              {!current && <li className="text-ink-faint">Choose a structure to see its assignments.</li>}
              {current && current.assignments.length === 0 && <li className="text-ink-faint">This structure has no assignment yet.</li>}
            </ul>
            <Check
              name="confirmed"
              label="Accept the removal although orders of this structure already have settlement documents"
              checked={confirmRemoval}
              disabled={!assignmentRow || !canEdit || removePending}
              onChange={setConfirmRemoval}
            />
            <button type="submit" className="btn btn-secondary min-h-11 px-4 text-signal-error sm:min-h-9" disabled={!assignmentRow || !canEdit || removePending}>
              Remove selected assignment
            </button>
          </form>
        </div>
      )}
    </Panel>
  );
}

function SettlementProfiles({
  profiles,
  structures,
  documentTypes,
  canMaintain,
}: {
  profiles: ProfileEntry[];
  structures: StructureEntry[];
  documentTypes: Array<{ documentType: string; name: string }>;
  canMaintain: boolean;
}) {
  const [create, createAction, createPending] = useActionState<SettlementConfigActionState, FormData>(saveProfileAction, { ok: true });
  const [edit, editAction, editPending] = useActionState<SettlementConfigActionState, FormData>(saveProfileAction, { ok: true });
  const [selected, setSelected] = useState<string | null>(null);
  const current = profiles.find((row) => row.profileCode === selected) ?? null;
  const lock = useChangeLock(SETTLEMENT_CONFIG_LOCKS.profile, current?.profileCode ?? null, ACTIVITY, canMaintain && current !== null);
  const canEdit = canMaintain && lock?.mode === 'CHANGE';

  const [blank, setBlank] = useState({
    profileCode: '', description: '', allocationStructure: '', documentType: 'SA',
    percentageAllowed: true, equivalenceAllowed: false, amountAllowed: false, isActive: true,
  });
  const [values, setValues] = useState(blank);

  useEffect(() => {
    setValues(current ? {
      profileCode: current.profileCode,
      description: current.description,
      allocationStructure: current.allocationStructure,
      documentType: current.documentType,
      percentageAllowed: current.percentageAllowed,
      equivalenceAllowed: current.equivalenceAllowed,
      amountAllowed: current.amountAllowed,
      isActive: current.isActive,
    } : blank);
  }, [current?.profileCode, current?.version, blank]);

  function field<K extends keyof typeof values>(key: K, value: (typeof values)[K]) {
    setValues((state) => ({ ...state, [key]: value }));
  }

  const profileForm = (mode: 'CREATE' | 'CHANGE', state: SettlementConfigActionState, pending: boolean, action: (payload: FormData) => void) => (
    <form action={action} className="space-y-3 border border-line p-3">
      <h3 className="font-medium">{mode === 'CREATE' ? 'New profile' : `Profile ${values.profileCode || '—'}`}</h3>
      <Message state={state} />
      {mode === 'CHANGE' && <LockNotice message={lock?.mode === 'DISPLAY' ? lock.message : null} />}
      <input type="hidden" name="mode" value={mode} />
      <input type="hidden" name="expectedVersion" value={current?.version ?? 0} />
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <label className="block">
          <Label text="Profile" required />
          <input
            name="profileCode"
            type="text"
            required
            minLength={2}
            maxLength={6}
            pattern="[A-Za-z0-9]{2,6}"
            disabled={mode === 'CHANGE' || pending}
            className="field-input code mt-1 min-h-11 w-full uppercase sm:min-h-9"
            value={values.profileCode}
            onChange={(event) => field('profileCode', event.currentTarget.value.toUpperCase())}
          />
        </label>
        <label className="block">
          <Label text="Description" required />
          <input
            name="description"
            type="text"
            required
            maxLength={40}
            disabled={(mode === 'CHANGE' && !canEdit) || pending}
            className="field-input mt-1 min-h-11 w-full sm:min-h-9"
            value={values.description}
            onChange={(event) => field('description', event.currentTarget.value.slice(0, 40))}
          />
        </label>
        <label className="block">
          <Label text="Allocation structure" required />
          <select
            name="allocationStructure"
            required
            disabled={(mode === 'CHANGE' && !canEdit) || pending}
            className="field-input mt-1 min-h-11 w-full sm:min-h-9"
            value={values.allocationStructure}
            onChange={(event) => field('allocationStructure', event.currentTarget.value)}
          >
            <option value="">Choose a structure</option>
            {structures.map((row) => <option key={row.structureCode} value={row.structureCode}>{row.structureCode} — {row.description}</option>)}
          </select>
        </label>
        <label className="block">
          <Label text="Document type" required />
          <select
            name="documentType"
            required
            disabled={(mode === 'CHANGE' && !canEdit) || pending}
            className="field-input mt-1 min-h-11 w-full sm:min-h-9"
            value={values.documentType}
            onChange={(event) => field('documentType', event.currentTarget.value)}
          >
            {documentTypes.map((row) => <option key={row.documentType} value={row.documentType}>{row.documentType} — {row.name}</option>)}
          </select>
          <span className="mt-1 block text-xs text-ink-faint">The document type the settlement posts with. It is stored on the profile, never guessed from an order.</span>
        </label>
      </div>
      <fieldset className="space-y-2 border border-line p-3" disabled={(mode === 'CHANGE' && !canEdit) || pending}>
        <legend className="px-1 text-xs font-medium text-ink-faint">Distribution methods this profile allows</legend>
        <Check name="percentageAllowed" label="Percentage" checked={values.percentageAllowed} disabled={(mode === 'CHANGE' && !canEdit) || pending} onChange={(value) => field('percentageAllowed', value)} />
        <Check name="equivalenceAllowed" label="Equivalence number" checked={values.equivalenceAllowed} disabled={(mode === 'CHANGE' && !canEdit) || pending} onChange={(value) => field('equivalenceAllowed', value)} />
        <Check name="amountAllowed" label="Fixed amount" checked={values.amountAllowed} disabled={(mode === 'CHANGE' && !canEdit) || pending} onChange={(value) => field('amountAllowed', value)} />
        <span className="block text-xs text-ink-faint">At least one method must stay allowed. A rule that uses a method the profile stops allowing is refused.</span>
      </fieldset>
      <Check
        name="isActive"
        label="Profile is active"
        hint="An inactive profile is read by no new order. While an order type resolves to it, deactivating is refused."
        checked={values.isActive}
        disabled={(mode === 'CHANGE' && !canEdit) || pending}
        onChange={(value) => field('isActive', value)}
      />
      <button type="submit" className="btn btn-primary min-h-11 px-4 sm:min-h-9" disabled={(mode === 'CHANGE' && !canEdit) || pending}>
        {mode === 'CREATE' ? 'Create profile' : 'Save profile'}
      </button>
    </form>
  );

  return (
    <Panel title="Settlement profiles" hint="What an order of a type settles against: its document type, its allowed methods, and its allocation structure.">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-line text-start text-xs text-ink-faint">
            <th className="py-2 text-start">Profile</th>
            <th className="py-2 text-start">Description</th>
            <th className="py-2 text-start">Structure</th>
            <th className="py-2 text-start">Document type</th>
            <th className="py-2 text-start">Methods</th>
            <th className="py-2 text-start">Order types</th>
            <th className="py-2" />
          </tr>
        </thead>
        <tbody>
          {profiles.length === 0 && <tr><td colSpan={7} className="py-3 text-ink-faint">No settlement profile is defined yet.</td></tr>}
          {profiles.map((row) => (
            <tr key={row.profileCode} className={`border-b border-line ${selected === row.profileCode ? 'bg-sunken' : ''}`}>
              <td className="py-2"><Code value={row.profileCode} />{!row.isActive && <span className="ms-2 chip chip-neutral">inactive</span>}</td>
              <td className="py-2">{row.description}</td>
              <td className="py-2"><Code value={row.allocationStructure} /></td>
              <td className="py-2"><Code value={row.documentType} /></td>
              <td className="py-2 text-xs">
                {[row.percentageAllowed && 'percentage', row.equivalenceAllowed && 'equivalence', row.amountAllowed && 'amount'].filter(Boolean).join(', ')}
              </td>
              <td className="py-2 text-xs">{row.orderTypes.length > 0 ? row.orderTypes.join(', ') : '—'}</td>
              <td className="py-2 text-end">
                {canMaintain && (
                  <button
                    type="button"
                    className="btn btn-secondary min-h-11 px-3 text-sm sm:min-h-9"
                    onClick={() => setSelected(selected === row.profileCode ? null : row.profileCode)}
                  >
                    {selected === row.profileCode ? 'Close' : 'Edit'}
                  </button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {canMaintain && (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          {profileForm('CREATE', create, createPending, createAction)}
          {current ? profileForm('CHANGE', edit, editPending, editAction) : (
            <p className="border border-line p-3 text-sm text-ink-faint">Choose a profile above to change it.</p>
          )}
        </div>
      )}
    </Panel>
  );
}

function OrderTypeAssignments({
  orderTypes,
  profiles,
  canMaintain,
}: {
  orderTypes: OrderTypeEntry[];
  profiles: ProfileEntry[];
  canMaintain: boolean;
}) {
  const [assign, assignAction, assignPending] = useActionState<SettlementConfigActionState, FormData>(saveOrderTypeAction, { ok: true });
  const [remove, removeAction, removePending] = useActionState<SettlementConfigActionState, FormData>(removeOrderTypeAction, { ok: true });
  const [selected, setSelected] = useState<string | null>(null);
  const [profileCode, setProfileCode] = useState('');
  const [confirmChange, setConfirmChange] = useState(false);
  const [confirmRemoval, setConfirmRemoval] = useState(false);
  const current = orderTypes.find((row) => row.orderType === selected) ?? null;
  const lock = useChangeLock(SETTLEMENT_CONFIG_LOCKS.orderType, current?.orderType ?? null, ACTIVITY, canMaintain && current !== null);
  const canEdit = canMaintain && lock?.mode === 'CHANGE';

  useEffect(() => {
    setProfileCode(current?.profileCode ?? '');
    setConfirmChange(false);
    setConfirmRemoval(false);
  }, [current?.orderType, current?.version, current?.profileCode]);

  return (
    <Panel title="Order type settlement profile" hint="Which profile every order of a type reads. A rule of one order never changes this row.">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-line text-start text-xs text-ink-faint">
            <th className="py-2 text-start">Order type</th>
            <th className="py-2 text-start">Description</th>
            <th className="py-2 text-start">Profile</th>
            <th className="py-2 text-end">Orders</th>
            <th className="py-2 text-end">With rules</th>
            <th className="py-2 text-end">Settled</th>
            <th className="py-2" />
          </tr>
        </thead>
        <tbody>
          {orderTypes.length === 0 && (
            <tr><td colSpan={7} className="py-3 text-ink-faint">No internal order type is defined, or your user may not maintain this screen.</td></tr>
          )}
          {orderTypes.map((row) => (
            <tr key={row.orderType} className={`border-b border-line ${selected === row.orderType ? 'bg-sunken' : ''}`}>
              <td className="py-2"><Code value={row.orderType} /></td>
              <td className="py-2">{row.description}</td>
              <td className="py-2">{row.profileCode ? <Code value={row.profileCode} /> : <span className="text-ink-faint">not assigned</span>}</td>
              <td className="py-2 text-end tabular">{row.orders}</td>
              <td className="py-2 text-end tabular">{row.ordersWithRules}</td>
              <td className="py-2 text-end tabular">{row.ordersWithSettlementDocuments}</td>
              <td className="py-2 text-end">
                {canMaintain && (
                  <button
                    type="button"
                    className="btn btn-secondary min-h-11 px-3 text-sm sm:min-h-9"
                    onClick={() => setSelected(selected === row.orderType ? null : row.orderType)}
                  >
                    {selected === row.orderType ? 'Close' : 'Edit'}
                  </button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      {canMaintain && current && (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          <form action={assignAction} className="space-y-3 border border-line p-3">
            <h3 className="font-medium">Profile for order type <Code value={current.orderType} /></h3>
            <Message state={assign} />
            <LockNotice message={lock?.mode === 'DISPLAY' ? lock.message : null} />
            <input type="hidden" name="mode" value={current.profileCode ? 'CHANGE' : 'CREATE'} />
            <input type="hidden" name="orderType" value={current.orderType} />
            <input type="hidden" name="expectedVersion" value={current.version} />
            <label className="block">
              <Label text="Settlement profile" required />
              <select
                name="profileCode"
                required
                disabled={!canEdit || assignPending}
                className="field-input mt-1 min-h-11 w-full sm:min-h-9"
                value={profileCode}
                onChange={(event) => setProfileCode(event.currentTarget.value)}
              >
                <option value="">Choose a profile</option>
                {profiles.map((row) => (
                  <option key={row.profileCode} value={row.profileCode}>
                    {row.profileCode} — {row.description}{!row.isActive ? ' (inactive)' : ''}
                  </option>
                ))}
              </select>
              <span className="mt-1 block text-xs text-ink-faint">
                Reassigning is refused while an order of this type has a balance its new structure does not assign.
              </span>
            </label>
            <Check
              name="confirmed"
              label="Accept the change although orders of this type already have settlement documents"
              checked={confirmChange}
              disabled={!canEdit || assignPending}
              onChange={setConfirmChange}
            />
            <button type="submit" className="btn btn-primary min-h-11 px-4 sm:min-h-9" disabled={!canEdit || assignPending}>
              Save assignment
            </button>
          </form>

          <form action={removeAction} className="space-y-3 border border-line p-3">
            <h3 className="font-medium">Remove the assignment</h3>
            <Message state={remove} />
            <input type="hidden" name="orderType" value={current.orderType} />
            <p className="text-sm text-ink-soft">
              The orders of this type keep their rules. A settlement then reports that the order type has
              no settlement profile, so remove this only once they have been reassigned.
            </p>
            <Check
              name="confirmed"
              label="Accept the removal although orders of this type already store a settlement rule"
              checked={confirmRemoval}
              disabled={!canEdit || removePending}
              onChange={setConfirmRemoval}
            />
            <button type="submit" className="btn btn-secondary min-h-11 px-4 text-signal-error sm:min-h-9" disabled={!canEdit || removePending || !current.profileCode}>
              Remove profile from order type
            </button>
          </form>
        </div>
      )}
    </Panel>
  );
}
