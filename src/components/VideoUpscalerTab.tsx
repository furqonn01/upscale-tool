import { useEffect, useRef, useState } from 'react'
import {
  Download,
  FileVideo,
  Film,
  Loader2,
  Volume2,
  VolumeX,
  Wand2,
  X,
} from 'lucide-react'
import { parseMp4File } from '../engines/mp4Demuxer'
import { computeTargetVideoSize, upscaleVideoLocally } from '../engines/videoUpscaler'
import type {
  DeviceCapabilities,
  ProgressInfo,
  VideoPipelineMode,
  VideoPreset,
  VideoUpscaleOptions,
} from '../types'
import { formatBytes } from '../utils/device'
import { saveGalleryItem } from '../utils/storage'
import { YouTubeVideoPlayer } from './YouTubeVideoPlayer'

interface VideoUpscalerTabProps {
  caps: DeviceCapabilities
  onGalleryUpdated: () => void
}

const VIDEO_PRESETS: Record<
  VideoPreset,
  { label: string; desc: string; denoise: number; deblock: number; sharpen: number; clarity: number }
> = {
  'photo-burik': {
    label: 'Video Burik → HD',
    desc: 'Bersihkan pecah kompresi & noise',
    denoise: 55,
    deblock: 68,
    sharpen: 65,
    clarity: 38,
  },
  anime: {
    label: 'Anime / Kartun',
    desc: 'Garis halus & tajam',
    denoise: 62,
    deblock: 72,
    sharpen: 82,
    clarity: 32,
  },
  clarity: {
    label: 'Detail Tajam',
    desc: 'Untuk rekaman cukup bersih',
    denoise: 30,
    deblock: 40,
    sharpen: 78,
    clarity: 50,
  },
}

