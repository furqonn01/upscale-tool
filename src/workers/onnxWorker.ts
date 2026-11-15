import * as ort from 'onnxruntime-web'

export interface OnnxWorkerRequest {
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
}

export type OnnxWorkerMessage =
  | { type: 'progress'; percent: number; stage: string; detail?: string }
  | {
      type: 'tile'
      tileRgba: ArrayBuffer
      validOutW: number
      validOutH: number
      cropX: number
      cropY: number
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

let cachedRawModelKey = ''
let cachedModelBytes: Uint8Array | null = null
let cachedKey = ''
let cachedSession: ort.InferenceSession | null = null
let cachedProvider = 'WASM'
const webGpuFailedModels = new Set<string>()

const workerCtx = self as unknown as {
  onmessage: ((event: MessageEvent<OnnxWorkerRequest>) => void) | null
  postMessage: (message: OnnxWorkerMessage, transfer?: Transferable[]) => void
}

function alignToMultiple(value: number, multiple: number): number {
  return Math.ceil(value / multiple) * multiple
}

function extractPatchNchwFloat32(
  srcRgba: Uint8ClampedArray,
  srcW: number,
  px0: number,
  py0: number,
  patchW: number,
  patchH: number,
  paddedW: number,
  paddedH: number
): Float32Array {
  const area = paddedW * paddedH
  const out = new Float32Array(3 * area)
  for (let y = 0; y < paddedH; y++) {
    const sy = py0 + Math.min(y, patchH - 1)
    for (let x = 0; x < paddedW; x++) {
      const sx = px0 + Math.min(x, patchW - 1)
      const srcIdx = (sy * srcW + sx) * 4
      const dstIdx = y * paddedW + x
      out[dstIdx] = srcRgba[srcIdx] / 255
      out[area + dstIdx] = srcRgba[srcIdx + 1] / 255
      out[2 * area + dstIdx] = srcRgba[srcIdx + 2] / 255
    }
  }
  return out
}

function analyzeTensorStats(arr: ArrayLike<number>): { max: number; nanCount: number } {
  let max = -Infinity
  let nanCount = 0
  const step = Math.max(1, Math.floor(arr.length / 4096))
  for (let i = 0; i < arr.length; i += step) {
    const v = Number(arr[i])
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
  wasmBaseUrl: string
): Promise<{ session: ort.InferenceSession; provider: string }> {
  if (modelBuffer) {
    cachedModelBytes = new Uint8Array(modelBuffer)
    cachedRawModelKey = modelKey
  }

  const allowGpu = preferWebGPU && !webGpuFailedModels.has(modelKey)
  const effectiveKey = `${modelKey}:${allowGpu ? 'webgpu' : 'wasm'}`
  if (cachedSession && cachedKey === effectiveKey) {
    return { session: cachedSession, provider: cachedProvider }
  }

  if (!cachedModelBytes || cachedRawModelKey !== modelKey) {
    throw new Error('Buffer model AI belum dimuat di worker')
  }

  ort.env.wasm.wasmPaths = wasmBaseUrl
  ort.env.wasm.numThreads = 1
  ort.env.wasm.simd = true

  if (cachedSession) {
    await cachedSession.release().catch(() => undefined)
    cachedSession = null
    cachedKey = ''
  }

  const hasGpu = allowGpu && typeof navigator !== 'undefined' && 'gpu' in navigator
  let session: ort.InferenceSession
  let provider = 'WASM'

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
      session = await ort.InferenceSession.create(cachedModelBytes, {
        executionProviders: ['wasm'],
        graphOptimizationLevel: 'all',
      })
      provider = 'WASM'
    }
  } else {
    session = await ort.InferenceSession.create(cachedModelBytes, {
      executionProviders: ['wasm'],
      graphOptimizationLevel: 'all',
    })
    provider = 'WASM'
  }

  cachedSession = session
  cachedKey = effectiveKey
  cachedProvider = provider
  return { session, provider }
}

