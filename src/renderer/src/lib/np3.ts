// Nikon .NP3 (Picture Control, format version "0310") writer.
//
// Writes a "Flexible Color Picture Control" — the NP3 variant Nikon Imaging
// Cloud recipes and NX Studio exports use (Z6III/Z5II/Z50II/Z8/Z9/Zf era), and
// the only kind whose parameter model matches an Adobe/Lightroom preset (tone
// sliders + 8-band colour blender + 3-way colour grading + luminance curve).
//
// Byte layout cross-validated against two independent sources:
//  - ssssota/nikon-flexible-color-picture-control (MIT) — an NP3 reader/writer
//    whose templates round-trip real NX Studio exports; our field offsets,
//    defaults, sentinels and the tone-curve chunk match it exactly.
//  - real files: Nikon Imaging Cloud recipe exports and NX Studio exports
//    (see scripts/analyze-np3.mjs to dump/diff them).
//
// Container: "NCP\0" magic · 00 00 01 00 · 00 00 00 04 · "0310", then TLV
// records  id(u32 BE) len(u32 BE) value[len]:
//
//   0x0200  name — 20 bytes ASCII, zero padded
//   0x0300  00 20 = flexible colour PC (classic PCs carry a base-PC enum here)
//   0x0600  sharpening       0x80 + steps×4 (¼ steps, -3..+9), flag 04
//   0x0700  clarity          0x80 + steps×4 (¼ steps, -5..+5), flag 04
//   0x1600  mid-range sharp  0x80 + steps×4 (¼ steps, -5..+5), flag 04
//   0x1900..0x1e00  contrast / highlights / shadows / white level /
//                   black level / saturation — 0x80 ± 100, flag 01.
//                   The first five become the 0x01 "User" sentinel when a
//                   tone-curve chunk is present (curve overrides them).
//   0x1f00  colour blender: 8 bands (R O Y G Cyan B Purple Magenta — same
//           order as Adobe's HSL bands) × (hue, chroma, brightness), each
//           0x80 ± 100; trailer 01 01 01 00
//   0x2000  colour grading: [highlights][midtone][shadows], each
//           (hueHi = 0x80 + (hue>>8), hueLo = hue & 0xff — hue 0..359°,
//            chroma 0x80±100, brightness 0x80±100); trailer 01 01 01 00;
//           then blending (0x80±100, Nikon default +50) 01, balance 01
//   remaining slots are the 0xff "n/a" defaults every real flexible file has
//
// After the records a 4-byte chunk marker follows: 00 00 00 00 = end,
// 00 01 01 00 = comment chunk (u32 length + even-padded UTF-8), and after the
// comment a u32 next-chunk type where 00 00 00 02 = tone-curve chunk:
// u32 length 0x242, then "I0", in-black, in-white, out-min, out-max,
// gamma (int + 0.01×frac), point count (≤20), (x,y) byte pairs, zero pad to
// offset 64, then a 257-entry u16 BE luminance LUT (0..32767, identity =
// i×32767/256, applied in sRGB gamma space), then 00 00 00 00.
//
// Not expressible in an NP3 and therefore dropped: white balance, dehaze,
// grain, sharpen radius/detail, and the colour-cast component of per-channel
// (R/G/B) point curves — but the channel curves' shared (luma) shape IS baked
// into the luminance LUT, since presets like VSCO carry their entire contrast
// there. Vibrance is folded into saturation (sat + vib/2 — matches observed
// conversions); exposure + parametric curve + master curve + tone sliders are
// baked into the tone-curve LUT when a curve is needed.

import type { CurvePoint, MonoToningType, PictureControl } from './pictureControl'
import { buildCurveLut, buildToneLut as buildPcToneLut, identityCurve } from './pictureControl'
import type { AcrParams } from './acr'
import { buildToneLut as buildAcrToneLut } from './acr'

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v))
/** 0x80-based byte for a -100..+100 slider value. */
const b80 = (v: number) => 0x80 + clamp(Math.round(v), -100, 100)
/** 0x80-based byte for a ¼-step slider (v in whole steps, range lo..hi). */
const bQuarter = (v: number, lo: number, hi: number) =>
  0x80 + clamp(Math.round(v * 4), lo * 4, hi * 4)

