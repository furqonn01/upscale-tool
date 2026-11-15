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

// Pass 1 (at source resolution): Fast YCbCr-aware JPEG deblocking & detail-preserving denoise (13 taps, no exp)
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
  float cY = luma(center.rgb);
  vec2 cChroma = center.rg - vec2(cY);
  float cB = center.b - cY;

  // Rational bilateral weights (4x faster than exp() on mobile GPUs while keeping crisp edges)
  float lumaSigma = mix(0.018, 0.095, uDenoise);
  float invLumaVar = 1.0 / max(lumaSigma * lumaSigma, 0.0001);
  float chromaSigma = mix(0.04, 0.22, max(uDenoise, uDeblock));
  float invChromaVar = 1.0 / max(chromaSigma * chromaSigma, 0.0001);

  float sumY = cY;
  float wSumY = 1.0;
  vec3 sumC = center.rgb;
  float wSumC = 1.0;

  float minY = cY;
  float maxY = cY;

  for (int dy = -1; dy <= 1; dy++) {
    for (int dx = -1; dx <= 1; dx++) {
      if (dx == 0 && dy == 0) continue;
      vec2 uv = clamp(vUv + vec2(float(dx), float(dy)) * uTexelSize, 0.0, 1.0);
      vec3 s = texture(uTex, uv).rgb;
      float sY = luma(s);
      minY = min(minY, sY);
      maxY = max(maxY, sY);

      float dY = sY - cY;
      float spatial = (dx == 0 || dy == 0) ? 0.72 : 0.48;
      float wY = spatial / (1.0 + dY * dY * invLumaVar);
      sumY += sY * wY;
      wSumY += wY;

      vec2 sChroma = s.rg - vec2(sY);
      float sB = s.b - sY;
      float dCh = dot(sChroma - cChroma, sChroma - cChroma) + (sB - cB) * (sB - cB);
      float wC = spatial / (1.0 + dCh * invChromaVar + dY * dY * invChromaVar * 0.35);
      sumC += s * wC;
      wSumC += wC;
    }
  }

  float cleanY = sumY / wSumY;
  vec3 cleanChromaRgb = sumC / wSumC;
  float cleanChromaY = luma(cleanChromaRgb);
  // Recombine crisp luma with smoothed chroma to kill JPEG color blocking without blurring edges
  vec3 denoised = clamp(cleanChromaRgb + vec3(cleanY - cleanChromaY), 0.0, 1.0);

  // Targeted 2-texel cross deblock ONLY on flat regions (high-contrast edges remain untouched)
  float localRange = maxY - minY;
  float flatMask = smoothstep(0.16, 0.015, localRange) * uDeblock;
  if (flatMask > 0.005) {
    vec3 w0 = texture(uTex, clamp(vUv + vec2(-2.0, 0.0) * uTexelSize, 0.0, 1.0)).rgb;
    vec3 w1 = texture(uTex, clamp(vUv + vec2( 2.0, 0.0) * uTexelSize, 0.0, 1.0)).rgb;
    vec3 w2 = texture(uTex, clamp(vUv + vec2(0.0, -2.0) * uTexelSize, 0.0, 1.0)).rgb;
    vec3 w3 = texture(uTex, clamp(vUv + vec2(0.0,  2.0) * uTexelSize, 0.0, 1.0)).rgb;
    vec3 wideAvg = (w0 + w1 + w2 + w3) * 0.25;
    float wideDiff = abs(luma(wideAvg) - cleanY);
    float blockWeight = flatMask * smoothstep(0.12, 0.008, wideDiff) * 0.42;
    denoised = mix(denoised, wideAvg, blockWeight);
  }

  float blend = clamp(max(uDenoise, uDeblock * 0.85), 0.0, 1.0);
  fragColor = vec4(mix(center.rgb, denoised, blend), center.a);
}
`

// Pass 2 (at target resolution): FSR-inspired 12-tap Edge-Adaptive Directional Lanczos2 Super-Resolution + Anti-Ringing
const EASU_UPSCALE_FRAGMENT_SHADER = `#version 300 es
precision highp float;
in vec2 vUv;
uniform sampler2D uTex;
uniform vec2 uSrcSize;
uniform vec2 uSrcInvSize;
out vec4 fragColor;

float luma(vec3 c) {
  return dot(c, vec3(0.299, 0.587, 0.114));
}

