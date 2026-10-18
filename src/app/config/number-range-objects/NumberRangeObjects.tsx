'use client';

/**
 * Number range objects — inert stage 1 (SCR-050 / SNRO).
 *
 * The layout the live screen will keep: the object grid with its
 * facts. Nothing here reads or writes yet; the registry and its
 * standing objects list here once the service lands, beside the
 * interval maintenance the number-ranges screen already performs.
 */
export default function NumberRangeObjects({ canMaintain }: { canMaintain: boolean }) {
  return (
    <div className="space-y-6">
      <p role="status" className="text-sm text-ink-soft">
        This screen stands inert: the object registry arrives in a later stage. The
        objects the applications number from will stand in the grid below, and every
        write will carry a reason and a change document.
      </p>

      <section aria-labelledby="number-range-objects-grid" className="space-y-2">
        <h2 id="number-range-objects-grid" className="text-base font-semibold">
          Number range objects
        </h2>
        <p className="max-w-3xl text-sm text-ink-soft">
          One row per object: its name of at most ten letters or digits — owned by the
          application, so no screen creates or deletes an object — its description of at
          most 60 characters, the number length its intervals format to, whether its
          intervals run per fiscal year or stand for all years, and the optional
          consumption warning that flags an interval before it runs dry. An interval's
          buffering choice stands beside it: a buffered interval reserves its block at
          once, so a document that later rolls back leaves its number consumed and the
          gap visible, where an unbuffered interval never lets a number escape.
        </p>
        <p className="text-sm text-ink-faint">No objects are listed yet.</p>
      </section>

      {canMaintain ? null : (
        <p className="text-sm text-ink-faint">
          You are viewing this screen read-only; maintaining number range objects needs
          its own authority.
        </p>
      )}
    </div>
  );
}
