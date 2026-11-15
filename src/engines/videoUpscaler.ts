import { ArrayBufferTarget, Muxer } from 'mp4-muxer'
import type { ProgressInfo, VideoUpscaleOptions } from '../types'
import { parseMp4File, type Mp4AudioTrack, type Mp4VideoTrack } from './mp4Demuxer'
import { WebGLRestorationPipeline, type RestorationParams } from './webglProcessor'

export interface VideoUpscaleResult {
  blob: Blob
  mimeType: string
  width: number
  height: number
  duration: number
  pipelineUsed: 'webcodecs-mp4' | 'mediarecorder'
  providerLabel: string
  audioIncluded: boolean
}

function makeEven(n: number): number {
  return Math.max(2, Math.round(n / 2) * 2)
}

export function computeTargetVideoSize(
  srcW: number,
  srcH: number,
  scale: 1.5 | 2 | 3 | 4,
  maxShortSide: 720 | 1080 | 2160
): { width: number; height: number } {
  let targetW = srcW * scale
  let targetH = srcH * scale

  // Cap by short side so portrait 720p/1080p videos (e.g. TikTok/Reels 432x864 -> 864x1728) keep full HD detail
  const shortSide = Math.min(targetW, targetH)
  if (shortSide > maxShortSide) {
    const ratio = maxShortSide / shortSide
    targetW *= ratio
    targetH *= ratio
  }

  // Keep max dimension within H.264 Level 5.1 / browser WebGL safe limits (<= 3840)
  const longSide = Math.max(targetW, targetH)
  if (longSide > 3840) {
    const ratio = 3840 / longSide
    targetW *= ratio
    targetH *= ratio
  }

  return {
    width: makeEven(targetW),
    height: makeEven(targetH),
  }
}

async function ensureVideoFrameReady(
  video: HTMLVideoElement,
  signal?: AbortSignal
): Promise<void> {
  if (video.readyState >= 2) return
  if (video.readyState === 0) {
    try {
      video.load()
    } catch {
      // ignore load trigger errors
    }
  }
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup()
      if (video.readyState >= 2) resolve()
      else reject(new Error('Timeout memuat data frame video'))
    }, 8000)
    const onReady = () => {
      cleanup()
      resolve()
    }
    const onError = () => {
      cleanup()
      reject(new Error('Gagal memuat frame awal video'))
    }
    const onAbort = () => {
      cleanup()
      reject(new DOMException('Dibatalkan', 'AbortError'))
    }
    const cleanup = () => {
      clearTimeout(timer)
      video.removeEventListener('loadeddata', onReady)
      video.removeEventListener('canplay', onReady)
      video.removeEventListener('error', onError)
      signal?.removeEventListener('abort', onAbort)
    }
    video.addEventListener('loadeddata', onReady, { once: true })
    video.addEventListener('canplay', onReady, { once: true })
    video.addEventListener('error', onError, { once: true })
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

async function waitForSeek(
  video: HTMLVideoElement,
  timeSec: number,
  signal?: AbortSignal
): Promise<void> {
  if (signal?.aborted) throw new DOMException('Dibatalkan', 'AbortError')
  await ensureVideoFrameReady(video, signal)

  if (Math.abs(video.currentTime - timeSec) < 0.0005 && video.readyState >= 2 && !video.seeking) {
    return
  }

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup()
      if (video.readyState >= 2) {
        resolve()
      } else {
        reject(new Error(`Timeout seek frame video di ${timeSec.toFixed(2)}s`))
      }
    }, 8000)

    const onSeeked = () => {
      cleanup()
      resolve()
    }
    const onError = () => {
      cleanup()
      reject(new Error('Gagal membaca frame video'))
    }
    const onAbort = () => {
      cleanup()
      reject(new DOMException('Dibatalkan', 'AbortError'))
    }
    const cleanup = () => {
      clearTimeout(timer)
      video.removeEventListener('seeked', onSeeked)
      video.removeEventListener('error', onError)
      signal?.removeEventListener('abort', onAbort)
    }
    video.addEventListener('seeked', onSeeked, { once: true })
    video.addEventListener('error', onError, { once: true })
    signal?.addEventListener('abort', onAbort, { once: true })
    video.currentTime = timeSec
  })
}

