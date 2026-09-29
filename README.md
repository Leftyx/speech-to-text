# Browser speech-to-text test page

A web page that listens to the microphone, waits for each pause, and
transcribes that phrase. Everything runs in the browser, and no audio leaves
the machine.

Four models are available. On the main page, you choose one of the first
three at the top of the page. The fourth runs on a second page, `parakeet.html`,
described at the end of this file.

| Model | Size | Notes |
|---|---|---|
| Orukeet v0.1.0 | 671 MB | Parakeet TDT 0.6B v3, int8. The most accurate. |
| Whisper small | 375 MB | Multilingual, int8. Smallest download. |
| Whisper medium | 946 MB | Multilingual, int8. Slow, and close to the engine's memory limit. |
| Parakeet TDT 0.6B v3 (4-bit) | 409 MB | Second page only. 4-bit encoder, runs on the processor. |

Orukeet and Parakeet support 25 languages:

Bulgarian, Croatian, Czech, Danish, Dutch, English, Estonian, Finnish,
French, German, Greek, Hungarian, Italian, Latvian, Lithuanian, Maltese,
Polish, Portuguese, Romanian, Russian, Slovak, Slovenian, Spanish, Swedish,
Ukrainian.

Only one model is in memory at a time, so a change of model reloads the page.
The browser keeps the model you use in its Cache Storage, and it is
downloaded from the server only once. A change of model replaces that stored
copy.

One button starts and stops the recording. After 45 s without speech, the
page stops the recording by itself, so the microphone is not left on.

Each line shows the recognised text and how long it took, for example:
`3.2 s of speech, transcribed in 1.4 s`. If transcription is slower than you
speak, the page shows how many phrases are waiting. No phrase is dropped.

## What you need

- Windows, macOS or Linux (tested on Windows only). On macOS or Linux,
  `npm run transcribe` needs `BROWSER` set to the path of Chrome or Edge.
- Node.js 24 or newer (check with `node --version`). With fnm, the
  `.node-version` file in this folder selects it.
- About 6 GB of free disk space for all four models

## Set up (one time)

Open a terminal in this folder (on Windows, **PowerShell** or **Command
Prompt**) and run:

```
npm install
npm run assets
```

`npm install` gets the build tools and the two libraries of the second page
(parakeet.js and ONNX Runtime Web).

`npm run assets` downloads the ready-made sherpa-onnx browser engine, a small
pause-detection model, and all speech models into the `assets` folder. That
is about 3 GB of downloads. The engine is release 1.13.2, from the official
sherpa-onnx GitHub releases.

To get fewer models, name the ones you want:

```
npm run assets orukeet whisper-small
```

The names are `orukeet`, `whisper-small`, `whisper-medium` and
`parakeet`. The downloads are kept in `work`, so running this again does
not download again. If you do not need that, you can delete `work`.

## Run while you work on the code

```
npm run dev
```

Open http://localhost:5173 in Chrome or Edge, wait for "Ready", press
**Start**, and speak. Edits under `src` show up at once. Press Ctrl+C in the
window to stop the server.

The page shows "Page version 2026-09-29 (TypeScript, Vite)" under the title.
If it does not, you are looking at an older copy.

Before you share a change, run `npm run typecheck` and `npm run lint`.

## Build and run the finished site

```
npm run build
npm run preview
```

`npm run build` checks the types and writes the site code into `dist`.
`npm run preview` serves it on http://localhost:8000, with the engine and
model files from `assets`.

## Use it with no network

The finished site works with no network, after one visit online. This does
not work with `npm run dev`. The site must be on https or on localhost.

1. While online, open the main page and wait for "Ready".
2. If you use the second page, open `parakeet.html` too and wait for "Ready".

After that, both pages open and transcribe with no network. A service worker
(a background script of the site) stores the pages, their code and the
engine. Each page stores its own model, one model per page. On the main page,
you can use only the model that you loaded while online. To use another
model, choose it while online.

When the network is back, the pages get the newer files from the server.

When the disk is low, a phone can delete stored data. So the page asks the
browser to keep it. The Console tab (F12) shows the answer of the browser.

## Test the models with a WAV file

```
npm run transcribe -- recording.wav
npm run transcribe -- recording.wav orukeet parakeet
```

This plays the file into each model through a fake microphone. It prints
what each model heard and how long it took. With no model names, it
uses every model. The file plays in real time, so each model takes at least
the length of the file plus about 10 s. It needs Edge or Chrome.

## Host it elsewhere

Copy the contents of `dist` and of `assets` into the same folder on any web
server. The requirements:

- Serve it over HTTPS, or the browser blocks the microphone.
- Send these two headers with every file. The engine needs them to run on
  several threads:
  `Cross-Origin-Opener-Policy: same-origin` and
  `Cross-Origin-Embedder-Policy: require-corp`.
- Serve `.wasm` files as `application/wasm`.

## Put it on the internet (Cloudflare)

The site runs as the Cloudflare Worker `orukeet-web`, on its `workers.dev`
address. Everything stays in the Cloudflare free plan. Cloudflare serves
static files up to 25 MiB only. So the engine, the models and the ONNX
Runtime wasm go to the R2 bucket `orukeet-web-files`. The Worker serves them
from there.

### One time

1. Make the R2 bucket `orukeet-web-files`. Keep public access off.
2. Make an rclone remote named `r2` for that bucket (R2 API token with
   Object Read & Write). You need it for the files over 300 MB, because the
   dashboard does not accept them.