/** Sanitise a preset name to the ASCII Nikon accepts, capped to fit the field. */
function sanitizeName(name: string): string {
  const ascii = name.replace(/[^\x20-\x7e]/g, '').trim()
  return (ascii || 'CUSTOM').slice(0, 19) // leave a null terminator
}

class ByteBuilder {
  private parts: number[] = []
  bytes(...vals: number[]): void {
    for (const v of vals) this.parts.push(v & 0xff)
  }
  u32(v: number): void {
    this.bytes(v >>> 24, v >>> 16, v >>> 8, v)
  }
  u16(v: number): void {
    this.bytes(v >>> 8, v)
  }
  /** TLV record. */
  rec(id: number, value: number[] | Uint8Array): void {
    this.u32(id)
    this.u32(value.length)
    for (const v of value) this.parts.push(v & 0xff)
  }
  /** 2-byte <value><flag> record. */
  rec2(id: number, value: number, flag: number): void {
    this.rec(id, [value, flag])
  }
  build(): ArrayBuffer {
    return Uint8Array.from(this.parts).buffer
  }
}

/** One colour-grading region: hue 0..359 (9-bit split), chroma/brightness ±. */
function gradeBytes(w: ByteBuilder, hue: number, chroma: number, brightness: number): void {
  const h = ((Math.round(hue) % 360) + 360) % 360
  w.bytes(0x80 + (h >> 8), h & 0xff, b80(chroma), b80(brightness))
}

const identityish = (pts: CurvePoint[]) => {
  const lut = buildCurveLut(pts)
  for (let i = 0; i < 256; i++) if (Math.abs(lut[i] - i) > 3) return false
  return true
}

/** The luminance LUT baked into the NP3 curve chunk: the ACR tone pipeline
 * (exposure / tone sliders / parametric / master curve) composed with the
 * luma-weighted mix of the R/G/B point curves, in render order (acr.ts applies
 * channel curves after the tone LUT). NP3 has no per-channel curves, so how
 * the three differ (the colour cast) is the one part that drops out — losing
 * their shared contrast shape too is what used to wash film presets out. */
export function np3ToneLut(pc: PictureControl): Uint8ClampedArray {
  const a = pc.acr
  if (!a) return buildPcToneLut(pc)
  const lut = buildAcrToneLut(a, pc.curve)
  const chan = [a.curveRed, a.curveGreen, a.curveBlue]
  if (!chan.some((c) => c && c.length >= 2)) return lut
  const [rL, gL, bL] = chan.map((c) => (c && c.length >= 2 ? buildCurveLut(c) : null))
  const out = new Uint8ClampedArray(256)
  for (let i = 0; i < 256; i++) {
    const v = lut[i]
    out[i] = Math.round(
      0.2126 * (rL ? rL[v] : v) + 0.7152 * (gL ? gL[v] : v) + 0.0722 * (bL ? bL[v] : v)
    )
  }
  return out
}

/** 256-entry 8-bit LUT → the NP3 curve chunk (I0 header + points + 257×u16). */
function toneCurveChunk(w: ByteBuilder, lut: Uint8ClampedArray): void {
  w.u32(0x00000002) // next chunk: tone curve
  w.u32(578) // chunk length
  const start: number[] = []
  // header: "I0", in-black/white, out-min/max, gamma 1.00
  start.push(0x49, 0x30, 0x00, 0xff, 0x00, 0xff, 0x01, 0x00)
  // Editor anchor points sampled from the LUT. NX Studio (and likely the
  // camera) treats the anchors as authoritative and re-splines the 257-entry
  // LUT from them on load, so use 17 of the 20 allowed points to keep the
  // re-splined curve close to ours.
  const xs = [0, 16, 32, 48, 64, 80, 96, 112, 128, 144, 160, 176, 192, 208, 224, 240, 255]
  start.push(xs.length)
  for (const x of xs) start.push(x, lut[x])
  while (start.length < 64) start.push(0)
  w.bytes(...start)
  // 257-entry u16 LUT over input 0..256; linear-interp the 8-bit LUT so the
  // identity case reproduces NX Studio's own bytes (round(i·32767/256)).
  for (let i = 0; i <= 256; i++) {
    const t = (i * 255) / 256
    const lo = Math.floor(t)
    const hi = Math.min(255, lo + 1)
    const y = lut[lo] + (lut[hi] - lut[lo]) * (t - lo)
    w.u16(clamp(Math.round((y * 32767) / 255), 0, 32767))
  }
  w.u32(0) // terminator
}

