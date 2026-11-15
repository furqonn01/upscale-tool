import fs from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import path from 'node:path'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig, type Connect, type Plugin } from 'vite'

function attachOrtMiddleware(middlewares: Connect.Server, ortDist: string): void {
  const assetPrefix = 'ort-wasm-simd-threaded'
  middlewares.use('/ort/', (req, res, next) => {
    const cleanUrl = (req.url || '').split('?')[0].replace(/^\/+/, '')
    if (!cleanUrl.startsWith(assetPrefix)) {
      next()
      return
    }
    const filePath = path.join(ortDist, cleanUrl)
    if (!fs.existsSync(filePath)) {
      next()
      return
    }
    if (cleanUrl.endsWith('.wasm')) {
      res.setHeader('Content-Type', 'application/wasm')
    } else if (cleanUrl.endsWith('.mjs') || cleanUrl.endsWith('.js')) {
      res.setHeader('Content-Type', 'application/javascript')
    }
    fs.createReadStream(filePath).pipe(res)
  })
}

function attachLocalProxyMiddleware(middlewares: Connect.Server): void {
  middlewares.use('/_proxy', async (req: IncomingMessage, res: ServerResponse, next) => {
    if (req.method !== 'POST') {
      next()
      return
    }
    try {
      const chunks: Buffer[] = []
      for await (const chunk of req) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
      }
      const raw = Buffer.concat(chunks).toString('utf8')
      const payload = JSON.parse(raw) as {
        url?: string
        method?: string
        headers?: Record<string, string>
        body?: string
      }

      if (!payload.url || !/^https?:\/\//i.test(payload.url)) {
        res.statusCode = 400
        res.end('Invalid proxy target URL')
        return
      }

      const upstream = await fetch(payload.url, {
        method: payload.method || 'GET',
        headers: payload.headers,
        body: payload.body,
      })

      res.statusCode = upstream.status
      const contentType = upstream.headers.get('content-type')
      if (contentType) res.setHeader('Content-Type', contentType)
      res.setHeader('X-Proxy-Used', 'vite-local')

      const arrayBuf = await upstream.arrayBuffer()
      res.end(Buffer.from(arrayBuf))
    } catch (err) {
      res.statusCode = 502
      res.setHeader('Content-Type', 'application/json')
      res.end(
        JSON.stringify({
          error: err instanceof Error ? err.message : 'Local proxy request failed',
        })
      )
    }
  })
}

function onnxRuntimeAssetsPlugin(): Plugin {
  const ortDist = path.resolve(import.meta.dirname, 'node_modules/onnxruntime-web/dist')
  const assetPrefix = 'ort-wasm-simd-threaded'

  return {
    name: 'onnxruntime-assets',
    configureServer(server) {
      attachOrtMiddleware(server.middlewares, ortDist)
      attachLocalProxyMiddleware(server.middlewares)
    },
    configurePreviewServer(server) {
      attachOrtMiddleware(server.middlewares, ortDist)
      attachLocalProxyMiddleware(server.middlewares)
    },
    writeBundle(options) {
      const outDir = options.dir || path.resolve(import.meta.dirname, 'dist')
      const targetDir = path.join(outDir, 'ort')
      fs.mkdirSync(targetDir, { recursive: true })
      if (!fs.existsSync(ortDist)) return
      for (const file of fs.readdirSync(ortDist)) {
        if (file.startsWith(assetPrefix) && (file.endsWith('.wasm') || file.endsWith('.mjs'))) {
          fs.copyFileSync(path.join(ortDist, file), path.join(targetDir, file))
        }
      }
    },
  }
}

export default defineConfig({
  plugins: [react(), tailwindcss(), onnxRuntimeAssetsPlugin()],
  worker: {
    format: 'es',
  },
  optimizeDeps: {
    exclude: ['onnxruntime-web'],
  },
})
