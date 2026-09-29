/**
 * AudioWorklet: runs on the browser's audio thread.
 *
 * The AudioContext already runs at 16 kHz (see `microphone.ts`), so the
 * browser has done the rate conversion. This processor only collects the
 * samples into chunks and sends each chunk straight to the speech worker,
 * through the port the page gives it.
 */
import {
  type AudioPortMessage,
  MIC_PROCESSOR_NAME,
  type MicProcessorOptions,
  SAMPLE_RATE,
  type WorkletCommand,
  type WorkletReply,
} from '../shared/audio-protocol.ts';
import { TypedChannel } from '../shared/typed-channel.ts';

class MicProcessor extends AudioWorkletProcessor implements AudioWorkletProcessorImpl {
  readonly #chunkSize: number;
  readonly #page = new TypedChannel<WorkletReply, WorkletCommand>(this.port);
  #chunk: Float32Array<ArrayBuffer>;
  #fill = 0;
  #out: MessagePort | null = null;
  #stopped = false;

  constructor({ processorOptions: { chunkMs } }: { processorOptions: MicProcessorOptions }) {
    super();
    this.#chunkSize = Math.round((SAMPLE_RATE * chunkMs) / 1000);
    this.#chunk = new Float32Array(this.#chunkSize);
    this.#page.onMessage((command) => {
      this.#handle(command);
    });
  }

  #handle(command: WorkletCommand): void {
    switch (command.type) {
      case 'connect':
        this.#out = command.port;
        break;
      case 'stop':
        this.#flush();
        this.#send({ type: 'end' });
        this.#out?.close();
        this.#out = null;
        this.#stopped = true;
        this.#page.send({ type: 'stopped' });
        break;
      default:
        command satisfies never;
    }
  }

  /** Returning false lets the browser drop this processor once recording stops. */
  process(inputs: Float32Array[][]): boolean {
    if (this.#stopped) return false;
    const channel = inputs[0]?.[0];
    if (!channel) return true;

    let read = 0;
    while (read < channel.length) {
      const take = Math.min(channel.length - read, this.#chunkSize - this.#fill);
      this.#chunk.set(channel.subarray(read, read + take), this.#fill);
      this.#fill += take;
      read += take;
      if (this.#fill === this.#chunkSize) this.#flush();
    }
    return true;
  }

  /** Sends what has been collected. A full chunk is transferred, a partial one copied. */
  #flush(): void {
    if (this.#fill === 0) return;
    const full = this.#fill === this.#chunkSize;
    const samples = full ? this.#chunk : this.#chunk.slice(0, this.#fill);
    this.#send({ type: 'audio', samples }, [samples.buffer]);
    if (full) this.#chunk = new Float32Array(this.#chunkSize);
    this.#fill = 0;
  }

  #send(message: AudioPortMessage, transfer: Transferable[] = []): void {
    this.#out?.postMessage(message, transfer);
  }
}

registerProcessor(MIC_PROCESSOR_NAME, MicProcessor);
