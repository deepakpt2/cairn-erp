'use client';

import { useActionState, useState } from 'react';
import { LockNotice, useChangeLock } from '@/ui/lock/ChangeLock';

import type {
  SchedulingAssignmentRow,
  SchedulingProfileRow,
} from '@/modules/inventory/scheduling-profile';

const LOCK_OBJECT = 'SCHEDULING_PROFILE';
const NOT_EXECUTED = [
  'print at release',
  'schedule at release',
  'material availability',
  'capacity leveling',
  'finite scheduling',
  'automatic goods receipt',
  'batch classification',
  'warehouse transfer requirement',
  'order type',
] as const;
import {
  assignSchedulingProfileAction,
  saveSchedulingProfileAction,
  type ProfileActionState,
} from './actions';

const INITIAL: ProfileActionState = { ok: false };

export default function SchedulingProfileForm({
  profiles,
  assignments,
  plants,
  canMaintain,
  selectedPlant,
}: {
  profiles: SchedulingProfileRow[];
  assignments: SchedulingAssignmentRow[];
  plants: Array<{ plant: string; name: string }>;
  canMaintain: boolean;
  selectedPlant: string;
}) {
  const [editing, setEditing] = useState<SchedulingProfileRow | null>(null);
  const [saveState, saveAction, savePending] = useActionState(saveSchedulingProfileAction, INITIAL);
  const [assignState, assignAction, assignPending] = useActionState(assignSchedulingProfileAction, INITIAL);
  const row = editing;
  const lock = useChangeLock(LOCK_OBJECT, row ? `${row.plant}/${row.profile}` : null, 'OPKP', canMaintain && Boolean(row));
  const locked = Boolean(row && lock?.mode === 'DISPLAY');

  return (
    <div className="space-y-4">
      <section className="border border-line bg-white p-4">
        <h2 className="text-sm font-semibold">Profiles</h2>
        {profiles.length === 0 ? (
          <p className="mt-2 text-sm text-ink-soft">No profile stands. Opening this screen does not create one.</p>
        ) : (
          <table className="mt-2 w-full text-sm">
            <thead>
              <tr className="border-b border-line text-left">
                <th className="px-2 py-2">Plant</th>
                <th className="px-2 py-2">Profile</th>
                <th className="px-2 py-2">Description</th>
                <th className="px-2 py-2">Release at creation</th>
                <th className="px-2 py-2">Batch creation</th>
                {canMaintain && <th className="px-2 py-2">Action</th>}
              </tr>
            </thead>
            <tbody>
              {profiles.map((profile) => (
                <tr key={`${profile.plant}/${profile.profile}`} className="border-b border-line/60">
                  <td className="px-2 py-2 code">{profile.plant}</td>
                  <td className="px-2 py-2 code">{profile.profile}</td>
                  <td className="px-2 py-2">{profile.description}</td>
                  <td className="px-2 py-2 code">{profile.releaseOnCreate.trim() || '—'}</td>
                  <td className="px-2 py-2 code">{profile.batchCreation.trim() || '—'}</td>
                  {canMaintain && (
                    <td className="px-2 py-2">
                      <button type="button" className="btn btn-default min-h-11 sm:min-h-8" onClick={() => setEditing(profile)}>
                        Change
                      </button>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      {canMaintain && (
        <form action={saveAction} className="space-y-3 border border-line bg-white p-4">
          <h2 className="text-sm font-semibold">{row ? 'Change profile' : 'Create profile'}</h2>
          {row && <LockNotice message={lock?.message} remedy={lock?.remedy} />}
          <input type="hidden" name="mode" value={row ? 'CHANGE' : 'CREATE'} />
          <input type="hidden" name="version" value={row?.version ?? 0} />
          {row && (
            <>
              <input type="hidden" name="plant" value={row.plant} />
              <input type="hidden" name="profile" value={row.profile} />
            </>
          )}
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="text-sm">
              Plant
              <select name="plant" defaultValue={row?.plant ?? selectedPlant} className="field-input mt-1 w-full" disabled={Boolean(row) || locked} required>
                <option value="">Select a plant</option>
                {plants.map((plant) => (
                  <option key={plant.plant} value={plant.plant}>{plant.plant} · {plant.name}</option>
                ))}
              </select>
            </label>
            <label className="text-sm">
              Profile
              <input name="profile" defaultValue={row?.profile ?? ''} maxLength={6} className="field-input code mt-1 w-full" readOnly={Boolean(row) || locked} required />
            </label>
            <label className="text-sm sm:col-span-2">
              Description
              <input name="description" defaultValue={row?.description ?? ''} maxLength={40} className="field-input mt-1 w-full" disabled={locked} required />
            </label>
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" name="releaseOnCreate" value="X" defaultChecked={row?.releaseOnCreate === 'X'} disabled={locked} />
              Release at creation (X)
            </label>
            <label className="text-sm">
              Batch creation in the order
              <select name="batchCreation" defaultValue={row?.batchCreation ?? ' '} className="field-input mt-1 w-full" disabled={locked}>
                <option value=" ">No automatic batch creation</option>
                <option value="1">1 — at order creation</option>
                <option value="2">2 — at order release</option>
              </select>
            </label>
            <label className="text-sm sm:col-span-2">
              Reason
              <input name="reason" className="field-input mt-1 w-full" disabled={locked} required />
            </label>
          </div>
          {saveState.message && (
            <p role="status" className={`text-sm ${saveState.ok ? 'text-ink' : 'text-red-700'}`}>
              {saveState.message} {saveState.remedy ?? ''}
            </p>
          )}
          <div className="flex gap-2">
            <button type="submit" className="btn btn-primary min-h-11 sm:min-h-8" disabled={savePending || locked}>
              Save
            </button>
            {row && (
              <button type="button" className="btn btn-default min-h-11 sm:min-h-8" onClick={() => setEditing(null)}>
                New profile
              </button>
            )}
          </div>
        </form>
      )}

      <section className="border border-line bg-white p-4">
        <h2 className="text-sm font-semibold">Material plant assignment</h2>
        <p className="mt-1 text-sm text-ink-soft">
          Stored on the plant view. The work scheduling view is not open here. An existing order keeps the profile it was created with.
        </p>
        {assignments.length === 0 ? (
          <p className="mt-2 text-sm text-ink-soft">No material in this list has a profile.</p>
        ) : (
          <table className="mt-2 w-full text-sm">
            <thead>
              <tr className="border-b border-line text-left">
                <th className="px-2 py-2">Material</th>
                <th className="px-2 py-2">Plant</th>
                <th className="px-2 py-2">Profile</th>
                <th className="px-2 py-2">Version</th>
              </tr>
            </thead>
            <tbody>
              {assignments.map((assignment) => (
                <tr key={`${assignment.plant}/${assignment.materialNumber}`} className="border-b border-line/60">
                  <td className="px-2 py-2 code">{assignment.materialNumber}</td>
                  <td className="px-2 py-2 code">{assignment.plant}</td>
                  <td className="px-2 py-2 code">{assignment.profile}</td>
                  <td className="px-2 py-2">{assignment.version}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {canMaintain && (
          <form action={assignAction} className="mt-3 grid gap-3 sm:grid-cols-2">
            <label className="text-sm">
              Material
              <input name="materialNumber" className="field-input code mt-1 w-full" required />
            </label>
            <label className="text-sm">
              Plant
              <input name="assignPlant" defaultValue={selectedPlant} className="field-input code mt-1 w-full" required />
            </label>
            <label className="text-sm">
              Profile
              <input name="assignProfile" maxLength={6} className="field-input code mt-1 w-full" />
            </label>
            <label className="text-sm">
              Plant view version
              <input name="expectedVersion" defaultValue="1" className="field-input mt-1 w-full" required />
            </label>
            <label className="text-sm sm:col-span-2">
              Reason
              <input name="assignReason" className="field-input mt-1 w-full" required />
            </label>
            {assignState.message && (
              <p role="status" className={`text-sm sm:col-span-2 ${assignState.ok ? 'text-ink' : 'text-red-700'}`}>
                {assignState.message} {assignState.remedy ?? ''}
              </p>
            )}
            <button type="submit" className="btn btn-primary min-h-11 sm:min-h-8" disabled={assignPending}>
              Assign
            </button>
          </form>
        )}
      </section>

      <section className="border border-line bg-white p-4">
        <h2 className="text-sm font-semibold">Not executed</h2>
        <p className="mt-1 text-sm text-ink-soft">
          These profile controls are not saved, because the process they would call does not stand. T399X is not this profile.
        </p>
        <ul className="mt-2 list-disc pl-5 text-sm text-ink-soft">
          {NOT_EXECUTED.map((item) => <li key={item}>{item}</li>)}
        </ul>
      </section>
    </div>
  );
}
