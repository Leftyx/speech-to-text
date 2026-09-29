/**
 * The main page: microphone → engine worker (sherpa-onnx) → one transcript
 * line per phrase. The engine cuts the speech at pauses by itself.
 */
import '../../ui/styles.css';
import type { OrukeetCommand, OrukeetEvent } from '../../shared/orukeet-protocol.ts';
import { parseSherpaModelList } from '../../shared/manifest.ts';
import { TypedChannel } from '../../shared/typed-channel.ts';
import { requiredById } from '../../ui/dom.ts';
import { connectRecording, enableOffline, fillPicker, findParts } from '../recording-page.ts';

const parts = findParts();
const { status, picker, controls } = parts;
const languageRow = requiredById('language-row', HTMLParagraphElement);
const languagePicker = requiredById('language', HTMLSelectElement);

const params = new URLSearchParams(location.search);
const chosenModel = params.get('model');

// Only a language in the list reaches Whisper. An unknown ?lang= selects no
// option, so the page falls back to "Detect".
languagePicker.value = params.get('lang') ?? '';
if (languagePicker.selectedIndex < 0) languagePicker.value = '';
const language = languagePicker.value;

await enableOffline();

// A classic worker, so it is not bundled by Vite's worker handling: the
// vite.config.ts plugin builds it into engine-worker.js at the site root.
const worker = new Worker(`${import.meta.env.BASE_URL}engine-worker.js`, { name: 'speech-engine' });
const engine = new TypedChannel<OrukeetCommand, OrukeetEvent>(worker);
const showSpeechEvent = connectRecording(parts, worker);

engine.onMessage((event) => {
  switch (event.type) {
    case 'ready':
      status.show(`Ready: ${event.model}. ${event.source} Loaded in ${event.loadSecs.toFixed(1)} s. Press Start and speak.`);
      controls.state = 'idle';
      break;
    default:
      showSpeechEvent(event);
  }
});

engine.send({ type: 'load', modelId: chosenModel, language });

// The model list is written by npm run assets. Changing model or language
// reloads the page: only one model fits in the engine's memory at a time, and
// the language is set when the model loads.
void fillPicker(picker, `${import.meta.env.BASE_URL}models/models.json`, (json) => {
  const models = parseSherpaModelList(json);
  // Only Whisper takes a language. The worker loads the first model when ?model= is unknown.
  const loaded = models.find((m) => m.id === chosenModel) ?? models[0];
  languageRow.hidden = loaded?.kind !== 'whisper';
  return models;
}, chosenModel ?? '');

picker.addEventListener('model-change', ({ detail: id }) => {
  params.set('model', id);
  location.search = params.toString();
});

languagePicker.addEventListener('change', () => {
  if (languagePicker.value) params.set('lang', languagePicker.value);
  else params.delete('lang');
  location.search = params.toString();
});
