/**
 * The events that both speech workers send to their page. Each worker's own
 * protocol adds its `ready` event (and Parakeet its `backend` event).
 */

/** One transcribed piece of speech, as both pages show it. */
export interface TranscriptEntry {
  /** The recognised text. Empty when nothing was recognised. */
  readonly text: string;
  /** Length of the audio. */
  readonly speechSecs: number;
  /** Time the model took to transcribe it. */
  readonly tookSecs: number;
}

/** Speech worker → page: the events both workers send. */
export type SpeechEvent =
  /** A loading step, for the status line. */
  | { readonly type: 'status'; readonly text: string }
  /** The pause detector hears speech (true) or silence (false). */
  | { readonly type: 'speech'; readonly active: boolean }
  /** Phrases cut but not yet transcribed, including the one in progress. 0 when all are done. */
  | { readonly type: 'waiting'; readonly count: number }
  /** One phrase transcribed. */
  | ({ readonly type: 'result' } & TranscriptEntry)
  /**
   * Something failed. `fatal`: the worker cannot go on, so the page stops
   * recording and keeps the error on screen. Otherwise the page shows the
   * error in the transcript, in the place of what it cost, and goes on.
   */
  | { readonly type: 'error'; readonly text: string; readonly fatal: boolean };
