/**
 * The working spinner — CAIRN.md §19.2.
 *
 * Two arcs rather than a closed ring, so the movement still reads at twelve
 * pixels on a dense screen. It carries no meaning of its own: the words beside
 * it say what is happening, so it never takes the focus and never reaches
 * assistive technology on its own.
 *
 * It is markup and CSS only — no client JavaScript — so a server component can
 * render it and the animation still runs when the page arrives.
 */
export function Spinner({ className = '' }: { className?: string }) {
  return (
    <span
      aria-hidden
      data-testid="spinner"
      className={`spinner ${className}`.trim()}
    />
  );
}
