import { SAMPLE_RATE } from '../../shared/audio-protocol.ts';
import type { SherpaModelEntry } from '../../shared/manifest.ts';

/** Engine threads per decode. */
const NUM_THREADS = 3;

/**
 * The recognizer configuration for a models.json entry.
 *
 * Every model file is written to the root of the engine's file system, so the
 * recognizer is given plain names such as `/encoder.onnx`.
 *
 * @param language - The spoken language for Whisper ("it", for example), or
 *   empty to let Whisper detect it. The transducer has no language setting.
 */
export function recognizerConfig(model: SherpaModelEntry, language: string): OfflineRecognizerConfig {
  const at = (name: string): string => `/${name}`;
  const common = { tokens: at(model.files.tokens), numThreads: NUM_THREADS, debug: 0 } as const;

  // Orukeet needs 128 mel bands, Whisper 80. The engine defaults to 80, so
  // the number always comes from the model list.
  const featConfig = { sampleRate: SAMPLE_RATE, featureDim: model.featureDim };

  switch (model.kind) {
    case 'whisper':
      return {
        featConfig,
        modelConfig: {
          ...common,
          whisper: {
            encoder: at(model.files.encoder),
            decoder: at(model.files.decoder),
            language,
            task: 'transcribe',
            tailPaddings: -1,
          },
        },
      };
    case 'transducer':
      return {
        featConfig,
        modelConfig: {
          ...common,
          modelType: 'nemo_transducer',
          transducer: {
            encoder: at(model.files.encoder),
            decoder: at(model.files.decoder),
            joiner: at(model.files.joiner),
          },
        },
      };
    default:
      return model satisfies never;
  }
}
