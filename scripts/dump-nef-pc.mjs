// Diagnostic: dump the PictureControlData block from a NEF so we can verify the
// byte offsets of each adjustment for a given camera/version.
//
//   node scripts/dump-nef-pc.mjs path/to/file.NEF
//
// Prints version/name/base + a labelled hex dump of the whole block. Set the
// in-camera Picture Control to known values, shoot a NEF, and run this to map
// which byte holds which setting.

import { readFileSync } from 'node:fs'

const file = process.argv[2]
if (!file) {
  console.error('usage: node scripts/dump-nef-pc.mjs <file.NEF>')
  process.exit(1)
}
const buf = readFileSync(file)
const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)
const dv = new DataView(ab)

const order = dv.getUint16(0, false)
const little = order === 0x4949
if (!little && order !== 0x4d4d) {
  console.error('not a TIFF/NEF')
  process.exit(1)
}
const u16 = (o) => dv.getUint16(o, little)
const u32 = (o) => dv.getUint32(o, little)

const TYPE_SIZE = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 7: 1, 9: 4, 10: 8 }
function find(tiffBase, ifdOff, tag, lit) {
  const rd16 = (o) => dv.getUint16(o, lit)
  const rd32 = (o) => dv.getUint32(o, lit)
  const ifd = tiffBase + ifdOff
  const n = rd16(ifd)
  for (let i = 0; i < n; i++) {
    const e = ifd + 2 + i * 12
    if (rd16(e) !== tag) continue
    const type = rd16(e + 2)
    const count = rd32(e + 4)
    const size = (TYPE_SIZE[type] ?? 1) * count
    const raw = rd32(e + 8)
    return { type, count, valuePtr: size <= 4 ? e + 8 : tiffBase + raw, raw }
  }
  return null
}
function ascii(off, len) {
  let s = ''
  for (let i = 0; i < len; i++) {
    const c = dv.getUint8(off + i)
    if (c === 0) break
    s += String.fromCharCode(c)
  }
  return s.trim()
}

const ifd0 = u32(4)
const exif = find(0, ifd0, 0x8769, little)
if (!exif) { console.error('no Exif IFD'); process.exit(1) }
const exifIfd = u32(exif.valuePtr)
const mn = find(0, exifIfd, 0x927c, little)
if (!mn) { console.error('no MakerNote'); process.exit(1) }
const mnStart = mn.raw
const sig = ascii(mnStart, 6)
console.log('MakerNote signature:', JSON.stringify(sig))
if (!sig.startsWith('Nikon')) { console.error('not a Nikon type-3 MakerNote'); process.exit(1) }
const tiffBase = mnStart + 10
const innerLittle = dv.getUint16(tiffBase, false) === 0x4949
const innerIfd = dv.getUint32(tiffBase + 4, innerLittle)
const pc = find(tiffBase, innerIfd, 0x0023, innerLittle)
if (!pc) { console.error('no PictureControlData (0x0023) tag'); process.exit(1) }

const start = pc.valuePtr
const len = pc.count
console.log('PictureControlData length:', len)
console.log('version:', JSON.stringify(ascii(start, 4)))
console.log('name   :', JSON.stringify(ascii(start + 4, 20)))
console.log('base   :', JSON.stringify(ascii(start + 24, 20)))
console.log('\nlabelled bytes (offset: unsigned / signed):')
for (let i = 44; i < len; i++) {
  const u = dv.getUint8(start + i)
  const s = (u << 24) >> 24
  console.log(`  [${String(i).padStart(2)}] 0x${u.toString(16).padStart(2, '0')}  u=${String(u).padStart(3)}  s=${s}`)
}
