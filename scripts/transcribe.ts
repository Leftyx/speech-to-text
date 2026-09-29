/**
 * Plays audio files into every model and prints what each one heard.
 *
 * Usage:  npm run transcribe -- <file> [more files ...] [model ...]
 * With no model names it uses every model in assets/. For example
 *   npm run transcribe -- recording.wav
 *   npm run transcribe -- recording.webm orukeet parakeet
 *
 * Each file plays through a headless Edge or Chrome as if it were the
 * microphone, so the whole page runs as it does for a person: microphone,
 * worklet, worker, model. The real-time playback means a 20 s file takes at
 * least 20 s per model. Files that are not WAV are converted first.
 */
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { describeError } from '../src/shared/errors.ts';
import { parseParakeetModelSpec, parseSherpaModelList } from '../src/shared/manifest.ts';
import { asWav, wavSeconds } from './lib/audio-file.ts';
import { type Page, launchBrowser } from './lib/browser.ts';
import { BuildError, failureText } from './lib/build-error.ts';
import { startSiteServer } from './lib/site-server.ts';

const ASSETS = join(import.meta.dirname, '..', 'assets');

/** Silence recorded after the file, so the pause detector closes the last phrase. */
const TAIL_SECS = 2;
const POLL_MS = 500;
const LOAD_TIMEOUT_MS = 5 * 60_000;

/** A model and the page that runs it. */
interface Target {
  readonly id: string;
  readonly path: string;
}

/** What one model made of one file. */
type Outcome =
  | { readonly ok: true; readonly text: string; readonly tookSecs: number }
  | { readonly ok: false; readonly error: string };

/** The page state that tells when transcription is finished. */
interface PageState {
  readonly status: string;
  readonly ready: boolean;
  readonly failed: boolean;
  /** "N phrases waiting to be transcribed", or empty. */
  readonly waiting: string;
  /** "Hearing speech…", or empty. */
  readonly live: string;
  /** The transcript lines. `error` lines stand for a phrase that failed. */
  readonly items: readonly { readonly text: string; readonly timing: string; readonly error: boolean }[];
}

const READ_STATE = `(() => {
  const banner = document.querySelector('status-banner');
  const status = banner?.textContent ?? '';
  return {
    status,
    ready: status.startsWith('Ready'),
    failed: banner?.failed ?? false,
    waiting: document.getElementById('waiting')?.textContent ?? '',
    live: document.querySelector('record-controls .live')?.textContent ?? '',
    items: [...document.querySelectorAll('transcript-list li')].map((li) => ({
      text: li.querySelector('span')?.textContent ?? '',
      timing: li.querySelector('small')?.textContent ?? '',
      error: li.classList.contains('error'),
    })),
  };
})()`;

/** Every model in assets/: the sherpa models on the main page, then the Parakeet page. */
async function availableTargets(): Promise<Target[]> {
  const listFile = join(ASSETS, 'models', 'models.json');
  if (!existsSync(listFile)) throw new BuildError('There is no model list. Run first: npm run assets');
  const list = parseSherpaModelList(JSON.parse(await readFile(listFile, 'utf8')));
  const targets: Target[] = list.map((m) => ({ id: m.id, path: `/?model=${encodeURIComponent(m.id)}` }));
  const parakeetSpec = join(ASSETS, 'models-parakeet', 'model.json');
  if (existsSync(parakeetSpec)) {
    const spec = parseParakeetModelSpec(JSON.parse(await readFile(parakeetSpec, 'utf8')));
    targets.push({ id: spec.id, path: '/parakeet.html' });
  }
  return targets;
}

/** Calls `read` until `done` accepts its value, or throws after `timeoutMs`. */
async function waitFor<T>(read: () => Promise<T>, done: (value: T) => boolean, timeoutMs: number, what: string): Promise<T> {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (done(value)) return value;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(POLL_MS);
  }
}

