import type { OnnxModelSpec } from '../types'

export const MODEL_CACHE_NAME = 'hd-studio-models-v1'

export const CURATED_ONNX_MODELS: OnnxModelSpec[] = [
  {
    id: '2x-span-live',
    name: 'SPAN LiveAction 2× (Super Cepat & Ringan)',
    scale: 2,
    sizeLabel: '~1.7 MB',
    bestFor: 'Default HP & Laptop — 7× lebih cepat di WASM, foto wajah & harian super natural',
    url: 'https://huggingface.co/notaneimu/onnx-image-models/resolve/main/2xLiveActionV1_SPAN_490000.onnx',
    valueRange: '0_1',
  },
  {
    id: '2x-nomos-compact',
    name: 'NomosUni Compact 2× (Anti-Burik & JPEG)',
    scale: 2,
    sizeLabel: '~2.4 MB',
    bestFor: 'HP & Laptop — bersihkan foto burik, noise, & kompresi WA/JPEG 2× dengan cepat',
    url: 'https://huggingface.co/notaneimu/onnx-image-models/resolve/main/2xNomosUni_compact_otf_medium.onnx',
    valueRange: '0_1',
  },
  {
    id: '4x-nomos8k-span',
    name: 'Nomos8k SPAN Strong 4× (Foto Burik → HD)',
    scale: 4,
    sizeLabel: '~1.7 MB',
    bestFor: 'Terbaik 4× ringan (HP & Laptop) — ubah foto burik/pecah jadi 4× HD dengan sangat cepat',
    url: 'https://huggingface.co/notaneimu/onnx-image-models/resolve/main/4xNomos8k_span_otf_strong_fp32_opset17.onnx',
    valueRange: '0_1',
  },
  {
    id: '4x-clearreality-span',
    name: 'ClearReality v1 SPAN 4× (Foto Nyata Tajam)',
    scale: 4,
    sizeLabel: '~1.7 MB',
    bestFor: 'Foto pemandangan, objek, & portrait nyata agar tajam natural tanpa efek plastik',
    url: 'https://huggingface.co/notaneimu/onnx-image-models/resolve/main/4x-ClearRealityV1-fp32-opset17.onnx',
    valueRange: '0_1',
  },
  {
    id: '4x-animevideo-v3',
    name: 'Real-ESRGAN Anime & Teks v3 4×',
    scale: 4,
    sizeLabel: '~2.5 MB',
    bestFor: 'Khusus anime, ilustrasi, kartun, logo & screenshot teks agar garis ekstra bersih',
    url: 'https://huggingface.co/tidus2102/Real-ESRGAN/resolve/main/RealESR-AnimeVideo-v3_x4.onnx',
    valueRange: '0_1',
  },
  {
    id: 'realesrgan-x4plus-fp32',
    name: 'Real-ESRGAN x4plus Pro 4× (Khusus Laptop GPU)',
    scale: 4,
    sizeLabel: '~67 MB',
    bestFor: 'Kualitas maksimal 4× (berat — disarankan khusus Laptop dengan WebGPU)',
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
