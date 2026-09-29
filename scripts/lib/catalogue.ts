/**
 * Everything `npm run assets` downloads: the sherpa-onnx engine, the pause
 * detector, the speech models, and the Parakeet model of the second page.
 */
import type {
  ParakeetModelSpec,
  SherpaFileRole,
  TransducerModelEntry,
  WhisperModelEntry,
} from '../../src/shared/manifest.ts';

/** Ready-made sherpa-onnx browser engine, from the official GitHub releases. */
export const ENGINE = {
  /**
   * One release, checked by its SHA-256: the page is written against this
   * engine's JavaScript API, and the script runs part of its code. To move to
   * a newer release, change both, then test every model.
   */
  from: 'https://github.com/k2-fsa/sherpa-onnx/releases/download/v1.13.2/'
    + 'sherpa-onnx-wasm-simd-1.13.2-vad-asr-moonshine-v2-tiny-en.tar.bz2',
  sha256: 'e8d3b69f5d109fb399dabcab7c378314377c310589281a38c630b751a11aa31a',
  /** The Emscripten main script. Its file list is patched to hold only the pause detector. */
  mainJs: 'sherpa-onnx-wasm-main-vad-asr.js',
  files: [
    'sherpa-onnx-wasm-main-vad-asr.js',
    'sherpa-onnx-wasm-main-vad-asr.wasm',
    'sherpa-onnx-asr.js',
    'sherpa-onnx-vad.js',
  ],
  dataName: 'sherpa-onnx-wasm-main-vad-asr.data',
} as const;

const RELEASE = 'https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/';

/**
 * The Silero pause detector, packed into the engine's `.data` file, and
 * copied to models-parakeet/ for the Parakeet page.
 */
export const VAD_URL = `${RELEASE}silero_vad.onnx`;

interface CatalogueBase {
  id: string;
  label: string;
  featureDim: number;
  /** URL of the .tar.bz2 archive. */
  from: string;
  /** Checked after download when given. */
  sha256?: string;
}

/**
 * One speech model the main page can use. `pick` says which file inside the
 * unpacked archive becomes which file in the site, and must name every file
 * of its kind. Only int8 weights are kept.
 */
export type CatalogueEntry =
  | (CatalogueBase & { kind: 'transducer'; pick: Record<keyof TransducerModelEntry['files'], RegExp> })
  | (CatalogueBase & { kind: 'whisper'; pick: Record<keyof WhisperModelEntry['files'], RegExp> });

/** The speech models of the main page. The first one is the default. */
export const CATALOGUE: readonly CatalogueEntry[] = [
  {
    id: 'orukeet',
    label: 'Orukeet v0.1.0 (Parakeet TDT 0.6B v3, int8)',
    kind: 'transducer',
    featureDim: 128, // this encoder takes 128 mel bands, not the usual 80
    from: 'https://huggingface.co/oruk/orukeet/resolve/'
      + '55a984d46f68323301837194ce647c702f55facc/onnx/sherpa-onnx-orukeet-v0.1.0-int8.tar.bz2',
    sha256: 'f9191f30178cc9122ce2f023bf9fefafc822028307b0efa4caff645ba3fe8d0a',
    pick: {
      encoder: /^encoder.*\.onnx$/,
      decoder: /^decoder.*\.onnx$/,
      joiner: /^joiner.*\.onnx$/,
      tokens: /^tokens\.txt$/,
    },
  },
  {
    id: 'whisper-small',
    label: 'Whisper small (multilingual, int8)',
    kind: 'whisper',
    featureDim: 80,
    from: `${RELEASE}sherpa-onnx-whisper-small.tar.bz2`,
    pick: {
      encoder: /^small-encoder\.int8\.onnx$/,
      decoder: /^small-decoder\.int8\.onnx$/,
      tokens: /^small-tokens\.txt$/,
    },
  },
  {
    id: 'whisper-medium',
    label: 'Whisper medium (multilingual, int8)',
    kind: 'whisper',
    featureDim: 80,
    from: `${RELEASE}sherpa-onnx-whisper-medium.tar.bz2`,
    pick: {
      encoder: /^medium-encoder\.int8\.onnx$/,
      decoder: /^medium-decoder\.int8\.onnx$/,
      tokens: /^medium-tokens\.txt$/,
    },
  },
];

/** The name each model file gets in the site, whatever it was called in the archive. */
export const SITE_NAME: Record<SherpaFileRole, string> = {
  encoder: 'encoder.onnx',
  decoder: 'decoder.onnx',
  joiner: 'joiner.onnx',
  tokens: 'tokens.txt',
};

/**
 * The second page, parakeet.html. It does not use the sherpa-onnx engine at all:
 * it runs Parakeet in 4-bit form with parakeet.js on ONNX Runtime Web, which
 * can use WebGPU. Both libraries come from npm and are bundled by Vite; only
 * the model files are downloaded here.
 */
export const PARAKEET = {
  id: 'parakeet',
  label: 'Parakeet TDT 0.6B v3 (4-bit)',
  repo: 'https://huggingface.co/efederici/parakeet-tdt-0.6b-v3-onnx-int4/resolve/main/',
  /** The names in the site. */
  files: {
    encoder: 'encoder-model.onnx',
    decoder: 'decoder_joint-model.int8.onnx', // decoder and joiner in one graph
    tokenizer: 'vocab.txt',
  },
  /** The names in `repo`. Only the encoder differs: the site name drops the repo's quantization tag. */
  repoFiles: {
    encoder: 'encoder-model.int4.onnx',
    decoder: 'decoder_joint-model.int8.onnx',
    tokenizer: 'vocab.txt',
  },
} as const satisfies Omit<ParakeetModelSpec, 'dir' | 'bytes'> & {
  repo: string;
  repoFiles: ParakeetModelSpec['files'];
};
