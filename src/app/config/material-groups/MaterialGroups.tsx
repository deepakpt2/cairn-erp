'use client';

/**
 * Material group definition — inert stage 1 (SCR-049 / OMSF).
 *
 * The layout the live screen will keep: the group grid with its short
 * and long descriptions and lifecycle. Nothing here reads or writes
 * yet; the standing material groups provisioned at onboarding list here
 * once the service lands.
 */
export default function MaterialGroups({ canMaintain }: { canMaintain: boolean }) {
  return (
    <div className="space-y-6">
      <p role="status" className="text-sm text-ink-soft">
        This screen stands inert: the material group definition service arrives in a
        later stage. The groups provisioned when the tenant was created will stand in
        the grid below, and every write will carry a reason and a change document.
      </p>

      <section aria-labelledby="material-groups-grid" className="space-y-2">
        <h2 id="material-groups-grid" className="text-base font-semibold">
          Material groups
        </h2>
        <p className="max-w-3xl text-sm text-ink-soft">
          One row per group: its key of at most nine letters or digits, a short
          description of at most 20 characters, and an optional long description of at
          most 60. Materials name one group when they are created, and reports read the
          group as it stands — renaming a description re-labels history, but the
          classification a material carries never changes silently, because the key is
          never renamed. A group is deleted only while no material carries it;
          deactivation stands beside deletion for a group in use. No numbering,
          valuation or period behaviour attaches to a group.
        </p>
        <p className="text-sm text-ink-faint">No groups are listed yet.</p>
      </section>

      {canMaintain ? null : (
        <p className="text-sm text-ink-faint">
          You are viewing this screen read-only; defining material groups needs its own
          authority.
        </p>
      )}
    </div>
  );
}
