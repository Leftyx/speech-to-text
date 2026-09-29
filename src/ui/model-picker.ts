import { megabytes } from '../shared/trace.ts';

/** One choice in the picker. */
export interface ModelChoice {
  readonly id: string;
  readonly label: string;
  readonly bytes: number;
}

/**
 * `<model-picker>`: a labelled drop-down of the available models.
 *
 * It is disabled until `setChoices()` gives it at least two models.
 *
 * @fires model-change - The user chose another model. `detail` is its id.
 */
export class ModelPicker extends HTMLElement {
  readonly #select = document.createElement('select');
  readonly #label = document.createElement('label');

  constructor() {
    super();
    this.#select.id = 'model-picker-select';
    this.#select.disabled = true;
    this.#select.append(new Option('reading the model list…'));
    this.#label.htmlFor = this.#select.id;
    this.#label.textContent = 'Model';
    this.#select.addEventListener('change', () => {
      this.dispatchEvent(new CustomEvent<HTMLElementEventMap['model-change']['detail']>(
        'model-change',
        { bubbles: true, detail: this.#select.value },
      ));
    });
  }

  connectedCallback(): void {
    if (!this.#select.isConnected) this.replaceChildren(this.#label, this.#select);
  }

  /** Fills the list and selects `selected`. */
  setChoices(choices: readonly ModelChoice[], selected: string): void {
    this.#select.replaceChildren(...choices.map((c) =>
      new Option(`${c.label} — ${megabytes(c.bytes)}`, c.id, false, c.id === selected)));
    this.#select.disabled = choices.length < 2;
  }

  /** Shows that no list could be read. */
  setUnavailable(): void {
    this.#select.replaceChildren(new Option('no model list'));
    this.#select.disabled = true;
  }
}

customElements.define('model-picker', ModelPicker);

declare global {
  interface HTMLElementTagNameMap {
    'model-picker': ModelPicker;
  }
  interface HTMLElementEventMap {
    'model-change': CustomEvent<string>;
  }
}
