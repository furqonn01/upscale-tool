import type { OnnxModelSpec } from '../types'

export const MODEL_CACHE_NAME = 'hd-studio-models-v1'

export const CURATED_ONNX_MODELS: OnnxModelSpec[] = [
  {
    id: 'swin2sr-light-x2',
    name: 'Swin2SR Lightweight 2× (Cepat & Hemat RAM)',
    scale: 2,
    sizeLabel: '~4 MB',
    bestFor: 'HP & Laptop — tajamkan foto/screenshot burik dengan cepat',
    url: 'https://huggingface.co/Xenova/swin2SR-lightweight-x2-64/resolve/main/onnx/model.onnx',
    valueRange: '0_1',
  },
  {
    id: 'realesrgan-general-x4v3',
    name: 'Real-ESRGAN General v3 4× (HD Cepat)',
    scale: 4,
    sizeLabel: '~4.9 MB',
    bestFor: 'HP & Laptop — ubah foto burik jadi 4× HD dengan cepat (FP32 WebGPU & WASM)',
    url: 'https://huggingface.co/Heliosoph/realesrgan-onnx/resolve/main/realesr-general-x4v3.onnx',
    valueRange: '0_1',
  },
  {
    id: 'swin2sr-classical-x2',
    name: 'Swin2SR Classical 2× (Detail Tekstur)',
    scale: 2,
    sizeLabel: '~48 MB',
    bestFor: 'Foto detail, arsitektur, dan objek tajam',
    url: 'https://huggingface.co/Xenova/swin2SR-classical-sr-x2-64/resolve/main/onnx/model.onnx',
    valueRange: '0_1',
  },
  {
    id: 'realesrgan-x4plus-fp32',
    name: 'Real-ESRGAN x4plus Pro 4× (Khusus Laptop GPU)',
    scale: 4,
    sizeLabel: '~67 MB',
    bestFor: 'Kualitas maksimal 4× (berat — disarankan untuk Laptop dengan WebGPU)',
    url: 'https://huggingface.co/othytenk/realesrgan-x4plus/resolve/main/realesrgan_x4plus.onnx',
    valueRange: '0_1',
  },
]

export async function isModelCached(url: string): Promise<boolean> {
  if (typeof caches === 'undefined') return false
  try {
    const cache = await caches.open(MODEL_CACHE_NAME)
    const match = await cache.match(url)
    return Boolean(match)
  } catch {
    return false
  }
}

export async function clearModelCache(): Promise<void> {
  if (typeof caches === 'undefined') return
  await caches.delete(MODEL_CACHE_NAME)
}
