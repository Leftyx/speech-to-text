/**
 * Downloads the speech engine and models into ./assets.
 *
 * Usage:  npm run assets [model ...]
 * With no names it gets every model. Name models to get fewer, for example
 *   npm run assets orukeet whisper-small
 *
 * Downloads are kept in ./work, so running this again copies from disk instead
 * of downloading. ./assets is rebuilt from scratch on every run.
 */
import { copyFile, mkdir, rm, stat, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { type ParakeetModelSpec, parseSherpaModelList, type SherpaFileRole } from '../src/shared/manifest.ts';
import { megabytes } from '../src/shared/trace.ts';
import { findFile, sha256, untar } from './lib/archive.ts';
import { BuildError, failureText } from './lib/build-error.ts';
import { CATALOGUE, type CatalogueEntry, ENGINE, PARAKEET, SITE_NAME, VAD_URL } from './lib/catalogue.ts';
import { packFiles, patchFileList } from './lib/emscripten-package.ts';
import { download } from './lib/net.ts';

const ROOT = join(import.meta.dirname, '..');
const WORK = join(ROOT, 'work');
const WORK_MODELS = join(WORK, 'models');
const WORK_ENGINE = join(WORK, 'engine');
const WORK_PARAKEET = join(WORK, 'parakeet');
const ASSETS = join(ROOT, 'assets');
const ASSETS_ENGINE = join(ASSETS, 'engine');

/** Downloads `url` to `path`, then deletes it again if its SHA-256 is not `expected`. */
async function checkedDownload(url: string, path: string, expected: string | undefined): Promise<void> {
  await download(url, path);
  if (!expected) return;
  console.log('  checking the download ...');
  if ((await sha256(path)) !== expected) {
    await rm(path);
    throw new BuildError(`${basename(path)} did not match its SHA-256, so it has been deleted. `
      + 'Run the script again. If it fails again, the file changed on the server: '
      + 'check the new file, then update its sha256 in scripts/lib/catalogue.ts.');
  }
}

/** Gets the pinned engine release and copies its files into assets/engine. */
async function getEngine(): Promise<void> {
  const name = basename(new URL(ENGINE.from).pathname);
  console.log(`  using ${name}`);
  await checkedDownload(ENGINE.from, join(WORK_ENGINE, name), ENGINE.sha256);

  const unpacked = join(WORK_ENGINE, 'unpacked');
  await rm(unpacked, { recursive: true, force: true });
  await mkdir(unpacked);
  untar(WORK_ENGINE, name, 'unpacked');

  const missing: string[] = [];
  for (const file of ENGINE.files) {
    const src = await findFile(unpacked, (n) => n === file);
    if (src) await copyFile(src, join(ASSETS_ENGINE, file));
    else missing.push(file);
  }
  if (missing.length) throw new BuildError(`The engine package is missing: ${missing.join(', ')}`);
}

/**
 * The engine always loads one packed file at startup. That file holds the
 * pause detector only, about 0.6 MB. Speech models stay as plain files in
 * assets/models, and the page writes the chosen one into the engine at start.
 */
async function packPauseDetector(): Promise<void> {
  const vadPath = join(WORK_MODELS, 'silero_vad.onnx');
  await download(VAD_URL, vadPath);
  const packed = await packFiles([['silero_vad.onnx', vadPath]], join(ASSETS_ENGINE, ENGINE.dataName));
  await patchFileList(join(ASSETS_ENGINE, ENGINE.mainJs), packed);
}

/**
 * Downloads, checks and unpacks one speech model, and returns its models.json
 * entry. `main` checks the entry with the page's own check.
 */
async function getModel(model: CatalogueEntry): Promise<unknown> {
  const archiveName = `${model.id}.tar.bz2`;
  await checkedDownload(model.from, join(WORK_MODELS, archiveName), model.sha256);

  console.log('  unpacking ...');
  const unpacked = join(WORK_MODELS, model.id);
  await rm(unpacked, { recursive: true, force: true });
  await mkdir(unpacked, { recursive: true });
  untar(WORK_MODELS, archiveName, model.id);

  const dir = `models/${model.id}/`;
  await mkdir(join(ASSETS, dir), { recursive: true });
  const files: Partial<Record<SherpaFileRole, string>> = {};
  let bytes = 0;
  for (const [role, pattern] of Object.entries(model.pick) as [SherpaFileRole, RegExp][]) {
    const src = await findFile(unpacked, (n) => pattern.test(n));
    if (!src) throw new BuildError(`The ${model.id} archive holds no file matching ${String(pattern)}.`);
    await copyFile(src, join(ASSETS, dir, SITE_NAME[role]));
    files[role] = SITE_NAME[role];
    bytes += (await stat(src)).size;
  }
  console.log(`  kept ${Object.keys(files).length} files, ${megabytes(bytes)}`);

  return { id: model.id, label: model.label, kind: model.kind, featureDim: model.featureDim, dir, files, bytes };
}

/** Downloads the Parakeet model files and writes models-parakeet/model.json. */
async function getParakeetModel(): Promise<void> {
  await mkdir(WORK_PARAKEET, { recursive: true });
  const dir = 'models-parakeet/';
  await mkdir(join(ASSETS, dir), { recursive: true });
  let bytes = 0;
  for (const role of Object.keys(PARAKEET.files) as (keyof typeof PARAKEET.files)[]) {
    const cached = join(WORK_PARAKEET, PARAKEET.repoFiles[role]);
    await download(PARAKEET.repo + PARAKEET.repoFiles[role], cached);
    await copyFile(cached, join(ASSETS, dir, PARAKEET.files[role]));
    bytes += (await stat(cached)).size;
  }
  // The Parakeet worker runs the same pause detector as the engine, as a plain
  // file. It is not in `files`, so the model size stays the Parakeet size.
  const vadPath = join(WORK_MODELS, 'silero_vad.onnx');
  await download(VAD_URL, vadPath);
  await copyFile(vadPath, join(ASSETS, dir, 'silero_vad.onnx'));
  const spec: ParakeetModelSpec = { id: PARAKEET.id, label: PARAKEET.label, dir, files: PARAKEET.files, bytes };
  await writeFile(join(ASSETS, dir, 'model.json'), `${JSON.stringify(spec, null, 1)}\n`);
  console.log(`  kept ${megabytes(bytes)} of model`);
}

async function main(): Promise<void> {
  const asked = process.argv.slice(2);
  const known = [...CATALOGUE.map((m) => m.id), PARAKEET.id];
  const unknown = asked.filter((a) => !known.includes(a));
  if (unknown.length) throw new BuildError(`No model is called ${unknown.join(', ')}. The names are: ${known.join(', ')}.`);

  // Naming speech models gets only those. Naming just the Parakeet page still gets
  // all of them, or the main page would end up with no model at all.
  const named = CATALOGUE.filter((m) => asked.includes(m.id));
  const wanted = named.length ? named : CATALOGUE;
  const withParakeet = asked.length === 0 || asked.includes(PARAKEET.id);

  await mkdir(WORK_MODELS, { recursive: true });
  await mkdir(WORK_ENGINE, { recursive: true });
  await rm(ASSETS, { recursive: true, force: true });
  await mkdir(ASSETS_ENGINE, { recursive: true });

  console.log('1/4 Speech engine (official sherpa-onnx release)');
  await getEngine();

  console.log('2/4 Pause detector, packed for the engine');
  await packPauseDetector();

  console.log(`3/4 Speech models: ${wanted.map((m) => m.id).join(', ')}`);
  const entries: unknown[] = [];
  for (const model of wanted) {
    console.log(`  ${model.label}`);
    entries.push(await getModel(model));
  }
  // The same check the page runs, so a wrong entry fails here, not in the browser.
  const manifest = parseSherpaModelList(entries);
  await writeFile(join(ASSETS, 'models', 'models.json'), `${JSON.stringify(manifest, null, 1)}\n`);

  if (withParakeet) {
    console.log(`4/4 Second page, parakeet.html: ${PARAKEET.label}`);
    await getParakeetModel();
  }

  const total = manifest.reduce((sum, m) => sum + m.bytes, 0);
  console.log(`\nDone. ${manifest.length} model(s), ${megabytes(total)} in assets/models.`);
  console.log('The archives in work/ are only needed to run this again. You can delete them.');
  console.log('Start the test page with:\n  npm run dev');
}

try {
  await main();
} catch (err) {
  console.error(`\nERROR: ${failureText(err)}`);
  process.exitCode = 1;
}
