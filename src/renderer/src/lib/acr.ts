// Adobe Camera Raw "develop" pipeline — an honest approximation.
//
// This consumes the full AcrParams block produced from an .xmp preset and
// renders every meaningful parameter, so nothing the XMP carries is silently
// dropped. It is NOT a colour-managed clone of Adobe's proprietary engine: we
// work on an 8-bit sRGB preview (JPEG / NEF embedded JPEG), not scene-linear
// RAW, and the per-slider math below is a faithful-look reconstruction, not
// Adobe's exact algorithm. Stages we cannot do on a baked preview (lens
// geometry / CA removal, precise demosaic-stage noise reduction, local mask
// adjustments) are intentionally omitted; see xmp.ts for what is dropped.

import type { CurvePoint } from './pictureControl'
import { buildCurveLut } from './pictureControl'

export interface GradeBand {
  h: number // hue 0..360
  s: number // saturation 0..100
  l: number // luminance -100..100
}

export interface AcrParams {
  // white balance — normalised deltas (-1..1) relative to the as-shot WB
  wbTemp?: number
  wbTint?: number
  // basic tone (Adobe units)
  exposure?: number // stops
  contrast?: number // -100..100
  highlights?: number // -100..100
  shadows?: number // -100..100
  whites?: number // -100..100
  blacks?: number // -100..100
  // presence
  texture?: number // -100..100
  clarity?: number // -100..100
  dehaze?: number // -100..100
  vibrance?: number // -100..100
  saturation?: number // -100..100 (global)
  // parametric tone curve
  paramShadows?: number
  paramDarks?: number
  paramLights?: number
  paramHighlights?: number
  paramShadowSplit?: number // 0..100 (default 25)
  paramMidSplit?: number // default 50
  paramHighlightSplit?: number // default 75
  // per-channel point curves (0..255), null/absent = identity
  curveRed?: CurvePoint[]
  curveGreen?: CurvePoint[]
  curveBlue?: CurvePoint[]
  // HSL — 8 bands: red, orange, yellow, green, aqua, blue, purple, magenta
  hueAdjust?: number[] // each -100..100
  satAdjust?: number[]
  lumAdjust?: number[]
  // colour grading (3-way + global) — supersedes split toning
  grade?: {
    shadow: GradeBand
    midtone: GradeBand
    highlight: GradeBand
    global: GradeBand
    blending: number // 0..100
    balance: number // -100..100
  }
  // detail
  sharpenAmount?: number // 0..150 (Adobe Sharpness)
  sharpenRadius?: number // 0.5..3
  sharpenDetail?: number // 0..100
  sharpenMasking?: number // 0..100
  // grain
  grainAmount?: number // 0..100
  grainSize?: number // 0..100
  grainFreq?: number // 0..100
  // greyscale conversion
  monochrome?: boolean
}

const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v)
const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v)

function smoothstep(a: number, b: number, x: number): number {
  const t = clamp01((x - a) / (b - a || 1))
  return t * t * (3 - 2 * t)
}

// ---- HSL helpers (full, for the colour stages) ----------------------------
function rgb2hsl(r: number, g: number, b: number): [number, number, number] {
  r /= 255
  g /= 255
  b /= 255
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  const l = (max + min) / 2
  const d = max - min
  if (d === 0) return [0, 0, l]
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min)
  let h: number
  if (max === r) h = ((g - b) / d) % 6
  else if (max === g) h = (b - r) / d + 2
  else h = (r - g) / d + 4
  h *= 60
  if (h < 0) h += 360
  return [h, s, l]
}

function hue2rgb(p: number, q: number, t: number): number {
  if (t < 0) t += 1
  if (t > 1) t -= 1
  if (t < 1 / 6) return p + (q - p) * 6 * t
  if (t < 1 / 2) return q
  if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6
  return p
}

function hsl2rgb(h: number, s: number, l: number): [number, number, number] {
  h = ((h % 360) + 360) % 360 / 360
  if (s === 0) {
    const v = l * 255
    return [v, v, v]
  }
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s
  const p = 2 * l - q
  return [
    hue2rgb(p, q, h + 1 / 3) * 255,
    hue2rgb(p, q, h) * 255,
    hue2rgb(p, q, h - 1 / 3) * 255
  ]
}

const LUMA_R = 0.2126
const LUMA_G = 0.7152
const LUMA_B = 0.0722