vec4 fetchSrc(vec2 coord) {
  vec2 uv = clamp((coord + 0.5) * uSrcInvSize, 0.5 * uSrcInvSize, 1.0 - 0.5 * uSrcInvSize);
  return texture(uTex, uv);
}

// Fast negative-lobe Lanczos2 polynomial approximation (zero trig, exact zero at d2=1 and d2=4)
float easuWeight(float d2, float clp) {
  float d2c = min(d2, clp);
  float wB = 0.4 * d2c - 1.0;
  float wA = 1.0 - 0.25 * d2c;
  return (1.5625 * wB * wB - 0.5625) * (wA * wA);
}

void accumTap(
  vec2 off,
  vec2 dir,
  vec2 invScale,
  float clp,
  vec3 color,
  inout vec3 acc,
  inout float wSum
) {
  float u = off.x * dir.x + off.y * dir.y;
  float v = off.x * (-dir.y) + off.y * dir.x;
  float d2 = u * u * invScale.x + v * v * invScale.y;
  float w = easuWeight(d2, clp);
  acc += color * w;
  wSum += w;
}

void main() {
  vec2 pp = vUv * uSrcSize - 0.5;
  vec2 fp = floor(pp);
  vec2 f = pp - fp;

  // 12-tap cross neighborhood around the 2x2 center (f, g, j, k)
  vec3 b = fetchSrc(fp + vec2( 0.0, -1.0)).rgb;
  vec3 c = fetchSrc(fp + vec2( 1.0, -1.0)).rgb;
  vec3 e = fetchSrc(fp + vec2(-1.0,  0.0)).rgb;
  vec4 f4 = fetchSrc(fp + vec2( 0.0,  0.0));
  vec4 g4 = fetchSrc(fp + vec2( 1.0,  0.0));
  vec3 h = fetchSrc(fp + vec2( 2.0,  0.0)).rgb;
  vec3 i = fetchSrc(fp + vec2(-1.0,  1.0)).rgb;
  vec4 j4 = fetchSrc(fp + vec2( 0.0,  1.0));
  vec4 k4 = fetchSrc(fp + vec2( 1.0,  1.0));
  vec3 l = fetchSrc(fp + vec2( 2.0,  1.0)).rgb;
  vec3 n = fetchSrc(fp + vec2( 0.0,  2.0)).rgb;
  vec3 o = fetchSrc(fp + vec2( 1.0,  2.0)).rgb;

  vec3 f3 = f4.rgb;
  vec3 g3 = g4.rgb;
  vec3 j3 = j4.rgb;
  vec3 k3 = k4.rgb;

  float lB = luma(b), lC = luma(c);
  float lE = luma(e), lF = luma(f3), lG = luma(g3), lH = luma(h);
  float lI = luma(i), lJ = luma(j3), lK = luma(k3), lL = luma(l);
  float lN = luma(n), lO = luma(o);

  // Estimate dominant edge direction & anisotropy across the 2x2 bilinear cell
  float w00 = (1.0 - f.x) * (1.0 - f.y);
  float w10 = f.x * (1.0 - f.y);
  float w01 = (1.0 - f.x) * f.y;
  float w11 = f.x * f.y;

  vec2 d00 = vec2(lG - lE, lJ - lB);
  vec2 d10 = vec2(lH - lF, lK - lC);
  vec2 d01 = vec2(lK - lI, lN - lF);
  vec2 d11 = vec2(lL - lJ, lO - lG);

  // Gradient points across edge; rotate 90deg to get edge tangent
  vec2 grad = d00 * w00 + d10 * w10 + d01 * w01 + d11 * w11;
  float gradLen2 = dot(grad, grad);

  vec2 dir = vec2(1.0, 0.0);
  float aniso = 0.0;
  if (gradLen2 > 1e-6) {
    vec2 gNorm = grad * inversesqrt(gradLen2);
    dir = vec2(-gNorm.y, gNorm.x);

    // Measure directional coherence (high when clean edge, low on isotropic noise/flat)
    float gx = abs(lG - lE) + abs(lK - lI);
    float gy = abs(lJ - lB) + abs(lK - lC);
    float edgeRatio = abs(gx - gy) / max(gx + gy, 0.001);
    aniso = clamp(sqrt(gradLen2) * 2.2 * (0.45 + 0.55 * edgeRatio), 0.0, 1.0);
  }

  // Stretch kernel along the edge and tighten across the edge for crisp diagonal lines
  float stretch = 1.0 + aniso * 0.55;
  float tight = 1.0 - aniso * 0.28;
  vec2 invScale = vec2(1.0 / (stretch * stretch), 1.0 / (tight * tight));
  float clp = 2.65;

  vec3 acc = vec3(0.0);
  float wSum = 0.0;

  accumTap(vec2( 0.0, -1.0) - f, dir, invScale, clp, b,  acc, wSum);
  accumTap(vec2( 1.0, -1.0) - f, dir, invScale, clp, c,  acc, wSum);
  accumTap(vec2(-1.0,  0.0) - f, dir, invScale, clp, e,  acc, wSum);
  accumTap(vec2( 0.0,  0.0) - f, dir, invScale, clp, f3, acc, wSum);
  accumTap(vec2( 1.0,  0.0) - f, dir, invScale, clp, g3, acc, wSum);
  accumTap(vec2( 2.0,  0.0) - f, dir, invScale, clp, h,  acc, wSum);
  accumTap(vec2(-1.0,  1.0) - f, dir, invScale, clp, i,  acc, wSum);
  accumTap(vec2( 0.0,  1.0) - f, dir, invScale, clp, j3, acc, wSum);
  accumTap(vec2( 1.0,  1.0) - f, dir, invScale, clp, k3, acc, wSum);
  accumTap(vec2( 2.0,  1.0) - f, dir, invScale, clp, l,  acc, wSum);
  accumTap(vec2( 0.0,  2.0) - f, dir, invScale, clp, n,  acc, wSum);
  accumTap(vec2( 1.0,  2.0) - f, dir, invScale, clp, o,  acc, wSum);

  vec3 bilinearRgb = f3 * w00 + g3 * w10 + j3 * w01 + k3 * w11;
  vec3 upscaled = abs(wSum) > 1e-4 ? (acc / wSum) : bilinearRgb;

  // Strict anti-ringing clamp to the 2x2 local source min/max
  vec3 min2x2 = min(min(f3, g3), min(j3, k3));
  vec3 max2x2 = max(max(f3, g3), max(j3, k3));
  vec3 finalRgb = clamp(upscaled, min2x2, max2x2);

  float finalAlpha = f4.a * w00 + g4.a * w10 + j4.a * w01 + k4.a * w11;
  fragColor = vec4(clamp(finalRgb, 0.0, 1.0), finalAlpha);
}
`

// Pass 3 (at target resolution): RCAS (Robust Contrast-Adaptive Sharpening) + Micro-Clarity & Natural Vibrance
const RCAS_CLARITY_FRAGMENT_SHADER = `#version 300 es
precision highp float;
in vec2 vUv;
uniform sampler2D uTex;
uniform vec2 uDstTexelSize;
uniform float uSharpen;
uniform float uClarity;
out vec4 fragColor;

