import type { ApiProfile } from '../types'

function normalizeProviderBaseUrl(rawUrl: string, kind: ApiProfile['kind']): string {
  let url = rawUrl.trim().replace(/\/+$/, '')
  if (!url) return ''

  // Strip full endpoint suffixes if user pasted the entire endpoint path
  url = url.replace(/\/(?:chat\/completions|images\/generations|models)$/i, '')

  if (kind === 'gemini') {
    if (!/\/v\d/i.test(url)) {
      return `${url}/v1beta`
    }
    return url
  }

  try {
    const parsed = new URL(url)
    if (parsed.pathname === '' || parsed.pathname === '/') {
      return `${url}/v1`
    }
  } catch {
    // Keep as-is if non-standard URL
  }
  return url
}

function buildErrorMessage(err: unknown, baseUrl: string): string {
  const msg = err instanceof Error ? err.message : String(err)
  const isHttpsPage = typeof window !== 'undefined' && window.location.protocol === 'https:'
  const isLocalTarget = /^http:\/\/(localhost|127\.0\.0\.1)/i.test(baseUrl)

  if (/failed to fetch|networkerror|load failed/i.test(msg)) {
    if (isHttpsPage && isLocalTarget) {
      return `Browser memblokir koneksi dari halaman HTTPS ke ${baseUrl} (Mixed Content / Private Network). Jalankan web ini di http://localhost atau aktifkan HTTPS/tunnel untuk 9Router.`
    }
    return `Gagal terhubung ke ${baseUrl}. Kemungkinan terblokir CORS browser atau server belum berjalan (jalankan lewat npm run dev agar proxy lokal Vite aktif).`
  }
  return msg
}

function authHeaders(apiKey: string): Record<string, string> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (apiKey.trim()) {
    headers['Authorization'] = `Bearer ${apiKey.trim()}`
  }
  return headers
}

function extractBalancedJsonObjects(text: string): unknown[] {
  const parsed: unknown[] = []
  let i = 0
  while (i < text.length) {
    const start = text.indexOf('{', i)
    if (start === -1) break
    let depth = 0
    let inString = false
    let escaped = false
    let end = -1
    for (let j = start; j < text.length; j++) {
      const ch = text[j]
      if (escaped) {
        escaped = false
        continue
      }
      if (ch === '\\' && inString) {
        escaped = true
        continue
      }
      if (ch === '"') {
        inString = !inString
        continue
      }
      if (inString) continue
      if (ch === '{') depth++
      else if (ch === '}') {
        depth--
        if (depth === 0) {
          end = j
          break
        }
      }
    }
    if (end === -1) break
    try {
      parsed.push(JSON.parse(text.slice(start, end + 1)))
    } catch {
      // skip malformed chunk
    }
    i = end + 1
  }
  return parsed
}

async function parseFlexibleJson<T>(res: Response): Promise<T> {
  const raw = (await res.text()).trim()
  if (!raw) throw new Error('Server mengembalikan respons kosong')

  try {
    return JSON.parse(raw) as T
  } catch {
    // Handle SSE ("data: {...}") or concatenated JSON chunks ("{...}{...}" / "{...}extra")
    const objects = extractBalancedJsonObjects(raw)
    if (objects.length === 0) {
      throw new Error(`Respons API bukan JSON valid: ${raw.slice(0, 200)}`)
    }

    // Merge OpenAI streaming delta chunks if applicable
    const hasChoices = objects.some(
      (obj) =>
        typeof obj === 'object' &&
        obj !== null &&
        'choices' in obj &&
        Array.isArray((obj as { choices?: unknown[] }).choices)
    )
    if (hasChoices && objects.length > 1) {
      let mergedText = ''
      const mergedImages: Array<{ image_url?: { url?: string } }> = []
      for (const obj of objects) {
        const c = (obj as {
          choices?: Array<{
            message?: { content?: string; images?: Array<{ image_url?: { url?: string } }> }
            delta?: { content?: string; images?: Array<{ image_url?: { url?: string } }> }
          }>
        }).choices?.[0]
        if (c?.delta?.content) mergedText += c.delta.content
        else if (c?.message?.content) mergedText += c.message.content
        if (c?.delta?.images) mergedImages.push(...c.delta.images)
        if (c?.message?.images) mergedImages.push(...c.message.images)
      }
      if (mergedText || mergedImages.length > 0) {
        return {
          choices: [
            {
              message: {
                content: mergedText,
                ...(mergedImages.length > 0 ? { images: mergedImages } : {}),
              },
            },
          ],
        } as T
      }
    }

    return objects[0] as T
  }
}

