// Adobe Camera Raw / Lightroom XMP preset → our PictureControl recipe.
//
// We read the whole `crs:` (camera-raw-settings) block and pack every
// meaningful parameter into `control.acr`, which the render pipeline (acr.ts)
// reproduces faithfully. The master point curve also lands in `control.curve`
// so it stays editable in the 톤커브 tab. This is a faithful-look conversion on
// an 8-bit preview — NOT a colour-managed Adobe clone (their engine is closed
// and operates on scene-linear RAW). Parameters with no preview-side meaning
// are intentionally dropped:
//   - lens geometry / chromatic-aberration / vignette corrections (need the
//     lens profile + full-res RAW)
//   - precise demosaic-stage luminance/colour noise reduction
//   - local mask adjustments (radial/gradient/AI masks)
//   - per-camera calibration primaries

import type { CurvePoint, PictureControl } from './pictureControl'
import type { AcrParams, GradeBand } from './acr'
import { identityCurve } from './pictureControl'

const CRS_NS = 'http://ns.adobe.com/camera-raw-settings/1.0/'
const RDF_NS = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#'

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v))

function attr(el: Element, name: string): string | null {
  const direct = el.getAttributeNS(CRS_NS, name)
  if (direct != null) return direct
  for (const a of Array.from(el.attributes)) {
    if (a.localName === name) return a.value
  }
  return null
}

function num(el: Element, name: string): number | null {
  const v = attr(el, name)
  if (v == null || v.trim() === '') return null
  const n = parseFloat(v) // handles "+36", "-0.37"
  return Number.isFinite(n) ? n : null
}

/** num with a default (so unset Adobe sliders read as 0/neutral). */
const numd = (el: Element, name: string, dflt = 0): number => num(el, name) ?? dflt

function bool(el: Element, name: string): boolean {
  return (attr(el, name) ?? '').toLowerCase() === 'true'
}

function findSettings(doc: Document): Element | null {
  const descs = Array.from(doc.getElementsByTagNameNS(RDF_NS, 'Description'))
  return (
    descs.find(
      (d) =>
        attr(d, 'Version') != null ||
        attr(d, 'Contrast2012') != null ||
        attr(d, 'Exposure2012') != null ||
        attr(d, 'ToneCurveName2012') != null
    ) ??
    descs[0] ??
    null
  )
}

function readName(el: Element): string | null {
  const named = el.getElementsByTagNameNS(CRS_NS, 'Name')[0]
  const li = named?.getElementsByTagNameNS(RDF_NS, 'li')[0]
  const t = li?.textContent?.trim()
  return t && t.length > 0 ? t : null
}

/** A named crs Seq of "x, y" point pairs → CurvePoint[] (or null). */
function readCurve(el: Element, tag: string): CurvePoint[] | null {
  const block = el.getElementsByTagNameNS(CRS_NS, tag)[0]
  if (!block) return null
  const pts: CurvePoint[] = []
  for (const li of Array.from(block.getElementsByTagNameNS(RDF_NS, 'li'))) {
    const m = (li.textContent ?? '').split(',')
    if (m.length !== 2) continue
    const x = parseFloat(m[0])
    const y = parseFloat(m[1])
    if (Number.isFinite(x) && Number.isFinite(y)) {
      pts.push({ x: clamp(Math.round(x), 0, 255), y: clamp(Math.round(y), 0, 255) })
    }
  }
  pts.sort((a, b) => a.x - b.x)
  return pts.length >= 2 ? pts : null
}

// Adobe HSL band order matches acr.ts BAND_HUE.
const HSL_BANDS = ['Red', 'Orange', 'Yellow', 'Green', 'Aqua', 'Blue', 'Purple', 'Magenta']
function readBandArray(el: Element, prefix: string): number[] {
  return HSL_BANDS.map((b) => numd(el, prefix + b))
}

function readGradeBand(el: Element, hueName: string, satName: string, lumName: string): GradeBand {
  return { h: numd(el, hueName), s: numd(el, satName), l: numd(el, lumName) }
}

