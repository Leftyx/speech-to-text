/** A readable message for any thrown value, including the strings Emscripten throws. */
export const describeError = (err: unknown): string =>
  err instanceof Error ? err.message : String(err);
