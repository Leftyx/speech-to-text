import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { BuildError } from './build-error.ts';

/** The SHA-256 of a file, as lowercase hex. */
export async function sha256(file: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk as Buffer);
  return hash.digest('hex');
}

/**
 * Unpacks `dir/archiveName` into `dir/outDirName`.
 *
 * Uses the tar.exe built into Windows 10/11 (also present on macOS/Linux).
 * The paths are relative to `dir`, because tar reads "C:" as a remote host.
 *
 * @throws BuildError that tells the user to delete the archive and try again.
 */
export function untar(dir: string, archiveName: string, outDirName: string): void {
  const r = spawnSync('tar', ['-xf', archiveName, '-C', outDirName], { cwd: dir, stdio: 'inherit' });
  if (r.error || r.status !== 0) {
    throw new BuildError(`Could not unpack ${archiveName} with the built-in "tar" command `
      + `(${r.error ? r.error.message : `exit code ${String(r.status)}`}). `
      + `Delete ${join(dir, archiveName)} and run the script again.`);
  }
}

/** The path of the first file under `dir` (at any depth) whose name passes `test`. */
export async function findFile(dir: string, test: (name: string) => boolean): Promise<string | undefined> {
  const entries = await readdir(dir, { recursive: true, withFileTypes: true });
  const found = entries.find((e) => e.isFile() && test(e.name));
  return found && join(found.parentPath, found.name);
}
