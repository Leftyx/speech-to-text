/**
 * The first element with this tag name. A page calls this only for elements
 * its own HTML contains, so a missing one is a bug and throws. So does a
 * custom element whose file was not imported: it would be a plain element.
 */
export function required<K extends keyof HTMLElementTagNameMap>(tag: K): HTMLElementTagNameMap[K] {
  if (tag.includes('-') && !customElements.get(tag)) throw new Error(`<${tag}> is not defined: import its file from src/ui`);
  const el = document.querySelector(tag);
  if (!el) throw new Error(`the page has no <${tag}>`);
  return el;
}

/** The element with this id. Throws if it is missing or of another type. */
export function requiredById<T extends HTMLElement>(id: string, type: abstract new () => T): T {
  const el = document.getElementById(id);
  if (!(el instanceof type)) throw new Error(`the page has no ${type.name} #${id}`);
  return el;
}
