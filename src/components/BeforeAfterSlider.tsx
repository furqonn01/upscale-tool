import { useRef, useState } from 'react'
import { Columns2, Eye, MoveHorizontal } from 'lucide-react'

interface BeforeAfterSliderProps {
  beforeUrl: string
  afterUrl: string | null
  beforeLabel?: string
  afterLabel?: string
}

export function BeforeAfterSlider({
  beforeUrl,
  afterUrl,
  beforeLabel = 'Asli',
  afterLabel = 'Hasil HD',
}: BeforeAfterSliderProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const [position, setPosition] = useState(50)
  const [dragging, setDragging] = useState(false)
  const [viewMode, setViewMode] = useState<'split' | 'after' | 'before'>('split')

  const updateFromClientX = (clientX: number) => {
    const el = containerRef.current
    if (!el) return
    const rect = el.getBoundingClientRect()
    const pct = ((clientX - rect.left) / Math.max(1, rect.width)) * 100
    setPosition(Math.max(0, Math.min(100, pct)))
  }

  if (!afterUrl) {
    return (
      <div className="relative overflow-hidden rounded-2xl border border-zinc-800 bg-zinc-900/70 checkerboard-bg">
        <img
          src={beforeUrl}
          alt="Preview asli"
          className="mx-auto max-h-[56dvh] w-auto max-w-full object-contain"
        />
        <span className="absolute top-3 left-3 rounded-full bg-zinc-950/80 px-2.5 py-1 text-xs font-medium text-zinc-200 backdrop-blur">
          {beforeLabel}
        </span>
      </div>
    )
  }

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-2 text-xs text-zinc-400">
        <span className="inline-flex items-center gap-1.5">
          <Columns2 className="h-3.5 w-3.5 text-violet-400" />
          Geser garis untuk membandingkan detail
        </span>
        <div className="inline-flex rounded-lg border border-zinc-800 bg-zinc-900 p-0.5">
          {(
            [
              { id: 'split', label: 'Split' },
              { id: 'after', label: 'HD' },
              { id: 'before', label: 'Asli' },
            ] as const
          ).map((mode) => (
            <button
              key={mode.id}
              type="button"
              onClick={() => setViewMode(mode.id)}
              className={`rounded-md px-2.5 py-1 text-xs font-medium transition ${
                viewMode === mode.id
                  ? 'bg-violet-600 text-white'
                  : 'text-zinc-400 hover:text-zinc-200'
              }`}
            >
              {mode.label}
            </button>
          ))}
        </div>
      </div>

      <div
        ref={containerRef}
        onPointerDown={(e) => {
          if (viewMode !== 'split') return
          setDragging(true)
          e.currentTarget.setPointerCapture(e.pointerId)
          updateFromClientX(e.clientX)
        }}
        onPointerMove={(e) => {
          if (!dragging || viewMode !== 'split') return
          updateFromClientX(e.clientX)
        }}
        onPointerUp={() => setDragging(false)}
        onPointerCancel={() => setDragging(false)}
        className={`relative select-none overflow-hidden rounded-2xl border border-zinc-800 bg-zinc-950 checkerboard-bg ${
          viewMode === 'split' ? 'touch-none cursor-ew-resize' : ''
        }`}
      >
        {/* Base layer: After HD */}
        <img
          src={viewMode === 'before' ? beforeUrl : afterUrl}
          alt={viewMode === 'before' ? beforeLabel : afterLabel}
          draggable={false}
          className="mx-auto block max-h-[58dvh] w-full object-contain"
        />

        {viewMode === 'split' && (
          <>
            {/* Overlay clipped layer: Before */}
            <div
              className="pointer-events-none absolute inset-0"
              style={{ clipPath: `inset(0 ${100 - position}% 0 0)` }}
            >
              <img
                src={beforeUrl}
                alt={beforeLabel}
                draggable={false}
                className="mx-auto block h-full max-h-[58dvh] w-full object-contain"
              />
            </div>

            {/* Divider line + handle */}
            <div
              className="pointer-events-none absolute inset-y-0 z-10 w-0.5 bg-white/90 shadow-[0_0_12px_rgba(0,0,0,0.8)]"
              style={{ left: `${position}%` }}
            >
              <div className="absolute top-1/2 left-1/2 flex h-9 w-9 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full border-2 border-white bg-violet-600 text-white shadow-lg">
                <MoveHorizontal className="h-4 w-4" />
              </div>
            </div>

            <span className="pointer-events-none absolute top-3 left-3 rounded-full bg-zinc-950/80 px-2.5 py-1 text-xs font-medium text-zinc-200 backdrop-blur">
              {beforeLabel}
            </span>
            <span className="pointer-events-none absolute top-3 right-3 rounded-full bg-violet-600/90 px-2.5 py-1 text-xs font-medium text-white backdrop-blur">
              {afterLabel}
            </span>
          </>
        )}

        {viewMode !== 'split' && (
          <span className="pointer-events-none absolute top-3 left-3 inline-flex items-center gap-1 rounded-full bg-zinc-950/80 px-2.5 py-1 text-xs font-medium text-zinc-200 backdrop-blur">
            <Eye className="h-3.5 w-3.5" />
            {viewMode === 'before' ? beforeLabel : afterLabel}
          </span>
        )}
      </div>
    </div>
  )
}
