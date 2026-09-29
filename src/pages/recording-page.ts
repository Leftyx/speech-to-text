/**
 * The page wiring that both pages share: the page parts, the model picker,
 * the Start and Stop buttons, and the events both speech workers send. Each
 * page's main.ts adds what is its own: its worker, its model list and its
 * `ready` text.
 */
import { Microphone } from "../audio/microphone.ts";
import type { AudioEndCommand, AudioPortCommand } from "../shared/audio-protocol.ts";
import { describeError } from "../shared/errors.ts";
import type { SpeechEvent } from "../shared/speech-protocol.ts";
import { TypedChannel } from "../shared/typed-channel.ts";
import { required, requiredById } from "../ui/dom.ts";
import "../ui/model-picker.ts";
import type { ModelChoice, ModelPicker } from "../ui/model-picker.ts";
import "../ui/record-controls.ts";
import type { RecordControls } from "../ui/record-controls.ts";
import "../ui/status-banner.ts";
import type { StatusBanner } from "../ui/status-banner.ts";
import "../ui/transcript-list.ts";
import type { TranscriptList } from "../ui/transcript-list.ts";

/** The elements both pages have. */
export interface PageParts {
  readonly status: StatusBanner;
  readonly picker: ModelPicker;
  readonly controls: RecordControls;
  readonly transcript: TranscriptList;
  /** How many phrases wait to be transcribed. */
  readonly waiting: HTMLParagraphElement;
}

/** Finds the elements both pages have. Throws if one is missing. */
export function findParts(): PageParts {
  return {
    status: required("status-banner"),
    picker: required("model-picker"),
    controls: required("record-controls"),
    transcript: required("transcript-list"),
    waiting: requiredById("waiting", HTMLParagraphElement),
  };
}

/**
 * Fills the model picker from the model list at `url`. If the list cannot be
 * read, the picker says so, and the speech worker reports the real error.
 *
 * @param toChoices - Checks the JSON and returns the models in it.
 * @param selected - The id to select. With none, or an unknown one, the first is selected.
 */
export async function fillPicker(
  picker: ModelPicker,
  url: string,
  toChoices: (json: unknown) => readonly ModelChoice[],
  selected = "",
): Promise<void> {
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    picker.setChoices(toChoices(await res.json()), selected);
  } catch (err) {
    picker.setUnavailable();
    console.error(`Could not read the model list ${url}:`, err);
  }
}

/**
 * Starts the service worker (src/workers/offline/service-worker.ts), so the
 * page opens and transcribes with no network. Only in the built site: the
 * dev server has no sw.js.
 *
 * Wait for it before the speech worker starts. The service worker stores only
 * the files that load after it runs, and the speech worker loads the engine.
 */
export async function enableOffline(): Promise<void> {
  if (!import.meta.env.PROD || !("serviceWorker" in navigator)) return;
  try {
    await navigator.serviceWorker.register(`${import.meta.env.BASE_URL}sw.js`);
    // A failed install never makes it ready. Then load the page without it.
    const timeout = new Promise<"timeout">((resolve) =>
      setTimeout(() => {
        resolve("timeout");
      }, 30_000),
    );
    if ((await Promise.race([navigator.serviceWorker.ready, timeout])) === "timeout") {
      console.warn("The service worker did not start in 30 s, so this visit is not stored for offline use.");
    }
  } catch (err) {
    console.warn("The service worker did not start, so the page does not work offline:", err);
  }
  // Without this, the browser can delete the stored model when the disk is low.
  try {
    const kept = await navigator.storage.persist();
    console.log(
      kept
        ? "Storage is persistent: the browser keeps the model."
        : "Storage is not persistent: the browser can delete the model when the disk is low.",
    );
  } catch (err) {
    console.warn("Could not ask for persistent storage:", err);
  }
}

/** With no speech for this long, the page stops recording, so the microphone is not left on. */
const SILENCE_STOP_MS = 30_000;

