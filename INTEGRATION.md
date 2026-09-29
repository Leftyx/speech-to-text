# TypeScript files for the jQuery integration

This document lists the browser TypeScript files that the jQuery application needs. It leaves out the user interface, the Node scripts and the Cloudflare server. A .NET server will replace the server parts.

## Which files you take depends on the model

The project has two models, Orukeet and Parakeet. Each one runs on its own speech engine (the code that turns audio into text), with its own files. Whisper runs on the Orukeet engine, for comparison only.

| Model | Engine | File sets to take |
| --- | --- | --- |
| Orukeet | sherpa-onnx | Common + Orukeet |
| Parakeet | parakeet.js | Common + Parakeet |
| Whisper (comparison only) | sherpa-onnx | Common + Orukeet |

If the manager picks one model, you take the common set and that model's set. The other set stays out.

## Common files

| File | What it does |
| --- | --- |
| `src/audio/microphone.ts` | Opens the microphone at 16 kHz and gives back the port that the audio arrives on. |
| `src/audio/mic-processor.worklet.ts` | Runs on the audio thread. Cuts the audio into 100 ms chunks. |
| `src/shared/audio-protocol.ts` | The audio messages, the sample rate, and the pause settings. |
| `src/shared/speech-protocol.ts` | The events that both workers send: status, speech, waiting, result, error. |
| `src/shared/typed-channel.ts` | Typed `postMessage` wrapper for every worker boundary. |
| `src/shared/manifest.ts` | Reads `models/models.json` and `models-parakeet/model.json`. |
| `src/shared/errors.ts` | Turns an error into a line of text. |
| `src/shared/trace.ts` | Logs each loading step with the elapsed time. |
| `src/workers/common/model-cache.ts` | Keeps the model in the browser Cache Storage, so it downloads once. |

## Orukeet files (sherpa-onnx engine)

| File | What it does |
| --- | --- |
| `src/shared/orukeet-protocol.ts` | The messages between the page and the engine worker. |
| `src/workers/orukeet/index.ts` | The worker entry. Loads the engine and the model, then transcribes. |
| `src/workers/orukeet/engine-loader.ts` | Starts the sherpa-onnx engine scripts. |
| `src/workers/orukeet/phrase-transcriber.ts` | Finds pauses and transcribes one phrase at a time. |
| `src/workers/orukeet/recognizer-config.ts` | The engine settings for a Whisper or a transducer model. |
| `src/workers/orukeet/sherpa-onnx.d.ts` | Types for the global names that the engine scripts define. |

This worker must stay a classic worker (a worker that loads scripts with `importScripts()`, not with `import`). The build bundles `src/workers/orukeet/index.ts` into one file, `engine-worker.js`. The `classicWorker` plugin in `vite.config.ts` does this.

## Parakeet files (parakeet.js engine)

| File | What it does |
| --- | --- |
| `src/shared/parakeet-protocol.ts` | The messages between the page and the Parakeet worker. |
| `src/workers/parakeet/index.ts` | The worker entry. Loads ONNX Runtime and the model, then transcribes. |
| `src/workers/parakeet/backend.ts` | Chooses the processor or the graphics card. The default is the processor. |
| `src/workers/parakeet/pause-detector.ts` | Finds pauses in speech with the Silero model. |

This engine needs two npm packages. The versions are in `package.json`:

- `parakeet.js`, pinned to a GitHub commit (1.4.9).
- `onnxruntime-web` 1.30.0, pinned in `overrides`.

## Files to rewrite for jQuery

`src/pages/recording-page.ts` mixes user interface code with logic that the jQuery page must keep. Do not copy it. Move this logic into the jQuery code:

1. Start: call `Microphone.start()`, then send the port to the worker with an `audio-port` command.
2. Stop: call `Microphone.stop()`. If it returns `false`, send `audio-end` to the worker.
3. Stop the recording after 30 seconds without speech. The clock runs only while no speech is heard and no phrase waits.
4. On a fatal `error` event, stop the recording and call `worker.terminate()`. The worker can hold up to 2 GB.
5. If the microphone does not start, show the advice from `microphoneAdvice()`.
6. If the application must work with no network, keep `enableOffline()` (see below).

`src/pages/orukeet/main.ts` and `src/pages/parakeet/main.ts` show how to create each worker and send the first `load` command. Use them as examples. Each one is about 45 lines.

## Optional file

`src/workers/offline/service-worker.ts` makes the site work with no network after one visit. If the jQuery application needs offline use, take this file. It must then store the files of the jQuery application too.

## Files to leave out

| File or folder | Reason |
| --- | --- |
| `src/ui/*.ts` (5 files) | User interface: status line, buttons, transcript list, model picker. |
| `src/ui/styles.css`, `index.html`, `parakeet.html` | User interface. |
| `src/pages/**` | Page wiring. Rewrite it for jQuery (see above). |
| `scripts/**` | Node tools: model download, test server, test runs. You can still use `npm run assets` to download the model files. |
| `cloudflare/**` | The Cloudflare server. The .NET server replaces it. |

## Code that depends on Vite

Some files use Vite features. If the jQuery application does not use Vite, you must replace them. The simplest path is to keep Vite as a build step that makes plain JavaScript files for the jQuery page.

| File | Vite feature |
| --- | --- |
| `src/audio/microphone.ts` | `import ... from './mic-processor.worklet.ts?worker&url'` |
| `src/workers/parakeet/index.ts` | `?url` import of the ONNX Runtime wasm file, and `import.meta.env.BASE_URL` |
| `src/pages/recording-page.ts` | `import.meta.env.PROD` and `import.meta.env.BASE_URL` |
| `vite.config.ts` | The `classicWorker` and `serviceWorker` plugins |

## What the .NET server must do

The server is not TypeScript, but the browser code fails without these rules:

- Send `Cross-Origin-Opener-Policy: same-origin` and `Cross-Origin-Embedder-Policy: require-corp` with every reply, errors included. The sherpa-onnx engine needs them for its threads.
- Serve the model files at the same paths as `assets/`: `engine/`, `models/` and `models-parakeet/`, relative to the site root.
- Answer `HEAD` requests on model files with `Content-Length`. The model cache uses it to check the file size.
- Answer a missing file with status 404, not with a page and status 200.
- Serve the site over HTTPS. Browsers give the microphone only to HTTPS pages and `localhost`.

The `require-corp` header also applies to jQuery and any other script from another server. Each one must send a `Cross-Origin-Resource-Policy` header or allow CORS, or the browser blocks it. The safest option is to serve jQuery from the same server.
