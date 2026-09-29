# CLAUDE.md

Browser speech-to-text test pages. All recognition runs in the browser. No audio leaves the machine. `README.md` is the user guide (setup, hosting, troubleshooting). This file covers what you need to change the code.

## Commands

Node 24+ (see `.node-version`). This machine uses fnm, and Node is not on the default PATH. In PowerShell, run this first:

```
fnm env --shell powershell | Out-String | Invoke-Expression
fnm use 24
```

- `npm run assets [orukeet] [whisper-small] [whisper-medium] [parakeet]`: download engine and models into `assets/` (no names = all). The engine is one sherpa-onnx release (1.13.2), pinned with its SHA-256 in `scripts/lib/catalogue.ts`.
- `npm run dev`: Vite dev server, http://localhost:5173.
- `npm run build`: `tsc -b`, then `vite build` into `dist/`.
- `npm run preview`: `scripts/serve.ts` serves `dist/` then `assets/` on port 8000.
- `npm run deploy`: build, then `wrangler deploy` to Cloudflare. It does not upload `assets/`: that goes to R2 by hand (README).
- `npm run transcribe -- <file>... [model ids]`: rebuilds, then plays each file as a fake microphone in headless Edge or Chrome (`scripts/lib/browser.ts`, DevTools protocol) and prints each model's transcript. A file that is not WAV is converted first. Real time: slow with many files or models. When the page shows an error, the run fails. An error line in the transcript counts too.
- `npm run typecheck`, `npm run lint`: both must pass. There are no unit tests.

Node runs `scripts/*.ts` directly (type stripping). So all code uses erasable syntax only: no enums, namespaces or parameter properties. Relative imports carry the `.ts` extension.

## Folders

- `src/`: all browser code. `index.html` and `parakeet.html` at the root are the Vite entries.
- `scripts/`: Node scripts (`assets.ts`, `serve.ts`, helpers in `scripts/lib/`).
- `assets/`: downloaded engine and model files. It is Vite's `publicDir` in dev, but `copyPublicDir` is off, so the build does not copy 2.4 GB. Git ignores it.
- `work/`: download cache for `npm run assets`. Git ignores it.
- `dist/`: build output. Bundled code goes to `dist/app/`, not `assets/`, so it stays apart from the downloaded files.
- `cloudflare/`: the Cloudflare Worker. `wrangler.jsonc` at the root configures it.

## TypeScript projects

`tsconfig.json` references six projects, because the DOM, WebWorker, AudioWorklet and Cloudflare Workers globals conflict:

- `tsconfig.app.json`: DOM. `src/pages`, `src/ui`, `src/audio/microphone.ts`.
- `tsconfig.worker.json`: WebWorker. `src/workers/parakeet`, `src/workers/common`, `src/workers/offline`.
- `tsconfig.engine.json`: WebWorker. `src/workers/orukeet`, `src/workers/common`. A project of its own, because `sherpa-onnx.d.ts` declares globals that the Parakeet worker does not have.
- `tsconfig.worklet.json`: `@types/audioworklet`. `src/audio/*.worklet.ts`.
- `tsconfig.node.json`: Node. `scripts`, the tool configs.
- `tsconfig.cloudflare.json`: `@cloudflare/workers-types`. `cloudflare`.

`src/shared/` is in the app and both worker projects, so it must use only APIs that exist in all of them. `audio-protocol.ts` and `typed-channel.ts` also run in the worklet, and `manifest.ts`, `trace.ts` and `errors.ts` also run in Node. TypeScript is pinned to 6.0, because typescript-eslint does not support 7 yet.

## Two independent pages

They share only `src/audio/`, `src/ui/`, `src/shared/`, `src/pages/recording-page.ts` and `src/workers/common/`.

Model storage: `src/workers/common/model-cache.ts` keeps each page's model in Cache Storage, one cache per page: `sherpa-model` (main page) and `parakeet-model` (Parakeet page). `localModel` does a `HEAD` size check per file, then takes the stored copy or downloads and stores the file. When the `HEAD` gets no answer (no network), it takes the stored copy without the check. Then it deletes the cache entries that the current model does not use, so each page keeps one model. It does this after it has all the files: a failed offline change of model must not delete the stored one. Every request there uses `cache: 'no-store'`, so the service worker does not store the model a second time. Keep the cache names, or every user downloads the model again.

### Orukeet page: `src/pages/orukeet/main.ts` + `src/workers/orukeet/` (sherpa-onnx)

Flow:

1. `Microphone.start()` (`src/audio/microphone.ts`) makes a 16 kHz `AudioContext`, so the browser resamples. It returns the port that audio arrives on.
2. `mic-processor.worklet.ts` cuts the audio into 100 ms chunks and transfers them to that port.
3. The page transfers the port to the worker (`audio-port` command).
4. `PhraseTranscriber` feeds the Silero VAD, queues finished phrases, and decodes one phrase per `setTimeout` task. Audio messages keep arriving between tasks.

