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

interface WorkerSlot {
  worker: Worker
  loadedModelKey: string
  modelByteLength: number
}

const workerPool: WorkerSlot[] = []

function getOrCreateWorkerSlot(index: number): WorkerSlot {
  while (workerPool.length <= index) {
    workerPool.push({
      worker: new Worker(new URL('../workers/onnxWorker.ts', import.meta.url), {
        type: 'module',
      }),
      loadedModelKey: '',
      modelByteLength: 0,
    })
  }
  return workerPool[index]
}

function resetWorkerSlot(index: number): void {
  const slot = workerPool[index]
  if (slot) {
    slot.worker.terminate()
    slot.worker = new Worker(new URL('../workers/onnxWorker.ts', import.meta.url), {
      type: 'module',
    })
    slot.loadedModelKey = ''
    slot.modelByteLength = 0
  }
}

function resetAllWorkers(): void {
  for (let i = 0; i < workerPool.length; i++) {
    resetWorkerSlot(i)
  }
}

interface WorkerInferenceArgs {
  slotIndex: number
  modelKey: string
  modelBuffer?: ArrayBuffer
  srcRgba: ArrayBuffer
  srcW: number
  srcH: number
  tileSize: number
  preferWebGPU: boolean
  isMobile: boolean
  fallbackScale: number
  wasmBaseUrl: string
  tileOffset: number
  tileStride: number
  suppressTileProgress?: boolean
  outCanvas: HTMLCanvasElement
  getOutCtx: (totalW: number, totalH: number) => CanvasRenderingContext2D
  onProgress?: (p: ProgressInfo) => void
  signal?: AbortSignal
}

