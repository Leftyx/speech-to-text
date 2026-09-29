/**
 * `<record-controls>`: one Start/Stop button, and a short live message beside
 * it ("Hearing speech…").
 *
 * The element only reports clicks. The page decides what they do and sets
 * `state` to match.
 *
 * @fires record-start - The button was pressed while it said Start.
 * @fires record-stop - The button was pressed while it said Stop.
 */
export class RecordControls extends HTMLElement {
  readonly #button = document.createElement('button');
  readonly #live = document.createElement('span');
  #state: RecordState = 'waiting';

  constructor() {
    super();
    this.#button.type = 'button';
    this.#live.className = 'live';
    this.#live.ariaLive = 'polite';
    this.#button.addEventListener('click', () => {
      const type = this.#state === 'recording' ? 'record-stop' : 'record-start';
      this.dispatchEvent(new Event(type, { bubbles: true }));
    });
    this.#render();
  }

  connectedCallback(): void {
    if (!this.#button.isConnected) this.replaceChildren(this.#button, this.#live);
  }

  /** What the button says, and whether it can be pressed. */
  set state(value: RecordState) {
    this.#state = value;
    this.#render();
  }

  /** The live message. Empty hides it. */
  set live(text: string) {
    this.#live.textContent = text;
  }

  #render(): void {
    const recording = this.#state === 'recording';
    // The class gives the color. scripts/transcribe.ts also finds the button by it.
    this.#button.className = recording ? 'stop' : 'start';
    this.#button.textContent = recording ? 'Stop' : 'Start';
    this.#button.disabled = this.#state !== 'idle' && !recording;
  }
}

/**
 * - `waiting`: the button cannot be pressed (the model is loading, or failed).
 * - `idle`: the button says Start.
 * - `recording`: the button says Stop.
 * - `busy`: the button cannot be pressed (the microphone is starting or stopping).
 */
export type RecordState = 'waiting' | 'idle' | 'recording' | 'busy';

customElements.define('record-controls', RecordControls);

declare global {
  interface HTMLElementTagNameMap {
    'record-controls': RecordControls;
  }
  interface HTMLElementEventMap {
    'record-start': Event;
    'record-stop': Event;
  }
}