const safeId = (s: string) =>
  'xmp-' + (s.replace(/[^A-Za-z0-9_-]/g, '_').replace(/_+/g, '_').slice(0, 32) || 'preset')

/** Convert an XMP preset (raw text) into a PictureControl recipe. */
export function xmpToPictureControl(xmpText: string, fileName = 'preset.xmp'): PictureControl {
  const doc = new DOMParser().parseFromString(xmpText, 'application/xml')
  if (doc.getElementsByTagName('parsererror').length) {
    throw new Error('XMP 파싱 실패: 잘못된 XML')
  }
  const el = findSettings(doc)
  if (!el) throw new Error('XMP에 camera-raw 설정 블록이 없습니다')

  const mono =
    bool(el, 'ConvertToGrayscale') ||
    (attr(el, 'Treatment') ?? '').toLowerCase() === 'black & white'

  // White balance: convert absolute temp/tint into a delta vs the as-shot WB,
  // normalised to roughly -1..1 (only a delta is meaningful on a baked preview).
  const temp = num(el, 'Temperature')
  const asShotTemp = num(el, 'AsShotTemperature')
  const tint = num(el, 'Tint')
  const asShotTint = num(el, 'AsShotTint')
  const wbTemp =
    temp != null && asShotTemp != null && asShotTemp > 0
      ? clamp((temp - asShotTemp) / 4000, -1, 1)
      : 0
  const wbTint =
    tint != null && asShotTint != null ? clamp((tint - asShotTint) / 60, -1, 1) : 0

  const master = readCurve(el, 'ToneCurvePV2012') ?? identityCurve()

  const grade: AcrParams['grade'] = {
    // split toning fills shadow/highlight; colour grading fills midtone/global
    shadow: {
      h: numd(el, 'SplitToningShadowHue'),
      s: numd(el, 'SplitToningShadowSaturation'),
      l: numd(el, 'ColorGradeShadowLum')
    },
    highlight: {
      h: numd(el, 'SplitToningHighlightHue'),
      s: numd(el, 'SplitToningHighlightSaturation'),
      l: numd(el, 'ColorGradeHighlightLum')
    },
    midtone: readGradeBand(el, 'ColorGradeMidtoneHue', 'ColorGradeMidtoneSat', 'ColorGradeMidtoneLum'),
    global: readGradeBand(el, 'ColorGradeGlobalHue', 'ColorGradeGlobalSat', 'ColorGradeGlobalLum'),
    blending: numd(el, 'ColorGradeBlending', 100),
    balance: numd(el, 'SplitToningBalance') || numd(el, 'ColorGradeBalance')
  }

  const acr: AcrParams = {
    wbTemp,
    wbTint,
    exposure: numd(el, 'Exposure2012'),
    contrast: numd(el, 'Contrast2012'),
    highlights: numd(el, 'Highlights2012'),
    shadows: numd(el, 'Shadows2012'),
    whites: numd(el, 'Whites2012'),
    blacks: numd(el, 'Blacks2012'),
    texture: numd(el, 'Texture'),
    clarity: numd(el, 'Clarity2012') || numd(el, 'Clarity'),
    dehaze: numd(el, 'Dehaze'),
    vibrance: numd(el, 'Vibrance'),
    saturation: numd(el, 'Saturation2012') || numd(el, 'Saturation'),
    paramShadows: numd(el, 'ParametricShadows'),
    paramDarks: numd(el, 'ParametricDarks'),
    paramLights: numd(el, 'ParametricLights'),
    paramHighlights: numd(el, 'ParametricHighlights'),
    paramShadowSplit: numd(el, 'ParametricShadowSplit', 25),
    paramMidSplit: numd(el, 'ParametricMidtoneSplit', 50),
    paramHighlightSplit: numd(el, 'ParametricHighlightSplit', 75),
    curveRed: readCurve(el, 'ToneCurvePV2012Red') ?? undefined,
    curveGreen: readCurve(el, 'ToneCurvePV2012Green') ?? undefined,
    curveBlue: readCurve(el, 'ToneCurvePV2012Blue') ?? undefined,
    hueAdjust: readBandArray(el, 'HueAdjustment'),
    satAdjust: readBandArray(el, 'SaturationAdjustment'),
    lumAdjust: readBandArray(el, 'LuminanceAdjustment'),
    grade,
    sharpenAmount: numd(el, 'Sharpness'),
    sharpenRadius: numd(el, 'SharpenRadius', 1),
    sharpenDetail: numd(el, 'SharpenDetail'),
    sharpenMasking: numd(el, 'SharpenEdgeMasking'),
    grainAmount: numd(el, 'GrainAmount'),
    grainSize: numd(el, 'GrainSize', 25),
    grainFreq: numd(el, 'GrainFrequency', 50),
    monochrome: mono
  }

  const name = readName(el) || fileName.replace(/\.xmp$/i, '').slice(0, 40) || 'XMP Preset'

  return {
    id: safeId(name || fileName),
    name: name.slice(0, 40),
    mode: mono ? 'monochrome' : 'color',
    curve: master, // editable master point curve (also consumed by acr)
    // simple top-level fields stay neutral; the acr block drives the render
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

// ---------------------------------------------------------------------------
// Writer: PictureControl → Lightroom/Camera Raw preset XMP (inverse direction,
// used for NP3 → XMP conversion). Mirrors the attribute style Adobe writes
// ("+36" signed ints), so the output imports cleanly into Lightroom.
// ---------------------------------------------------------------------------

const sgn = (v: number) => (v > 0 ? `+${Math.round(v)}` : String(Math.round(v)))
const escXml = (s: string) =>
  s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!)

function curveSeq(tag: string, pts: CurvePoint[]): string {
  const lis = pts.map((p) => `     <rdf:li>${p.x}, ${p.y}</rdf:li>`).join('\n')
  return `   <crs:${tag}>\n    <rdf:Seq>\n${lis}\n    </rdf:Seq>\n   </crs:${tag}>`
}

/** Adobe's point curve holds at most 16 anchors — Lightroom drops the whole
 * curve on import when a preset exceeds that (NP3 curve chunks carry 17+).
 * Thin interior points, least shape-changing first, until it fits. */
function capCurvePoints(pts: CurvePoint[], max = 16): CurvePoint[] {
  const out = [...pts]
  while (out.length > max) {
    let bestI = 1
    let bestErr = Infinity
    for (let i = 1; i < out.length - 1; i++) {
      const a = out[i - 1]
      const b = out[i]
      const c = out[i + 1]
      const t = c.x === a.x ? 0.5 : (b.x - a.x) / (c.x - a.x)
      const err = Math.abs(b.y - (a.y + (c.y - a.y) * t))
      if (err < bestErr) {
        bestErr = err
        bestI = i
      }
    }
    out.splice(bestI, 1)
  }
  return out
}

/** Serialise a PictureControl (typically parsed from an .NP3) into an Adobe
 * Camera Raw preset .xmp. Everything an NP3 carries maps 1:1 back to ACR. */
export function pictureControlToXmp(pc: PictureControl): string {
  const a = pc.acr
  const uuid = Array.from(crypto.getRandomValues(new Uint8Array(16)))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
    .toUpperCase()

  // classic (non-acr) recipes fall back to the few shared sliders
  const tone = {
    contrast: a?.contrast ?? pc.contrast,
    highlights: a?.highlights ?? 0,
    shadows: a?.shadows ?? 0,
    whites: a?.whites ?? 0,
    blacks: a?.blacks ?? 0,
    saturation: a?.saturation ?? pc.saturation
  }
  const attrs: string[] = [
    'crs:PresetType="Normal"',
    'crs:Cluster=""',
    `crs:UUID="${uuid}"`,
    'crs:SupportsAmount="False"',
    'crs:SupportsColor="True"',
    'crs:SupportsMonochrome="True"',
    'crs:Version="16.0"',
    'crs:ProcessVersion="15.4"',
    'crs:WhiteBalance="As Shot"',
    'crs:Exposure2012="0.00"',
    `crs:Contrast2012="${sgn(tone.contrast)}"`,
    `crs:Highlights2012="${sgn(tone.highlights)}"`,
    `crs:Shadows2012="${sgn(tone.shadows)}"`,
    `crs:Whites2012="${sgn(tone.whites)}"`,
    `crs:Blacks2012="${sgn(tone.blacks)}"`,
    `crs:Texture="${sgn(a?.texture ?? 0)}"`,
    `crs:Clarity2012="${sgn(a?.clarity ?? 0)}"`,
    'crs:Vibrance="0"',
    `crs:Saturation="${sgn(tone.saturation)}"`,
    `crs:Sharpness="${Math.round(a?.sharpenAmount ?? pc.sharpening)}"`
  ]
  for (let i = 0; i < HSL_BANDS.length; i++) {
    attrs.push(`crs:HueAdjustment${HSL_BANDS[i]}="${sgn(a?.hueAdjust?.[i] ?? 0)}"`)
  }
  for (let i = 0; i < HSL_BANDS.length; i++) {
    attrs.push(`crs:SaturationAdjustment${HSL_BANDS[i]}="${sgn(a?.satAdjust?.[i] ?? 0)}"`)
  }
  for (let i = 0; i < HSL_BANDS.length; i++) {
    attrs.push(`crs:LuminanceAdjustment${HSL_BANDS[i]}="${sgn(a?.lumAdjust?.[i] ?? 0)}"`)
  }
  const g = a?.grade
  attrs.push(
    `crs:SplitToningShadowHue="${Math.round(g?.shadow.h ?? 0)}"`,
    `crs:SplitToningShadowSaturation="${Math.round(g?.shadow.s ?? 0)}"`,
    `crs:SplitToningHighlightHue="${Math.round(g?.highlight.h ?? 0)}"`,
    `crs:SplitToningHighlightSaturation="${Math.round(g?.highlight.s ?? 0)}"`,
    `crs:SplitToningBalance="${sgn(g?.balance ?? 0)}"`,
    `crs:ColorGradeMidtoneHue="${Math.round(g?.midtone.h ?? 0)}"`,
    `crs:ColorGradeMidtoneSat="${Math.round(g?.midtone.s ?? 0)}"`,
    `crs:ColorGradeShadowLum="${sgn(g?.shadow.l ?? 0)}"`,
    `crs:ColorGradeMidtoneLum="${sgn(g?.midtone.l ?? 0)}"`,
    `crs:ColorGradeHighlightLum="${sgn(g?.highlight.l ?? 0)}"`,
    `crs:ColorGradeBlending="${Math.round(g?.blending ?? 100)}"`
  )
  const mono = pc.mode === 'monochrome' || !!a?.monochrome
  if (mono) attrs.push('crs:ConvertToGrayscale="True"')
  const curve = capCurvePoints([...pc.curve].sort((p, q) => p.x - q.x))
  const hasCurve = curve.length > 2 || curve.some((p) => Math.abs(p.y - p.x) > 1)
  attrs.push(`crs:ToneCurveName2012="${hasCurve ? 'Custom' : 'Linear'}"`, 'crs:HasSettings="True"')

  const identity: CurvePoint[] = [
    { x: 0, y: 0 },
    { x: 255, y: 255 }
  ]
  return `<x:xmpmeta xmlns:x="adobe:ns:meta/" x:xmptk="NPC Simulator">
 <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
  <rdf:Description rdf:about=""
    xmlns:crs="http://ns.adobe.com/camera-raw-settings/1.0/"
   ${attrs.join('\n   ')}>
   <crs:Name>
    <rdf:Alt>
     <rdf:li xml:lang="x-default">${escXml(pc.name)}</rdf:li>
    </rdf:Alt>
   </crs:Name>
   <crs:Group>
    <rdf:Alt>
     <rdf:li xml:lang="x-default">NPC Simulator</rdf:li>
    </rdf:Alt>
   </crs:Group>
${curveSeq('ToneCurvePV2012', hasCurve ? curve : identity)}
${curveSeq('ToneCurvePV2012Red', identity)}
${curveSeq('ToneCurvePV2012Green', identity)}
${curveSeq('ToneCurvePV2012Blue', identity)}
  </rdf:Description>
 </rdf:RDF>
</x:xmpmeta>
`
}
