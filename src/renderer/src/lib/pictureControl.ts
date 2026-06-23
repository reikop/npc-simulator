// Picture Control recipe model + a canvas image-processing pipeline.
// Everything here is original code that approximates the *look* of Nikon Picture
// Controls; it is not Nikon's proprietary algorithm and produces a preview only.

import { applyAcr } from './acr'

export interface CurvePoint {
  x: number // input 0..255
  y: number // output 0..255
}

/** Monochrome toning: a named tint at density 1..7. nikonpc.com ships sepia /
 * cyanotype / red; the remaining six were stubbed out there — we implement them. */
export type MonoToningType =
  | 'none'
  | 'sepia'
  | 'cyanotype'
  | 'red'
  | 'yellow'
  | 'green'
  | 'blueGreen'
  | 'blue'
  | 'purpleBlue'
  | 'redPurple'
export interface MonoTone {
  type: MonoToningType
  density: number // 1..7
}

/** All selectable toning types (for the editor dropdown). */
export const TONING_TYPES: { value: MonoToningType; label: string }[] = [
  { value: 'none', label: '없음' },
  { value: 'sepia', label: '세피아' },
  { value: 'cyanotype', label: '시아노타입' },
  { value: 'red', label: '레드' },
  { value: 'yellow', label: '옐로' },
  { value: 'green', label: '그린' },
  { value: 'blueGreen', label: '블루그린' },
  { value: 'blue', label: '블루' },
  { value: 'purpleBlue', label: '퍼플블루' },
  { value: 'redPurple', label: '레드퍼플' }
]

export interface PictureControl {
  id: string
  name: string
  /** 'color' applies saturation/hue; 'monochrome' converts to B&W + toning. */
  mode: 'color' | 'monochrome'
  /** Master tone curve, sorted by x. Identity = [{0,0},{255,255}]. */
  curve: CurvePoint[]
  brightness: number // -100..100
  contrast: number // -100..100
  saturation: number // -100..100
  hue: number // -180..180 degrees
  sharpening: number // 0..100 (unsharp amount)
  /** B&W channel filter, mimics colored lens filters (manual feature). */
  filter: 'none' | 'yellow' | 'orange' | 'red' | 'green'
  /** Monochrome toning (named tint + density), as nikonpc.com renders it. */
  monoTone?: MonoTone | null
  /** Colour-mode tint (our extra). null = off. */
  toning: { color: string; strength: number } | null // strength 0..100
  /**
   * Full Adobe Camera Raw parameter set, present only on presets imported from
   * an .xmp. When set, the render pipeline runs the high-fidelity ACR path
   * (see acr.ts) so the imported look is reproduced faithfully; the master tone
   * curve above stays the editable point curve.
   */
  acr?: import('./acr').AcrParams
}

// Per-density [R,G,B] offsets added to the grey value. sepia / cyanotype / red
// reproduce nikonpc.com's own tables; the other six (stubbed to [0,0,0] there)
// are built from a base tint vector scaled across the seven density steps,
// using the same accelerating progression as sepia.
function ramp(base: [number, number, number]): number[][] {
  const k = [1, 1.9, 2.8, 3.7, 4.8, 5.8, 6.8]
  return k.map((m) => base.map((v) => Math.round(v * m)))
}

const TONING_OFFSETS: Record<Exclude<MonoToningType, 'none'>, number[][]> = {
  sepia: [
    [10, -2, -10], [19, -3, -19], [28, -5, -29], [37, -6, -39],
    [48, -8, -52], [58, -10, -65], [68, -12, -78]
  ],
  cyanotype: [
    [-2, -1, 10], [-4, -2, 19], [-6, -3, 29], [-7, -4, 38],
    [-10, -5, 48], [-12, -6, 59], [-14, -7, 70]
  ],
  red: [
    [14, -4, -6], [27, -7, -12], [40, -11, -18], [52, -15, -24],
    [66, -19, -31], [80, -23, -39], [93, -28, -47]
  ],
  yellow: ramp([9, 5, -13]), // warm, drops blue
  green: ramp([-7, 8, -6]),
  blueGreen: ramp([-9, 4, 9]), // teal
  blue: ramp([-5, -6, 13]),
  purpleBlue: ramp([3, -8, 13]), // indigo / violet
  redPurple: ramp([13, -10, 7]) // magenta
}

/** Resolve a MonoTone to its [R,G,B] grey offset, or null for none. */
export function monoToneOffset(t: MonoTone | null | undefined): [number, number, number] | null {
  if (!t || t.type === 'none') return null
  const table = TONING_OFFSETS[t.type]
  if (!table) return null
  const d = Math.max(1, Math.min(7, Math.round(t.density))) - 1
  const o = table[d]
  return [o[0], o[1], o[2]]
}

