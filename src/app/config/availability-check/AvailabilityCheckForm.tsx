'use client';

import { useActionState, useState } from 'react';
import { LockNotice, useChangeLock } from '@/ui/lock/ChangeLock';

import type {
  CheckingGroupAssignment,
  CheckingGroupRow,
  CheckingRuleRow,
  ScopeOfCheckRow,
} from '@/modules/production/availability-check';
import {
  assignCheckingGroupAction,
  saveCheckingGroupAction,
  saveCheckingRuleAction,
  saveScopeAction,
  type AvailabilityActionState,
} from './actions';

const INITIAL: AvailabilityActionState = { ok: false };
const LOCK_OBJECT = 'AVAILABILITY_CHECK';

function Notice({ state }: { state: AvailabilityActionState }) {
  if (!state.message) return null;
  return (
    <p role="status" className={state.ok ? 'text-sm' : 'text-sm text-red-700'}>
      {state.message}{state.remedy ? ` ${state.remedy}` : ''}
    </p>
  );
}

function mark(value: string): string {
  return value.trim() || 'blank';
}

export default function AvailabilityCheckForm({
  current,
  canMaintain,
}: {
  current: {
    groups: CheckingGroupRow[];
    rules: CheckingRuleRow[];
    scopes: ScopeOfCheckRow[];
    assignments: CheckingGroupAssignment[];
  };
  canMaintain: boolean;
}) {
  const [group, setGroup] = useState<CheckingGroupRow | null>(null);
  const [rule, setRule] = useState<CheckingRuleRow | null>(null);
  const [scope, setScope] = useState<ScopeOfCheckRow | null>(null);
  const [groupState, groupAction, groupPending] = useActionState(saveCheckingGroupAction, INITIAL);
  const [ruleState, ruleAction, rulePending] = useActionState(saveCheckingRuleAction, INITIAL);
  const [assignState, assignAction, assignPending] = useActionState(assignCheckingGroupAction, INITIAL);
  const [scopeState, scopeAction, scopePending] = useActionState(saveScopeAction, INITIAL);
  const groupLock = useChangeLock(LOCK_OBJECT, group ? `GROUP/${group.checkingGroup}` : null, 'OVZ2', canMaintain && Boolean(group));
  const ruleLock = useChangeLock(LOCK_OBJECT, rule ? `RULE/${rule.checkingRule}` : null, 'OPJL', canMaintain && Boolean(rule));
  const scopeLock = useChangeLock(
    LOCK_OBJECT,
    scope ? `SCOPE/${scope.checkingGroup}/${scope.checkingRule}` : null,
    'OVZ9',
    canMaintain && Boolean(scope),
  );

  return (
    <div className="space-y-4">
      <section className="border border-line bg-white p-4">
        <h2 className="text-sm font-semibold">Checking groups</h2>
        <p className="mt-1 text-sm text-ink-soft">A missing material assignment is not shown as a group. Opening this list does not create one.</p>
        {current.groups.length === 0 ? (
          <p className="mt-2 text-sm">No checking group stands.</p>
        ) : (
          <table className="mt-2 w-full text-sm">
            <thead>
              <tr className="border-b border-line text-left">
                <th className="px-2 py-2">Group</th>
                <th className="px-2 py-2">Description</th>
                <th className="px-2 py-2">No check</th>
                {canMaintain && <th className="px-2 py-2">Action</th>}
              </tr>
            </thead>
            <tbody>
              {current.groups.map((row) => (
                <tr key={row.checkingGroup} className="border-b border-line/60">
                  <td className="px-2 py-2 code">{row.checkingGroup}</td>
                  <td className="px-2 py-2">{row.description}</td>
                  <td className="px-2 py-2 code">{mark(row.noCheck)}</td>
                  {canMaintain && (
                    <td className="px-2 py-2">
                      <button type="button" className="btn btn-default min-h-11 sm:min-h-8" onClick={() => setGroup(row)}>Change</button>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      {canMaintain && (
        <form key={group?.checkingGroup ?? 'new-group'} action={groupAction} className="space-y-3 border border-line bg-white p-4">
          <h2 className="text-sm font-semibold">{group ? 'Change checking group' : 'Create checking group'}</h2>
          {group && <LockNotice message={groupLock?.message} />}
          <Notice state={groupState} />
          <input type="hidden" name="mode" value={group ? 'CHANGE' : 'CREATE'} />
          <input type="hidden" name="version" value={group?.version ?? 0} />
          <label className="block text-sm">
            Checking group
            <input name="checkingGroup" defaultValue={group?.checkingGroup ?? ''} maxLength={2} className="field-input code mt-1 w-full" readOnly={Boolean(group)} required />
          </label>
          <label className="block text-sm">
            Description
            <input name="description" defaultValue={group?.description ?? ''} maxLength={20} className="field-input mt-1 w-full" required />
          </label>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" name="noCheck" value="X" defaultChecked={group?.noCheck === 'X'} />
            No availability check (X). This is the checking-group indicator. It does not make the material available, and it is not checking control for creation or release.
          </label>
          <label className="block text-sm">
            Reason
            <input name="reason" className="field-input mt-1 w-full" required />
          </label>
          <button className="btn btn-primary min-h-11 sm:min-h-8" type="submit" disabled={groupPending}>Save checking group</button>
        </form>
      )}

      <section className="border border-line bg-white p-4">
        <h2 className="text-sm font-semibold">Checking rules</h2>
        <p className="mt-1 text-sm text-ink-soft">A rule is not assigned to a material and is not bound to order creation, conversion, or MRP.</p>
        {current.rules.length === 0 ? <p className="mt-2 text-sm">No checking rule stands.</p> : (
          <table className="mt-2 w-full text-sm">
            <thead>
              <tr className="border-b border-line text-left">
                <th className="px-2 py-2">Rule</th>
                <th className="px-2 py-2">Description</th>
                {canMaintain && <th className="px-2 py-2">Action</th>}
              </tr>
            </thead>
            <tbody>
              {current.rules.map((row) => (
                <tr key={row.checkingRule} className="border-b border-line/60">
                  <td className="px-2 py-2 code">{row.checkingRule}</td>
                  <td className="px-2 py-2">{row.description}</td>
                  {canMaintain && (
                    <td className="px-2 py-2">
                      <button type="button" className="btn btn-default min-h-11 sm:min-h-8" onClick={() => setRule(row)}>Change</button>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      {canMaintain && (
        <form key={rule?.checkingRule ?? 'new-rule'} action={ruleAction} className="space-y-3 border border-line bg-white p-4">
          <h2 className="text-sm font-semibold">{rule ? 'Change checking rule' : 'Create checking rule'}</h2>
          {rule && <LockNotice message={ruleLock?.message} />}
          <Notice state={ruleState} />
          <input type="hidden" name="mode" value={rule ? 'CHANGE' : 'CREATE'} />
          <input type="hidden" name="version" value={rule?.version ?? 0} />
          <label className="block text-sm">
            Checking rule
            <input name="checkingRule" defaultValue={rule?.checkingRule ?? ''} maxLength={2} className="field-input code mt-1 w-full" readOnly={Boolean(rule)} required />
          </label>
          <label className="block text-sm">
            Description
            <input name="description" defaultValue={rule?.description ?? ''} maxLength={40} className="field-input mt-1 w-full" required />
          </label>
          <label className="block text-sm">
            Reason
            <input name="reason" className="field-input mt-1 w-full" required />
          </label>
          <button className="btn btn-primary min-h-11 sm:min-h-8" type="submit" disabled={rulePending}>Save checking rule</button>
        </form>
      )}

      <section className="border border-line bg-white p-4">
        <h2 className="text-sm font-semibold">Material plant assignment</h2>
        <p className="mt-1 text-sm text-ink-soft">Null stays not assigned. This does not create a plant view and does not change MRP data.</p>
        <table className="mt-2 w-full text-sm">
          <thead>
            <tr className="border-b border-line text-left">
              <th className="px-2 py-2">Material</th>
              <th className="px-2 py-2">Plant</th>
              <th className="px-2 py-2">Checking group</th>
              <th className="px-2 py-2">Version</th>
            </tr>
          </thead>
          <tbody>
            {current.assignments.map((row) => (
              <tr key={`${row.plant}/${row.materialNumber}`} className="border-b border-line/60">
                <td className="px-2 py-2 code">{row.materialNumber}</td>
                <td className="px-2 py-2 code">{row.plant}</td>
                <td className="px-2 py-2 code">{row.checkingGroup ?? 'not assigned'}</td>
                <td className="px-2 py-2 code">{row.version}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      {canMaintain && (
        <form action={assignAction} className="space-y-3 border border-line bg-white p-4">
          <h2 className="text-sm font-semibold">Assign checking group</h2>
          <Notice state={assignState} />
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="text-sm">Material<input name="materialNumber" className="field-input code mt-1 w-full" required /></label>
            <label className="text-sm">Plant<input name="plant" className="field-input code mt-1 w-full" required /></label>
            <label className="text-sm">Checking group<input name="checkingGroup" maxLength={2} className="field-input code mt-1 w-full" /></label>
            <label className="text-sm">Plant-view version<input name="expectedVersion" className="field-input code mt-1 w-full" required /></label>
          </div>
          <p className="text-sm text-ink-soft">Leave the group blank to clear it. A blank group is not a default.</p>
          <label className="block text-sm">Reason<input name="reason" className="field-input mt-1 w-full" required /></label>
          <button className="btn btn-primary min-h-11 sm:min-h-8" type="submit" disabled={assignPending}>Assign</button>
        </form>
      )}

      <section className="border border-line bg-white p-4">
        <h2 className="text-sm font-semibold">Scope of check</h2>
        <p className="mt-1 text-sm text-ink-soft">The key is the group and the rule. A saved scope is not an ATP balance.</p>
        {current.scopes.length === 0 ? <p className="mt-2 text-sm">No scope stands.</p> : (
          <table className="mt-2 w-full text-sm">
            <thead>
              <tr className="border-b border-line text-left">
                <th className="px-2 py-2">Group</th>
                <th className="px-2 py-2">Rule</th>
                <th className="px-2 py-2">Safety</th>
                <th className="px-2 py-2">Quality</th>
                <th className="px-2 py-2">Blocked</th>
                <th className="px-2 py-2">Reservations</th>
                {canMaintain && <th className="px-2 py-2">Action</th>}
              </tr>
            </thead>
            <tbody>
              {current.scopes.map((row) => (
                <tr key={`${row.checkingGroup}/${row.checkingRule}`} className="border-b border-line/60">
                  <td className="px-2 py-2 code">{row.checkingGroup}</td>
                  <td className="px-2 py-2 code">{row.checkingRule}</td>
                  <td className="px-2 py-2 code">{mark(row.includeSafetyStock)}</td>
                  <td className="px-2 py-2 code">{mark(row.includeQualityStock)}</td>
                  <td className="px-2 py-2 code">{mark(row.includeBlockedStock)}</td>
                  <td className="px-2 py-2 code">{mark(row.reservations)}</td>
                  {canMaintain && (
                    <td className="px-2 py-2">
                      <button type="button" className="btn btn-default min-h-11 sm:min-h-8" onClick={() => setScope(row)}>Change</button>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      {canMaintain && (
        <form key={scope ? `${scope.checkingGroup}/${scope.checkingRule}` : 'new-scope'} action={scopeAction} className="space-y-3 border border-line bg-white p-4">
          <h2 className="text-sm font-semibold">{scope ? 'Change scope of check' : 'Create scope of check'}</h2>
          {scope && <LockNotice message={scopeLock?.message} />}
          <Notice state={scopeState} />
          <input type="hidden" name="mode" value={scope ? 'CHANGE' : 'CREATE'} />
          <input type="hidden" name="version" value={scope?.version ?? 0} />
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="text-sm">Checking group<input name="checkingGroup" defaultValue={scope?.checkingGroup ?? ''} maxLength={2} className="field-input code mt-1 w-full" readOnly={Boolean(scope)} required /></label>
            <label className="text-sm">Checking rule<input name="checkingRule" defaultValue={scope?.checkingRule ?? ''} maxLength={2} className="field-input code mt-1 w-full" readOnly={Boolean(scope)} required /></label>
          </div>
          <div className="grid gap-2 text-sm sm:grid-cols-2">
            <label className="flex items-center gap-2"><input type="checkbox" name="includeSafetyStock" value="X" defaultChecked={scope?.includeSafetyStock === 'X'} />Include safety stock</label>
            <label className="flex items-center gap-2"><input type="checkbox" name="includeQualityStock" value="X" defaultChecked={scope?.includeQualityStock === 'X'} />Include quality-inspection stock</label>
            <label className="flex items-center gap-2"><input type="checkbox" name="includeBlockedStock" value="X" defaultChecked={scope?.includeBlockedStock === 'X'} />Include blocked stock</label>
            <label className="flex items-center gap-2"><input type="checkbox" name="includeRestrictedUse" value="X" defaultChecked={scope?.includeRestrictedUse === 'X'} />Include restricted-use batches</label>
            <label className="flex items-center gap-2"><input type="checkbox" name="purchaseOrders" value="X" defaultChecked={scope?.purchaseOrders === 'X'} />Purchase orders</label>
            <label className="flex items-center gap-2"><input type="checkbox" name="purchaseRequisitions" value="X" defaultChecked={scope?.purchaseRequisitions === 'X'} />Purchase requisitions</label>
            <label className="flex items-center gap-2"><input type="checkbox" name="dependentRequirements" value="X" defaultChecked={scope?.dependentRequirements === 'X'} />Dependent requirements</label>
            <label className="flex items-center gap-2"><input type="checkbox" name="reservations" value="X" defaultChecked={scope?.reservations === 'X'} />Reservations</label>
          </div>
          <div className="grid gap-3 sm:grid-cols-3">
            <label className="text-sm">Planned orders
              <select name="plannedOrders" defaultValue={scope?.plannedOrders ?? ' '} className="field-input mt-1 w-full">
                <option value=" ">Do not include</option>
                <option value="X">X — all planned orders</option>
                <option value="A">A — firmed only</option>
              </select>
            </label>
            <label className="text-sm">Production orders
              <select name="productionOrders" defaultValue={scope?.productionOrders ?? ' '} className="field-input mt-1 w-full">
                <option value=" ">Do not include</option>
                <option value="X">X — all production orders</option>
                <option value="F">F — released production orders only</option>
              </select>
            </label>
            <label className="text-sm">Receipts in the past
              <select name="receiptsInPast" defaultValue={scope?.receiptsInPast ?? ' '} className="field-input mt-1 w-full">
                <option value=" ">Past and future</option>
                <option value="B">B — future only</option>
              </select>
            </label>
          </div>
          <p className="text-sm text-ink-soft">These controls are stored only. They do not calculate ATP.</p>
          <label className="block text-sm">Reason<input name="reason" className="field-input mt-1 w-full" required /></label>
          <button className="btn btn-primary min-h-11 sm:min-h-8" type="submit" disabled={scopePending}>Save scope</button>
        </form>
      )}
    </div>
  );
}
