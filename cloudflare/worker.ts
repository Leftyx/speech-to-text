/**
 * The Cloudflare Worker for the test site.
 *
 * Cloudflare serves the files in dist/ directly, with the headers from
 * dist/_headers. It calls this Worker only for other paths: the engine and
 * model files, which are never in dist/, and the ONNX Runtime wasm, which is
 * too large for a static file (over 25 MiB). They are in R2, under the same
 * path as on the site.
 */
import { CROSS_ORIGIN_ISOLATION } from './cross-origin.ts';

/** The bindings from wrangler.jsonc. */
interface Env {
  readonly FILES: R2Bucket;
}

const TYPES: Readonly<Record<string, string>> = {
  js: 'text/javascript; charset=utf-8',
  json: 'application/json; charset=utf-8',
  txt: 'text/plain; charset=utf-8',
  wasm: 'application/wasm',
};

/** The reply for one R2 file. `body` is null for a HEAD request. */
function reply(object: R2Object, body: ReadableStream | null): Response {
  return new Response(body, {
    headers: {
      'Content-Type': TYPES[object.key.split('.').pop() ?? ''] ?? 'application/octet-stream',
      'Content-Length': String(object.size),
      ETag: object.httpEtag,
      // no-store: the same as the local server. Both pages keep their model
      // in Cache Storage. no-transform: Cloudflare must not compress, or it
      // can drop Content-Length, which the size check needs.
      'Cache-Control': 'no-store, no-transform',
      ...CROSS_ORIGIN_ISOLATION,
    },
  });
}

/** A short text reply, with the same cross-origin headers as every other reply. */
const text = (status: number, body: string, headers: Record<string, string> = {}): Response =>
  new Response(body, { status, headers: { ...headers, ...CROSS_ORIGIN_ISOLATION } });

/** The 404 reply. It is logged, so `wrangler tail` shows which file is missing from R2. */
function notFound(key: string): Response {
  console.warn(`not in R2: ${key}`);
  return text(404, 'Not found');
}

/** The Worker's request handler. */
export default {
  /** Answers GET and HEAD from R2. Both speech workers read each model file size from a HEAD (model-cache.ts). */
  async fetch(request, env): Promise<Response> {
    let key: string;
    try {
      key = decodeURIComponent(new URL(request.url).pathname.slice(1));
    } catch {
      return text(400, 'Bad request: the path is not valid');
    }
    switch (request.method) {
      case 'HEAD': {
        const object = await env.FILES.head(key);
        return object ? reply(object, null) : notFound(key);
      }
      case 'GET': {
        const object = await env.FILES.get(key);
        return object ? reply(object, object.body) : notFound(key);
      }
      default:
        return text(405, 'Method not allowed', { Allow: 'GET, HEAD' });
    }
  },
} satisfies ExportedHandler<Env>;
