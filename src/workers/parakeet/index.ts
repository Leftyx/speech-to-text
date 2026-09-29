/**
 * Speech worker for the Parakeet page (module worker).
 *
 * Runs Parakeet TDT v3 in 4-bit form through parakeet.js and ONNX Runtime
 * Web. It has nothing to do with the engine worker: no sherpa-onnx. The
 * Silero pause detector cuts the audio into phrases, and each phrase is
 * transcribed when you pause.
 */
import { ParakeetModel } from 'parakeet.js';
import ortWasmUrl from 'onnxruntime-web/ort-wasm-simd-threaded.asyncify.wasm?url';
import { type AudioPortMessage, SAMPLE_RATE } from '../../shared/audio-protocol.ts';
import { describeError } from '../../shared/errors.ts';
import type { ParakeetCommand, ParakeetEvent } from '../../shared/parakeet-protocol.ts';
import { type ParakeetBackend, isParakeetBackend, parseParakeetModelSpec } from '../../shared/manifest.ts';
import { createTrace, megabytes, secondsSince } from '../../shared/trace.ts';
import { TypedChannel } from '../../shared/typed-channel.ts';
import { chooseBackend, describeBackend, wantsGpu } from './backend.ts';
import { localModel } from '../common/model-cache.ts';
import { PauseDetector } from './pause-detector.ts';

const page = new TypedChannel<ParakeetEvent, ParakeetCommand>(self);
const trace = createTrace('parakeet');

/** This page's model cache. Keep the name, or every user downloads the model again. */
const MODEL_CACHE = 'parakeet-model';

/**
 * Threads for ONNX Runtime: half the cores, at most 4, the ONNX Runtime
 * default. Without it, parakeet.js takes one thread per core. On a phone that
 * includes the slow power-saving cores, and the threads compete with the
 * audio thread and the page.
 */
const CPU_THREADS = Math.min(4, Math.ceil(navigator.hardwareConcurrency / 2));

/** What `load` makes. Recording needs all of it. */
interface Loaded {
  readonly model: ParakeetModel;
  readonly detector: PauseDetector;
  readonly backend: ParakeetBackend;
}

let loaded: Loaded | undefined;
/** Set once `load` arrives. A second `load` would load a second model over the first. */
let loadStarted = false;
/** Ends the recording in progress. Unset when none is. */
let endRecording: (() => void) | undefined;

/**
 * All model work, in order. ONNX Runtime then runs one model at a time, and
 * the audio reaches the pause detector in the order it was recorded.
 */
let queue: Promise<unknown> = Promise.resolve();
/** Phrases waiting or being transcribed. */
let waiting = 0;

/** Shows `text` on the page's status line. */
function showStatus(text: string): void {
  page.send({ type: 'status', text });
}

/** Reads model.json, points ONNX Runtime at its files, and loads the model. */
async function load(askedBackend: string | null): Promise<void> {
  const res = await fetch(`${import.meta.env.BASE_URL}models-parakeet/model.json`);
  if (!res.ok) throw new Error(`no model list (HTTP ${res.status}); run npm run assets parakeet`);
  const spec = parseParakeetModelSpec(await res.json());

  const backend = chooseBackend(askedBackend);
  trace(`backend: ${backend}`);
  const { text, gpu } = await describeBackend(backend);
  // A wrong ?backend= runs the default. Say so, or the page seems to ignore the link.
  const note = askedBackend === null || isParakeetBackend(askedBackend)
    ? ''
    : ` (the page asked for "${askedBackend}", which is not a backend)`;
  page.send({ type: 'backend', text: text + note, gpu });
  showStatus(`Loading ${spec.label} (${megabytes(spec.bytes)})…`);

  // parakeet.js imports ONNX Runtime with a dynamic import() and keeps any
  // wasm location set before it runs. Import it the same way here, so it
  // stays one separate chunk: its threads start by loading that chunk's own
  // URL, and must not load this whole worker.
  const ort = await import('onnxruntime-web/webgpu');
  ort.env.wasm.wasmPaths = { wasm: ortWasmUrl };
  trace('ONNX Runtime loaded');

  const t0 = performance.now();
  // model.json paths are relative to the site root, not to this worker's URL.
  const dir = import.meta.env.BASE_URL + spec.dir;
  const { files, source } = await localModel(MODEL_CACHE, [dir + spec.files.encoder, dir + spec.files.decoder], {
    log: trace,
    status: showStatus,
  });
  const [encoder, decoder] = files;
  if (!encoder || !decoder) throw new Error('the model files are missing');
  const encoderUrl = URL.createObjectURL(encoder);
  const decoderUrl = URL.createObjectURL(decoder);
  const model = await ParakeetModel.fromUrls({
    encoderUrl,
    decoderUrl,
    tokenizerUrl: dir + spec.files.tokenizer,
    backend,
    cpuThreads: CPU_THREADS,
    preprocessorBackend: 'js', // mel features in JavaScript, no extra model
    nMels: 128,
    subsampling: 8,
  }).finally(() => {
    URL.revokeObjectURL(encoderUrl);
    URL.revokeObjectURL(decoderUrl);
  });
  trace('the Parakeet model is ready');
  const detector = await PauseDetector.create(ort, `${dir}silero_vad.onnx`);
  trace('the pause detector is ready');
  loaded = { model, detector, backend };
  page.send({ type: 'ready', loadSecs: secondsSince(t0), source });
}

