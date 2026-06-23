// NPC (Nikon Picture Control) file helpers.
//
// The on-disk NPC binary format (.NCP/.NP2/.NP3) is Nikon-proprietary and not
// publicly documented, so full-fidelity binary read/write is a roadmap item.
// What we CAN do reliably today:
//   - read the embedded human-readable control name from a binary NPC file
//   - serialise/deserialise our own recipe format as JSON (portable, editable)
// This keeps the manager honest: it never claims to have written a camera-valid
// binary it cannot actually produce.

import type { PictureControl } from './pictureControl'

export interface NpcFileInfo {
  name: string
  size: number
  /** Best-effort control name pulled out of the binary, or null. */
  controlName: string | null
  /** Raw bytes, kept so we can try to load a recipe without re-reading. */
  bytes?: ArrayBuffer
}

/**
 * Scan an NPC binary for the longest run of printable ASCII that looks like the
 * control name. NPC files store the name as readable text inside a header
 * region; this is a heuristic, not a full parse.
 */
export function readNpcName(buf: ArrayBuffer): string | null {
  const b = new Uint8Array(buf)
  let best = ''
  let cur = ''
  // limit to the header region where the name lives
  const end = Math.min(b.length, 512)
  for (let i = 0; i < end; i++) {
    const c = b[i]
    if (c >= 0x20 && c <= 0x7e) {
      cur += String.fromCharCode(c)
    } else {
      if (cur.length >= 3 && cur.length > best.length && /[A-Za-z]/.test(cur)) best = cur
      cur = ''
    }
  }
  if (cur.length >= 3 && cur.length > best.length) best = cur
  best = best.trim()
  return best.length >= 3 ? best : null
}

export interface Recipe {
  format: 'npc-simulator-recipe'
  version: 1
  control: PictureControl
}

export function toRecipeJson(pc: PictureControl): string {
  const recipe: Recipe = { format: 'npc-simulator-recipe', version: 1, control: pc }
  return JSON.stringify(recipe, null, 2)
}

export function fromRecipeJson(json: string): PictureControl | null {
  try {
    const parsed = JSON.parse(json) as Recipe
    if (parsed?.format === 'npc-simulator-recipe' && parsed.control) return parsed.control
  } catch {
    /* ignore */
  }
  return null
}

/** Encode a recipe as bytes for the "Export" action (JSON payload for now). */
export function encodeRecipe(pc: PictureControl): ArrayBuffer {
  const json = toRecipeJson(pc)
  return new TextEncoder().encode(json).buffer
}