function runWorkerInference(
  args: WorkerInferenceArgs
): Promise<{ provider: string; scale: number; totalW: number; totalH: number }> {
  const slot = getOrCreateWorkerSlot(args.slotIndex)
  const worker = slot.worker

  return new Promise((resolve, reject) => {
    const cleanup = () => {
      worker.onmessage = null
      worker.onerror = null
      args.signal?.removeEventListener('abort', onAbort)
    }

    const onAbort = () => {
      cleanup()
      resetAllWorkers()
      reject(new DOMException('Dibatalkan', 'AbortError'))
    }

    args.signal?.addEventListener('abort', onAbort, { once: true })

    worker.onerror = (ev) => {
      cleanup()
      resetWorkerSlot(args.slotIndex)
      reject(new Error(ev.message || 'Worker ONNX mengalami error'))
    }

    worker.onmessage = (event: MessageEvent<OnnxWorkerMessage>) => {
      const msg = event.data
      if (msg.type === 'progress') {
        args.onProgress?.({ percent: msg.percent, stage: msg.stage, detail: msg.detail })
        return
      }
      if (msg.type === 'tile') {
        try {
          const outCtx = args.getOutCtx(msg.totalW, msg.totalH)
          const rgba = new Uint8ClampedArray(msg.tileRgba)
          outCtx.putImageData(new ImageData(rgba, msg.swOut, msg.shOut), msg.dstX, msg.dstY)
        } catch (err) {
          cleanup()
          reject(err instanceof Error ? err : new Error('Gagal menulis tile output AI'))
        }
        return
      }
      if (msg.type === 'done') {
        cleanup()
        slot.loadedModelKey = args.modelKey
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
        if (!args.modelBuffer) {
          slot.loadedModelKey = ''
        }
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
      isMobile: args.isMobile,
      fallbackScale: args.fallbackScale,
      wasmBaseUrl: args.wasmBaseUrl,
      tileOffset: args.tileOffset,
      tileStride: args.tileStride,
      suppressTileProgress: args.suppressTileProgress,
    }
    const transfers: Transferable[] = [args.srcRgba]
    if (args.modelBuffer) {
      slot.modelByteLength = args.modelBuffer.byteLength
      transfers.push(args.modelBuffer)
    }
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
  const modelKey = customModelFile
    ? `local:${customModelFile.name}:${customModelFile.size}`
    : modelSpec.url

  const srcW = bitmap.width
  const srcH = bitmap.height
  const maxDim = isMobile ? 4096 : 8192
  const maxPixels = isMobile ? 16_000_000 : 48_000_000
  const expectedOutW = srcW * modelSpec.scale
  const expectedOutH = srcH * modelSpec.scale
  if (expectedOutW > maxDim || expectedOutH > maxDim || expectedOutW * expectedOutH > maxPixels) {
    throw new Error(
      `Ukuran hasil ${expectedOutW}×${expectedOutH} terlalu besar untuk memori canvas browser (${isMobile ? 'HP' : 'Laptop'}). Gunakan skala 2× atau aktifkan Auto-Fit HP.`
    )
  }

  let canUseWebGpu = preferWebGPU
  if (canUseWebGpu && modelSpec.isFp16) {
    canUseWebGpu = await hasWebGpuShaderF16()
  }

  const effectiveTileSize = modelSpec.scale >= 4 ? Math.min(tileSize, 192) : tileSize
  const totalTiles = Math.ceil(srcW / effectiveTileSize) * Math.ceil(srcH / effectiveTileSize)
  const isCrossOriginIsolated =
    typeof window !== 'undefined' && Boolean(window.crossOriginIsolated)
  const hwCores = typeof navigator !== 'undefined' ? navigator.hardwareConcurrency || 4 : 4

  // When crossOriginIsolated is unavailable on a multi-core laptop, fan out WASM tiles across 2 workers for ~1.8x speedup
  const slot0 = getOrCreateWorkerSlot(0)
  const knownModelSize =
    slot0.loadedModelKey === modelKey
      ? slot0.modelByteLength
      : customModelFile?.size ?? 0

  const canUseDualWasmPool =
    !isMobile &&
    !canUseWebGpu &&
    !isCrossOriginIsolated &&
    hwCores >= 4 &&
    totalTiles >= 4 &&
    knownModelSize <= 25_000_000

  let modelBuffer: ArrayBuffer | undefined
  const needSlot0Buffer = slot0.loadedModelKey !== modelKey
  const needSlot1Buffer =
    canUseDualWasmPool && workerPool[1]?.loadedModelKey !== modelKey

  if (needSlot0Buffer || needSlot1Buffer) {
    if (customModelFile) {
      onProgress?.({ percent: 8, stage: `Membaca model lokal ${customModelFile.name}...` })
      modelBuffer = await customModelFile.arrayBuffer()
    } else {
      modelBuffer = await fetchModelBuffer(modelSpec.url, onProgress, signal)
    }
    if (signal?.aborted) throw new DOMException('Dibatalkan', 'AbortError')
  } else {
    onProgress?.({ percent: 18, stage: 'Menggunakan sesi model AI di memori...' })
  }

  const useDualWasm =
    canUseDualWasmPool &&
    ((modelBuffer ? modelBuffer.byteLength : knownModelSize) <= 25_000_000)

  const srcCanvas = document.createElement('canvas')
  srcCanvas.width = srcW
  srcCanvas.height = srcH
  const srcCtx = srcCanvas.getContext('2d', { willReadFrequently: true })
  if (!srcCtx) throw new Error('Gagal membuat canvas sumber')
  srcCtx.drawImage(bitmap, 0, 0)
  const srcImgData = srcCtx.getImageData(0, 0, srcW, srcH)
  // Release source canvas memory immediately (critical on mobile)
  srcCanvas.width = 0
  srcCanvas.height = 0

  const outCanvas = document.createElement('canvas')
  let outCtx: CanvasRenderingContext2D | null = null
  const getOutCtx = (totalW: number, totalH: number): CanvasRenderingContext2D => {
    if (!outCtx) {
      if (outCanvas.width !== totalW) outCanvas.width = totalW
      if (outCanvas.height !== totalH) outCanvas.height = totalH
      outCtx = outCanvas.getContext('2d')
      if (!outCtx) throw new Error('Gagal membuat canvas output AI')
    }
    return outCtx
  }

  const wasmBaseUrl = new URL(`${import.meta.env.BASE_URL}ort/`, window.location.origin).href

  try {
    let doneInfo: { provider: string; scale: number; totalW: number; totalH: number }

    if (useDualWasm) {
      const srcCopy = srcImgData.data.buffer.slice(0)
      const buf0 = needSlot0Buffer && modelBuffer ? modelBuffer.slice(0) : undefined
      const buf1 = needSlot1Buffer && modelBuffer ? modelBuffer : undefined

      const [res0] = await Promise.all([
        runWorkerInference({
          slotIndex: 0,
          modelKey,
          modelBuffer: buf0,
          srcRgba: srcImgData.data.buffer,
          srcW,
          srcH,
          tileSize,
          preferWebGPU: false,
          isMobile,
          fallbackScale: modelSpec.scale,
          wasmBaseUrl,
          tileOffset: 0,
          tileStride: 2,
          outCanvas,
          getOutCtx,
          onProgress,
          signal,
        }),
        runWorkerInference({
          slotIndex: 1,
          modelKey,
          modelBuffer: buf1,
          srcRgba: srcCopy,
          srcW,
          srcH,
          tileSize,
          preferWebGPU: false,
          isMobile,
          fallbackScale: modelSpec.scale,
          wasmBaseUrl,
          tileOffset: 1,
          tileStride: 2,
          suppressTileProgress: true,
          outCanvas,
          getOutCtx,
          signal,
        }),
      ])
      doneInfo = res0
    } else {
      doneInfo = await runWorkerInference({
        slotIndex: 0,
        modelKey,
        modelBuffer: needSlot0Buffer ? modelBuffer : undefined,
        srcRgba: srcImgData.data.buffer,
        srcW,
        srcH,
        tileSize,
        preferWebGPU: canUseWebGpu,
        isMobile,
        fallbackScale: modelSpec.scale,
        wasmBaseUrl,
        tileOffset: 0,
        tileStride: 1,
        outCanvas,
        getOutCtx,
        onProgress,
        signal,
      })
    }

    onProgress?.({ percent: 96, stage: 'Menyimpan hasil HD...' })
    const blob = await canvasToBlob(outCanvas, outputFormat)
    return {
      blob,
      width: doneInfo.totalW,
      height: doneInfo.totalH,
      provider: doneInfo.provider,
      scale: doneInfo.scale,
    }
  } finally {
    outCanvas.width = 0
    outCanvas.height = 0
  }
}