export function identityCurve(): CurvePoint[] {
  return [
    { x: 0, y: 0 },
    { x: 255, y: 255 }
  ]
}

export function defaultControl(): PictureControl {
  return {
    id: 'standard',
    name: 'Standard',
    mode: 'color',
    curve: identityCurve(),
    brightness: 0,
    contrast: 0,
    saturation: 0,
    hue: 0,
    sharpening: 0,
    filter: 'none',
    monoTone: null,
    toning: null
  }
}

// ---------------------------------------------------------------------------
// Tone curve -> 256-entry LUT (monotone-ish Catmull-Rom through sorted points)
// ---------------------------------------------------------------------------

export function buildCurveLut(points: CurvePoint[]): Uint8ClampedArray {
  const pts = [...points].sort((a, b) => a.x - b.x)
  const lut = new Uint8ClampedArray(256)
  if (pts.length === 0) {
    for (let i = 0; i < 256; i++) lut[i] = i
    return lut
  }
  const sample = (x: number): number => {
    if (x <= pts[0].x) return pts[0].y
    if (x >= pts[pts.length - 1].x) return pts[pts.length - 1].y
    let i = 0
    while (i < pts.length - 1 && pts[i + 1].x < x) i++
    const p0 = pts[Math.max(0, i - 1)]
    const p1 = pts[i]
    const p2 = pts[Math.min(pts.length - 1, i + 1)]
    const p3 = pts[Math.min(pts.length - 1, i + 2)]
    const span = p2.x - p1.x || 1
    const t = (x - p1.x) / span
    const t2 = t * t
    const t3 = t2 * t
    // Catmull-Rom
    const y =
      0.5 *
      (2 * p1.y +
        (-p0.y + p2.y) * t +
        (2 * p0.y - 5 * p1.y + 4 * p2.y - p3.y) * t2 +
        (-p0.y + 3 * p1.y - 3 * p2.y + p3.y) * t3)
    return y
  }
  for (let i = 0; i < 256; i++) lut[i] = Math.round(sample(i))
  return lut
}

/** Fold brightness + contrast + curve into a single 256 LUT for speed. */
function buildToneLut(pc: PictureControl): Uint8ClampedArray {
  const curveLut = buildCurveLut(pc.curve)
  const b = pc.brightness * 1.28 // -128..128
  const c = pc.contrast / 100 // -1..1
  // contrast factor (standard formula)
  const cf = (259 * (c * 255 + 255)) / (255 * (259 - c * 255))
  const out = new Uint8ClampedArray(256)
  for (let i = 0; i < 256; i++) {
    let v = curveLut[i]
    v = cf * (v - 128) + 128 + b
    out[i] = v < 0 ? 0 : v > 255 ? 255 : v
  }
  return out
}

const FILTER_WEIGHTS: Record<PictureControl['filter'], [number, number, number]> = {
  none: [0.21, 0.71, 0.07], // nikonpc.com's monochrome luma weights
  yellow: [0.35, 0.55, 0.1],
  orange: [0.5, 0.42, 0.08],
  red: [0.7, 0.25, 0.05],
  green: [0.2, 0.7, 0.1]
}

