// Standalone XMP ↔ NP3 converter page (GitHub Pages). Reuses the simulator's
// conversion engine verbatim: xmp.ts (ACR parse/write) + np3.ts (NP3
// write/parse).

import { xmpToPictureControl, pictureControlToXmp } from '../src/renderer/src/lib/xmp'
import { buildNp3, parseNp3, np3ToneLut } from '../src/renderer/src/lib/np3'
import {
  applyPictureControl,
  buildCurveLut,
  type PictureControl
} from '../src/renderer/src/lib/pictureControl'

interface Row {
  fileName: string
  outName: string
  bytes: ArrayBuffer | string | null // NP3 bytes or XMP text
  ctrl: PictureControl | null
  error?: string
}

const $ = <T extends HTMLElement>(sel: string) => document.querySelector(sel) as T
const dropzone = $('#dropzone')
const fileInput = $('#fileInput') as unknown as HTMLInputElement
const resultsEl = $('#results')
const downloadAllBtn = $('#downloadAll') as unknown as HTMLButtonElement
const previewEl = $('#preview')
const pvCanvas = $('#previewCanvas') as unknown as HTMLCanvasElement
const pvLabelL = $('#previewLabelL')
const pvLabelR = $('#previewLabelR')

const rows: Row[] = []

// ---- hover preview: sample photo + before/after split render ---------------

const PV_W = 720
const PV_H = 480

/** Procedural sample "photo": sky gradient with a sun glow, hills, skin/colour
 * swatches and a neutral ramp — enough signal to judge tone, WB and HSL moves.
 * Dropping a JPG/PNG onto the page replaces it with a real photo. */
function makeSampleScene(): ImageData {
  const img = new ImageData(PV_W, PV_H)
  const d = img.data
  const horizon = 0.6
  const swatches = [
    [233, 182, 150], [152, 102, 76], [201, 45, 40], [232, 140, 38], [235, 214, 60],
    [62, 158, 70], [58, 178, 190], [52, 92, 200], [128, 70, 178], [128, 128, 128]
  ]
  for (let y = 0; y < PV_H; y++) {
    for (let x = 0; x < PV_W; x++) {
      const o = (y * PV_W + x) * 4
      const fy = y / PV_H
      const fx = x / PV_W
      let r: number
      let g: number
      let b: number
      if (fy < horizon) {
        const t = fy / horizon // deep blue → warm horizon
        r = 58 + t * 190
        g = 108 + t * 100
        b = 205 - t * 48
        const dx = fx - 0.72
        const dy = (fy - 0.16) * (PV_H / PV_W)
        const glow = Math.max(0, 1 - Math.sqrt(dx * dx + dy * dy) * 3.2)
        r += glow * glow * 70
        g += glow * glow * 52
        b += glow * glow * 18
      } else if (fy < horizon + 0.12 + 0.02 * Math.sin(fx * 9)) {
        const near = fy > horizon + 0.055 + 0.02 * Math.sin(fx * 7 + 1)
        r = near ? 52 : 88
        g = near ? 82 : 118
        b = near ? 44 : 66
      } else if (fy < 0.9) {
        const c = swatches[Math.min(9, Math.floor(fx * 10))]
        r = c[0]
        g = c[1]
        b = c[2]
      } else {
        r = g = b = fx * 255 // neutral ramp for reading the tone curve
      }
      d[o] = r
      d[o + 1] = g
      d[o + 2] = b
      d[o + 3] = 255
    }
  }
  return img
}

let sample: ImageData = makeSampleScene()
const renderCache = new Map<Row, HTMLCanvasElement>()

const cloneSample = () =>
  new ImageData(new Uint8ClampedArray(sample.data), sample.width, sample.height)

async function loadSampleFile(f: File): Promise<void> {
  try {
    const bmp = await createImageBitmap(f, { imageOrientation: 'from-image' })
    const scale = Math.min(1, PV_W / bmp.width)
    const w = Math.max(1, Math.round(bmp.width * scale))
    const h = Math.max(1, Math.round(bmp.height * scale))
    const c = document.createElement('canvas')
    c.width = w
    c.height = h
    const ctx = c.getContext('2d')!
    ctx.drawImage(bmp, 0, 0, w, h)
    sample = ctx.getImageData(0, 0, w, h)
    renderCache.clear()
    previewEl.style.display = 'block' // a photo alone must show the panel too
    drawIdle()
  } catch {
    rows.push({
      fileName: f.name,
      outName: '',
      bytes: null,
      ctrl: null,
      error: '이미지를 읽지 못했습니다 — JPG/PNG/WebP만 샘플로 쓸 수 있습니다'
    })
  }
}

