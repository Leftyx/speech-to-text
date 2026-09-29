import { resolve } from 'node:path';
import { build, defineConfig, type Plugin } from 'vite';
import { CROSS_ORIGIN_ISOLATION } from './cloudflare/cross-origin.ts';

/**
 * Bundles a TypeScript entry into one classic (non-module) script, and
 * returns its code.
 *
 * @param define - Names to replace in the code, as in Vite's `define`.
 */
async function bundleScript(
  entry: string,
  fileName: string,
  dev: boolean,
  define: Record<string, string> = {},
): Promise<string> {
  const result = await build({
    configFile: false,
    publicDir: false,
    logLevel: 'warn',
    define,
    build: {
      write: false,
      minify: !dev,
      sourcemap: dev ? 'inline' : false,
      lib: { entry: resolve(import.meta.dirname, entry), formats: ['iife'], name: 'script', fileName },
    },
  });
  const outputs = Array.isArray(result) ? result : [result];
  for (const out of outputs) {
    if ('output' in out) {
      const chunk = out.output.find((o) => o.type === 'chunk');
      if (chunk) return chunk.code;
    }
  }
  throw new Error(`no output for ${entry}`);
}

/**
 * Builds one classic (non-module) worker script from a TypeScript entry.
 *
 * Vite serves workers as ES modules in dev, and uses one output format for
 * all workers in the build. The sherpa-onnx engine worker must be a classic
 * script, because the engine loads only through importScripts(). So this
 * plugin bundles it separately, as one IIFE file served at the site root:
 * - dev: bundled on request, and again after any source file changes;
 * - build: bundled once and written into dist/.
 */
function classicWorker({ entry, fileName }: { entry: string; fileName: string }): Plugin {
  const bundle = (dev: boolean): Promise<string> => bundleScript(entry, fileName, dev);

  return {
    name: 'classic-worker',

    configureServer(server) {
      let cached: Promise<string> | undefined;
      const forget = (): void => {
        cached = undefined;
      };
      server.watcher.on('change', forget);
      server.watcher.on('add', forget);
      server.watcher.on('unlink', forget);

      const path = `${server.config.base}${fileName}`;
      server.middlewares.use((req, res, next) => {
        if (req.url?.split('?')[0] !== path) {
          next();
          return;
        }
        cached ??= bundle(true);
        cached.then((code) => {
          res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8', ...CROSS_ORIGIN_ISOLATION });
          res.end(code);
        }, (err: unknown) => {
          cached = undefined;
          next(err);
        });
      });
    },

    async generateBundle() {
      this.emitFile({ type: 'asset', fileName, source: await bundle(false) });
    },
  };
}

/**
 * Writes two Cloudflare files into dist/ (see cloudflare/worker.ts):
 * - `_headers`: the cross-origin headers for every static file;
 * - `.assetsignore`: keeps the ONNX Runtime wasm (about 27 MB) out of the
 *   static files, because Cloudflare refuses files over 25 MiB. It goes to
 *   R2 with the models instead, under the same path.
 */
function cloudflareFiles(): Plugin {
  const headers = Object.entries(CROSS_ORIGIN_ISOLATION).map(([name, value]) => `  ${name}: ${value}\n`).join('');
  return {
    name: 'cloudflare-files',
    apply: 'build',
    generateBundle() {
      this.emitFile({ type: 'asset', fileName: '_headers', source: `/*\n${headers}` });
      this.emitFile({ type: 'asset', fileName: '.assetsignore', source: 'app/ort-wasm-*.wasm\n' });
    },
  };
}

/**
 * Builds the service worker (src/workers/offline/service-worker.ts) into
 * sw.js at the site root. Build only: in dev, stored files would hide code
 * changes. It gets the list of pages and code files to store at install.
 */
function serviceWorker(): Plugin {
  return {
    name: 'service-worker',
    apply: 'build',
    // After Vite's own plugins and classicWorker, so the bundle already holds
    // the pages, the worker files and engine-worker.js.
    enforce: 'post',
    async generateBundle(_options, bundle) {
      const precache = Object.keys(bundle).filter((name) => /\.(html|js|css)$/.test(name));
      const source = await bundleScript('src/workers/offline/service-worker.ts', 'sw.js', false, {
        __PRECACHE__: JSON.stringify(precache),
      });
      this.emitFile({ type: 'asset', fileName: 'sw.js', source });
    },
  };
}

export default defineConfig({
  // Two plain HTML pages, no client-side routing. The default ('spa') answers
  // a missing file with index.html and status 200, so a missing model looked
  // like a broken one, and could even be stored as the model.
  appType: 'mpa',
  // Engine and model files from `npm run assets`. Served as-is in dev, but not
  // copied into dist/ (about 2.4 GB): the preview server and any host serve
  // the two folders side by side.
  publicDir: 'assets',
  build: {
    copyPublicDir: false,
    // Not "assets", to keep the bundled code apart from the downloaded files.
    assetsDir: 'app',
    rolldownOptions: {
      input: {
        main: resolve(import.meta.dirname, 'index.html'),
        parakeet: resolve(import.meta.dirname, 'parakeet.html'),
      },
    },
  },
  worker: { format: 'es' },
  resolve: {
    alias: [
      // parakeet.js imports plain 'onnxruntime-web'. Give it the WebGPU build,
      // which also runs on WebAssembly alone. package.json "overrides" pins
      // the version to 1.30.0: parakeet.js asks for 1.24.1, whose WebGPU
      // backend destroys a buffer before the queue uses it. Put 1.24.1 back
      // if a newer one misbehaves.
      { find: /^onnxruntime-web$/, replacement: 'onnxruntime-web/webgpu' },
    ],
  },
  // ONNX Runtime finds its threads and wasm file relative to its own module
  // URL, which pre-bundling would change.
  optimizeDeps: { exclude: ['onnxruntime-web'] },
  server: { headers: CROSS_ORIGIN_ISOLATION },
  plugins: [
    classicWorker({ entry: 'src/workers/orukeet/index.ts', fileName: 'engine-worker.js' }),
    cloudflareFiles(),
    serviceWorker(),
  ],
});
