import { open, rename, stat } from 'node:fs/promises';
import { basename } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { BuildError } from './build-error.ts';

/** Downloads over this size print their progress in steps of 10 %. */
const PROGRESS_FROM_BYTES = 20 * 1024 * 1024;

/** A reply with an error status. */
class HttpError extends Error {
  readonly status: number;

  constructor(status: number, url: string) {
    super(`HTTP ${status}: ${url}`);
    this.status = status;
  }
}

/**
 * Only a network failure (fetch throws a TypeError), a server error (5xx) or
 * "too many requests" (429) can pass on its own. Anything else, such as a
 * missing file or a full disk, fails the same way on the next try.
 */
const worthRetry = (err: unknown): boolean =>
  err instanceof TypeError || (err instanceof HttpError && (err.status >= 500 || err.status === 429));

/**
 * Runs `fn`, and tries again when it fails for a reason that can pass.
 *
 * A network call can fail for a short time (Wi-Fi, VPN, proxy, a GitHub
 * outage). "fetch failed" alone says nothing, so the code in `err.cause` goes
 * into the message.
 *
 * @param what - What is being tried, for the messages.
 * @throws BuildError after the last try fails, or at once for a failure that cannot pass.
 */
async function retry<T>(what: string, fn: () => Promise<T>, tries = 3): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const reason = describeFetchError(err);
      if (!worthRetry(err)) {
        const next = err instanceof HttpError && err.status === 404
          ? 'The file is not at that address any more: update it in scripts/lib/catalogue.ts'
          : 'Correct that, then run the script again';
        throw new BuildError(`${what} failed: ${reason}. ${next}.`);
      }
      if (attempt >= tries) {
        throw new BuildError(`${what} failed after ${tries} tries: ${reason}. `
          + 'Check the internet connection, then run the script again.');
      }
      console.log(`  ${what} failed (${reason}), trying again in ${attempt * 2} s ...`);
      await sleep(attempt * 2000);
    }
  }
}

function describeFetchError(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  const { cause } = err;
  if (cause instanceof Error) return ('code' in cause && typeof cause.code === 'string') ? cause.code : cause.message;
  return err.message;
}

async function hasFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).size > 0;
  } catch {
    return false;
  }
}

/**
 * Downloads `url` to `dest`, unless `dest` already exists.
 *
 * The data goes to `dest.part` first and is renamed at the end, so a stopped
 * download never looks like a finished one.
 */
export async function download(url: string, dest: string): Promise<void> {
  const name = basename(dest);
  if (await hasFile(dest)) {
    console.log(`  already downloaded: ${name}`);
    return;
  }
  console.log(`  downloading ${name} ...`);
  const tmp = `${dest}.part`;
  await retry(`Download of ${name}`, async () => {
    const res = await fetch(url, { redirect: 'follow' });
    if (!res.ok || !res.body) throw new HttpError(res.status, url);

    const total = Number(res.headers.get('content-length')) || 0;
    let done = 0;
    let lastStep = -1;
    // Each try writes the .part file from the start, so a half file cannot survive.
    const file = await open(tmp, 'w');
    try {
      // Node's types for the fetch body do not say what its chunks are.
      for await (const chunk of res.body as AsyncIterable<Uint8Array>) {
        await file.write(chunk);
        done += chunk.byteLength;
        const step = total > PROGRESS_FROM_BYTES ? Math.floor((done * 10) / total) : lastStep;
        if (step !== lastStep) {
          lastStep = step;
          console.log(`    ${step * 10}%`);
        }
      }
    } finally {
      await file.close();
    }
  });
  await rename(tmp, dest);
}
