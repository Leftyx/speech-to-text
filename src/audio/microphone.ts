/**
 * Microphone capture, shared by both pages.
 * Records 16 kHz mono audio and sends it to whatever port it is given.
 */
import {
  MIC_PROCESSOR_NAME,
  type MicProcessorOptions,
  SAMPLE_RATE,
  type WorkletCommand,
  type WorkletReply,
} from '../shared/audio-protocol.ts';
import { TypedChannel } from '../shared/typed-channel.ts';
import processorUrl from './mic-processor.worklet.ts?worker&url';

/** How long `stop()` waits for the audio thread to send its last samples. */
const STOP_TIMEOUT_MS = 1000;

/** The audio graph of one recording. */
interface Session {
  readonly context: AudioContext;
  readonly stream: MediaStream;
  readonly node: AudioWorkletNode;
  readonly control: TypedChannel<WorkletCommand, WorkletReply>;
}

/** Records from the default microphone, one recording at a time. */
export class Microphone {
  #session: Session | undefined;

  /**
   * Asks for the microphone and starts recording.
   *
   * @param onLost - Called when the recording stops without `stop()`: the
   *   microphone was unplugged or its permission taken back, or the system
   *   closed the audio. Call `stop()` then, to release the rest.
   * @returns The port the audio arrives on, as `AudioPortMessage`s: audio
   *   chunks, then `end` after `stop()`. Transfer it to a speech worker. Audio
   *   waits in the port until the worker listens, so nothing is lost.
   * @throws If the user refuses the microphone, or the browser cannot record at 16 kHz.
   */
  async start(onLost: (reason: string) => void): Promise<MessagePort> {
    if (this.#session) throw new Error('already recording');
    // Browsers offer the microphone only to https and localhost pages.
    if (!('mediaDevices' in navigator)) {
      throw new DOMException('the browser offers no microphone to this page', 'SecurityError');
    }

    const stream = await navigator.mediaDevices.getUserMedia({
      // The browser's call processing (echo cancellation, noise removal) is
      // built for telephone speech and changes the sound in ways a speech
      // model never heard in training. Set both back to true if you work in
      // a noisy room and the text gets worse.
      audio: { channelCount: 1, echoCancellation: false, noiseSuppression: false },
    });
    let context: AudioContext | undefined;
    try {
      // Ask for 16 kHz, the rate these models were trained on. The browser
      // then does the rate conversion with a proper filter, and the worklet
      // only has to cut the audio into chunks. "playback" asks for large audio
      // buffers, so the audio thread wakes up less often and uses less
      // battery. Nothing here needs a short delay: each phrase waits for a pause.
      const audio = new AudioContext({ sampleRate: SAMPLE_RATE, latencyHint: 'playback' });
      context = audio;
      await audio.audioWorklet.addModule(processorUrl);
      const node = new AudioWorkletNode(audio, MIC_PROCESSOR_NAME, {
        numberOfInputs: 1,
        numberOfOutputs: 0,
        channelCount: 1,
        channelCountMode: 'explicit',
        processorOptions: { chunkMs: 100 } satisfies MicProcessorOptions,
      });
      const { port1: toWorklet, port2: fromWorklet } = new MessageChannel();
      const control = new TypedChannel<WorkletCommand, WorkletReply>(node.port);
      control.send({ type: 'connect', port: toWorklet }, [toWorklet]);
      audio.createMediaStreamSource(stream).connect(node);
      if (audio.state === 'suspended') await audio.resume();
      const session: Session = { context: audio, stream, node, control };
      this.#session = session;

      // Only a loss during this recording counts: stop() closes the audio too.
      const lost = (reason: string): void => {
        if (this.#session === session) onLost(reason);
      };
      for (const track of stream.getAudioTracks()) {
        track.addEventListener('ended', () => {
          lost('the microphone was unplugged, or its permission was taken back');
        });
      }
      audio.addEventListener('statechange', () => {
        if (audio.state === 'closed' || audio.state === 'interrupted') lost(`the system audio is ${audio.state}`);
      });
      return fromWorklet;
    } catch (err) {
      await release(stream, context);
      throw err;
    }
  }

  /**
   * Stops recording, after the last audio has been handed to the port.
   *
   * @returns False if the audio thread did not answer in time. The port then
   *   gets no `end`, and the last audio may be lost.
   */
  async stop(): Promise<boolean> {
    const session = this.#session;
    if (!session) return true;
    this.#session = undefined;

    const stopped = Promise.withResolvers<boolean>();
    // 'stopped' is the worklet's only reply.
    session.control.onMessage(() => {
      stopped.resolve(true);
    });
    session.control.send({ type: 'stop' });
    // The audio thread may already be gone. Do not wait for it forever.
    setTimeout(() => {
      stopped.resolve(false);
    }, STOP_TIMEOUT_MS);
    const answered = await stopped.promise;

    session.node.disconnect();
    await release(session.stream, session.context);
    return answered;
  }
}

/** Turns the microphone off and closes the audio graph. */
async function release(stream: MediaStream, context?: AudioContext): Promise<void> {
  for (const track of stream.getTracks()) track.stop();
  if (context && context.state !== 'closed') await context.close();
}
