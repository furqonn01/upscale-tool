import type { OutputImageFormat, ProgressInfo } from '../types'

const VERTEX_SHADER = `#version 300 es
in vec2 aPos;
uniform float uFlipY;
out vec2 vUv;
void main() {
  vUv = vec2(aPos.x * 0.5 + 0.5, uFlipY > 0.5 ? (0.5 - aPos.y * 0.5) : (aPos.y * 0.5 + 0.5));
  gl_Position = vec4(aPos, 0.0, 1.0);
}
`

// Pass 1: Edge-preserving Bilateral De-burik Denoise + JPEG Block-Artifact Smoothing
const DEBURIK_FRAGMENT_SHADER = `#version 300 es
precision highp float;
in vec2 vUv;
uniform sampler2D uTex;
uniform vec2 uTexelSize;
uniform float uDenoise;
uniform float uDeblock;
out vec4 fragColor;

float luma(vec3 c) {
  return dot(c, vec3(0.299, 0.587, 0.114));
}

void main() {
  vec4 center = texture(uTex, vUv);
  float centerLuma = luma(center.rgb);

  // Adaptive bilateral filter to clean "burik" noise while keeping edges intact
  float spatialSigma = mix(0.8, 2.2, uDenoise);
  float rangeSigma = mix(0.025, 0.16, max(uDenoise, uDeblock * 0.85));
  float invRange2 = 1.0 / (2.0 * rangeSigma * rangeSigma);
  float invSpatial2 = 1.0 / (2.0 * spatialSigma * spatialSigma);

  vec3 sum = vec3(0.0);
  float weightSum = 0.0;

  for (int y = -2; y <= 2; y++) {
    for (int x = -2; x <= 2; x++) {
      vec2 offset = vec2(float(x), float(y)) * uTexelSize;
      vec3 sampleRgb = texture(uTex, clamp(vUv + offset, 0.0, 1.0)).rgb;
      float dLuma = luma(sampleRgb) - centerLuma;
      float dColor = length(sampleRgb - center.rgb);
      float dist2 = float(x * x + y * y);

      float wSpatial = exp(-dist2 * invSpatial2);
      float wRange = exp(-(dLuma * dLuma + dColor * dColor * 0.35) * invRange2);
      float w = wSpatial * wRange;
      sum += sampleRgb * w;
      weightSum += w;
    }
  }

  vec3 denoised = sum / max(weightSum, 0.0001);

  // Subtle deblocking across wider 2-texel stride for compressed JPEG/video macroblocks
  vec3 wide = (
    texture(uTex, clamp(vUv + vec2(-2.0, 0.0) * uTexelSize, 0.0, 1.0)).rgb +
    texture(uTex, clamp(vUv + vec2( 2.0, 0.0) * uTexelSize, 0.0, 1.0)).rgb +
    texture(uTex, clamp(vUv + vec2(0.0, -2.0) * uTexelSize, 0.0, 1.0)).rgb +
    texture(uTex, clamp(vUv + vec2(0.0,  2.0) * uTexelSize, 0.0, 1.0)).rgb
  ) * 0.25;

  float diffWide = length(wide - denoised);
  float deblockMask = smoothstep(0.14, 0.01, diffWide) * uDeblock * 0.45;
  vec3 result = mix(denoised, mix(denoised, wide, 0.5), deblockMask);
  vec3 finalRgb = mix(center.rgb, result, clamp(max(uDenoise, uDeblock), 0.0, 1.0));

  fragColor = vec4(finalRgb, center.a);
}
`

