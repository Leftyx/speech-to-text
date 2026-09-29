/**
 * the Parakeet page: microphone → Parakeet worker → one transcript line per phrase.
 * The worker cuts the speech at pauses.
 */
import '../../ui/styles.css';
import type { ParakeetCommand, ParakeetEvent } from '../../shared/parakeet-protocol.ts';
import { parseParakeetModelSpec } from '../../shared/manifest.ts';
import { TypedChannel } from '../../shared/typed-channel.ts';
import { requiredById } from '../../ui/dom.ts';
import { connectRecording, enableOffline, fillPicker, findParts } from '../recording-page.ts';

const parts = findParts();
const { status, picker, controls } = parts;
const badge = requiredById('backend', HTMLElement);
const heading = requiredById('heading', HTMLHeadingElement);

await enableOffline();

const worker = new Worker(new URL('../../workers/parakeet/index.ts', import.meta.url), { type: 'module', name: 'parakeet' });
const speech = new TypedChannel<ParakeetCommand, ParakeetEvent>(worker);
const showSpeechEvent = connectRecording(parts, worker);

speech.onMessage((event) => {
  switch (event.type) {
    case 'backend': {
      // The page runs on either backend, so the title says which one it got.
      badge.textContent = `backend: ${event.text}`;
      const on = event.gpu ? 'WebGPU' : 'the processor';
      heading.textContent = `Parakeet on ${on}`;
      document.title = `Parakeet on ${on} — test page`;
      break;
    }
    case 'ready':
      status.show(`Ready. ${event.source} Loaded in ${event.loadSecs.toFixed(1)} s. Press Start and speak.`);
      controls.state = 'idle';
      break;
    default:
      showSpeechEvent(event);
  }
});

speech.send({ type: 'load', backend: new URLSearchParams(location.search).get('backend') });

// This page has one model. The picker shows its name and size, and stays
// disabled because there is nothing to choose.
void fillPicker(picker, `${import.meta.env.BASE_URL}models-parakeet/model.json`, (json) => [parseParakeetModelSpec(json)]);
