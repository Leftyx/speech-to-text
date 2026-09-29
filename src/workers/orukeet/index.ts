/**
 * The engine worker: runs the sherpa-onnx engine off the main thread.
 *
 * It receives 16 kHz audio from the microphone worklet, cuts it at pauses and
 * transcribes each phrase in order.
 *
 * This is a CLASSIC worker, built by vite.config.ts into one script,
 * `engine-worker.js`, at the site root: the engine files load only through
 * importScripts(). See engine-loader.ts.
 *
 * Loading, in order:
 *   1. empty the old model storage (removeOldStorage);
 *   2. read models/models.json and pick the model the page asked for;
 *   3. get its files, from browser storage or the server (model-cache.ts);
 *   4. start the engine, and write the files into its file system;
 *   5. create the recognizer, then let go of the files.
 */
import type { AudioPortMessage } from '../../shared/audio-protocol.ts';
import type { OrukeetCommand, OrukeetEvent } from '../../shared/orukeet-protocol.ts';
import { describeError } from '../../shared/errors.ts';
import { parseSherpaModelList, type SherpaModelEntry } from '../../shared/manifest.ts';
import { createTrace, megabytes, secondsSince } from '../../shared/trace.ts';
import { TypedChannel } from '../../shared/typed-channel.ts';
import { localModel } from '../common/model-cache.ts';
import { startEngine } from './engine-loader.ts';
import { PhraseTranscriber } from './phrase-transcriber.ts';

const page = new TypedChannel<OrukeetEvent, OrukeetCommand>(self);
const trace = createTrace('model');

/** This script is served from the site root, next to models/ and engine/. */
const SITE_BASE = new URL('./', self.location.href);
const ENGINE_BASE = new URL('engine/', SITE_BASE);

/** This page's model cache. Keep the name, or every user downloads the model again. */
const MODEL_CACHE = 'sherpa-model';

let transcriber: PhraseTranscriber | undefined;
/** Set once `load` arrives. A second `load` would start a second engine over the first. */
let loadStarted = false;
/** Ends the recording in progress. Unset when none is. */
let endRecording: (() => void) | undefined;

/** Shows `text` on the page's status line. */
function showStatus(text: string): void {
  page.send({ type: 'status', text });
}

/** Runs one loading step; a failure is reported under `failure`. */
async function step<T>(failure: string, run: () => T | Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (err) {
    throw new Error(`${failure}: ${describeError(err)}`, { cause: err });
  }
}

/** The models.json entry for `modelId`, or the first one if none is given or found. */
async function chooseModel(modelId: string | null): Promise<SherpaModelEntry> {
  const list = await fetch(new URL('models/models.json', SITE_BASE));
  if (!list.ok) throw new Error(`no model list (HTTP ${list.status}); run npm run assets`);
  const models = parseSherpaModelList(await list.json());
  const model = models.find((m) => m.id === modelId) ?? models[0];
  if (!model) throw new Error('the model list is empty; run npm run assets');
  return model;
}

/**
 * Earlier versions kept the model in the browser's private file storage
 * (OPFS). Nothing uses OPFS now, so empty it, or the old model stays on the
 * disk. When all testers use this version, remove this function.
 */
async function removeOldStorage(): Promise<void> {
  try {
    const root = await navigator.storage.getDirectory();
    const names: string[] = [];
    for await (const name of root.keys()) names.push(name);
    await Promise.all(names.map((name) => root.removeEntry(name, { recursive: true })));
    if (names.length > 0) trace(`deleted the old model storage (${names.length} files)`);
  } catch (err) {
    trace(`could not delete the old model storage: ${describeError(err)}`);
  }
}