// Pass 2: Catmull-Rom Cubic Upscale + Adaptive Edge-Aware Sharpening + Micro-Contrast Clarity
const UPSCALE_SHARPEN_FRAGMENT_SHADER = `#version 300 es
precision highp float;
in vec2 vUv;
uniform sampler2D uTex;
uniform vec2 uSrcSize;
uniform vec2 uDstTexelSize;
uniform float uSharpen;
uniform float uClarity;
out vec4 fragColor;

vec4 cubicWeight(float v) {
  vec4 n = vec4(1.0, 2.0, 3.0, 4.0) - v;
  vec4 s = n * n * n;
  float x = s.x;
  float y = s.y - 4.0 * s.x;
  float z = s.z - 4.0 * s.y + 6.0 * s.x;
  float w = 6.0 - x - y - z;
  return vec4(x, y, z, w) * (1.0 / 6.0);
}

// High-quality 4-tap Catmull-Rom / B-Spline bicubic sampler
vec4 sampleBicubic(sampler2D tex, vec2 uv, vec2 texSize) {
  vec2 invSize = 1.0 / texSize;
  vec2 coords = uv * texSize - 0.5;
  vec2 fxy = fract(coords);
  coords -= fxy;

  vec4 xcubic = cubicWeight(fxy.x);
  vec4 ycubic = cubicWeight(fxy.y);

  vec4 c = coords.xxyy + vec2(-0.5, 1.5).xyxy;
  vec4 s = vec4(xcubic.xz + xcubic.yw, ycubic.xz + ycubic.yw);
  vec4 offset = c + vec4(xcubic.yw, ycubic.yw) / s;
  offset *= invSize.xxyy;

  vec4 s0 = texture(tex, clamp(offset.xz, 0.0, 1.0));
  vec4 s1 = texture(tex, clamp(offset.yz, 0.0, 1.0));
  vec4 s2 = texture(tex, clamp(offset.xw, 0.0, 1.0));
  vec4 s3 = texture(tex, clamp(offset.yw, 0.0, 1.0));

  float sx = s.x / (s.x + s.y);
  float sy = s.z / (s.z + s.w);

  return mix(mix(s3, s2, sx), mix(s1, s0, sx), sy);
}

float luma(vec3 c) {
  return dot(c, vec3(0.299, 0.587, 0.114));
}

void main() {
  vec4 center = sampleBicubic(uTex, vUv, uSrcSize);

  // Edge-aware CAS-inspired sharpening in destination resolution space
  vec2 d = uDstTexelSize * 1.15;
  vec3 n  = sampleBicubic(uTex, vUv + vec2( 0.0, -d.y), uSrcSize).rgb;
  vec3 s  = sampleBicubic(uTex, vUv + vec2( 0.0,  d.y), uSrcSize).rgb;
  vec3 e  = sampleBicubic(uTex, vUv + vec2( d.x,  0.0), uSrcSize).rgb;
  vec3 w  = sampleBicubic(uTex, vUv + vec2(-d.x,  0.0), uSrcSize).rgb;

  vec3 minNbr = min(min(n, s), min(e, w));
  vec3 maxNbr = max(max(n, s), max(e, w));

  // Local contrast adaptive weight (prevents ringing/halos on flat areas & harsh edges)
  vec3 blur = (n + s + e + w) * 0.25;
  vec3 highPass = center.rgb - blur;
  float edgeEnergy = clamp(length(maxNbr - minNbr) * 2.5, 0.0, 1.0);
  float sharpAmount = mix(0.0, 1.65, uSharpen) * (0.35 + 0.65 * (1.0 - edgeEnergy * 0.5));

  vec3 sharpened = clamp(center.rgb + highPass * sharpAmount, minNbr - 0.06, maxNbr + 0.06);

  // Clarity (local tonal micro-contrast) + gentle natural vibrance
  vec2 wideD = uDstTexelSize * 4.5;
  vec3 wideAvg = (
    texture(uTex, clamp(vUv + vec2(-wideD.x, -wideD.y), 0.0, 1.0)).rgb +
    texture(uTex, clamp(vUv + vec2( wideD.x, -wideD.y), 0.0, 1.0)).rgb +
    texture(uTex, clamp(vUv + vec2(-wideD.x,  wideD.y), 0.0, 1.0)).rgb +
    texture(uTex, clamp(vUv + vec2( wideD.x,  wideD.y), 0.0, 1.0)).rgb
  ) * 0.25;

  vec3 clarityRgb = sharpened + (sharpened - wideAvg) * (uClarity * 0.35);

  // Subtle highlight/shadow balance
  float y = luma(clarityRgb);
  float satBoost = 1.0 + uClarity * 0.08;
  vec3 finalRgb = mix(vec3(y), clarityRgb, satBoost);

  fragColor = vec4(clamp(finalRgb, 0.0, 1.0), center.a);
}
`

