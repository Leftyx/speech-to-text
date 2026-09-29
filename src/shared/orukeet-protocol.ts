/**
 * Messages between the main page and the sherpa-onnx engine worker
 * (`src/workers/orukeet`).
 */
import type { AudioEndCommand, AudioPortCommand } from './audio-protocol.ts';
import type { SpeechEvent } from './speech-protocol.ts';

/** Page → engine worker. `load` comes first, once. */
export type OrukeetCommand =
  /**
   * Load a model. `modelId` is the page's `?model=`, or null for the first one
   * listed. `language` is the page's `?lang=` ("it", for example), or empty to
   * let Whisper detect it. Only Whisper uses it.
   */
  | { readonly type: 'load'; readonly modelId: string | null; readonly language: string }
  | AudioPortCommand
  | AudioEndCommand;

/** Engine worker → page. */
export type OrukeetEvent =
  | SpeechEvent
  /**
   * The model is loaded and recording can start. `model` is its name, with a
   * note if the page asked for a model that is not in the list. `source` is
   * one sentence: did the model come from storage or from the server.
   */
  | { readonly type: 'ready'; readonly loadSecs: number; readonly model: string; readonly source: string };