/** Adds `task` to the end of the model work. */
function enqueue(task: () => unknown): void {
  queue = queue.then(task).catch((err: unknown) => {
    page.send({
      type: 'error',
      text: `Pause detection failed: ${describeError(err)}. Press Stop, then Start.`,
      fatal: false,
    });
  });
}

function setWaiting(count: number): void {
  waiting = count;
  page.send({ type: 'waiting', count });
}

/** Queues each phrase for transcription, after the work already queued. */
function queuePhrases(from: Loaded, phrases: readonly Float32Array[]): void {
  for (const phrase of phrases) {
    setWaiting(waiting + 1);
    enqueue(() => transcribe(from, phrase));
  }
}

async function transcribe({ model, backend }: Loaded, phrase: Float32Array): Promise<void> {
  const t0 = performance.now();
  try {
    const out = await model.transcribe(phrase, SAMPLE_RATE, {});
    page.send({
      type: 'result',
      text: out.utterance_text,
      speechSecs: phrase.length / SAMPLE_RATE,
      tookSecs: secondsSince(t0),
    });
    if (out.metrics) console.log('[parakeet] metrics', out.metrics);
  } catch (err) {
    // A fault inside the graphics driver stops this model, not the page.
    const hint = wantsGpu(backend) && /webgpu|buffer|device|gpu/i.test(describeError(err))
      ? ' WebGPU failed here, so open this page as parakeet.html?backend=wasm to run on the processor instead.'
      : ' The next phrases still are.';
    page.send({ type: 'error', text: `This phrase was not transcribed: ${describeError(err)}.${hint}`, fatal: false });
  } finally {
    setWaiting(waiting - 1);
  }
}

/** Cuts one recording from its port into phrases at pauses, and transcribes each phrase. */
function record(port: MessagePort): void {
  const current = loaded;
  if (!current) {
    port.close();
    page.send({ type: 'error', text: 'The model is not loaded yet. Wait for "Ready", then press Start.', fatal: false });
    return;
  }
  const pauses = current.detector;
  let speaking = false;
  const setSpeaking = (active: boolean): void => {
    if (active === speaking) return;
    speaking = active;
    page.send({ type: 'speech', active });
  };

  // Whatever was being said when Stop was pressed is a phrase too.
  const end = (): void => {
    port.close();
    if (endRecording === end) endRecording = undefined;
    enqueue(() => {
      const last = pauses.finish();
      if (last) queuePhrases(current, [last]);
      setSpeaking(false);
    });
  };
  endRecording = end;

  new TypedChannel<never, AudioPortMessage>(port).onMessage((msg) => {
    switch (msg.type) {
      case 'audio':
        enqueue(async () => {
          queuePhrases(current, await pauses.feed(msg.samples));
          setSpeaking(pauses.speaking);
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
      load(command.backend).catch((err: unknown) => {
        page.send({ type: 'error', text: `Could not load the model: ${describeError(err)}`, fatal: true });
      });
      break;
    case 'audio-port':
      record(command.port);
      break;
    case 'audio-end':
      endRecording?.();
      break;
    default:
      command satisfies never;
  }
});

// A promise inside parakeet.js or ONNX Runtime can fail with nobody waiting
// for it. No other listener sees that, so tell the page.
self.addEventListener('unhandledrejection', (e) => {
  page.send({
    type: 'error',
    text: `Background failure: ${describeError(e.reason)}. If the page stops working, reload it.`,
    fatal: false,
  });
});
