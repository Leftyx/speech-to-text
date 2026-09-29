/**
 * A build failure whose message is written for the person running the script.
 * Helpers throw it; the top of each script prints the message and sets the
 * exit code, so no helper ends the process on its own.
 */
export class BuildError extends Error {
  override name = 'BuildError';
}

/** What the top of a script prints for a failure: the message of a BuildError, else the whole stack. */
export function failureText(err: unknown): string {
  if (err instanceof BuildError) return err.message;
  return err instanceof Error && err.stack ? err.stack : String(err);
}
