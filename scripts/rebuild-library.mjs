// Rebuild src/renderer/src/lib/library.json from the local raw archive
// (data/npc-raw/*.txt) using the shared parser — no network access needed.
// Run after changing the scaling/calibration in parse-npc.mjs.

import { promises as fs } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { baseName, toRecipe } from './parse-npc.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const RAW_DIR = resolve(ROOT, 'data/npc-raw')
const OUT_JSON = resolve(ROOT, 'src/renderer/src/lib/library.json')

const list = (await fs.readFile(resolve(ROOT, 'npc_list.txt'), 'utf-8'))
  .split(/\r?\n/)
  .map((s) => s.trim())
  .filter(Boolean)

const recipes = []
let missing = 0
for (const path of list) {
  const rawPath = resolve(RAW_DIR, baseName(path) + '.txt')
  let text
  try {
    text = await fs.readFile(rawPath, 'utf-8')
  } catch {
    missing++
    continue
  }
  recipes.push(toRecipe(path, text))
}

recipes.sort((a, b) => a.name.localeCompare(b.name))
await fs.writeFile(OUT_JSON, JSON.stringify(recipes, null, 2), 'utf-8')
console.log(`Rebuilt ${recipes.length} recipes -> ${OUT_JSON}` + (missing ? ` (${missing} raw missing)` : ''))
