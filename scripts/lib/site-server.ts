/**
 * Serves the built site: code from ./dist, engine and model files from
 * ./assets. Hosting elsewhere needs the same two folders in one root, and the
 * same two cross-origin headers (cloudflare/cross-origin.ts) on every reply.
 */
import { createReadStream, existsSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { extname, join, normalize, sep } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { CROSS_ORIGIN_ISOLATION } from '../../cloudflare/cross-origin.ts';
import { BuildError } from './build-error.ts';

const ROOT = join(import.meta.dirname, '..', '..');
const ROOTS = [join(ROOT, 'dist'), join(ROOT, 'assets')]; // first match wins

const TYPES: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.wasm': 'application/wasm',
};

/** The first file under ROOTS for this URL path, or undefined. Never leaves the roots. */
async function resolveFile(urlPath: string): Promise<{ file: string; size: number } | undefined> {
  for (const root of ROOTS) {
    const candidate = normalize(join(root, urlPath));
    if (!candidate.startsWith(root + sep)) continue;
    try {
      const st = await stat(candidate);
      if (st.isFile()) return { file: candidate, size: st.size };
    } catch (err) {
      // Not in this folder: try the next one. Any other error (no access) is a real failure.
      const { code } = err as NodeJS.ErrnoException;
      if (code !== 'ENOENT' && code !== 'ENOTDIR') throw err;
    }
  }
  return undefined;
}

/** A running site server. */
export interface SiteServer {
  readonly server: Server;
  /** The port it listens on, useful when it was started on port 0. */
  readonly port: number;
}

/**
 * Starts serving the site on 127.0.0.1.
 *
 * @param port - 0 picks a free port.
 * @throws BuildError naming the command to run if dist/ or assets/ is missing.
 */
export async function startSiteServer(port: number): Promise<SiteServer> {
  const missing = [
    ['dist/index.html', 'npm run build'],
    ['assets/engine/sherpa-onnx-wasm-main-vad-asr.data', 'npm run assets'],
  ].filter(([file]) => !existsSync(join(ROOT, file ?? '')));
  if (missing.length) {
    throw new BuildError(`Files are missing. Run first: ${missing.map(([, cmd]) => cmd).join(', then ')}`);
  }

  const server = createServer((req, res) => {
    void (async () => {
      let path: string;
      try {
        path = decodeURIComponent(new URL(req.url ?? '/', 'http://localhost').pathname);
      } catch {
        res.writeHead(400, CROSS_ORIGIN_ISOLATION).end();
        return;
      }
      if (path.endsWith('/')) path += 'index.html';

      const found = await resolveFile(path);
      if (!found) {
        res.writeHead(404, { 'Content-Type': 'text/plain', ...CROSS_ORIGIN_ISOLATION }).end('Not found');
        return;
      }

      res.writeHead(200, {
        'Content-Type': TYPES[extname(found.file)] ?? 'application/octet-stream',
        'Content-Length': found.size,
        'Cache-Control': 'no-store',
        ...CROSS_ORIGIN_ISOLATION,
      });
      // A HEAD request only asks for the headers, so do not read 670 MB from disk.
      if (req.method === 'HEAD') {
        res.end();
        return;
      }
      await pipeline(createReadStream(found.file), res);
    })().catch((err: unknown) => {
      // Usually the browser closed the connection mid-file.
      if (!res.headersSent) res.writeHead(500, CROSS_ORIGIN_ISOLATION);
      res.end();
      if ((err as NodeJS.ErrnoException).code !== 'ERR_STREAM_PREMATURE_CLOSE') console.error(err);
    });
  });

  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, '127.0.0.1', resolve);
    });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EADDRINUSE') {
      throw new BuildError(`Port ${port} is in use. Stop the program that uses it, or set PORT to another number.`);
    }
    throw err;
  }
  return { server, port: (server.address() as AddressInfo).port };
}
