/**
 * `<status-banner>`: the one-line status at the top of each page.
 *
 * Its starting text comes from the HTML. After `fail()`, the error stays on
 * screen: later `show()` calls are ignored, so a status message sent after a
 * failure cannot hide it. Style the error with `status-banner:state(error)`.
 */
export class StatusBanner extends HTMLElement {
  readonly #internals = this.attachInternals();

  constructor() {
    super();
    this.#internals.role = 'status';
  }

  /** True once `fail()` has been called. */
  get failed(): boolean {
    return this.#internals.states.has('error');
  }

  /** Shows a progress or state message, unless an error is showing. */
  show(text: string): void {
    if (!this.failed) this.textContent = text;
  }

  /** Shows an error for good, and logs it to the console. */
  fail(text: string): void {
    this.#internals.states.add('error');
    this.textContent = `${text.replace(/\.$/, '')}. Press F12 and read the Console tab for details.`;
    console.error(text);
  }
}

customElements.define('status-banner', StatusBanner);

declare global {
  interface HTMLElementTagNameMap {
    'status-banner': StatusBanner;
  }
}
