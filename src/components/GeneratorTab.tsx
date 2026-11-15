import { useEffect, useRef, useState } from 'react'
import {
  ArrowUpRight,
  Download,
  KeyRound,
  Loader2,
  PenTool,
  Sparkles,
  Wand2,
} from 'lucide-react'
import {
  enhancePromptWithLlm,
  generateImageWithProfile,
  generateSvgWithLlm,
  svgMarkupToPngBlob,
} from '../engines/apiClient'
import type { ApiProfile } from '../types'
import { saveGalleryItem } from '../utils/storage'

interface GeneratorTabProps {
  activeProfile: ApiProfile
  onOpenSettings: () => void
  onSendToUpscaler: (blob: Blob, title: string) => void
  onGalleryUpdated: () => void
}

interface GeneratedCard {
  id: string
  blob: Blob
  url: string
  svgMarkup?: string
  title: string
  modeLabel: string
}

const STYLE_CHIPS = [
  'Photorealistic 8K Cinematic',
  'Anime Key Visual',
  '3D Pixar / Unreal Render',
  'Minimalist Vector Illustration',
  'Cyberpunk Neon Photography',
  'Watercolor Painting',
]

export function GeneratorTab({
  activeProfile,
  onOpenSettings,
  onSendToUpscaler,
  onGalleryUpdated,
}: GeneratorTabProps) {
  const [genMode, setGenMode] = useState<'image-api' | 'svg-nonvision'>('image-api')
  const [rawIdea, setRawIdea] = useState('')
  const [prompt, setPrompt] = useState('')
  const [negativePrompt, setNegativePrompt] = useState(
    'blurry, lowres, jpeg artifacts, watermark, bad anatomy'
  )
  const [stylePreset, setStylePreset] = useState(STYLE_CHIPS[0])
  const [size, setSize] = useState<'1024x1024' | '1024x1792' | '1792x1024'>('1024x1024')
  const [batchCount, setBatchCount] = useState<1 | 2 | 4>(1)

  const [enhancing, setEnhancing] = useState(false)
  const [generating, setGenerating] = useState(false)
  const [statusMsg, setStatusMsg] = useState<string | null>(null)
  const [errorMsg, setErrorMsg] = useState<string | null>(null)
  const [results, setResults] = useState<GeneratedCard[]>([])
  const resultsRef = useRef<GeneratedCard[]>([])

  useEffect(() => {
    resultsRef.current = results
  }, [results])

  useEffect(() => {
    return () => {
      for (const r of resultsRef.current) URL.revokeObjectURL(r.url)
    }
  }, [])

  const handleEnhancePrompt = async () => {
    const idea = rawIdea.trim() || prompt.trim()
    if (!idea) {
      setErrorMsg('Tulis ide singkat dulu sebelum diracik.')
      return
    }
    setErrorMsg(null)
    setEnhancing(true)
    try {
      const enhanced = await enhancePromptWithLlm(activeProfile, idea, stylePreset)
      setPrompt(enhanced.prompt)
      setNegativePrompt(enhanced.negativePrompt)
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Gagal meracik prompt')
    } finally {
      setEnhancing(false)
    }
  }

  const handleGenerate = async () => {
    const finalPrompt = (prompt.trim() || rawIdea.trim())
    if (!finalPrompt) {
      setErrorMsg('Masukkan prompt atau ide gambar terlebih dahulu.')
      return
    }

    setErrorMsg(null)
    setGenerating(true)
    const count = genMode === 'svg-nonvision' ? 1 : batchCount
    const nextCards: GeneratedCard[] = []

    try {
      for (let i = 0; i < count; i++) {
        setStatusMsg(
          count > 1
            ? `Membuat gambar ${i + 1}/${count}...`
            : genMode === 'svg-nonvision'
              ? `Membuat ilustrasi vector SVG via ${activeProfile.textModel}...`
              : `Membuat gambar via ${activeProfile.imageModel}...`
        )

        if (genMode === 'svg-nonvision') {
          const [w, h] = size.split('x').map(Number)
          const svgMarkup = await generateSvgWithLlm(
            activeProfile,
            `${finalPrompt} (${stylePreset})`,
            w,
            h
          )
          const pngBlob = await svgMarkupToPngBlob(svgMarkup, w, h)
          const url = URL.createObjectURL(pngBlob)
          const card: GeneratedCard = {
            id: `svg-${Date.now()}-${i}`,
            blob: pngBlob,
            url,
            svgMarkup,
            title: `vector-${Date.now()}`,
            modeLabel: `SVG Vector (${activeProfile.textModel})`,
          }
          nextCards.push(card)

          await saveGalleryItem({
            id: card.id,
            kind: 'generated-svg',
            title: finalPrompt.slice(0, 48),
            createdAt: Date.now(),
            mimeType: 'image/png',
            blob: pngBlob,
            width: w,
            height: h,
            meta: card.modeLabel,
          }).catch(() => undefined)
        } else {
          const res = await generateImageWithProfile(
            activeProfile,
            `${finalPrompt}, ${stylePreset}`,
            { size, negativePrompt }
          )
          const url = URL.createObjectURL(res.blob)
          const card: GeneratedCard = {
            id: `gen-${Date.now()}-${i}`,
            blob: res.blob,
            url,
            title: `ai-gen-${Date.now()}-${i + 1}`,
            modeLabel: res.usedMode,
          }
          nextCards.push(card)

          await saveGalleryItem({
            id: card.id,
            kind: 'generated-image',
            title: finalPrompt.slice(0, 48),
            createdAt: Date.now(),
            mimeType: res.mimeType,
            blob: res.blob,
            meta: `${activeProfile.imageModel} (${res.usedMode})`,
          }).catch(() => undefined)
        }
      }

      setResults((prev) => [...nextCards, ...prev])
      onGalleryUpdated()
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Gagal generate gambar')
    } finally {
      setGenerating(false)
      setStatusMsg(null)
    }
  }

  const downloadCard = (card: GeneratedCard, asSvg = false) => {
    const a = document.createElement('a')
    if (asSvg && card.svgMarkup) {
      const svgBlob = new Blob([card.svgMarkup], { type: 'image/svg+xml;charset=utf-8' })
      const url = URL.createObjectURL(svgBlob)
      a.href = url
      a.download = `${card.title}.svg`
      a.click()
      setTimeout(() => URL.revokeObjectURL(url), 1000)
      return
    }
    a.href = card.url
    a.download = `${card.title}.png`
    a.click()
  }

  return (
    <div className="grid grid-cols-1 gap-5 lg:grid-cols-12">
      {/* Left Prompt & Generator Controls */}
      <div className="space-y-4 lg:col-span-5">
        {/* Active Gateway Banner */}
        <div className="flex items-center justify-between gap-3 rounded-2xl border border-zinc-800 bg-zinc-900/70 p-3.5">
          <div className="min-w-0">
            <div className="flex items-center gap-2 text-xs font-semibold text-zinc-100">
              <span
                className={`h-2 w-2 rounded-full ${
                  activeProfile.apiKey.trim() || activeProfile.kind === '9router'
                    ? 'bg-emerald-400'
                    : 'bg-amber-400'
                }`}
              />
              <span className="truncate">{activeProfile.name}</span>
            </div>
            <div className="mt-0.5 truncate font-mono text-[11px] text-zinc-400">
              Teks: {activeProfile.textModel} • Gambar: {activeProfile.imageModel}
            </div>
          </div>
          <button
            type="button"
            onClick={onOpenSettings}
            className="inline-flex shrink-0 items-center gap-1.5 rounded-xl border border-zinc-700 bg-zinc-800 px-3 py-1.5 text-xs font-medium text-zinc-100 hover:bg-zinc-700"
          >
            <KeyRound className="h-3.5 w-3.5 text-violet-400" />
            Atur API Key
          </button>
        </div>

        <div className="space-y-4 rounded-2xl border border-zinc-800 bg-zinc-900/60 p-4">
          {/* Generation Mode */}
          <div>
            <label className="mb-2 block text-xs font-semibold uppercase tracking-wider text-zinc-400">
              Mode Generate Gambar
            </label>
            <div className="grid grid-cols-2 gap-2">
              <button
                type="button"
                onClick={() => setGenMode('image-api')}
                className={`rounded-xl border p-2.5 text-left transition ${
                  genMode === 'image-api'
                    ? 'border-violet-500 bg-violet-500/15 text-white'
                    : 'border-zinc-800 bg-zinc-950/50 text-zinc-400 hover:border-zinc-700'
                }`}
              >
                <div className="inline-flex items-center gap-1.5 text-xs font-semibold">
                  <Sparkles className="h-3.5 w-3.5 text-violet-400" />
                  Image Gen API
                </div>
                <div className="mt-0.5 text-[11px] opacity-80">
                  Gemini / DALL-E / 9Router Image
                </div>
              </button>

              <button
                type="button"
                onClick={() => setGenMode('svg-nonvision')}
                className={`rounded-xl border p-2.5 text-left transition ${
                  genMode === 'svg-nonvision'
                    ? 'border-sky-500 bg-sky-500/15 text-white'
                    : 'border-zinc-800 bg-zinc-950/50 text-zinc-400 hover:border-zinc-700'
                }`}
              >
                <div className="inline-flex items-center gap-1.5 text-xs font-semibold">
                  <PenTool className="h-3.5 w-3.5 text-sky-400" />
                  Vector SVG (Non-Vision)
                </div>
                <div className="mt-0.5 text-[11px] opacity-80">
                  Jalan di Agnes 3.5 &amp; semua LLM teks
                </div>
              </button>
            </div>
          </div>

          {/* Non-vision Prompt Studio */}
          <div className="space-y-2 rounded-xl border border-zinc-800 bg-zinc-950/50 p-3">
            <label className="block text-xs font-medium text-zinc-300">
              1. Ide Singkat (Bahasa Indonesia / Inggris)
            </label>
            <div className="flex flex-col gap-2 sm:flex-row">
              <input
                type="text"
                value={rawIdea}
                onChange={(e) => setRawIdea(e.target.value)}
                placeholder="Contoh: Kucing oranye pakai jaket cyberpunk di Jakarta malam..."
                className="flex-1 rounded-xl border border-zinc-700 bg-zinc-900 px-3 py-2 text-xs text-zinc-100 outline-none focus:border-violet-500"
              />
              <button
                type="button"
                disabled={enhancing}
                onClick={handleEnhancePrompt}
                className="inline-flex items-center justify-center gap-1.5 rounded-xl border border-violet-500/50 bg-violet-600/20 px-3 py-2 text-xs font-semibold text-violet-200 hover:bg-violet-600/30 disabled:opacity-50"
              >
                {enhancing ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Wand2 className="h-3.5 w-3.5" />
                )}
                Racik Prompt AI
              </button>
            </div>
            <p className="text-[11px] text-zinc-500">
              Memakai model non-vision ({activeProfile.textModel}) untuk menyusun prompt detail.
            </p>
          </div>

          {/* Style Chips */}
          <div>
            <label className="mb-1.5 block text-xs text-zinc-400">Gaya Visual</label>
            <div className="flex flex-wrap gap-1.5">
              {STYLE_CHIPS.map((s) => (
                <button
                  key={s}
                  type="button"
                  onClick={() => setStylePreset(s)}
                  className={`rounded-lg border px-2.5 py-1 text-[11px] font-medium transition ${
                    stylePreset === s
                      ? 'border-violet-500 bg-violet-600 text-white'
                      : 'border-zinc-800 bg-zinc-950/60 text-zinc-400 hover:border-zinc-700'
                  }`}
                >
                  {s}
                </button>
              ))}
            </div>
          </div>

          {/* Detailed Prompt */}
          <div>
            <label className="mb-1 block text-xs text-zinc-400">2. Prompt Akhir</label>
            <textarea
              rows={3}
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              placeholder="Tulis prompt lengkap di sini atau pakai tombol 'Racik Prompt AI' di atas..."
              className="w-full rounded-xl border border-zinc-700 bg-zinc-950 p-3 text-xs text-zinc-100 outline-none focus:border-violet-500"
            />
          </div>

          {genMode === 'image-api' && (
            <div>
              <label className="mb-1 block text-xs text-zinc-400">Negative Prompt (Opsional)</label>
              <input
                type="text"
                value={negativePrompt}
                onChange={(e) => setNegativePrompt(e.target.value)}
                className="w-full rounded-xl border border-zinc-700 bg-zinc-950 px-3 py-2 text-xs text-zinc-300 outline-none focus:border-violet-500"
              />
            </div>
          )}

          {/* Size & Batch */}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="mb-1 block text-xs text-zinc-400">Rasio / Ukuran</label>
              <select
                value={size}
                onChange={(e) =>
                  setSize(e.target.value as '1024x1024' | '1024x1792' | '1792x1024')
                }
                className="w-full rounded-xl border border-zinc-700 bg-zinc-950 px-2.5 py-2 text-xs text-zinc-200 outline-none focus:border-violet-500"
              >
                <option value="1024x1024">1:1 Persegi (1024×1024)</option>
                <option value="1024x1792">9:16 HP / Story (1024×1792)</option>
                <option value="1792x1024">16:9 Laptop / Banner (1792×1024)</option>
              </select>
            </div>

            <div>
              <label className="mb-1 block text-xs text-zinc-400">Jumlah Batch</label>
              <div className="grid grid-cols-3 gap-1.5">
                {([1, 2, 4] as const).map((n) => (
                  <button
                    key={n}
                    type="button"
                    disabled={genMode === 'svg-nonvision' && n > 1}
                    onClick={() => setBatchCount(n)}
                    className={`rounded-xl border py-2 text-xs font-semibold ${
                      (genMode === 'svg-nonvision' ? 1 : batchCount) === n
                        ? 'border-violet-500 bg-violet-600 text-white'
                        : 'border-zinc-800 bg-zinc-950/60 text-zinc-300 disabled:opacity-40'
                    }`}
                  >
                    {n}×
                  </button>
                ))}
              </div>
            </div>
          </div>

          {errorMsg && (
            <div className="rounded-xl border border-rose-500/40 bg-rose-500/10 p-3 text-xs text-rose-200">
              {errorMsg}
            </div>
          )}

          <button
            type="button"
            disabled={generating}
            onClick={handleGenerate}
            className="flex w-full items-center justify-center gap-2 rounded-xl bg-gradient-to-r from-violet-600 to-fuchsia-600 px-4 py-3 text-sm font-semibold text-white shadow-lg shadow-violet-600/20 transition hover:brightness-110 disabled:opacity-50"
          >
            {generating ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin" />
                {statusMsg || 'Generating...'}
              </>
            ) : (
              <>
                <Sparkles className="h-4 w-4" />
                Generate Sekarang (BYOK)
              </>
            )}
          </button>
        </div>
      </div>

      {/* Right Results Grid */}
      <div className="space-y-4 lg:col-span-7">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-semibold text-zinc-200">
            Hasil Generate Sesi Ini ({results.length})
          </h3>
          <span className="text-xs text-zinc-500">Otomatis tersimpan di Galeri Lokal</span>
        </div>

        {results.length === 0 ? (
          <div className="flex min-h-[340px] flex-col items-center justify-center rounded-2xl border border-zinc-800 bg-zinc-900/40 p-6 text-center">
            <Sparkles className="mb-3 h-8 w-8 text-violet-400/70" />
            <p className="text-sm font-medium text-zinc-300">
              Belum ada gambar yang dibuat di sesi ini
            </p>
            <p className="mt-1 max-w-md text-xs text-zinc-500">
              Gunakan API Key milik Anda (9Router, Agnes 3.5, Gemini, atau OpenAI-compatible) tanpa batas aplikasi. Semua hasil bisa langsung di-upscale ke HD!
            </p>
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            {results.map((card) => (
              <div
                key={card.id}
                className="overflow-hidden rounded-2xl border border-zinc-800 bg-zinc-900/70"
              >
                <div className="checkerboard-bg aspect-square overflow-hidden">
                  <img
                    src={card.url}
                    alt={card.title}
                    className="h-full w-full object-contain"
                  />
                </div>
                <div className="space-y-2 p-3">
                  <div className="flex items-center justify-between text-[11px] text-zinc-400">
                    <span className="truncate font-mono">{card.modeLabel}</span>
                  </div>
                  <div className="flex flex-wrap gap-1.5">
                    <button
                      type="button"
                      onClick={() => onSendToUpscaler(card.blob, card.title)}
                      className="inline-flex flex-1 items-center justify-center gap-1 rounded-lg bg-violet-600 px-2.5 py-1.5 text-xs font-semibold text-white hover:bg-violet-500"
                    >
                      <ArrowUpRight className="h-3.5 w-3.5" />
                      HD-kan di Upscaler
                    </button>
                    <button
                      type="button"
                      onClick={() => downloadCard(card, false)}
                      className="inline-flex items-center gap-1 rounded-lg border border-zinc-700 bg-zinc-800 px-2.5 py-1.5 text-xs font-medium text-zinc-200 hover:bg-zinc-700"
                    >
                      <Download className="h-3.5 w-3.5" />
                      PNG
                    </button>
                    {card.svgMarkup && (
                      <button
                        type="button"
                        onClick={() => downloadCard(card, true)}
                        className="inline-flex items-center gap-1 rounded-lg border border-sky-500/40 bg-sky-500/10 px-2.5 py-1.5 text-xs font-medium text-sky-200 hover:bg-sky-500/20"
                      >
                        SVG
                      </button>
                    )}
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