float luma(vec3 c) {
  return dot(c, vec3(0.299, 0.587, 0.114));
}

void main() {
  vec4 center4 = texture(uTex, vUv);
  vec3 e = center4.rgb;

  vec3 n = texture(uTex, clamp(vUv + vec2( 0.0, -uDstTexelSize.y), 0.0, 1.0)).rgb;
  vec3 s = texture(uTex, clamp(vUv + vec2( 0.0,  uDstTexelSize.y), 0.0, 1.0)).rgb;
  vec3 w = texture(uTex, clamp(vUv + vec2(-uDstTexelSize.x,  0.0), 0.0, 1.0)).rgb;
  vec3 r = texture(uTex, clamp(vUv + vec2( uDstTexelSize.x,  0.0), 0.0, 1.0)).rgb;

  // Robust Contrast-Adaptive Sharpening (RCAS): strong crispness without halos or clipping
  float eL = luma(e);
  float nL = luma(n);
  float sL = luma(s);
  float wL = luma(w);
  float rL = luma(r);

  float mn4L = min(min(nL, sL), min(wL, rL));
  float mx4L = max(max(nL, sL), max(wL, rL));

  float mnL = min(mn4L, eL);
  float mxL = max(mx4L, eL);

  float hitMin = mnL / max(4.0 * mx4L, 1e-4);
  float hitMax = (mxL - 1.0) / min(4.0 * mn4L - 4.0, -1e-4);
  float lobe = max(-hitMin, hitMax);

  // Max negative lobe 0.21 gives up to ~5x crisp local edge boost where safe
  float maxLobe = mix(0.0, 0.21, uSharpen);
  float weight = clamp(lobe, -maxLobe, 0.0);

  // Noise suppression: slightly attenuate sharpening on near-zero micro-noise
  float contrastSpan = mx4L - mn4L;
  weight *= smoothstep(0.005, 0.04, contrastSpan);

  vec3 rcas = (e + weight * (n + s + w + r)) / max(1.0 + 4.0 * weight, 0.08);
  rcas = clamp(rcas, 0.0, 1.0);

  // Local micro-contrast clarity + natural vibrance using 4 diagonal taps at 2.8px radius
  vec3 finalRgb = rcas;
  if (uClarity > 0.005) {
    vec2 wideD = uDstTexelSize * 2.8;
    vec3 c0 = texture(uTex, clamp(vUv + vec2(-wideD.x, -wideD.y), 0.0, 1.0)).rgb;
    vec3 c1 = texture(uTex, clamp(vUv + vec2( wideD.x, -wideD.y), 0.0, 1.0)).rgb;
    vec3 c2 = texture(uTex, clamp(vUv + vec2(-wideD.x,  wideD.y), 0.0, 1.0)).rgb;
    vec3 c3 = texture(uTex, clamp(vUv + vec2( wideD.x,  wideD.y), 0.0, 1.0)).rgb;
    vec3 wideAvg = (c0 + c1 + c2 + c3) * 0.25;

    // Soft-clamped detail contrast so clarity pops without blowing out highlights
    vec3 detail = clamp(rcas - wideAvg, -0.22, 0.22);
    finalRgb = clamp(rcas + detail * (uClarity * 0.42), 0.0, 1.0);

    // Natural vibrance: lifts muted colors slightly more than already saturated colors
    float maxC = max(finalRgb.r, max(finalRgb.g, finalRgb.b));
    float minC = min(finalRgb.r, min(finalRgb.g, finalRgb.b));
    float sat = maxC - minC;
    float vibrance = 1.0 + uClarity * 0.16 * (1.0 - sat);
    float y = luma(finalRgb);
    finalRgb = clamp(mix(vec3(y), finalRgb, vibrance), 0.0, 1.0);
  }

  fragColor = vec4(finalRgb, center4.a);
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
  private easuProgram: WebGLProgram
  private rcasProgram: WebGLProgram
  private vao: WebGLVertexArrayObject
  private vbo: WebGLBuffer
  private srcTex: WebGLTexture
  private midTex: WebGLTexture
  private midFbo: WebGLFramebuffer
  private dstTex: WebGLTexture
  private dstFbo: WebGLFramebuffer
  private midWidth = 0
  private midHeight = 0
  private dstWidth = 0
  private dstHeight = 0

  private deburikLocs: {
    uTex: WebGLUniformLocation | null
    uFlipY: WebGLUniformLocation | null
    uTexelSize: WebGLUniformLocation | null
    uDenoise: WebGLUniformLocation | null
    uDeblock: WebGLUniformLocation | null
  }
  private easuLocs: {
    uTex: WebGLUniformLocation | null
    uFlipY: WebGLUniformLocation | null
    uSrcSize: WebGLUniformLocation | null
    uSrcInvSize: WebGLUniformLocation | null
  }
  private rcasLocs: {
    uTex: WebGLUniformLocation | null
    uFlipY: WebGLUniformLocation | null
    uDstTexelSize: WebGLUniformLocation | null
    uSharpen: WebGLUniformLocation | null
    uClarity: WebGLUniformLocation | null
  }

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
    this.easuProgram = createProgram(gl, EASU_UPSCALE_FRAGMENT_SHADER)
    this.rcasProgram = createProgram(gl, RCAS_CLARITY_FRAGMENT_SHADER)

    this.deburikLocs = {
      uTex: gl.getUniformLocation(this.deburikProgram, 'uTex'),
      uFlipY: gl.getUniformLocation(this.deburikProgram, 'uFlipY'),
      uTexelSize: gl.getUniformLocation(this.deburikProgram, 'uTexelSize'),
      uDenoise: gl.getUniformLocation(this.deburikProgram, 'uDenoise'),
      uDeblock: gl.getUniformLocation(this.deburikProgram, 'uDeblock'),
    }
    this.easuLocs = {
      uTex: gl.getUniformLocation(this.easuProgram, 'uTex'),
      uFlipY: gl.getUniformLocation(this.easuProgram, 'uFlipY'),
      uSrcSize: gl.getUniformLocation(this.easuProgram, 'uSrcSize'),
      uSrcInvSize: gl.getUniformLocation(this.easuProgram, 'uSrcInvSize'),
    }
    this.rcasLocs = {
      uTex: gl.getUniformLocation(this.rcasProgram, 'uTex'),
      uFlipY: gl.getUniformLocation(this.rcasProgram, 'uFlipY'),
      uDstTexelSize: gl.getUniformLocation(this.rcasProgram, 'uDstTexelSize'),
      uSharpen: gl.getUniformLocation(this.rcasProgram, 'uSharpen'),
      uClarity: gl.getUniformLocation(this.rcasProgram, 'uClarity'),
    }

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

    for (const prog of [this.deburikProgram, this.easuProgram, this.rcasProgram]) {
      const loc = gl.getAttribLocation(prog, 'aPos')
      gl.enableVertexAttribArray(loc)
      gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0)
    }

    const srcTex = gl.createTexture()
    const midTex = gl.createTexture()
    const midFbo = gl.createFramebuffer()
    const dstTex = gl.createTexture()
    const dstFbo = gl.createFramebuffer()
    if (!srcTex || !midTex || !midFbo || !dstTex || !dstFbo) {
      throw new Error('Gagal alokasi tekstur WebGL2')
    }
    this.srcTex = srcTex
    this.midTex = midTex
    this.midFbo = midFbo
    this.dstTex = dstTex
    this.dstFbo = dstFbo

    for (const tex of [srcTex, midTex, dstTex]) {
      gl.bindTexture(gl.TEXTURE_2D, tex)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
    }
  }

  isLost(): boolean {
    return this.gl.isContextLost()
  }

  private ensureFboTarget(
    tex: WebGLTexture,
    fbo: WebGLFramebuffer,
    w: number,
    h: number,
    curW: number,
    curH: number
  ): { w: number; h: number } {
    if (curW === w && curH === h) return { w: curW, h: curH }
    const gl = this.gl
    gl.bindTexture(gl.TEXTURE_2D, tex)
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null)
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo)
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0)
    const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER)
    gl.bindFramebuffer(gl.FRAMEBUFFER, null)
    if (status !== gl.FRAMEBUFFER_COMPLETE) {
      throw new Error(`Framebuffer WebGL2 tidak lengkap (${status})`)
    }
    return { w, h }
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

    gl.bindVertexArray(this.vao)
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, 0)

    // Upload source frame/image
    gl.activeTexture(gl.TEXTURE0)
    gl.bindTexture(gl.TEXTURE_2D, this.srcTex)
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source)

    const needsDeburik = params.denoise > 0.5 || params.deblock > 0.5
    const needsRcas = params.sharpen > 0.5 || params.clarity > 0.5

    // Pass 1 (optional): Fast YCbCr de-burik denoise + deblock -> midFbo
    let upscaleInputTex = this.srcTex
    if (needsDeburik) {
      const midSize = this.ensureFboTarget(
        this.midTex,
        this.midFbo,
        srcWidth,
        srcHeight,
        this.midWidth,
        this.midHeight
      )
      this.midWidth = midSize.w
      this.midHeight = midSize.h

      gl.bindFramebuffer(gl.FRAMEBUFFER, this.midFbo)
      gl.viewport(0, 0, srcWidth, srcHeight)
      gl.useProgram(this.deburikProgram)
      gl.uniform1i(this.deburikLocs.uTex, 0)
      gl.uniform1f(this.deburikLocs.uFlipY, 0.0)
      gl.uniform2f(this.deburikLocs.uTexelSize, 1 / srcWidth, 1 / srcHeight)
      gl.uniform1f(this.deburikLocs.uDenoise, params.denoise / 100)
      gl.uniform1f(this.deburikLocs.uDeblock, params.deblock / 100)
      gl.drawArrays(gl.TRIANGLES, 0, 6)
      upscaleInputTex = this.midTex
    }

    // Pass 2: Edge-Adaptive Directional Super-Resolution (EASU 12-tap + anti-ringing)
    gl.bindTexture(gl.TEXTURE_2D, upscaleInputTex)
    gl.useProgram(this.easuProgram)
    gl.uniform1i(this.easuLocs.uTex, 0)
    gl.uniform2f(this.easuLocs.uSrcSize, srcWidth, srcHeight)
    gl.uniform2f(this.easuLocs.uSrcInvSize, 1 / srcWidth, 1 / srcHeight)

    if (!needsRcas) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, null)
      gl.viewport(0, 0, dstWidth, dstHeight)
      gl.uniform1f(this.easuLocs.uFlipY, 1.0)
      gl.drawArrays(gl.TRIANGLES, 0, 6)
      return
    }

    const dstSize = this.ensureFboTarget(
      this.dstTex,
      this.dstFbo,
      dstWidth,
      dstHeight,
      this.dstWidth,
      this.dstHeight
    )
    this.dstWidth = dstSize.w
    this.dstHeight = dstSize.h

    gl.bindFramebuffer(gl.FRAMEBUFFER, this.dstFbo)
    gl.viewport(0, 0, dstWidth, dstHeight)
    gl.uniform1f(this.easuLocs.uFlipY, 0.0)
    gl.drawArrays(gl.TRIANGLES, 0, 6)

    // Pass 3: RCAS Contrast-Adaptive Sharpening + Clarity -> Canvas
    gl.bindFramebuffer(gl.FRAMEBUFFER, null)
    gl.viewport(0, 0, dstWidth, dstHeight)
    gl.bindTexture(gl.TEXTURE_2D, this.dstTex)
    gl.useProgram(this.rcasProgram)
    gl.uniform1i(this.rcasLocs.uTex, 0)
    gl.uniform1f(this.rcasLocs.uFlipY, 1.0)
    gl.uniform2f(this.rcasLocs.uDstTexelSize, 1 / dstWidth, 1 / dstHeight)
    gl.uniform1f(this.rcasLocs.uSharpen, params.sharpen / 100)
    gl.uniform1f(this.rcasLocs.uClarity, params.clarity / 100)
    gl.drawArrays(gl.TRIANGLES, 0, 6)
  }

  dispose(): void {
    const gl = this.gl
    gl.deleteTexture(this.srcTex)
    gl.deleteTexture(this.midTex)
    gl.deleteFramebuffer(this.midFbo)
    gl.deleteTexture(this.dstTex)
    gl.deleteFramebuffer(this.dstFbo)
    gl.deleteBuffer(this.vbo)
    gl.deleteVertexArray(this.vao)
    gl.deleteProgram(this.deburikProgram)
    gl.deleteProgram(this.easuProgram)
    gl.deleteProgram(this.rcasProgram)
  }
}

