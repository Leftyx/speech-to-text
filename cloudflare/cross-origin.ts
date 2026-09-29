/**
 * The engine uses several threads, which share memory through a
 * SharedArrayBuffer. A browser gives that object only to a page that is
 * "cross-origin isolated", and these two headers make the page isolated.
 *
 * Every server of this site sends them, from this one constant: Vite dev
 * (vite.config.ts), Cloudflare's static files (the `_headers` file that
 * vite.config.ts writes), the Cloudflare Worker (worker.ts) and the local
 * server (scripts/lib/site-server.ts).
 */
export const CROSS_ORIGIN_ISOLATION = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
};
