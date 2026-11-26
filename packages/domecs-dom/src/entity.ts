import type { Entity } from '@domecs/core'

/**
 * H-9: the attribute `mountDOM` stamps on every element a view mounts,
 * holding the entity id, so a DOM event can be routed back to its entity.
 */
export const ENTITY_ATTRIBUTE = 'data-entity'

/**
 * The entity whose mounted element is `target` or holds it — the innermost
 * one, for nested views (H-8) — or `undefined` outside any. Takes an event's
 * `target` as it comes (a text node is read through its parent element).
 */
export function entityOf(target: EventTarget | Node | null | undefined): Entity | undefined {
  let node = target as Node | null | undefined
  if (node === null || node === undefined || typeof (node as Node).nodeType !== 'number') return undefined
  if (node.nodeType !== 1) node = node.parentElement
  if (node === null) return undefined
  const host = (node as Element).closest(`[${ENTITY_ATTRIBUTE}]`)
  if (host === null) return undefined
  const id = Number(host.getAttribute(ENTITY_ATTRIBUTE))
  return Number.isSafeInteger(id) && id >= 0 ? id : undefined
}