async function pickSupportedAvcConfigs(
  width: number,
  height: number,
  fps: number
): Promise<VideoEncoderConfig[]> {
  if (typeof VideoEncoder === 'undefined') return []
  const bitrate = Math.min(28_000_000, Math.max(5_000_000, Math.round(width * height * fps * 0.28)))
  const isAbove1080p = width * height > 2_300_000
  // Prefer High Profile (avc1.6400xx) first for cleaner 8x8 transform and fewer compression blocks
  const codecs = isAbove1080p
    ? ['avc1.640033', 'avc1.64002a', 'avc1.4d0033', 'avc1.420033', 'avc1.4d002a', 'avc1.640028']
    : ['avc1.64002a', 'avc1.640028', 'avc1.64001f', 'avc1.4d002a', 'avc1.42002a', 'avc1.42E01E']

  const supported: VideoEncoderConfig[] = []
  // On desktop & mobile WebCodecs, prefer-software OpenH264 realtime avoids cross-process GPU
  // fence stalls when pipelining with WebGL texImage2D; keep no-preference first for 4K+ streams.
  const hwModes: HardwareAcceleration[] = isAbove1080p
    ? ['no-preference', 'prefer-software']
    : ['prefer-software', 'no-preference']
  const latencyModes: (LatencyMode | undefined)[] = ['realtime', undefined]

  for (const latencyMode of latencyModes) {
    for (const hardwareAcceleration of hwModes) {
      for (const codec of codecs) {
        try {
          const cfg: VideoEncoderConfig = {
            codec,
            width,
            height,
            bitrate,
            bitrateMode: 'variable',
            framerate: fps,
            hardwareAcceleration,
            ...(latencyMode ? { latencyMode } : {}),
            avc: { format: 'avc' },
          }
          const support = await VideoEncoder.isConfigSupported(cfg)
          if (support.supported) supported.push(cfg)
        } catch {
          // try next profile
        }
      }
    }
  }
  return supported
}

async function prepareAacAudioTrack(
  file: File
): Promise<{ audioBuffer: AudioBuffer; config: AudioEncoderConfig } | null> {
  if (typeof AudioEncoder === 'undefined' || typeof AudioData === 'undefined') return null
  if (file.size > 250 * 1024 * 1024) return null

  try {
    const AudioCtx =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext
    if (!AudioCtx) return null

    const ctx = new AudioCtx()
    let decoded: AudioBuffer
    try {
      const buf = await file.arrayBuffer()
      decoded = await ctx.decodeAudioData(buf)
    } finally {
      await ctx.close().catch(() => undefined)
    }

    if (!decoded.length || decoded.numberOfChannels <= 0) return null

    const tryConfig = async (
      channels: number,
      sampleRate: number
    ): Promise<AudioEncoderConfig | null> => {
      const cfg: AudioEncoderConfig = {
        codec: 'mp4a.40.2',
        numberOfChannels: channels,
        sampleRate,
        bitrate: 128_000,
      }
      try {
        const support = await AudioEncoder.isConfigSupported(cfg)
        return support.supported ? cfg : null
      } catch {
        return null
      }
    }

    let audioBuffer = decoded
    let config =
      decoded.numberOfChannels <= 2
        ? await tryConfig(decoded.numberOfChannels, decoded.sampleRate)
        : null

    if (!config) {
      const targetChannels = Math.min(2, decoded.numberOfChannels)
      const targetRate = 48_000
      config = await tryConfig(targetChannels, targetRate)
      if (!config) return null

      const offline = new OfflineAudioContext(
        targetChannels,
        Math.max(1, Math.ceil(decoded.duration * targetRate)),
        targetRate
      )
      const src = offline.createBufferSource()
      src.buffer = decoded
      src.connect(offline.destination)
      src.start(0)
      audioBuffer = await offline.startRendering()
    }

    return { audioBuffer, config }
  } catch {
    return null
  }
}

async function encodeAudioIntoMuxer(
  audioBuffer: AudioBuffer,
  config: AudioEncoderConfig,
  muxer: Muxer<ArrayBufferTarget>,
  signal?: AbortSignal
): Promise<void> {
  let audioError: Error | null = null
  const audioEncoder = new AudioEncoder({
    output: (chunk, meta) => {
      muxer.addAudioChunk(chunk, meta)
    },
    error: (err) => {
      audioError = err instanceof Error ? err : new Error(String(err))
    },
  })
  audioEncoder.configure(config)

  try {
    const channels = config.numberOfChannels
    const sampleRate = config.sampleRate
    const totalSamples = audioBuffer.length
    const chunkFrames = 1024

    for (let offset = 0; offset < totalSamples; offset += chunkFrames) {
      if (signal?.aborted) throw new DOMException('Dibatalkan', 'AbortError')
      if (audioError) throw audioError

      const count = Math.min(chunkFrames, totalSamples - offset)
      const planar = new Float32Array(count * channels)
      for (let ch = 0; ch < channels; ch++) {
        const chData = audioBuffer.getChannelData(Math.min(ch, audioBuffer.numberOfChannels - 1))
        planar.set(chData.subarray(offset, offset + count), ch * count)
      }

      const audioData = new AudioData({
        format: 'f32-planar',
        sampleRate,
        numberOfFrames: count,
        numberOfChannels: channels,
        timestamp: Math.round((offset / sampleRate) * 1_000_000),
        data: planar,
      })

      while (audioEncoder.encodeQueueSize > 16) {
        await new Promise((r) => setTimeout(r, 8))
        if (signal?.aborted) {
          audioData.close()
          throw new DOMException('Dibatalkan', 'AbortError')
        }
      }

      audioEncoder.encode(audioData)
      audioData.close()
    }

    await audioEncoder.flush()
    if (audioError) throw audioError
  } finally {
    if (audioEncoder.state !== 'closed') {
      audioEncoder.close()
    }
  }
}

