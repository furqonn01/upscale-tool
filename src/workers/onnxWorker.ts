import type * as OrtTypes from 'onnxruntime-web'

type OrtModule = typeof OrtTypes

export interface OnnxWorkerRequest {
  modelKey: string
  modelBuffer?: ArrayBuffer
  srcRgba: ArrayBuffer
  srcW: number
  srcH: number
  tileSize: number
  preferWebGPU: boolean
  isMobile?: boolean
  fallbackScale: number
  wasmBaseUrl: string
  tileOffset?: number
  tileStride?: number
  suppressTileProgress?: boolean
}

export type OnnxWorkerMessage =
  | { type: 'progress'; percent: number; stage: string; detail?: string }
  | {
      type: 'tile'
      tileRgba: ArrayBuffer
      swOut: number
      shOut: number
      dstX: number
      dstY: number
      detectedScale: number
      totalW: number
      totalH: number
    }
  | { type: 'done'; provider: string; scale: number; totalW: number; totalH: number }
  | { type: 'error'; message: string }

let ortFullModule: OrtModule | null = null
let ortWasmModule: OrtModule | null = null

let cachedRawModelKey = ''
let cachedModelBytes: Uint8Array | null = null
let cachedKey = ''
let cachedSession: OrtTypes.InferenceSession | null = null
let cachedProvider = 'WASM'
const webGpuFailedModels = new Set<string>()

let scratchPatchBuf: Float32Array | null = null

const workerCtx = self as unknown as {
  name?: string
  crossOriginIsolated?: boolean
  onmessage: ((event: MessageEvent<OnnxWorkerRequest>) => void) | null
  postMessage: (message: OnnxWorkerMessage, transfer?: Transferable[]) => void
}

async function loadOrtModule(needWebGpu: boolean): Promise<OrtModule> {
  if (needWebGpu) {
    if (!ortFullModule) {
      ortFullModule = (await import('onnxruntime-web')) as OrtModule
    }
    return ortFullModule
  }
  if (ortFullModule) return ortFullModule
  if (!ortWasmModule) {
    ortWasmModule = (await import('onnxruntime-web/wasm')) as OrtModule
  }
  return ortWasmModule
}

function alignToMultiple(value: number, multiple: number): number {
  return Math.ceil(value / multiple) * multiple
}

function extractPatchNchwFloat32(
  srcRgba: Uint8ClampedArray,
  srcW: number,
  srcH: number,
  px0: number,
  py0: number,
  patchW: number,
  patchH: number,
  paddedW: number,
  paddedH: number
): Float32Array {
  const area = paddedW * paddedH
  const needed = 3 * area
  if (!scratchPatchBuf || scratchPatchBuf.length !== needed) {
    scratchPatchBuf = new Float32Array(needed)
  }
  const out = scratchPatchBuf
  const area2 = 2 * area
  const INV_255 = 1 / 255

  const noClampY = py0 + paddedH <= srcH && paddedH === patchH
  const noClampX = px0 + paddedW <= srcW && paddedW === patchW

  if (noClampX && noClampY) {
    for (let y = 0; y < paddedH; y++) {
      let srcIdx = ((py0 + y) * srcW + px0) * 4
      let dstIdx = y * paddedW
      for (let x = 0; x < paddedW; x++, srcIdx += 4, dstIdx++) {
        out[dstIdx] = srcRgba[srcIdx] * INV_255
        out[area + dstIdx] = srcRgba[srcIdx + 1] * INV_255
        out[area2 + dstIdx] = srcRgba[srcIdx + 2] * INV_255
      }
    }
    return out
  }

  for (let y = 0; y < paddedH; y++) {
    const sy = py0 + (y < patchH ? y : patchH - 1)
    const rowOffset = sy * srcW
    const dstRowOffset = y * paddedW
    for (let x = 0; x < paddedW; x++) {
      const sx = px0 + (x < patchW ? x : patchW - 1)
      const srcIdx = (rowOffset + sx) * 4
      const dstIdx = dstRowOffset + x
      out[dstIdx] = srcRgba[srcIdx] * INV_255
      out[area + dstIdx] = srcRgba[srcIdx + 1] * INV_255
      out[area2 + dstIdx] = srcRgba[srcIdx + 2] * INV_255
    }
  }
  return out
}

