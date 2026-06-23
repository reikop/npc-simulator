// Nikon .NP3 (Picture Control, format version "0310") writer.
//
// Reverse-engineered from a real NX Studio export. The container is a simple
// tag-length-value stream:
//
//   "NCP\0"                         4-byte magic
//   00 00 01 00                     format flags
//   00 00 00 04                     record count hint
//   "0310"                          version string (ASCII)
//   then records, each:  id(uint32 BE)  len(uint32 BE)  value[len]
//
// Decoded record map (id → meaning), from the sample:
//   0x0200  preset name (ASCII, zero-padded; 20 bytes in the sample)
//   0x0300..0x1e00  individual parameters, 2 bytes each = <value><type/flag>
//                   0x80 = neutral (128), 0xFF = "Auto"
//   0x1f00  28-byte block — high-entropy, appears encoded/checksummed
//   0x2000  20-byte block — curve / colour data + trailer
//
// What we can write reliably from one sample is the NAME (plain ASCII at a
// fixed offset). The per-slider value records and the 0x1f00/0x2000 curve
// blocks use an encoding we cannot confirm without several varied .NP3 samples,
// so we DO NOT fabricate them — the exported file keeps the template's tested
// parameter block and only swaps in your preset name, yielding a structurally
// valid, camera-loadable Picture Control. (Give me a few more NX Studio exports
// with different curves/sliders and the value records can be mapped too.)

// Base64 of the reference NX Studio export ("Filmstill's Classic Neg.NP3").
const TEMPLATE_B64 =
  'TkNQAAAAAQAAAAAEMDMxMAAAAgAAAAAURmlsbXN0aWxsJ3MgQ05lZwAAAAAAAAMAAAAAAgAgAAAEAAAAAAIAAAAABQAAAAAC/wEAAAYAAAAAAogEAAAHAAAAAAKCBAAACAAAAAAC/wQAAAkAAAAAAv8EAAAKAAAAAAL/BAAACwAAAAAC/wQAAAwAAAAAAv8AAAANAAAAAAL/AAAADgAAAAAC/wQAAA8AAAAAAv8BAAAQAAAAAAL/AQAAEQAAAAAC/wEAABIAAAAAAv8BAAATAAAAAAL/AQAAFAAAAAACgAEAABUAAAAAAv8KAAAWAAAAAAKEBAAAFwAAAAAC/wQAABgAAAAAAv8EAAAZAAAAAALkAQAAGgAAAAACgAEAABsAAAAAAk4BAAAcAAAAAAJxAQAAHQAAAAACjwEAAB4AAAAAAl8BAAAfAAAAABya3YWK0HZngKPSj0my5DVskEm3WF68t3EBAQEAAAAgAAAAABSAfIWegBSUsoAUjxwBAQEA2gFYAQAAAAA='

// offset/length of the name value record (id 0x0200) inside the template
const NAME_OFFSET = 24
const NAME_LEN = 20

function decodeTemplate(): Uint8Array {
  const bin = atob(TEMPLATE_B64)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

/** Sanitise a preset name to the ASCII Nikon accepts, capped to fit the field. */
function sanitizeName(name: string): string {
  const ascii = name.replace(/[^\x20-\x7e]/g, '').trim()
  return (ascii || 'CUSTOM').slice(0, NAME_LEN - 1) // leave a null terminator
}

/**
 * Build a valid .NP3 binary for a preset name. The look is inherited from the
 * reference template; only the name is rewritten (see the module note for why).
 */
export function buildNp3(name: string): ArrayBuffer {
  const bytes = decodeTemplate()
  const safe = sanitizeName(name)
  // clear the fixed name field, then write the ASCII name (zero-padded)
  for (let i = 0; i < NAME_LEN; i++) bytes[NAME_OFFSET + i] = 0
  for (let i = 0; i < safe.length; i++) bytes[NAME_OFFSET + i] = safe.charCodeAt(i)
  return bytes.buffer as ArrayBuffer
}
