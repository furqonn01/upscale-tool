import type { ApiProfile, GalleryItem, TokenStorageScope } from '../types'

const PROFILES_KEY = 'hd_studio_api_profiles_v1'
const ACTIVE_PROFILE_KEY = 'hd_studio_active_profile_v1'
const TOKEN_SCOPE_KEY = 'hd_studio_token_scope_v1'
const SESSION_KEYS_KEY = 'hd_studio_session_keys_v1'

export const DEFAULT_PROFILES: ApiProfile[] = [
  {
    id: '9router-local',
    name: '9Router (Gateway Lokal)',
    kind: '9router',
    baseUrl: 'http://localhost:20128/v1',
    apiKey: '',
    textModel: 'agnes-3.5',
    imageModel: 'dall-e-3',
    imageEndpointMode: 'auto',
  },
  {
    id: 'agnes-custom',
    name: 'Agnes 3.5 / OpenAI-Compatible',
    kind: 'openai-compatible',
    baseUrl: 'https://api.openai.com/v1',
    apiKey: '',
    textModel: 'agnes-3.5',
    imageModel: 'gpt-image-1',
    imageEndpointMode: 'auto',
  },
  {
    id: 'gemini-native',
    name: 'Google Gemini API (BYOK)',
    kind: 'gemini',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    apiKey: '',
    textModel: 'gemini-2.5-flash',
    imageModel: 'gemini-2.0-flash-preview-image-generation',
    imageEndpointMode: 'gemini-native',
  },
]

function loadSessionKeys(): Record<string, string> {
  try {
    const raw = sessionStorage.getItem(SESSION_KEYS_KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw) as unknown
    if (!parsed || typeof parsed !== 'object') return {}
    return parsed as Record<string, string>
  } catch {
    return {}
  }
}

export function loadApiProfiles(): {
  profiles: ApiProfile[]
  activeId: string
  tokenScope: TokenStorageScope
} {
  try {
    const rawScope = localStorage.getItem(TOKEN_SCOPE_KEY)
    const tokenScope: TokenStorageScope = rawScope === 'session' ? 'session' : 'local'
    const raw = localStorage.getItem(PROFILES_KEY)
    const activeRaw = localStorage.getItem(ACTIVE_PROFILE_KEY)
    if (!raw) {
      return {
        profiles: DEFAULT_PROFILES,
        activeId: DEFAULT_PROFILES[0].id,
        tokenScope,
      }
    }
    const parsed = JSON.parse(raw) as ApiProfile[]
    if (!Array.isArray(parsed) || parsed.length === 0) {
      return {
        profiles: DEFAULT_PROFILES,
        activeId: DEFAULT_PROFILES[0].id,
        tokenScope,
      }
    }
    const sessionKeys = tokenScope === 'session' ? loadSessionKeys() : null
    const hydratedProfiles =
      sessionKeys === null
        ? parsed
        : parsed.map((p) => ({
            ...p,
            apiKey: typeof sessionKeys[p.id] === 'string' ? sessionKeys[p.id] : '',
          }))
    // Guarantee no leftover apiKey remains in localStorage when session-only mode is active.
    if (tokenScope === 'session' && parsed.some((p) => p.apiKey)) {
      const sanitized = parsed.map((p) => ({ ...p, apiKey: '' }))
      localStorage.setItem(PROFILES_KEY, JSON.stringify(sanitized))
    }
    const activeId =
      activeRaw && hydratedProfiles.some((p) => p.id === activeRaw)
        ? activeRaw
        : hydratedProfiles[0].id
    return { profiles: hydratedProfiles, activeId, tokenScope }
  } catch {
    return { profiles: DEFAULT_PROFILES, activeId: DEFAULT_PROFILES[0].id, tokenScope: 'local' }
  }
}

export function saveApiProfiles(
  profiles: ApiProfile[],
  activeId: string,
  tokenScope: TokenStorageScope = 'local',
): void {
  localStorage.setItem(TOKEN_SCOPE_KEY, tokenScope)
  localStorage.setItem(ACTIVE_PROFILE_KEY, activeId)
  if (tokenScope === 'session') {
    const keysMap: Record<string, string> = {}
    for (const p of profiles) {
      if (p.apiKey) keysMap[p.id] = p.apiKey
    }
    sessionStorage.setItem(SESSION_KEYS_KEY, JSON.stringify(keysMap))
    const sanitized = profiles.map((p) => ({ ...p, apiKey: '' }))
    localStorage.setItem(PROFILES_KEY, JSON.stringify(sanitized))
    return
  }
  sessionStorage.removeItem(SESSION_KEYS_KEY)
  localStorage.setItem(PROFILES_KEY, JSON.stringify(profiles))
}

export function clearStoredApiTokens(): void {
  try {
    sessionStorage.removeItem(SESSION_KEYS_KEY)
    const raw = localStorage.getItem(PROFILES_KEY)
    if (!raw) return
    const parsed = JSON.parse(raw) as ApiProfile[]
    if (Array.isArray(parsed)) {
      const sanitized = parsed.map((p) => ({ ...p, apiKey: '' }))
      localStorage.setItem(PROFILES_KEY, JSON.stringify(sanitized))
    }
  } catch {
    // Ignore storage parse failures while clearing tokens.
  }
}

// IndexedDB local gallery (100% on-device storage)
const DB_NAME = 'hd-local-studio-db'
const DB_VERSION = 1
const STORE_NAME = 'gallery'

function openGalleryDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION)
    req.onupgradeneeded = () => {
      const db = req.result
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        const store = db.createObjectStore(STORE_NAME, { keyPath: 'id' })
        store.createIndex('createdAt', 'createdAt', { unique: false })
      }
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

export async function saveGalleryItem(item: GalleryItem): Promise<void> {
  const db = await openGalleryDb()
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite')
    tx.objectStore(STORE_NAME).put(item)
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
  })
  db.close()
}

export async function listGalleryItems(): Promise<GalleryItem[]> {
  const db = await openGalleryDb()
  const items = await new Promise<GalleryItem[]>((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly')
    const req = tx.objectStore(STORE_NAME).getAll()
    req.onsuccess = () => resolve((req.result as GalleryItem[]) || [])
    req.onerror = () => reject(req.error)
  })
  db.close()
  return items.sort((a, b) => b.createdAt - a.createdAt)
}

export async function deleteGalleryItem(id: string): Promise<void> {
  const db = await openGalleryDb()
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite')
    tx.objectStore(STORE_NAME).delete(id)
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
  })
  db.close()
}

export async function clearGalleryItems(): Promise<void> {
  const db = await openGalleryDb()
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite')
    tx.objectStore(STORE_NAME).clear()
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
  })
  db.close()
}
