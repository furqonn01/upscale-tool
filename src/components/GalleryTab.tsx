import { useEffect, useState } from 'react'
import { ArrowUpRight, Download, FolderHeart, Trash2 } from 'lucide-react'
import type { GalleryItem } from '../types'
import { formatBytes } from '../utils/device'
import { clearGalleryItems, deleteGalleryItem, listGalleryItems } from '../utils/storage'

interface GalleryTabProps {
  refreshSignal: number
  onSendToUpscaler: (blob: Blob, title: string) => void
}

interface GalleryViewItem extends GalleryItem {
  objectUrl: string
}

export function GalleryTab({ refreshSignal, onSendToUpscaler }: GalleryTabProps) {
  const [items, setItems] = useState<GalleryViewItem[]>([])
  const [filter, setFilter] = useState<'all' | 'photo' | 'video' | 'generated'>('all')

  useEffect(() => {
    let active = true
    const urlsToRevoke: string[] = []

    listGalleryItems()
      .then((rows) => {
        if (!active) return
        const mapped = rows.map((r) => {
          const objectUrl = URL.createObjectURL(r.blob)
          urlsToRevoke.push(objectUrl)
          return { ...r, objectUrl }
        })
        setItems(mapped)
      })
      .catch(() => undefined)

    return () => {
      active = false
      for (const u of urlsToRevoke) URL.revokeObjectURL(u)
    }
  }, [refreshSignal])

  const handleDelete = async (id: string) => {
    await deleteGalleryItem(id)
    setItems((prev) => {
      const target = prev.find((i) => i.id === id)
      if (target) URL.revokeObjectURL(target.objectUrl)
      return prev.filter((i) => i.id !== id)
    })
  }

  const handleClearAll = async () => {
    await clearGalleryItems()
    for (const i of items) URL.revokeObjectURL(i.objectUrl)
    setItems([])
  }

  const filtered = items.filter((item) => {
    if (filter === 'photo') return item.kind === 'upscale-photo'
    if (filter === 'video') return item.kind === 'upscale-video'
    if (filter === 'generated')
      return item.kind === 'generated-image' || item.kind === 'generated-svg'
    return true
  })

  const downloadItem = (item: GalleryViewItem) => {
    const ext = item.mimeType.includes('mp4')
      ? 'mp4'
      : item.mimeType.includes('webm')
        ? 'webm'
        : item.mimeType.includes('jpeg')
          ? 'jpg'
          : item.mimeType.includes('webp')
            ? 'webp'
            : 'png'
    const a = document.createElement('a')
    a.href = item.objectUrl
    a.download = `${item.title.replace(/[^\w-]+/g, '_')}.${ext}`
    a.click()
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap gap-1.5">
          {(
            [
              { id: 'all', label: `Semua (${items.length})` },
              { id: 'photo', label: 'Foto HD' },
              { id: 'video', label: 'Video HD' },
              { id: 'generated', label: 'Hasil AI' },
            ] as const
          ).map((f) => (
            <button
              key={f.id}
              type="button"
              onClick={() => setFilter(f.id)}
              className={`rounded-xl border px-3 py-1.5 text-xs font-medium transition ${
                filter === f.id
                  ? 'border-violet-500 bg-violet-600 text-white'
                  : 'border-zinc-800 bg-zinc-900 text-zinc-400 hover:text-zinc-200'
              }`}
            >
              {f.label}
            </button>
          ))}
        </div>

        {items.length > 0 && (
          <button
            type="button"
            onClick={handleClearAll}
            className="inline-flex items-center gap-1.5 rounded-xl border border-zinc-800 bg-zinc-900 px-3 py-1.5 text-xs text-rose-400 hover:border-rose-500/40"
          >
            <Trash2 className="h-3.5 w-3.5" />
            Bersihkan Galeri
          </button>
        )}
      </div>

      {filtered.length === 0 ? (
        <div className="flex min-h-[280px] flex-col items-center justify-center rounded-2xl border border-zinc-800 bg-zinc-900/40 p-6 text-center">
          <FolderHeart className="mb-3 h-9 w-9 text-zinc-600" />
          <p className="text-sm font-medium text-zinc-300">Galeri Lokal Masih Kosong</p>
          <p className="mt-1 max-w-md text-xs text-zinc-500">
            Semua hasil upscale foto/video dan gambar AI yang Anda buat otomatis tersimpan aman di penyimpanan lokal browser (IndexedDB) perangkat ini.
          </p>
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {filtered.map((item) => (
            <div
              key={item.id}
              className="flex flex-col overflow-hidden rounded-2xl border border-zinc-800 bg-zinc-900/70"
            >
              <div className="aspect-video bg-zinc-950 checkerboard-bg overflow-hidden">
                {item.kind === 'upscale-video' ? (
                  <video
                    src={item.objectUrl}
                    controls
                    playsInline
                    className="h-full w-full bg-black object-contain"
                  />
                ) : (
                  <img
                    src={item.objectUrl}
                    alt={item.title}
                    className="h-full w-full object-contain"
                  />
                )}
              </div>

              <div className="flex flex-1 flex-col justify-between gap-2 p-3">
                <div>
                  <div className="truncate text-xs font-semibold text-zinc-100">{item.title}</div>
                  <div className="mt-0.5 text-[11px] text-zinc-400">
                    {item.width && item.height ? `${item.width}×${item.height} • ` : ''}
                    {formatBytes(item.blob.size)}
                    {item.meta ? ` • ${item.meta}` : ''}
                  </div>
                </div>

                <div className="flex items-center gap-1.5 pt-1">
                  {item.kind !== 'upscale-video' && (
                    <button
                      type="button"
                      onClick={() => onSendToUpscaler(item.blob, item.title)}
                      className="inline-flex flex-1 items-center justify-center gap-1 rounded-lg bg-violet-600/90 px-2.5 py-1.5 text-xs font-medium text-white hover:bg-violet-500"
                    >
                      <ArrowUpRight className="h-3.5 w-3.5" />
                      Upscale
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => downloadItem(item)}
                    className="inline-flex flex-1 items-center justify-center gap-1 rounded-lg border border-zinc-700 bg-zinc-800 px-2.5 py-1.5 text-xs font-medium text-zinc-200 hover:bg-zinc-700"
                  >
                    <Download className="h-3.5 w-3.5" />
                    Unduh
                  </button>
                  <button
                    type="button"
                    onClick={() => handleDelete(item.id)}
                    className="rounded-lg border border-zinc-800 p-1.5 text-zinc-400 hover:border-rose-500/40 hover:text-rose-400"
                    title="Hapus"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
