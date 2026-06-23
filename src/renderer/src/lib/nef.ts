// Minimal TIFF/NEF reader.
//
// NEF (Nikon Electronic Format) is a TIFF-based container. Every NEF embeds at
// least one full-resolution JPEG preview, referenced from an IFD via the
// JPEGInterchangeFormat (0x0201) + JPEGInterchangeFormatLength (0x0202) tags.
// We walk IFD0, its SubIFDs (tag 0x014A) and IFD1, collect every embedded JPEG,
// and return the largest one. No native dependencies / RAW demosaic required.

export interface ExtractedPreview {
  /** JPEG bytes of the largest embedded preview. */
  jpeg: Uint8Array
  /** Byte length, useful to pick the biggest preview. */
  length: number
}

const TAG_SUBIFDS = 0x014a
const TAG_JPEG_OFFSET = 0x0201
const TAG_JPEG_LENGTH = 0x0202
const TYPE_BYTES: Record<number, number> = {
  1: 1, // BYTE
  2: 1, // ASCII
  3: 2, // SHORT
  4: 4, // LONG
  5: 8, // RATIONAL
  7: 1, // UNDEFINED
  9: 4, // SLONG
  10: 8 // SRATIONAL
}

class Reader {
  view: DataView
  little: boolean
  constructor(buf: ArrayBuffer, little: boolean) {
    this.view = new DataView(buf)
    this.little = little
  }
  u16(o: number) {
    return this.view.getUint16(o, this.little)
  }
  u32(o: number) {
    return this.view.getUint32(o, this.little)
  }
}

interface IfdEntry {
  tag: number
  type: number
  count: number
  valueOffset: number // file offset where the value (or pointer) lives
}

function readEntry(r: Reader, o: number): IfdEntry {
  const tag = r.u16(o)
  const type = r.u16(o + 2)
  const count = r.u32(o + 4)
  return { tag, type, count, valueOffset: o + 8 }
}

/** Read the numeric values of an entry (handles inline vs. offset storage). */
function entryValues(r: Reader, e: IfdEntry): number[] {
  const size = (TYPE_BYTES[e.type] ?? 1) * e.count
  const base = size <= 4 ? e.valueOffset : r.u32(e.valueOffset)
  const out: number[] = []
  for (let i = 0; i < e.count; i++) {
    switch (e.type) {
      case 3:
        out.push(r.u16(base + i * 2))
        break
      case 1:
      case 7:
        out.push(r.view.getUint8(base + i))
        break
      default: // treat LONG and the rest as 32-bit
        out.push(r.u32(base + i * 4))
    }
  }
  return out
}

export function extractNefPreview(buf: ArrayBuffer): ExtractedPreview | null {
  if (buf.byteLength < 8) return null
  const head = new DataView(buf)
  const byteOrder = head.getUint16(0, false)
  let little: boolean
  if (byteOrder === 0x4949)
    little = true // "II"
  else if (byteOrder === 0x4d4d)
    little = false // "MM"
  else return null

  const r = new Reader(buf, little)
  const magic = r.u16(2)
  if (magic !== 42) return null

  const jpegs: { offset: number; length: number }[] = []
  const visited = new Set<number>()

  const walkIfd = (ifdOffset: number, depth: number) => {
    if (depth > 6 || ifdOffset <= 0 || ifdOffset + 2 > buf.byteLength) return
    if (visited.has(ifdOffset)) return
    visited.add(ifdOffset)

    const n = r.u16(ifdOffset)
    let jpegOff = -1
    let jpegLen = -1
    for (let i = 0; i < n; i++) {
      const e = readEntry(r, ifdOffset + 2 + i * 12)
      if (e.tag === TAG_JPEG_OFFSET) jpegOff = entryValues(r, e)[0]
      else if (e.tag === TAG_JPEG_LENGTH) jpegLen = entryValues(r, e)[0]
      else if (e.tag === TAG_SUBIFDS) {
        for (const sub of entryValues(r, e)) walkIfd(sub, depth + 1)
      }
    }
    if (jpegOff > 0 && jpegLen > 0 && jpegOff + jpegLen <= buf.byteLength) {
      jpegs.push({ offset: jpegOff, length: jpegLen })
    }
    // chained next IFD
    const nextPtr = ifdOffset + 2 + n * 12
    if (nextPtr + 4 <= buf.byteLength) walkIfd(r.u32(nextPtr), depth + 1)
  }

  walkIfd(r.u32(4), 0)

  if (jpegs.length === 0) return null
  jpegs.sort((a, b) => b.length - a.length)
  const best = jpegs[0]
  const bytes = new Uint8Array(buf.slice(best.offset, best.offset + best.length))
  // sanity: JPEG starts with FFD8
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8) {
    // some previews store a raw strip; bail rather than render garbage
    const valid = jpegs.find((j) => {
      const b = new Uint8Array(buf.slice(j.offset, j.offset + 2))
      return b[0] === 0xff && b[1] === 0xd8
    })
    if (!valid) return null
    const vb = new Uint8Array(buf.slice(valid.offset, valid.offset + valid.length))
    return { jpeg: vb, length: valid.length }
  }
  return { jpeg: bytes, length: best.length }
}

const NEF_EXTS = ['nef', 'nrw']

export function isRawName(name: string): boolean {
  const ext = name.split('.').pop()?.toLowerCase() ?? ''
  return NEF_EXTS.includes(ext)
}

/**
 * Turn an opened file (JPG or NEF) into an HTMLImageElement-ready object URL.
 * For NEF we extract the embedded JPEG; for everything else we pass bytes through.
 */
export async function loadImageBitmap(
  name: string,
  bytes: ArrayBuffer
): Promise<{ bitmap: ImageBitmap; source: 'jpeg' | 'nef-embedded' }> {
  let blobBytes: Uint8Array
  let source: 'jpeg' | 'nef-embedded' = 'jpeg'
  if (isRawName(name)) {
    const preview = extractNefPreview(bytes)
    if (!preview) {
      throw new Error(
        'No embedded JPEG preview found in this NEF. (Full RAW demosaic is not supported yet.)'
      )
    }
    blobBytes = preview.jpeg
    source = 'nef-embedded'
  } else {
    blobBytes = new Uint8Array(bytes)
  }
  const blob = new Blob([blobBytes as BlobPart])
  const bitmap = await createImageBitmap(blob)
  return { bitmap, source }
}
