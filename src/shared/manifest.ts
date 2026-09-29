/**
 * The model lists that `npm run assets` writes and the workers read:
 * `models/models.json` for the sherpa-onnx page and `models-parakeet/model.json`
 * for the Parakeet page. The build script and the workers both import these types,
 * so the two sides cannot drift apart.
 */

interface SherpaModelBase {
  /** Short name, used in `?model=` and on the command line. */
  readonly id: string;
  /** Text shown in the model picker. */
  readonly label: string;
  /** Mel bands the encoder takes: Orukeet 128, Whisper 80. */
  readonly featureDim: number;
  /** Folder of the model files, relative to the site root, with a trailing slash. */
  readonly dir: string;
  /** Total size of the model files, for the picker and the status line. */
  readonly bytes: number;
}

/** A NeMo transducer model, such as Orukeet (Parakeet TDT). */
export interface TransducerModelEntry extends SherpaModelBase {
  readonly kind: 'transducer';
  readonly files: {
    readonly encoder: string;
    readonly decoder: string;
    readonly joiner: string;
    readonly tokens: string;
  };
}

/** A Whisper model. */
export interface WhisperModelEntry extends SherpaModelBase {
  readonly kind: 'whisper';
  readonly files: {
    readonly encoder: string;
    readonly decoder: string;
    readonly tokens: string;
  };
}

/** One entry of `models/models.json`. */
export type SherpaModelEntry = TransducerModelEntry | WhisperModelEntry;

/** The file roles a sherpa model can have. */
export type SherpaFileRole = 'encoder' | 'decoder' | 'joiner' | 'tokens';

const PARAKEET_BACKENDS = ['webgpu', 'webgpu-hybrid', 'webgpu-strict', 'wasm'] as const;

/** How parakeet.js splits the work: see `src/workers/parakeet/backend.ts`. */
export type ParakeetBackend = (typeof PARAKEET_BACKENDS)[number];

/** True if `v` names a parakeet.js backend. */
export const isParakeetBackend = (v: unknown): v is ParakeetBackend => (PARAKEET_BACKENDS as readonly unknown[]).includes(v);

/** `models-parakeet/model.json`: the one model of the Parakeet page. */
export interface ParakeetModelSpec {
  readonly id: string;
  readonly label: string;
  readonly dir: string;
  readonly files: {
    readonly encoder: string;
    /** Decoder and joiner in one graph. */
    readonly decoder: string;
    readonly tokenizer: string;
  };
  readonly bytes: number;
}

// ---- Checks for JSON read over the network ----

type JsonObject = Readonly<Record<string, unknown>>;

const isObject = (value: unknown): value is JsonObject =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function field<T>(obj: JsonObject, key: string, test: (v: unknown) => v is T, where: string): T {
  const value = obj[key];
  if (!test(value)) throw new TypeError(`${where}: "${key}" is missing or has the wrong type`);
  return value;
}

const isString = (v: unknown): v is string => typeof v === 'string' && v.length > 0;
const isCount = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v > 0;
/** The workers join folder and file names as plain strings, so the slash must be there. */
const isFolder = (v: unknown): v is string => isString(v) && v.endsWith('/');
/** The engine writes each file into the root of its own file system, so a name has no folder. */
const isFileName = (v: unknown): v is string => isString(v) && !v.includes('/');

function stringMap<K extends string>(value: unknown, keys: readonly K[], where: string): Record<K, string> {
  if (!isObject(value)) throw new TypeError(`${where}: "files" is not an object`);
  const out: Partial<Record<K, string>> = {};
  for (const key of keys) out[key] = field(value, key, isFileName, `${where} files`);
  return out as Record<K, string>;
}

/**
 * Checks the contents of `models/models.json`.
 * @throws TypeError naming the first entry and field that is wrong.
 */
export function parseSherpaModelList(json: unknown): SherpaModelEntry[] {
  if (!Array.isArray(json)) throw new TypeError('models.json is not a list');
  return json.map((raw: unknown, i): SherpaModelEntry => {
    const where = `models.json entry ${i}`;
    if (!isObject(raw)) throw new TypeError(`${where} is not an object`);
    const base = {
      id: field(raw, 'id', isString, where),
      label: field(raw, 'label', isString, where),
      featureDim: field(raw, 'featureDim', isCount, where),
      dir: field(raw, 'dir', isFolder, where),
      bytes: field(raw, 'bytes', isCount, where),
    };
    const kind = raw['kind'];
    if (kind === 'whisper') {
      return { ...base, kind, files: stringMap(raw['files'], ['encoder', 'decoder', 'tokens'], where) };
    }
    if (kind === 'transducer') {
      return {
        ...base,
        kind,
        files: stringMap(raw['files'], ['encoder', 'decoder', 'joiner', 'tokens'], where),
      };
    }
    throw new TypeError(`${where}: unknown kind ${JSON.stringify(kind)}`);
  });
}

/**
 * Checks the contents of `models-parakeet/model.json`.
 * @throws TypeError naming the first field that is wrong.
 */
export function parseParakeetModelSpec(json: unknown): ParakeetModelSpec {
  const where = 'models-parakeet/model.json';
  if (!isObject(json)) throw new TypeError(`${where} is not an object`);
  return {
    id: field(json, 'id', isString, where),
    label: field(json, 'label', isString, where),
    dir: field(json, 'dir', isFolder, where),
    files: stringMap(json['files'], ['encoder', 'decoder', 'tokenizer'], where),
    bytes: field(json, 'bytes', isCount, where),
  };
}