/** Left half = reference (XMP rows: full ACR render; NP3 rows: the untouched
 * photo), right half = what the NP3 actually carries (round-tripped through
 * the encoder), so conversion loss is visible on the divider. */
function renderSplit(row: Row): HTMLCanvasElement {
  const isXmpRow = typeof row.bytes !== 'string' // .xmp → .NP3 (bytes = NP3)
  const left = cloneSample()
  if (isXmpRow) applyPictureControl(left, row.ctrl!)
  const right = cloneSample()
  const rightCtrl = isXmpRow ? parseNp3(row.bytes as ArrayBuffer, row.outName) : row.ctrl!
  applyPictureControl(right, rightCtrl)
  const c = document.createElement('canvas')
  c.width = sample.width
  c.height = sample.height
  const ctx = c.getContext('2d')!
  const half = Math.floor(sample.width / 2)
  ctx.putImageData(left, 0, 0)
  ctx.putImageData(right, 0, 0, half, 0, sample.width - half, sample.height)
  ctx.fillStyle = 'rgba(255,255,255,0.85)'
  ctx.fillRect(half, 0, 1, sample.height)
  return c
}

function showPreview(row: Row): void {
  if (row.error || !row.ctrl || !row.bytes) return
  let c = renderCache.get(row)
  if (!c) {
    c = renderSplit(row)
    renderCache.set(row, c)
  }
  pvCanvas.width = c.width
  pvCanvas.height = c.height
  pvCanvas.getContext('2d')!.drawImage(c, 0, 0)
  const isXmpRow = typeof row.bytes !== 'string'
  pvLabelL.textContent = isXmpRow ? 'XMP(ACR) 렌더' : '원본'
  pvLabelR.textContent = isXmpRow ? 'NP3 결과' : 'NP3 적용'
}

function drawIdle(): void {
  pvCanvas.width = sample.width
  pvCanvas.height = sample.height
  pvCanvas.getContext('2d')!.putImageData(sample, 0, 0)
  pvLabelL.textContent = ''
  pvLabelR.textContent = ''
}

// ---- conversion (both directions, routed by extension) -----------------------

const safeBase = (name: string) =>
  name.replace(/[^A-Za-z0-9_-]/g, '_').replace(/_+/g, '_').slice(0, 20) || 'CUSTOM'

function convertXmp(fileName: string, text: string): Row {
  try {
    const ctrl = xmpToPictureControl(text, fileName)
    return { fileName, outName: safeBase(ctrl.name) + '.NP3', bytes: buildNp3(ctrl), ctrl }
  } catch (err) {
    return { fileName, outName: '', bytes: null, ctrl: null, error: (err as Error).message }
  }
}

function convertNp3(fileName: string, buf: ArrayBuffer): Row {
  try {
    const ctrl = parseNp3(buf, fileName)
    return { fileName, outName: safeBase(ctrl.name) + '.xmp', bytes: pictureControlToXmp(ctrl), ctrl }
  } catch (err) {
    return { fileName, outName: '', bytes: null, ctrl: null, error: (err as Error).message }
  }
}

async function handleFiles(files: File[]): Promise<void> {
  let skipped = 0
  for (const f of files) {
    if (/\.xmp$/i.test(f.name)) rows.push(convertXmp(f.name, await f.text()))
    else if (/\.(np3|ncp|np2)$/i.test(f.name)) rows.push(convertNp3(f.name, await f.arrayBuffer()))
    else if (/\.(jpe?g|png|webp)$/i.test(f.name)) await loadSampleFile(f) // preview sample
    else skipped++
  }
  if (skipped > 0) {
    rows.push({
      fileName: `${skipped}개 파일`,
      outName: '',
      bytes: null,
      ctrl: null,
      error: 'XMP/NP3가 아니라서 건너뜀'
    })
  }
  render()
}

// ---- summary chips ----------------------------------------------------------

