// Extract the in-camera Picture Control that a Nikon stored inside a NEF.
//
// Nikon writes the capture-time Picture Control into its MakerNote, under the
// PictureControlData tag (0x0023). The path is:
//   TIFF IFD0 -> Exif IFD (tag 0x8769) -> MakerNote (tag 0x927C)
//   MakerNote = "Nikon\0" + version + an *embedded* TIFF whose IFD holds 0x0023
//   0x0023 block = version("0100"/"0200"/"0300") + name + base + scalar adjusts
//
// The version/name/base are at fixed, reliable offsets. The numeric adjustment
// offsets differ per version, so those are decoded best-effort and flagged.

import type { PictureControl, MonoToningType } from './pictureControl'
import { defaultControl } from './pictureControl'

const TAG_EXIF_IFD = 0x8769
const TAG_MAKERNOTE = 0x927c
const TAG_PICTURE_CONTROL = 0x0023

interface View {
  dv: DataView
  little: boolean
  u16(o: number): number
  u32(o: number): number
  u8(o: number): number
}

function makeView(buf: ArrayBuffer, base: number, little: boolean): View {
  const dv = new DataView(buf)
  return {
    dv,
    little,
    u16: (o) => dv.getUint16(base + o, little),
    u32: (o) => dv.getUint32(base + o, little),
    u8: (o) => dv.getUint8(base + o)
  }
}

const TYPE_SIZE: Record<number, number> = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 7: 1, 9: 4, 10: 8 }

/** Find an IFD entry by tag; returns {type,count,valuePtr} where valuePtr is an
 *  absolute file offset to the value (resolving inline vs. pointer). `tiffBase`
 *  is the offset all internal pointers are relative to. */
function findEntry(
  buf: ArrayBuffer,
  little: boolean,
  tiffBase: number,
  ifdOffset: number,
  tag: number
): { type: number; count: number; valuePtr: number; raw: number } | null {
  const v = makeView(buf, 0, little)
  const ifdAbs = tiffBase + ifdOffset
  if (ifdAbs + 2 > buf.byteLength) return null
  const n = v.u16(ifdAbs)
  for (let i = 0; i < n; i++) {
    const e = ifdAbs + 2 + i * 12
    if (e + 12 > buf.byteLength) break
    if (v.u16(e) !== tag) continue
    const type = v.u16(e + 2)
    const count = v.u32(e + 4)
    const size = (TYPE_SIZE[type] ?? 1) * count
    const raw = v.u32(e + 8)
    const valuePtr = size <= 4 ? e + 8 : tiffBase + raw
    return { type, count, valuePtr, raw }
  }
  return null
}

function ascii(buf: ArrayBuffer, off: number, len: number): string {
  const b = new Uint8Array(buf, off, Math.min(len, buf.byteLength - off))
  let s = ''
  for (const c of b) {
    if (c === 0) break
    s += String.fromCharCode(c)
  }
  return s.trim()
}

export interface EmbeddedPictureControl {
  version: string
  name: string
  base: string
  /** raw bytes of the whole PictureControlData block (for diagnostics) */
  raw: Uint8Array
  /** decoded scalar adjustments (best-effort, version dependent) */
  adjust: Record<string, number>
}

