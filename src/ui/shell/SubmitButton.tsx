'use client';

import { useFormStatus } from 'react-dom';
import { Spinner } from './Spinner';

/**
 * A submit button that says so while its form is being answered — CAIRN.md §19.2.
 *
 * The pending state comes from the form itself, so it is the truth rather than a
 * guess: the button is disabled and shows a spinner for exactly as long as the
 * action is running, and no longer.
 */
export function SubmitButton({
  label,
  pendingLabel,
  className = 'btn btn-default',
  disabled = false,
}: {
  label: string;
  pendingLabel: string;
  className?: string;
  disabled?: boolean;
}) {
  const { pending } = useFormStatus();

  return (
    <button
      type="submit"
      className={className}
      disabled={disabled || pending}
      aria-busy={pending || undefined}
      data-testid="submit-button"
    >
      {pending ? (
        <span className="inline-flex items-center gap-1.5">
          <Spinner />
          {pendingLabel}
        </span>
      ) : (
        label
      )}
    </button>
  );
}