function chips(ctrl: PictureControl): { label: string; cls: string }[] {
  const a = ctrl.acr
  if (!a) return [{ label: '구형 NCP — 기본 슬라이더만', cls: 'warn' }]
  const out: { label: string; cls: string }[] = []
  const tone = [a.contrast, a.highlights, a.shadows, a.whites, a.blacks].filter(Boolean).length
  if (tone > 0) out.push({ label: `톤 슬라이더 ${tone}`, cls: 'on' })
  if ((a.saturation ?? 0) || (a.vibrance ?? 0)) out.push({ label: '채도', cls: 'on' })
  if ([a.hueAdjust, a.satAdjust, a.lumAdjust].some((arr) => arr?.some((v) => v !== 0)))
    out.push({ label: 'HSL → 컬러 블렌더', cls: 'on' })
  const g = a.grade
  if (g && (g.shadow.s > 0 || g.midtone.s > 0 || g.highlight.s > 0))
    out.push({ label: '스플릿 토닝 → 그레이딩', cls: 'on' })
  // channel curves: their shared (luma) shape is baked into the NP3 curve;
  // only the spread between R/G/B — the colour cast — is dropped
  const chanLuts = [a.curveRed, a.curveGreen, a.curveBlue].map((c) =>
    c && c.length >= 2 ? buildCurveLut(c) : null
  )
  let chanShape = 0
  let chanCast = 0
  for (let i = 0; i < 256; i++) {
    const r = chanLuts[0] ? chanLuts[0][i] : i
    const g = chanLuts[1] ? chanLuts[1][i] : i
    const b = chanLuts[2] ? chanLuts[2][i] : i
    chanShape = Math.max(chanShape, Math.abs(0.2126 * r + 0.7152 * g + 0.0722 * b - i))
    chanCast = Math.max(chanCast, Math.max(r, g, b) - Math.min(r, g, b))
  }
  const curveBaked =
    ctrl.curve.length > 2 ||
    ctrl.curve.some((p) => Math.abs(p.y - p.x) > 3) ||
    chanShape > 3 ||
    Math.abs(a.exposure ?? 0) > 0.05 ||
    !!(a.paramShadows || a.paramDarks || a.paramLights || a.paramHighlights)
  if (curveBaked) out.push({ label: '톤커브 베이크', cls: 'on' })
  if ((a.sharpenAmount ?? 0) || (a.clarity ?? 0) || (a.texture ?? 0))
    out.push({ label: '샤프닝·명료도', cls: 'on' })
  // dropped features
  if (a.wbTemp || a.wbTint) out.push({ label: 'WB 드롭', cls: 'warn' })
  if (chanCast > 5) out.push({ label: 'RGB커브 색조 드롭', cls: 'warn' })
  if (a.grainAmount) out.push({ label: '그레인 드롭', cls: 'warn' })
  if (a.dehaze) out.push({ label: '디헤이즈 드롭', cls: 'warn' })
  return out
}

/** Tiny sparkline of the luminance curve the NP3 will carry. */
function curveSvg(ctrl: PictureControl): string {
  if (!ctrl.acr) return ''
  const lut = np3ToneLut(ctrl)
  const S = 56
  const pts: string[] = []
  for (let i = 0; i <= 27; i++) {
    const x = Math.round((i / 27) * 255)
    pts.push(`${((x / 255) * (S - 8) + 4).toFixed(1)},${(S - 4 - (lut[x] / 255) * (S - 8)).toFixed(1)}`)
  }
  return (
    `<svg width="${S}" height="${S}" viewBox="0 0 ${S} ${S}">` +
    `<line x1="4" y1="${S - 4}" x2="${S - 4}" y2="4" stroke="#38383f" stroke-dasharray="3 3"/>` +
    `<polyline points="${pts.join(' ')}" fill="none" stroke="#f5a623" stroke-width="1.6"/>` +
    `</svg>`
  )
}

// ---- rendering / downloads --------------------------------------------------

function download(row: Row): void {
  if (!row.bytes) return
  const type = typeof row.bytes === 'string' ? 'application/rdf+xml' : 'application/octet-stream'
  const url = URL.createObjectURL(new Blob([row.bytes], { type }))
  const aEl = document.createElement('a')
  aEl.href = url
  aEl.download = row.outName
  document.body.appendChild(aEl)
  aEl.click()
  aEl.remove()
  setTimeout(() => URL.revokeObjectURL(url), 2000)
}

