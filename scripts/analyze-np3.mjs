// Parse and diff Nikon .NP3 Picture Control files (format version "0310").
//
// Purpose: map the TLV record encoding (slider records 0x0300..0x1e00 and the
// 0x1f00/0x2000 curve blocks) by comparing NX Studio exports that each change
// ONE parameter against a baseline export. Feed it a folder of samples:
//
//   node scripts/analyze-np3.mjs data/np3-samples
//   node scripts/analyze-np3.mjs BASE.NP3 SHARP+2.NP3 ...
//
// The file whose name contains "BASE" (case-insensitive; else the first file)
// is the baseline. For every other file only the records that DIFFER from the
// baseline are printed, so each single-parameter export reveals exactly which
// record (and which bytes inside it) that parameter lives in.
//
// Container layout (from a real NX Studio export):
//   "NCP\0"            4-byte magic
//   00 00 01 00        format flags
//   00 00 00 04        record count hint
//   "0310"             version string (ASCII)
//   records:           id(u32 BE) len(u32 BE) value[len]

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, basename } from 'node:path'

function parseNp3(path) {
  const buf = readFileSync(path)
  if (buf.length < 16 || buf.toString('latin1', 0, 3) !== 'NCP') {
    return { path, error: 'NCP magic 없음' }
  }
  const version = buf.toString('latin1', 12, 16)
  if (version !== '0310') {
    return { path, error: `버전 ${version} — TLV(0310) 아님 (구형 NCP/NP2는 별도 포맷)` }
  }
  const records = new Map()
  let o = 16
  while (o + 8 <= buf.length) {
    const id = buf.readUInt32BE(o)
    const len = buf.readUInt32BE(o + 4)
    if (o + 8 + len > buf.length) break
    records.set(id, buf.subarray(o + 8, o + 8 + len))
    o += 8 + len
  }
  return { path, version, records, trailing: buf.length - o }
}

const hex = (b) => [...b].map((x) => x.toString(16).padStart(2, '0')).join(' ')
const idStr = (id) => '0x' + id.toString(16).padStart(4, '0')

// annotate the 2-byte records: value byte is 0x80-based (128 = ±0), 0xff = auto
function annotate(b) {
  if (b.length !== 2) return ''
  const v = b[0]
  if (v === 0xff) return ' (auto/—)'
  return ` (0x80${v >= 0x80 ? '+' : '-'}${Math.abs(v - 0x80)})`
}

function collectFiles(args) {
  const files = []
  for (const a of args) {
    if (statSync(a).isDirectory()) {
      for (const f of readdirSync(a)) {
        if (/\.(np3|ncp|np2)$/i.test(f)) files.push(join(a, f))
      }
    } else files.push(a)
  }
  return files
}

const args = process.argv.slice(2)
if (args.length === 0) {
  console.error('사용법: node scripts/analyze-np3.mjs <폴더 또는 NP3 파일들>')
  process.exit(1)
}

const parsed = collectFiles(args).map(parseNp3)
for (const p of parsed.filter((p) => p.error)) {
  console.log(`SKIP ${basename(p.path)}: ${p.error}`)
}
const ok = parsed.filter((p) => !p.error)
if (ok.length === 0) process.exit(1)

// baseline = name containing "base", else first
const baseIdx = Math.max(0, ok.findIndex((p) => /base/i.test(basename(p.path))))
const base = ok[baseIdx]

console.log(`\n=== 기준(baseline): ${basename(base.path)} ===`)
for (const [id, b] of base.records) {
  const asc = id === 0x0200 ? `  "${b.toString('latin1').replace(/\0+$/, '')}"` : annotate(b)
  console.log(`  ${idStr(id)} len=${String(b.length).padStart(2)}  ${hex(b)}${asc}`)
}

for (const p of ok) {
  if (p === base) continue
  console.log(`\n=== ${basename(p.path)} — 기준과 다른 레코드 ===`)
  const ids = new Set([...base.records.keys(), ...p.records.keys()])
  let diffs = 0
  for (const id of [...ids].sort((a, b) => a - b)) {
    if (id === 0x0200) continue // name always differs
    const a = base.records.get(id)
    const b = p.records.get(id)
    if (!a || !b) {
      console.log(`  ${idStr(id)}: ${!a ? '기준에 없음' : '샘플에 없음'}`)
      diffs++
      continue
    }
    if (Buffer.compare(a, b) !== 0) {
      console.log(`  ${idStr(id)}: ${hex(a)}${annotate(a)}`)
      console.log(`  ${' '.repeat(idStr(id).length)}→ ${hex(b)}${annotate(b)}`)
      // byte-level positions that changed (curve 블록 매핑용)
      if (a.length === b.length && a.length > 2) {
        const pos = []
        for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) pos.push(i)
        console.log(`  ${' '.repeat(idStr(id).length)}  변경 바이트 오프셋: [${pos.join(', ')}]`)
      }
      diffs++
    }
  }
  if (!diffs) console.log('  (이름 외 차이 없음)')
}