function compileShader(gl: WebGL2RenderingContext, type: number, source: string): WebGLShader {
  const shader = gl.createShader(type)
  if (!shader) throw new Error('Gagal membuat WebGL shader')
  gl.shaderSource(shader, source)
  gl.compileShader(shader)
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const info = gl.getShaderInfoLog(shader) || 'Unknown shader compile error'
    gl.deleteShader(shader)
    throw new Error(`Shader error: ${info}`)
  }
  return shader
}

function createProgram(gl: WebGL2RenderingContext, fragSource: string): WebGLProgram {
  const vs = compileShader(gl, gl.VERTEX_SHADER, VERTEX_SHADER)
  const fs = compileShader(gl, gl.FRAGMENT_SHADER, fragSource)
  const prog = gl.createProgram()
  if (!prog) throw new Error('Gagal membuat WebGL program')
  gl.attachShader(prog, vs)
  gl.attachShader(prog, fs)
  gl.linkProgram(prog)
  gl.deleteShader(vs)
  gl.deleteShader(fs)
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
    const info = gl.getProgramInfoLog(prog) || 'Unknown program link error'
    gl.deleteProgram(prog)
    throw new Error(`Program link error: ${info}`)
  }
  return prog
}

export interface RestorationParams {
  denoise: number // 0 - 100
  deblock: number // 0 - 100
  sharpen: number // 0 - 100
  clarity: number // 0 - 100
}

export class WebGLRestorationPipeline {
  readonly canvas: HTMLCanvasElement
  private gl: WebGL2RenderingContext
  private deburikProgram: WebGLProgram
  private upscaleProgram: WebGLProgram
  private vao: WebGLVertexArrayObject
  private vbo: WebGLBuffer
  private srcTex: WebGLTexture
  private midTex: WebGLTexture
  private midFbo: WebGLFramebuffer
  private midWidth = 0
  private midHeight = 0