function analyzeTensorStats(arr: ArrayLike<number>): { max: number; nanCount: number } {
  let max = -Infinity
  let nanCount = 0
  const step = Math.max(1, Math.floor(arr.length / 4096))
  for (let i = 0; i < arr.length; i += step) {
    const v = arr[i]
    if (!Number.isFinite(v)) {
      nanCount++
      continue
    }
    if (v > max) max = v
  }
  return { max, nanCount }
}

async function getSession(
  modelKey: string,
  modelBuffer: ArrayBuffer | undefined,
  preferWebGPU: boolean,
  isMobile: boolean,
  wasmBaseUrl: string
): Promise<{ ort: OrtModule; session: OrtTypes.InferenceSession; provider: string }> {
  if (modelBuffer) {
    cachedModelBytes = new Uint8Array(modelBuffer)
    cachedRawModelKey = modelKey
  }

  const hasGpu =
    preferWebGPU &&
    !webGpuFailedModels.has(modelKey) &&
    typeof navigator !== 'undefined' &&
    'gpu' in navigator

  const ort = await loadOrtModule(hasGpu)

  const supportsThreads = Boolean(workerCtx.crossOriginIsolated)
  const hwCores = typeof navigator !== 'undefined' ? navigator.hardwareConcurrency || 4 : 4
  const wasmThreads = supportsThreads ? Math.min(isMobile ? 2 : 4, Math.max(1, hwCores)) : 1

  const effectiveKey = `${modelKey}:${hasGpu ? 'webgpu' : `wasm-t${wasmThreads}`}`
  if (cachedSession && cachedKey === effectiveKey) {
    return { ort, session: cachedSession, provider: cachedProvider }
  }

  if (!cachedModelBytes || cachedRawModelKey !== modelKey) {
    throw new Error('Buffer model AI belum dimuat di worker')
  }

  ort.env.wasm.wasmPaths = wasmBaseUrl
  ort.env.wasm.numThreads = wasmThreads
  ort.env.wasm.simd = true
  ort.env.wasm.proxy = false

  if (cachedSession) {
    await cachedSession.release().catch(() => undefined)
    cachedSession = null
    cachedKey = ''
  }

  const wasmSessionOpts: OrtTypes.InferenceSession.SessionOptions = {
    executionProviders: ['wasm'],
    graphOptimizationLevel: 'all',
    enableCpuMemArena: true,
    enableMemPattern: true,
    executionMode: 'sequential',
  }

  let session: OrtTypes.InferenceSession
  let provider = supportsThreads && wasmThreads > 1 ? `WASM ${wasmThreads}T` : 'WASM'

  if (hasGpu) {
    try {
      session = await ort.InferenceSession.create(cachedModelBytes, {
        executionProviders: [
          {
            name: 'webgpu',
            preferredLayout: 'NCHW',
            // Keep Clip clamp on CPU so JSEP WebGPU never fails on NHWC/large final Clip output tensors
            forceCpuNodeNames: ['/Clip', 'Clip'],
          },
          'wasm',
        ],
        graphOptimizationLevel: 'all',
      })
      provider = 'WebGPU'
    } catch {
      webGpuFailedModels.add(modelKey)
      session = await ort.InferenceSession.create(cachedModelBytes, wasmSessionOpts)
      provider = supportsThreads && wasmThreads > 1 ? `WASM ${wasmThreads}T` : 'WASM'
    }
  } else {
    session = await ort.InferenceSession.create(cachedModelBytes, wasmSessionOpts)
  }

  cachedSession = session
  cachedKey = effectiveKey
  cachedProvider = provider
  return { ort, session, provider }
}

