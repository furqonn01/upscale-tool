import type { OnnxModelSpec, OutputImageFormat, ProgressInfo } from '../types'
import type { OnnxWorkerMessage, OnnxWorkerRequest } from '../workers/onnxWorker'
import { MODEL_CACHE_NAME } from './onnxModels'
import { canvasToBlob } from './webglProcessor'

async function fetchModelBuffer(
  url: string,
  onProgress?: (p: ProgressInfo) => void,
  signal?: AbortSignal
): Promise<ArrayBuffer> {
  if (typeof caches !== 'undefined') {
    try {
      const cache = await caches.open(MODEL_CACHE_NAME)
      const cached = await cache.match(url)
      if (cached) {
        onProgress?.({
          percent: 14,
          stage: 'Memuat model AI dari cache lokal...',
        })
        return await cached.arrayBuffer()
      }
    } catch {
      // Cache unavailable; proceed with network fetch
    }
  }

  onProgress?.({
    percent: 2,
    stage: 'Mengunduh model AI ke perangkat (sekali saja)...',
    detail: 'Setelah selesai, model tersimpan lokal untuk pemakaian offline',
  })

  const response = await fetch(url, { signal })
  if (!response.ok) {
    throw new Error(`Gagal mengunduh model AI (HTTP ${response.status})`)
  }

  const total = Number(response.headers.get('content-length') || 0)
  if (!response.body) {
    const buf = await response.arrayBuffer()
    await saveBufferToCache(url, buf)
    return buf
  }

  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let received = 0

  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    if (value) {
      chunks.push(value)
      received += value.byteLength
      if (total > 0) {
        const pct = Math.min(20, Math.round((received / total) * 20))
        onProgress?.({
          percent: pct,
          stage: 'Mengunduh model AI ke cache lokal...',
          detail: `${(received / 1048576).toFixed(1)} MB / ${(total / 1048576).toFixed(1)} MB`,
        })
      } else {
        onProgress?.({
          percent: 10,
          stage: 'Mengunduh model AI ke cache lokal...',
          detail: `${(received / 1048576).toFixed(1)} MB`,
        })
      }
    }
  }

  const merged = new Uint8Array(received)
  let offset = 0
  for (const chunk of chunks) {
    merged.set(chunk, offset)
    offset += chunk.byteLength
  }

  await saveBufferToCache(url, merged.buffer)
  return merged.buffer
}

async function saveBufferToCache(url: string, buffer: ArrayBuffer): Promise<void> {
  if (typeof caches === 'undefined') return
  try {
    const cache = await caches.open(MODEL_CACHE_NAME)
    await cache.put(
      url,
      new Response(buffer.slice(0), {
        headers: { 'Content-Type': 'application/octet-stream' },
      })
    )
  } catch {
    // Ignore quota errors on restricted storage
  }
}

async function hasWebGpuShaderF16(): Promise<boolean> {
  try {
    const gpu = (
      navigator as Navigator & {
        gpu?: { requestAdapter: () => Promise<{ features?: Set<string> } | null> }
      }
    ).gpu
    if (!gpu) return false
    const adapter = await gpu.requestAdapter()
    return Boolean(adapter?.features?.has('shader-f16'))
  } catch {
    return false
  }
}

let sharedWorker: Worker | null = null

function getOrCreateWorker(): Worker {
  if (!sharedWorker) {
    sharedWorker = new Worker(new URL('../workers/onnxWorker.ts', import.meta.url), {
      type: 'module',
    })
  }
  return sharedWorker
}

function resetWorker(): void {
  if (sharedWorker) {
    sharedWorker.terminate()
    sharedWorker = null
  }
}

interface WorkerInferenceArgs {
  modelKey: string
  modelBuffer?: ArrayBuffer
  srcRgba: ArrayBuffer
  srcW: number
  srcH: number
  tileSize: number
  preferWebGPU: boolean
  fallbackScale: number
  wasmBaseUrl: string
  suppressTileProgress?: boolean
  outCanvas: HTMLCanvasElement
  tileOutCanvas: HTMLCanvasElement
  onProgress?: (p: ProgressInfo) => void
  signal?: AbortSignal
}

async function loadOnnxModelAsset(
  modelSpec: OnnxModelSpec,
  customModelFile: File | null | undefined,
  preferWebGPU: boolean,
  onProgress?: (p: ProgressInfo) => void,
  signal?: AbortSignal
): Promise<{ modelKey: string; modelBuffer: ArrayBuffer; canUseWebGpu: boolean }> {
  const modelKey = customModelFile
    ? `local:${customModelFile.name}:${customModelFile.size}`
    : modelSpec.url

  let modelBuffer: ArrayBuffer
  if (customModelFile) {
    onProgress?.({ percent: 8, stage: `Membaca model lokal ${customModelFile.name}...` })
    modelBuffer = await customModelFile.arrayBuffer()
  } else {
    modelBuffer = await fetchModelBuffer(modelSpec.url, onProgress, signal)
  }

  if (signal?.aborted) throw new DOMException('Dibatalkan', 'AbortError')

  let canUseWebGpu = preferWebGPU
  if (canUseWebGpu && modelSpec.isFp16) {
    canUseWebGpu = await hasWebGpuShaderF16()
  }

  return { modelKey, modelBuffer, canUseWebGpu }
}