  constructor(canvas?: HTMLCanvasElement) {
    this.canvas = canvas ?? document.createElement('canvas')
    const gl = this.canvas.getContext('webgl2', {
      alpha: true,
      antialias: false,
      depth: false,
      stencil: false,
      preserveDrawingBuffer: true,
      powerPreference: 'high-performance',
    })
    if (!gl) {
      throw new Error('WebGL2 tidak tersedia di browser ini')
    }
    this.gl = gl
    this.deburikProgram = createProgram(gl, DEBURIK_FRAGMENT_SHADER)
    this.upscaleProgram = createProgram(gl, UPSCALE_SHARPEN_FRAGMENT_SHADER)

    const vao = gl.createVertexArray()
    const vbo = gl.createBuffer()
    if (!vao || !vbo) throw new Error('Gagal alokasi buffer WebGL2')
    this.vao = vao
    this.vbo = vbo

    gl.bindVertexArray(vao)
    gl.bindBuffer(gl.ARRAY_BUFFER, vbo)
    gl.bufferData(
      gl.ARRAY_BUFFER,
      new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]),
      gl.STATIC_DRAW
    )

    for (const prog of [this.deburikProgram, this.upscaleProgram]) {
      const loc = gl.getAttribLocation(prog, 'aPos')
      gl.enableVertexAttribArray(loc)
      gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0)
    }

    const srcTex = gl.createTexture()
    const midTex = gl.createTexture()
    const midFbo = gl.createFramebuffer()
    if (!srcTex || !midTex || !midFbo) throw new Error('Gagal alokasi tekstur WebGL2')
    this.srcTex = srcTex
    this.midTex = midTex
    this.midFbo = midFbo

    for (const tex of [srcTex, midTex]) {
      gl.bindTexture(gl.TEXTURE_2D, tex)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
    }
  }

  private ensureMidTarget(w: number, h: number): void {
    const gl = this.gl
    if (this.midWidth === w && this.midHeight === h) return
    this.midWidth = w
    this.midHeight = h
    gl.bindTexture(gl.TEXTURE_2D, this.midTex)
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null)
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.midFbo)
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.midTex, 0)
    const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER)
    gl.bindFramebuffer(gl.FRAMEBUFFER, null)
    if (status !== gl.FRAMEBUFFER_COMPLETE) {
      throw new Error(`Framebuffer WebGL2 tidak lengkap (${status})`)
    }
  }

  render(
    source: TexImageSource,
    srcWidth: number,
    srcHeight: number,
    dstWidth: number,
    dstHeight: number,
    params: RestorationParams
  ): void {
    const gl = this.gl
    if (gl.isContextLost()) {
      throw new Error('Konteks GPU WebGL2 terputus')
    }
    if (this.canvas.width !== dstWidth) this.canvas.width = dstWidth
    if (this.canvas.height !== dstHeight) this.canvas.height = dstHeight

    this.ensureMidTarget(srcWidth, srcHeight)

    gl.bindVertexArray(this.vao)
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, 0)

    // Upload source frame/image
    gl.activeTexture(gl.TEXTURE0)
    gl.bindTexture(gl.TEXTURE_2D, this.srcTex)
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source)

    // Pass 1: De-burik denoise + deblock -> midFbo
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.midFbo)
    gl.viewport(0, 0, srcWidth, srcHeight)
    gl.useProgram(this.deburikProgram)
    gl.uniform1i(gl.getUniformLocation(this.deburikProgram, 'uTex'), 0)
    gl.uniform1f(gl.getUniformLocation(this.deburikProgram, 'uFlipY'), 0.0)
    gl.uniform2f(
      gl.getUniformLocation(this.deburikProgram, 'uTexelSize'),
      1 / srcWidth,
      1 / srcHeight
    )
    gl.uniform1f(gl.getUniformLocation(this.deburikProgram, 'uDenoise'), params.denoise / 100)
    gl.uniform1f(gl.getUniformLocation(this.deburikProgram, 'uDeblock'), params.deblock / 100)
    gl.drawArrays(gl.TRIANGLES, 0, 6)

    // Pass 2: Bicubic Upscale + Edge-Aware Sharpen + Clarity -> Canvas
    gl.bindFramebuffer(gl.FRAMEBUFFER, null)
    gl.viewport(0, 0, dstWidth, dstHeight)
    gl.bindTexture(gl.TEXTURE_2D, this.midTex)
    gl.useProgram(this.upscaleProgram)
    gl.uniform1i(gl.getUniformLocation(this.upscaleProgram, 'uTex'), 0)
    gl.uniform1f(gl.getUniformLocation(this.upscaleProgram, 'uFlipY'), 1.0)
    gl.uniform2f(gl.getUniformLocation(this.upscaleProgram, 'uSrcSize'), srcWidth, srcHeight)
    gl.uniform2f(
      gl.getUniformLocation(this.upscaleProgram, 'uDstTexelSize'),
      1 / dstWidth,
      1 / dstHeight
    )
    gl.uniform1f(gl.getUniformLocation(this.upscaleProgram, 'uSharpen'), params.sharpen / 100)
    gl.uniform1f(gl.getUniformLocation(this.upscaleProgram, 'uClarity'), params.clarity / 100)
    gl.drawArrays(gl.TRIANGLES, 0, 6)
  }

  dispose(): void {
    const gl = this.gl
    gl.deleteTexture(this.srcTex)
    gl.deleteTexture(this.midTex)
    gl.deleteFramebuffer(this.midFbo)
    gl.deleteBuffer(this.vbo)
    gl.deleteVertexArray(this.vao)
    gl.deleteProgram(this.deburikProgram)
    gl.deleteProgram(this.upscaleProgram)
  }
}