function hexToRgb(hex: string): [number, number, number] {
  const m = hex.replace('#', '')
  const n = parseInt(m.length === 3 ? m.replace(/(.)/g, '$1$1') : m, 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}

// ---------------------------------------------------------------------------
// Main pipeline: mutate an ImageData in place.
// ---------------------------------------------------------------------------

export function applyPictureControl(img: ImageData, pc: PictureControl): void {
  // High-fidelity path for XMP-imported presets: render the full ACR parameter
  // set (white balance, region tone, HSL, colour grading, grain, …).
  if (pc.acr) {
    applyAcr(img, pc.acr, pc.curve)
    if (pc.sharpening > 0) unsharpMask(img, pc.sharpening / 100)
    return
  }

  const d = img.data
  const tone = buildToneLut(pc)

  // 1) tone curve (+ folded brightness/contrast), per channel
  for (let i = 0; i < d.length; i += 4) {
    d[i] = tone[d[i]]
    d[i + 1] = tone[d[i + 1]]
    d[i + 2] = tone[d[i + 2]]
  }

  if (pc.mode === 'monochrome') {
    // 2a) grey conversion + named toning, reproducing nikonpc.com:
    //     grey = weighted luma, then add the toning's per-density [R,G,B] offset.
    const [fw, fg, fb] = FILTER_WEIGHTS[pc.filter]
    const off = monoToneOffset(pc.monoTone)
    for (let i = 0; i < d.length; i += 4) {
      let y = fw * d[i] + fg * d[i + 1] + fb * d[i + 2]
      if (y > 255) y = 255
      if (off) {
        d[i] = y > 255 - off[0] ? 255 : y + off[0]
        d[i + 1] = y < off[1] ? 0 : y + off[1]
        d[i + 2] = y < off[2] ? 0 : y + off[2]
      } else {
        d[i] = y
        d[i + 1] = y
        d[i + 2] = y
      }
    }
  } else {
    // 2b) saturation + hue in HSL space (matches nikonpc.com's adjustment).
    //     pc.saturation is the -45..45 scale, pc.hue is degrees.
    if (pc.saturation !== 0 || pc.hue !== 0) {
      adjustSaturationHue(d, pc.hue, pc.saturation)
    }
    // optional color toning tint (our own extra)
    if (pc.toning) {
      const ton = hexToRgb(pc.toning.color)
      const tonS = pc.toning.strength / 100
      for (let i = 0; i < d.length; i += 4) {
        d[i] = d[i] + (ton[0] - d[i]) * tonS * 0.5
        d[i + 1] = d[i + 1] + (ton[1] - d[i + 1]) * tonS * 0.5
        d[i + 2] = d[i + 2] + (ton[2] - d[i + 2]) * tonS * 0.5
      }
    }
  }

  if (pc.sharpening > 0) unsharpMask(img, pc.sharpening / 100)
}

/**
 * Saturation + hue rotation done in HSL space, reproducing the semantics used
 * by nikonpc.com: a positive saturation `s` (on a roughly -45..45 scale) boosts
 * HSL saturation by a factor `1 + 2*(s/100)`, a negative one by `1 + s/100`;
 * `hueDeg` rotates the hue around the colour wheel. Operates in place on RGBA.
 */
function adjustSaturationHue(d: Uint8ClampedArray, hueDeg: number, sat: number): void {
  const o = sat / 100
  const satMul = o < 0 ? 1 + o : 1 + 2 * o
  const hueShift = ((((hueDeg % 360) + 360) % 360) / 360) * 6 // in 0..6 sextants

  for (let i = 0; i < d.length; i += 4) {
    const R = d[i]
    const G = d[i + 1]
    const B = d[i + 2]
    const max = R > G ? (R > B ? R : B) : G > B ? G : B
    const min = R < G ? (R < B ? R : B) : G < B ? G : B
    const chroma = max - min
    const lum = (max + min) / 510 // 0..1
    if (lum <= 0 || chroma <= 0) continue // grey pixel: hue/sat undefined

    // boosted HSL saturation -> new "top" value y
    let s: number
    if (lum <= 0.5) s = (chroma / (max + min)) * satMul
    else s = (chroma / (510 - max - min)) * satMul
    if (s > 1) s = 1
    const y = lum <= 0.5 ? lum * (1 + s) : lum + s - lum * s
    const c = 2 * lum - y // bottom value

    // hue as a 0..6 sextant coordinate, then shift
    let h: number
    if (max === R) h = min === G ? 5 + (max - B) / chroma : 1 - (max - G) / chroma
    else if (max === G) h = min === B ? 1 + (max - R) / chroma : 3 - (max - B) / chroma
    else h = min === R ? 3 + (max - G) / chroma : 5 - (max - R) / chroma
    h += hueShift
    if (h < 0) h += 6
    else if (h >= 6) h -= 6

    const seg = h | 0
    const t = h - seg
    let nr: number
    let ng: number
    let nb: number
    switch (seg) {
      case 0:
        nr = y
        ng = c + (y - c) * t
        nb = c
        break
      case 1:
        nr = y - (y - c) * t
        ng = y
        nb = c
        break
      case 2:
        nr = c
        ng = y
        nb = c + (y - c) * t
        break
      case 3:
        nr = c
        ng = y - (y - c) * t
        nb = y
        break
      case 4:
        nr = c + (y - c) * t
        ng = c
        nb = y
        break
      default:
        nr = y
        ng = c
        nb = y - (y - c) * t
    }
    d[i] = nr * 255
    d[i + 1] = ng * 255
    d[i + 2] = nb * 255
  }
}

/** Simple 3x3 unsharp mask. amount 0..~1.5 */
function unsharpMask(img: ImageData, amount: number): void {
  const { width: w, height: h, data } = img
  const src = new Uint8ClampedArray(data)
  const k = amount
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const o = (y * w + x) * 4
      for (let c = 0; c < 3; c++) {
        const center = src[o + c]
        const blur =
          (src[o - 4 + c] +
            src[o + 4 + c] +
            src[o - w * 4 + c] +
            src[o + w * 4 + c] +
            4 * center) /
          8
        const v = center + (center - blur) * k * 4
        data[o + c] = v < 0 ? 0 : v > 255 ? 255 : v
      }
    }
  }
}
