// Converts WAV files to 16 kHz, 16-bit, mono (what Parakeet expects).
// Handles 8/16/24/32-bit PCM, 32-bit float, mu-law and A-law input.
//
// Usage:
//   node resample-16k.js input.wav            -> writes input_16k.wav
//   node resample-16k.js C:\path\to\folder     -> writes all .wav files into folder\16k\

import fs from "node:fs";
import path from "node:path";

const TARGET_RATE = 16000;

function ulaw(u) {
  u = ~u & 0xff;
  const sign = u & 0x80,
    exp = (u >> 4) & 7,
    mant = u & 0x0f;
  const s = (((mant << 3) + 0x84) << exp) - 0x84;
  return (sign ? -s : s) / 32768;
}

function alaw(a) {
  a ^= 0x55;
  const sign = a & 0x80,
    exp = (a >> 4) & 7,
    mant = a & 0x0f;
  const s = exp === 0 ? (mant << 4) + 8 : ((mant << 4) + 0x108) << (exp - 1);
  return (sign ? s : -s) / 32768;
}

function readWav(buf) {
  if (buf.toString("ascii", 0, 4) !== "RIFF" || buf.toString("ascii", 8, 12) !== "WAVE") throw new Error("not a WAV file");
  let fmt = null,
    data = null,
    off = 12;
  while (off + 8 <= buf.length) {
    const id = buf.toString("ascii", off, off + 4);
    const size = buf.readUInt32LE(off + 4);
    const body = off + 8;
    if (id === "fmt ") {
      let format = buf.readUInt16LE(body);
      if (format === 0xfffe) format = buf.readUInt16LE(body + 24); // extensible
      fmt = {
        format,
        channels: buf.readUInt16LE(body + 2),
        rate: buf.readUInt32LE(body + 4),
        bits: buf.readUInt16LE(body + 14),
      };
    } else if (id === "data") {
      data = buf.subarray(body, Math.min(body + size, buf.length));
    }
    off = body + size + (size % 2);
  }
  if (!fmt || !data) throw new Error("missing fmt or data chunk");

  const bytes = fmt.bits / 8;
  const frames = Math.floor(data.length / (bytes * fmt.channels));
  const mono = new Float32Array(frames);

  for (let i = 0; i < frames; i++) {
    let sum = 0;
    for (let c = 0; c < fmt.channels; c++) {
      const p = (i * fmt.channels + c) * bytes;
      let v;
      if (fmt.format === 7) v = ulaw(data[p]);
      else if (fmt.format === 6) v = alaw(data[p]);
      else if (fmt.format === 3) v = bytes === 8 ? data.readDoubleLE(p) : data.readFloatLE(p);
      else if (fmt.bits === 8) v = (data[p] - 128) / 128;
      else if (fmt.bits === 16) v = data.readInt16LE(p) / 32768;
      else if (fmt.bits === 24) v = data.readIntLE(p, 3) / 8388608;
      else if (fmt.bits === 32) v = data.readInt32LE(p) / 2147483648;
      else throw new Error(`unsupported format ${fmt.format} / ${fmt.bits}-bit`);
      sum += v;
    }
    mono[i] = sum / fmt.channels;
  }
  return { samples: mono, rate: fmt.rate, info: fmt };
}

function resample(samples, from, to) {
  if (from === to) return samples;
  const outLen = Math.floor((samples.length * to) / from);
  const out = new Float32Array(outLen);
  const step = from / to;
  for (let i = 0; i < outLen; i++) {
    const pos = i * step;
    const i0 = Math.floor(pos);
    const i1 = Math.min(i0 + 1, samples.length - 1);
    const t = pos - i0;
    out[i] = samples[i0] * (1 - t) + samples[i1] * t;
  }
  return out;
}

function writeWav(samples, rate) {
  const buf = Buffer.alloc(44 + samples.length * 2);
  buf.write("RIFF", 0, "ascii");
  buf.writeUInt32LE(36 + samples.length * 2, 4);
  buf.write("WAVE", 8, "ascii");
  buf.write("fmt ", 12, "ascii");
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20); // PCM
  buf.writeUInt16LE(1, 22); // mono
  buf.writeUInt32LE(rate, 24);
  buf.writeUInt32LE(rate * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write("data", 36, "ascii");
  buf.writeUInt32LE(samples.length * 2, 40);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    buf.writeInt16LE(Math.round(s * 32767), 44 + i * 2);
  }
  return buf;
}

function convert(inFile, outFile) {
  const { samples, rate, info } = readWav(fs.readFileSync(inFile));
  fs.writeFileSync(outFile, writeWav(resample(samples, rate, TARGET_RATE), TARGET_RATE));
  console.log(`${path.basename(inFile)}: ${info.rate} Hz, ${info.bits}-bit, ${info.channels} ch -> 16000 Hz, 16-bit, mono`);
}

const input = process.argv[2];
if (!input) {
  console.log("Usage: node resample-16k.js <file.wav | folder>");
  process.exit(1);
}

if (fs.statSync(input).isDirectory()) {
  const outDir = path.join(input, "16k");
  fs.mkdirSync(outDir, { recursive: true });
  for (const f of fs.readdirSync(input)) {
    if (!f.toLowerCase().endsWith(".wav")) continue;
    try {
      convert(path.join(input, f), path.join(outDir, f));
    } catch (e) {
      console.log(`${f}: skipped (${e.message})`);
    }
  }
} else {
  const out = input.replace(/\.wav$/i, "") + "_16k.wav";
  convert(input, out);
}
