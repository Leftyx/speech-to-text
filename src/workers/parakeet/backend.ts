import { type ParakeetBackend, isParakeetBackend } from '../../shared/manifest.ts';

/**
 * The backend when the page names none: the processor. That is the real test,
 * because the page is meant for phones, and many phone browsers have no WebGPU.
 */
const DEFAULT_BACKEND: ParakeetBackend = 'wasm';

/**
 * The backend to run: the page's `?backend=` if it names a backend, else
 * {@link DEFAULT_BACKEND}. Plain "webgpu" becomes "webgpu-hybrid".
 *
 * In parakeet.js 1.4.9, "wasm" puts the whole model on WebAssembly.
 * "webgpu-hybrid" runs the encoder on WebGPU and the decoder on WebAssembly.
 * Plain "webgpu" gives the encoder no execution provider, so ONNX Runtime
 * picks WebAssembly for it: the page would run on the processor and still
 * report WebGPU.
 */
export function chooseBackend(asked: string | null): ParakeetBackend {
  const backend = isParakeetBackend(asked) ? asked : DEFAULT_BACKEND;
  return backend === 'webgpu' ? 'webgpu-hybrid' : backend;
}

/** Whether the backend asks for WebGPU at all. */
export const wantsGpu = (backend: ParakeetBackend): boolean => backend.startsWith('webgpu');

/** What will really run, in words for the page, and whether that uses the GPU. */
export async function describeBackend(backend: ParakeetBackend): Promise<{ text: string; gpu: boolean }> {
  if (!wantsGpu(backend)) return { text: 'WebAssembly (CPU), asked for', gpu: false };
  try {
    if ('gpu' in navigator && await navigator.gpu.requestAdapter()) {
      return { text: 'WebGPU for the encoder, WebAssembly for the decoder', gpu: true };
    }
  } catch (err) {
    console.warn('[parakeet] the WebGPU adapter request failed:', err);
  }
  // With no adapter, ONNX Runtime falls back to WebAssembly on its own.
  // Only "webgpu-strict" has no fallback: it then fails to load.
  return { text: 'WebAssembly (CPU), because this browser gives no WebGPU adapter', gpu: false };
}
