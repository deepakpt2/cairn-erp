'use client';

/**
 * Material type definition — inert stage 1 (SCR-048 / OMS2).
 *
 * The layout the live screen will keep: the type grid with its
 * definition detail, the account category references judged on every
 * type, and the per-plant quantity/value updating rows. Nothing here
 * reads or writes yet; the standing material types provisioned at
 * onboarding list here once the service lands.
 */
export default function MaterialTypes({ canMaintain }: { canMaintain: boolean }) {
  return (
    <div className="space-y-6">
      <p role="status" className="text-sm text-ink-soft">
        This screen stands inert: the material type definition service arrives in a later
        stage. The types provisioned when the tenant was created will stand in the grid
        below, and every write will carry a reason and a change document.
      </p>

      <section aria-labelledby="material-types-grid" className="space-y-2">
        <h2 id="material-types-grid" className="text-base font-semibold">
          Material types
        </h2>
        <p className="max-w-3xl text-sm text-ink-soft">
          One row per type: its key of at most four letters or digits and description of at
          most 25 characters, the default price control (Standard price or Moving average
          price), the internal and external material number ranges, the account category
          reference, the internal procurement default materials inherit, the external and
          internal purchase-order permissions (Not allowed, Allowed with warning, Allowed),
          and whether the type supports configurable materials. A type is deleted only
          while no material carries it; deactivation stands beside deletion for a type in
          use.
        </p>
        <p className="text-sm text-ink-faint">No types are listed yet.</p>
      </section>

      <section aria-labelledby="account-category-references" className="space-y-2">
        <h2 id="account-category-references" className="text-base font-semibold">
          Account category references
        </h2>
        <p className="max-w-3xl text-sm text-ink-soft">
          Every type names one account category reference, the grouping valuation will read
          when it assigns classes to materials. The references are maintained here because
          no other screen owns them; which valuation classes a reference permits is decided
          when the valuation classes themselves are maintained.
        </p>
        <p className="text-sm text-ink-faint">No references are listed yet.</p>
      </section>

      <section aria-labelledby="material-type-valuation" className="space-y-2">
        <h2 id="material-type-valuation" className="text-base font-semibold">
          Quantity and value updating
        </h2>
        <p className="max-w-3xl text-sm text-ink-soft">
          Updating is decided per plant: for each type and plant, whether quantities and
          whether values are updated. Changing updating for a type at a plant is refused
          while materials of that type stand at that plant, so standing materials never
          change their accounting behaviour silently.
        </p>
        <p className="text-sm text-ink-faint">No updating rows are listed yet.</p>
      </section>

      {canMaintain ? null : (
        <p className="text-sm text-ink-faint">
          You are viewing this screen read-only; defining material types needs its own
          authority.
        </p>
      )}
    </div>
  );
}