/** Gets every file of `model`, by file name, and the sentence that says where they came from. */
async function getModelFiles(model: SherpaModelEntry): Promise<{
  files: Map<string, Uint8Array<ArrayBuffer>>;
  source: string;
}> {
  const names = Object.values(model.files);
  const local = await localModel(MODEL_CACHE, names.map((name) => new URL(model.dir + name, SITE_BASE).href), {
    log: trace,
    status: showStatus,
  });

  const files = new Map<string, Uint8Array<ArrayBuffer>>();
  for (const [i, name] of names.entries()) {
    const file = local.files[i];
    if (!file) throw new Error(`${model.dir}${name} is missing`);
    const t0 = performance.now();
    const bytes = new Uint8Array(await file.arrayBuffer());
    trace(`${model.dir}${name}: ${megabytes(bytes.byteLength)} read in ${secondsSince(t0).toFixed(1)} s`);
    files.set(name, bytes);
  }
  return { files, source: local.source };
}

async function load(modelId: string | null, language: string): Promise<void> {
  await removeOldStorage();
  const { model, label, files, source } = await step('Could not get the model', async () => {
    const model = await chooseModel(modelId);
    trace(`chosen model: ${model.id}`);
    const text = `Getting ${model.label} (${megabytes(model.bytes)})…`;
    trace(text);
    showStatus(text);
    // A wrong ?model= loads the first model. Say so, or the page seems to ignore the link.
    const label = modelId === null || modelId === model.id
      ? model.label
      : `${model.label} (the page asked for "${modelId}", which is not in the model list)`;
    return { model, label, ...await getModelFiles(model) };
  });

  trace('starting the engine');
  const runtime = await step('Could not start the engine', () => startEngine({
    base: ENGINE_BASE,
    onStatus: showStatus,
    onAbort: (reason) => {
      transcriber = undefined;
      page.send({ type: 'error', text: reason, fatal: true });
    },
  }));

  trace('the engine is up, handing it the model');
  showStatus('Loading the model into memory…');
  const t0 = performance.now();
  await step('Model failed to load', () => {
    for (const [name, bytes] of files) {
      // canOwn is true, so the engine takes these bytes instead of copying.
      runtime.FS_createDataFile('/', name, bytes, true, true, true);
    }
    trace('model files written into the engine');
    transcriber = new PhraseTranscriber(runtime, model, language, (event) => {
      page.send(event);
    });
    trace('the recognizer is ready');
  });
  page.send({ type: 'ready', loadSecs: secondsSince(t0), model: label, source });

  // The recognizer has read the files, so let go of them.
  for (const name of files.keys()) runtime.FS_unlink(`/${name}`);
  trace('released the copies held outside the recognizer');
}

/** Runs `work` on the transcriber, and reports a failure. The recording goes on. */
function withTranscriber(work: (transcriber: PhraseTranscriber) => void): void {
  if (!transcriber) return;
  try {
    work(transcriber);
  } catch (err) {
    page.send({
      type: 'error',
      text: `Audio processing failed: ${describeError(err)}. Press Stop, then Start.`,
      fatal: false,
    });
  }
}

/** Feeds one recording's audio port into the transcriber. */
function listen(port: MessagePort): void {
  const end = (): void => {
    port.close();
    if (endRecording === end) endRecording = undefined;
    withTranscriber((t) => {
      t.finish();
    });
  };
  endRecording = end;
  new TypedChannel<never, AudioPortMessage>(port).onMessage((msg) => {
    switch (msg.type) {
      case 'audio':
        withTranscriber((t) => {
          t.feed(msg.samples);
        });
        break;
      case 'end':
        end();
        break;
      default:
        msg satisfies never;
    }
  });
}

page.onMessage((command) => {
  switch (command.type) {
    case 'load':
      if (loadStarted) throw new Error('the page sent load twice');
      loadStarted = true;
      load(command.modelId, command.language).catch((err: unknown) => {
        trace(describeError(err));
        page.send({ type: 'error', text: describeError(err), fatal: true });
      });
      break;
    case 'audio-port':
      listen(command.port);
      break;
    case 'audio-end':
      endRecording?.();
      break;
    default:
      command satisfies never;
  }
});

self.addEventListener('error', (e) => {
  page.send({ type: 'error', text: `Worker error: ${e.message}. Reload the page`, fatal: true });
});