const proxyPreferredOrigins = new Set<string>()

function getOriginSafe(url: string): string {
  try {
    return new URL(url).origin
  } catch {
    return ''
  }
}

async function fetchViaLocalProxy(url: string, init?: RequestInit): Promise<Response> {
  const headersRecord: Record<string, string> = {}
  if (init?.headers) {
    const h = new Headers(init.headers)
    h.forEach((v, k) => {
      headersRecord[k] = v
    })
  }
  const proxyRes = await fetch('/_proxy', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      url,
      method: init?.method || 'GET',
      headers: headersRecord,
      body: typeof init?.body === 'string' ? init.body : undefined,
    }),
  })
  if (proxyRes.status === 404 && !proxyRes.headers.get('X-Proxy-Used')) {
    throw new Error('Local proxy unavailable')
  }
  return proxyRes
}

async function smartFetch(
  url: string,
  init?: RequestInit
): Promise<{ response: Response; viaProxy: boolean }> {
  const origin = getOriginSafe(url)
  if (origin && proxyPreferredOrigins.has(origin)) {
    const proxyRes = await fetchViaLocalProxy(url, init)
    return { response: proxyRes, viaProxy: true }
  }

  try {
    const direct = await fetch(url, init)
    return { response: direct, viaProxy: false }
  } catch (directErr) {
    try {
      const proxyRes = await fetchViaLocalProxy(url, init)
      if (origin) proxyPreferredOrigins.add(origin)
      return { response: proxyRes, viaProxy: true }
    } catch {
      throw directErr
    }
  }
}

