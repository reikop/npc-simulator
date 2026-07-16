// Standalone XMP ↔ NP3 converter page (GitHub Pages). Reuses the simulator's
// conversion engine verbatim: xmp.ts (ACR parse/write) + np3.ts (NP3
// write/parse).

import { xmpToPictureControl, pictureControlToXmp } from '../src/renderer/src/lib/xmp'
import { buildNp3, parseNp3, np3ToneLut } from '../src/renderer/src/lib/np3'
import { buildCurveLut, type PictureControl } from '../src/renderer/src/lib/pictureControl'

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

const rows: Row[] = []

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
    }
    resultsEl.appendChild(div)
  }
  const ok = rows.filter((r) => r.bytes)
  downloadAllBtn.style.display = ok.length > 1 ? 'block' : 'none'
  downloadAllBtn.textContent = `전체 다운로드 (${ok.length}개)`
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
  render()
  document.title += ok ? ' — SELFTEST OK' : ' — SELFTEST FAIL'
}
