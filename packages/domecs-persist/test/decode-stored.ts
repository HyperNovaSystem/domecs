import type { WorldSnapshot } from '@domecs/core'
import { decodeSave } from '../src/index.js'

/** The snapshot in stored save text (header and codec, H-11/H-12), as load() would decode it. */
export function decodeStored(text: string): WorldSnapshot {
  const d = decodeSave(text)
  if (!d.ok) throw new Error(`stored text did not decode: ${JSON.stringify(d.error)}`)
  return d.value.snapshot
}
