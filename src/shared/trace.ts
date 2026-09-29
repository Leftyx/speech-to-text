/** Seconds since `t0`, a `performance.now()` value. */
export const secondsSince = (t0: number): number => (performance.now() - t0) / 1000;

/** A size for people to read, such as "671 MB". */
export const megabytes = (bytes: number): string => `${(bytes / 1e6).toFixed(0)} MB`;

/**
 * Returns a logger that prefixes each line with the seconds since it was made.
 *
 * Every loading step reports itself this way, so when loading stalls, the
 * console names the step it stalled on.
 */
export function createTrace(tag: string): (text: string) => void {
  const start = performance.now();
  return (text) => {
    console.log(`[${tag} ${secondsSince(start).toFixed(1)} s] ${text}`);
  };
}
