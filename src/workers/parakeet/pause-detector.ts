/**
 * The Silero pause detector for the Parakeet worker. The main page runs the same
 * model inside sherpa-onnx. parakeet.js has no pause detector, so this runs
 * the model on ONNX Runtime directly.
 */
import type * as Ort from 'onnxruntime-web/webgpu';
import { PAUSE_SETTINGS, SAMPLE_RATE } from '../../shared/audio-protocol.ts';

/** Samples per model run: 32 ms at 16 kHz. */
const WINDOW = 512;

/** The number of windows in `secs` seconds. */
const windows = (secs: number): number => Math.round((secs * SAMPLE_RATE) / WINDOW);

const THRESHOLD = PAUSE_SETTINGS.threshold;
const MIN_SILENCE = windows(PAUSE_SETTINGS.minSilenceSecs);
const MIN_SPEECH = windows(PAUSE_SETTINGS.minSpeechSecs);
const MAX_PHRASE = windows(PAUSE_SETTINGS.maxPhraseSecs);
/** Silence kept before and after the speech, so the first and last sounds are not cut. */
const PAD = windows(0.2);

/** Cuts 16 kHz audio into phrases at pauses. */
export class PauseDetector {
  readonly #ort: typeof Ort;
  readonly #session: Ort.InferenceSession;
  /** The model's memory between windows. */
  #h: Ort.Tensor;
  #c: Ort.Tensor;
  /** Samples left over, fewer than one window. */
  #rest = new Float32Array(0);
  /** Before speech: the last PAD windows. During speech: the phrase so far. */
  #windows: Float32Array[] = [];
  #speaking = false;
  /** Windows with speech in the current phrase. */
  #speech = 0;
  /** Windows without speech since the last speech. */
  #silence = 0;

  /** Use {@link PauseDetector.create}. */
  private constructor(ort: typeof Ort, session: Ort.InferenceSession) {
    this.#ort = ort;
    this.#session = session;
    this.#h = this.#zeroState();
    this.#c = this.#zeroState();
  }

  /**
   * Loads the model from `url`.
   * @param ort - The ONNX Runtime module that parakeet.js also uses.
   * @throws If the file is missing or the model does not load.
   */
  static async create(ort: typeof Ort, url: string): Promise<PauseDetector> {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`no pause detector (HTTP ${res.status}); run npm run assets parakeet`);
    // The model is 0.6 MB, so the processor is fast enough, on any backend.
    const session = await ort.InferenceSession.create(new Uint8Array(await res.arrayBuffer()), {
      executionProviders: ['wasm'],
    });
    return new PauseDetector(ort, session);
  }

  /** True while someone is speaking. */
  get speaking(): boolean {
    return this.#speaking;
  }

  /** Takes the next chunk of audio, and returns the phrases that ended in it. */
  async feed(samples: Float32Array): Promise<Float32Array[]> {
    const audio = join([this.#rest, samples]);
    const phrases: Float32Array[] = [];
    let at = 0;
    for (; at + WINDOW <= audio.length; at += WINDOW) {
      const window = audio.slice(at, at + WINDOW);
      const phrase = this.#step(window, await this.#probability(window));
      if (phrase) phrases.push(phrase);
    }
    this.#rest = audio.slice(at);
    return phrases;
  }

  /** Recording stopped: returns the phrase in progress, if any, and starts again from zero. */
  finish(): Float32Array | undefined {
    const phrase = this.#speaking ? this.#end() : undefined;
    this.#h = this.#zeroState();
    this.#c = this.#zeroState();
    this.#rest = new Float32Array(0);
    this.#windows = [];
    return phrase;
  }

  /** Adds one window, and returns a phrase if one is complete. */
  #step(window: Float32Array, probability: number): Float32Array | undefined {
    const voiced = probability > THRESHOLD;
    this.#windows.push(window);
    if (!this.#speaking) {
      if (voiced) {
        this.#speaking = true;
        this.#speech = 1;
        this.#silence = 0;
      } else if (this.#windows.length > PAD) {
        this.#windows.shift();
      }
      return undefined;
    }

    if (voiced) {
      this.#speech++;
      this.#silence = 0;
    } else {
      this.#silence++;
    }
    if (this.#silence >= MIN_SILENCE) return this.#end();
    if (this.#windows.length >= MAX_PHRASE) {
      // Long speech with no pause: send it in parts.
      const phrase = join(this.#windows);
      this.#windows = [];
      this.#speech = 0;
      return phrase;
    }
    return undefined;
  }

  /** Ends the phrase. Returns it, or nothing if it had too little speech. */
  #end(): Float32Array | undefined {
    // Keep PAD windows of the silence at the end. The last PAD windows are
    // also the start of the next phrase.
    const keep = Math.max(0, this.#windows.length - Math.max(0, this.#silence - PAD));
    const phrase = this.#speech >= MIN_SPEECH ? join(this.#windows.slice(0, keep)) : undefined;
    this.#windows = this.#windows.slice(-PAD);
    this.#speaking = false;
    this.#speech = 0;
    this.#silence = 0;
    return phrase;
  }

  /** Runs the model on one window: the chance that it holds speech, 0 to 1. */
  async #probability(window: Float32Array): Promise<number> {
    const out = await this.#session.run({
      x: new this.#ort.Tensor('float32', window, [1, WINDOW]),
      h: this.#h,
      c: this.#c,
    });
    this.#h = output(out, 'new_h');
    this.#c = output(out, 'new_c');
    return Number(output(out, 'prob').data[0]);
  }

  #zeroState(): Ort.Tensor {
    return new this.#ort.Tensor('float32', new Float32Array(2 * 64), [2, 1, 64]);
  }
}

function output(out: Ort.InferenceSession.OnnxValueMapType, name: string): Ort.Tensor {
  const value = out[name];
  if (!value) throw new Error(`the pause detector gave no ${name}`);
  return value;
}

/** The parts as one array. */
function join(parts: readonly Float32Array[]): Float32Array {
  const all = new Float32Array(parts.reduce((sum, p) => sum + p.length, 0));
  let at = 0;
  for (const part of parts) {
    all.set(part, at);
    at += part.length;
  }
  return all;
}