// ---- tone: build a per-channel 256 LUT folding exposure/contrast/region ----
// Exported: np3.ts bakes this LUT into the NP3 tone-curve chunk on export.
export function buildToneLut(a: AcrParams, master: CurvePoint[]): Uint8ClampedArray {
  // Exposure on a display-referred 8-bit preview must PRESERVE the endpoints,
  // otherwise a negative EV drags an already-blown sky down to grey (Adobe runs
  // exposure in scene-linear RAW where blown highlights have headroom). An
  // endpoint-preserving gamma (0→0, 1→1, mids shift) matches the look far better
  // than a linear gain.
  const ev = a.exposure ?? 0
  const expGamma = Math.pow(2, -ev) // EV<0 → gamma>1 → darker mids, white stays white
  const c = (a.contrast ?? 0) / 100
  const hi = (a.highlights ?? 0) / 100
  const sh = (a.shadows ?? 0) / 100
  const wh = (a.whites ?? 0) / 100
  const bl = (a.blacks ?? 0) / 100
  const masterLut = buildCurveLut(master)
  const paramLut = buildParametricLut(a)

  const lut = new Uint8ClampedArray(256)
  for (let i = 0; i < 256; i++) {
    let v = i / 255
    if (ev) v = Math.pow(v, expGamma) // exposure (endpoint-preserving)
    // contrast around mid-grey, soft-clipped so highlights don't hard-flatten
    v = (v - 0.5) * (1 + c) + 0.5
    // whites / blacks shift the extremes (Adobe sign: + brightens that end)
    v += wh * 0.18 * smoothstep(0.5, 1, v)
    v += bl * 0.18 * (1 - smoothstep(0, 0.5, v))
    // highlight recovery / shadow lift (region weighted)
    v += hi * 0.4 * smoothstep(0.35, 1, v)
    v += sh * 0.4 * (1 - smoothstep(0, 0.65, v))
    v = clamp01(v)
    let out = Math.round(v * 255)
    out = paramLut[out] // parametric region curve
    out = masterLut[out] // master point curve
    lut[i] = out
  }
  return lut
}

// Adobe parametric curve: 4 region sliders split by 3 thresholds.
function buildParametricLut(a: AcrParams): Uint8ClampedArray {
  const lut = new Uint8ClampedArray(256)
  const ps = (a.paramShadows ?? 0) / 100
  const pd = (a.paramDarks ?? 0) / 100
  const pl = (a.paramLights ?? 0) / 100
  const ph = (a.paramHighlights ?? 0) / 100
  if (!ps && !pd && !pl && !ph) {
    for (let i = 0; i < 256; i++) lut[i] = i
    return lut
  }
  const sSplit = (a.paramShadowSplit ?? 25) / 100
  const mSplit = (a.paramMidSplit ?? 50) / 100
  const hSplit = (a.paramHighlightSplit ?? 75) / 100
  for (let i = 0; i < 256; i++) {
    const x = i / 255
    // bell weights centred on each region, bounded by the splits
    const wShadow = 1 - smoothstep(0, sSplit * 2, x)
    const wHigh = smoothstep(hSplit, 1, x)
    const wDark = smoothstep(0, mSplit, x) * (1 - smoothstep(mSplit, hSplit, x))
    const wLight = smoothstep(sSplit, mSplit, x) * (1 - smoothstep(hSplit, 1, x))
    const delta = (ps * wShadow + pd * wDark + pl * wLight + ph * wHigh) * 0.25
    lut[i] = clamp(Math.round((x + delta) * 255), 0, 255)
  }
  return lut
}

