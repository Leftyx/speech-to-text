/**
 * Typed messaging over anything with `postMessage`: a Worker from the page
 * side, the worker's own global scope from the inside, or a MessagePort.
 */

/** The part of Worker, DedicatedWorkerGlobalScope and MessagePort that we use. */
export interface MessageEndpoint {
  postMessage(message: unknown, transfer: Transferable[]): void;
  addEventListener(type: 'message' | 'messageerror', listener: (event: MessageEvent) => void): void;
  /** Only MessagePort has it, and it delivers nothing to listeners until it is called. */
  start?(): void;
}

/** A protocol message: a union of objects that each have a `type`. */
export interface Message {
  readonly type: string;
}

/**
 * One side of a typed conversation.
 *
 * @typeParam Send - The messages this side sends.
 * @typeParam Receive - The messages this side receives.
 */
export class TypedChannel<Send extends Message, Receive extends Message> {
  readonly #endpoint: MessageEndpoint;

  constructor(endpoint: MessageEndpoint) {
    this.#endpoint = endpoint;
  }

  /** Sends `message`. Buffers in `transfer` move to the other side instead of being copied. */
  send(message: Send, transfer: Transferable[] = []): void {
    this.#endpoint.postMessage(message, transfer);
  }

  /**
   * Calls `handler` for every message received. The data is not checked at
   * run time: both ends of a channel are our own code, built together.
   */
  onMessage(handler: (message: Receive) => void): void {
    this.#endpoint.addEventListener('message', (event: MessageEvent<Receive>) => {
      handler(event.data);
    });
    // A message that cannot be read on this side never reaches `handler`.
    this.#endpoint.addEventListener('messageerror', () => {
      console.error('A message could not be read, so it was lost.');
    });
    this.#endpoint.start?.();
  }
}