Engine worker rules:

- It must stay a **classic** worker. The sherpa-onnx files are non-modular Emscripten scripts that load only through `importScripts()` and define globals (typed in `sherpa-onnx.d.ts`). Vite serves workers as modules in dev and has one worker format for the build. So the `classicWorker` plugin in `vite.config.ts` bundles `src/workers/orukeet/index.ts` separately, as one IIFE `engine-worker.js` at the site root. In dev it builds on request, and again after any file change.
- The page creates it by URL string (`${BASE_URL}engine-worker.js`), not with `new URL(..., import.meta.url)`.
- `engine-loader.ts` sets `Module.mainScriptUrlOrBlob` to the engine script, so engine threads (`em-pthread`) load only the engine, not our worker. It also sets `locateFile` to the site's `engine/` folder (`assets/engine/` on disk), and turns `onRuntimeInitialized` / `onAbort` into a Promise. It also listens for `unhandledrejection`: when the `.data` download fails, the engine calls neither of the two.
- Loading order in `index.ts`:
  1. Empty OPFS (`removeOldStorage`): earlier versions kept the model there. When all testers use the Cache Storage version, remove this step.
  2. Read `models.json`, then get the files through `localModel('sherpa-model', …)` and read each blob into a `Uint8Array`.
  3. `startEngine`, then `FS_createDataFile` with `canOwn`.
  4. Create the `PhraseTranscriber`.
  5. `FS_unlink` the files.
- `recognizerConfig()`: `whisper` or `transducer` (`nemo_transducer`). `featureDim` comes from `models.json` (Orukeet 128, Whisper 80, engine default 80).

### Parakeet page: `src/pages/parakeet/main.ts` + `src/workers/parakeet/` (parakeet.js)

- A module worker, found by Vite through `new URL('../../workers/parakeet/index.ts', import.meta.url)`.
- onnxruntime-web comes from npm. parakeet.js is pinned to a GitHub commit (1.4.9), because npm still has only 1.4.4. In 1.4.4, `decode()` deletes the space before a word that starts with an accented letter ("Roma è" → "Romaè"). PR #203 fixed this upstream. When a newer version appears on npm, go back to a normal version number. `package.json` `overrides` pins ort 1.30.0 (see the comment in `vite.config.ts`). The alias maps `onnxruntime-web` → `onnxruntime-web/webgpu`. ort is excluded from `optimizeDeps`.
- The default backend is `wasm` (`DEFAULT_BACKEND` in `backend.ts`). The processor is the real test, because the site is for phones, and many have no WebGPU. `?backend=webgpu` is for comparison, and runs `webgpu-hybrid`. In parakeet.js 1.4.9, plain `webgpu` gives the encoder no execution provider, so ort runs it on WebAssembly.
- The worker gives parakeet.js `cpuThreads` (half the cores, at most 4, the ort default). Without it, parakeet.js sets one ort thread per core. The pause detector uses the same ort instance, so it gets the same thread count.
- The worker imports ort with a dynamic `import()`, the same way parakeet.js does. This keeps ort in its own chunk: ort threads load their own module URL, and must not load the whole worker. The worker sets `ort.env.wasm.wasmPaths = { wasm: <?url import> }` before parakeet.js runs, and parakeet.js keeps a path that is already set.
- `pause-detector.ts` runs Silero (`models-parakeet/silero_vad.onnx`, copied there by `npm run assets`) on the same ort instance, on wasm. It uses the same `PAUSE_SETTINGS` (`src/shared/audio-protocol.ts`) as the engine's `createVad`. parakeet.js has no pause detector. Every model run (pause detector and Parakeet) goes through one promise queue in `index.ts`, so ort never runs two models at once. Stop (`end`) sends the phrase in progress.
- The encoder and decoder come from `localModel('parakeet-model', …)` (see model storage above). parakeet.js gets `blob:` URLs to the returned files, and the worker revokes them after the load.

## Messages

Every worker boundary is a discriminated union in `src/shared/`: `audio-protocol.ts`, `orukeet-protocol.ts` and `parakeet-protocol.ts`. Both worker event unions start from `SpeechEvent` (`speech-protocol.ts`), which holds the events both workers send. Each adds its own `ready`, and Parakeet adds `backend`. Both `ready` events carry `source`: one sentence that tells where the model came from (storage or the server). Send and receive through `TypedChannel<Send, Receive>` (`typed-channel.ts`), and handle messages with a `switch` that ends in `default: x satisfies never`. `connectRecording(parts, worker)` returns `showSpeechEvent`. A page's switch handles its own events, then ends in `default: showSpeechEvent(event)`: TypeScript narrows `event` to `SpeechEvent` there, and the switch in `showSpeechEvent` ends in `satisfies never`. Each worker's first command is `load` (model id or backend from the page URL), sent once. Workers do not read `location.search`.