// ---------------------------------------------------------------------------
// Main entry: mutate ImageData in place with the full ACR parameter set.
// ---------------------------------------------------------------------------
export function applyAcr(
  img: ImageData,
  a: AcrParams,
  master: CurvePoint[]
): void {
  const d = img.data

  // 1) white balance gains (applied before the tone LUT)
  const t = a.wbTemp ?? 0
  const ti = a.wbTint ?? 0
  const gR = 1 + 0.25 * t + 0.1 * ti
  const gG = 1 - 0.12 * ti
  const gB = 1 - 0.25 * t + 0.1 * ti

  // 2) tone LUT (exposure/contrast/region/parametric/master) + per-channel curves
  const tone = buildToneLut(a, master)
  const rCurve = a.curveRed ? buildCurveLut(a.curveRed) : null
  const gCurve = a.curveGreen ? buildCurveLut(a.curveGreen) : null
  const bCurve = a.curveBlue ? buildCurveLut(a.curveBlue) : null
  for (let i = 0; i < d.length; i += 4) {
    let r = tone[clamp(Math.round(d[i] * gR), 0, 255)]
    let g = tone[clamp(Math.round(d[i + 1] * gG), 0, 255)]
    let b = tone[clamp(Math.round(d[i + 2] * gB), 0, 255)]
    if (rCurve) r = rCurve[r]
    if (gCurve) g = gCurve[g]
    if (bCurve) b = bCurve[b]
    d[i] = r
    d[i + 1] = g
    d[i + 2] = b
  }

  // 3) local contrast: clarity / texture / dehaze
  if ((a.clarity ?? 0) || (a.texture ?? 0) || (a.dehaze ?? 0)) {
    localContrast(img, a)
  }

  // 4) colour: HSL 8-band + vibrance + global saturation (single pass)
  const needHsl =
    !a.monochrome &&
    (hasAny(a.hueAdjust) ||
      hasAny(a.satAdjust) ||
      hasAny(a.lumAdjust) ||
      (a.vibrance ?? 0) !== 0 ||
      (a.saturation ?? 0) !== 0)
  if (needHsl) hslStage(d, a)

  // 5) greyscale (if the preset converts to B&W) — luma mix
  if (a.monochrome) {
    for (let i = 0; i < d.length; i += 4) {
      const y = LUMA_R * d[i] + LUMA_G * d[i + 1] + LUMA_B * d[i + 2]
      d[i] = d[i + 1] = d[i + 2] = y
    }
  }

  // 6) colour grading / split toning (3-way + global)
  if (a.grade && gradeActive(a.grade)) gradeStage(d, a.grade)

  // 7) sharpening (amount + radius + masking)
  if ((a.sharpenAmount ?? 0) > 0) {
    sharpen(img, a)
  }

  // 8) film grain
  if ((a.grainAmount ?? 0) > 0) grain(img, a)
}

function hasAny(arr?: number[]): boolean {
  return !!arr && arr.some((v) => v !== 0)
}

// 8 Adobe HSL band centres (degrees), in hue order.
const BAND_HUE = [0, 30, 60, 120, 180, 240, 270, 300]

function bandWeights(h: number, out: number[]): void {
  for (let i = 0; i < 8; i++) out[i] = 0
  // find the two band anchors surrounding h and split linearly
  let lo = 7
  for (let i = 0; i < 8; i++) {
    if (BAND_HUE[i] <= h) lo = i
  }
  const hiIdx = (lo + 1) % 8
  let a = BAND_HUE[lo]
  let b = BAND_HUE[hiIdx]
  if (b <= a) b += 360
  let x = h
  if (x < a) x += 360
  const t = (x - a) / (b - a || 1)
  out[lo] = 1 - t
  out[hiIdx] = t
}

function hslStage(d: Uint8ClampedArray, a: AcrParams): void {
  const hueA = a.hueAdjust ?? [0, 0, 0, 0, 0, 0, 0, 0]
  const satA = a.satAdjust ?? [0, 0, 0, 0, 0, 0, 0, 0]
  const lumA = a.lumAdjust ?? [0, 0, 0, 0, 0, 0, 0, 0]
  const vib = (a.vibrance ?? 0) / 100
  const satG = (a.saturation ?? 0) / 100
  const w = [0, 0, 0, 0, 0, 0, 0, 0]
  for (let i = 0; i < d.length; i += 4) {
    let [h, s, l] = rgb2hsl(d[i], d[i + 1], d[i + 2])
    if (s > 0) {
      bandWeights(h, w)
      let dHue = 0
      let dSat = 0
      let dLum = 0
      for (let k = 0; k < 8; k++) {
        if (w[k] === 0) continue
        dHue += w[k] * hueA[k]
        dSat += w[k] * satA[k]
        dLum += w[k] * lumA[k]
      }
      // Gate by saturation: near-neutral pixels (a blown blue-ish sky) must stay
      // largely unaffected, otherwise a strong band luminance like Blue −65
      // greys out the highlights — Adobe's HSL barely touches low-sat pixels.
      const satGate = Math.min(1, s * 4)
      h += dHue * 0.3 * satGate // ±100 → ±30°
      s *= 1 + (dSat / 100) * satGate
      l = clamp01(l + (dLum / 100) * 0.2 * satGate)
    }
    // vibrance: boost low-saturation pixels more (skin protection)
    if (vib) s += vib * (1 - s) * 0.6
    // global saturation
    if (satG) s *= 1 + satG
    s = clamp01(s)
    const [r, g, b] = hsl2rgb(h, s, l)
    d[i] = r
    d[i + 1] = g
    d[i + 2] = b
  }
}