function createFileByteReader(file: File, windowSize = 2 * 1024 * 1024) {
  let winStart = -1
  let winEnd = -1
  let winBytes = new Uint8Array(0)

  return async function readBytes(offset: number, size: number): Promise<Uint8Array> {
    if (offset >= winStart && offset + size <= winEnd) {
      const rel = offset - winStart
      return winBytes.subarray(rel, rel + size)
    }
    if (size >= windowSize) {
      const buf = await file.slice(offset, offset + size).arrayBuffer()
      return new Uint8Array(buf)
    }
    const readEnd = Math.min(file.size, offset + windowSize)
    const buf = await file.slice(offset, readEnd).arrayBuffer()
    winStart = offset
    winEnd = offset + buf.byteLength
    winBytes = new Uint8Array(buf)
    return winBytes.subarray(0, Math.min(size, winBytes.byteLength))
  }
}

function pickRecorderMimeType(): string {
  if (typeof MediaRecorder === 'undefined') return ''
  const candidates = [
    'video/mp4;codecs=avc1.42E01E,mp4a.40.2',
    'video/webm;codecs=vp9,opus',
    'video/webm;codecs=vp8,opus',
    'video/mp4',
    'video/webm',
  ]
  for (const mime of candidates) {
    if (MediaRecorder.isTypeSupported(mime)) return mime
  }
  return ''
}

export async function upscaleVideoLocally(
  file: File,
  options: VideoUpscaleOptions,
  onProgress?: (p: ProgressInfo) => void,
  onPreviewFrame?: (canvas: HTMLCanvasElement) => void,
  signal?: AbortSignal
): Promise<VideoUpscaleResult> {
  const restorationParams: RestorationParams = {
    denoise: options.denoise,
    deblock: options.deblock,
    sharpen: options.sharpen,
    clarity: options.clarity,
  }

  // Fast Path: Demux MP4 -> VideoDecoder -> WebGL2 EASU+RCAS -> VideoEncoder -> mp4-muxer (+ raw AAC passthrough)
  if (
    options.pipeline !== 'recorder' &&
    typeof VideoDecoder !== 'undefined' &&
    typeof VideoEncoder !== 'undefined'
  ) {
    try {
      const parsed = await parseMp4File(file)
      if (parsed?.videoTrack) {
        const vt = parsed.videoTrack
        const decCheck = await VideoDecoder.isConfigSupported({
          codec: vt.codec,
          description: vt.description,
        }).catch(() => ({ supported: false }))

        if (decCheck.supported) {
          const isRotated90 = vt.rotation === 90 || vt.rotation === 270
          const uprightSrcW = isRotated90 ? vt.height : vt.width
          const uprightSrcH = isRotated90 ? vt.width : vt.height
          const { width: uprightDstW, height: uprightDstH } = computeTargetVideoSize(
            uprightSrcW,
            uprightSrcH,
            options.scale,
            options.maxHeight
          )
          const encDstW = isRotated90 ? uprightDstH : uprightDstW
          const encDstH = isRotated90 ? uprightDstW : uprightDstH
          const effectiveFps =
            options.targetFps === 'source' ? vt.fps : Math.min(options.targetFps, Math.max(vt.fps, 1))
          const avcConfigs = await pickSupportedAvcConfigs(encDstW, encDstH, effectiveFps)

          if (avcConfigs.length > 0) {
            let preparedFallbackAudio: { audioBuffer: AudioBuffer; config: AudioEncoderConfig } | null = null
            let canSatisfyAudio = !options.includeAudio || Boolean(parsed.audioTrack)
            if (options.includeAudio && !parsed.audioTrack) {
              preparedFallbackAudio = await prepareAacAudioTrack(file)
              canSatisfyAudio = Boolean(preparedFallbackAudio)
            }

            if (canSatisfyAudio || options.pipeline === 'webcodecs') {
              return await runDemuxedMp4WebCodecsPipeline({
                file,
                videoTrack: vt,
                audioTrack: options.includeAudio ? parsed.audioTrack : null,
                preparedFallbackAudio: options.includeAudio ? preparedFallbackAudio : null,
                durationSec: parsed.durationSec,
                uprightSrcW,
                uprightSrcH,
                uprightDstW,
                uprightDstH,
                encDstW,
                encDstH,
                targetFps: options.targetFps,
                encoderConfigs: avcConfigs,
                params: restorationParams,
                onProgress,
                onPreviewFrame,
                signal,
              })
            }
          }
        }
      }
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') {
        throw err
      }
      // Fall through cleanly to <video> WebCodecs / MediaRecorder for non-MP4 or exotic streams
    }
  }

  const url = URL.createObjectURL(file)
  const video = document.createElement('video')
  video.muted = true
  video.playsInline = true
  video.preload = 'auto'
  video.src = url

  try {
    await new Promise<void>((resolve, reject) => {
      video.onloadedmetadata = () => resolve()
      video.onerror = () => reject(new Error('Format video tidak didukung oleh browser ini'))
    })

    const srcW = video.videoWidth
    const srcH = video.videoHeight
    const duration = Number.isFinite(video.duration) && video.duration > 0 ? video.duration : 1
    if (!srcW || !srcH) throw new Error('Dimensi video tidak valid')

    const fps = options.targetFps === 'source' ? 30 : options.targetFps
    const { width: dstW, height: dstH } = computeTargetVideoSize(
      srcW,
      srcH,
      options.scale,
      options.maxHeight
    )

    const avcConfigs = await pickSupportedAvcConfigs(dstW, dstH, fps)
    let preparedAudio: { audioBuffer: AudioBuffer; config: AudioEncoderConfig } | null = null
    if (options.includeAudio && options.pipeline !== 'recorder' && avcConfigs.length > 0) {
      preparedAudio = await prepareAacAudioTrack(file)
    }

    const shouldUseWebCodecs =
      options.pipeline === 'webcodecs' ||
      (options.pipeline === 'auto' && avcConfigs.length > 0 && (!options.includeAudio || Boolean(preparedAudio)))

    if (shouldUseWebCodecs) {
      if (avcConfigs.length === 0) {
        throw new Error(
          'WebCodecs H.264 encoder tidak tersedia di perangkat ini, pilih mode Kompatibel HP'
        )
      }
      return await runWebCodecsPipeline(
        video,
        srcW,
        srcH,
        dstW,
        dstH,
        duration,
        fps,
        avcConfigs,
        restorationParams,
        preparedAudio,
        onProgress,
        onPreviewFrame,
        signal
      )
    }

    return await runMediaRecorderPipeline(
      video,
      srcW,
      srcH,
      dstW,
      dstH,
      duration,
      fps,
      options.includeAudio,
      restorationParams,
      onProgress,
      onPreviewFrame,
      signal
    )
  } finally {
    video.pause()
    video.removeAttribute('src')
    video.load()
    URL.revokeObjectURL(url)
  }
}