/** What to do when the microphone does not start, from the error's name. */
function microphoneAdvice(err: unknown): string {
  switch (err instanceof Error ? err.name : "") {
    case "NotAllowedError":
      return "Allow microphone access for this page, then press Start again.";
    case "SecurityError":
      return "Open the page over https or on localhost, then press Start again.";
    case "NotFoundError":
    case "OverconstrainedError":
      return "Connect a microphone, then press Start again.";
    case "NotReadableError":
    case "AbortError":
      return "Another program is using the microphone, or the system blocks it. Close that program, then press Start again.";
    case "NotSupportedError":
      return "This browser cannot record at 16 kHz. Use Edge or Chrome.";
    default:
      return "Press Start again. If it fails again, reload the page.";
  }
}

/**
 * Connects the Start and Stop buttons to the microphone and to `worker`, and
 * shows a crash of `worker` on the status line.
 *
 * @returns The handler for the events both speech workers send. Each page's
 *   message switch ends with it.
 */
export function connectRecording(parts: PageParts, worker: Worker): (event: SpeechEvent) => void {
  const { status, controls, transcript, waiting } = parts;
  const speech = new TypedChannel<AudioPortCommand | AudioEndCommand, never>(worker);
  const mic = new Microphone();

  let recording = false;
  /** The worker hears speech now. */
  let speaking = false;
  /** Phrases the worker has not transcribed yet. */
  let pending = 0;
  let silenceTimer: ReturnType<typeof setTimeout> | undefined;

  /**
   * Starts the silence clock again, or holds it. It runs only while nobody
   * speaks and no phrase waits. The worker reports speech late when it is
   * behind, so the clock waits until the worker has caught up.
   */
  const watchSilence = (): void => {
    clearTimeout(silenceTimer);
    if (!recording || speaking || pending > 0) return;
    silenceTimer = setTimeout(() => {
      void stop(`Stopped after ${SILENCE_STOP_MS / 1000} s without speech. Press Start to record again.`);
    }, SILENCE_STOP_MS);
  };

  /** Stops the recording, if one runs, and shows `message`. */
  const stop = async (message: string): Promise<void> => {
    recording = false;
    watchSilence();
    controls.state = "busy";
    controls.live = "";
    try {
      if (await mic.stop()) {
        status.show(message);
      } else {
        // The audio thread sent no `end`, so end the recording from here.
        speech.send({ type: "audio-end" });
        status.show(`${message} The audio system did not answer, so the last phrase may be lost.`);
      }
    } catch (err) {
      status.show(`The microphone did not stop cleanly: ${describeError(err)}. If Start does not work, reload the page.`);
    }
    controls.state = status.failed ? "waiting" : "idle";
  };

  /**
   * The worker cannot go on: stop recording, and keep the error on screen.
   * End the worker too. It can hold up to 2 GB, and only a reload uses it again.
   */
  const fail = (text: string): void => {
    status.fail(text);
    worker.terminate();
    void stop("");
  };

  worker.addEventListener("error", (e) => {
    fail(`Background worker failed: ${e.message || "its script did not load"}. Reload the page`);
  });

  controls.addEventListener("record-start", () => {
    void (async () => {
      controls.state = "busy";
      try {
        const port = await mic.start((reason) => {
          void stop(`The recording stopped: ${reason}. Press Start to record again.`);
        });
        speech.send({ type: "audio-port", port }, [port]);
      } catch (err) {
        await stop(`Microphone not available: ${describeError(err)}. ${microphoneAdvice(err)}`);
        return;
      }
      controls.state = "recording";
      recording = true;
      watchSilence();
      status.show("Listening. Each phrase is transcribed when you pause.");
    })();
  });

  controls.addEventListener("record-stop", () => {
    void stop("Stopped. Any remaining phrases will still appear below.");
  });

  return (event) => {
    switch (event.type) {
      case "status":
        status.show(event.text);
        break;
      case "speech":
        controls.live = event.active ? "Hearing speech…" : "";
        speaking = event.active;
        watchSilence();
        break;
      case "waiting":
        waiting.textContent = event.count > 0 ? `${event.count} phrase${event.count === 1 ? "" : "s"} waiting to be transcribed` : "";
        pending = event.count;
        watchSilence();
        break;
      case "result":
        transcript.add(event);
        break;
      case "error":
        if (event.fatal) {
          fail(event.text);
        } else {
          transcript.addError(event.text);
          console.error(event.text);
        }
        break;
      default:
        event satisfies never;
    }
  };
}
