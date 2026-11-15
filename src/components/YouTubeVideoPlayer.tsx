import { useCallback, useEffect, useRef, useState } from 'react'
import {
  Check,
  Columns2,
  Maximize,
  Minimize,
  Pause,
  PictureInPicture2,
  Play,
  RectangleHorizontal,
  Repeat,
  RotateCcw,
  RotateCw,
  Settings,
  Volume1,
  Volume2,
  VolumeX,
} from 'lucide-react'

type CompareViewMode = 'after' | 'before' | 'split'

export interface YouTubeVideoPlayerProps {
  src: string
  compareSrc?: string
  mainLabel?: string
  compareLabel?: string
  title?: string
  qualityBadge?: string
  theaterMode?: boolean
  onToggleTheater?: () => void
  compact?: boolean
  className?: string
}

const PLAYBACK_RATES = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 2]

function formatDuration(sec: number): string {
  if (!Number.isFinite(sec) || sec < 0) return '0:00'
  const total = Math.floor(sec)
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  if (h > 0) {
    return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
  }
  return `${m}:${String(s).padStart(2, '0')}`
}

export function YouTubeVideoPlayer({
  src,
  compareSrc,
  mainLabel = 'Hasil HD',
  compareLabel = 'Asli',
  title,
  qualityBadge,
  theaterMode = false,
  onToggleTheater,
  compact = false,
  className = '',
}: YouTubeVideoPlayerProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const videoRef = useRef<HTMLVideoElement>(null)
  const compareVideoRef = useRef<HTMLVideoElement>(null)
  const progressBarRef = useRef<HTMLDivElement>(null)
  const volumeBarRef = useRef<HTMLDivElement>(null)
  const hideTimerRef = useRef<number | null>(null)
  const clickTimerRef = useRef<number | null>(null)
  const seekFeedbackTimerRef = useRef<number | null>(null)
  const lastTapRef = useRef<{ time: number; zone: 'left' | 'center' | 'right' } | null>(null)

  const [playing, setPlaying] = useState(false)
  const [currentTime, setCurrentTime] = useState(0)
  const [duration, setDuration] = useState(0)
  const [bufferedEnd, setBufferedEnd] = useState(0)
  const [volume, setVolume] = useState(1)
  const [muted, setMuted] = useState(false)
  const [playbackRate, setPlaybackRate] = useState(1)
  const [loop, setLoop] = useState(false)
  const [isFullscreen, setIsFullscreen] = useState(false)
  const [controlsVisible, setControlsVisible] = useState(true)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [scrubbing, setScrubbing] = useState(false)
  const [hoverTime, setHoverTime] = useState<{ ratio: number; sec: number } | null>(null)
  const [seekOverlay, setSeekOverlay] = useState<{ side: 'left' | 'right'; sec: number } | null>(
    null
  )
  const [viewMode, setViewMode] = useState<CompareViewMode>('after')
  const [splitPos, setSplitPos] = useState(50)
  const [draggingSplit, setDraggingSplit] = useState(false)
  const [draggingVolume, setDraggingVolume] = useState(false)

  const hasCompare = Boolean(compareSrc)
  const activeMode: CompareViewMode = hasCompare ? viewMode : 'after'
  const effectiveVolume = muted ? 0 : volume
  const showControls = !playing || settingsOpen || scrubbing || draggingVolume || controlsVisible
  const canPiP =
    !compact && typeof document !== 'undefined' && Boolean(document.pictureInPictureEnabled)

  const clearHideTimer = useCallback(() => {
    if (hideTimerRef.current !== null) {
      window.clearTimeout(hideTimerRef.current)
      hideTimerRef.current = null
    }
  }, [])

  const scheduleHideControls = useCallback(() => {
    clearHideTimer()
    if (!playing || settingsOpen || scrubbing) return
    hideTimerRef.current = window.setTimeout(() => {
      setControlsVisible(false)
    }, 2400)
  }, [clearHideTimer, playing, settingsOpen, scrubbing])

  const revealControls = useCallback(() => {
    setControlsVisible(true)
    scheduleHideControls()
  }, [scheduleHideControls])

  useEffect(() => {
    if (playing && !settingsOpen && !scrubbing) {
      scheduleHideControls()
    } else {
      clearHideTimer()
    }
    return clearHideTimer
  }, [playing, settingsOpen, scrubbing, clearHideTimer, scheduleHideControls])

  useEffect(() => {
    const onFsChange = () => {
      setIsFullscreen(document.fullscreenElement === containerRef.current)
    }
    document.addEventListener('fullscreenchange', onFsChange)
    return () => document.removeEventListener('fullscreenchange', onFsChange)
  }, [])

  // Sync secondary comparison video element when in Before/After split mode
  const syncCompareVideo = useCallback((forceSeek = false) => {
    const main = videoRef.current
    const cmp = compareVideoRef.current
    if (!main || !cmp) return
    if (cmp.playbackRate !== main.playbackRate) {
      cmp.playbackRate = main.playbackRate
    }
    if (forceSeek || Math.abs(cmp.currentTime - main.currentTime) > 0.08) {
      try {
        cmp.currentTime = main.currentTime
      } catch {
        // Ignore seek before metadata ready
      }
    }
    if (!main.paused && cmp.paused) {
      cmp.play().catch(() => undefined)
    } else if (main.paused && !cmp.paused) {
      cmp.pause()
    }
  }, [])

  useEffect(() => {
    if (activeMode !== 'split') return
    syncCompareVideo(true)
  }, [activeMode, syncCompareVideo])

  const togglePlay = useCallback(() => {
    const v = videoRef.current
    if (!v) return
    if (v.paused || v.ended) {
      v.play().catch(() => undefined)
    } else {
      v.pause()
    }
    revealControls()
  }, [revealControls])

  const seekTo = useCallback(
    (targetSec: number) => {
      const v = videoRef.current
      if (!v) return
      const maxSec = Number.isFinite(v.duration) && v.duration > 0 ? v.duration : duration
      const clamped = Math.max(0, Math.min(maxSec || 0, targetSec))
      v.currentTime = clamped
      setCurrentTime(clamped)
      if (compareVideoRef.current && activeMode === 'split') {
        try {
          compareVideoRef.current.currentTime = clamped
        } catch {
          // Ignore seek before metadata
        }
      }
      revealControls()
    },
    [duration, activeMode, revealControls]
  )

  const seekBy = useCallback(
    (deltaSec: number) => {
      const v = videoRef.current
      if (!v) return
      seekTo((v.currentTime || 0) + deltaSec)
      if (seekFeedbackTimerRef.current !== null) {
        window.clearTimeout(seekFeedbackTimerRef.current)
      }
      setSeekOverlay({
        side: deltaSec < 0 ? 'left' : 'right',
        sec: Math.abs(deltaSec),
      })
      seekFeedbackTimerRef.current = window.setTimeout(() => {
        setSeekOverlay(null)
      }, 650)
    },
    [seekTo]
  )

  const toggleMute = useCallback(() => {
    const v = videoRef.current
    if (!v) return
    const nextMuted = !v.muted
    v.muted = nextMuted
    if (!nextMuted && v.volume === 0) {
      v.volume = 0.6
      setVolume(0.6)
    }
    setMuted(nextMuted)
    revealControls()
  }, [revealControls])

  const changeVolume = useCallback(
    (nextVol: number) => {
      const v = videoRef.current
      const clamped = Math.max(0, Math.min(1, nextVol))
      setVolume(clamped)
      if (v) {
        v.volume = clamped
        v.muted = clamped === 0
      }
      setMuted(clamped === 0)
      revealControls()
    },
    [revealControls]
  )

  const changeRate = useCallback(
    (rate: number) => {
      setPlaybackRate(rate)
      if (videoRef.current) videoRef.current.playbackRate = rate
      if (compareVideoRef.current) compareVideoRef.current.playbackRate = rate
      revealControls()
    },
    [revealControls]
  )

  const toggleFullscreen = useCallback(async () => {
    const el = containerRef.current
    if (!el) return
    try {
      if (document.fullscreenElement === el) {
        await document.exitFullscreen()
      } else {
        await el.requestFullscreen()
      }
    } catch {
      // Fallback for iOS Safari native video fullscreen
      const vid = videoRef.current as (HTMLVideoElement & { webkitEnterFullscreen?: () => void }) | null
      vid?.webkitEnterFullscreen?.()
    }
    revealControls()
  }, [revealControls])

  const togglePiP = useCallback(async () => {
    const v = videoRef.current
    if (!v || !document.pictureInPictureEnabled) return
    try {
      if (document.pictureInPictureElement === v) {
        await document.exitPictureInPicture()
      } else {
        await v.requestPictureInPicture()
      }
    } catch {
      // Ignore PiP rejection if metadata not loaded
    }
  }, [])

  const handleKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const tag = (e.target as HTMLElement | null)?.tagName
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return

    switch (e.key.toLowerCase()) {
      case ' ':
      case 'k':
        e.preventDefault()
        togglePlay()
        break
      case 'j':
        e.preventDefault()
        seekBy(-10)
        break
      case 'l':
        e.preventDefault()
        seekBy(10)
        break
      case 'arrowleft':
        e.preventDefault()
        seekBy(-5)
        break
      case 'arrowright':
        e.preventDefault()
        seekBy(5)
        break
      case 'arrowup':
        e.preventDefault()
        changeVolume(volume + 0.1)
        break
      case 'arrowdown':
        e.preventDefault()
        changeVolume(volume - 0.1)
        break
      case 'm':
        e.preventDefault()
        toggleMute()
        break
      case 'f':
        e.preventDefault()
        toggleFullscreen()
        break
      case 't':
        if (onToggleTheater) {
          e.preventDefault()
          onToggleTheater()
        }
        break
      case ',':
      case '<':
        if (e.shiftKey) {
          e.preventDefault()
          const idx = PLAYBACK_RATES.indexOf(playbackRate)
          if (idx > 0) changeRate(PLAYBACK_RATES[idx - 1])
        }
        break
      case '.':
      case '>':
        if (e.shiftKey) {
          e.preventDefault()
          const idx = PLAYBACK_RATES.indexOf(playbackRate)
          if (idx >= 0 && idx < PLAYBACK_RATES.length - 1) changeRate(PLAYBACK_RATES[idx + 1])
        }
        break
      default:
        if (/^[0-9]$/.test(e.key) && duration > 0) {
          e.preventDefault()
          seekTo((Number(e.key) / 10) * duration)
        }
    }
  }

  const getProgressFromPointer = (clientX: number) => {
    const bar = progressBarRef.current
    if (!bar) return { ratio: 0, sec: 0 }
    const rect = bar.getBoundingClientRect()
    const ratio = rect.width > 0 ? Math.max(0, Math.min(1, (clientX - rect.left) / rect.width)) : 0
    return { ratio, sec: ratio * (duration || 0) }
  }

  const handleSurfaceClick = (e: React.MouseEvent<HTMLDivElement>) => {
    if (settingsOpen) {
      setSettingsOpen(false)
      return
    }
    const rect = e.currentTarget.getBoundingClientRect()
    const relX = rect.width > 0 ? (e.clientX - rect.left) / rect.width : 0.5
    const zone: 'left' | 'center' | 'right' = relX < 0.3 ? 'left' : relX > 0.7 ? 'right' : 'center'
    const now = performance.now()
    const prev = lastTapRef.current

    if (prev && now - prev.time < 260 && prev.zone === zone) {
      if (clickTimerRef.current !== null) {
        window.clearTimeout(clickTimerRef.current)
        clickTimerRef.current = null
      }
      lastTapRef.current = null
      if (zone === 'left') seekBy(-10)
      else if (zone === 'right') seekBy(10)
      else toggleFullscreen()
      return
    }

    lastTapRef.current = { time: now, zone }
    if (clickTimerRef.current !== null) {
      window.clearTimeout(clickTimerRef.current)
    }
    clickTimerRef.current = window.setTimeout(() => {
      clickTimerRef.current = null
      togglePlay()
    }, 200)
  }

  const updateSplitFromClientX = (clientX: number) => {
    const el = containerRef.current
    if (!el) return
    const rect = el.getBoundingClientRect()
    const pct = rect.width > 0 ? ((clientX - rect.left) / rect.width) * 100 : 50
    setSplitPos(Math.max(4, Math.min(96, pct)))
  }

  const updateVolumeFromClientX = (clientX: number) => {
    const bar = volumeBarRef.current
    if (!bar) return
    const rect = bar.getBoundingClientRect()
    const ratio = rect.width > 0 ? Math.max(0, Math.min(1, (clientX - rect.left) / rect.width)) : 0
    changeVolume(Math.round(ratio * 20) / 20)
  }

  const activeVideoSrc = activeMode === 'before' && compareSrc ? compareSrc : src
  const playedPct = duration > 0 ? Math.min(100, (currentTime / duration) * 100) : 0
  const bufferedPct = duration > 0 ? Math.min(100, (bufferedEnd / duration) * 100) : 0

  return (
    <div
      ref={containerRef}
      tabIndex={0}
      onKeyDown={handleKeyDown}
      onMouseMove={revealControls}
      onMouseLeave={() =>
        playing && !settingsOpen && !scrubbing && !draggingVolume && setControlsVisible(false)
      }
      className={`group/yt relative select-none overflow-hidden bg-black outline-none focus-visible:ring-2 focus-visible:ring-red-500 ${
        isFullscreen ? 'flex h-full w-full items-center justify-center' : 'aspect-video w-full'
      } ${className}`}
    >
      {/* Main video layer */}
      <video
        ref={videoRef}
        src={activeVideoSrc}
        playsInline
        loop={loop}
        preload="metadata"
        onLoadStart={() => {
          setCurrentTime(0)
          setDuration(0)
          setBufferedEnd(0)
          setPlaying(false)
          setControlsVisible(true)
        }}
        onLoadedMetadata={(e) => {
          const v = e.currentTarget
          setDuration(v.duration || 0)
          v.playbackRate = playbackRate
          v.volume = volume
          v.muted = muted
          syncCompareVideo(true)
        }}
        onTimeUpdate={(e) => {
          const v = e.currentTarget
          if (!scrubbing) setCurrentTime(v.currentTime)
          if (v.buffered.length > 0) {
            setBufferedEnd(v.buffered.end(v.buffered.length - 1))
          }
          if (activeMode === 'split') syncCompareVideo(false)
        }}
        onPlay={() => {
          setPlaying(true)
          if (activeMode === 'split') syncCompareVideo(true)
        }}
        onPause={() => {
          setPlaying(false)
          if (activeMode === 'split') syncCompareVideo(false)
        }}
        onSeeked={() => {
          if (activeMode === 'split') syncCompareVideo(true)
        }}
        onEnded={() => {
          if (!loop) setPlaying(false)
        }}
        className="h-full w-full object-contain"
      />

      {/* Synchronized Before/After split overlay */}
      {activeMode === 'split' && compareSrc && (
        <video
          ref={compareVideoRef}
          src={compareSrc}
          muted
          playsInline
          loop={loop}
          preload="metadata"
          style={{ clipPath: `inset(0 ${100 - splitPos}% 0 0)` }}
          className="pointer-events-none absolute inset-0 h-full w-full object-contain"
        />
      )}

      {/* Interactive video surface (click to play/pause, double-click left/right to seek) */}
      <div onClick={handleSurfaceClick} className="absolute inset-0 z-10 cursor-pointer" />

      {/* Split-screen divider handle */}
      {activeMode === 'split' && compareSrc && (
        <div
          style={{ left: `${splitPos}%` }}
          onPointerDown={(e) => {
            e.stopPropagation()
            e.currentTarget.setPointerCapture(e.pointerId)
            setDraggingSplit(true)
            updateSplitFromClientX(e.clientX)
          }}
          onPointerMove={(e) => {
            if (!draggingSplit) return
            e.stopPropagation()
            updateSplitFromClientX(e.clientX)
          }}
          onPointerUp={(e) => {
            if (!draggingSplit) return
            e.stopPropagation()
            e.currentTarget.releasePointerCapture(e.pointerId)
            setDraggingSplit(false)
          }}
          onClick={(e) => e.stopPropagation()}
          className="absolute inset-y-0 z-20 -ml-2.5 flex w-5 cursor-ew-resize items-center justify-center touch-none"
        >
          <div className="h-full w-0.5 bg-white/90 shadow-[0_0_8px_rgba(0,0,0,0.8)]" />
          <div className="absolute flex h-7 w-7 items-center justify-center rounded-full border border-white/70 bg-black/80 text-[10px] font-bold text-white shadow-lg">
            ↔
          </div>
        </div>
      )}

      {/* Top gradient bar: Title + Mode Switcher (Hasil HD / Asli / Split) */}
      <div
        className={`pointer-events-none absolute inset-x-0 top-0 z-20 flex items-start justify-between gap-2 bg-gradient-to-b from-black/80 via-black/35 to-transparent px-3 pt-2.5 pb-6 transition-opacity duration-200 ${
          showControls ? 'opacity-100' : 'opacity-0'
        }`}
      >
        <div className="flex min-w-0 items-center gap-2">
          {title && (
            <span className="truncate text-xs font-medium text-white drop-shadow sm:text-sm">
              {title}
            </span>
          )}
          {qualityBadge && (
            <span className="shrink-0 rounded bg-red-600/90 px-1.5 py-0.5 text-[10px] font-bold tracking-wide text-white">
              {qualityBadge}
            </span>
          )}
        </div>

        {hasCompare && (
          <div
            onClick={(e) => e.stopPropagation()}
            className="pointer-events-auto flex shrink-0 items-center gap-0.5 rounded-lg border border-white/15 bg-black/70 p-0.5 text-[11px] backdrop-blur-md"
          >
            <button
              type="button"
              onClick={() => setViewMode('after')}
              className={`rounded-md px-2 py-1 font-medium transition ${
                activeMode === 'after'
                  ? 'bg-red-600 text-white'
                  : 'text-zinc-300 hover:text-white'
              }`}
            >
              {mainLabel}
            </button>
            <button
              type="button"
              onClick={() => setViewMode('before')}
              className={`rounded-md px-2 py-1 font-medium transition ${
                activeMode === 'before'
                  ? 'bg-white text-zinc-950'
                  : 'text-zinc-300 hover:text-white'
              }`}
            >
              {compareLabel}
            </button>
            <button
              type="button"
              onClick={() => setViewMode('split')}
              className={`inline-flex items-center gap-1 rounded-md px-2 py-1 font-medium transition ${
                activeMode === 'split'
                  ? 'bg-emerald-600 text-white'
                  : 'text-zinc-300 hover:text-white'
              }`}
              title="Bandingkan layar belah Asli vs HD"
            >
              <Columns2 className="h-3 w-3" />
              Split
            </button>
          </div>
        )}
      </div>

      {/* Split mode corner labels */}
      {activeMode === 'split' && compareSrc && (
        <>
          <span className="pointer-events-none absolute top-11 left-3 z-20 rounded bg-black/70 px-1.5 py-0.5 text-[10px] font-semibold text-zinc-200 backdrop-blur-sm">
            {compareLabel}
          </span>
          <span className="pointer-events-none absolute top-11 right-3 z-20 rounded bg-emerald-600/85 px-1.5 py-0.5 text-[10px] font-semibold text-white backdrop-blur-sm">
            {mainLabel}
          </span>
        </>
      )}

      {/* Double-tap / double-click seek ripple feedback */}
      {seekOverlay && (
        <div
          className={`pointer-events-none absolute inset-y-0 z-20 flex w-1/3 flex-col items-center justify-center text-white ${
            seekOverlay.side === 'left'
              ? 'left-0 rounded-r-full bg-white/10'
              : 'right-0 rounded-l-full bg-white/10'
          }`}
        >
          {seekOverlay.side === 'left' ? (
            <RotateCcw className="h-7 w-7" />
          ) : (
            <RotateCw className="h-7 w-7" />
          )}
          <span className="mt-1 text-xs font-semibold">
            {seekOverlay.side === 'left' ? `-${seekOverlay.sec} dtk` : `+${seekOverlay.sec} dtk`}
          </span>
        </div>
      )}

      {/* Center YouTube-style Play Button when paused */}
      {!playing && !seekOverlay && (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation()
            togglePlay()
          }}
          aria-label="Putar video"
          className={`absolute top-1/2 left-1/2 z-20 flex -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-2xl bg-red-600/95 text-white shadow-xl transition hover:scale-105 hover:bg-red-500 ${
            compact ? 'h-11 w-14' : 'h-12 w-16 sm:h-14 sm:w-20'
          }`}
        >
          <Play className={`${compact ? 'h-5 w-5' : 'h-6 w-6 sm:h-7 sm:w-7'} fill-current ml-0.5`} />
        </button>
      )}

      {/* Bottom YouTube Control Dock */}
      <div
        onClick={(e) => e.stopPropagation()}
        className={`absolute inset-x-0 bottom-0 z-30 bg-gradient-to-t from-black/95 via-black/70 to-transparent px-2.5 pt-8 pb-2 transition-opacity duration-200 sm:px-3.5 ${
          showControls ? 'opacity-100' : 'pointer-events-none opacity-0'
        }`}
      >
        {/* Red Timeline Scrubber */}
        <div
          ref={progressBarRef}
          onPointerDown={(e) => {
            e.stopPropagation()
            e.currentTarget.setPointerCapture(e.pointerId)
            setScrubbing(true)
            const p = getProgressFromPointer(e.clientX)
            setHoverTime(p)
            seekTo(p.sec)
          }}
          onPointerMove={(e) => {
            const p = getProgressFromPointer(e.clientX)
            setHoverTime(p)
            if (scrubbing) seekTo(p.sec)
          }}
          onPointerUp={(e) => {
            if (!scrubbing) return
            e.currentTarget.releasePointerCapture(e.pointerId)
            setScrubbing(false)
            scheduleHideControls()
          }}
          onPointerLeave={() => {
            if (!scrubbing) setHoverTime(null)
          }}
          className="group/bar relative flex h-4 cursor-pointer items-center touch-none"
        >
          {/* Floating timestamp tooltip */}
          {hoverTime && duration > 0 && (
            <div
              style={{ left: `${Math.max(5, Math.min(95, hoverTime.ratio * 100))}%` }}
              className="pointer-events-none absolute -top-7 -translate-x-1/2 rounded bg-zinc-900/95 px-1.5 py-0.5 text-[11px] font-semibold tabular-nums text-white shadow"
            >
              {formatDuration(hoverTime.sec)}
            </div>
          )}

          <div className="relative h-1 w-full rounded-full bg-white/25 transition-all group-hover/bar:h-1.5">
            {/* Buffered range */}
            <div
              style={{ width: `${bufferedPct}%` }}
              className="absolute inset-y-0 left-0 rounded-full bg-white/40"
            />
            {/* Hover preview range */}
            {hoverTime && (
              <div
                style={{ width: `${hoverTime.ratio * 100}%` }}
                className="absolute inset-y-0 left-0 rounded-full bg-white/30"
              />
            )}
            {/* YouTube Red progress fill */}
            <div
              style={{ width: `${playedPct}%` }}
              className="absolute inset-y-0 left-0 rounded-full bg-red-600"
            />
            {/* Scrubber thumb */}
            <div
              style={{ left: `${playedPct}%` }}
              className={`absolute top-1/2 h-3 w-3 -translate-x-1/2 -translate-y-1/2 rounded-full bg-red-600 shadow transition-transform ${
                scrubbing
                  ? 'scale-125'
                  : 'scale-0 group-hover/bar:scale-100'
              }`}
            />
          </div>
        </div>

        {/* Control Buttons Row */}
        <div className="mt-0.5 flex items-center justify-between gap-2 text-white">
          <div className="flex items-center gap-1 sm:gap-2">
            <button
              type="button"
              onClick={togglePlay}
              title={playing ? 'Jeda (K / Spasi)' : 'Putar (K / Spasi)'}
              className="rounded-lg p-1.5 hover:bg-white/15"
            >
              {playing ? (
                <Pause className="h-4 w-4 fill-current sm:h-5 sm:w-5" />
              ) : (
                <Play className="h-4 w-4 fill-current sm:h-5 sm:w-5" />
              )}
            </button>

            {!compact && (
              <>
                <button
                  type="button"
                  onClick={() => seekBy(-10)}
                  title="Mundur 10 detik (J)"
                  className="hidden rounded-lg p-1.5 hover:bg-white/15 sm:inline-flex"
                >
                  <RotateCcw className="h-4 w-4" />
                </button>
                <button
                  type="button"
                  onClick={() => seekBy(10)}
                  title="Maju 10 detik (L)"
                  className="hidden rounded-lg p-1.5 hover:bg-white/15 sm:inline-flex"
                >
                  <RotateCw className="h-4 w-4" />
                </button>
              </>
            )}

            {/* Volume group */}
            <div className="group/vol flex items-center">
              <button
                type="button"
                onClick={toggleMute}
                title={muted || volume === 0 ? 'Bunyikan (M)' : 'Bisukan (M)'}
                className="rounded-lg p-1.5 hover:bg-white/15"
              >
                {muted || volume === 0 ? (
                  <VolumeX className="h-4 w-4 sm:h-5 sm:w-5" />
                ) : volume < 0.5 ? (
                  <Volume1 className="h-4 w-4 sm:h-5 sm:w-5" />
                ) : (
                  <Volume2 className="h-4 w-4 sm:h-5 sm:w-5" />
                )}
              </button>
              {!compact && (
                <div
                  className={`hidden items-center overflow-hidden transition-all duration-200 sm:flex ${
                    draggingVolume
                      ? 'mr-1.5 w-[72px] opacity-100'
                      : 'w-0 opacity-0 group-hover/vol:mr-1.5 group-hover/vol:w-[72px] group-hover/vol:opacity-100 group-focus-within/vol:mr-1.5 group-focus-within/vol:w-[72px] group-focus-within/vol:opacity-100'
                  }`}
                >
                  <div
                    ref={volumeBarRef}
                    role="slider"
                    tabIndex={0}
                    aria-label="Volume"
                    aria-valuemin={0}
                    aria-valuemax={100}
                    aria-valuenow={Math.round(effectiveVolume * 100)}
                    onPointerDown={(e) => {
                      e.stopPropagation()
                      e.currentTarget.setPointerCapture(e.pointerId)
                      setDraggingVolume(true)
                      updateVolumeFromClientX(e.clientX)
                    }}
                    onPointerMove={(e) => {
                      if (!draggingVolume) return
                      e.stopPropagation()
                      updateVolumeFromClientX(e.clientX)
                    }}
                    onPointerUp={(e) => {
                      if (!draggingVolume) return
                      e.currentTarget.releasePointerCapture(e.pointerId)
                      setDraggingVolume(false)
                      scheduleHideControls()
                    }}
                    onKeyDown={(e) => {
                      if (e.key === 'ArrowRight' || e.key === 'ArrowUp') {
                        e.preventDefault()
                        e.stopPropagation()
                        changeVolume(volume + 0.1)
                      } else if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') {
                        e.preventDefault()
                        e.stopPropagation()
                        changeVolume(volume - 0.1)
                      }
                    }}
                    className="relative flex h-6 w-full cursor-pointer items-center px-1.5 touch-none outline-none"
                  >
                    <div className="relative h-1 w-full rounded-full bg-white/30">
                      <div
                        style={{ width: `${effectiveVolume * 100}%` }}
                        className="absolute inset-y-0 left-0 rounded-full bg-white"
                      />
                      <div
                        style={{ left: `${effectiveVolume * 100}%` }}
                        className={`absolute top-1/2 h-3 w-3 -translate-x-1/2 -translate-y-1/2 rounded-full bg-white shadow transition-transform ${
                          draggingVolume ? 'scale-115' : 'scale-100'
                        }`}
                      />
                    </div>
                  </div>
                </div>
              )}
            </div>

            {/* Timestamp */}
            <span className="ml-1 text-[11px] font-medium tabular-nums text-zinc-200 sm:text-xs">
              {formatDuration(currentTime)} <span className="text-zinc-400">/</span>{' '}
              {formatDuration(duration)}
            </span>
          </div>

          {/* Right Controls */}
          <div className="relative flex items-center gap-0.5 sm:gap-1.5">
            {playbackRate !== 1 && (
              <span className="rounded bg-white/15 px-1.5 py-0.5 text-[10px] font-semibold">
                {playbackRate}×
              </span>
            )}

            {/* Settings Popover */}
            <button
              type="button"
              onClick={() => setSettingsOpen((p) => !p)}
              title="Pengaturan kecepatan & ulangi"
              className={`rounded-lg p-1.5 transition hover:bg-white/15 ${
                settingsOpen ? 'rotate-45 bg-white/15' : ''
              }`}
            >
              <Settings className="h-4 w-4 sm:h-[18px] sm:w-[18px]" />
            </button>

            {settingsOpen && (
              <div className="absolute right-0 bottom-11 z-40 w-52 rounded-xl border border-white/15 bg-zinc-950/95 p-2 text-xs text-zinc-100 shadow-2xl backdrop-blur-md">
                <button
                  type="button"
                  onClick={() => setLoop((v) => !v)}
                  className="flex w-full items-center justify-between rounded-lg px-2.5 py-1.5 hover:bg-white/10"
                >
                  <span className="inline-flex items-center gap-2">
                    <Repeat className="h-3.5 w-3.5 text-zinc-400" />
                    Ulangi Video (Loop)
                  </span>
                  {loop && <Check className="h-3.5 w-3.5 text-red-500" />}
                </button>

                <div className="my-1.5 border-t border-white/10" />
                <div className="px-2.5 pb-1 text-[10px] font-semibold uppercase tracking-wider text-zinc-400">
                  Kecepatan Putar
                </div>
                <div className="grid grid-cols-4 gap-1 px-1">
                  {PLAYBACK_RATES.map((rate) => (
                    <button
                      key={rate}
                      type="button"
                      onClick={() => changeRate(rate)}
                      className={`rounded-md py-1 text-[11px] font-medium transition ${
                        playbackRate === rate
                          ? 'bg-red-600 text-white'
                          : 'bg-white/5 text-zinc-300 hover:bg-white/15'
                      }`}
                    >
                      {rate === 1 ? 'Normal' : `${rate}×`}
                    </button>
                  ))}
                </div>
              </div>
            )}

            {canPiP && (
              <button
                type="button"
                onClick={togglePiP}
                title="Picture-in-Picture"
                className="hidden rounded-lg p-1.5 hover:bg-white/15 sm:inline-flex"
              >
                <PictureInPicture2 className="h-4 w-4 sm:h-[18px] sm:w-[18px]" />
              </button>
            )}

            {onToggleTheater && !isFullscreen && (
              <button
                type="button"
                onClick={onToggleTheater}
                title={theaterMode ? 'Keluar Mode Teater (T)' : 'Mode Teater (T)'}
                className={`hidden rounded-lg p-1.5 hover:bg-white/15 lg:inline-flex ${
                  theaterMode ? 'text-red-500' : ''
                }`}
              >
                <RectangleHorizontal className="h-4 w-4 sm:h-[18px] sm:w-[18px]" />
              </button>
            )}

            <button
              type="button"
              onClick={toggleFullscreen}
              title={isFullscreen ? 'Keluar Layar Penuh (F)' : 'Layar Penuh (F)'}
              className="rounded-lg p-1.5 hover:bg-white/15"
            >
              {isFullscreen ? (
                <Minimize className="h-4 w-4 sm:h-5 sm:w-5" />
              ) : (
                <Maximize className="h-4 w-4 sm:h-5 sm:w-5" />
              )}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
