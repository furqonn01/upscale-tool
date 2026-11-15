import type { DeviceCapabilities, PhotoUpscaleOptions, RestorationPreset } from '../types'

let cachedCaps: DeviceCapabilities | null = null

export function detectDeviceCapabilities(): DeviceCapabilities {
  if (cachedCaps) return cachedCaps

  const ua = typeof navigator !== 'undefined' ? navigator.userAgent : ''
  const isTouch =
    typeof window !== 'undefined' &&
    ('ontouchstart' in window || navigator.maxTouchPoints > 0)
  const isMobile =
    /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(ua) ||
    (isTouch && typeof window !== 'undefined' && window.innerWidth < 820)

  let webgl2 = false
  let maxTextureSize = 4096
  if (typeof document !== 'undefined') {
    try {
      const canvas = document.createElement('canvas')
      const gl = canvas.getContext('webgl2')
      if (gl) {
        webgl2 = true
        maxTextureSize = gl.getParameter(gl.MAX_TEXTURE_SIZE) || 4096
      }
    } catch {
      webgl2 = false
    }
  }

  const nav = typeof navigator !== 'undefined' ? (navigator as Navigator & { gpu?: unknown; deviceMemory?: number }) : undefined
  const webgpu = Boolean(nav && 'gpu' in nav && nav.gpu)
  const webcodecs =
    typeof window !== 'undefined' &&
    'VideoEncoder' in window &&
    'VideoFrame' in window
  const offscreenCanvas = typeof OffscreenCanvas !== 'undefined'
  const deviceMemoryGB = nav?.deviceMemory ?? null
  const hardwareConcurrency = nav?.hardwareConcurrency ?? 4

  let recommendedTileSize: 128 | 192 | 256 = 256
  if (isMobile || (deviceMemoryGB !== null && deviceMemoryGB <= 4)) {
    recommendedTileSize = 128
  } else if (deviceMemoryGB !== null && deviceMemoryGB <= 8) {
    recommendedTileSize = 192
  }

  cachedCaps = {
    isMobile,
    isTouch,
    webgpu,
    webgl2,
    webcodecs,
    offscreenCanvas,
    deviceMemoryGB,
    hardwareConcurrency,
    maxTextureSize,
    recommendedTileSize,
  }
  return cachedCaps
}

export function getPresetSettings(preset: RestorationPreset): Pick<
  PhotoUpscaleOptions,
  'denoise' | 'sharpen' | 'clarity' | 'deblock'
> {
  switch (preset) {
    case 'photo-burik':
      return { denoise: 55, deblock: 65, sharpen: 68, clarity: 42 }
    case 'anime':
      return { denoise: 62, deblock: 70, sharpen: 84, clarity: 35 }
    case 'portrait-soft':
      return { denoise: 60, deblock: 50, sharpen: 45, clarity: 28 }
    case 'sharp-text':
      return { denoise: 35, deblock: 55, sharpen: 92, clarity: 55 }
  }
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`
}