async function initVerifiedVideoEncoder(
  configs: VideoEncoderConfig[],
  firstFrameCanvas: HTMLCanvasElement,
  frameDurationUs: number,
  muxer: Muxer<ArrayBufferTarget>,
  onAsyncError: (err: Error) => void,
  firstTimestampUs = 0
): Promise<VideoEncoder> {
  let lastErr: Error | null = null

  for (const cfg of configs) {
    let liveToMuxer = false
    let localErr: Error | null = null
    const buffered: Array<{ chunk: EncodedVideoChunk; meta?: EncodedVideoChunkMetadata }> = []

    const candidate = new VideoEncoder({
      output: (chunk, meta) => {
        if (liveToMuxer) {
          muxer.addVideoChunk(chunk, meta)
        } else {
          buffered.push({ chunk, meta })
        }
      },
      error: (err) => {
        const e = err instanceof Error ? err : new Error(String(err))
        localErr = e
        if (liveToMuxer) onAsyncError(e)
      },
    })

    const frame = new VideoFrame(firstFrameCanvas, {
      timestamp: firstTimestampUs,
      duration: frameDurationUs,
    })

    try {
      candidate.configure(cfg)
      if (localErr || candidate.state !== 'configured') {
        throw localErr ?? new Error(`Encoder gagal configure (${cfg.codec})`)
      }
      candidate.encode(frame, { keyFrame: true })
      await Promise.race([
        candidate.flush(),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error(`Encoder flush timeout (${cfg.codec})`)), 5000)
        ),
      ])
      if (localErr || candidate.state !== 'configured') {
        throw localErr ?? new Error(`Encoder tertutup saat frame awal (${cfg.codec})`)
      }

      for (const item of buffered) {
        muxer.addVideoChunk(item.chunk, item.meta)
      }
      liveToMuxer = true
      return candidate
    } catch (err) {
      lastErr = err instanceof Error ? err : new Error(String(err))
      if (candidate.state !== 'closed') {
        try {
          candidate.close()
        } catch {
          // ignore close errors on failed candidate
        }
      }
    } finally {
      frame.close()
    }
  }

  throw lastErr ?? new Error('Semua konfigurasi H.264 WebCodecs gagal di perangkat ini.')
}

interface DemuxedMp4PipelineArgs {
  file: File
  videoTrack: Mp4VideoTrack
  audioTrack: Mp4AudioTrack | null
  preparedFallbackAudio: { audioBuffer: AudioBuffer; config: AudioEncoderConfig } | null
  durationSec: number
  uprightSrcW: number
  uprightSrcH: number
  uprightDstW: number
  uprightDstH: number
  encDstW: number
  encDstH: number
  targetFps: 'source' | 24 | 30 | 60
  encoderConfigs: VideoEncoderConfig[]
  params: RestorationParams
  onProgress?: (p: ProgressInfo) => void
  onPreviewFrame?: (canvas: HTMLCanvasElement) => void
  signal?: AbortSignal
}