/**
 * Build a camera-loadable .NP3 from a PictureControl recipe. XMP-imported
 * presets (pc.acr) map near-1:1 onto a flexible Picture Control; hand-made
 * recipes fall back to the sliders that exist on both sides. Exposure,
 * parametric regions, the master curve and (when a curve is written) the tone
 * sliders are baked into the luminance curve chunk.
 */
export function buildNp3(pc: PictureControl): ArrayBuffer {
  const a = pc.acr
  const w = new ByteBuilder()

  // does the look need the tone-curve chunk? (exposure, the parametric
  // regions and the channel curves' shared shape only exist as curve shape;
  // a non-identity master curve obviously)
  const mono = pc.mode === 'monochrome' || !!a?.monochrome
  const hasChanCurve =
    !!a &&
    [a.curveRed, a.curveGreen, a.curveBlue].some((c) => c && c.length >= 2 && !identityish(c))
  const needCurve = a
    ? !identityish(pc.curve) ||
      hasChanCurve ||
      Math.abs(a.exposure ?? 0) > 0.05 ||
      !!(a.paramShadows || a.paramDarks || a.paramLights || a.paramHighlights)
    : !identityish(pc.curve) || pc.brightness !== 0

  // file header
  w.bytes(0x4e, 0x43, 0x50, 0x00) // "NCP\0"
  w.bytes(0x00, 0x00, 0x01, 0x00)
  w.bytes(0x00, 0x00, 0x00, 0x04)
  w.bytes(0x30, 0x33, 0x31, 0x30) // "0310"

  // name
  const name = sanitizeName(pc.name)
  const nameBytes = new Uint8Array(20)
  for (let i = 0; i < name.length; i++) nameBytes[i] = name.charCodeAt(i)
  w.rec(0x0200, nameBytes)

  // flexible-PC identity + neutral slots (bytes every real flexible file has)
  w.rec(0x0300, [0x00, 0x20])
  w.rec(0x0400, [0x00, 0x00])
  w.rec2(0x0500, 0xff, 0x01)

  // detail sliders (¼ steps)
  const sharp = a ? (a.sharpenAmount ?? 0) * 0.06 : pc.sharpening * 0.09 // → 0..9
  const clarity = a ? (a.clarity ?? 0) * 0.05 : 0 // ±100 → ±5
  const midRange = a ? (a.texture ?? 0) * 0.05 : 0 // texture ≈ mid-range sharp
  w.rec2(0x0600, bQuarter(sharp, -3, 9), 0x04)
  w.rec2(0x0700, bQuarter(clarity, -5, 5), 0x04)

  for (const id of [0x0800, 0x0900, 0x0a00, 0x0b00]) w.rec2(id, 0xff, 0x04)
  w.rec2(0x0c00, 0xff, 0x00)
  w.rec2(0x0d00, 0xff, 0x00)
  w.rec2(0x0e00, 0xff, 0x04)
  for (const id of [0x0f00, 0x1000, 0x1100, 0x1200, 0x1300]) w.rec2(id, 0xff, 0x01)
  // 0x1400 is 0x80 in slider-driven files but NX Studio normalises it to the
  // 0xff "n/a" state when a user tone curve is present — match that.
  w.rec2(0x1400, needCurve ? 0xff : 0x80, 0x01)
  w.rec2(0x1500, 0xff, 0x0a)
  w.rec2(0x1600, bQuarter(midRange, -5, 5), 0x04)
  w.rec2(0x1700, 0xff, 0x04)
  w.rec2(0x1800, 0xff, 0x04)

  // tone: when the curve chunk is written the five tone sliders are baked
  // into the LUT and stored as the 0x01 sentinel (that is how NX Studio marks
  // a "User" curve; the camera then uses the LUT).
  const tone = a
    ? {
        contrast: a.contrast ?? 0,
        highlights: a.highlights ?? 0,
        shadows: a.shadows ?? 0,
        whites: a.whites ?? 0,
        blacks: a.blacks ?? 0,
        saturation: (a.saturation ?? 0) + (a.vibrance ?? 0) * 0.5
      }
    : {
        contrast: pc.contrast,
        highlights: 0,
        shadows: 0,
        whites: 0,
        blacks: 0,
        saturation: pc.saturation
      }
  const SENTINEL = 0x01
  const toneByte = (v: number) => (needCurve ? SENTINEL : b80(v))
  w.rec2(0x1900, toneByte(tone.contrast), 0x01)
  w.rec2(0x1a00, toneByte(tone.highlights), 0x01)
  w.rec2(0x1b00, toneByte(tone.shadows), 0x01)
  w.rec2(0x1c00, toneByte(tone.whites), 0x01)
  w.rec2(0x1d00, toneByte(tone.blacks), 0x01)
  w.rec2(0x1e00, b80(mono ? -100 : tone.saturation), 0x01) // stays live with a curve

  // colour blender — 8 × (hue, chroma, brightness), ACR HSL bands verbatim
  const blender: number[] = []
  for (let i = 0; i < 8; i++) {
    blender.push(
      b80(a?.hueAdjust?.[i] ?? 0),
      b80(mono ? 0 : a?.satAdjust?.[i] ?? 0),
      b80(a?.lumAdjust?.[i] ?? 0)
    )
  }
  blender.push(0x01, 0x01, 0x01, 0x00)
  w.rec(0x1f00, blender)

  // colour grading — order highlights/midtone/shadows; split-toning hues
  // verbatim, ACR region saturation lands on ≈¼ scale (matches conversions
  // in the wild), blending/balance direct. Nikon's neutral blending is +50.
  const g = a?.grade
  w.u32(0x2000)
  w.u32(20)
  gradeBytes(w, g?.highlight.h ?? 0, (g?.highlight.s ?? 0) / 4, g?.highlight.l ?? 0)
  gradeBytes(w, g?.midtone.h ?? 0, (g?.midtone.s ?? 0) / 4, g?.midtone.l ?? 0)
  gradeBytes(w, g?.shadow.h ?? 0, (g?.shadow.s ?? 0) / 4, g?.shadow.l ?? 0)
  w.bytes(0x01, 0x01, 0x01, 0x00)
  w.bytes(b80(g ? g.blending : 50), 0x01, b80(g?.balance ?? 0), 0x01)

  // comment chunk (provenance) — UTF-8, NUL-terminated, padded to even length
  const note = `Converted by NPC Simulator${a ? ' from an Adobe XMP preset.' : '.'}`
  const text = new TextEncoder().encode(note)
  const payload = new Uint8Array(((text.length + 1) + 1) & ~1) // +NUL, round up to even
  payload.set(text)
  w.u32(0x00010100) // comment marker (flag bytes 01 01)
  w.u32(payload.length)
  w.bytes(...payload)

  // tone-curve chunk or end-of-file
  if (needCurve) {
    toneCurveChunk(w, np3ToneLut(pc))
  } else {
    w.u32(0)
  }

  return w.build()
}

