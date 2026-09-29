/**
 * Messages between the Parakeet page and its worker (`src/workers/parakeet`).
 */
import type { AudioEndCommand, AudioPortCommand } from './audio-protocol.ts';
import type { SpeechEvent } from './speech-protocol.ts';

/** Page → Parakeet worker. `load` comes first, once. */
export type ParakeetCommand =
  /** Load the model. `backend` is the page's `?backend=`, or null for the default. */
  | { readonly type: 'load'; readonly backend: string | null }
  | AudioPortCommand
  | AudioEndCommand;

/** Parakeet worker → page. */
export type ParakeetEvent =
  | SpeechEvent
  /** Which backend runs the model, in words, for the badge and the title. */
  | { readonly type: 'backend'; readonly text: string; readonly gpu: boolean }
  /**
   * The model is loaded and recording can start. `source` is one sentence:
   * did the model come from storage or from the server.
   */
  | { readonly type: 'ready'; readonly loadSecs: number; readonly source: string };