function gradeActive(g: NonNullable<AcrParams['grade']>): boolean {
  return (
    g.shadow.s > 0 ||
    g.highlight.s > 0 ||
    g.midtone.s > 0 ||
    g.global.s > 0 ||
    g.shadow.l !== 0 ||
    g.midtone.l !== 0 ||
    g.highlight.l !== 0 ||
    g.global.l !== 0
  )
}

function gradeStage(d: Uint8ClampedArray, g: NonNullable<AcrParams['grade']>): void {
  const blend = clamp((g.blending ?? 100) / 100, 0, 1)
  const bal = (g.balance ?? 0) / 100 // -1..1, + favours highlights
  // pre-compute each band's tint direction (unit-ish RGB offset from grey)
  const dir = (band: GradeBand): [number, number, number, number] => {
    const [r, gg, b] = hsl2rgb(band.h, clamp01(band.s / 100), 0.5)
    return [(r - 127.5) / 127.5, (gg - 127.5) / 127.5, (b - 127.5) / 127.5, band.s / 100]
  }
  const sd = dir(g.shadow)
  const md = dir(g.midtone)
  const hd = dir(g.highlight)
  const gd = dir(g.global)
  const sL = g.shadow.l / 100
  const mL = g.midtone.l / 100
  const hL = g.highlight.l / 100
  const gL = g.global.l / 100
  const strength = 40 * blend

  for (let i = 0; i < d.length; i += 4) {
    const Y = (LUMA_R * d[i] + LUMA_G * d[i + 1] + LUMA_B * d[i + 2]) / 255
    // region weights, balance shifts the shadow/highlight pivot
    const pivot = 0.5 + bal * 0.3
    let wSh = 1 - smoothstep(0, pivot, Y)
    let wHi = smoothstep(pivot, 1, Y)
    let wMid = 1 - wSh - wHi
    if (wMid < 0) wMid = 0
    const addR =
      (sd[0] * sd[3] * wSh + md[0] * md[3] * wMid + hd[0] * hd[3] * wHi + gd[0] * gd[3]) *
      strength
    const addG =
      (sd[1] * sd[3] * wSh + md[1] * md[3] * wMid + hd[1] * hd[3] * wHi + gd[1] * gd[3]) *
      strength
    const addB =
      (sd[2] * sd[3] * wSh + md[2] * md[3] * wMid + hd[2] * hd[3] * wHi + gd[2] * gd[3]) *
      strength
    const addL = (sL * wSh + mL * wMid + hL * wHi + gL) * 60
    d[i] = clamp(d[i] + addR + addL, 0, 255)
    d[i + 1] = clamp(d[i + 1] + addG + addL, 0, 255)
    d[i + 2] = clamp(d[i + 2] + addB + addL, 0, 255)
  }
}

// Box blur one channel (luminance) — separable, radius in px.
function boxBlurLuma(src: Float32Array, w: number, h: number, radius: number): Float32Array {
  const r = Math.max(1, Math.round(radius))
  const tmp = new Float32Array(src.length)
  const out = new Float32Array(src.length)
  const norm = 1 / (2 * r + 1)
  // horizontal
  for (let y = 0; y < h; y++) {
    const row = y * w
    let acc = 0
    for (let x = -r; x <= r; x++) acc += src[row + clamp(x, 0, w - 1)]
    for (let x = 0; x < w; x++) {
      tmp[row + x] = acc * norm
      const add = src[row + clamp(x + r + 1, 0, w - 1)]
      const sub = src[row + clamp(x - r, 0, w - 1)]
      acc += add - sub
    }
  }
  // vertical
  for (let x = 0; x < w; x++) {
    let acc = 0
    for (let y = -r; y <= r; y++) acc += tmp[clamp(y, 0, h - 1) * w + x]
    for (let y = 0; y < h; y++) {
      out[y * w + x] = acc * norm
      const add = tmp[clamp(y + r + 1, 0, h - 1) * w + x]
      const sub = tmp[clamp(y - r, 0, h - 1) * w + x]
      acc += add - sub
    }
  }
  return out
}

