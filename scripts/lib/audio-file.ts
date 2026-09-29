/**
 * Audio files for `npm run transcribe`. The browser's fake microphone plays
 * only WAV files, so other formats are converted first.
 */
import { readFile, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { describeError } from '../../src/shared/errors.ts';
import { launchBrowser } from './browser.ts';
import { BuildError } from './build-error.ts';

/** The rate the models take (SAMPLE_RATE in src/shared/audio-protocol.ts, a browser-only module). */
const SAMPLE_RATE = 16_000;

const isWavHeader = (buf: Buffer): boolean =>
  buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WAVE';

/**
 * The length of a WAV file in seconds, from its header.
 * @throws BuildError if it is not a WAV file.
 */
export async function wavSeconds(file: string): Promise<number> {
  const buf = await readFile(file);
  if (!isWavHeader(buf)) throw new BuildError(`${file} is not a WAV file.`);
  let byteRate = 0;
  for (let at = 12; at + 8 <= buf.length;) {
    const id = buf.toString('ascii', at, at + 4);
    const size = buf.readUInt32LE(at + 4);
    if (id === 'fmt ') byteRate = buf.readUInt32LE(at + 16);
    if (id === 'data' && byteRate) return Math.min(size, buf.length - at - 8) / byteRate;
    at += 8 + size + (size % 2); // chunks are padded to an even size
  }
  throw new BuildError(`${file} has no audio data.`);
}

/**
 * Decodes the audio in the browser page and returns it as 16-bit mono PCM,
 * base64. decodeAudioData resamples to the context's rate, 16 kHz.
 */
const DECODE = (base64: string): string => `(async () => {
  const bytes = Uint8Array.fromBase64(${JSON.stringify(base64)});
  const audio = await new OfflineAudioContext(1, 1, ${SAMPLE_RATE}).decodeAudioData(bytes.buffer);
  const pcm = new Int16Array(audio.length);
  for (let c = 0; c < audio.numberOfChannels; c++) {
    const data = audio.getChannelData(c);
    for (let i = 0; i < data.length; i++) {
      pcm[i] += Math.round(Math.max(-1, Math.min(1, data[i])) * 32767 / audio.numberOfChannels);
    }
  }
  return new Uint8Array(pcm.buffer).toBase64();
})()`;

/** A 16 kHz mono 16-bit WAV file around `pcm`. */
function wavFile(pcm: Buffer): Buffer {
  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVEfmt ', 8, 'ascii');
  header.writeUInt32LE(16, 16); // fmt chunk size
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(SAMPLE_RATE, 24);
  header.writeUInt32LE(SAMPLE_RATE * 2, 28); // bytes per second
  header.writeUInt16LE(2, 32); // bytes per sample
  header.writeUInt16LE(16, 34); // bits per sample
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

/**
 * The file itself if it is a WAV file. Otherwise (WebM, MP3, M4A, OGG, FLAC
 * and anything else the browser can play) a 16 kHz WAV copy in `tempDir`.
 *
 * @throws BuildError if the browser cannot decode it.
 */
export async function asWav(file: string, tempDir: string): Promise<string> {
  const buf = await readFile(file);
  if (isWavHeader(buf)) return file;

  const browser = await launchBrowser();
  let pcm: unknown;
  try {
    pcm = await browser.page.evaluate(DECODE(buf.toString('base64')));
  } catch (err) {
    throw new BuildError(`${file} is not a WAV file, and the browser cannot decode it either (${describeError(err)}).`);
  } finally {
    await browser.close();
  }
  if (typeof pcm !== 'string') throw new BuildError(`The browser gave no audio for ${file}.`);
  const out = join(tempDir, `${basename(file)}.16k.wav`);
  await writeFile(out, wavFile(Buffer.from(pcm, 'base64')));
  return out;
}