// ---------------------------------------------------------------------------
// Reader: .NP3 / .NCP → PictureControl (inverse of the writer above)
// ---------------------------------------------------------------------------

/** Curve points from a tone-curve chunk. The 257-entry LUT is the full
 * composite curve — real Nikon recipes set non-default levels/gamma in the
 * chunk header (matte out-min, gamma 0.6…), which the editor anchors alone
 * miss — so fit points to the LUT when present; raw anchors are the fallback
 * for short/legacy chunks. */
function curveFromChunk(val: Uint8Array): CurvePoint[] | null {
  if (val.length >= 64 + 257 * 2) {
    // u16 BE entries over input 0..256 → composite curve sampled at x 0..255
    const lut = new Float64Array(256)
    for (let x = 0; x < 256; x++) {
      const t = (x * 256) / 255
      const i = Math.min(255, Math.floor(t))
      const a = ((val[64 + i * 2] << 8) | val[64 + i * 2 + 1]) / 32767
      const b = ((val[66 + i * 2] << 8) | val[66 + i * 2 + 1]) / 32767
      lut[x] = (a + (b - a) * (t - i)) * 255
    }
    return fitCurveToLut(lut)
  }
  const n = Math.min(val[8] ?? 0, 20)
  const pts: CurvePoint[] = []
  for (let i = 0; i < n; i++) pts.push({ x: val[9 + i * 2], y: val[10 + i * 2] })
  pts.sort((p, q) => p.x - q.x)
  return pts.length >= 2 ? pts : null
}

