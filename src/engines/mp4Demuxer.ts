export interface Mp4Sample {
  offset: number
  size: number
  type: 'key' | 'delta'
  timestampUs: number
  durationUs: number
}

export interface Mp4VideoTrack {
  codec: string
  width: number
  height: number
  rotation: 0 | 90 | 180 | 270
  fps: number
  durationUs: number
  description: Uint8Array
  samples: Mp4Sample[]
}

export interface Mp4AudioTrack {
  codec: 'mp4a.40.2'
  numberOfChannels: number
  sampleRate: number
  durationUs: number
  description: Uint8Array
  samples: Mp4Sample[]
}

export interface ParsedMp4 {
  durationSec: number
  videoTrack: Mp4VideoTrack | null
  audioTrack: Mp4AudioTrack | null
}

function readAscii(view: DataView, offset: number, length: number): string {
  let out = ''
  for (let i = 0; i < length; i++) {
    out += String.fromCharCode(view.getUint8(offset + i))
  }
  return out
}

function readUint64(view: DataView, offset: number): number {
  const hi = view.getUint32(offset)
  const lo = view.getUint32(offset + 4)
  return hi * 4294967296 + lo
}

function readInt64(view: DataView, offset: number): number {
  const hi = view.getInt32(offset)
  const lo = view.getUint32(offset + 4)
  return hi * 4294967296 + lo
}

function toHexByte(n: number): string {
  return n.toString(16).padStart(2, '0')
}

interface BoxSpan {
  type: string
  start: number
  headerSize: number
  end: number
}

function iterBoxes(view: DataView, start: number, end: number): BoxSpan[] {
  const boxes: BoxSpan[] = []
  let pos = start
  while (pos + 8 <= end) {
    let size = view.getUint32(pos)
    const type = readAscii(view, pos + 4, 4)
    let headerSize = 8
    if (size === 1) {
      if (pos + 16 > end) break
      size = readUint64(view, pos + 8)
      headerSize = 16
    } else if (size === 0) {
      size = end - pos
    }
    if (size < headerSize || pos + size > end) break
    boxes.push({ type, start: pos, headerSize, end: pos + size })
    pos += size
  }
  return boxes
}

function findBox(view: DataView, start: number, end: number, targetType: string): BoxSpan | null {
  for (const box of iterBoxes(view, start, end)) {
    if (box.type === targetType) return box
  }
  return null
}

function parseRotationFromMatrix(view: DataView, matrixStart: number): 0 | 90 | 180 | 270 {
  // 3x3 fixed-point 16.16 matrix in tkhd
  const a = view.getInt32(matrixStart) / 65536
  const b = view.getInt32(matrixStart + 4) / 65536
  const angle = Math.round((Math.atan2(b, a) * 180) / Math.PI)
  const norm = ((angle % 360) + 360) % 360
  if (norm === 90) return 90
  if (norm === 180) return 180
  if (norm === 270) return 270
  return 0
}

function parseEsdsDescriptor(bytes: Uint8Array): {
  objectType: number
  audioSpecificConfig: Uint8Array
} | null {
  // esds full box payload starts after version(1)+flags(3) = 4 bytes
  let pos = 4
  const readDescSize = (): number => {
    let size = 0
    for (let i = 0; i < 4 && pos < bytes.length; i++) {
      const b = bytes[pos++]
      size = (size << 7) | (b & 0x7f)
      if ((b & 0x80) === 0) break
    }
    return size
  }

  let objectType = 0
  let audioSpecificConfig: Uint8Array | null = null

  while (pos < bytes.length) {
    const tag = bytes[pos++]
    const size = readDescSize()
    if (tag === 0x03) {
      // ES_Descriptor: ES_ID(2) + flags(1) + optional dependencies
      if (pos + 3 > bytes.length) break
      const flags = bytes[pos + 2]
      pos += 3
      if (flags & 0x80) pos += 2
      if (flags & 0x40) {
        const urlLen = bytes[pos] ?? 0
        pos += 1 + urlLen
      }
      if (flags & 0x20) pos += 2
    } else if (tag === 0x04) {
      // DecoderConfigDescriptor: objectTypeIndication(1) + streamType(1) + buffer(3) + max(4) + avg(4) = 13 bytes
      if (pos + 13 > bytes.length) break
      objectType = bytes[pos]
      pos += 13
    } else if (tag === 0x05) {
      const len = Math.min(size, bytes.length - pos)
      audioSpecificConfig = bytes.slice(pos, pos + len)
      break
    } else {
      pos += size
    }
  }

  if (!audioSpecificConfig || audioSpecificConfig.length === 0) return null
  return { objectType, audioSpecificConfig }
}