- `error` carries `fatal`. Fatal: the page stops the recording, disables the button and keeps the error on the status line. It also ends the worker, which frees the memory of the worker at once. Not fatal (one phrase, or one audio chunk): the page adds a red line to the transcript and goes on.
- `audio-end` (page → worker) ends the current recording. When the worklet does not answer Stop within 1 s, the worker gets no `end`, so the page sends `audio-end` instead.

Workers resolve site paths against the site root: `import.meta.env.BASE_URL` in module code, and `self.location` in the engine worker (served at the root). `models.json` paths are relative to the site root.

## UI

Native custom elements in light DOM, one per file in `src/ui/`: `<status-banner>`, `<record-controls>`, `<transcript-list>`, `<model-picker>`. They augment `HTMLElementTagNameMap` / `HTMLElementEventMap`, so `required('record-controls')` and `addEventListener('record-start', …)` are typed.

- The ARIA role and states go through `ElementInternals`. The error state is styled with `status-banner:state(error)`.
- Children are created in the constructor and attached in `connectedCallback`.
- Components know nothing about workers. The page `main.ts` files and `src/pages/recording-page.ts` are the only wiring. `recording-page.ts` holds what both pages do the same way: `findParts()`, `fillPicker()`, and `connectRecording()` (the microphone, Start/Stop, sending the audio port, the worker `error` handler, and `showSpeechEvent`).
- `<record-controls>` has one button: Start, then Stop while recording. Its class (`start` or `stop`) gives the color, and `scripts/transcribe.ts` clicks it by that class.
- `connectRecording()` stops the recording after 30 s without speech (`SILENCE_STOP_MS`). The clock runs only while no speech is heard and no phrase waits, because a worker that is behind reports speech late.
- Styles are all in `src/ui/styles.css` (`@layer base, components, page`, native nesting).

## Serving

Every server must send `Cross-Origin-Opener-Policy: same-origin` and `Cross-Origin-Embedder-Policy: require-corp`. The engine needs `SharedArrayBuffer` for its threads. The pair is one constant, in `cloudflare/cross-origin.ts`. Vite dev sends it through `server.headers` and the `classicWorker` middleware. `scripts/lib/site-server.ts` and the Cloudflare Worker send it with every reply, errors included.

Offline: the built site works with no network after one online visit per page. The `serviceWorker` plugin in `vite.config.ts` bundles `src/workers/offline/service-worker.ts` into `sw.js` at the site root. It passes `__PRECACHE__`: the `.html`, `.js` and `.css` files of the build. Details:

- The service worker stores those files at install in the cache `site-files`. Keep the name.
- It answers every same-origin `GET` from the network first and stores the answer. With no network, it answers from the cache.
- It skips `cache: 'no-store'` requests: those are the model files.
- Pages are stored without `.html`, `index.html` and the query, because Cloudflare redirects `parakeet.html` to `parakeet`.
- `enableOffline()` in `recording-page.ts` registers it in the build only, and asks for persistent storage. Both pages await it before they create their speech worker, so the files that worker loads are stored on the first visit too.

Vite dev uses `appType: 'mpa'`. With the default (`spa`), a missing file got `index.html` with status 200, so a missing model looked like a broken one.

Cloudflare: one Worker on `workers.dev`, behind Cloudflare Access. Cloudflare serves `dist/` as static files, with the headers from `dist/_headers`. Any other path goes to `cloudflare/worker.ts`. It serves the file from the R2 bucket, under the same path. It answers `HEAD` with `Content-Length` for the size check. Static files must be 25 MiB or less, so `dist/.assetsignore` leaves out the ONNX Runtime wasm, and that file goes to R2 at `app/<name>`. The `cloudflareFiles` plugin in `vite.config.ts` writes `_headers` and `.assetsignore`.

## Conventions

- User-facing text and comments use short, plain English sentences. Comments explain _why_. Every exported item has TSDoc.
- Errors tell the user what to do next. Script failures throw `BuildError` (`scripts/lib/build-error.ts`). Only the script's top level sets the exit code.
- Workers log each loading step with elapsed seconds (`createTrace` in `src/shared/trace.ts`).
- The page version line in `index.html` ("Page version <date> (TypeScript, Vite)") is quoted in `README.md`. Update both together.

## Codebase intelligence

When working in this repo, prefer search_graph / codegraph context / fn_impact
over grep + reading whole files. Re-index after structural changes
(new files, renamed functions). The graph is faster and more accurate
than text search for "who calls X" and "what depends on Y" questions.