/** Greedy spline fit: start from the endpoints and keep adding the sample the
 * Catmull-Rom through the current points misses most, until the curve fits
 * within ±1/255 or reaches Adobe's 16-anchor budget. */
function fitCurveToLut(lut: Float64Array): CurvePoint[] {
  const pts: CurvePoint[] = [
    { x: 0, y: Math.round(lut[0]) },
    { x: 255, y: Math.round(lut[255]) }
  ]
  while (pts.length < 16) {
    const spline = buildCurveLut(pts)
    let worstX = -1
    let worstErr = 1
    for (let x = 1; x < 255; x++) {
      const err = Math.abs(lut[x] - spline[x])
      if (err > worstErr) {
        worstErr = err
        worstX = x
      }
    }
    if (worstX < 0) break
    pts.push({ x: worstX, y: Math.round(lut[worstX]) })
    pts.sort((p, q) => p.x - q.x)
  }
  return pts
}

const ascii = (u8: Uint8Array, off: number, len: number): string => {
  let s = ''
  for (let i = off; i < off + len && i < u8.length; i++) {
    if (u8[i] === 0) break
    s += String.fromCharCode(u8[i])
  }
  return s.trim()
}

const presetId = (prefix: string, name: string) =>
  prefix + '-' + (name.replace(/[^A-Za-z0-9_-]/g, '_').replace(/_+/g, '_').slice(0, 32) || 'preset')

/** Parse a Nikon Picture Control file (flexible "0310" NP3 fully; classic
 * "0100" NCP sliders best-effort) into an editable PictureControl. */
export function parseNp3(buf: ArrayBuffer, fileName = 'preset.np3'): PictureControl {
  const u8 = new Uint8Array(buf)
  if (u8.length < 16 || ascii(u8, 0, 3) !== 'NCP') {
    throw new Error('NCP 매직 없음 — Picture Control 파일이 아닙니다')
  }
  const version = ascii(u8, 12, 4)
  if (version === '0100') return parseClassicNcp(u8, fileName)
  if (version !== '0310') {
    throw new Error(`Picture Control 버전 ${version}은 아직 파싱하지 못합니다 (0310/0100만 지원)`)
  }

  const dv = new DataView(buf)
  const records = new Map<number, Uint8Array>()
  let curve: CurvePoint[] | null = null
  let o = 16
  while (o + 8 <= u8.length) {
    const id = dv.getUint32(o, false)
    const len = dv.getUint32(o + 4, false)
    if (id === 0 && len === 0) {
      o += 8
      continue
    }
    if (o + 8 + len > u8.length) break
    const val = u8.subarray(o + 8, o + 8 + len)
    if (id === 0x00010100) {
      // comment chunk — provenance only, not part of the look
    } else if (id === 0x00000002 && len >= 64) {
      curve = curveFromChunk(val)
    } else {
      records.set(id, val)
    }
    o += 8 + len
  }

  // 0x80-based slider byte → value; 0xff (n/a), 0x00 (auto), 0x01 (user curve) → 0
  const slider = (id: number): number => {
    const v = records.get(id)?.[0]
    return v === undefined || v === 0xff || v === 0x00 || v === 0x01 ? 0 : v - 0x80
  }
  const name = ascii(u8, 24, 20) || fileName.replace(/\.(np3|ncp|np2)$/i, '').slice(0, 19)

  const blender = records.get(0x1f00)
  const band = (base: number, k: number) =>
    blender && blender.length >= 24 ? blender[base * 3 + k] - 0x80 : 0
  const grading = records.get(0x2000)
  const gradeBand = (i: number) =>
    grading && grading.length >= 20
      ? {
          h: ((grading[i * 4] & 0x0f) << 8) | grading[i * 4 + 1],
          // writer stores ACR-style region saturation on a ≈¼ scale
          s: clamp((grading[i * 4 + 2] - 0x80) * 4, 0, 100),
          l: grading[i * 4 + 3] - 0x80
        }
      : { h: 0, s: 0, l: 0 }

  const acr: AcrParams = {
    contrast: slider(0x1900),
    highlights: slider(0x1a00),
    shadows: slider(0x1b00),
    whites: slider(0x1c00),
    blacks: slider(0x1d00),
    saturation: slider(0x1e00),
    sharpenAmount: clamp(Math.round((slider(0x0600) / 4) * 16.7), 0, 150),
    clarity: clamp(slider(0x0700) * 5, -100, 100),
    texture: clamp(slider(0x1600) * 5, -100, 100),
    hueAdjust: [0, 1, 2, 3, 4, 5, 6, 7].map((i) => band(i, 0)),
    satAdjust: [0, 1, 2, 3, 4, 5, 6, 7].map((i) => band(i, 1)),
    lumAdjust: [0, 1, 2, 3, 4, 5, 6, 7].map((i) => band(i, 2)),
    grade: {
      highlight: gradeBand(0), // stored order: highlights, midtone, shadows
      midtone: gradeBand(1),
      shadow: gradeBand(2),
      global: { h: 0, s: 0, l: 0 }, // NP3 grading has no global band
      blending: grading && grading.length >= 20 ? grading[16] - 0x80 : 50,
      balance: grading && grading.length >= 20 ? grading[18] - 0x80 : 0
    },
    monochrome: false
  }

  return {
    id: presetId('np3', name),
    name: name.slice(0, 40),
    mode: 'color',
    curve: curve ?? identityCurve(),
    brightness: 0,
    contrast: 0,
    saturation: 0,
    hue: 0,
    sharpening: 0,
    filter: 'none',
    monoTone: null,
    toning: null,
    acr
  }
}

