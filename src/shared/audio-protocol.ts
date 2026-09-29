/**
 * Messages between the page, the microphone AudioWorklet and a speech worker.
 *
 * The page creates a MessageChannel per recording. One end goes to the
 * worklet, the other to the speech worker, so audio flows from the audio
 * thread to the worker without passing through the page.
 */

/** The rate every model here was trained on. */
export const SAMPLE_RATE = 16_000;

/**
 * Where both pages cut speech into phrases: the sherpa-onnx createVad
 * defaults, with a longer pause. the Parakeet page is there to compare with
 * the main page, so both pause detectors read these values.
 */
export const PAUSE_SETTINGS = {
  /** Audio is speech when the pause detector gives a speech chance above this (0 to 1). */
  threshold: 0.5,
  /**
   * Silence that ends a phrase. The default is 0.5 s. Longer phrases give
   * Parakeet more sound to find the language from, so it guesses English less.
   */
  minSilenceSecs: 0.7,
  /** A phrase with less speech than this is dropped. */
  minSpeechSecs: 0.25,
  /** Longer speech with no pause is sent in parts of this length. */
  maxPhraseSecs: 20,
} as const;

/** The name the worklet registers its processor under. */
export const MIC_PROCESSOR_NAME = 'mic-processor';

/** Worklet → speech worker, over the recording's MessageChannel. */
export type AudioPortMessage =
  /** 16 kHz mono samples. The buffer is transferred, not copied. */
  | { readonly type: 'audio'; readonly samples: Float32Array<ArrayBuffer> }
  /** The recording stopped. Everything recorded has been sent before this. */
  | { readonly type: 'end' };

/** Page → worklet, over the AudioWorkletNode port. */
export type WorkletCommand =
  | { readonly type: 'connect'; readonly port: MessagePort }
  | { readonly type: 'stop' };

/** Worklet → page, over the AudioWorkletNode port. */
export interface WorkletReply {
  readonly type: 'stopped';
}

/** The `processorOptions` the worklet is created with. */
export interface MicProcessorOptions {
  /** Length of each audio message. */
  readonly chunkMs: number;
}

/** Page → speech worker: the worker end of a new recording's MessageChannel. */
export interface AudioPortCommand {
  readonly type: 'audio-port';
  readonly port: MessagePort;
}

/**
 * Page → speech worker: end the current recording now. The page sends it
 * when the audio thread did not answer Stop, so the worklet sent no `end`.
 */
export interface AudioEndCommand {
  readonly type: 'audio-end';
}