async function runWorkerInference(
  args: WorkerInferenceArgs
): Promise<{ provider: string; scale: number; totalW: number; totalH: number }> {
  const worker = getOrCreateWorker()
  let outCtx: CanvasRenderingContext2D | null = null

  return new Promise((resolve, reject) => {
    const cleanup = () => {
      worker.onmessage = null
      worker.onerror = null
      args.signal?.removeEventListener('abort', onAbort)
    }

    const onAbort = () => {
      cleanup()
      resetWorker()
      reject(new DOMException('Dibatalkan', 'AbortError'))
    }

    args.signal?.addEventListener('abort', onAbort, { once: true })

    worker.onerror = (ev) => {
      cleanup()
      resetWorker()
      reject(new Error(ev.message || 'Worker ONNX mengalami error'))
    }

    worker.onmessage = (event: MessageEvent<OnnxWorkerMessage>) => {
      const msg = event.data
      if (msg.type === 'progress') {
        args.onProgress?.({ percent: msg.percent, stage: msg.stage, detail: msg.detail })
        return
      }
      if (msg.type === 'tile') {
        if (!outCtx) {
          if (args.outCanvas.width !== msg.totalW) args.outCanvas.width = msg.totalW
          if (args.outCanvas.height !== msg.totalH) args.outCanvas.height = msg.totalH
          outCtx = args.outCanvas.getContext('2d')
          if (!outCtx) {
            cleanup()
            reject(new Error('Gagal membuat canvas output AI'))
            return
          }
        }
        const rgba = new Uint8ClampedArray(msg.tileRgba)
        if (args.tileOutCanvas.width !== msg.validOutW) args.tileOutCanvas.width = msg.validOutW
        if (args.tileOutCanvas.height !== msg.validOutH) args.tileOutCanvas.height = msg.validOutH
        const tileOutCtx = args.tileOutCanvas.getContext('2d')
        if (tileOutCtx && outCtx) {
          tileOutCtx.putImageData(new ImageData(rgba, msg.validOutW, msg.validOutH), 0, 0)
          outCtx.drawImage(
            args.tileOutCanvas,
            msg.cropX,
            msg.cropY,
            msg.swOut,
            msg.shOut,
            msg.dstX,
            msg.dstY,
            msg.swOut,
            msg.shOut
          )
        }
        return
      }
      if (msg.type === 'done') {
        cleanup()
        resolve({
          provider: msg.provider,
          scale: msg.scale,
          totalW: msg.totalW,
          totalH: msg.totalH,
        })
        return
      }
      if (msg.type === 'error') {
        cleanup()
        reject(new Error(msg.message))
      }
    }

    const req: OnnxWorkerRequest = {
      modelKey: args.modelKey,
      modelBuffer: args.modelBuffer,
      srcRgba: args.srcRgba,
      srcW: args.srcW,
      srcH: args.srcH,
      tileSize: args.tileSize,
      preferWebGPU: args.preferWebGPU,
      fallbackScale: args.fallbackScale,
      wasmBaseUrl: args.wasmBaseUrl,
      suppressTileProgress: args.suppressTileProgress,
    }
    const transfers: Transferable[] = [args.srcRgba]
    if (args.modelBuffer) transfers.push(args.modelBuffer)
    worker.postMessage(req, transfers)
  })
}

export async function upscaleImageWithOnnx(
  bitmap: ImageBitmap,
  modelSpec: OnnxModelSpec,
  customModelFile: File | null | undefined,
  tileSize: number,
  preferWebGPU: boolean,
  isMobile: boolean,
  outputFormat: OutputImageFormat,
  onProgress?: (p: ProgressInfo) => void,
  signal?: AbortSignal
): Promise<{ blob: Blob; width: number; height: number; provider: string; scale: number }> {
  const { modelKey, modelBuffer, canUseWebGpu } = await loadOnnxModelAsset(
    modelSpec,
    customModelFile,
    preferWebGPU,
    onProgress,
    signal
  )

  const srcW = bitmap.width
  const srcH = bitmap.height
  const maxDim = isMobile ? 4096 : 8192
  const maxPixels = isMobile ? 16_000_000 : 48_000_000
  const expectedOutW = srcW * modelSpec.scale
  const expectedOutH = srcH * modelSpec.scale
  if (expectedOutW > maxDim || expectedOutH > maxDim || expectedOutW * expectedOutH > maxPixels) {
    throw new Error(
      `Ukuran hasil ${expectedOutW}×${expectedOutH} terlalu besar untuk memori canvas browser (${isMobile ? 'HP' : 'Laptop'}). Gunakan skala 2× atau kecilkan foto sumber terlebih dahulu.`
    )
  }

  const srcCanvas = document.createElement('canvas')
  srcCanvas.width = srcW
  srcCanvas.height = srcH
  const srcCtx = srcCanvas.getContext('2d', { willReadFrequently: true })
  if (!srcCtx) throw new Error('Gagal membuat canvas sumber')
  srcCtx.drawImage(bitmap, 0, 0)
  const srcImgData = srcCtx.getImageData(0, 0, srcW, srcH)

  const outCanvas = document.createElement('canvas')
  const tileOutCanvas = document.createElement('canvas')
  const wasmBaseUrl = new URL(`${import.meta.env.BASE_URL}ort/`, window.location.origin).href

  const doneInfo = await runWorkerInference({
    modelKey,
    modelBuffer,
    srcRgba: srcImgData.data.buffer,
    srcW,
    srcH,
    tileSize,
    preferWebGPU: canUseWebGpu,
    fallbackScale: modelSpec.scale,
    wasmBaseUrl,
    outCanvas,
    tileOutCanvas,
    onProgress,
    signal,
  })

  onProgress?.({ percent: 96, stage: 'Menyimpan hasil HD...' })
  const blob = await canvasToBlob(outCanvas, outputFormat)
  return {
    blob,
    width: doneInfo.totalW,
    height: doneInfo.totalH,
    provider: doneInfo.provider,
    scale: doneInfo.scale,
  }
}