function buildHevcCodecString(prefix: 'hvc1' | 'hev1', desc: Uint8Array): string {
  if (desc.length < 13) return `${prefix}.1.6.L93.B0`
  const profileSpace = (desc[1] >> 6) & 0x03
  const tierFlag = (desc[1] >> 5) & 0x01
  const profileIdc = desc[1] & 0x1f
  const spaceStr = ['', 'A', 'B', 'C'][profileSpace] || ''
  // Compatibility flags are 4 bytes reversed hex bitmask
  let compat = ((desc[2] << 24) | (desc[3] << 16) | (desc[4] << 8) | desc[5]) >>> 0
  let reversed = 0
  for (let i = 0; i < 32; i++) {
    reversed = (reversed << 1) | (compat & 1)
    compat >>>= 1
  }
  const compatHex = (reversed >>> 0).toString(16)
  const levelIdc = desc[12]
  const tierChar = tierFlag ? 'H' : 'L'
  return `${prefix}.${spaceStr}${profileIdc}.${compatHex}.${tierChar}${levelIdc}.B0`
}

interface RawEditList {
  emptyLeadSec: number
  mediaTimeTicks: number
}

function parseElst(view: DataView, box: BoxSpan, mvhdTimescale: number): RawEditList {
  const payload = box.start + box.headerSize
  const version = view.getUint8(payload)
  const entryCount = view.getUint32(payload + 4)
  let pos = payload + 8
  let emptyLeadTicks = 0
  let mediaTimeTicks = 0

  for (let i = 0; i < entryCount; i++) {
    let segDur: number
    let mediaTime: number
    if (version === 1) {
      if (pos + 20 > box.end) break
      segDur = readUint64(view, pos)
      mediaTime = readInt64(view, pos + 8)
      pos += 20
    } else {
      if (pos + 12 > box.end) break
      segDur = view.getUint32(pos)
      mediaTime = view.getInt32(pos + 4)
      pos += 12
    }
    if (mediaTime < 0) {
      emptyLeadTicks += segDur
    } else {
      mediaTimeTicks = mediaTime
      break
    }
  }

  return {
    emptyLeadSec: mvhdTimescale > 0 ? emptyLeadTicks / mvhdTimescale : 0,
    mediaTimeTicks,
  }
}

interface BuiltSamples {
  samples: Mp4Sample[]
  minRawPtsUs: number
  durationUs: number
}

