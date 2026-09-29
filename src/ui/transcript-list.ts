import type { TranscriptEntry } from '../shared/speech-protocol.ts';

/**
 * `<transcript-list>`: the numbered list of transcribed phrases, each with
 * how long the speech was and how long it took to transcribe.
 */
export class TranscriptList extends HTMLElement {
  readonly #list = document.createElement('ol');

  constructor() {
    super();
    this.#list.ariaLabel = 'Transcript';
  }

  connectedCallback(): void {
    if (!this.#list.isConnected) this.replaceChildren(this.#list);
  }

  /** Adds one entry at the end and scrolls it into view. */
  add({ text, speechSecs, tookSecs }: TranscriptEntry): void {
    const words = document.createElement('span');
    words.textContent = text.trim() || '(nothing recognised)';
    const timing = document.createElement('small');
    timing.textContent = `${speechSecs.toFixed(1)} s of speech, transcribed in ${tookSecs.toFixed(1)} s`;

    const item = document.createElement('li');
    item.append(words, timing);
    this.#append(item);
  }

  /** Adds a failure at the end, in the place of the phrase it cost. */
  addError(text: string): void {
    const words = document.createElement('span');
    words.textContent = text;
    const item = document.createElement('li');
    item.className = 'error';
    item.append(words);
    this.#append(item);
  }

  #append(item: HTMLLIElement): void {
    this.#list.append(item);
    item.scrollIntoView({ block: 'nearest' });
  }
}

customElements.define('transcript-list', TranscriptList);

declare global {
  interface HTMLElementTagNameMap {
    'transcript-list': TranscriptList;
  }
}
