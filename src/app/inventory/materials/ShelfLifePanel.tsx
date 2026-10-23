import { saveMaterialShelfLifeAction } from './shelf-life-action';
import type { MaterialShelfLife } from '@/modules/inventory/material-shelf-life';

/** Client-level shelf-life settings. Saving does not post and does not change a batch date. */
export default function ShelfLifePanel({ current, canMaintain }: {
  current: MaterialShelfLife;
  canMaintain: boolean;
}) {
  return (
    <section className="panel space-y-3 p-4">
      <h2 className="text-sm font-medium">Shelf life data</h2>
      <p className="text-sm text-ink-soft">
        These fields are for the material, not for one plant. They are not copied to a batch.
        A save does not post and does not change a stored expiration date. OMJ5 is not this screen.
      </p>
      {canMaintain ? (
        <form action={saveMaterialShelfLifeAction} className="flex flex-wrap items-end gap-3">
          <input type="hidden" name="materialNumber" value={current.materialNumber} />
          <label className="text-sm">Minimum remaining shelf life
            <input name="minRemainingShelfLife" inputMode="numeric" className="field-input code mt-1 w-28" defaultValue={current.minRemainingShelfLife ?? ''} />
          </label>
          <label className="text-sm">Total shelf life
            <input name="totalShelfLife" inputMode="numeric" className="field-input code mt-1 w-28" defaultValue={current.totalShelfLife ?? ''} />
          </label>
          <label className="text-sm">Storage percentage
            <input name="storagePercentage" inputMode="numeric" className="field-input code mt-1 w-28" defaultValue={current.storagePercentage ?? ''} />
          </label>
          <label className="text-sm">Period
            <select name="periodIndicator" className="field-input mt-1" defaultValue={current.periodIndicator === ' ' ? 'D' : current.periodIndicator ?? ''}>
              <option value="">Not set</option>
              <option value="D">Days</option>
              <option value="1">Weeks</option>
              <option value="2">Months</option>
              <option value="3">Years</option>
            </select>
          </label>
          <label className="text-sm">Reason
            <input name="reason" required minLength={3} className="field-input mt-1 w-64" />
          </label>
          <button className="btn btn-default min-h-11 sm:min-h-8" type="submit">Save shelf life</button>
        </form>
      ) : <p className="text-sm text-ink-soft">Display only. Ask an administrator for INV.MATERIAL.MAINTAIN.</p>}
    </section>
  );
}
