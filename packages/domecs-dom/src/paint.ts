/**
 * H-7 (Harbor findings): patch an element to match a markup string, for
 * panels drawn from strings. Writing such a panel with `innerHTML` replaces
 * the button under the pointer between press and release — so the click
 * never fires — and drops the focus on every repaint. `paint` keeps every
 * node that is still right, and `watchPresses` holds repaints off whatever
 * the primary button is pressing until the click has landed.
 */

interface PressState {
  /** The element the primary button went down on, until it comes back up. */
  pressed: Element | null
  /** Markup asked for during that press, by the element it is waiting for. */
  readonly held: Map<Element, string>
}

const presses = new WeakMap<Document, PressState>()
const painted = new WeakMap<Element, string>()

/**
 * Make `target`'s content match `html`, keeping every node that is already
 * right — an element whose tag matches is kept and its attributes and
 * children brought into line, so focus, scroll positions and CSS
 * transitions survive. Nothing is touched when `html` is what was last
 * painted, nor while a press that `watchPresses` is tracking is under way
 * inside `target` (the markup is painted once the click has landed). True
 * when the DOM changed.
 *
 * `paint` owns `target`'s content: it compares against what it last painted,
 * so do not change that content by other means.
 */
export function paint(target: Element, html: string): boolean {
  const press = presses.get(target.ownerDocument)
  if (painted.get(target) === html) {
    press?.held.delete(target)
    return false
  }
  if (press !== undefined && press.pressed !== null && target.contains(press.pressed)) {
    press.held.set(target, html)
    return false
  }
  painted.set(target, html)
  const want = target.ownerDocument.createElement('template')
  want.innerHTML = html
  morph(target, want.content)
  return true
}

/**
 * Forget what {@link paint} last wrote into `target` (and any markup held
 * for it), before its content is cleared by other means — so the same
 * markup painted again is written, not skipped as already there.
 */
export function forgetPaint(target: Element): void {
  painted.delete(target)
  presses.get(target.ownerDocument)?.held.delete(target)
}

/**
 * Keep {@link paint} off whatever the primary button is pressing in
 * `root`: what was under the pointer when the button went down is still
 * there, unchanged, when it comes up, so the click lands — and lands on what
 * was aimed at, not on what a re-sorted list has moved into its place.
 * Markup asked for meanwhile is painted as soon as the click has been
 * dispatched (or, for a press that ends without a click, on the next task).
 * Returns a function that stops watching.
 */
export function watchPresses(root: Document): () => void {
  let state = presses.get(root)
  if (state === undefined) {
    state = { pressed: null, held: new Map() }
    presses.set(root, state)
  }
  const own = state
  const down = (ev: Event): void => {
    if ((ev as PointerEvent).button > 0) return // only the primary button ends in a click
    const t = ev.target as Node | null
    own.pressed = t !== null && t.nodeType === 1 ? (t as Element) : null
  }
  const release = (): void => {
    own.pressed = null
    const waiting = [...own.held]
    own.held.clear()
    for (const [target, html] of waiting) paint(target, html)
  }
  // The click that ends a press is dispatched after pointerup, in the same
  // task, and reaches the window last: by then every handler has read what
  // was pressed, and the page can catch up before the next frame. The timer
  // is for a press that ends without a click.
  const up = (): void => void setTimeout(release, 0)
  const view = root.defaultView
  root.addEventListener('pointerdown', down, true)
  root.addEventListener('pointerup', up, true)
  root.addEventListener('pointercancel', up, true)
  view?.addEventListener('click', release)
  view?.addEventListener('blur', up)
  return () => {
    root.removeEventListener('pointerdown', down, true)
    root.removeEventListener('pointerup', up, true)
    root.removeEventListener('pointercancel', up, true)
    view?.removeEventListener('click', release)
    view?.removeEventListener('blur', up)
    release()
  }
}

/** Bring `live`'s children into line with `want`'s, position by position, reusing what matches. */
function morph(live: Node, want: Node): void {
  let have = live.firstChild
  let next = want.firstChild
  while (next !== null) {
    const after = next.nextSibling
    if (have !== null && have.nodeType === next.nodeType && have.nodeName === next.nodeName) {
      if (have.nodeType === 1 /* an element */) {
        attributes(have as Element, next as Element)
        morph(have, next)
      } else if (have.nodeValue !== next.nodeValue) {
        have.nodeValue = next.nodeValue
      }
      have = have.nextSibling
    } else {
      live.insertBefore(next, have) // a different kind of node belongs here: take the wanted one whole
    }
    next = after
  }
  while (have !== null) {
    const gone = have
    have = have.nextSibling
    live.removeChild(gone)
  }
}

function attributes(live: Element, want: Element): void {
  for (const name of live.getAttributeNames()) {
    if (!want.hasAttribute(name)) live.removeAttribute(name)
  }
  for (const name of want.getAttributeNames()) {
    const value = want.getAttribute(name)!
    if (live.getAttribute(name) !== value) live.setAttribute(name, value)
  }
}
