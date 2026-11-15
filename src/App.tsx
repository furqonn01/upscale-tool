import { useMemo, useState } from 'react'
import {
  Film,
  FolderHeart,
  Image as ImageIcon,
  KeyRound,
  ShieldCheck,
  Sparkles,
} from 'lucide-react'
import { ApiSettingsModal } from './components/ApiSettingsModal'
import { GalleryTab } from './components/GalleryTab'
import { GeneratorTab } from './components/GeneratorTab'
import { PhotoUpscalerTab } from './components/PhotoUpscalerTab'
import { VideoUpscalerTab } from './components/VideoUpscalerTab'
import type { ApiProfile, AppTab, TokenStorageScope } from './types'
import { detectDeviceCapabilities } from './utils/device'
import { loadApiProfiles, saveApiProfiles } from './utils/storage'

const TABS: Array<{ id: AppTab; label: string; shortLabel: string; icon: typeof ImageIcon }> = [
  { id: 'photo', label: 'Upscale Foto HD', shortLabel: 'Foto HD', icon: ImageIcon },
  { id: 'video', label: 'Upscale Video HD', shortLabel: 'Video HD', icon: Film },
  { id: 'generate', label: 'AI Generator (BYOK)', shortLabel: 'Generate', icon: Sparkles },
  { id: 'gallery', label: 'Galeri Lokal', shortLabel: 'Galeri', icon: FolderHeart },
]