function render(): void {
  resultsEl.innerHTML = ''
  for (const row of rows) {
    const div = document.createElement('div')
    div.className = 'row' + (row.error ? ' error' : '')
    if (row.error || !row.ctrl) {
      div.innerHTML =
        `<div class="meta"><div class="name">${esc(row.fileName)}</div>` +
        `<div class="err-msg">변환 실패: ${esc(row.error ?? '알 수 없는 오류')}</div></div>`
    } else {
      const size =
        typeof row.bytes === 'string'
          ? new TextEncoder().encode(row.bytes).length
          : row.bytes!.byteLength
      div.innerHTML =
        curveSvg(row.ctrl) +
        `<div class="meta">` +
        `<div class="name">${esc(row.ctrl.name)}<small>${esc(row.fileName)} → ${esc(row.outName)} · ${size}B</small></div>` +
        `<div class="chips">${chips(row.ctrl)
          .map((c) => `<span class="chip ${c.cls}">${esc(c.label)}</span>`)
          .join('')}</div>` +
        `</div>`
      const btn = document.createElement('button')
      btn.textContent = '다운로드'
      btn.onclick = () => download(row)
      div.appendChild(btn)
      div.classList.add('previewable')
      div.onmouseenter = () => showPreview(row)
      div.onmouseleave = () => drawIdle()
      div.onclick = () => showPreview(row) // touch devices have no hover
    }
    resultsEl.appendChild(div)
  }
  const ok = rows.filter((r) => r.bytes)
  downloadAllBtn.style.display = ok.length > 1 ? 'block' : 'none'
  downloadAllBtn.textContent = `전체 다운로드 (${ok.length}개)`
  if (ok.length > 0 && previewEl.style.display !== 'block') {
    previewEl.style.display = 'block'
    drawIdle()
  }
}

const esc = (s: string) =>
  s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!)

downloadAllBtn.onclick = async () => {
  for (const row of rows.filter((r) => r.bytes)) {
    download(row)
    await new Promise((r) => setTimeout(r, 300)) // let the browser breathe between downloads
  }
}

// ---- input wiring -----------------------------------------------------------

dropzone.onclick = () => fileInput.click()
fileInput.onchange = () => {
  void handleFiles(Array.from(fileInput.files ?? []))
  fileInput.value = ''
}
window.addEventListener('dragover', (e) => {
  e.preventDefault()
  dropzone.classList.add('over')
})
window.addEventListener('dragleave', (e) => {
  if (!e.relatedTarget) dropzone.classList.remove('over')
})
window.addEventListener('drop', (e) => {
  e.preventDefault()
  dropzone.classList.remove('over')
  void handleFiles(Array.from(e.dataTransfer?.files ?? []))
})

// ---- self test (?selftest=1): convert an embedded sample and mark the title --

const SAMPLE_XMP = `<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
 <rdf:Description rdf:about="" xmlns:crs="http://ns.adobe.com/camera-raw-settings/1.0/"
  crs:Version="18.1" crs:Contrast2012="+20" crs:Highlights2012="-30" crs:Shadows2012="+25"
  crs:Saturation="-10" crs:Vibrance="+10" crs:HueAdjustmentBlue="-15"
  crs:SplitToningShadowHue="40" crs:SplitToningShadowSaturation="12" crs:GrainAmount="30">
  <crs:Name><rdf:Alt><rdf:li xml:lang="x-default">SELFTEST</rdf:li></rdf:Alt></crs:Name>
  <crs:ToneCurvePV2012><rdf:Seq><rdf:li>0, 12</rdf:li><rdf:li>255, 244</rdf:li></rdf:Seq></crs:ToneCurvePV2012>
 </rdf:Description></rdf:RDF></x:xmpmeta>`

if (new URLSearchParams(location.search).has('selftest')) {
  const row = convertXmp('selftest.xmp', SAMPLE_XMP)
  rows.push(row)
  let ok = !!row.bytes && row.ctrl?.name === 'SELFTEST'
  // reverse leg: NP3 bytes → XMP text → parse again. The HSL blue hue (-15)
  // survives both directions untouched; tone sliders are baked into the curve
  // (sample has one), so assert a non-linear curve came back too.
  if (ok) {
    const back = convertNp3('selftest.np3', row.bytes as ArrayBuffer)
    rows.push(back)
    const reparsed =
      typeof back.bytes === 'string' ? xmpToPictureControl(back.bytes, 'roundtrip.xmp') : null
    ok =
      back.ctrl?.name === 'SELFTEST' &&
      reparsed?.acr?.hueAdjust?.[5] === -15 &&
      (reparsed?.curve.length ?? 0) >= 3 &&
      (reparsed?.curve.length ?? 99) <= 16 // Adobe's point-curve anchor limit
  }
  // preview smoke test: the split render must actually move pixels
  if (ok) {
    const pv = renderSplit(rows[0])
    const strip = pv.getContext('2d')!.getImageData(0, 0, pv.width, 1).data
    let diff = 0
    for (let i = 0; i < strip.length; i += 40) diff += Math.abs(strip[i] - sample.data[i])
    ok = pv.width === sample.width && diff > 0
  }
  render()
  document.title += ok ? ' — SELFTEST OK' : ' — SELFTEST FAIL'
}
