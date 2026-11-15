export type AppTab = 'photo' | 'video' | 'generate' | 'gallery'

export interface DeviceCapabilities {
  isMobile: boolean
  isTouch: boolean
  webgpu: boolean
  webgl2: boolean
  webcodecs: boolean
  offscreenCanvas: boolean
  deviceMemoryGB: number | null
  hardwareConcurrency: number
  maxTextureSize: number
  recommendedTileSize: 128 | 192 | 256
}

export type PhotoEngine = 'instant-hd' | 'ai-onnx'
export type RestorationPreset = 'photo-burik' | 'anime' | 'portrait-soft' | 'sharp-text'
export type OutputImageFormat = 'image/png' | 'image/jpeg' | 'image/webp'

export type OnnxExecutionBackend = 'auto' | 'wasm'

export interface PhotoUpscaleOptions {
  engine: PhotoEngine
  preset: RestorationPreset
  scale: 2 | 3 | 4
  denoise: number // 0 - 100
  sharpen: number // 0 - 100
  clarity: number // 0 - 100
  deblock: number // 0 - 100
  tileSize: 128 | 192 | 256 | 384
  onnxModelId: string
  customModelFile?: File | null
  onnxBackend?: OnnxExecutionBackend
  outputFormat: OutputImageFormat
}

export interface OnnxModelSpec {
  id: string
  name: string
  scale: 2 | 4
  sizeLabel: string
  bestFor: string
  url: string
  isFp16?: boolean
  inputOrder?: 'nchw'
  valueRange?: '0_1' | 'neg1_1'
  fixedSize?: number
}

export type VideoPipelineMode = 'auto' | 'webcodecs' | 'recorder'
export type VideoPreset = 'photo-burik' | 'anime' | 'clarity'

export interface VideoUpscaleOptions {
  scale: 1.5 | 2 | 3 | 4
  preset: VideoPreset
  denoise: number
  sharpen: number
  clarity: number
  deblock: number
  maxHeight: 720 | 1080 | 2160
  targetFps: 'source' | 24 | 30 | 60
  pipeline: VideoPipelineMode
  includeAudio: boolean
}

export type TokenStorageScope = 'local' | 'session'

export type ApiProviderKind = '9router' | 'openai-compatible' | 'gemini'

export interface ApiProfile {
  id: string
  name: string
  kind: ApiProviderKind
  baseUrl: string
  apiKey: string
  textModel: string // For non-vision LLM (Agnes 3.5, 9Router combo, Gemini text)
  imageModel: string // For image generation (or multimodal image model)
  imageEndpointMode: 'auto' | 'images-api' | 'chat-multimodal' | 'gemini-native'
}

export interface GalleryItem {
  id: string
  kind: 'upscale-photo' | 'upscale-video' | 'generated-image' | 'generated-svg'
  title: string
  createdAt: number
  mimeType: string
  blob: Blob
  width?: number
  height?: number
  meta?: string
}

export interface ProgressInfo {
  percent: number
  stage: string
  detail?: string
}