function buildSamplesFromStbl(
  view: DataView,
  stbl: BoxSpan,
  timescale: number,
  emptyLeadSec: number,
  mediaTimeTicks: number,
  allSyncIfNoStss: boolean
): BuiltSamples | null {
  const sttsBox = findBox(view, stbl.start + stbl.headerSize, stbl.end, 'stts')
  const stscBox = findBox(view, stbl.start + stbl.headerSize, stbl.end, 'stsc')
  const stszBox = findBox(view, stbl.start + stbl.headerSize, stbl.end, 'stsz')
  const stcoBox = findBox(view, stbl.start + stbl.headerSize, stbl.end, 'stco')
  const co64Box = findBox(view, stbl.start + stbl.headerSize, stbl.end, 'co64')
  const stssBox = findBox(view, stbl.start + stbl.headerSize, stbl.end, 'stss')
  const cttsBox = findBox(view, stbl.start + stbl.headerSize, stbl.end, 'ctts')

  if (!sttsBox || !stscBox || !stszBox || (!stcoBox && !co64Box) || timescale <= 0) {
    return null
  }

  // Sample sizes (stsz)
  const stszStart = stszBox.start + stszBox.headerSize
  const constSampleSize = view.getUint32(stszStart + 4)
  const sampleCount = view.getUint32(stszStart + 8)
  if (sampleCount === 0) return null

  const sizes = new Uint32Array(sampleCount)
  if (constSampleSize > 0) {
    sizes.fill(constSampleSize)
  } else {
    let p = stszStart + 12
    for (let i = 0; i < sampleCount; i++) {
      sizes[i] = view.getUint32(p)
      p += 4
    }
  }

  // Chunk offsets (stco / co64)
  const chunkOffsets: number[] = []
  if (stcoBox) {
    const p0 = stcoBox.start + stcoBox.headerSize
    const count = view.getUint32(p0 + 4)
    for (let i = 0; i < count; i++) {
      chunkOffsets.push(view.getUint32(p0 + 8 + i * 4))
    }
  } else if (co64Box) {
    const p0 = co64Box.start + co64Box.headerSize
    const count = view.getUint32(p0 + 4)
    for (let i = 0; i < count; i++) {
      chunkOffsets.push(readUint64(view, p0 + 8 + i * 8))
    }
  }

  // Sample to chunk (stsc) -> compute byte offset of every sample
  const stscStart = stscBox.start + stscBox.headerSize
  const stscCount = view.getUint32(stscStart + 4)
  const stscEntries: Array<{ firstChunk: number; samplesPerChunk: number }> = []
  for (let i = 0; i < stscCount; i++) {
    const p = stscStart + 8 + i * 12
    stscEntries.push({
      firstChunk: view.getUint32(p),
      samplesPerChunk: view.getUint32(p + 4),
    })
  }

  const offsets = new Float64Array(sampleCount)
  let sIdx = 0
  let stscIdx = 0
  for (let chunkIdx = 0; chunkIdx < chunkOffsets.length && sIdx < sampleCount; chunkIdx++) {
    const chunkNum1 = chunkIdx + 1
    while (stscIdx + 1 < stscEntries.length && chunkNum1 >= stscEntries[stscIdx + 1].firstChunk) {
      stscIdx++
    }
    const countInChunk = stscEntries[stscIdx]?.samplesPerChunk ?? 0
    let byteOff = chunkOffsets[chunkIdx]
    for (let k = 0; k < countInChunk && sIdx < sampleCount; k++) {
      offsets[sIdx] = byteOff
      byteOff += sizes[sIdx]
      sIdx++
    }
  }

  // Sync samples (stss)
  const syncSet = new Set<number>()
  if (stssBox) {
    const p0 = stssBox.start + stssBox.headerSize
    const count = view.getUint32(p0 + 4)
    for (let i = 0; i < count; i++) {
      syncSet.add(view.getUint32(p0 + 8 + i * 4) - 1)
    }
  }

  // Decode times & durations (stts)
  const dts = new Float64Array(sampleCount)
  const durations = new Float64Array(sampleCount)
  {
    const p0 = sttsBox.start + sttsBox.headerSize
    const count = view.getUint32(p0 + 4)
    let curDts = 0
    let idx = 0
    for (let i = 0; i < count && idx < sampleCount; i++) {
      const run = view.getUint32(p0 + 8 + i * 8)
      const delta = view.getUint32(p0 + 12 + i * 8)
      for (let j = 0; j < run && idx < sampleCount; j++) {
        dts[idx] = curDts
        durations[idx] = delta
        curDts += delta
        idx++
      }
    }
  }

  // Composition offsets (ctts)
  const cttsOffsets = new Float64Array(sampleCount)
  if (cttsBox) {
    const p0 = cttsBox.start + cttsBox.headerSize
    const version = view.getUint8(p0)
    const count = view.getUint32(p0 + 4)
    let idx = 0
    for (let i = 0; i < count && idx < sampleCount; i++) {
      const run = view.getUint32(p0 + 8 + i * 8)
      const offsetVal = version === 1 ? view.getInt32(p0 + 12 + i * 8) : view.getUint32(p0 + 12 + i * 8)
      for (let j = 0; j < run && idx < sampleCount; j++) {
        cttsOffsets[idx] = offsetVal
        idx++
      }
    }
  }

  const samples: Mp4Sample[] = new Array(sampleCount)
  const emptyLeadUs = emptyLeadSec * 1_000_000
  let minRawPtsUs = Number.POSITIVE_INFINITY
  let maxEndUs = 0

  for (let i = 0; i < sampleCount; i++) {
    const ptsTicks = dts[i] + cttsOffsets[i] - mediaTimeTicks
    const timestampUs = Math.round((ptsTicks / timescale) * 1_000_000 + emptyLeadUs)
    const durationUs = Math.max(1, Math.round((durations[i] / timescale) * 1_000_000))
    if (timestampUs < minRawPtsUs) minRawPtsUs = timestampUs
    if (timestampUs + durationUs > maxEndUs) maxEndUs = timestampUs + durationUs
    const isKey = allSyncIfNoStss || !stssBox ? true : syncSet.has(i)
    samples[i] = {
      offset: offsets[i],
      size: sizes[i],
      type: isKey ? 'key' : 'delta',
      timestampUs,
      durationUs,
    }
  }

  return {
    samples,
    minRawPtsUs: Number.isFinite(minRawPtsUs) ? minRawPtsUs : 0,
    durationUs: Math.max(1, maxEndUs - (Number.isFinite(minRawPtsUs) ? minRawPtsUs : 0)),
  }
}

