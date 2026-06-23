// Fetch every Picture Control definition listed on nikonpc.com and turn it into
// our own recipe format + a real .NCP binary.
//
// The site exposes two endpoints (discovered from its public app.js):
//   POST ?cmd=loadNpc            { name: "<folder>/PICCONxx.NCP" }  -> full definition
//   POST ?cmd=dowloadModefiedNpc { points[i][]=x, points[i][]=y }   -> NCP binary (curve)
//
// We only collect functional/numeric parameters (curve points, sharpening, etc.)
// that the site distributes for installing on cameras.

import { promises as fs } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { baseName, toRecipe } from './parse-npc.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const BASE = 'https://nikonpc.com'
const RAW_DIR = resolve(ROOT, 'data/npc-raw')
const BIN_DIR = resolve(ROOT, 'data/npc-bin')
const OUT_JSON = resolve(ROOT, 'src/renderer/src/lib/library.json')
const CONCURRENCY = 6

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function postForm(cmd, body) {
  const res = await fetch(`${BASE}/?cmd=${cmd}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': 'npc-simulator/0.1 (personal preset import)'
    },
    body
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return res
}

async function fetchOne(path) {
  // 1) full definition
  const res = await postForm('loadNpc', `name=${encodeURIComponent(path)}`)
  const text = await res.text()
  await fs.writeFile(resolve(RAW_DIR, baseName(path) + '.txt'), text, 'utf-8')
  const recipe = toRecipe(path, text)

  // 2) real .NCP binary from the curve points
  try {
    const params = new URLSearchParams()
    recipe.curve.forEach((p) => {
      params.append('points[][]', String(p.x))
      params.append('points[][]', String(p.y))
    })
    const bin = await postForm('dowloadModefiedNpc', params.toString())
    const buf = Buffer.from(await bin.arrayBuffer())
    if (buf.length >= 4 && buf.toString('ascii', 0, 3) === 'NCP') {
      await fs.writeFile(resolve(BIN_DIR, baseName(path) + '.NCP'), buf)
      recipe.binaryBytes = buf.length
    }
  } catch (e) {
    recipe.binaryError = String(e.message || e)
  }
  return recipe
}

async function main() {
  await fs.mkdir(RAW_DIR, { recursive: true })
  await fs.mkdir(BIN_DIR, { recursive: true })
  const list = (await fs.readFile(resolve(ROOT, 'npc_list.txt'), 'utf-8'))
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean)

  console.log(`Fetching ${list.length} picture controls...`)
  const recipes = []
  let done = 0
  let failed = 0

  // simple concurrency pool
  let idx = 0
  async function worker() {
    while (idx < list.length) {
      const myIdx = idx++
      const path = list[myIdx]
      try {
        const r = await fetchOne(path)
        recipes.push(r)
      } catch (e) {
        failed++
        console.error(`  FAIL ${path}: ${e.message}`)
      }
      done++
      if (done % 10 === 0 || done === list.length) {
        console.log(`  ${done}/${list.length} (failed: ${failed})`)
      }
      await sleep(60) // be gentle
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker))

  recipes.sort((a, b) => a.name.localeCompare(b.name))
  await fs.writeFile(OUT_JSON, JSON.stringify(recipes, null, 2), 'utf-8')
  const withBin = recipes.filter((r) => r.binaryBytes).length
  console.log(`\nDone. ${recipes.length} recipes -> ${OUT_JSON}`)
  console.log(`Raw archive: ${RAW_DIR}`)
  console.log(`NCP binaries: ${BIN_DIR} (${withBin} files)`)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