// Guard against nested Emscripten pthread workers executing the main worker message handler
if (!workerCtx.name?.startsWith('em-pthread')) {
  workerCtx.onmessage = async (event: MessageEvent<OnnxWorkerRequest>) => {
    const req = event.data
    try {
      const srcRgba = new Uint8ClampedArray(req.srcRgba)
      const { srcW, srcH, tileSize } = req
      const isMobile = Boolean(req.isMobile)
      const tileOffset = req.tileOffset ?? 0
      const tileStride = Math.max(1, req.tileStride ?? 1)

      if (!req.suppressTileProgress && tileOffset === 0) {
        workerCtx.postMessage({
          type: 'progress',
          percent: 24,
          stage: 'Mengompilasi graph model AI...',
          detail: workerCtx.crossOriginIsolated
            ? 'Multi-thread SIMD aktif di background thread'
            : 'Berjalan di background thread agar UI tetap responsif',
        })
      }

      let { ort, session, provider } = await getSession(
        req.modelKey,
        req.modelBuffer,
        req.preferWebGPU,
        isMobile,
        req.wasmBaseUrl
      )

      const inputName = session.inputNames[0]
      const outputName = session.outputNames[0]
      if (!inputName || !outputName) {
        throw new Error('Model ONNX tidak memiliki input/output tensor yang valid')
      }

      const overlap = 8
      // On 4x models, keep tile size <= 192px so WebGPU/WASM intermediate buffers stay memory-safe
      const effectiveTileSize =
        req.fallbackScale >= 4 ? Math.min(tileSize, 192) : tileSize
      const cols = Math.ceil(srcW / effectiveTileSize)
      const rows = Math.ceil(srcH / effectiveTileSize)
      const totalTiles = cols * rows

      let detectedScale = req.fallbackScale
      let detectedMul: number | null = null
      let processedByMe = 0

      for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
          const tileIndex = r * cols + c
          if (tileIndex % tileStride !== tileOffset) {
            continue
          }

          const sx = c * effectiveTileSize
          const sy = r * effectiveTileSize
          const sw = Math.min(effectiveTileSize, srcW - sx)
          const sh = Math.min(effectiveTileSize, srcH - sy)

          const px0 = Math.max(0, sx - overlap)
          const py0 = Math.max(0, sy - overlap)
          const px1 = Math.min(srcW, sx + sw + overlap)
          const py1 = Math.min(srcH, sy + sh + overlap)
          const patchW = px1 - px0
          const patchH = py1 - py0

          // Align to 8px (Swin2SR window size = 8; avoids bloated 16px extra padding)
          const paddedW = alignToMultiple(patchW, 8)
          const paddedH = alignToMultiple(patchH, 8)

          if (!req.suppressTileProgress && tileOffset === 0) {
            const approxDone = Math.min(totalTiles, processedByMe * tileStride + 1)
            workerCtx.postMessage({
              type: 'progress',
              percent: 25 + Math.round((approxDone / totalTiles) * 68),
              stage: `AI Super-Resolution (${provider}${tileStride > 1 ? ` ×${tileStride}` : ''}) — Tile ${approxDone}/${totalTiles}`,
              detail: `${srcW}×${srcH} • tile ${paddedW}×${paddedH}`,
            })
          }

          const tensorData = extractPatchNchwFloat32(
            srcRgba,
            srcW,
            srcH,
            px0,
            py0,
            patchW,
            patchH,
            paddedW,
            paddedH
          )
          const inputTensor = new ort.Tensor('float32', tensorData, [1, 3, paddedH, paddedW])
          let outputTensor: OrtTypes.InferenceSession.OnnxValueMapType[string] | undefined

          try {
            let results: OrtTypes.InferenceSession.OnnxValueMapType
            try {
              results = await session.run({ [inputName]: inputTensor })
            } catch (runErr) {
              if (provider === 'WebGPU') {
                webGpuFailedModels.add(req.modelKey)
                if (!req.suppressTileProgress) {
                  workerCtx.postMessage({
                    type: 'progress',
                    percent: 25 + Math.round((tileIndex / totalTiles) * 68),
                    stage: 'WebGPU tidak mendukung node model, beralih otomatis ke WASM...',
                  })
                }
                const fb = await getSession(
                  req.modelKey,
                  undefined,
                  false,
                  isMobile,
                  req.wasmBaseUrl
                )
                ort = fb.ort
                session = fb.session
                provider = fb.provider
                results = await session.run({ [inputName]: inputTensor })
              } else {
                throw runErr
              }
            }
            outputTensor = results[outputName]

            // Validate first tile on WebGPU: auto-fallback to WASM if WebGPU returned NaN or all-black zeros
            if (processedByMe === 0 && provider === 'WebGPU') {
              const inStats = analyzeTensorStats(tensorData)
              const outStats = analyzeTensorStats(outputTensor.data as ArrayLike<number>)
              if (outStats.nanCount > 0 || (inStats.max > 0.03 && outStats.max <= 0.001)) {
                outputTensor.dispose()
                webGpuFailedModels.add(req.modelKey)
                if (!req.suppressTileProgress) {
                  workerCtx.postMessage({
                    type: 'progress',
                    percent: 25,
                    stage: 'WebGPU tidak cocok dengan model ini, beralih ke WASM...',
                  })
                }
                const fb = await getSession(
                  req.modelKey,
                  undefined,
                  false,
                  isMobile,
                  req.wasmBaseUrl
                )
                ort = fb.ort
                session = fb.session
                provider = fb.provider
                results = await session.run({ [inputName]: inputTensor })
                outputTensor = results[outputName]
              }
            }

            const dims = outputTensor.dims
            const outPatchH = dims[dims.length - 2]
            const outPatchW = dims[dims.length - 1]
            if (processedByMe === 0) {
              detectedScale = Math.max(1, Math.round(outPatchW / paddedW))
            }

            const rawOut = outputTensor.data as Float32Array
            if (detectedMul === null) {
              const outStats = analyzeTensorStats(rawOut)
              detectedMul = outStats.max > 2.5 ? 1 : 255
            }
            const mul = detectedMul
            const outArea = outPatchW * outPatchH
            const outArea2 = 2 * outArea

            const cropX = (sx - px0) * detectedScale
            const cropY = (sy - py0) * detectedScale
            const swOut = sw * detectedScale
            const shOut = sh * detectedScale
            const tileRgba = new Uint8ClampedArray(swOut * shOut * 4)

            // Crop overlap directly into tightly-packed output RGBA buffer using native Uint8ClampedArray clamping
            let dstPos = 0
            for (let y = 0; y < shOut; y++) {
              let srcPos = (cropY + y) * outPatchW + cropX
              for (let x = 0; x < swOut; x++, srcPos++, dstPos += 4) {
                tileRgba[dstPos] = rawOut[srcPos] * mul
                tileRgba[dstPos + 1] = rawOut[outArea + srcPos] * mul
                tileRgba[dstPos + 2] = rawOut[outArea2 + srcPos] * mul
                tileRgba[dstPos + 3] = 255
              }
            }

            const tileMsg: OnnxWorkerMessage = {
              type: 'tile',
              tileRgba: tileRgba.buffer,
              swOut,
              shOut,
              dstX: sx * detectedScale,
              dstY: sy * detectedScale,
              detectedScale,
              totalW: srcW * detectedScale,
              totalH: srcH * detectedScale,
            }
            workerCtx.postMessage(tileMsg, [tileRgba.buffer])
          } finally {
            inputTensor.dispose()
            outputTensor?.dispose()
          }

          processedByMe++
        }
      }

      workerCtx.postMessage({
        type: 'done',
        provider: tileStride > 1 ? `${provider} ×${tileStride}` : provider,
        scale: detectedScale,
        totalW: srcW * detectedScale,
        totalH: srcH * detectedScale,
      })
    } catch (err) {
      workerCtx.postMessage({
        type: 'error',
        message: err instanceof Error ? err.message : String(err),
      })
    }
  }
}
