// Shared parser: turns a nikonpc.com loadNpc response (python-dict-ish text)
// into our recipe format. Used by both fetch-npc.mjs and rebuild-library.mjs.
//
// Calibration note: Nikon Picture Control stores contrast/saturation/hue on a
// small -3..+3 integer scale and sharpening on 0..9 (verified across all 166
// presets). The film "look" is mostly carried by the custom tone curve, so the
// scalar adjustments are mapped GENTLY — over-scaling hue is what turned some
// presets bright green.

export function sanitize(p) {
  return p.replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^_+|_+$/g, '')
}

export function baseName(p) {
  return sanitize(p.replace(/\.(ncp|np2|np3)$/i, ''))
}

export function field(text, key) {
  const m = text.match(new RegExp(`'${key}'\\s*:\\s*(null|'((?:[^'\\\\]|\\\\.)*)')`))
  if (!m) return null
  if (m[1] === 'null') return null
  return m[2]
}

export function numField(text, key) {
  const v = field(text, key)
  if (v === null || v === '') return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

export function curvePoints(text) {
  const i = text.indexOf("'points'")
  if (i < 0) return []
  const open = text.indexOf('[', i)
  if (open < 0) return []
  let depth = 0
  let end = open
  for (let j = open; j < text.length; j++) {
    if (text[j] === '[') depth++
    else if (text[j] === ']') {
      depth--
      if (depth === 0) {
        end = j
        break
      }
    }
  }
  const block = text.slice(open, end + 1)
  const pts = []
  const re = /\[\s*'(-?\d+)'\s*,\s*'(-?\d+)'\s*\]/g
  let m
  while ((m = re.exec(block))) pts.push({ x: Number(m[1]), y: Number(m[2]) })
  return pts
}

// Nikon scale -> our engine scale. Gentle, because the curve does the heavy lifting.
// These match nikonpc.com's own lookup tables exactly:
//   saturation {-3..3} -> {-45..45}  (×15)
//   hue        {-3..3} -> {-12..12}° (×4)
const SCALE = {
  contrast: 15, // -3..3  -> -45..45
  brightness: 15, // -3..3  -> -45..45
  saturation: 15, // -3..3  -> -45..45  (engine applies HSL r = 1+2*(s/100) for s>0)
  hue: 4, // -3..3  -> ±12°  (was ×60 — the green-cast bug)
  sharpening: 11 // 0..9   -> 0..99
}
const apply = (v, f) => (v === null ? 0 : Math.round(v * f))

// nikonpc.com toningType codes -> our toning names. All ten are now implemented
// (the site stubbed yellow..redPurple, we give them real tints).
const TONING_TYPE = {
  80: 'none',
  81: 'sepia',
  82: 'cyanotype',
  83: 'red',
  84: 'yellow',
  85: 'green',
  86: 'blueGreen',
  87: 'blue',
  88: 'purpleBlue',
  89: 'redPurple'
}

// filterEffect codes -> B&W colour filter (channel-mix). Now applied in render.
const FILTER_EFFECT = {
  80: 'none',
  81: 'yellow',
  82: 'orange',
  83: 'red',
  84: 'green'
}

function monoTone(text) {
  const tType = numField(text, 'toningType')
  const density = numField(text, 'toning') // 1..7, or null when 'disabled'
  const type = TONING_TYPE[tType] || 'none'
  if (type === 'none' || !density || density < 1) return null
  return { type, density: Math.max(1, Math.min(7, density)) }
}

function monoFilter(text) {
  return FILTER_EFFECT[numField(text, 'filterEffect')] || 'none'
}

export function toRecipe(path, text) {
  const name = field(text, 'name') || path.split('/').pop().replace(/\.\w+$/, '')
  const base = (field(text, 'picCtrl') || '').toLowerCase()
  const mode = base.includes('mono') ? 'monochrome' : 'color'
  let curve = curvePoints(text)
  if (curve.length < 2) {
    curve = [
      { x: 0, y: 0 },
      { x: 255, y: 255 }
    ]
  }
  return {
    id: sanitize(path),
    name,
    sourcePath: path,
    mode,
    curve,
    brightness: apply(numField(text, 'brightness'), SCALE.brightness),
    contrast: apply(numField(text, 'contrast'), SCALE.contrast),
    saturation: apply(numField(text, 'saturation'), SCALE.saturation),
    hue: apply(numField(text, 'hue'), SCALE.hue),
    sharpening: Math.min(100, apply(numField(text, 'sharpening'), SCALE.sharpening)),
    filter: mode === 'monochrome' ? monoFilter(text) : 'none',
    monoTone: mode === 'monochrome' ? monoTone(text) : null,
    toning: null
  }
}