async function runDemuxedMp4WebCodecsPipeline(
  args: DemuxedMp4PipelineArgs
): Promise<VideoUpscaleResult> {
  const {
    file,
    videoTrack,
    audioTrack,
    preparedFallbackAudio,
    durationSec,
    uprightSrcW,
    uprightSrcH,
    uprightDstW,
    uprightDstH,
    encDstW,
    encDstH,
    targetFps,
    encoderConfigs,
    params,
    onProgress,
    onPreviewFrame,
    signal,
  } = args

  const audioMetaConfig = audioTrack
    ? {
        codec: 'aac' as const,
        numberOfChannels: audioTrack.numberOfChannels,
        sampleRate: audioTrack.sampleRate,
      }
    : preparedFallbackAudio
      ? {
          codec: 'aac' as const,
          numberOfChannels: preparedFallbackAudio.config.numberOfChannels,
          sampleRate: preparedFallbackAudio.config.sampleRate,
        }
      : undefined

  const outputFps =
    targetFps === 'source' ? videoTrack.fps : Math.min(targetFps, Math.max(videoTrack.fps, 1))

  const target = new ArrayBufferTarget()
  const muxer = new Muxer({
    target,
    video: {
      codec: 'avc',
      width: encDstW,
      height: encDstH,
      rotation: videoTrack.rotation,
      frameRate: outputFps,
    },
    ...(audioMetaConfig ? { audio: audioMetaConfig } : {}),
    fastStart: 'in-memory',
    firstTimestampBehavior: 'offset',
  })

  const pipeline = new WebGLRestorationPipeline()
  const readBytes = createFileByteReader(file)
  const samples = videoTrack.samples
  const totalSamples = samples.length
  const minFrameIntervalUs =
    targetFps !== 'source' && videoTrack.fps > targetFps + 2
      ? Math.floor(1_000_000 / targetFps) - 1000
      : 0

  const encoderRef: { current: VideoEncoder | null } = { current: null }
  let decoder: VideoDecoder | null = null
  let pipelineErr: Error | null = null
  let encodedIndex = 0
  let decodedCount = 0
  let lastAcceptedTs = Number.NEGATIVE_INFINITY
  let lastProgressAt = 0
  let lastPreviewAt = 0

  const decodedQueue: VideoFrame[] = []
  let drainChain: Promise<void> = Promise.resolve()
  let wakeFeeder: (() => void) | null = null
  let feederTimer: ReturnType<typeof setTimeout> | null = null
  const notifyFeeder = () => {
    if (feederTimer) {
      clearTimeout(feederTimer)
      feederTimer = null
    }
    const fn = wakeFeeder
    if (fn) {
      wakeFeeder = null
      fn()
    }
  }
  const waitQueueDrain = () =>
    new Promise<void>((resolve) => {
      wakeFeeder = resolve
      feederTimer = setTimeout(notifyFeeder, 2000)
    })

  let wakeEncoder: (() => void) | null = null
  let encTimer: ReturnType<typeof setTimeout> | null = null
  const notifyEncoder = () => {
    if (encTimer) {
      clearTimeout(encTimer)
      encTimer = null
    }
    const fn = wakeEncoder
    if (fn) {
      wakeEncoder = null
      fn()
    }
  }
  const waitEncoderDrain = () =>
    new Promise<void>((resolve) => {
      wakeEncoder = resolve
      encTimer = setTimeout(notifyEncoder, 2000)
    })

  const processFrame = async (frame: VideoFrame): Promise<void> => {
    try {
      if (signal?.aborted) throw new DOMException('Dibatalkan', 'AbortError')
      if (pipelineErr) throw pipelineErr

      decodedCount++
      const ts = frame.timestamp
      if (minFrameIntervalUs > 0 && lastAcceptedTs >= 0 && ts - lastAcceptedTs < minFrameIntervalUs) {
        return
      }
      lastAcceptedTs = ts

      const srcW = frame.displayWidth || videoTrack.width
      const srcH = frame.displayHeight || videoTrack.height
      pipeline.render(frame, srcW, srcH, encDstW, encDstH, params)
      const frameCanvas = pipeline.canvas

      const frameNow = performance.now()
      if (encodedIndex === 0 || frameNow - lastPreviewAt >= 450) {
        lastPreviewAt = frameNow
        onPreviewFrame?.(frameCanvas)
      }

      const defaultDurUs = Math.round(1_000_000 / Math.max(1, outputFps))
      const durUs = frame.duration && frame.duration > 0 ? frame.duration : defaultDurUs

      if (encodedIndex === 0) {
        const createdEncoder = await initVerifiedVideoEncoder(
          encoderConfigs,
          frameCanvas,
          durUs,
          muxer,
          (err) => {
            pipelineErr = err
            notifyEncoder()
            notifyFeeder()
          },
          ts
        )
        createdEncoder.addEventListener('dequeue', notifyEncoder)
        encoderRef.current = createdEncoder
      } else {
        const activeEncoder = encoderRef.current
        if (!activeEncoder) throw new Error('Encoder video belum siap')
        while (activeEncoder.encodeQueueSize > 16) {
          if (pipelineErr || activeEncoder.state !== 'configured') {
            throw pipelineErr ?? new Error(`Encoder video tertutup (${activeEncoder.state})`)
          }
          await waitEncoderDrain()
          if (signal?.aborted) throw new DOMException('Dibatalkan', 'AbortError')
        }
        if (pipelineErr) throw pipelineErr
        if (activeEncoder.state !== 'configured') {
          throw new Error(`Encoder video tertutup (${activeEncoder.state})`)
        }
        const outFrame = new VideoFrame(frameCanvas, { timestamp: ts, duration: durUs })
        try {
          activeEncoder.encode(outFrame, {
            keyFrame: encodedIndex === 1 || encodedIndex % Math.max(1, outputFps * 2) === 0,
          })
        } finally {
          outFrame.close()
        }
      }

      encodedIndex++
      const now = performance.now()
      if (now - lastProgressAt > 90 || decodedCount === totalSamples) {
        lastProgressAt = now
        onProgress?.({
          percent: Math.min(92, Math.round((decodedCount / totalSamples) * 92)),
          stage: `Memproses cepat frame ${decodedCount}/${totalSamples} (GPU Direct)`,
          detail: `${uprightSrcW}×${uprightSrcH} → ${uprightDstW}×${uprightDstH} • ${outputFps} fps`,
        })
      }
    } finally {
      frame.close()
      notifyFeeder()
    }
  }

  const scheduleDrain = () => {
    drainChain = drainChain.then(async () => {
      while (decodedQueue.length > 0) {
        const nextFrame = decodedQueue.shift()
        if (!nextFrame) break
        await processFrame(nextFrame)
      }
      notifyFeeder()
    })
    drainChain.catch((err) => {
      if (!pipelineErr) {
        pipelineErr = err instanceof Error ? err : new Error(String(err))
      }
      notifyFeeder()
    })
  }

  try {
    decoder = new VideoDecoder({
      output: (frame) => {
        if (pipelineErr || signal?.aborted) {
          frame.close()
          return
        }
        decodedQueue.push(frame)
        scheduleDrain()
      },
      error: (err) => {
        pipelineErr = err instanceof Error ? err : new Error(String(err))
        notifyFeeder()
        notifyEncoder()
      },
    })
    decoder.addEventListener('dequeue', notifyFeeder)

    // Prefer software H.264 decoder when available so decoding never contends with GPU WebGL/encoder pools
    const swDecCheck = await VideoDecoder.isConfigSupported({
      codec: videoTrack.codec,
      codedWidth: videoTrack.width,
      codedHeight: videoTrack.height,
      description: videoTrack.description,
      hardwareAcceleration: 'prefer-software',
    }).catch(() => ({ supported: false }))

    decoder.configure({
      codec: videoTrack.codec,
      codedWidth: videoTrack.width,
      codedHeight: videoTrack.height,
      description: videoTrack.description,
      hardwareAcceleration: swDecCheck.supported ? 'prefer-software' : 'no-preference',
    })

    for (let i = 0; i < totalSamples; i++) {
      if (signal?.aborted) throw new DOMException('Dibatalkan', 'AbortError')
      if (pipelineErr) throw pipelineErr

      while (decoder.decodeQueueSize >= 16 || decodedQueue.length >= 16) {
        if (pipelineErr) throw pipelineErr
        await waitQueueDrain()
        if (signal?.aborted) throw new DOMException('Dibatalkan', 'AbortError')
      }

      const sample = samples[i]
      const data = await readBytes(sample.offset, sample.size)
      const chunk = new EncodedVideoChunk({
        type: sample.type,
        timestamp: sample.timestampUs,
        duration: sample.durationUs,
        data,
      })
      decoder.decode(chunk)
    }

    await decoder.flush()
    await drainChain
    if (pipelineErr) throw pipelineErr

    onProgress?.({ percent: 94, stage: 'Finalisasi video MP4...' })
    if (encoderRef.current) {
      await encoderRef.current.flush()
    }
    if (pipelineErr) throw pipelineErr

    if (audioTrack && audioTrack.samples.length > 0) {
      onProgress?.({ percent: 96, stage: 'Menyalin audio AAC asli (lossless sync)...' })
      for (let i = 0; i < audioTrack.samples.length; i++) {
        if (signal?.aborted) throw new DOMException('Dibatalkan', 'AbortError')
        const aSample = audioTrack.samples[i]
        const rawAudio = await readBytes(aSample.offset, aSample.size)
        // Copy out from reusable read-ahead window so muxer owns independent bytes
        const chunkBytes = new Uint8Array(rawAudio)
        muxer.addAudioChunkRaw(
          chunkBytes,
          'key',
          aSample.timestampUs,
          aSample.durationUs,
          i === 0
            ? {
                decoderConfig: {
                  codec: 'mp4a.40.2',
                  description: audioTrack.description,
                  numberOfChannels: audioTrack.numberOfChannels,
                  sampleRate: audioTrack.sampleRate,
                },
              }
            : undefined
        )
      }
    } else if (preparedFallbackAudio) {
      onProgress?.({ percent: 96, stage: 'Menggabungkan track audio AAC...' })
      await encodeAudioIntoMuxer(
        preparedFallbackAudio.audioBuffer,
        preparedFallbackAudio.config,
        muxer,
        signal
      )
    }

    muxer.finalize()
    const blob = new Blob([target.buffer], { type: 'video/mp4' })
    return {
      blob,
      mimeType: 'video/mp4',
      width: uprightDstW,
      height: uprightDstH,
      duration: durationSec,
      pipelineUsed: 'webcodecs-mp4',
      providerLabel: 'WebGL2 Direct',
      audioIncluded: Boolean(audioMetaConfig),
    }
  } finally {
    if (feederTimer) clearTimeout(feederTimer)
    if (encTimer) clearTimeout(encTimer)
    for (const f of decodedQueue) {
      try {
        f.close()
      } catch {
        // ignore
      }
    }
    decodedQueue.length = 0
    if (decoder && decoder.state !== 'closed') {
      try {
        decoder.close()
      } catch {
        // ignore
      }
    }
    if (encoderRef.current && encoderRef.current.state !== 'closed') {
      try {
        encoderRef.current.close()
      } catch {
        // ignore
      }
    }
    pipeline.dispose()
  }
}