let sharedPhotoPipeline: WebGLRestorationPipeline | null = null

function getSharedPhotoPipeline(): WebGLRestorationPipeline {
  if (sharedPhotoPipeline && !sharedPhotoPipeline.isLost()) {
    return sharedPhotoPipeline
  }
  if (sharedPhotoPipeline) {
    try {
      sharedPhotoPipeline.dispose()
    } catch {
      // ignore dispose errors on lost context
    }
    sharedPhotoPipeline = null
  }
  sharedPhotoPipeline = new WebGLRestorationPipeline()
  return sharedPhotoPipeline
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
    stage: 'Menjalankan Super-Resolution GPU (EASU + RCAS)...',
    detail: `${srcW}×${srcH} → ${dstW}×${dstH}`,
  })

  // Keep each WebGL render target safe for mobile (<= 2048px) while giving laptops fast single-pass up to 4096px
  const safeLimit = Math.min(maxTextureSize, isMobile ? 2048 : 4096)
  const pipeline = getSharedPhotoPipeline()

  if (dstW <= safeLimit && dstH <= safeLimit) {
    pipeline.render(bitmap, srcW, srcH, dstW, dstH, params)
    onProgress?.({ percent: 85, stage: 'Mengemas file hasil HD...' })
    const blob = await canvasToBlob(pipeline.canvas, outputFormat)
    return { blob, width: dstW, height: dstH }
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
    tileCanvas.width = 0
    tileCanvas.height = 0
    outCanvas.width = 0
    outCanvas.height = 0
  }
}

export function canvasToBlob(canvas: HTMLCanvasElement, format: OutputImageFormat): Promise<Blob> {
  return new Promise((resolve, reject) => {
    const quality = format === 'image/png' ? undefined : 0.95
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
