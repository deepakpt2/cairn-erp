/**
 * Observe one asynchronous change-lock request and defer its owner-checked release until that request
 * has settled if the screen is cancelled first. The release is still scoped by the server action to the
 * persisted session ID; this helper does not infer ownership from a username.
 */
export function observeChangeLockClaim<T>(
  request: Promise<T>,
  onResolve: (value: T) => void,
  onReject: (error: unknown) => void,
  release: () => Promise<unknown>,
): { cancel: () => Promise<void> } {
  let active = true;
  let cleanup: Promise<void> | null = null;

  const observed = request.then(
    (value) => {
      if (active) onResolve(value);
    },
    (error: unknown) => {
      if (active) onReject(error);
    },
  );
  // The observer callbacks are currently reducer dispatches, but a future callback must not turn a
  // request rejection into an unhandled promise on a page the operator has already left.
  void observed.catch(() => undefined);

  return {
    cancel: () => {
      active = false;
      if (!cleanup) {
        // A rejected client request can follow a committed server-side claim. Release after either
        // outcome; the release action itself only deletes a row held by this persisted session.
        cleanup = request
          .then(
            () => release(),
            () => release(),
          )
          .then(() => undefined, () => undefined);
      }
      return cleanup;
    },
  };
}
