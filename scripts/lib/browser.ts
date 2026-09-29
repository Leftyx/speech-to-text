/**
 * A headless Edge or Chrome whose microphone plays a WAV file, driven over the
 * DevTools protocol. Uses the browser already installed; no extra package.
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { describeError } from '../../src/shared/errors.ts';
import { BuildError } from './build-error.ts';

/** Where Windows installs Edge and Chrome. The BROWSER variable overrides. */
const CANDIDATES = [
  process.env['BROWSER'],
  `${process.env['ProgramFiles(x86)'] ?? ''}\\Microsoft\\Edge\\Application\\msedge.exe`,
  `${process.env['ProgramFiles'] ?? ''}\\Microsoft\\Edge\\Application\\msedge.exe`,
  `${process.env['ProgramFiles'] ?? ''}\\Google\\Chrome\\Application\\chrome.exe`,
  `${process.env['LOCALAPPDATA'] ?? ''}\\Google\\Chrome\\Application\\chrome.exe`,
];

function findBrowser(): string {
  const found = CANDIDATES.find((path) => path && existsSync(path));
  if (!found) throw new BuildError('No Edge or Chrome found. Set BROWSER to the path of msedge.exe or chrome.exe.');
  return found;
}

/** One browser tab. */
export interface Page {
  /** Opens `url` and waits for its load event. */
  navigate(url: string): Promise<void>;
  /** Runs `expression` in the page and returns its value (JSON-compatible values only). Check its shape. */
  evaluate(expression: string): Promise<unknown>;
}

/** A running browser and its one tab. `close()` ends it and deletes its profile. */
export interface Browser {
  readonly page: Page;
  close(): Promise<void>;
}

interface CdpReply {
  id?: number;
  method?: string;
  result?: unknown;
  error?: { message: string };
}

/**
 * Starts a headless browser with a fresh profile.
 *
 * @param wav - If given, the microphone plays this file once, from the moment
 *   a page starts recording, then gives silence.
 */
export async function launchBrowser(wav?: string): Promise<Browser> {
  const profile = await mkdtemp(join(tmpdir(), 'orukeet-transcribe-'));
  const microphone = wav
    ? [
      '--use-fake-ui-for-media-stream',
      '--use-fake-device-for-media-stream',
      `--use-file-for-fake-audio-capture=${wav}%noloop`,
    ]
    : [];
  const child = spawn(findBrowser(), [
    '--headless=new',
    '--remote-debugging-port=0',
    `--user-data-dir=${profile}`,
    '--no-first-run',
    '--no-default-browser-check',
    ...microphone,
    // A scripted click is not a user gesture, and without one the browser may
    // keep the AudioContext suspended.
    '--autoplay-policy=no-user-gesture-required',
    '--enable-unsafe-webgpu',
    'about:blank',
  ], { stdio: 'ignore' });
  // Why the browser is gone, once it is. Without an 'error' listener, a
  // browser that cannot start would crash this script.
  let gone: string | undefined;
  child.once('error', (err) => {
    gone = err.message;
  });
  child.once('exit', (code) => {
    // A launcher can hand over to another process and exit with 0.
    if (code !== 0) gone ??= `it stopped with exit code ${String(code)}`;
  });

  const close = async (): Promise<void> => {
    child.kill();
    try {
      await rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    } catch (err) {
      console.warn(`Could not delete the temporary browser profile ${profile}: ${describeError(err)}`);
    }
  };

  try {
    // With port 0 the browser picks a free port and writes it into this file.
    const port = await waitForDevToolsPort(join(profile, 'DevToolsActivePort'), () => gone);
    const tabs = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json() as
      { type: string; webSocketDebuggerUrl: string }[];
    const tab = tabs.find((t) => t.type === 'page');
    if (!tab) throw new BuildError('The browser opened no tab.');
    return { page: await connect(tab.webSocketDebuggerUrl), close };
  } catch (err) {
    await close();
    throw err;
  }
}

/** @param gone - Why the browser stopped, once it has. */
async function waitForDevToolsPort(file: string, gone: () => string | undefined): Promise<number> {
  for (let i = 0; i < 100; i++) {
    const reason = gone();
    if (reason) throw new BuildError(`The browser did not start (${reason}). Set BROWSER to the path of msedge.exe or chrome.exe.`);
    try {
      const port = Number((await readFile(file, 'utf8')).split('\n')[0]);
      if (port) return port;
    } catch {
      // not written yet
    }
    await sleep(100);
  }
  throw new BuildError('The browser did not start within 10 s. Run the command again.');
}

async function connect(url: string): Promise<Page> {
  const socket = new WebSocket(url);
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', reject, { once: true });
  });

  let nextId = 0;
  const pending = new Map<number, PromiseWithResolvers<unknown>>();
  /** Resolved by the next page load event. */
  let onLoad: PromiseWithResolvers<undefined> | undefined;
  socket.addEventListener('message', ({ data }: { data: unknown }) => {
    const msg = JSON.parse(String(data)) as CdpReply;
    if (msg.id !== undefined) {
      const call = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) call?.reject(new Error(msg.error.message));
      else call?.resolve(msg.result);
    } else if (msg.method === 'Page.loadEventFired') {
      onLoad?.resolve(undefined);
    }
  });
  // If the browser crashes, no reply comes. Fail every call that waits for one.
  socket.addEventListener('close', () => {
    const err = new BuildError('The browser closed the connection. Did it crash? Run the command again.');
    for (const call of pending.values()) call.reject(err);
    pending.clear();
    onLoad?.reject(err);
  });

  const send = (method: string, params: object = {}): Promise<unknown> => {
    const id = ++nextId;
    const call = Promise.withResolvers<unknown>();
    pending.set(id, call);
    socket.send(JSON.stringify({ id, method, params }));
    return call.promise;
  };

  await send('Page.enable');
  return {
    async navigate(target) {
      const loaded = Promise.withResolvers<undefined>();
      // Handled here as well, so a rejection is never unhandled when the navigate call fails first.
      loaded.promise.catch(() => undefined);
      onLoad = loaded;
      const { errorText } = await send('Page.navigate', { url: target }) as { errorText?: string };
      if (errorText) throw new Error(`could not open ${target}: ${errorText}`);
      await loaded.promise;
    },
    async evaluate(expression) {
      const reply = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }) as {
        result: { value: unknown };
        exceptionDetails?: { text: string; exception?: { description?: string } };
      };
      if (reply.exceptionDetails) {
        // `text` is only "Uncaught (in promise)". The error itself is in the description.
        const { text, exception } = reply.exceptionDetails;
        throw new Error(`in the page: ${exception?.description ?? text}`);
      }
      return reply.result.value;
    },
  };
}
