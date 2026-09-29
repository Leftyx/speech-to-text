/**
 * The sherpa-onnx engine is an Emscripten build. At start it loads one packed
 * `.data` file, and its `.js` file holds the list of files inside that package.
 * These helpers write our own package and put its file list into the `.js`.
 */
import { createReadStream, createWriteStream } from 'node:fs';
import { readFile, stat, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { basename } from 'node:path';
import { pipeline } from 'node:stream/promises';
import vm from 'node:vm';
import { BuildError } from './build-error.ts';

/** Where one file sits inside the package. */
export interface PackageEntry {
  filename: string;
  start: number;
  end: number;
}

/** The result of {@link packFiles}. */
export interface PackedFiles {
  entries: PackageEntry[];
  totalSize: number;
}

/** The part of the engine's `loadPackage({...})` argument that we change. */
interface PackageMetadata {
  files: Record<string, unknown>[];
  remote_package_size: number;
  package_uuid?: string;
}

/**
 * Writes all files, back to back, into one package file.
 *
 * @param files - Pairs of [name inside the package, source path].
 * @returns The offsets the engine needs to find each file.
 */
export async function packFiles(files: readonly (readonly [string, string])[], outPath: string): Promise<PackedFiles> {
  const entries: PackageEntry[] = [];
  let offset = 0;
  for (const [name, src] of files) {
    const { size } = await stat(src);
    entries.push({ filename: `/${name}`, start: offset, end: offset + size });
    offset += size;
  }
  // pipeline() turns a failed write (a full disk, no access) into a failure of this call.
  await pipeline(async function* () {
    for (const [, src] of files) yield* createReadStream(src);
  }, createWriteStream(outPath));
  if ((await stat(outPath)).size !== offset) throw new BuildError('Model package has the wrong size after writing.');
  return { entries, totalSize: offset };
}

/**
 * Replaces the file list inside the engine's `.js` file with `packed`, then
 * reads the file back to confirm the change.
 */
export async function patchFileList(jsPath: string, packed: PackedFiles): Promise<void> {
  let js = await readFile(jsPath, 'utf8');
  const { start, end } = locateFileList(js, jsPath);
  // The list is a JavaScript object literal, not strict JSON, so it is
  // evaluated in an empty context instead of parsed.
  const meta = vm.runInNewContext(`(${js.slice(start, end + 1)})`) as Partial<PackageMetadata> | undefined;
  const template = Array.isArray(meta?.files) ? meta.files[0] : undefined;
  if (!meta?.files || !template) {
    throw new BuildError(`Unexpected file list format in ${basename(jsPath)}.`);
  }

  meta.files = packed.entries.map((e) => {
    const f: Record<string, unknown> = { ...template, ...e };
    if ('audio' in template) f['audio'] = 0;
    return f;
  });
  meta.remote_package_size = packed.totalSize;
  if ('package_uuid' in meta) meta.package_uuid = randomUUID();

  js = js.slice(0, start) + JSON.stringify(meta) + js.slice(end + 1);
  await writeFile(jsPath, js);

  const again = await readFile(jsPath, 'utf8');
  const pos = locateFileList(again, jsPath);
  const check = JSON.parse(again.slice(pos.start, pos.end + 1)) as PackageMetadata;
  if (check.remote_package_size !== packed.totalSize || check.files.length !== packed.entries.length) {
    throw new BuildError('Updating the engine file list did not work.');
  }
}

/** Finds the object literal passed to the last `loadPackage(` call. */
function locateFileList(js: string, jsPath: string): { start: number; end: number } {
  const last = [...js.matchAll(/loadPackage\(\s*\{/g)].at(-1);
  if (!last) throw new BuildError(`Could not find the model file list in ${basename(jsPath)}.`);
  const start = last.index + last[0].length - 1;
  return { start, end: matchBrace(js, start) };
}

/** The index of the `}` that closes the `{` at `open`. Skips braces inside strings. */
function matchBrace(s: string, open: number): number {
  let depth = 0;
  let quote: string | null = null;
  for (let i = open; i < s.length; i++) {
    const c = s[i];
    if (quote) {
      if (c === '\\') i++;
      else if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'") quote = c;
    else if (c === '{') depth++;
    else if (c === '}' && --depth === 0) return i;
  }
  throw new BuildError('Could not read the model file list (unbalanced braces).');
}
