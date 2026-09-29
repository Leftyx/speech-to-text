import { describeError } from '../../shared/errors.ts';

/** The Emscripten main script. The two helper scripts before it define the JS API. */
const MAIN_SCRIPT = 'sherpa-onnx-wasm-main-vad-asr.js';
const SCRIPTS = ['sherpa-onnx-asr.js', 'sherpa-onnx-vad.js', MAIN_SCRIPT] as const;

/** The settings for {@link startEngine}. */
export interface EngineOptions {
  /** URL of the folder that holds the engine files. */
  readonly base: URL;
  /** Loading progress from the engine, as text. */
  readonly onStatus: (text: string) => void;
  /** The engine stopped after it had started. Before that, the returned Promise rejects instead. */
  readonly onAbort: (reason: string) => void;
}

/**
 * Loads and starts the sherpa-onnx engine in this worker.
 *
 * The engine is a classic Emscripten build: plain scripts that read their
 * settings from a global `Module` and define globals of their own. That is why
 * this worker is a classic worker, bundled as one script.
 *
 * @returns The engine runtime, once it is ready to use.
 * @throws If the engine scripts do not load.
 */
export function startEngine({ base, onStatus, onAbort }: EngineOptions): Promise<SherpaRuntime> {
  const { promise, resolve, reject } = Promise.withResolvers<SherpaRuntime>();
  let started = false;
  const fail = (what: unknown): void => {
    if (started) onAbort(`The engine stopped: ${describeError(what)}. Reload the page`);
    else reject(new Error(`${describeError(what)}; if the engine files are missing, run npm run assets`));
  };

  // The engine downloads its .data file in a promise that nothing waits for.
  // If that download fails, neither onAbort nor onRuntimeInitialized runs,
  // and only this event tells.
  self.addEventListener('unhandledrejection', (e) => {
    fail(e.reason);
  });

  const config: EmscriptenModuleConfig = {
    locateFile: (path) => new URL(path, base).href,
    // The engine runs on several threads, and starts each one as a worker
    // that loads this script. Left alone it would load the script that loaded
    // the engine, which is this worker: all of our code would run again in
    // every thread. Point the threads at the engine script itself.
    mainScriptUrlOrBlob: new URL(MAIN_SCRIPT, base).href,
    setStatus: (text) => {
      if (text) onStatus(text);
    },
    onAbort: fail,
    onRuntimeInitialized: () => {
      started = true;
      // Emscripten adds the runtime to the same object it was given.
      resolve(config as SherpaRuntime);
    },
  };

  self.Module = config;
  try {
    importScripts(...SCRIPTS.map((name) => new URL(name, base).href));
  } catch (err) {
    throw new Error(`its scripts did not load (${describeError(err)}); run npm run assets`, { cause: err });
  }
  return promise;
}