// classic "0100" NCP: 12B header, version(4) name(20) base(u16) mod(1) pad(1),
// then sharpening/contrast/brightness/saturation/hue/filter/toning/toning-
// saturation as single 0x80-based bytes (0x00 auto, 0x01 user curve, 0xff n/a)
const NCP_FILTERS: PictureControl['filter'][] = ['none', 'yellow', 'orange', 'red', 'green']
const NCP_TONING: MonoToningType[] = [
  'none', 'sepia', 'cyanotype', 'red', 'yellow',
  'green', 'blueGreen', 'blue', 'purpleBlue', 'redPurple'
]

function parseClassicNcp(u8: Uint8Array, fileName: string): PictureControl {
  const name = ascii(u8, 16, 20) || fileName.replace(/\.(np3|ncp|np2)$/i, '').slice(0, 19)
  const base = u8.length >= 38 ? (u8[36] << 8) | u8[37] : 0
  const raw = (o: number) => (o < u8.length ? u8[o] : 0xff)
  const val = (o: number) => {
    const v = raw(o)
    return v === 0xff || v === 0x00 || v === 0x01 ? 0 : v - 0x80
  }
  // enum bytes are either 0x80-based codes or small plain indices
  const code = (o: number) => {
    const v = raw(o)
    if (v === 0xff) return 0
    return v >= 0x80 ? v - 0x80 : v
  }
  const mono = base === 0x064d // MONOCHROME base profile
  const sc = (v: number, f: number) => Math.round(Math.max(-3, Math.min(3, v)) * f)
  const toning = NCP_TONING[code(46)] ?? 'none'
  return {
    id: presetId('ncp', name),
    name: name.slice(0, 40),
    mode: mono ? 'monochrome' : 'color',
    curve: identityCurve(),
    brightness: sc(val(42), 15),
    contrast: sc(val(41), 15),
    saturation: mono ? 0 : sc(val(43), 15),
    hue: mono ? 0 : sc(val(44), 4),
    sharpening: Math.max(0, Math.min(100, raw(40) >= 0x80 ? (raw(40) - 0x80) * 11 : 0)),
    filter: mono ? NCP_FILTERS[code(45)] ?? 'none' : 'none',
    monoTone:
      mono && toning !== 'none'
        ? { type: toning, density: Math.max(1, Math.min(7, val(47) || 4)) }
        : null,
    toning: null
  }
}
