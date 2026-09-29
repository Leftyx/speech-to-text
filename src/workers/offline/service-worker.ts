/**
 * The service worker. It keeps the site files on the device, so both pages
 * open and transcribe with no network.
 *
 * Online, each file comes from the network, and the answer is stored. With no
 * network, the stored copy answers. The pages and their code are stored at
 * install, because the first visit loads them before this worker runs. The
 * engine files, the ONNX Runtime wasm and the model lists are stored when a
 * page loads them. So open each page once online, and wait for "Ready".
 *
 * The model files are not stored here: model-cache.ts keeps them. It asks
 * for them with `cache: 'no-store'`, and this worker leaves such requests to
 * the browser. Else each model would be stored twice.
 *
 * Old build files stay in the cache after an update. Only a new ONNX Runtime
 * version makes that large (27 MB), so they are not deleted.
 */

/** The pages and their code, relative to the site root. vite.config.ts sets it. */
declare const __PRECACHE__: readonly string[];

const sw = self as unknown as ServiceWorkerGlobalScope;

/** Keep the name, or every device stores the site files again. */
const CACHE = 'site-files';

/**
 * The key a file is stored under: its URL with no query, and a page with no
 * ".html" or "index.html". Cloudflare redirects "parakeet.html" to "parakeet", and
 * "parakeet.html?backend=webgpu" is still the same page.
 */
function keyOf(url: string): string {
  const key = new URL(url);
  key.search = '';
  key.pathname = key.pathname.replace(/(index)?\.html$/, '');
  return key.href;
}

/** Stores `response` for `url`. A copy, because the browser refuses a stored redirect as a page. */
async function store(url: string, response: Response): Promise<void> {
  const cache = await caches.open(CACHE);
  await cache.put(keyOf(url), new Response(response.body, response));
}

/** Stores the pages and their code. One missing file fails the install, and the browser tries again later. */
async function precache(): Promise<void> {
  await Promise.all(__PRECACHE__.map(async (file) => {
    const url = new URL(file, sw.registration.scope).href;
    // "no-cache": a page must come from the server, not from the browser's own cache.
    const response = await fetch(url, { cache: 'no-cache' });
    if (!response.ok) throw new Error(`${file}: HTTP ${response.status}`);
    await store(url, response);
  }));
}

/** The network answer, stored for later. With no network, the stored copy. */
async function networkFirst(event: FetchEvent): Promise<Response> {
  const { request } = event;
  try {
    const response = await fetch(request);
    if (response.ok) {
      event.waitUntil(store(request.url, response.clone()).catch((err: unknown) => {
        console.warn(`[offline] could not store ${request.url}:`, err);
      }));
    }
    return response;
  } catch (err) {
    const stored = await caches.match(keyOf(request.url), { cacheName: CACHE });
    if (stored) return stored;
    throw err;
  }
}

sw.addEventListener('install', (event) => {
  event.waitUntil(precache().then(() => sw.skipWaiting()));
});

// Take over the open pages at once, so the files they load next are stored.
sw.addEventListener('activate', (event) => {
  event.waitUntil(sw.clients.claim());
});

sw.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET' || request.cache === 'no-store') return;
  if (new URL(request.url).origin !== sw.location.origin) return;
  event.respondWith(networkFirst(event));
});