function localContrast(img: ImageData, a: AcrParams): void {
  const { width: w, height: h, data: d } = img
  const n = w * h
  const luma = new Float32Array(n)
  for (let i = 0, p = 0; i < d.length; i += 4, p++) {
    luma[p] = LUMA_R * d[i] + LUMA_G * d[i + 1] + LUMA_B * d[i + 2]
  }
  const clarity = (a.clarity ?? 0) / 100
  const texture = (a.texture ?? 0) / 100
  const dehaze = (a.dehaze ?? 0) / 100
  // clarity: large-radius local contrast; texture: small radius; dehaze ~ clarity+
  const big = boxBlurLuma(luma, w, h, Math.max(8, Math.round(Math.min(w, h) / 40)))
  const small = clarity || texture ? boxBlurLuma(luma, w, h, 3) : big
  for (let i = 0, p = 0; i < d.length; i += 4, p++) {
    const detailBig = luma[p] - big[p]
    const detailSmall = luma[p] - small[p]
    const boost =
      detailBig * (clarity + dehaze * 0.8) * 1.5 + detailSmall * texture * 1.2
    if (boost === 0) continue
    d[i] = clamp(d[i] + boost, 0, 255)
    d[i + 1] = clamp(d[i + 1] + boost, 0, 255)
    d[i + 2] = clamp(d[i + 2] + boost, 0, 255)
  }
  // dehaze also lifts global contrast + saturation slightly
  if (dehaze > 0) {
    for (let i = 0; i < d.length; i += 4) {
      for (let c = 0; c < 3; c++) {
        const v = d[i + c]
        d[i + c] = clamp((v - 128) * (1 + dehaze * 0.3) + 128, 0, 255)
      }
    }
  }
}

function sharpen(img: ImageData, a: AcrParams): void {
  const { width: w, height: h, data } = img
  const amount = (a.sharpenAmount ?? 0) / 100
  const radius = Math.max(1, Math.round(a.sharpenRadius ?? 1))
  const masking = (a.sharpenMasking ?? 0) / 100
  const src = new Uint8ClampedArray(data)
  const luma = new Float32Array(w * h)
  for (let i = 0, p = 0; i < src.length; i += 4, p++) {
    luma[p] = LUMA_R * src[i] + LUMA_G * src[i + 1] + LUMA_B * src[i + 2]
  }
  const blur = boxBlurLuma(luma, w, h, radius)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const p = y * w + x
      const o = p * 4
      // masking: skip flat areas (low local gradient)
      if (masking > 0) {
        const gx = Math.abs(
          luma[y * w + Math.min(w - 1, x + 1)] - luma[y * w + Math.max(0, x - 1)]
        )
        const gy = Math.abs(
          luma[Math.min(h - 1, y + 1) * w + x] - luma[Math.max(0, y - 1) * w + x]
        )
        const edge = (gx + gy) / 255
        if (edge < masking * 0.5) continue
      }
      const hp = (luma[p] - blur[p]) * amount * 2
      data[o] = clamp(src[o] + hp, 0, 255)
      data[o + 1] = clamp(src[o + 1] + hp, 0, 255)
      data[o + 2] = clamp(src[o + 2] + hp, 0, 255)
    }
  }
}

// Deterministic-ish value noise for grain (size controls correlation).
function grain(img: ImageData, a: AcrParams): void {
  const { width: w, height: h, data } = img
  const amount = (a.grainAmount ?? 0) / 100
  const size = 1 + ((a.grainSize ?? 25) / 100) * 3 // px correlation
  const strength = amount * 22 // film grain is subtle; over-strong reads as noise
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      // hashed pseudo-random per grain cell, stable across renders
      const cx = Math.floor(x / size)
      const cy = Math.floor(y / size)
      let n = (cx * 374761393 + cy * 668265263) >>> 0
      n = (n ^ (n >> 13)) * 1274126177
      n = (n ^ (n >> 16)) >>> 0
      const o = (y * w + x) * 4
      // luminance mask: grain peaks in midtones, fades out of blown highlights
      // and crushed shadows (matches how film grain reads on a real frame).
      const Y = (LUMA_R * data[o] + LUMA_G * data[o + 1] + LUMA_B * data[o + 2]) / 255
      const mask = 0.25 + 0.75 * (4 * Y * (1 - Y))
      const noise = (n / 4294967295 - 0.5) * strength * mask
      data[o] = clamp(data[o] + noise, 0, 255)
      data[o + 1] = clamp(data[o + 1] + noise, 0, 255)
      data[o + 2] = clamp(data[o + 2] + noise, 0, 255)
    }
  }
}
