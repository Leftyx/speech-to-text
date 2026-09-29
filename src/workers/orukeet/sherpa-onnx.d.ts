/**
 * Types for the sherpa-onnx browser engine: the globals that
 * `sherpa-onnx-asr.js`, `sherpa-onnx-vad.js` and the Emscripten main script
 * define when the engine worker loads them with importScripts().
 *
 * Only what the engine worker uses is declared.
 */

/** What the worker sets on `Module` before the engine script runs. */
interface EmscriptenModuleConfig {
  /** Resolves engine file names (the .wasm and .data files) to URLs. */
  locateFile?: (path: string, scriptDirectory: string) => string;
  /** The script each engine thread loads. By default, the script that loaded the engine. */
  mainScriptUrlOrBlob?: string | Blob;
  /** Loading progress, as text. Called with an empty string when done. */
  setStatus?: (text: string) => void;
  /** The engine stopped for good: out of memory, or a fatal error. */
  onAbort?: (what: unknown) => void;
  /** The engine is ready to use. */
  onRuntimeInitialized?: () => void;
}

/** `Module` once the engine runtime is up: the same object, with the runtime added. */
interface SherpaRuntime extends EmscriptenModuleConfig {
  /**
   * Writes a file into the engine's in-memory file system.
   * With `canOwn`, the engine takes `data` instead of copying it.
   */
  FS_createDataFile(
    parent: string, name: string, data: Uint8Array, canRead: boolean, canWrite: boolean, canOwn: boolean,
  ): void;
  FS_unlink(path: string): void;
}

/** Read by the Emscripten main script when it starts. */
declare var Module: EmscriptenModuleConfig | undefined;

/** The model settings of an offline recognizer: one model family, never two. */
type OfflineModelConfig = {
  tokens: string;
  numThreads: number;
  debug: 0 | 1;
} & (
  | { modelType: 'nemo_transducer'; transducer: { encoder: string; decoder: string; joiner: string } }
  | {
    whisper: {
      encoder: string;
      decoder: string;
      /** The spoken language ("it", for example). Empty: Whisper detects it itself. */
      language: string;
      task: 'transcribe' | 'translate';
      tailPaddings: number;
    };
  }
);

/** Configuration of an offline (whole-phrase) recognizer. */
interface OfflineRecognizerConfig {
  featConfig: { sampleRate: number; featureDim: number };
  modelConfig: OfflineModelConfig;
}

declare class OfflineStream {
  acceptWaveform(sampleRate: number, samples: Float32Array): void;
  free(): void;
}

declare class OfflineRecognizer {
  constructor(config: OfflineRecognizerConfig, module: SherpaRuntime);
  /** 0 when the model could not be loaded. */
  readonly handle: number;
  createStream(): OfflineStream;
  decode(stream: OfflineStream): void;
  getResult(stream: OfflineStream): { text?: string };
}

/** A ring buffer of samples inside the engine's memory. */
declare class CircularBuffer {
  constructor(capacity: number, module: SherpaRuntime);
  push(samples: Float32Array): void;
  get(startIndex: number, n: number): Float32Array;
  pop(n: number): void;
  size(): number;
  head(): number;
  reset(): void;
}

/** The pause detector. It cuts the audio it is given into speech segments. */
declare class Vad {
  readonly config: { sileroVad: { windowSize: number } };
  acceptWaveform(samples: Float32Array): void;
  /** Speech is being heard now. */
  isDetected(): boolean;
  /** No finished segment is waiting. */
  isEmpty(): boolean;
  front(): { samples: Float32Array };
  pop(): void;
  /** Ends the current segment, as if a pause had been heard. */
  flush(): void;
  reset(): void;
}

/** Settings of one pause detector model. */
interface VadModelConfig {
  model: string;
  threshold: number;
  minSilenceDuration: number;
  minSpeechDuration: number;
  maxSpeechDuration: number;
  windowSize: number;
}

/** Pause detector settings. Given to createVad, they replace all its defaults. */
interface VadConfig {
  sileroVad: VadModelConfig;
  tenVad: VadModelConfig;
  sampleRate: number;
  numThreads: number;
  provider: 'cpu';
  debug: 0 | 1;
  bufferSizeInSeconds: number;
}

/** Creates the pause detector. With no config, it uses its defaults, which print debug output. */
declare function createVad(module: SherpaRuntime, config?: VadConfig): Vad;
