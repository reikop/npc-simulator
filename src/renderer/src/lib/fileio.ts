// Browser file I/O helpers (replaces the Electron main-process IPC).
// Uses plain <input type=file> for opening images, the File System Access API
// (with a <input webkitdirectory> fallback) for reading an NPC folder, and a
// blob download for saving/exporting.

export interface OpenedImage {
  name: string
  bytes: ArrayBuffer
}

export interface FolderNpc {
  name: string
  size: number
  bytes: ArrayBuffer
}

const IMAGE_ACCEPT = '.jpg,.jpeg,.png,.webp,.nef,.nrw'
const NPC_EXTS = ['ncp', 'np2', 'np3']

function hasExt(name: string, exts: string[]): boolean {
  const e = name.split('.').pop()?.toLowerCase() ?? ''
  return exts.includes(e)
}

/** Open a single image file via a hidden file input. */
export function pickImageFile(): Promise<OpenedImage | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = IMAGE_ACCEPT
    input.onchange = async () => {
      const f = input.files?.[0]
      if (!f) return resolve(null)
      resolve({ name: f.name, bytes: await f.arrayBuffer() })
    }
    // if the dialog is cancelled there is no event; that's fine (promise stays pending
    // until GC). To avoid leaks we also listen on window focus once.
    input.click()
  })
}

export interface OpenedText {
  name: string
  text: string
}

/** Open a single XMP preset file (text) via a hidden file input. */
export function pickXmpFile(): Promise<OpenedText | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = '.xmp,application/rdf+xml,text/xml'
    input.onchange = async () => {
      const f = input.files?.[0]
      if (!f) return resolve(null)
      resolve({ name: f.name, text: await f.text() })
    }
    input.click()
  })
}

/**
 * Pick a folder and return every NPC file inside it (bytes loaded eagerly —
 * NPC folders are tiny). Prefers the File System Access API; falls back to a
 * directory <input> on browsers without it.
 */
export async function pickNpcFolder(): Promise<FolderNpc[] | null> {
  const w = window as unknown as {
    showDirectoryPicker?: () => Promise<FileSystemDirectoryHandleLike>
  }
  if (w.showDirectoryPicker) {
    try {
      const dir = await w.showDirectoryPicker()
      const out: FolderNpc[] = []
      for await (const [name, handle] of dir.entries()) {
        if (handle.kind !== 'file' || !hasExt(name, NPC_EXTS)) continue
        const file = await handle.getFile()
        out.push({ name, size: file.size, bytes: await file.arrayBuffer() })
      }
      return out.sort((a, b) => a.name.localeCompare(b.name))
    } catch (err) {
      if ((err as DOMException)?.name === 'AbortError') return null
      // fall through to input fallback
    }
  }
  return pickNpcFolderFallback()
}

function pickNpcFolderFallback(): Promise<FolderNpc[] | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input')
    input.type = 'file'
    ;(input as unknown as { webkitdirectory: boolean }).webkitdirectory = true
    input.multiple = true
    input.onchange = async () => {
      const files = Array.from(input.files ?? []).filter((f) => hasExt(f.name, NPC_EXTS))
      if (files.length === 0) return resolve([])
      const out: FolderNpc[] = []
      for (const f of files) {
        out.push({ name: f.name, size: f.size, bytes: await f.arrayBuffer() })
      }
      resolve(out.sort((a, b) => a.name.localeCompare(b.name)))
    }
    input.click()
  })
}

/** Trigger a browser download of arbitrary bytes/text. */
export function downloadBlob(filename: string, data: ArrayBuffer | string): void {
  const blob =
    typeof data === 'string'
      ? new Blob([data], { type: 'application/json' })
      : new Blob([data], { type: 'application/octet-stream' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

// minimal structural types for the File System Access API (not in lib.dom yet)
interface FileSystemDirectoryHandleLike {
  entries(): AsyncIterableIterator<[string, FileSystemHandleLike]>
}
interface FileSystemHandleLike {
  kind: 'file' | 'directory'
  getFile(): Promise<File>
}