async function runWebCodecsPipeline(
  video: HTMLVideoElement,
  srcW: number,
  srcH: number,
  dstW: number,
  dstH: number,
  duration: number,
  fps: number,
  encoderConfigs: VideoEncoderConfig[],
  params: RestorationParams,
  preparedAudio: { audioBuffer: AudioBuffer; config: AudioEncoderConfig } | null,
  onProgress?: (p: ProgressInfo) => void,
  onPreviewFrame?: (canvas: HTMLCanvasElement) => void,
  signal?: AbortSignal
): Promise<VideoUpscaleResult> {
  const totalFrames = Math.max(1, Math.floor(duration * fps))

  const target = new ArrayBufferTarget()
  const muxer = new Muxer({
    target,
    video: {
      codec: 'avc',
      width: dstW,
      height: dstH,
      frameRate: fps,
    },
    ...(preparedAudio
      ? {
          audio: {
            codec: 'aac',
            numberOfChannels: preparedAudio.config.numberOfChannels,
            sampleRate: preparedAudio.config.sampleRate,
          },
        }
      : {}),
    fastStart: 'in-memory',
    firstTimestampBehavior: 'offset',
  })

  let encodeError: Error | null = null
  let encoder: VideoEncoder | null = null
  const pipeline = new WebGLRestorationPipeline()
  const frameDurationUs = Math.round(1_000_000 / fps)

  try {
    for (let i = 0; i < totalFrames; i++) {
      if (signal?.aborted) throw new DOMException('Dibatalkan', 'AbortError')
      if (encodeError) throw encodeError

      const timeSec = Math.min(duration - 0.001, i / fps)
      await waitForSeek(video, timeSec, signal)

      pipeline.render(video, srcW, srcH, dstW, dstH, params)
      const frameCanvas = pipeline.canvas

      if (i % 6 === 0) {
        onPreviewFrame?.(frameCanvas)
      }

      if (i === 0) {
        encoder = await initVerifiedVideoEncoder(
          encoderConfigs,
          frameCanvas,
          frameDurationUs,
          muxer,
          (err) => {
            encodeError = err
          }
        )
      } else {
        if (!encoder) throw new Error('Encoder video belum siap')
        const timestampUs = i * frameDurationUs
        const frame = new VideoFrame(frameCanvas, {
          timestamp: timestampUs,
          duration: frameDurationUs,
        })

        try {
          // Apply backpressure so mobile GPU/encoder queue never overflows
          while (encoder.encodeQueueSize > 8) {
            if (encodeError || encoder.state !== 'configured') {
              throw encodeError ?? new Error(`Encoder video tertutup (${encoder.state})`)
            }
            await new Promise((r) => setTimeout(r, 12))
            if (signal?.aborted) {
              throw new DOMException('Dibatalkan', 'AbortError')
            }
          }

          if (encodeError) throw encodeError
          if (encoder.state !== 'configured') {
            throw new Error(`Encoder video tertutup (${encoder.state}) saat frame ${i + 1}`)
          }

          encoder.encode(frame, { keyFrame: i === 1 || i % Math.max(1, fps * 2) === 0 })
        } finally {
          frame.close()
        }
      }

      onProgress?.({
        percent: Math.min(92, Math.round(((i + 1) / totalFrames) * 92)),
        stage: `Merestorasi frame ${i + 1}/${totalFrames} (WebGL2 MP4)`,
        detail: `${srcW}×${srcH} → ${dstW}×${dstH} • ${fps} fps`,
      })
    }

    onProgress?.({ percent: 94, stage: 'Finalisasi video MP4...' })
    if (encoder) {
      await encoder.flush()
    }
    if (encodeError) throw encodeError

    if (preparedAudio) {
      onProgress?.({ percent: 97, stage: 'Menggabungkan track audio AAC...' })
      await encodeAudioIntoMuxer(preparedAudio.audioBuffer, preparedAudio.config, muxer, signal)
    }

    muxer.finalize()

    const blob = new Blob([target.buffer], { type: 'video/mp4' })
    return {
      blob,
      mimeType: 'video/mp4',
      width: dstW,
      height: dstH,
      duration,
      pipelineUsed: 'webcodecs-mp4',
      providerLabel: 'WebGL2',
      audioIncluded: Boolean(preparedAudio),
    }
  } finally {
    if (encoder && encoder.state !== 'closed') {
      encoder.close()
    }
    pipeline.dispose()
  }
}