3. Run `npm run deploy`.
4. Turn on Cloudflare Access for the Worker's `workers.dev` address, and
   allow the email addresses of the testers.

### Upload the files to R2

The R2 name of each file is its path under `assets` (or under `dist` for the
wasm), with `/`.

| Local file | R2 name | Size | How |
|---|---|---|---|
| `assets/engine/` (all 5 files) | `engine/<file>` | up to 13 MB | Dashboard |
| `assets/models/models.json` | `models/models.json` | 1 KB | Dashboard |
| `assets/models/orukeet/decoder.onnx`, `joiner.onnx`, `tokens.txt` | `models/orukeet/<file>` | up to 12 MB | Dashboard |
| `assets/models/orukeet/encoder.onnx` | `models/orukeet/encoder.onnx` | 653 MB | rclone |
| `assets/models/whisper-small/` (all 3 files) | `models/whisper-small/<file>` | up to 262 MB | Dashboard |
| `assets/models/whisper-medium/tokens.txt` | `models/whisper-medium/tokens.txt` | 1 MB | Dashboard |
| `assets/models/whisper-medium/encoder.onnx`, `decoder.onnx` | `models/whisper-medium/<file>` | 374 MB, 571 MB | rclone |
| `assets/models-parakeet/model.json`, `decoder_joint-model.int8.onnx`, `vocab.txt`, `silero_vad.onnx` | `models-parakeet/<file>` | up to 18 MB | Dashboard |
| `assets/models-parakeet/encoder-model.onnx` | `models-parakeet/encoder-model.onnx` | 391 MB | rclone |
| `dist/app/ort-wasm-simd-threaded.asyncify-<code>.wasm` | `app/<same file name>` | 27 MB | Dashboard |

The rclone command for one file:

```
rclone copyto assets/models/orukeet/encoder.onnx r2:orukeet-web-files/models/orukeet/encoder.onnx
```

To upload all of `assets` in one command instead:
`rclone copy assets r2:orukeet-web-files`.

### After a change

- Code change: run `npm run deploy`.
- New model files: upload them again.
- New onnxruntime-web version: the wasm file gets a new name. Run
  `npm run deploy`, then upload the new wasm file. The second page does not
  load until you do.

## Files

| File | What it is |
|---|---|
| `index.html`, `src/pages/orukeet/` | The main test page |
| `parakeet.html`, `src/pages/parakeet/` | The second page |
| `src/workers/orukeet/` | Runs the sherpa-onnx engine in the background (Web Worker) |
| `src/workers/parakeet/` | Runs the second page's model in the background (Web Worker) |
| `src/workers/common/` | Keeps the models in browser storage, for both pages |
| `src/workers/offline/` | The service worker, which keeps the site files for use with no network |
| `src/audio/` | Microphone capture, used by both pages, and its AudioWorklet |
| `src/ui/` | The page parts (status line, buttons, transcript, model list) and the stylesheet |
| `src/shared/` | Message formats and model list formats, shared by pages, workers and scripts |
| `scripts/assets.ts` | Downloads the engine and the models into `assets` |
| `scripts/serve.ts` | Web server for the finished site |
| `vite.config.ts` | Build settings |
| `cloudflare/worker.ts`, `wrangler.jsonc` | The Cloudflare Worker and its settings |
| `cloudflare/cross-origin.ts` | The two cross-origin headers, for every server of the site |
| `assets/engine/` | The speech engine, and the pause detector packed into its `.data` file |
| `assets/models/` | The speech models, one folder each, and `models.json` |
| `assets/models-parakeet/` | The 4-bit model and the pause detector for the second page |

## If something goes wrong

- **The script cannot unpack an archive:** the built-in Windows `tar` command
  did not open the file. Delete that file under `work\models` and run
  `npm run assets` again.
- **Page says "Model failed to load", or stays on "Loading the model into
  memory":** press F12 and read the Console tab. Every step of the model
  loading prints there with the seconds it took. The engine can use 2 GB of
  memory at most, and Whisper medium is close to that limit. If the console
  shows an out-of-memory message, use a smaller model.
- **Nothing appears after speaking:** check the browser has microphone
  permission for the page, then pause for about one second after each
  phrase.
- **A red line in the transcript:** one phrase or one piece of audio failed,
  and the page went on. The line says what failed. A red status line at the
  top means the page cannot go on: reload it.

## The second page: Parakeet

`parakeet.html` is a separate experiment. It runs the same
Parakeet TDT v3 in 4-bit form, through
[parakeet.js](https://www.npmjs.com/package/parakeet.js) on ONNX Runtime Web.
It shares no speech engine code with the main page, so a problem in its
engine cannot affect the main page.

Differences from the main page:

- The model is 4-bit, about 410 MB instead of 671 MB.
- It runs on the processor (WebAssembly). This is the real test, because
  many phones have no WebGPU. To compare, open `parakeet.html?backend=webgpu`.
  If the browser offers WebGPU, the encoder then runs on the graphics card.
  The page shows which one it got.
- It has its own copy of the Silero pause detector
  (`assets/models-parakeet/silero_vad.onnx`), with the same settings as the main
  page. At each pause, it transcribes the phrase you just said.
- It keeps the model in the browser's Cache Storage, apart from the main
  page's model, so it is downloaded from the server only once.

4-bit weights save download size, and they can cost accuracy. On the
WebAssembly backend they can also be slower than 8-bit, because the weights
are unpacked during the calculation. The point of the page is to measure that
on your own machine.