export function VideoUpscalerTab({ caps, onGalleryUpdated }: VideoUpscalerTabProps) {
  const inputRef = useRef<HTMLInputElement>(null)
  const previewCanvasRef = useRef<HTMLCanvasElement>(null)
  const abortRef = useRef<AbortController | null>(null)

  const [sourceFile, setSourceFile] = useState<File | null>(null)
  const [sourceUrl, setSourceUrl] = useState<string | null>(null)
  const [sourceMeta, setSourceMeta] = useState<{
    w: number
    h: number
    duration: number
  } | null>(null)

  const [resultBlob, setResultBlob] = useState<Blob | null>(null)
  const [resultUrl, setResultUrl] = useState<string | null>(null)
  const [resultInfo, setResultInfo] = useState<string>('')

  const [processing, setProcessing] = useState(false)
  const [progress, setProgress] = useState<ProgressInfo | null>(null)
  const [errorMsg, setErrorMsg] = useState<string | null>(null)
  const [theaterMode, setTheaterMode] = useState(false)

  const [options, setOptions] = useState<VideoUpscaleOptions>(() => ({
    scale: caps.isMobile ? 1.5 : 2,
    preset: 'photo-burik',
    denoise: 55,
    deblock: 68,
    sharpen: 65,
    clarity: 38,
    maxHeight: caps.isMobile ? 720 : 1080,
    targetFps: 'source',
    pipeline: 'auto',
    includeAudio: true,
  }))

  useEffect(() => {
    return () => {
      if (sourceUrl) URL.revokeObjectURL(sourceUrl)
    }
  }, [sourceUrl])

  useEffect(() => {
    return () => {
      if (resultUrl) URL.revokeObjectURL(resultUrl)
    }
  }, [resultUrl])

  const handleVideoFile = (file: File | undefined) => {
    if (!file) return
    if (!file.type.startsWith('video/') && !/\.(mp4|m4v|mov|webm|mkv)$/i.test(file.name)) {
      setErrorMsg('Pilih file video (MP4, MOV, WebM, dll).')
      return
    }
    setErrorMsg(null)
    setResultBlob(null)
    setResultInfo('')
    setResultUrl(null)
    setSourceMeta(null)
    const nextUrl = URL.createObjectURL(file)
    setSourceFile(file)
    setSourceUrl(nextUrl)

    let resolved = false
    const probe = document.createElement('video')
    probe.preload = 'metadata'
    const fallbackToDemuxMeta = () => {
      if (resolved) return
      void parseMp4File(file).then((parsed) => {
        if (resolved || !parsed?.videoTrack) return
        const vt = parsed.videoTrack
        const rotated = vt.rotation === 90 || vt.rotation === 270
        resolved = true
        setSourceMeta({
          w: rotated ? vt.height : vt.width,
          h: rotated ? vt.width : vt.height,
          duration: parsed.durationSec || 0,
        })
      }).catch(() => undefined)
    }
    const metaTimer = setTimeout(fallbackToDemuxMeta, 400)

    probe.onloadedmetadata = () => {
      resolved = true
      clearTimeout(metaTimer)
      setSourceMeta({
        w: probe.videoWidth,
        h: probe.videoHeight,
        duration: probe.duration || 0,
      })
      probe.removeAttribute('src')
      probe.load()
    }
    probe.onerror = () => {
      clearTimeout(metaTimer)
      probe.removeAttribute('src')
      probe.load()
      fallbackToDemuxMeta()
    }
    probe.src = nextUrl
  }

  const applyPreset = (preset: VideoPreset) => {
    const p = VIDEO_PRESETS[preset]
    setOptions((prev) => ({
      ...prev,
      preset,
      denoise: p.denoise,
      deblock: p.deblock,
      sharpen: p.sharpen,
      clarity: p.clarity,
    }))
  }

  const runVideoUpscale = async () => {
    if (!sourceFile) return
    setErrorMsg(null)
    setProcessing(true)
    setProgress({ percent: 2, stage: 'Mempersiapkan pipeline video GPU...' })
    const controller = new AbortController()
    abortRef.current = controller
    const startedAt = performance.now()

    try {
      const res = await upscaleVideoLocally(
        sourceFile,
        options,
        setProgress,
        (frameCanvas) => {
          const targetCanvas = previewCanvasRef.current
          if (!targetCanvas) return
          const scalePreview = Math.min(1, 640 / Math.max(frameCanvas.width, frameCanvas.height))
          const pw = Math.max(1, Math.round(frameCanvas.width * scalePreview))
          const ph = Math.max(1, Math.round(frameCanvas.height * scalePreview))
          if (targetCanvas.width !== pw) targetCanvas.width = pw
          if (targetCanvas.height !== ph) targetCanvas.height = ph
          const ctx = targetCanvas.getContext('2d')
          ctx?.drawImage(frameCanvas, 0, 0, pw, ph)
        },
        controller.signal
      )

      const elapsed = ((performance.now() - startedAt) / 1000).toFixed(1)
      const nextResultUrl = URL.createObjectURL(res.blob)
      setResultBlob(res.blob)
      setResultUrl(nextResultUrl)
      const pipelineBadge =
        res.pipelineUsed === 'webcodecs-mp4' ? 'MP4 WebCodecs' : 'MediaRecorder'
      setResultInfo(
        `${res.width}×${res.height} • ${pipelineBadge}${res.audioIncluded ? ' + Audio' : ''} • ${elapsed}s • ${formatBytes(res.blob.size)}`
      )

      const cleanTitle = sourceFile.name.replace(/\.[^.]+$/, '') || 'video'
      await saveGalleryItem({
        id: `video-${Date.now()}`,
        kind: 'upscale-video',
        title: `${cleanTitle}-HD-${res.width}x${res.height}`,
        createdAt: Date.now(),
        mimeType: res.mimeType,
        blob: res.blob,
        width: res.width,
        height: res.height,
        meta: `${res.providerLabel} (${elapsed}s)`,
      }).catch(() => undefined)
      onGalleryUpdated()
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') {
        setErrorMsg('Pemrosesan video dibatalkan.')
      } else {
        setErrorMsg(err instanceof Error ? err.message : 'Gagal memproses video')
      }
    } finally {
      abortRef.current = null
      setProcessing(false)
      setProgress(null)
    }
  }

  const downloadVideo = () => {
    if (!resultBlob || !resultUrl || !sourceFile) return
    const ext = resultBlob.type.includes('mp4') ? 'mp4' : 'webm'
    const baseName = sourceFile.name.replace(/\.[^.]+$/, '') || 'video'
    const a = document.createElement('a')
    a.href = resultUrl
    a.download = `${baseName}-HD.${ext}`
    a.click()
  }

  const targetDims = sourceMeta
    ? computeTargetVideoSize(sourceMeta.w, sourceMeta.h, options.scale, options.maxHeight)
    : null

  return (
    <div className="grid grid-cols-1 gap-5 lg:grid-cols-12">
      {/* Preview Panel */}
      <div className={`space-y-4 ${theaterMode && sourceUrl ? 'lg:col-span-12' : 'lg:col-span-7'}`}>
        {!sourceUrl ? (
          <div
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => {
              e.preventDefault()
              handleVideoFile(e.dataTransfer.files?.[0])
            }}
            className="flex min-h-[300px] flex-col items-center justify-center rounded-2xl border-2 border-dashed border-zinc-700/80 bg-zinc-900/50 p-6 text-center"
          >
            <div className="mb-3 flex h-14 w-14 items-center justify-center rounded-2xl bg-sky-500/15 text-sky-400">
              <Film className="h-7 w-7" />
            </div>
            <h2 className="text-base font-semibold text-zinc-100 sm:text-lg">
              Pilih Video Burik untuk Dijadikan HD
            </h2>
            <p className="mt-1 max-w-md text-xs text-zinc-400 sm:text-sm">
              Restorasi GPU WebGL2 instan langsung di perangkat Anda tanpa upload server. Cocok untuk klip pendek di HP maupun Laptop.
            </p>
            <button
              type="button"
              onClick={() => inputRef.current?.click()}
              className="mt-5 inline-flex items-center gap-2 rounded-xl bg-sky-600 px-4 py-2.5 text-sm font-medium text-white shadow-lg shadow-sky-600/20 hover:bg-sky-500"
            >
              <FileVideo className="h-4 w-4" />
              Pilih File Video Lokal
            </button>
          </div>
        ) : (
          <div className="space-y-3">
            <div className="overflow-hidden rounded-2xl border border-zinc-800 bg-black shadow-xl">
              {processing ? (
                <div className="relative flex aspect-video w-full items-center justify-center bg-black">
                  <canvas
                    ref={previewCanvasRef}
                    className="h-full w-full object-contain"
                  />
                  <div className="pointer-events-none absolute top-3 left-3 inline-flex items-center gap-1.5 rounded-full bg-black/75 px-3 py-1 text-xs font-medium text-emerald-300 backdrop-blur-sm">
                    <span className="h-2 w-2 animate-pulse rounded-full bg-red-500" />
                    Live Frame Restorasi HD...
                  </div>
                </div>
              ) : (
                <YouTubeVideoPlayer
                  src={resultUrl || sourceUrl}
                  compareSrc={resultUrl ? sourceUrl : undefined}
                  mainLabel={targetDims ? `Hasil HD (${targetDims.height}p)` : 'Hasil HD'}
                  compareLabel={sourceMeta ? `Asli (${sourceMeta.h}p)` : 'Asli'}
                  title={sourceFile?.name}
                  qualityBadge={
                    resultUrl && targetDims
                      ? `${targetDims.height}p HD`
                      : sourceMeta
                        ? `${sourceMeta.h}p Asli`
                        : undefined
                  }
                  theaterMode={theaterMode}
                  onToggleTheater={() => setTheaterMode((v) => !v)}
                />
              )}
            </div>

            <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-zinc-800 bg-zinc-900/70 px-3.5 py-2.5 text-xs">
              <div className="flex flex-wrap items-center gap-2 text-zinc-300">
                <span className="font-medium text-zinc-100">{sourceFile?.name}</span>
                {sourceMeta && targetDims && (
                  <span className="rounded bg-zinc-800 px-2 py-0.5 text-zinc-400">
                    {sourceMeta.w}×{sourceMeta.h} → {targetDims.width}×{targetDims.height} (
                    {sourceMeta.duration.toFixed(1)}s)
                  </span>
                )}
                {resultInfo && (
                  <span className="rounded bg-emerald-500/15 px-2 py-0.5 text-emerald-300">
                    {resultInfo}
                  </span>
                )}
                <span className="hidden text-[11px] text-zinc-500 sm:inline">
                  Spasi/K: Putar • J/L: ±10s • M: Mute • T: Teater • F: Fullscreen
                </span>
              </div>

              <div className="flex items-center gap-2">
                <button
                  type="button"
                  disabled={processing}
                  onClick={() => inputRef.current?.click()}
                  className="rounded-lg border border-zinc-700 bg-zinc-800 px-2.5 py-1.5 text-xs font-medium text-zinc-200 hover:bg-zinc-700 disabled:opacity-50"
                >
                  Ganti Video
                </button>
                {resultBlob && (
                  <button
                    type="button"
                    onClick={downloadVideo}
                    className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-emerald-500"
                  >
                    <Download className="h-3.5 w-3.5" />
                    Unduh Video HD
                  </button>
                )}
              </div>
            </div>
          </div>
        )}

        <input
          ref={inputRef}
          type="file"
          accept="video/*"
          className="hidden"
          onChange={(e) => {
            handleVideoFile(e.target.files?.[0])
            e.target.value = ''
          }}
        />
      </div>

      {/* Controls */}
      <div className={`space-y-4 ${theaterMode && sourceUrl ? 'lg:col-span-12' : 'lg:col-span-5'}`}>
        <div className="space-y-4 rounded-2xl border border-zinc-800 bg-zinc-900/60 p-4">
          {/* Presets */}
          <div>
            <label className="mb-2 block text-xs font-semibold uppercase tracking-wider text-zinc-400">
              Preset Restorasi Instant HD GPU
            </label>
            <div className="grid grid-cols-3 gap-2">
              {(Object.keys(VIDEO_PRESETS) as VideoPreset[]).map((key) => (
                <button
                  key={key}
                  type="button"
                  onClick={() => applyPreset(key)}
                  className={`rounded-xl border p-2 text-left transition ${
                    options.preset === key
                      ? 'border-sky-500 bg-sky-500/15 text-white'
                      : 'border-zinc-800 bg-zinc-950/40 text-zinc-400 hover:border-zinc-700'
                  }`}
                >
                  <div className="text-xs font-semibold">{VIDEO_PRESETS[key].label}</div>
                  <div className="mt-0.5 text-[10px] opacity-75">{VIDEO_PRESETS[key].desc}</div>
                </button>
              ))}
            </div>
          </div>

          {/* Scale & Max Resolution */}
          <div className="grid grid-cols-2 gap-3 border-t border-zinc-800/80 pt-3">
            <div>
              <label className="mb-1.5 block text-xs text-zinc-400">Skala Perbesaran</label>
              <div className="grid grid-cols-4 gap-1">
                {([1.5, 2, 3, 4] as const).map((s) => (
                  <button
                    key={s}
                    type="button"
                    onClick={() => setOptions((p) => ({ ...p, scale: s }))}
                    className={`rounded-lg border py-1.5 text-xs font-semibold ${
                      options.scale === s
                        ? 'border-sky-500 bg-sky-600 text-white'
                        : 'border-zinc-800 bg-zinc-950/60 text-zinc-300'
                    }`}
                  >
                    {s}×
                  </button>
                ))}
              </div>
            </div>

            <div>
              <label className="mb-1.5 block text-xs text-zinc-400">Batas Resolusi</label>
              <select
                value={options.maxHeight}
                onChange={(e) =>
                  setOptions((p) => ({
                    ...p,
                    maxHeight: Number(e.target.value) as 720 | 1080 | 2160,
                  }))
                }
                className="w-full rounded-lg border border-zinc-700 bg-zinc-950 px-2.5 py-1.5 text-xs text-zinc-200 outline-none focus:border-sky-500"
              >
                <option value={720}>720p HD (Ringan HP)</option>
                <option value={1080}>1080p Full HD</option>
                <option value={2160}>4K (Laptop GPU)</option>
              </select>
            </div>
          </div>

          {/* FPS & Audio */}
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div>
              <label className="mb-1 block text-xs text-zinc-400">Frame Rate (FPS)</label>
              <select
                value={options.targetFps}
                onChange={(e) => {
                  const val = e.target.value
                  setOptions((p) => ({
                    ...p,
                    targetFps: val === 'source' ? 'source' : (Number(val) as 24 | 30 | 60),
                  }))
                }}
                className="w-full rounded-lg border border-zinc-700 bg-zinc-950 px-2.5 py-1.5 text-xs text-zinc-200 outline-none focus:border-sky-500"
              >
                <option value="source">Ikuti FPS Asli (Tercepat & Halus)</option>
                <option value={24}>24 fps (Sinematik)</option>
                <option value={30}>30 fps (Standar)</option>
                <option value={60}>60 fps (Halus)</option>
              </select>
            </div>

            <div className="flex items-end">
              <button
                type="button"
                onClick={() => setOptions((p) => ({ ...p, includeAudio: !p.includeAudio }))}
                className={`flex w-full items-center justify-center gap-2 rounded-lg border px-3 py-1.5 text-xs font-medium transition ${
                  options.includeAudio
                    ? 'border-emerald-500/60 bg-emerald-500/15 text-emerald-200'
                    : 'border-zinc-700 bg-zinc-950 text-zinc-400'
                }`}
              >
                {options.includeAudio ? (
                  <>
                    <Volume2 className="h-3.5 w-3.5" />
                    Sertakan Audio Asli
                  </>
                ) : (
                  <>
                    <VolumeX className="h-3.5 w-3.5" />
                    Tanpa Audio (MP4 Cepat)
                  </>
                )}
              </button>
            </div>
          </div>

          <div>
            <label className="mb-1 block text-xs text-zinc-400">Mode Encoder</label>
            <select
              value={options.pipeline}
              onChange={(e) =>
                setOptions((p) => ({ ...p, pipeline: e.target.value as VideoPipelineMode }))
              }
              className="w-full rounded-lg border border-zinc-700 bg-zinc-950 px-2.5 py-1.5 text-xs text-zinc-200 outline-none focus:border-sky-500"
            >
              <option value="auto">Otomatis (WebCodecs MP4 + AAC)</option>
              <option value="webcodecs">
                WebCodecs MP4 ({caps.webcodecs ? 'Didukung' : 'Tidak tersedia'})
              </option>
              <option value="recorder">Kompatibel HP (MediaRecorder)</option>
            </select>
          </div>

          {/* Sliders */}
          <div className="space-y-2.5 border-t border-zinc-800/80 pt-3">
            {(
              [
                { key: 'deblock', label: 'Anti-Pecah Video (Deblock)' },
                { key: 'denoise', label: 'Haluskan Noise' },
                { key: 'sharpen', label: 'Ketajaman Frame' },
                { key: 'clarity', label: 'Clarity' },
              ] as const
            ).map((item) => (
              <div key={item.key}>
                <div className="mb-1 flex justify-between text-xs">
                  <span className="text-zinc-300">{item.label}</span>
                  <span className="font-mono text-sky-300">{options[item.key]}%</span>
                </div>
                <input
                  type="range"
                  min={0}
                  max={100}
                  value={options[item.key]}
                  onChange={(e) =>
                    setOptions((p) => ({ ...p, [item.key]: Number(e.target.value) }))
                  }
                  className="studio-slider w-full"
                />
              </div>
            ))}
          </div>

          <p className="rounded-xl border border-zinc-800 bg-zinc-950/60 px-3 py-2 text-[11px] text-zinc-400">
            Menggunakan akselerasi GPU WebGL2 frame-demi-frame dan WebCodecs MP4 + audio AAC langsung di perangkat Anda.
          </p>

          {errorMsg && (
            <div className="rounded-xl border border-rose-500/40 bg-rose-500/10 p-3 text-xs text-rose-200">
              {errorMsg}
            </div>
          )}

          {progress && (
            <div className="space-y-1.5 rounded-xl border border-sky-500/30 bg-sky-500/10 p-3">
              <div className="flex items-center justify-between text-xs font-medium text-sky-200">
                <span>{progress.stage}</span>
                <span>{progress.percent}%</span>
              </div>
              <div className="h-2 overflow-hidden rounded-full bg-zinc-800">
                <div
                  className="h-full rounded-full bg-sky-500 transition-all duration-200"
                  style={{ width: `${progress.percent}%` }}
                />
              </div>
              {progress.detail && (
                <div className="text-[11px] text-zinc-400">{progress.detail}</div>
              )}
            </div>
          )}

          <div className="flex gap-2">
            <button
              type="button"
              disabled={!sourceFile || processing}
              onClick={runVideoUpscale}
              className="flex flex-1 items-center justify-center gap-2 rounded-xl bg-gradient-to-r from-sky-600 to-violet-600 px-4 py-3 text-sm font-semibold text-white shadow-lg shadow-sky-600/20 transition hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-45"
            >
              {processing ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" />
                  Merestorasi Video...
                </>
              ) : (
                <>
                  <Wand2 className="h-4 w-4" />
                  Proses Video HD
                </>
              )}
            </button>
            {processing && (
              <button
                type="button"
                onClick={() => abortRef.current?.abort()}
                className="inline-flex items-center justify-center rounded-xl border border-zinc-700 bg-zinc-800 px-3.5 text-zinc-200 hover:bg-zinc-700"
                title="Batalkan"
              >
                <X className="h-4 w-4" />
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