export async function testApiConnection(
  profile: ApiProfile
): Promise<{ ok: boolean; message: string; models?: string[] }> {
  const baseUrl = normalizeProviderBaseUrl(profile.baseUrl, profile.kind)
  if (!baseUrl) return { ok: false, message: 'Base URL wajib diisi.' }

  try {
    if (profile.kind === 'gemini') {
      if (!profile.apiKey.trim()) return { ok: false, message: 'API Key Gemini belum diisi.' }
      const { response: res, viaProxy } = await smartFetch(
        `${baseUrl}/models?key=${encodeURIComponent(profile.apiKey.trim())}`
      )
      if (!res.ok) {
        const text = await res.text()
        return { ok: false, message: `Gemini API error (${res.status}): ${text.slice(0, 220)}` }
      }
      const data = await parseFlexibleJson<{ models?: Array<{ name?: string }> }>(res)
      const models = (data.models || [])
        .map((m) => (m.name || '').replace(/^models\//, ''))
        .filter(Boolean)
        .slice(0, 24)
      return {
        ok: true,
        message: `Terhubung ke Gemini API (${models.length} model terdeteksi${viaProxy ? ' via proxy lokal' : ''}).`,
        models,
      }
    }

    const { response: res, viaProxy } = await smartFetch(`${baseUrl}/models`, {
      headers: authHeaders(profile.apiKey),
    })
    if (res.ok) {
      const data = await parseFlexibleJson<{ data?: Array<{ id?: string }> }>(res)
      const models = (data.data || []).map((m) => m.id || '').filter(Boolean).slice(0, 30)
      return {
        ok: true,
        message: `Terhubung ke ${baseUrl} (${models.length} model tersedia${viaProxy ? ' via proxy lokal' : ''}).`,
        models,
      }
    }

    // Fallback ping via tiny chat completion if /models is disabled on proxy
    const { response: chatRes, viaProxy: chatProxy } = await smartFetch(
      `${baseUrl}/chat/completions`,
      {
        method: 'POST',
        headers: authHeaders(profile.apiKey),
        body: JSON.stringify({
          model: profile.textModel.trim() || 'agnes-3.5',
          messages: [{ role: 'user', content: 'ping' }],
          max_tokens: 5,
          stream: false,
        }),
      }
    )
    if (!chatRes.ok) {
      const text = await chatRes.text()
      return {
        ok: false,
        message: `Server merespons ${chatRes.status}: ${text.slice(0, 220)}`,
      }
    }
    return {
      ok: true,
      message: `Terhubung ke ${baseUrl} via chat endpoint${chatProxy ? ' (proxy lokal)' : ''}.`,
    }
  } catch (err) {
    return { ok: false, message: buildErrorMessage(err, baseUrl) }
  }
}

async function runTextCompletion(
  profile: ApiProfile,
  systemPrompt: string,
  userPrompt: string
): Promise<string> {
  const baseUrl = normalizeProviderBaseUrl(profile.baseUrl, profile.kind)
  if (!baseUrl) throw new Error('Base URL API belum diatur di Pengaturan API Key')

  try {
    if (profile.kind === 'gemini') {
      if (!profile.apiKey.trim()) throw new Error('API Key Gemini belum diisi')
      const model = profile.textModel.trim() || 'gemini-2.5-flash'
      const { response: res } = await smartFetch(
        `${baseUrl}/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(profile.apiKey.trim())}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            systemInstruction: { parts: [{ text: systemPrompt }] },
            contents: [{ role: 'user', parts: [{ text: userPrompt }] }],
          }),
        }
      )
      if (!res.ok) {
        const errText = await res.text()
        throw new Error(`Gemini error (${res.status}): ${errText.slice(0, 220)}`)
      }
      const data = await parseFlexibleJson<{
        candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>
      }>(res)
      const text = data.candidates?.[0]?.content?.parts?.map((p) => p.text || '').join('') || ''
      if (!text.trim()) throw new Error('Respons teks Gemini kosong')
      return text.trim()
    }

    const { response: res } = await smartFetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: authHeaders(profile.apiKey),
      body: JSON.stringify({
        model: profile.textModel.trim() || 'agnes-3.5',
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
        temperature: 0.7,
        stream: false,
      }),
    })
    if (!res.ok) {
      const errText = await res.text()
      throw new Error(`API error (${res.status}): ${errText.slice(0, 220)}`)
    }
    const data = await parseFlexibleJson<{
      choices?: Array<{ message?: { content?: string } }>
    }>(res)
    const rawContent = data.choices?.[0]?.message?.content || ''
    const content = rawContent.replace(/<think>[\s\S]*?<\/think>/gi, '').trim()
    if (!content) throw new Error('Respons model teks kosong')
    return content
  } catch (err) {
    throw new Error(buildErrorMessage(err, baseUrl))
  }
}

export async function enhancePromptWithLlm(
  profile: ApiProfile,
  rawIdea: string,
  styleLabel: string
): Promise<{ prompt: string; negativePrompt: string }> {
  const system = `You are an expert AI image prompt engineer. Convert the user's idea (in Indonesian or English) into a vivid, high-detail English prompt for image generation in style "${styleLabel}".
Return ONLY valid JSON with keys "prompt" and "negativePrompt" (no markdown fences).`

  const raw = await runTextCompletion(profile, system, rawIdea)
  try {
    const cleaned = raw.replace(/^```json\s*/i, '').replace(/```$/i, '').trim()
    const parsed = JSON.parse(cleaned) as { prompt?: string; negativePrompt?: string }
    if (parsed.prompt) {
      return {
        prompt: parsed.prompt,
        negativePrompt:
          parsed.negativePrompt ||
          'blurry, lowres, jpeg artifacts, watermark, deformed hands, extra fingers, text',
      }
    }
  } catch {
    // Fallback if model returned plain text instead of JSON
  }
  return {
    prompt: raw,
    negativePrompt: 'blurry, lowres, jpeg artifacts, watermark, bad anatomy',
  }
}

export async function generateSvgWithLlm(
  profile: ApiProfile,
  prompt: string,
  width: number,
  height: number
): Promise<string> {
  const system = `You are a master vector artist. Generate a clean, rich, multi-layered SVG artwork for the user's description.
Rules:
- Output ONLY raw <svg ...>...</svg> markup, no markdown fences, no commentary.
- Set viewBox="0 0 ${width} ${height}" and width="${width}" height="${height}".
- Include gradients (<defs><linearGradient>...), atmospheric background, detailed foreground shapes, and clean colors.
- Do not use external image URLs or <script> tags.`

  const raw = await runTextCompletion(profile, system, prompt)
  const match = raw.match(/<svg[\s\S]*?<\/svg>/i)
  if (!match) {
    throw new Error('Model tidak mengembalikan markup <svg> yang valid')
  }
  return match[0].replace(/<script[\s\S]*?<\/script>/gi, '')
}

export async function svgMarkupToPngBlob(
  svgMarkup: string,
  width: number,
  height: number
): Promise<Blob> {
  const svgBlob = new Blob([svgMarkup], { type: 'image/svg+xml;charset=utf-8' })
  const url = URL.createObjectURL(svgBlob)
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const el = new Image()
      el.onload = () => resolve(el)
      el.onerror = () => reject(new Error('Gagal merender SVG dari model AI'))
      el.src = url
    })
    const canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = height
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('Canvas 2D gagal dibuat')
    ctx.drawImage(img, 0, 0, width, height)
    return await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('Gagal ekspor PNG'))), 'image/png')
    })
  } finally {
    URL.revokeObjectURL(url)
  }
}

async function dataUrlOrRemoteToBlob(src: string): Promise<Blob> {
  if (src.startsWith('data:')) {
    const res = await fetch(src)
    return await res.blob()
  }
  const { response: res } = await smartFetch(src)
  if (!res.ok) throw new Error(`Gagal mengambil hasil gambar (HTTP ${res.status})`)
  return await res.blob()
}

function base64ToBlob(b64: string, mime = 'image/png'): Blob {
  const bin = atob(b64)
  const arr = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) {
    arr[i] = bin.charCodeAt(i)
  }
  return new Blob([arr], { type: mime })
}

export async function generateImageWithProfile(
  profile: ApiProfile,
  prompt: string,
  options: { size: '1024x1024' | '1024x1792' | '1792x1024'; negativePrompt?: string }
): Promise<{ blob: Blob; mimeType: string; usedMode: string }> {
  const baseUrl = normalizeProviderBaseUrl(profile.baseUrl, profile.kind)
  if (!baseUrl) throw new Error('Base URL belum diisi di Pengaturan API Key')

  const fullPrompt = options.negativePrompt?.trim()
    ? `${prompt}\n\nAvoid: ${options.negativePrompt.trim()}`
    : prompt

  const mode =
    profile.imageEndpointMode === 'auto'
      ? profile.kind === 'gemini'
        ? 'gemini-native'
        : 'images-api'
      : profile.imageEndpointMode

  try {
    if (mode === 'gemini-native') {
      if (!profile.apiKey.trim()) throw new Error('API Key Gemini belum diisi')
      const model = profile.imageModel.trim() || 'gemini-2.0-flash-preview-image-generation'
      const { response: res } = await smartFetch(
        `${baseUrl}/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(profile.apiKey.trim())}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [{ role: 'user', parts: [{ text: fullPrompt }] }],
            generationConfig: {
              responseModalities: ['TEXT', 'IMAGE'],
            },
          }),
        }
      )
      if (!res.ok) {
        const txt = await res.text()
        throw new Error(`Gemini Image error (${res.status}): ${txt.slice(0, 240)}`)
      }
      const data = await parseFlexibleJson<{
        candidates?: Array<{
          content?: {
            parts?: Array<{
              inlineData?: { data: string; mimeType?: string }
            }>
          }
        }>
      }>(res)
      const parts = data.candidates?.[0]?.content?.parts || []
      const imgPart = parts.find((p) => p.inlineData?.data)
      if (!imgPart?.inlineData?.data) {
        throw new Error(
          'Model Gemini tidak mengembalikan gambar. Pastikan model yang dipilih mendukung output gambar (misal gemini-2.0-flash-preview-image-generation).'
        )
      }
      const mimeType = imgPart.inlineData.mimeType || 'image/png'
      return {
        blob: base64ToBlob(imgPart.inlineData.data, mimeType),
        mimeType,
        usedMode: 'Gemini Native Image',
      }
    }

    let imagesApiNote = ''

    if (mode === 'images-api') {
      const imageModel = profile.imageModel.trim() || 'dall-e-3'
      const payload: Record<string, unknown> = {
        model: imageModel,
        prompt: fullPrompt,
        size: options.size,
        n: 1,
      }
      if (/^dall-e/i.test(imageModel)) {
        payload.response_format = 'b64_json'
      }

      let { response: res } = await smartFetch(`${baseUrl}/images/generations`, {
        method: 'POST',
        headers: authHeaders(profile.apiKey),
        body: JSON.stringify(payload),
      })

      if (!res.ok && 'response_format' in payload) {
        delete payload.response_format
        const retry = await smartFetch(`${baseUrl}/images/generations`, {
          method: 'POST',
          headers: authHeaders(profile.apiKey),
          body: JSON.stringify(payload),
        })
        res = retry.response
      }

      if (res.ok) {
        const data = await parseFlexibleJson<{
          data?: Array<{ b64_json?: string; url?: string }>
          images?: Array<{ b64_json?: string; url?: string }>
        }>(res)
        const first = data.data?.[0] || data.images?.[0]
        if (first?.b64_json) {
          return {
            blob: base64ToBlob(first.b64_json, 'image/png'),
            mimeType: 'image/png',
            usedMode: '/v1/images/generations',
          }
        }
        if (first?.url) {
          const blob = await dataUrlOrRemoteToBlob(first.url)
          return {
            blob,
            mimeType: blob.type || 'image/png',
            usedMode: '/v1/images/generations',
          }
        }
      } else {
        const errTxt = await res.text()
        imagesApiNote = `/images/generations (${res.status}): ${errTxt.slice(0, 140)}`
        if (profile.imageEndpointMode === 'images-api') {
          throw new Error(`Images API error (${res.status}): ${errTxt.slice(0, 240)}`)
        }
      }
    }

    // Chat-multimodal image extraction fallback (for gateways/routers that return image URLs/base64 via chat)
    const { response: chatRes } = await smartFetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: authHeaders(profile.apiKey),
      body: JSON.stringify({
        model: profile.imageModel.trim() || profile.textModel.trim() || 'agnes-3.5',
        messages: [
          {
            role: 'user',
            content: `Generate an image (${options.size}): ${fullPrompt}`,
          },
        ],
        stream: false,
      }),
    })
    if (!chatRes.ok) {
      const errTxt = await chatRes.text()
      throw new Error(`Endpoint error (${chatRes.status}): ${errTxt.slice(0, 240)}`)
    }

    interface ChatPart {
      type?: string
      text?: string
      image_url?: { url?: string } | string
      url?: string
      b64_json?: string
      inlineData?: { data?: string; mimeType?: string }
      source?: { data?: string; media_type?: string }
    }

    const chatJson = await parseFlexibleJson<{
      choices?: Array<{
        message?: {
          content?: string | ChatPart[]
          images?: Array<{ image_url?: { url?: string }; url?: string; b64_json?: string } | string>
        }
      }>
    }>(chatRes)

    const msg = chatJson.choices?.[0]?.message
    const firstImgItem = msg?.images?.[0]
    if (typeof firstImgItem === 'string') {
      const blob = await dataUrlOrRemoteToBlob(firstImgItem)
      return { blob, mimeType: blob.type || 'image/png', usedMode: 'Chat Multimodal' }
    }
    if (firstImgItem?.b64_json) {
      return {
        blob: base64ToBlob(firstImgItem.b64_json, 'image/png'),
        mimeType: 'image/png',
        usedMode: 'Chat Multimodal',
      }
    }
    const inlineImgUrl = firstImgItem?.image_url?.url || firstImgItem?.url
    if (inlineImgUrl) {
      const blob = await dataUrlOrRemoteToBlob(inlineImgUrl)
      return { blob, mimeType: blob.type || 'image/png', usedMode: 'Chat Multimodal' }
    }

    // Handle array-structured multimodal message.content
    let textContent = ''
    if (Array.isArray(msg?.content)) {
      for (const part of msg.content) {
        if (part.inlineData?.data) {
          const mime = part.inlineData.mimeType || 'image/png'
          return {
            blob: base64ToBlob(part.inlineData.data, mime),
            mimeType: mime,
            usedMode: 'Chat InlineData',
          }
        }
        if (part.source?.data) {
          const mime = part.source.media_type || 'image/png'
          return {
            blob: base64ToBlob(part.source.data, mime),
            mimeType: mime,
            usedMode: 'Chat Source',
          }
        }
        if (part.b64_json) {
          return {
            blob: base64ToBlob(part.b64_json, 'image/png'),
            mimeType: 'image/png',
            usedMode: 'Chat Base64',
          }
        }
        const partUrl =
          typeof part.image_url === 'string'
            ? part.image_url
            : part.image_url?.url || part.url
        if (partUrl) {
          const blob = await dataUrlOrRemoteToBlob(partUrl)
          return { blob, mimeType: blob.type || 'image/png', usedMode: 'Chat Content Image' }
        }
        if (part.text) textContent += `${part.text}\n`
      }
    } else if (typeof msg?.content === 'string') {
      textContent = msg.content
    }

    const dataUrlMatch = textContent.match(/data:image\/[a-zA-Z0-9+.-]+;base64,[A-Za-z0-9+/=]+/)
    if (dataUrlMatch) {
      const blob = await dataUrlOrRemoteToBlob(dataUrlMatch[0])
      return { blob, mimeType: blob.type || 'image/png', usedMode: 'Chat Base64' }
    }

    const mdUrlMatch = textContent.match(/!\[[^\]]*\]\((https?:\/\/[^)\s]+)\)/)
    const rawUrlMatch = textContent.match(
      /https?:\/\/[^\s"'<>]+\.(?:png|jpe?g|webp)(?:\?[^\s"'<>]*)?/i
    )
    const imgUrl = mdUrlMatch?.[1] || rawUrlMatch?.[0]
    if (imgUrl) {
      const blob = await dataUrlOrRemoteToBlob(imgUrl)
      return { blob, mimeType: blob.type || 'image/png', usedMode: 'Chat Image URL' }
    }

    const replyPreview = textContent.trim().slice(0, 140)
    throw new Error(
      `Model "${profile.imageModel || profile.textModel}" tidak mengembalikan file gambar (model Vision/Chat hanya membaca gambar input dan membalas teks, berbeda dengan model Image-Generation seperti dall-e-3 / gpt-image-1 / flux / imagen). Untuk model teks/vision di 9Router, gunakan mode "Vector SVG (Non-Vision)" atau ganti Model Gambar ke model pembuat gambar.${imagesApiNote ? ` [Info ${imagesApiNote}]` : ''}${replyPreview ? ` [Balasan model: "${replyPreview}"]` : ''}`
    )
  } catch (err) {
    throw new Error(buildErrorMessage(err, baseUrl))
  }
}
