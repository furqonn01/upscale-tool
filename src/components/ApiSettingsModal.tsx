import { useState } from 'react'
import {
  CheckCircle2,
  Eye,
  EyeOff,
  KeyRound,
  Loader2,
  Plus,
  RefreshCw,
  ShieldCheck,
  Trash2,
  X,
  XCircle,
} from 'lucide-react'
import { testApiConnection } from '../engines/apiClient'
import type { ApiProfile, ApiProviderKind, TokenStorageScope } from '../types'
import { clearStoredApiTokens } from '../utils/storage'

interface ApiSettingsModalProps {
  open: boolean
  profiles: ApiProfile[]
  activeId: string
  tokenScope: TokenStorageScope
  onClose: () => void
  onSave: (profiles: ApiProfile[], activeId: string, tokenScope: TokenStorageScope) => void
}

export function ApiSettingsModal({
  open,
  profiles,
  activeId,
  tokenScope,
  onClose,
  onSave,
}: ApiSettingsModalProps) {
  const [draftProfiles, setDraftProfiles] = useState<ApiProfile[]>(profiles)
  const [selectedId, setSelectedId] = useState<string>(activeId)
  const [draftScope, setDraftScope] = useState<TokenStorageScope>(tokenScope)
  const [showKey, setShowKey] = useState(false)
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<{
    ok: boolean
    message: string
    models?: string[]
  } | null>(null)

  if (!open) return null

  const active = draftProfiles.find((p) => p.id === selectedId) ?? draftProfiles[0]

  const updateActive = (patch: Partial<ApiProfile>) => {
    setDraftProfiles((prev) =>
      prev.map((p) => (p.id === active.id ? { ...p, ...patch } : p))
    )
    setTestResult(null)
  }

  const addNewProfile = () => {
    const newId = `custom-${Date.now()}`
    const created: ApiProfile = {
      id: newId,
      name: 'Custom API / 9Router',
      kind: 'openai-compatible',
      baseUrl: 'http://localhost:20128/v1',
      apiKey: '',
      textModel: 'agnes-3.5',
      imageModel: 'dall-e-3',
      imageEndpointMode: 'auto',
    }
    setDraftProfiles((prev) => [...prev, created])
    setSelectedId(newId)
    setTestResult(null)
  }

  const removeActiveProfile = () => {
    if (draftProfiles.length <= 1) return
    const next = draftProfiles.filter((p) => p.id !== active.id)
    setDraftProfiles(next)
    setSelectedId(next[0].id)
    setTestResult(null)
  }

  const runTest = async () => {
    setTesting(true)
    setTestResult(null)
    const res = await testApiConnection(active)
    setTestResult(res)
    setTesting(false)
  }

  const handleSave = () => {
    onSave(draftProfiles, active.id, draftScope)
    onClose()
  }

  const handleClearAllTokens = () => {
    clearStoredApiTokens()
    const cleared = draftProfiles.map((p) => ({ ...p, apiKey: '' }))
    setDraftProfiles(cleared)
    onSave(cleared, active.id, draftScope)
    setTestResult({
      ok: true,
      message: 'Semua token API telah dihapus dari penyimpanan browser ini.',
    })
  }

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/75 p-0 backdrop-blur-sm sm:items-center sm:p-4">
      <div className="flex max-h-[92dvh] w-full max-w-2xl flex-col overflow-hidden rounded-t-2xl border border-zinc-800 bg-zinc-900 shadow-2xl sm:rounded-2xl">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-zinc-800 px-4 py-3.5">
          <div className="flex items-center gap-2">
            <KeyRound className="h-5 w-5 text-violet-400" />
            <div>
              <h2 className="text-sm font-semibold text-white sm:text-base">
                Pengaturan API Key &amp; Gateway (BYOK)
              </h2>
              <p className="text-[11px] text-zinc-400">
                Support 9Router, Agnes 3.5 (Non-Vision), OpenAI-Compatible, &amp; Gemini
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg p-1.5 text-zinc-400 hover:bg-zinc-800 hover:text-white"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 space-y-4 overflow-y-auto p-4">
          {/* Profile tabs */}
          <div className="flex flex-wrap items-center gap-1.5">
            {draftProfiles.map((p) => (
              <button
                key={p.id}
                type="button"
                onClick={() => {
                  setSelectedId(p.id)
                  setTestResult(null)
                }}
                className={`rounded-xl border px-3 py-1.5 text-xs font-medium transition ${
                  p.id === active.id
                    ? 'border-violet-500 bg-violet-600 text-white'
                    : 'border-zinc-700 bg-zinc-950/60 text-zinc-300 hover:border-zinc-600'
                }`}
              >
                {p.name}
              </button>
            ))}
            <button
              type="button"
              onClick={addNewProfile}
              className="inline-flex items-center gap-1 rounded-xl border border-dashed border-zinc-700 px-2.5 py-1.5 text-xs text-zinc-300 hover:border-violet-500 hover:text-white"
            >
              <Plus className="h-3.5 w-3.5" />
              Tambah Profil
            </button>
          </div>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div>
              <label className="mb-1 block text-xs text-zinc-400">Nama Profil</label>
              <input
                type="text"
                value={active.name}
                onChange={(e) => updateActive({ name: e.target.value })}
                className="w-full rounded-xl border border-zinc-700 bg-zinc-950 px-3 py-2 text-xs text-zinc-100 outline-none focus:border-violet-500"
              />
            </div>

            <div>
              <label className="mb-1 block text-xs text-zinc-400">Tipe Provider</label>
              <select
                value={active.kind}
                onChange={(e) => {
                  const kind = e.target.value as ApiProviderKind
                  updateActive({
                    kind,
                    baseUrl:
                      kind === '9router'
                        ? 'http://localhost:20128/v1'
                        : kind === 'gemini'
                          ? 'https://generativelanguage.googleapis.com/v1beta'
                          : active.baseUrl,
                    imageEndpointMode: kind === 'gemini' ? 'gemini-native' : 'auto',
                  })
                }}
                className="w-full rounded-xl border border-zinc-700 bg-zinc-950 px-3 py-2 text-xs text-zinc-100 outline-none focus:border-violet-500"
              >
                <option value="9router">9Router (OpenAI-Compatible Gateway)</option>
                <option value="openai-compatible">OpenAI-Compatible (Agnes / OpenRouter / Custom)</option>
                <option value="gemini">Google Gemini API (Native)</option>
              </select>
            </div>
          </div>

          <div>
            <label className="mb-1 block text-xs text-zinc-400">Base URL Endpoint</label>
            <input
              type="url"
              value={active.baseUrl}
              onChange={(e) => updateActive({ baseUrl: e.target.value })}
              placeholder="http://localhost:20128/v1"
              className="w-full rounded-xl border border-zinc-700 bg-zinc-950 px-3 py-2 font-mono text-xs text-zinc-100 outline-none focus:border-violet-500"
            />
          </div>

          <div>
            <label className="mb-1 block text-xs text-zinc-400">
              API Key (Hanya disimpan di browser ini — tidak global)
            </label>
            <div className="flex gap-2">
              <input
                type={showKey ? 'text' : 'password'}
                value={active.apiKey}
                onChange={(e) => updateActive({ apiKey: e.target.value })}
                placeholder="Tempel API Key dari 9Router / Agnes / Gemini / OpenAI..."
                className="flex-1 rounded-xl border border-zinc-700 bg-zinc-950 px-3 py-2 font-mono text-xs text-zinc-100 outline-none focus:border-violet-500"
              />
              <button
                type="button"
                onClick={() => setShowKey((s) => !s)}
                className="rounded-xl border border-zinc-700 bg-zinc-950 px-3 text-zinc-300 hover:bg-zinc-800"
                title={showKey ? 'Sembunyikan' : 'Tampilkan'}
              >
                {showKey ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
              </button>
            </div>
            {active.apiKey.trim().startsWith('AIza') && active.kind !== 'gemini' && (
              <p className="mt-1.5 text-[11px] text-amber-300">
                Key Anda diawali <span className="font-mono">AIza...</span> (Google Gemini). Pilih tab profil{' '}
                <strong>Google Gemini API (BYOK)</strong> di atas atau ubah Tipe Provider ke <strong>Google Gemini API</strong>.
              </p>
            )}

            {/* Browser-only token storage controls */}
            <div className="mt-2.5 rounded-xl border border-zinc-800 bg-zinc-950/70 p-2.5">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="inline-flex items-center gap-1.5 text-[11px] font-medium text-emerald-300">
                  <ShieldCheck className="h-3.5 w-3.5" />
                  Penyimpanan Token Browser (Bukan Global)
                </span>
                <button
                  type="button"
                  onClick={handleClearAllTokens}
                  className="inline-flex items-center gap-1 rounded-lg border border-red-500/30 bg-red-500/10 px-2 py-1 text-[11px] font-medium text-red-300 hover:bg-red-500/20"
                >
                  <Trash2 className="h-3 w-3" />
                  Hapus Semua Token
                </button>
              </div>
              <div className="mt-2 grid grid-cols-2 gap-1.5">
                <button
                  type="button"
                  onClick={() => setDraftScope('local')}
                  className={`rounded-lg border px-2.5 py-1.5 text-left text-[11px] transition ${
                    draftScope === 'local'
                      ? 'border-violet-500 bg-violet-500/15 text-violet-200'
                      : 'border-zinc-800 bg-zinc-900/60 text-zinc-400 hover:border-zinc-700'
                  }`}
                >
                  <div className="font-semibold">Browser Ini (Persisten)</div>
                  <div className="text-[10px] opacity-80">localStorage browser lokal</div>
                </button>
                <button
                  type="button"
                  onClick={() => setDraftScope('session')}
                  className={`rounded-lg border px-2.5 py-1.5 text-left text-[11px] transition ${
                    draftScope === 'session'
                      ? 'border-violet-500 bg-violet-500/15 text-violet-200'
                      : 'border-zinc-800 bg-zinc-900/60 text-zinc-400 hover:border-zinc-700'
                  }`}
                >
                  <div className="font-semibold">Tab Ini Saja (Sementara)</div>
                  <div className="text-[10px] opacity-80">sessionStorage, hilang saat tutup tab</div>
                </button>
              </div>
              <p className="mt-1.5 text-[10px] text-zinc-500">
                Token hanya tersimpan di browser perangkat ini (tidak disimpan di server, file .env, atau global).
              </p>
            </div>
          </div>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div>
              <label className="mb-1 block text-xs text-zinc-400">
                Model Teks / Non-Vision (Prompt &amp; SVG)
              </label>
              <input
                type="text"
                value={active.textModel}
                onChange={(e) => updateActive({ textModel: e.target.value })}
                placeholder="agnes-3.5 atau combo/model dari 9Router"
                className="w-full rounded-xl border border-zinc-700 bg-zinc-950 px-3 py-2 font-mono text-xs text-zinc-100 outline-none focus:border-violet-500"
              />
            </div>

            <div>
              <label className="mb-1 block text-xs text-zinc-400">
                Model Gambar (Image Generation)
              </label>
              <input
                type="text"
                value={active.imageModel}
                onChange={(e) => updateActive({ imageModel: e.target.value })}
                placeholder="dall-e-3 / gpt-image-1 / gemini-2.0-flash-preview-image-generation"
                className="w-full rounded-xl border border-zinc-700 bg-zinc-950 px-3 py-2 font-mono text-xs text-zinc-100 outline-none focus:border-violet-500"
              />
            </div>
          </div>

          <div>
            <label className="mb-1 block text-xs text-zinc-400">Mode Endpoint Gambar</label>
            <select
              value={active.imageEndpointMode}
              onChange={(e) =>
                updateActive({
                  imageEndpointMode: e.target.value as ApiProfile['imageEndpointMode'],
                })
              }
              className="w-full rounded-xl border border-zinc-700 bg-zinc-950 px-3 py-2 text-xs text-zinc-100 outline-none focus:border-violet-500"
            >
              <option value="auto">Otomatis (/images/generations lalu fallback Chat Multimodal)</option>
              <option value="images-api">Khusus /v1/images/generations</option>
              <option value="chat-multimodal">Khusus /v1/chat/completions (Image URL/Base64)</option>
              <option value="gemini-native">Khusus Gemini Native Image</option>
            </select>
          </div>

          {/* Test connection */}
          <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-zinc-800 bg-zinc-950/60 p-3">
            <button
              type="button"
              disabled={testing}
              onClick={runTest}
              className="inline-flex items-center gap-2 rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-1.5 text-xs font-medium text-zinc-100 hover:bg-zinc-700 disabled:opacity-50"
            >
              {testing ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <RefreshCw className="h-3.5 w-3.5" />
              )}
              Tes Koneksi &amp; Cek Model
            </button>

            {draftProfiles.length > 1 && (
              <button
                type="button"
                onClick={removeActiveProfile}
                className="inline-flex items-center gap-1 rounded-lg px-2.5 py-1.5 text-xs text-rose-400 hover:bg-rose-500/10"
              >
                <Trash2 className="h-3.5 w-3.5" />
                Hapus Profil
              </button>
            )}
          </div>

          {testResult && (
            <div
              className={`rounded-xl border p-3 text-xs ${
                testResult.ok
                  ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-200'
                  : 'border-rose-500/40 bg-rose-500/10 text-rose-200'
              }`}
            >
              <div className="flex items-start gap-2">
                {testResult.ok ? (
                  <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-400" />
                ) : (
                  <XCircle className="mt-0.5 h-4 w-4 shrink-0 text-rose-400" />
                )}
                <span>{testResult.message}</span>
              </div>

              {testResult.models && testResult.models.length > 0 && (
                <div className="mt-2.5 space-y-1.5 border-t border-emerald-500/20 pt-2">
                  <div className="text-[11px] text-emerald-300">
                    Klik model untuk mengisi Model Teks (atau tahan Shift/klik kanan untuk Model Gambar):
                  </div>
                  <div className="flex flex-wrap gap-1.5">
                    {testResult.models.map((m) => (
                      <button
                        key={m}
                        type="button"
                        onClick={(e) =>
                          e.shiftKey
                            ? updateActive({ imageModel: m })
                            : updateActive({ textModel: m })
                        }
                        onContextMenu={(e) => {
                          e.preventDefault()
                          updateActive({ imageModel: m })
                        }}
                        className="rounded-md border border-emerald-500/30 bg-zinc-950/70 px-2 py-0.5 font-mono text-[11px] text-zinc-200 hover:border-emerald-400"
                      >
                        {m}
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end gap-2 border-t border-zinc-800 px-4 py-3 safe-pb">
          <button
            type="button"
            onClick={onClose}
            className="rounded-xl border border-zinc-700 px-4 py-2 text-xs font-medium text-zinc-300 hover:bg-zinc-800"
          >
            Batal
          </button>
          <button
            type="button"
            onClick={handleSave}
            className="rounded-xl bg-violet-600 px-4 py-2 text-xs font-semibold text-white hover:bg-violet-500"
          >
            Simpan &amp; Gunakan Profil Ini
          </button>
        </div>
      </div>
    </div>
  )
}