export async function parseMp4File(file: File): Promise<ParsedMp4 | null> {
  // Quick ftyp check before scanning
  const headBuf = await file.slice(0, Math.min(16, file.size)).arrayBuffer()
  if (headBuf.byteLength < 12) return null
  const headView = new DataView(headBuf)
  const firstType = readAscii(headView, 4, 4)
  if (firstType !== 'ftyp' && firstType !== 'moov' && firstType !== 'free' && firstType !== 'wide') {
    return null
  }

  let moovBuf: ArrayBuffer | null = null
  let pos = 0
  while (pos + 8 <= file.size) {
    const hdrBuf = await file.slice(pos, Math.min(pos + 16, file.size)).arrayBuffer()
    if (hdrBuf.byteLength < 8) break
    const hdrView = new DataView(hdrBuf)
    let size = hdrView.getUint32(0)
    const type = readAscii(hdrView, 4, 4)
    let headerSize = 8
    if (size === 1) {
      if (hdrBuf.byteLength < 16) break
      size = readUint64(hdrView, 8)
      headerSize = 16
    } else if (size === 0) {
      size = file.size - pos
    }
    if (size < headerSize || pos + size > file.size) break

    if (type === 'moov') {
      // Cap moov read at 64MB to avoid pathological files
      if (size > 64 * 1024 * 1024) return null
      moovBuf = await file.slice(pos, pos + size).arrayBuffer()
      break
    }
    pos += size
  }

  if (!moovBuf) return null

  const view = new DataView(moovBuf)
  const rawBytes = new Uint8Array(moovBuf)
  const moovBoxes = iterBoxes(view, 8, moovBuf.byteLength)

  let mvhdTimescale = 1000
  let mvhdDurationSec = 0
  const mvhd = moovBoxes.find((b) => b.type === 'mvhd')
  if (mvhd) {
    const p0 = mvhd.start + mvhd.headerSize
    const version = view.getUint8(p0)
    if (version === 1) {
      mvhdTimescale = view.getUint32(p0 + 20)
      mvhdDurationSec = mvhdTimescale > 0 ? readUint64(view, p0 + 24) / mvhdTimescale : 0
    } else {
      mvhdTimescale = view.getUint32(p0 + 12)
      mvhdDurationSec = mvhdTimescale > 0 ? view.getUint32(p0 + 16) / mvhdTimescale : 0
    }
  }

  let rawVideo: {
    track: Omit<Mp4VideoTrack, 'samples' | 'durationUs'>
    built: BuiltSamples
  } | null = null
  let rawAudio: {
    track: Omit<Mp4AudioTrack, 'samples' | 'durationUs'>
    built: BuiltSamples
  } | null = null

  for (const trak of moovBoxes.filter((b) => b.type === 'trak')) {
    const trakBoxes = iterBoxes(view, trak.start + trak.headerSize, trak.end)
    const tkhd = trakBoxes.find((b) => b.type === 'tkhd')
    const edts = trakBoxes.find((b) => b.type === 'edts')
    const mdia = trakBoxes.find((b) => b.type === 'mdia')
    if (!mdia) continue

    let rotation: 0 | 90 | 180 | 270 = 0
    if (tkhd) {
      const tp = tkhd.start + tkhd.headerSize
      const version = view.getUint8(tp)
      const matrixOffset = version === 1 ? tp + 52 : tp + 40
      if (matrixOffset + 36 <= tkhd.end) {
        rotation = parseRotationFromMatrix(view, matrixOffset)
      }
    }

    let edit: RawEditList = { emptyLeadSec: 0, mediaTimeTicks: 0 }
    if (edts) {
      const elst = findBox(view, edts.start + edts.headerSize, edts.end, 'elst')
      if (elst) edit = parseElst(view, elst, mvhdTimescale)
    }

    const mdiaBoxes = iterBoxes(view, mdia.start + mdia.headerSize, mdia.end)
    const mdhd = mdiaBoxes.find((b) => b.type === 'mdhd')
    const hdlr = mdiaBoxes.find((b) => b.type === 'hdlr')
    const minf = mdiaBoxes.find((b) => b.type === 'minf')
    if (!mdhd || !hdlr || !minf) continue

    const mp = mdhd.start + mdhd.headerSize
    const mdhdVersion = view.getUint8(mp)
    const timescale =
      mdhdVersion === 1 ? view.getUint32(mp + 20) : view.getUint32(mp + 12)
    const handlerType = readAscii(view, hdlr.start + hdlr.headerSize + 8, 4)

    const stbl = findBox(view, minf.start + minf.headerSize, minf.end, 'stbl')
    if (!stbl) continue

    const stsd = findBox(view, stbl.start + stbl.headerSize, stbl.end, 'stsd')
    if (!stsd) continue

    const stsdPayload = stsd.start + stsd.headerSize
    const entryCount = view.getUint32(stsdPayload + 4)
    if (entryCount < 1) continue

    const entryStart = stsdPayload + 8
    const entrySize = view.getUint32(entryStart)
    const entryEnd = Math.min(stsd.end, entryStart + entrySize)
    const entryType = readAscii(view, entryStart + 4, 4)

    if (handlerType === 'vide' && !rawVideo) {
      const width = view.getUint16(entryStart + 32)
      const height = view.getUint16(entryStart + 34)
      const childBoxes = iterBoxes(view, entryStart + 86, entryEnd)

      let codec = ''
      let description: Uint8Array | null = null

      if ((entryType === 'avc1' || entryType === 'avc3')) {
        const avcC = childBoxes.find((b) => b.type === 'avcC')
        if (avcC) {
          description = rawBytes.slice(avcC.start + avcC.headerSize, avcC.end)
          if (description.length >= 4) {
            codec = `avc1.${toHexByte(description[1])}${toHexByte(description[2])}${toHexByte(description[3])}`
          }
        }
      } else if (entryType === 'hvc1' || entryType === 'hev1') {
        const hvcC = childBoxes.find((b) => b.type === 'hvcC')
        if (hvcC) {
          description = rawBytes.slice(hvcC.start + hvcC.headerSize, hvcC.end)
          codec = buildHevcCodecString(entryType, description)
        }
      } else if (entryType === 'vp09') {
        const vpcC = childBoxes.find((b) => b.type === 'vpcC')
        if (vpcC) {
          description = rawBytes.slice(vpcC.start + vpcC.headerSize, vpcC.end)
          const p = description[4] ?? 0
          const lvl = description[5] ?? 10
          const bd = (description[6] ?? 0x80) >> 4
          codec = `vp09.${String(p).padStart(2, '0')}.${String(lvl).padStart(2, '0')}.${String(bd).padStart(2, '0')}`
        }
      } else if (entryType === 'av01') {
        const av1C = childBoxes.find((b) => b.type === 'av1C')
        if (av1C) {
          description = rawBytes.slice(av1C.start + av1C.headerSize, av1C.end)
          const profile = (description[1] ?? 0) >> 5
          const level = (description[1] ?? 0) & 0x1f
          codec = `av01.${profile}.${String(level).padStart(2, '0')}M.08`
        }
      }

      if (codec && description && width > 0 && height > 0) {
        const built = buildSamplesFromStbl(
          view,
          stbl,
          timescale,
          edit.emptyLeadSec,
          edit.mediaTimeTicks,
          false
        )
        if (built) {
          const avgFps =
            built.durationUs > 0
              ? Math.max(1, Math.min(120, Math.round((built.samples.length * 1_000_000) / built.durationUs)))
              : 30
          rawVideo = {
            track: { codec, width, height, rotation, fps: avgFps, description },
            built,
          }
        }
      }
    } else if (handlerType === 'soun' && !rawAudio && entryType === 'mp4a') {
      const version = view.getUint16(entryStart + 16)
      const channels = view.getUint16(entryStart + 24)
      const sampleRate = view.getUint16(entryStart + 32)
      const extraOffset = version === 1 ? 16 : version === 2 ? 36 : 0
      const childStart = entryStart + 36 + extraOffset
      const childBoxes = iterBoxes(view, childStart, entryEnd)

      let esdsBox = childBoxes.find((b) => b.type === 'esds')
      if (!esdsBox) {
        const waveBox = childBoxes.find((b) => b.type === 'wave')
        if (waveBox) {
          esdsBox = findBox(view, waveBox.start + waveBox.headerSize, waveBox.end, 'esds') ?? undefined
        }
      }

      if (esdsBox) {
        const esdsBytes = rawBytes.slice(esdsBox.start + esdsBox.headerSize, esdsBox.end)
        const parsedEsds = parseEsdsDescriptor(esdsBytes)
        if (parsedEsds && parsedEsds.objectType === 0x40) {
          const built = buildSamplesFromStbl(
            view,
            stbl,
            timescale,
            edit.emptyLeadSec,
            edit.mediaTimeTicks,
            true
          )
          if (built) {
            rawAudio = {
              track: {
                codec: 'mp4a.40.2',
                numberOfChannels: Math.max(1, Math.min(2, channels || 2)),
                sampleRate: sampleRate || 48000,
                description: parsedEsds.audioSpecificConfig,
              },
              built,
            }
          }
        }
      }
    }
  }

  if (!rawVideo) return null

  // Shift timestamps uniformly so the earliest sample across tracks starts at >= 0
  const baseShiftUs = Math.min(
    rawVideo.built.minRawPtsUs,
    rawAudio ? rawAudio.built.minRawPtsUs : rawVideo.built.minRawPtsUs
  )

  const normalizeSamples = (samples: Mp4Sample[]) => {
    if (baseShiftUs === 0) return
    for (const s of samples) {
      s.timestampUs = Math.max(0, s.timestampUs - baseShiftUs)
    }
  }

  normalizeSamples(rawVideo.built.samples)
  if (rawAudio) normalizeSamples(rawAudio.built.samples)

  return {
    durationSec:
      mvhdDurationSec > 0
        ? mvhdDurationSec
        : rawVideo.built.durationUs / 1_000_000,
    videoTrack: {
      ...rawVideo.track,
      durationUs: rawVideo.built.durationUs,
      samples: rawVideo.built.samples,
    },
    audioTrack: rawAudio
      ? {
          ...rawAudio.track,
          durationUs: rawAudio.built.durationUs,
          samples: rawAudio.built.samples,
        }
      : null,
  }
}
