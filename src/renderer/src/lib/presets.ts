// Built-in preset library. These are original recipes crafted to evoke common
// film / camera looks — not copied from any third-party site's data.

import type { PictureControl } from './pictureControl'
import { identityCurve } from './pictureControl'
import libraryData from './library.json'

let n = 0
const id = (s: string) => `${s}-${n++}`

function curve(pts: [number, number][]): { x: number; y: number }[] {
  return pts.map(([x, y]) => ({ x, y }))
}

export const PRESETS: PictureControl[] = [
  {
    id: id('standard'),
    name: 'Standard',
    mode: 'color',
    curve: identityCurve(),
    brightness: 0,
    contrast: 0,
    saturation: 0,
    hue: 0,
    sharpening: 15,
    filter: 'none',
    toning: null
  },
  {
    id: id('vivid'),
    name: 'Vivid',
    mode: 'color',
    curve: curve([
      [0, 0],
      [64, 54],
      [128, 132],
      [192, 205],
      [255, 255]
    ]),
    brightness: 0,
    contrast: 22,
    saturation: 38,
    hue: -4,
    sharpening: 28,
    filter: 'none',
    toning: null
  },
  {
    id: id('portrait'),
    name: 'Soft Portrait',
    mode: 'color',
    curve: curve([
      [0, 12],
      [128, 130],
      [255, 246]
    ]),
    brightness: 4,
    contrast: -12,
    saturation: -6,
    hue: 4,
    sharpening: 8,
    filter: 'none',
    toning: { color: '#f3d6c0', strength: 14 }
  },
  {
    id: id('teal-orange'),
    name: 'Teal & Orange',
    mode: 'color',
    curve: curve([
      [0, 10],
      [70, 60],
      [180, 196],
      [255, 250]
    ]),
    brightness: -2,
    contrast: 16,
    saturation: 10,
    hue: -10,
    sharpening: 18,
    filter: 'none',
    toning: { color: '#1f6f78', strength: 12 }
  },
  {
    id: id('warm-film'),
    name: 'Warm Film',
    mode: 'color',
    curve: curve([
      [0, 18],
      [64, 70],
      [192, 196],
      [255, 242]
    ]),
    brightness: 3,
    contrast: -6,
    saturation: 12,
    hue: 6,
    sharpening: 10,
    filter: 'none',
    toning: { color: '#e8c79a', strength: 20 }
  },
  {
    id: id('mono'),
    name: 'Monochrome',
    mode: 'monochrome',
    curve: curve([
      [0, 0],
      [128, 128],
      [255, 255]
    ]),
    brightness: 0,
    contrast: 14,
    saturation: 0,
    hue: 0,
    sharpening: 22,
    filter: 'none',
    toning: null
  },
  {
    id: id('mono-red'),
    name: 'B&W Red Filter',
    mode: 'monochrome',
    curve: curve([
      [0, 0],
      [96, 84],
      [255, 255]
    ]),
    brightness: 0,
    contrast: 28,
    saturation: 0,
    hue: 0,
    sharpening: 26,
    filter: 'red',
    toning: null
  },
  {
    id: id('sepia'),
    name: 'Sepia',
    mode: 'monochrome',
    curve: curve([
      [0, 8],
      [128, 132],
      [255, 248]
    ]),
    brightness: 2,
    contrast: 10,
    saturation: 0,
    hue: 0,
    sharpening: 14,
    filter: 'none',
    monoTone: { type: 'sepia', density: 5 },
    toning: null
  },
  {
    id: id('cyanotype'),
    name: 'Cyanotype',
    mode: 'monochrome',
    curve: curve([
      [0, 6],
      [128, 128],
      [255, 244]
    ]),
    brightness: 0,
    contrast: 12,
    saturation: 0,
    hue: 0,
    sharpening: 14,
    filter: 'none',
    monoTone: { type: 'cyanotype', density: 6 },
    toning: null
  }
]

/** Deep clone a preset so edits don't mutate the library. */
export function clonePreset(pc: PictureControl): PictureControl {
  return JSON.parse(JSON.stringify(pc))
}

/** A preset imported from nikonpc.com, with provenance metadata. */
export interface LibraryPreset extends PictureControl {
  sourcePath?: string
  binaryBytes?: number
}

/** All presets downloaded from nikonpc.com (curve points + settings). */
export const LIBRARY: LibraryPreset[] = libraryData as LibraryPreset[]

/** Built-ins first, then the full downloaded library. */
export const ALL_PRESETS: LibraryPreset[] = [...PRESETS, ...LIBRARY]