/** Locate and decode the PictureControlData block from a NEF. */
export function readEmbeddedPictureControl(buf: ArrayBuffer): EmbeddedPictureControl | null {
  if (buf.byteLength < 16) return null
  const order = new DataView(buf).getUint16(0, false)
  const little = order === 0x4949
  if (!little && order !== 0x4d4d) return null
  const v = makeView(buf, 0, little)
  if (v.u16(2) !== 42) return null
  const ifd0 = v.u32(4)

  // IFD0 -> Exif IFD
  const exif = findEntry(buf, little, 0, ifd0, TAG_EXIF_IFD)
  if (!exif) return null
  const exifIfd = new DataView(buf).getUint32(exif.valuePtr, little)

  // Exif IFD -> MakerNote
  const mn = findEntry(buf, little, 0, exifIfd, TAG_MAKERNOTE)
  if (!mn) return null
  const mnStart = mn.raw // makernote blob starts here (absolute)
  if (mnStart + 18 > buf.byteLength) return null

  // Nikon type-3 MakerNote: "Nikon\0" + 2-byte ver + 2 bytes + embedded TIFF
  const sig = ascii(buf, mnStart, 6)
  if (!sig.startsWith('Nikon')) return null
  const tiffBase = mnStart + 10 // embedded TIFF header starts here
  const innerOrder = new DataView(buf).getUint16(tiffBase, false)
  const innerLittle = innerOrder === 0x4949
  if (!innerLittle && innerOrder !== 0x4d4d) return null
  const iv = makeView(buf, tiffBase, innerLittle)
  if (iv.u16(2) !== 42) return null
  const innerIfd = iv.u32(4)

  // inner IFD -> PictureControlData (offsets relative to tiffBase)
  const pc = findEntry(buf, innerLittle, tiffBase, innerIfd, TAG_PICTURE_CONTROL)
  if (!pc) return null
  const start = pc.valuePtr
  const len = pc.count
  if (start + Math.min(len, 58) > buf.byteLength) return null

  const raw = new Uint8Array(buf.slice(start, start + len))
  const version = ascii(buf, start, 4)
  const name = ascii(buf, start + 4, 20)
  const base = ascii(buf, start + 24, 20)

  // Scalar adjustments. Layout shifts by version; these are the v1("0100")
  // offsets and a reasonable guess for v2/v3 — VERIFY against a real file.
  const adjust = decodeAdjust(raw, version)

  return { version, name, base, raw, adjust }
}

// Nikon stores most adjustments as signed bytes around 0 (e.g. 0xff = -1), and
// filter/toning as 0x80-based codes. Offsets below are best-effort per version.
function decodeAdjust(raw: Uint8Array, version: string): Record<string, number> {
  const s8 = (o: number) => (o < raw.length ? (raw[o] << 24) >> 24 : 0) // signed
  const u8 = (o: number) => (o < raw.length ? raw[o] : 0)
  // Default to the v1 ("0100") layout; newer versions add a Clarity byte which
  // shifts later fields, so we offset them by +2 for 0200/0300.
  const shift = version === '0100' ? 0 : 2
  return {
    quickAdjust: s8(49),
    sharpening: u8(51),
    contrast: s8(53 + shift),
    brightness: s8(55 + shift),
    saturation: s8(57 + shift),
    hue: s8(59 + shift),
    filterEffect: u8(61 + shift),
    toningEffect: u8(63 + shift),
    toningSaturation: u8(64 + shift)
  }
}

const FILTER_CODE: Record<number, PictureControl['filter']> = {
  0x80: 'none',
  0x81: 'yellow',
  0x82: 'orange',
  0x83: 'red',
  0x84: 'green'
}
const TONING_CODE: Record<number, MonoToningType> = {
  0x80: 'none',
  0x81: 'sepia',
  0x82: 'cyanotype',
  0x83: 'red',
  0x84: 'yellow',
  0x85: 'green',
  0x86: 'blueGreen',
  0x87: 'blue',
  0x88: 'purpleBlue',
  0x89: 'redPurple'
}

/** Convert an extracted Picture Control into one of our editable recipes. */
export function nefToPictureControl(buf: ArrayBuffer): PictureControl | null {
  const e = readEmbeddedPictureControl(buf)
  if (!e) return null
  const mono = /MONOCHROME/i.test(e.base) || /MONOCHROME/i.test(e.name)
  const pc = defaultControl()
  pc.id = 'nef-' + (e.name || 'embedded')
  pc.name = e.name || e.base || 'NEF Picture Control'
  pc.mode = mono ? 'monochrome' : 'color'
  pc.sharpening = Math.min(100, Math.max(0, e.adjust.sharpening) * 11)
  pc.contrast = clampScale(e.adjust.contrast, 15)
  pc.brightness = clampScale(e.adjust.brightness, 15)
  if (mono) {
    pc.filter = FILTER_CODE[e.adjust.filterEffect] ?? 'none'
    const tone = TONING_CODE[e.adjust.toningEffect] ?? 'none'
    const density = Math.max(1, Math.min(7, Math.round((e.adjust.toningSaturation || 0) || 4)))
    pc.monoTone = tone === 'none' ? null : { type: tone, density }
  } else {
    pc.saturation = clampScale(e.adjust.saturation, 15)
    pc.hue = clampScale(e.adjust.hue, 4)
  }
  return pc
}

function clampScale(v: number, factor: number): number {
  const x = Math.max(-3, Math.min(3, v)) * factor
  return Math.round(x)
}
