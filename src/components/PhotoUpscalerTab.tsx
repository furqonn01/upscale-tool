import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Cpu,
  Download,
  FileUp,
  Image as ImageIcon,
  Loader2,
  Sparkles,
  Trash2,
  Wand2,
  X,
  Zap,
} from 'lucide-react'
import {
  clearModelCache,
  CURATED_ONNX_MODELS,
  isModelCached,
} from '../engines/onnxModels'
import { upscaleImageWithWebGL } from '../engines/webglProcessor'
import type {
  DeviceCapabilities,
  OnnxExecutionBackend,
  OutputImageFormat,
  PhotoUpscaleOptions,
  ProgressInfo,
  RestorationPreset,
} from '../types'
import { formatBytes, getPresetSettings } from '../utils/device'
import { saveGalleryItem } from '../utils/storage'
import { BeforeAfterSlider } from './BeforeAfterSlider'

interface PhotoUpscalerTabProps {
  caps: DeviceCapabilities
  incomingImage: { blob: Blob; title: string; nonce: number } | null
  onGalleryUpdated: () => void
}

const PRESET_CARDS: Array<{ id: RestorationPreset; label: string; desc: string }> = [
  { id: 'photo-burik', label: 'Foto Burik → HD', desc: 'Bersihkan pecah JPEG & blur' },
  { id: 'anime', label: 'Anime / Ilustrasi', desc: 'Garis tajam & warna bersih' },
  { id: 'portrait-soft', label: 'Wajah / Portrait', desc: 'Kulit halus tanpa noise kasar' },
  { id: 'sharp-text', label: 'Teks / Dokumen', desc: 'Tulisan & screenshot ekstra tajam' },
]

function computeSafeSourceFit(
  srcW: number,
  srcH: number,
  scale: number,
  isMobile: boolean
): { w: number; h: number; fitted: boolean } {
  const maxDim = isMobile ? 4096 : 8192
  const maxPixels = isMobile ? 16_000_000 : 48_000_000
  const maxSrcDim = Math.floor(maxDim / scale)
  const maxSrcPixels = Math.floor(maxPixels / (scale * scale))

  let factor = 1
  if (srcW > maxSrcDim) factor = Math.min(factor, maxSrcDim / srcW)
  if (srcH > maxSrcDim) factor = Math.min(factor, maxSrcDim / srcH)
  if (srcW * srcH > maxSrcPixels) {
    factor = Math.min(factor, Math.sqrt(maxSrcPixels / (srcW * srcH)))
  }

  if (factor >= 0.999) {
    return { w: srcW, h: srcH, fitted: false }
  }
  return {
    w: Math.max(64, Math.floor(srcW * factor)),
    h: Math.max(64, Math.floor(srcH * factor)),
    fitted: true,
  }
}

function getResolutionTierLabel(w: number, h: number): string {
  const longSide = Math.max(w, h)
  const shortSide = Math.min(w, h)
  if (longSide >= 3840 || shortSide >= 2160) return '4K UHD'
  if (longSide >= 2560 || shortSide >= 1440) return '2K QHD'
  if (longSide >= 1920 || shortSide >= 1080) return 'Full HD'
  if (longSide >= 1280 || shortSide >= 720) return 'HD'
  return ''
}

