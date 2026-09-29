/**
 * Keeps model files in the browser's Cache Storage, so each file is
 * downloaded only once.
 *
 * Both workers use it, each with its own cache. A page deletes only the
 * files in its own cache, so it cannot delete the other page's model.
 *
 * Every request here uses `cache: 'no-store'`. The service worker then leaves
 * it alone, so the model is not stored a second time in the site files.
 */
import { describeError } from '../../shared/errors.ts';
import { megabytes, secondsSince } from '../../shared/trace.ts';

/** Where the loading steps are reported. */
export interface CacheReport {
  /** Details for the console. */
  readonly log: (text: string) => void;
  /** Short text for the page's status line. */
  readonly status: (text: string) => void;
}

/** The model files, from storage or from the server. */
export interface LocalModel {
  /** The files, in the order of the paths asked for. */
  readonly files: readonly Blob[];
  /** One sentence for the page: did the model come from storage or from the server. */
  readonly source: string;
}

/**
 * The size of `url` from a HEAD request, to compare with the stored copy.
 *
 * @returns Undefined when there is no network. The stored copy is then used
 *   as it is. Only complete files are stored, so it is complete.
 */
async function serverSize(url: string): Promise<number | undefined> {
  const path = new URL(url).pathname;
  let head: Response;
  try {
    head = await fetch(url, { method: 'HEAD', cache: 'no-store' });
  } catch {
    // fetch fails only when no answer came at all: no network.
    return undefined;
  }
  if (!head.ok) throw new Error(`${path} is not on the server (HTTP ${head.status}); run npm run assets`);
  const size = Number(head.headers.get('content-length'));
  if (!size) {
    throw new Error(`the server did not report the size of ${path}. Reload the page. If it fails again, `
      + 'the server must send Content-Length with each model file');
  }
  return size;
}

/**
 * Gets `url` from the cache when a complete copy is there, else downloads
 * it and stores it. A failure to store is logged, and loading goes on.
 */
async function getFile(
  cache: Cache,
  url: string,
  report: CacheReport,
): Promise<{ file: Blob; downloaded: boolean; storeError: string | undefined }> {
  const path = new URL(url).pathname;
  const size = await serverSize(url);
  const stored = await (await cache.match(url))?.blob();

  if (size === undefined) {
    if (!stored) {
      throw new Error(`${path} is not stored on this device, and there is no network. `
        + 'Open this page once while online, and wait for "Ready"');
    }
    report.log(`${path}: NO NETWORK, so the stored copy is used (${megabytes(stored.size)})`);
    return { file: stored, downloaded: false, storeError: undefined };
  }
  if (stored?.size === size) {
    report.log(`${path}: FROM STORAGE, no download (${megabytes(size)})`);
    return { file: stored, downloaded: false, storeError: undefined };
  }

  // Say why, before the download starts: it can take minutes.
  const reason = stored
    ? `the stored copy is ${stored.size} bytes, the server has ${size}`
    : 'it is not in storage';
  report.log(`${path}: DOWNLOADING ${megabytes(size)}, because ${reason}`);
  report.status(`Downloading ${path.split('/').pop()} (${megabytes(size)}). It is stored after this, so later visits do not download it…`);
  const t0 = performance.now();
  const res = await fetch(url, { cache: 'no-store' });
  if (!res.ok) throw new Error(`${path} failed to download (HTTP ${res.status}). Check the connection, then reload the page`);
  const file = await res.blob();
  // A cut connection can end the body early. Such a file must not be used or stored.
  if (file.size !== size) {
    throw new Error(`${path} arrived with ${file.size} of ${size} bytes. Check the connection, then reload the page`);
  }
  report.log(`${path}: downloaded ${megabytes(file.size)} in ${secondsSince(t0).toFixed(1)} s`);
  try {
    await cache.put(url, new Response(file));
    report.log(`${path}: stored, so the next visit does not download it`);
    return { file, downloaded: true, storeError: undefined };
  } catch (err) {
    report.log(`${path}: COULD NOT STORE it, so the next visit downloads it again: ${describeError(err)}`);
    return { file, downloaded: true, storeError: describeError(err) };
  }
}

/** The sentence for {@link LocalModel.source}. */
function describeSource(files: number, downloads: number, storeError: string | undefined): string {
  if (downloads === 0) return 'Model read from storage, no download.';
  if (storeError !== undefined) {
    return `Model downloaded (${downloads} of ${files} files), but the browser did not store it (${storeError}), `
      + 'so the next visit downloads it again.';
  }
  return `Model downloaded (${downloads} of ${files} files) and stored, so the next visit does not download it.`;
}

/**
 * Gets the files at `paths`, from the cache `cacheName` when it can, else
 * from the server. Then cached files that are not in `paths` are deleted, so
 * an older model does not stay on the disk. They are deleted only after the
 * new files are all there: with no network, the page then still has the
 * older model.
 *
 * @param cacheName - The page's own cache. Keep the names the pages use, or
 *   every user downloads the model again.
 * @param paths - Site paths such as `/models-parakeet/encoder-model.onnx`, or full URLs.
 * @param report - Told where each file came from and how fast.
 */
export async function localModel(
  cacheName: string,
  paths: readonly string[],
  report: CacheReport,
): Promise<LocalModel> {
  const cache = await caches.open(cacheName);
  const urls = paths.map((path) => new URL(path, self.location.href).href);

  const files: Blob[] = [];
  let downloads = 0;
  let storeError: string | undefined;
  for (const url of urls) {
    const got = await getFile(cache, url, report);
    if (got.downloaded) downloads++;
    storeError ??= got.storeError;
    files.push(got.file);
  }
  for (const request of await cache.keys()) {
    if (!urls.includes(request.url)) {
      await cache.delete(request);
      report.log(`${new URL(request.url).pathname}: deleted from storage, the model does not use it`);
    }
  }
  report.log(`model files: ${urls.length - downloads} from storage, ${downloads} downloaded`);
  const source = describeSource(urls.length, downloads, storeError);
  report.status(`${source} Starting the model…`);
  return { files, source };
}