export function App() {
  const caps = useMemo(() => detectDeviceCapabilities(), [])
  const initialProfiles = useMemo(() => loadApiProfiles(), [])

  const [activeTab, setActiveTab] = useState<AppTab>('photo')
  const [profiles, setProfiles] = useState<ApiProfile[]>(initialProfiles.profiles)
  const [activeProfileId, setActiveProfileId] = useState<string>(initialProfiles.activeId)
  const [tokenScope, setTokenScope] = useState<TokenStorageScope>(initialProfiles.tokenScope)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [galleryRefresh, setGalleryRefresh] = useState(0)
  const [incomingImage, setIncomingImage] = useState<{
    blob: Blob
    title: string
    nonce: number
  } | null>(null)

  const activeProfile =
    profiles.find((p) => p.id === activeProfileId) ?? profiles[0]

  const handleSaveProfiles = (
    nextProfiles: ApiProfile[],
    nextActiveId: string,
    nextScope: TokenStorageScope,
  ) => {
    setProfiles(nextProfiles)
    setActiveProfileId(nextActiveId)
    setTokenScope(nextScope)
    saveApiProfiles(nextProfiles, nextActiveId, nextScope)
  }

  const handleSendToUpscaler = (blob: Blob, title: string) => {
    setIncomingImage({ blob, title, nonce: Date.now() })
    setActiveTab('photo')
  }

  return (
    <div className="min-h-dvh bg-zinc-950 text-zinc-100 pb-20 md:pb-8">
      {/* Top Bar */}
      <header className="sticky top-0 z-30 border-b border-zinc-800/80 bg-zinc-950/85 backdrop-blur-md">
        <div className="mx-auto flex max-w-7xl items-center justify-between gap-3 px-4 py-3">
          <div className="flex items-center gap-2.5">
            <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-gradient-to-br from-violet-600 to-sky-500 shadow-lg shadow-violet-600/20">
              <Sparkles className="h-5 w-5 text-white" />
            </div>
            <div>
              <h1 className="text-sm font-bold tracking-tight text-white sm:text-base">
                HD Local Studio
              </h1>
              <div className="flex items-center gap-1.5 text-[11px] text-zinc-400">
                <ShieldCheck className="h-3.5 w-3.5 text-emerald-400" />
                <span>100% Lokal • Tanpa Upload Server</span>
              </div>
            </div>
          </div>

          {/* Desktop Navigation Pills */}
          <nav className="hidden items-center gap-1 rounded-2xl border border-zinc-800 bg-zinc-900/70 p-1 md:flex">
            {TABS.map((t) => {
              const Icon = t.icon
              const isActive = activeTab === t.id
              return (
                <button
                  key={t.id}
                  type="button"
                  onClick={() => setActiveTab(t.id)}
                  className={`inline-flex items-center gap-1.5 rounded-xl px-3.5 py-1.5 text-xs font-semibold transition ${
                    isActive
                      ? 'bg-violet-600 text-white shadow-sm'
                      : 'text-zinc-400 hover:text-zinc-100'
                  }`}
                >
                  <Icon className="h-3.5 w-3.5" />
                  {t.label}
                </button>
              )
            })}
          </nav>

          {/* Device Capability + API Key Button */}
          <div className="flex items-center gap-2">
            <span className="hidden rounded-lg border border-zinc-800 bg-zinc-900 px-2.5 py-1 text-[11px] font-medium text-zinc-400 lg:inline-flex">
              {caps.isMobile ? 'HP' : 'Laptop'} • {caps.webgpu ? 'WebGPU' : caps.webgl2 ? 'WebGL2' : 'CPU'}
            </span>
            <button
              type="button"
              onClick={() => setSettingsOpen(true)}
              className="inline-flex items-center gap-1.5 rounded-xl border border-zinc-700 bg-zinc-900 px-3 py-1.5 text-xs font-medium text-zinc-100 transition hover:border-violet-500 hover:bg-zinc-800"
            >
              <KeyRound className="h-3.5 w-3.5 text-violet-400" />
              <span className="hidden sm:inline">API Key</span>
              <span className="sm:hidden">API</span>
            </button>
          </div>
        </div>
      </header>

      {/* Main Content (preserve state across tab switches) */}
      <main className="mx-auto max-w-7xl px-3 py-4 sm:px-6 sm:py-6">
        <div className={activeTab === 'photo' ? 'block' : 'hidden'}>
          <PhotoUpscalerTab
            caps={caps}
            incomingImage={incomingImage}
            onGalleryUpdated={() => setGalleryRefresh((n) => n + 1)}
          />
        </div>

        <div className={activeTab === 'video' ? 'block' : 'hidden'}>
          <VideoUpscalerTab
            caps={caps}
            onGalleryUpdated={() => setGalleryRefresh((n) => n + 1)}
          />
        </div>

        <div className={activeTab === 'generate' ? 'block' : 'hidden'}>
          <GeneratorTab
            activeProfile={activeProfile}
            onOpenSettings={() => setSettingsOpen(true)}
            onSendToUpscaler={handleSendToUpscaler}
            onGalleryUpdated={() => setGalleryRefresh((n) => n + 1)}
          />
        </div>

        <div className={activeTab === 'gallery' ? 'block' : 'hidden'}>
          <GalleryTab
            refreshSignal={galleryRefresh}
            onSendToUpscaler={handleSendToUpscaler}
          />
        </div>
      </main>

      {/* Mobile Bottom Navigation */}
      <nav className="fixed inset-x-0 bottom-0 z-30 border-t border-zinc-800 bg-zinc-950/95 backdrop-blur-md md:hidden safe-pb">
        <div className="grid grid-cols-4 gap-1 px-2 pt-1.5">
          {TABS.map((t) => {
            const Icon = t.icon
            const isActive = activeTab === t.id
            return (
              <button
                key={t.id}
                type="button"
                onClick={() => setActiveTab(t.id)}
                className={`flex flex-col items-center justify-center gap-0.5 rounded-xl py-1.5 text-[11px] font-medium transition ${
                  isActive ? 'text-violet-400' : 'text-zinc-400'
                }`}
              >
                <Icon className={`h-5 w-5 ${isActive ? 'text-violet-400' : 'text-zinc-400'}`} />
                <span>{t.shortLabel}</span>
              </button>
            )
          })}
        </div>
      </nav>

      {settingsOpen && (
        <ApiSettingsModal
          open={settingsOpen}
          profiles={profiles}
          activeId={activeProfile.id}
          tokenScope={tokenScope}
          onClose={() => setSettingsOpen(false)}
          onSave={handleSaveProfiles}
        />
      )}
    </div>
  )
}

export default App
