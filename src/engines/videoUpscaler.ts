import { ArrayBufferTarget, Muxer } from 'mp4-muxer'
import type { ProgressInfo, VideoUpscaleOptions } from '../types'
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
  maxHeight: 720 | 1080 | 2160
): { width: number; height: number } {
  let targetW = srcW * scale
  let targetH = srcH * scale
  if (targetH > maxHeight) {
    const ratio = maxHeight / targetH
    targetW *= ratio
    targetH = maxHeight
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
  const bitrate = Math.min(24_000_000, Math.max(3_000_000, Math.round(width * height * fps * 0.18)))
  const isAbove1080p = width * height > 2_300_000
  const codecs = isAbove1080p
    ? ['avc1.640033', 'avc1.4d0033', 'avc1.420033', 'avc1.4d002a', 'avc1.640028']
    : ['avc1.4d002a', 'avc1.64002a', 'avc1.640028', 'avc1.42002a', 'avc1.42001f', 'avc1.42E01E']

  const supported: VideoEncoderConfig[] = []
  const hwModes: HardwareAcceleration[] = ['no-preference', 'prefer-software']

  for (const hardwareAcceleration of hwModes) {
    for (const codec of codecs) {
      try {
        const cfg: VideoEncoderConfig = {
          codec,
          width,
          height,
          bitrate,
          framerate: fps,
          hardwareAcceleration,
          avc: { format: 'avc' },
        }
        const support = await VideoEncoder.isConfigSupported(cfg)
        if (support.supported) supported.push(cfg)
      } catch {
        // try next profile
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

function pickRecorderMimeType(): string {
  if (typeof MediaRecorder === 'undefined') return ''
  const candidates = [
    'video/mp4;codecs=avc1.42E01E,mp4a.40.2',
    'video/mp4',
    'video/webm;codecs=vp9,opus',
    'video/webm;codecs=vp8,opus',
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

    const restorationParams: RestorationParams = {
      denoise: options.denoise,
      deblock: options.deblock,
      sharpen: options.sharpen,
      clarity: options.clarity,
    }

    const avcConfigs = await pickSupportedAvcConfigs(dstW, dstH, fps)
    const canAudioEncoder = typeof AudioEncoder !== 'undefined'

    const shouldUseWebCodecs =
      options.pipeline === 'webcodecs' ||
      (options.pipeline === 'auto' && avcConfigs.length > 0 && (!options.includeAudio || canAudioEncoder))

    if (shouldUseWebCodecs) {
      if (avcConfigs.length === 0) {
        throw new Error(
          'WebCodecs H.264 encoder tidak tersedia di perangkat ini, pilih mode Kompatibel HP'
        )
      }
      const preparedAudio = options.includeAudio ? await prepareAacAudioTrack(file) : null
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
  onAsyncError: (err: Error) => void
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
      timestamp: 0,
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

  const bitrate = Math.min(16_000_000, Math.max(2_500_000, Math.round(dstW * dstH * fps * 0.14)))
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
