import { PAUSE_SETTINGS, SAMPLE_RATE } from '../../shared/audio-protocol.ts';
import { describeError } from '../../shared/errors.ts';
import type { SherpaModelEntry } from '../../shared/manifest.ts';
import type { SpeechEvent } from '../../shared/speech-protocol.ts';
import { secondsSince } from '../../shared/trace.ts';
import { recognizerConfig } from './recognizer-config.ts';

/** Seconds of audio the input buffer holds. */
const BUFFER_SECS = 30;

/** PAUSE_SETTINGS, under the names createVad uses. */
const PAUSES = {
  threshold: PAUSE_SETTINGS.threshold,
  minSilenceDuration: PAUSE_SETTINGS.minSilenceSecs,
  minSpeechDuration: PAUSE_SETTINGS.minSpeechSecs,
  maxSpeechDuration: PAUSE_SETTINGS.maxPhraseSecs,
};

/**
 * The sherpa-onnx createVad defaults (sherpa-onnx-vad.js), with debug off.
 * The defaults print the settings to the console as if they were an error.
 * createVad uses all or none of its defaults, so every setting is here.
 */
const VAD_CONFIG: VadConfig = {
  sileroVad: {
    model: './silero_vad.onnx', // from the engine's .data package
    ...PAUSES,
    windowSize: 512,
  },
  tenVad: {
    model: '',
    ...PAUSES,
    windowSize: 256,
  },
  sampleRate: SAMPLE_RATE,
  numThreads: 1,
  provider: 'cpu',
  debug: 0,
  bufferSizeInSeconds: 30,
};

/**
 * Cuts incoming audio into phrases at pauses, and transcribes the phrases in
 * order, one at a time.
 *
 * Nothing is dropped while a phrase is being decoded: audio that arrives
 * meanwhile waits in the worker's message queue, and finished phrases wait in
 * this object's queue.
 */
export class PhraseTranscriber {
  readonly #vad: Vad;
  readonly #buffer: CircularBuffer;
  readonly #recognizer: OfflineRecognizer;
  readonly #report: (event: SpeechEvent) => void;
  readonly #queue: Float32Array[] = [];
  #busy = false;
  #speaking = false;
  #lastWaiting = -1;

  /**
   * @param runtime - The started engine, with the model files already in its file system.
   * @param model - The models.json entry whose files are in the engine.
   * @param language - The spoken language for Whisper, or empty to detect it.
   * @param report - Receives the `speech`, `waiting`, `result` and `error` events.
   * @throws If the engine cannot load the model.
   */
  constructor(
    runtime: SherpaRuntime,
    model: SherpaModelEntry,
    language: string,
    report: (event: SpeechEvent) => void,
  ) {
    this.#vad = createVad(runtime, VAD_CONFIG);
    this.#buffer = new CircularBuffer(BUFFER_SECS * SAMPLE_RATE, runtime);
    this.#recognizer = new OfflineRecognizer(recognizerConfig(model, language), runtime);
    if (this.#recognizer.handle === 0) throw new Error('the model could not be loaded');
    this.#report = report;
  }

  /** Takes the next chunk of 16 kHz audio. */
  feed(samples: Float32Array): void {
    this.#buffer.push(samples);
    const window = this.#vad.config.sileroVad.windowSize;
    while (this.#buffer.size() > window) {
      this.#vad.acceptWaveform(this.#buffer.get(this.#buffer.head(), window));
      this.#buffer.pop(window);
    }
    this.#setSpeaking(this.#vad.isDetected());
    this.#collect();
  }

  /** Recording stopped: treat whatever was being said as a finished phrase. */
  finish(): void {
    this.#vad.flush();
    this.#collect();
    this.#vad.reset();
    this.#buffer.reset();
    this.#setSpeaking(false);
  }

  #setSpeaking(active: boolean): void {
    if (active === this.#speaking) return;
    this.#speaking = active;
    this.#report({ type: 'speech', active });
  }

  #reportWaiting(count: number): void {
    if (count === this.#lastWaiting) return;
    this.#lastWaiting = count;
    this.#report({ type: 'waiting', count });
  }

  /** Moves finished phrases from the pause detector to the queue, and starts decoding. */
  #collect(): void {
    while (!this.#vad.isEmpty()) {
      this.#queue.push(this.#vad.front().samples);
      this.#vad.pop();
    }
    this.#reportWaiting(this.#queue.length + (this.#busy ? 1 : 0));
    if (!this.#busy && this.#queue.length > 0) {
      this.#busy = true;
      this.#scheduleNext();
    }
  }

  // One phrase per task, so the audio messages that arrived meanwhile are
  // handled in between. Decoding is synchronous and blocks this worker.
  #scheduleNext(): void {
    setTimeout(() => {
      this.#transcribeNext();
    }, 0);
  }

  #transcribeNext(): void {
    const samples = this.#queue.shift();
    if (!samples) {
      this.#busy = false;
      this.#reportWaiting(0);
      return;
    }

    let stream: OfflineStream | undefined;
    try {
      const t0 = performance.now();
      stream = this.#recognizer.createStream();
      stream.acceptWaveform(SAMPLE_RATE, samples);
      this.#recognizer.decode(stream);
      this.#report({
        type: 'result',
        text: this.#recognizer.getResult(stream).text ?? '',
        speechSecs: samples.length / SAMPLE_RATE,
        tookSecs: secondsSince(t0),
      });
      this.#reportWaiting(this.#queue.length);
    } catch (err) {
      this.#report({
        type: 'error',
        text: `This phrase was not transcribed: ${describeError(err)}. The next phrases still are.`,
        fatal: false,
      });
    } finally {
      stream?.free();
    }
    this.#scheduleNext();
  }
}