async function runMediaRecorderPipeline(
  video: HTMLVideoElement,
  srcW: number,
  srcH: number,
  dstW: number,
  dstH: number,
  duration: number,
  fps: number,
  includeAudio: boolean,
  params: RestorationParams,
  onProgress?: (p: ProgressInfo) => void,
  onPreviewFrame?: (canvas: HTMLCanvasElement) => void,
  signal?: AbortSignal
): Promise<VideoUpscaleResult> {
  const mimeType = pickRecorderMimeType()
  if (!mimeType) {
    throw new Error('Browser tidak mendukung MediaRecorder maupun WebCodecs')
  }

  const pipeline = new WebGLRestorationPipeline()
  const canvasStream = pipeline.canvas.captureStream(fps)
  let audioCtx: AudioContext | null = null

  if (includeAudio) {
    try {
      const AudioCtx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext
      audioCtx = new AudioCtx()
      const srcNode = audioCtx.createMediaElementSource(video)
      const destNode = audioCtx.createMediaStreamDestination()
      // Keep audio silent on speakers while routing to recorded stream
      const silentGain = audioCtx.createGain()
      silentGain.gain.value = 0
      srcNode.connect(destNode)
      srcNode.connect(silentGain)
      silentGain.connect(audioCtx.destination)
      video.muted = false
      for (const track of destNode.stream.getAudioTracks()) {
        canvasStream.addTrack(track)
      }
    } catch {
      video.muted = true
    }
  }

  const bitrate = Math.min(24_000_000, Math.max(4_000_000, Math.round(dstW * dstH * fps * 0.22)))
  const recorder = new MediaRecorder(canvasStream, {
    mimeType,
    videoBitsPerSecond: bitrate,
  })

  const chunks: BlobPart[] = []
  recorder.ondataavailable = (ev) => {
    if (ev.data && ev.data.size > 0) chunks.push(ev.data)
  }

  const stoppedPromise = new Promise<void>((resolve) => {
    recorder.onstop = () => resolve()
  })

  let rafId = 0
  let finished = false

  try {
    await waitForSeek(video, 0, signal)
    pipeline.render(video, srcW, srcH, dstW, dstH, params)
    onPreviewFrame?.(pipeline.canvas)

    if (audioCtx && audioCtx.state === 'suspended') {
      await audioCtx.resume()
    }

    recorder.start(250)
    await video.play()

    await new Promise<void>((resolve, reject) => {
      const onAbort = () => {
        finished = true
        video.pause()
        reject(new DOMException('Dibatalkan', 'AbortError'))
      }
      signal?.addEventListener('abort', onAbort, { once: true })

      video.onended = () => {
        finished = true
        resolve()
      }
      video.onerror = () => {
        finished = true
        reject(new Error('Pemutaran video terhenti saat pemrosesan'))
      }

      let frameCounter = 0
      const loop = () => {
        if (finished) return
        if (video.readyState >= 2) {
          pipeline.render(video, srcW, srcH, dstW, dstH, params)
          frameCounter++
          if (frameCounter % 8 === 0) onPreviewFrame?.(pipeline.canvas)
          const pct = Math.min(95, Math.round((video.currentTime / duration) * 95))
          onProgress?.({
            percent: pct,
            stage: `Merekam & merestorasi real-time (${video.currentTime.toFixed(1)}s / ${duration.toFixed(1)}s)`,
            detail: `${dstW}×${dstH} • ${includeAudio ? 'Dengan Audio' : 'Tanpa Audio'}`,
          })
        }
        rafId = requestAnimationFrame(loop)
      }
      rafId = requestAnimationFrame(loop)
    })

    if (recorder.state !== 'inactive') {
      recorder.stop()
    }
    await stoppedPromise

    const cleanMime = mimeType.split(';')[0] || 'video/webm'
    const blob = new Blob(chunks, { type: cleanMime })
    onProgress?.({ percent: 100, stage: 'Selesai!' })
    return {
      blob,
      mimeType: cleanMime,
      width: dstW,
      height: dstH,
      duration,
      pipelineUsed: 'mediarecorder',
      providerLabel: 'MediaRecorder WebGL2',
      audioIncluded: includeAudio,
    }
  } finally {
    cancelAnimationFrame(rafId)
    if (recorder.state !== 'inactive') {
      try {
        recorder.stop()
      } catch {
        // ignore
      }
    }
    for (const track of canvasStream.getTracks()) track.stop()
    if (audioCtx) {
      await audioCtx.close().catch(() => undefined)
    }
    pipeline.dispose()
  }
}