export async function upscaleImageWithWebGL(
  bitmap: ImageBitmap,
  scale: 2 | 3 | 4,
  params: RestorationParams,
  maxTextureSize: number,
  isMobile: boolean,
  outputFormat: OutputImageFormat,
  onProgress?: (p: ProgressInfo) => void
): Promise<{ blob: Blob; width: number; height: number }> {
  const srcW = bitmap.width
  const srcH = bitmap.height
  const dstW = Math.round(srcW * scale)
  const dstH = Math.round(srcH * scale)

  const maxDim = isMobile ? 4096 : 8192
  const maxPixels = isMobile ? 16_000_000 : 48_000_000
  if (dstW > maxDim || dstH > maxDim || dstW * dstH > maxPixels) {
    throw new Error(
      `Ukuran hasil ${dstW}×${dstH} melebihi batas memori canvas browser (${isMobile ? 'HP' : 'Laptop'}). Pilih skala 2× atau kecilkan foto sumber.`
    )
  }

  onProgress?.({
    percent: 25,
    stage: 'Menjalankan restorasi GPU WebGL2...',
    detail: `${srcW}×${srcH} → ${dstW}×${dstH}`,
  })

  // Keep each WebGL render target <= 2048px so mobile & laptop GPUs never lose context or turn black
  const safeLimit = Math.min(maxTextureSize, 2048)
  if (dstW <= safeLimit && dstH <= safeLimit) {
    const pipeline = new WebGLRestorationPipeline()
    try {
      pipeline.render(bitmap, srcW, srcH, dstW, dstH, params)
      onProgress?.({ percent: 85, stage: 'Mengemas file hasil...' })
      const blob = await canvasToBlob(pipeline.canvas, outputFormat)
      return { blob, width: dstW, height: dstH }
    } finally {
      pipeline.dispose()
    }
  }

  // Large resolution fallback: tile source patches into a final 2D canvas
  const outCanvas = document.createElement('canvas')
  outCanvas.width = dstW
  outCanvas.height = dstH
  const outCtx = outCanvas.getContext('2d')
  if (!outCtx) throw new Error('Gagal membuat canvas output')

  const tileSrc = Math.max(256, Math.floor(safeLimit / scale) - 32)
  const pad = 16
  const cols = Math.ceil(srcW / tileSrc)
  const rows = Math.ceil(srcH / tileSrc)
  const totalTiles = cols * rows

  const tileCanvas = document.createElement('canvas')
  const tileCtx = tileCanvas.getContext('2d')
  if (!tileCtx) throw new Error('Gagal membuat tile canvas')

  const pipeline = new WebGLRestorationPipeline()
  try {
    let done = 0
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const sx = c * tileSrc
        const sy = r * tileSrc
        const sw = Math.min(tileSrc, srcW - sx)
        const sh = Math.min(tileSrc, srcH - sy)

        const px0 = Math.max(0, sx - pad)
        const py0 = Math.max(0, sy - pad)
        const px1 = Math.min(srcW, sx + sw + pad)
        const py1 = Math.min(srcH, sy + sh + pad)
        const pw = px1 - px0
        const ph = py1 - py0

        tileCanvas.width = pw
        tileCanvas.height = ph
        tileCtx.clearRect(0, 0, pw, ph)
        tileCtx.drawImage(bitmap, px0, py0, pw, ph, 0, 0, pw, ph)

        pipeline.render(tileCanvas, pw, ph, pw * scale, ph * scale, params)

        const cropX = (sx - px0) * scale
        const cropY = (sy - py0) * scale
        outCtx.drawImage(
          pipeline.canvas,
          cropX,
          cropY,
          sw * scale,
          sh * scale,
          sx * scale,
          sy * scale,
          sw * scale,
          sh * scale
        )

        done++
        onProgress?.({
          percent: 20 + Math.round((done / totalTiles) * 70),
          stage: `Memproses tile GPU (${done}/${totalTiles})`,
        })
        await new Promise((res) => setTimeout(res, 0))
      }
    }
    onProgress?.({ percent: 94, stage: 'Menyimpan gambar HD...' })
    const blob = await canvasToBlob(outCanvas, outputFormat)
    return { blob, width: dstW, height: dstH }
  } finally {
    pipeline.dispose()
  }
}

export function canvasToBlob(canvas: HTMLCanvasElement, format: OutputImageFormat): Promise<Blob> {
  return new Promise((resolve, reject) => {
    const quality = format === 'image/png' ? undefined : 0.94
    canvas.toBlob(
      (blob) => {
        if (blob) resolve(blob)
        else reject(new Error('Gagal mengonversi canvas ke file gambar'))
      },
      format,
      quality
    )
  })
}