workerCtx.onmessage = async (event: MessageEvent<OnnxWorkerRequest>) => {
  const req = event.data
  try {
    const srcRgba = new Uint8ClampedArray(req.srcRgba)
    const { srcW, srcH, tileSize } = req

    if (!req.suppressTileProgress) {
      workerCtx.postMessage({
        type: 'progress',
        percent: 24,
        stage: 'Mengompilasi graph model AI...',
        detail: 'Berjalan di background thread agar UI tetap responsif',
      })
    }

    let { session, provider } = await getSession(
      req.modelKey,
      req.modelBuffer,
      req.preferWebGPU,
      req.wasmBaseUrl
    )

    const inputName = session.inputNames[0]
    const outputName = session.outputNames[0]
    if (!inputName || !outputName) {
      throw new Error('Model ONNX tidak memiliki input/output tensor yang valid')
    }

    const overlap = 12
    // On 4x models, keep tile size <= 192px so WebGPU intermediate buffers stay well below maxStorageBufferBindingSize
    const effectiveTileSize =
      req.fallbackScale >= 4 ? Math.min(tileSize, 192) : tileSize
    const cols = Math.ceil(srcW / effectiveTileSize)
    const rows = Math.ceil(srcH / effectiveTileSize)
    const totalTiles = cols * rows

    let detectedScale = req.fallbackScale
    let tileIndex = 0

    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
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

        const paddedW = alignToMultiple(patchW, 16)
        const paddedH = alignToMultiple(patchH, 16)

        if (!req.suppressTileProgress) {
          workerCtx.postMessage({
            type: 'progress',
            percent: 25 + Math.round((tileIndex / totalTiles) * 68),
            stage: `AI Super-Resolution (${provider}) — Tile ${tileIndex + 1}/${totalTiles}`,
            detail: `${srcW}×${srcH} • tile ${paddedW}×${paddedH}`,
          })
        }

        const tensorData = extractPatchNchwFloat32(
          srcRgba,
          srcW,
          px0,
          py0,
          patchW,
          patchH,
          paddedW,
          paddedH
        )
        const inputTensor = new ort.Tensor('float32', tensorData, [1, 3, paddedH, paddedW])
        let outputTensor: ort.InferenceSession.OnnxValueMapType[string] | undefined

        try {
          let results: ort.InferenceSession.OnnxValueMapType
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
              const fb = await getSession(req.modelKey, undefined, false, req.wasmBaseUrl)
              session = fb.session
              provider = fb.provider
              results = await session.run({ [inputName]: inputTensor })
            } else {
              throw runErr
            }
          }
          outputTensor = results[outputName]

          // Validate Tile 0: auto-fallback to WASM if WebGPU returned NaN or all-black zeros
          if (tileIndex === 0 && provider === 'WebGPU') {
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
              const fb = await getSession(req.modelKey, undefined, false, req.wasmBaseUrl)
              session = fb.session
              provider = fb.provider
              results = await session.run({ [inputName]: inputTensor })
              outputTensor = results[outputName]
            }
          }

          const dims = outputTensor.dims
          const outPatchH = dims[dims.length - 2]
          const outPatchW = dims[dims.length - 1]
          if (tileIndex === 0) {
            detectedScale = Math.max(1, Math.round(outPatchW / paddedW))
          }

          const rawOut = outputTensor.data as ArrayLike<number>
          const outStats = analyzeTensorStats(rawOut)
          const mul = outStats.max > 2.5 ? 1 : 255
          const outArea = outPatchW * outPatchH
          const validOutW = patchW * detectedScale
          const validOutH = patchH * detectedScale
          const tileRgba = new Uint8ClampedArray(validOutW * validOutH * 4)

          for (let y = 0; y < validOutH; y++) {
            for (let x = 0; x < validOutW; x++) {
              const srcPos = y * outPatchW + x
              const dstPos = (y * validOutW + x) * 4
              const rVal = Number(rawOut[srcPos])
              const gVal = Number(rawOut[outArea + srcPos])
              const bVal = Number(rawOut[2 * outArea + srcPos])
              tileRgba[dstPos] = Number.isFinite(rVal) ? Math.max(0, Math.min(255, Math.round(rVal * mul))) : 0
              tileRgba[dstPos + 1] = Number.isFinite(gVal) ? Math.max(0, Math.min(255, Math.round(gVal * mul))) : 0
              tileRgba[dstPos + 2] = Number.isFinite(bVal) ? Math.max(0, Math.min(255, Math.round(bVal * mul))) : 0
              tileRgba[dstPos + 3] = 255
            }
          }

          const tileMsg: OnnxWorkerMessage = {
            type: 'tile',
            tileRgba: tileRgba.buffer,
            validOutW,
            validOutH,
            cropX: (sx - px0) * detectedScale,
            cropY: (sy - py0) * detectedScale,
            swOut: sw * detectedScale,
            shOut: sh * detectedScale,
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

        tileIndex++
      }
    }

    workerCtx.postMessage({
      type: 'done',
      provider,
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