/** Loads one model, records the file into it, and collects the transcript. */
async function transcribe(page: Page, base: string, target: Target, seconds: number): Promise<Outcome> {
  const state = async (): Promise<PageState> => {
    const value = await page.evaluate(READ_STATE);
    // READ_STATE above builds this object, so a light check is enough.
    if (typeof value !== 'object' || value === null || !('items' in value)) {
      throw new Error('the page state could not be read');
    }
    return value as PageState;
  };

  await page.navigate(base + target.path);
  const loaded = await waitFor(state, (s) => s.ready || s.failed, LOAD_TIMEOUT_MS, 'the model to load');
  if (loaded.failed) return { ok: false, error: loaded.status };

  await page.evaluate(`document.querySelector('record-controls .start').click()`);
  await sleep((seconds + TAIL_SECS) * 1000);
  // After 45 s without speech the page stops by itself, and the button says Start.
  await page.evaluate(`document.querySelector('record-controls .stop')?.click()`);
  await sleep(1000); // let the worker receive the end of the recording

  // Finished when nothing is waiting or being transcribed, twice in a row.
  let quietBefore = false;
  const done = await waitFor(state, (s) => {
    const quiet = s.failed || (s.waiting === '' && s.live === '');
    const finished = quiet && quietBefore;
    quietBefore = quiet;
    return finished;
  }, Math.max(120, seconds * 15) * 1000, 'the transcript');
  if (done.failed) return { ok: false, error: done.status };
  const errors = done.items.filter((i) => i.error);
  if (errors.length) return { ok: false, error: errors.map((i) => i.text).join(' | ') };

  const text = done.items.map((i) => i.text).join(' ');
  const tookSecs = done.items.reduce((sum, i) => sum + Number(/transcribed in ([\d.]+) s/.exec(i.timing)?.[1] ?? 0), 0);
  return { ok: true, text, tookSecs };
}

/** Runs every file through every model. @returns How many of those runs failed. */
async function main(): Promise<number> {
  const all = await availableTargets();
  // An argument is a model if it names one, otherwise a file.
  const args = process.argv.slice(2);
  const names = args.filter((a) => all.some((t) => t.id === a));
  const files = args.filter((a) => !names.includes(a)).map((f) => resolve(f));
  if (!files.length) throw new BuildError('Name at least one audio file: npm run transcribe -- recording.wav');
  const missing = files.filter((f) => !existsSync(f));
  if (missing.length) {
    throw new BuildError(`Not found: ${missing.join(', ')}. The models are: ${all.map((t) => t.id).join(', ')}.`);
  }
  const targets = names.length ? all.filter((t) => names.includes(t.id)) : all;
  const width = Math.max(...targets.map((t) => t.id.length));

  const tempDir = await mkdtemp(join(tmpdir(), 'orukeet-audio-'));
  const { server, port } = await startSiteServer(0);
  let failed = 0;
  try {
    for (const file of files) {
      const wav = await asWav(file, tempDir);
      const seconds = await wavSeconds(wav);
      console.log(`\n${basename(file)} (${seconds.toFixed(1)} s${wav === file ? '' : ', converted to WAV'})`);
      // The file is fixed when the browser starts, so each file gets its own browser.
      const browser = await launchBrowser(wav);
      try {
        for (const target of targets) {
          // The name first, so a long run shows which model it is on.
          process.stdout.write(`  ${target.id.padEnd(width)}  `);
          const out = await transcribe(browser.page, `http://127.0.0.1:${port}`, target, seconds)
            .catch((err: unknown): Outcome => ({ ok: false, error: describeError(err) }));
          if (!out.ok) failed++;
          console.log(out.ok
            ? `${out.tookSecs.toFixed(1).padStart(5)} s  ${out.text || '(nothing recognised)'}`
            : `FAILED: ${out.error}`);
        }
      } finally {
        await browser.close();
      }
    }
  } finally {
    server.close();
    await rm(tempDir, { recursive: true, force: true });
  }
  return failed;
}

try {
  const failed = await main();
  if (failed > 0) {
    console.error(`\n${failed} run(s) FAILED.`);
    process.exitCode = 1;
  }
} catch (err) {
  console.error(`\nERROR: ${failureText(err)}`);
  process.exitCode = 1;
}