export function PhotoUpscalerTab({
  caps,
  incomingImage,
  onGalleryUpdated,
}: PhotoUpscalerTabProps) {
  const fileInputRef = useRef<HTMLInputElement>(null)
  const onnxInputRef = useRef<HTMLInputElement>(null)
  const abortRef = useRef<AbortController | null>(null)

  const [sourceBlob, setSourceBlob] = useState<Blob | null>(null)
  const [sourceName, setSourceName] = useState<string>('foto')
  const [sourceDims, setSourceDims] = useState<{ w: number; h: number } | null>(null)
  const [beforeUrl, setBeforeUrl] = useState<string | null>(null)

  const [afterBlob, setAfterBlob] = useState<Blob | null>(null)
  const [afterUrl, setAfterUrl] = useState<string | null>(null)
  const [afterDims, setAfterDims] = useState<{ w: number; h: number } | null>(null)
  const [processInfo, setProcessInfo] = useState<string>('')

  const [processing, setProcessing] = useState(false)
  const [progress, setProgress] = useState<ProgressInfo | null>(null)
  const [errorMsg, setErrorMsg] = useState<string | null>(null)
  const [cachedModelMap, setCachedModelMap] = useState<Record<string, boolean>>({})
  const [autoFitSafe, setAutoFitSafe] = useState(true)

  const [options, setOptions] = useState<PhotoUpscaleOptions>(() => ({
    engine: 'instant-hd',
    preset: 'photo-burik',
    scale: 2,
    ...getPresetSettings('photo-burik'),
    tileSize: caps.recommendedTileSize,
    onnxModelId: CURATED_ONNX_MODELS[0].id,
    customModelFile: null,
    onnxBackend: 'auto',
    outputFormat: 'image/png',
  }))

  const activeOnnxModel = useMemo(
    () => CURATED_ONNX_MODELS.find((m) => m.id === options.onnxModelId) ?? CURATED_ONNX_MODELS[0],
    [options.onnxModelId]
  )

  const refreshModelCacheStatus = useCallback(async () => {
    const entries = await Promise.all(
      CURATED_ONNX_MODELS.map(async (m) => [m.id, await isModelCached(m.url)] as const)
    )
    setCachedModelMap(Object.fromEntries(entries))
  }, [])

  const loadSourceBlob = useCallback((blob: Blob, name: string) => {
    setErrorMsg(null)
    setAfterBlob(null)
    setAfterDims(null)
    setProcessInfo('')
    setAfterUrl(null)

    const nextUrl = URL.createObjectURL(blob)
    setBeforeUrl(nextUrl)
    setSourceBlob(blob)
    setSourceName(name.replace(/\.[^.]+$/, '') || 'foto')

    const img = new Image()
    img.onload = () => {
      setSourceDims({ w: img.naturalWidth, h: img.naturalHeight })
    }
    img.src = nextUrl
  }, [])

  useEffect(() => {
    let active = true
    Promise.all(
      CURATED_ONNX_MODELS.map(async (m) => [m.id, await isModelCached(m.url)] as const)
    )
      .then((entries) => {
        if (active) setCachedModelMap(Object.fromEntries(entries))
      })
      .catch(() => undefined)
    return () => {
      active = false
    }
  }, [])

  // Handle incoming image from AI Generator or Gallery asynchronously
  useEffect(() => {
    if (!incomingImage) return
    let active = true
    createImageBitmap(incomingImage.blob)
      .then((bmp) => {
        const w = bmp.width
        const h = bmp.height
        bmp.close()
        if (!active) return
        const nextUrl = URL.createObjectURL(incomingImage.blob)
        setErrorMsg(null)
        setAfterBlob(null)
        setAfterDims(null)
        setProcessInfo('')
        setAfterUrl(null)
        setBeforeUrl(nextUrl)
        setSourceBlob(incomingImage.blob)
        setSourceName(incomingImage.title.replace(/\.[^.]+$/, '') || 'foto')
        setSourceDims({ w, h })
      })
      .catch(() => undefined)
    return () => {
      active = false
    }
  }, [incomingImage])

  useEffect(() => {
    return () => {
      if (beforeUrl) URL.revokeObjectURL(beforeUrl)
    }
  }, [beforeUrl])

  useEffect(() => {
    return () => {
      if (afterUrl) URL.revokeObjectURL(afterUrl)
    }
  }, [afterUrl])

  const handleFileSelected = (file: File | undefined) => {
    if (!file) return
    if (!file.type.startsWith('image/')) {
      setErrorMsg('Pilih file gambar (JPG, PNG, WebP, HEIC yang didukung browser).')
      return
    }
    loadSourceBlob(file, file.name)
  }

  const generateBurikSample = async () => {
    // Generate a low-res blurry/compressed sample locally to demonstrate restoration immediately
    const c = document.createElement('canvas')
    c.width = 240
    c.height = 160
    const ctx = c.getContext('2d')
    if (!ctx) return
    const grad = ctx.createLinearGradient(0, 0, 240, 160)
    grad.addColorStop(0, '#1e1b4b')
    grad.addColorStop(0.5, '#6d28d9')
    grad.addColorStop(1, '#0284c7')
    ctx.fillStyle = grad
    ctx.fillRect(0, 0, 240, 160)

    ctx.fillStyle = '#fde047'
    ctx.beginPath()
    ctx.arc(58, 52, 22, 0, Math.PI * 2)
    ctx.fill()

    ctx.fillStyle = '#0f172a'
    ctx.beginPath()
    ctx.moveTo(0, 160)
    ctx.lineTo(80, 74)
    ctx.lineTo(145, 118)
    ctx.lineTo(195, 64)
    ctx.lineTo(240, 128)
    ctx.lineTo(240, 160)
    ctx.closePath()
    ctx.fill()

    ctx.fillStyle = '#ffffff'
    ctx.font = 'bold 20px sans-serif'
    ctx.fillText('SAMPLE HD', 66, 144)

    // Compress hard as low quality JPEG so artifacts ("burik") appear visibly
    const blob = await new Promise<Blob | null>((resolve) =>
      c.toBlob((b) => resolve(b), 'image/jpeg', 0.25)
    )
    if (blob) loadSourceBlob(blob, 'sample-burik')
  }

  const applyPreset = (preset: RestorationPreset) => {
    setOptions((prev) => ({
      ...prev,
      preset,
      ...getPresetSettings(preset),
    }))
  }

  const runUpscale = useCallback(async () => {
    if (!sourceBlob) return
    setErrorMsg(null)
    setProcessing(true)
    setProgress({ percent: 5, stage: 'Membaca gambar lokal...' })

    const controller = new AbortController()
    abortRef.current = controller
    const startedAt = performance.now()

    const saveResult = async (
      blob: Blob,
      width: number,
      height: number,
      engineLabel: string
    ) => {
      const elapsedSec = ((performance.now() - startedAt) / 1000).toFixed(1)
      const nextUrl = URL.createObjectURL(blob)
      setAfterBlob(blob)
      setAfterUrl(nextUrl)
      setAfterDims({ w: width, h: height })
      setProcessInfo(`${engineLabel} • ${elapsedSec}s • ${formatBytes(blob.size)}`)

      await saveGalleryItem({
        id: `photo-${Date.now()}`,
        kind: 'upscale-photo',
        title: `${sourceName}-HD-${width}x${height}`,
        createdAt: Date.now(),
        mimeType: blob.type || options.outputFormat,
        blob,
        width,
        height,
        meta: `${engineLabel} (${elapsedSec}s)`,
      }).catch(() => undefined)
      onGalleryUpdated()
    }

    try {
      const rawBitmap = await createImageBitmap(sourceBlob)
      const activeScale =
        options.engine === 'ai-onnx' && !options.customModelFile
          ? activeOnnxModel.scale
          : options.scale

      const safeFit = autoFitSafe
        ? computeSafeSourceFit(rawBitmap.width, rawBitmap.height, activeScale, caps.isMobile)
        : { w: rawBitmap.width, h: rawBitmap.height, fitted: false }

      let workingBitmap = rawBitmap
      if (safeFit.fitted) {
        setProgress({
          percent: 7,
          stage: `Menyesuaikan resolusi aman (${safeFit.w}×${safeFit.h})...`,
        })
        workingBitmap = await createImageBitmap(rawBitmap, {
          resizeWidth: safeFit.w,
          resizeHeight: safeFit.h,
          resizeQuality: 'high',
        })
        rawBitmap.close()
      }

      try {
        if (options.engine === 'instant-hd') {
          const result = await upscaleImageWithWebGL(
            workingBitmap,
            options.scale,
            {
              denoise: options.denoise,
              deblock: options.deblock,
              sharpen: options.sharpen,
              clarity: options.clarity,
            },
            caps.maxTextureSize,
            caps.isMobile,
            options.outputFormat,
            setProgress
          )
          await saveResult(result.blob, result.width, result.height, 'Instant HD GPU (EASU+RCAS)')
        } else {
          setProgress({ percent: 8, stage: 'Memuat modul AI ONNX...' })
          const { upscaleImageWithOnnx } = await import('../engines/onnxUpscaler')
          const result = await upscaleImageWithOnnx(
            workingBitmap,
            activeOnnxModel,
            options.customModelFile,
            options.tileSize,
            options.onnxBackend !== 'wasm' && caps.webgpu,
            caps.isMobile,
            options.outputFormat,
            setProgress,
            controller.signal
          )
          await refreshModelCacheStatus()
          await saveResult(
            result.blob,
            result.width,
            result.height,
            `AI ONNX (${result.provider})`
          )
        }
      } finally {
        workingBitmap.close()
      }
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') {
        setErrorMsg('Proses dibatalkan.')
      } else {
        setErrorMsg(err instanceof Error ? err.message : 'Gagal memproses gambar')
      }
    } finally {
      abortRef.current = null
      setProcessing(false)
      setProgress(null)
    }
  }, [activeOnnxModel, autoFitSafe, caps.isMobile, caps.maxTextureSize, caps.webgpu, onGalleryUpdated, options, refreshModelCacheStatus, sourceBlob, sourceName])

  const downloadOutput = () => {
    if (!afterBlob || !afterUrl) return
    const ext =
      options.outputFormat === 'image/jpeg'
        ? 'jpg'
        : options.outputFormat === 'image/webp'
          ? 'webp'
          : 'png'
    const a = document.createElement('a')
    a.href = afterUrl
    a.download = `${sourceName}-HD.${ext}`
    a.click()
  }

  const effectiveScale =
    options.engine === 'ai-onnx' && !options.customModelFile
      ? activeOnnxModel.scale
      : options.scale

  const predictedFit = sourceDims
    ? autoFitSafe
      ? computeSafeSourceFit(sourceDims.w, sourceDims.h, effectiveScale, caps.isMobile)
      : { w: sourceDims.w, h: sourceDims.h, fitted: false }
    : null

  const predictedOutW = predictedFit ? predictedFit.w * effectiveScale : 0
  const predictedOutH = predictedFit ? predictedFit.h * effectiveScale : 0
  const predictedTier = predictedFit ? getResolutionTierLabel(predictedOutW, predictedOutH) : ''
  const predictedDims = predictedFit
    ? `${predictedOutW} × ${predictedOutH}${predictedTier ? ` (${predictedTier})` : ''}${predictedFit.fitted ? ' • Auto-Fit' : ''}`
    : null

  const isMultiThreadReady =
    typeof window !== 'undefined' && Boolean(window.crossOriginIsolated)

  return (
    <div className="grid grid-cols-1 gap-5 lg:grid-cols-12">
      {/* Left / Top Preview Canvas */}
      <div className="space-y-4 lg:col-span-7">
        {!beforeUrl ? (
          <div
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => {
              e.preventDefault()
              handleFileSelected(e.dataTransfer.files?.[0])
            }}
            className="flex min-h-[300px] flex-col items-center justify-center rounded-2xl border-2 border-dashed border-zinc-700/80 bg-zinc-900/50 p-6 text-center transition hover:border-violet-500/70"
          >
            <div className="mb-3 flex h-14 w-14 items-center justify-center rounded-2xl bg-violet-500/15 text-violet-400">
              <ImageIcon className="h-7 w-7" />
            </div>
            <h2 className="text-base font-semibold text-zinc-100 sm:text-lg">
              Pilih atau Tarik Foto Burik ke Sini
            </h2>
            <p className="mt-1 max-w-md text-xs text-zinc-400 sm:text-sm">
              100% diproses di perangkat Anda (HP/Laptop). Tidak ada foto yang diunggah ke server.
            </p>
            <div className="mt-5 flex flex-wrap items-center justify-center gap-2.5">
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                className="inline-flex items-center gap-2 rounded-xl bg-violet-600 px-4 py-2.5 text-sm font-medium text-white shadow-lg shadow-violet-600/20 transition hover:bg-violet-500 active:scale-[0.98]"
              >
                <FileUp className="h-4 w-4" />
                Pilih Foto dari Galeri
              </button>
              <button
                type="button"
                onClick={generateBurikSample}
                className="inline-flex items-center gap-2 rounded-xl border border-zinc-700 bg-zinc-800/80 px-3.5 py-2.5 text-sm font-medium text-zinc-200 transition hover:bg-zinc-800"
              >
                <Sparkles className="h-4 w-4 text-amber-400" />
                Coba Sample Burik
              </button>
            </div>
          </div>
        ) : (
          <div className="space-y-3">
            <BeforeAfterSlider
              beforeUrl={beforeUrl}
              afterUrl={afterUrl}
              beforeLabel={sourceDims ? `Asli ${sourceDims.w}×${sourceDims.h}` : 'Asli'}
              afterLabel={afterDims ? `HD ${afterDims.w}×${afterDims.h}` : 'Hasil HD'}
            />

            <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-zinc-800 bg-zinc-900/70 px-3.5 py-2.5 text-xs text-zinc-300">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-medium text-zinc-100">{sourceName}</span>
                {sourceDims && (
                  <span className="rounded bg-zinc-800 px-2 py-0.5 text-zinc-400">
                    {sourceDims.w}×{sourceDims.h}
                    {predictedDims ? ` → ${predictedDims}` : ''}
                  </span>
                )}
                {processInfo && (
                  <span className="rounded bg-emerald-500/15 px-2 py-0.5 text-emerald-300">
                    {processInfo}
                  </span>
                )}
              </div>

              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => fileInputRef.current?.click()}
                  className="rounded-lg border border-zinc-700 bg-zinc-800 px-2.5 py-1.5 text-xs font-medium text-zinc-200 hover:bg-zinc-700"
                >
                  Ganti Foto
                </button>
                {afterBlob && (
                  <button
                    type="button"
                    onClick={downloadOutput}
                    className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-emerald-500"
                  >
                    <Download className="h-3.5 w-3.5" />
                    Unduh HD
                  </button>
                )}
              </div>
            </div>
          </div>
        )}

        <input
          ref={fileInputRef}
          type="file"
          accept="image/*"
          className="hidden"
          onChange={(e) => {
            handleFileSelected(e.target.files?.[0])
            e.target.value = ''
          }}
        />
      </div>

      {/* Right / Bottom Controls */}
      <div className="space-y-4 lg:col-span-5">
        <div className="rounded-2xl border border-zinc-800 bg-zinc-900/60 p-4 space-y-4">
          {/* Engine Mode Selector */}
          <div>
            <label className="mb-2 block text-xs font-semibold uppercase tracking-wider text-zinc-400">
              Mesin Pemrosesan Lokal
            </label>
            <div className="grid grid-cols-2 gap-2">
              <button
                type="button"
                onClick={() => setOptions((p) => ({ ...p, engine: 'instant-hd' }))}
                className={`flex flex-col items-start rounded-xl border p-3 text-left transition ${
                  options.engine === 'instant-hd'
                    ? 'border-violet-500 bg-violet-500/15 text-zinc-100'
                    : 'border-zinc-800 bg-zinc-950/50 text-zinc-400 hover:border-zinc-700'
                }`}
              >
                <span className="inline-flex items-center gap-1.5 text-xs font-semibold">
                  <Zap className="h-3.5 w-3.5 text-amber-400" />
                  Instant HD GPU
                </span>
                <span className="mt-1 text-[11px] opacity-80">
                  EASU + RCAS • 0 MB • &lt; 1 detik di HP &amp; Laptop
                </span>
              </button>

              <button
                type="button"
                onClick={() => setOptions((p) => ({ ...p, engine: 'ai-onnx' }))}
                className={`flex flex-col items-start rounded-xl border p-3 text-left transition ${
                  options.engine === 'ai-onnx'
                    ? 'border-violet-500 bg-violet-500/15 text-zinc-100'
                    : 'border-zinc-800 bg-zinc-950/50 text-zinc-400 hover:border-zinc-700'
                }`}
              >
                <span className="inline-flex items-center gap-1.5 text-xs font-semibold">
                  <Cpu className="h-3.5 w-3.5 text-sky-400" />
                  AI Neural (ONNX)
                </span>
                <span className="mt-1 text-[11px] opacity-80">
                  Swin2SR / Real-ESRGAN lokal
                </span>
              </button>
            </div>
          </div>

          {options.engine === 'instant-hd' ? (
            <>
              {/* Presets */}
              <div>
                <label className="mb-2 block text-xs font-semibold uppercase tracking-wider text-zinc-400">
                  Preset Restorasi
                </label>
                <div className="grid grid-cols-2 gap-2">
                  {PRESET_CARDS.map((p) => (
                    <button
                      key={p.id}
                      type="button"
                      onClick={() => applyPreset(p.id)}
                      className={`rounded-xl border px-3 py-2 text-left transition ${
                        options.preset === p.id
                          ? 'border-violet-500/80 bg-violet-500/10 text-white'
                          : 'border-zinc-800 bg-zinc-950/40 text-zinc-400 hover:border-zinc-700'
                      }`}
                    >
                      <div className="text-xs font-semibold">{p.label}</div>
                      <div className="text-[11px] opacity-75">{p.desc}</div>
                    </button>
                  ))}
                </div>
              </div>

              {/* Scale */}
              <div>
                <div className="mb-1.5 flex items-center justify-between text-xs">
                  <span className="font-semibold uppercase tracking-wider text-zinc-400">
                    Skala Perbesaran
                  </span>
                </div>
                <div className="grid grid-cols-3 gap-2">
                  {([2, 3, 4] as const).map((s) => (
                    <button
                      key={s}
                      type="button"
                      onClick={() => setOptions((p) => ({ ...p, scale: s }))}
                      className={`rounded-lg border py-2 text-xs font-semibold transition ${
                        options.scale === s
                          ? 'border-violet-500 bg-violet-600 text-white'
                          : 'border-zinc-800 bg-zinc-950/60 text-zinc-300 hover:border-zinc-700'
                      }`}
                    >
                      {s}× HD
                    </button>
                  ))}
                </div>
              </div>

              {/* Fine Sliders */}
              <div className="space-y-3 border-t border-zinc-800/80 pt-3">
                {(
                  [
                    { key: 'deblock', label: 'Anti-Pecah JPEG (Deblock)' },
                    { key: 'denoise', label: 'Haluskan Noise (De-burik)' },
                    { key: 'sharpen', label: 'Ketajaman Detail' },
                    { key: 'clarity', label: 'Clarity & Kontras Mikro' },
                  ] as const
                ).map((item) => (
                  <div key={item.key}>
                    <div className="mb-1 flex justify-between text-xs">
                      <span className="text-zinc-300">{item.label}</span>
                      <span className="font-mono text-violet-300">{options[item.key]}%</span>
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
            </>
          ) : (
            <div className="space-y-3">
              <div>
                <div className="mb-1.5 flex items-center justify-between">
                  <label className="text-xs font-semibold uppercase tracking-wider text-zinc-400">
                    Model AI Lokal (Cache Browser)
                  </label>
                  <button
                    type="button"
                    onClick={async () => {
                      await clearModelCache()
                      await refreshModelCacheStatus()
                    }}
                    className="inline-flex items-center gap-1 text-[11px] text-zinc-400 hover:text-rose-400"
                  >
                    <Trash2 className="h-3 w-3" />
                    Hapus Cache
                  </button>
                </div>

                <div className="space-y-2">
                  {CURATED_ONNX_MODELS.map((m) => {
                    const selected = !options.customModelFile && options.onnxModelId === m.id
                    const isCached = Boolean(cachedModelMap[m.id])
                    return (
                      <button
                        key={m.id}
                        type="button"
                        onClick={() =>
                          setOptions((p) => ({
                            ...p,
                            onnxModelId: m.id,
                            customModelFile: null,
                          }))
                        }
                        className={`w-full rounded-xl border p-2.5 text-left transition ${
                          selected
                            ? 'border-violet-500 bg-violet-500/15 text-white'
                            : 'border-zinc-800 bg-zinc-950/50 text-zinc-300 hover:border-zinc-700'
                        }`}
                      >
                        <div className="flex items-center justify-between gap-2">
                          <span className="text-xs font-semibold">{m.name}</span>
                          <span
                            className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${
                              isCached
                                ? 'bg-emerald-500/20 text-emerald-300'
                                : 'bg-zinc-800 text-zinc-400'
                            }`}
                          >
                            {isCached ? 'Siap Offline' : m.sizeLabel}
                          </span>
                        </div>
                        <p className="mt-0.5 text-[11px] text-zinc-400">{m.bestFor}</p>
                      </button>
                    )
                  })}
                </div>
              </div>

              {/* Local custom .onnx file */}
              <div className="rounded-xl border border-zinc-800 bg-zinc-950/50 p-3">
                <div className="flex items-center justify-between gap-2">
                  <div className="text-xs">
                    <div className="font-medium text-zinc-200">
                      Atau pakai file .onnx lokal sendiri
                    </div>
                    <div className="text-[11px] text-zinc-400">
                      {options.customModelFile
                        ? `Aktif: ${options.customModelFile.name}`
                        : '100% offline tanpa unduh model'}
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() => onnxInputRef.current?.click()}
                    className="rounded-lg border border-zinc-700 bg-zinc-800 px-2.5 py-1.5 text-xs font-medium text-zinc-200 hover:bg-zinc-700"
                  >
                    Pilih .onnx
                  </button>
                </div>
                <input
                  ref={onnxInputRef}
                  type="file"
                  accept=".onnx"
                  className="hidden"
                  onChange={(e) => {
                    const file = e.target.files?.[0]
                    if (file) {
                      setOptions((p) => ({ ...p, customModelFile: file }))
                    }
                    e.target.value = ''
                  }}
                />
              </div>

              {/* Tile size selector for HP vs Laptop stability */}
              <div>
                <div className="mb-1 flex items-center justify-between text-xs">
                  <span className="text-zinc-300">Ukuran Tile Memori</span>
                  <span className="text-[11px] text-zinc-400">
                    {caps.isMobile ? 'HP: disarankan 128px' : 'Laptop: 192–256px'}
                  </span>
                </div>
                <div className="grid grid-cols-4 gap-1.5">
                  {([128, 192, 256, 384] as const).map((ts) => (
                    <button
                      key={ts}
                      type="button"
                      onClick={() => setOptions((p) => ({ ...p, tileSize: ts }))}
                      className={`rounded-lg border py-1.5 text-xs font-medium ${
                        options.tileSize === ts
                          ? 'border-violet-500 bg-violet-600 text-white'
                          : 'border-zinc-800 bg-zinc-950/60 text-zinc-400'
                      }`}
                    >
                      {ts}px
                    </button>
                  ))}
                </div>
              </div>

              {/* Execution backend selector */}
              <div>
                <div className="mb-1 flex items-center justify-between text-xs">
                  <span className="text-zinc-300">Backend Eksekusi AI</span>
                  <span className="text-[11px] text-zinc-400">
                    Pilih WASM jika GPU error
                  </span>
                </div>
                <select
                  value={options.onnxBackend ?? 'auto'}
                  onChange={(e) =>
                    setOptions((p) => ({
                      ...p,
                      onnxBackend: e.target.value as OnnxExecutionBackend,
                    }))
                  }
                  className="w-full rounded-lg border border-zinc-700 bg-zinc-950 px-2.5 py-1.5 text-xs text-zinc-200 outline-none focus:border-violet-500"
                >
                  <option value="auto">
                    Auto ({caps.webgpu ? 'WebGPU → WASM' : isMultiThreadReady ? 'WASM Multi-Thread' : 'WASM'})
                  </option>
                  <option value="wasm">
                    WASM CPU ({isMultiThreadReady ? 'Multi-Thread SIMD' : 'Stabil / Tanpa WebGPU'})
                  </option>
                </select>
              </div>
            </div>
          )}

          {/* Safe Auto-Fit & Output Format */}
          <div className="space-y-2.5 border-t border-zinc-800/80 pt-3">
            <label className="flex cursor-pointer items-center justify-between gap-2 text-xs text-zinc-300">
              <span>Auto-Fit Foto Besar (Anti-Crash HP/Laptop)</span>
              <input
                type="checkbox"
                checked={autoFitSafe}
                onChange={(e) => setAutoFitSafe(e.target.checked)}
                className="h-4 w-4 accent-violet-500"
              />
            </label>

            <div className="flex items-center justify-between gap-3">
              <span className="text-xs text-zinc-400">Format Output</span>
              <select
                value={options.outputFormat}
                onChange={(e) =>
                  setOptions((p) => ({ ...p, outputFormat: e.target.value as OutputImageFormat }))
                }
                className="rounded-lg border border-zinc-700 bg-zinc-950 px-2.5 py-1.5 text-xs text-zinc-200 outline-none focus:border-violet-500"
              >
                <option value="image/png">PNG (Lossless HD)</option>
                <option value="image/webp">WebP (Cepat &amp; Hemat)</option>
                <option value="image/jpeg">JPEG (Kompatibel Semua)</option>
              </select>
            </div>
          </div>

          {errorMsg && (
            <div className="rounded-xl border border-rose-500/40 bg-rose-500/10 p-3 text-xs text-rose-200">
              {errorMsg}
            </div>
          )}

          {progress && (
            <div className="space-y-1.5 rounded-xl border border-violet-500/30 bg-violet-500/10 p-3">
              <div className="flex items-center justify-between text-xs font-medium text-violet-200">
                <span>{progress.stage}</span>
                <span>{progress.percent}%</span>
              </div>
              <div className="h-2 overflow-hidden rounded-full bg-zinc-800">
                <div
                  className="h-full rounded-full bg-violet-500 transition-all duration-200"
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
              disabled={!sourceBlob || processing}
              onClick={runUpscale}
              className="flex flex-1 items-center justify-center gap-2 rounded-xl bg-gradient-to-r from-violet-600 to-sky-600 px-4 py-3 text-sm font-semibold text-white shadow-lg shadow-violet-600/20 transition hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-45"
            >
              {processing ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" />
                  Memproses HD...
                </>
              ) : (
                <>
                  <Wand2 className="h-4 w-4" />
                  Jadikan HD Sekarang
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
