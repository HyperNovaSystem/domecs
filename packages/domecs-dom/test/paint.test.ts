import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { paint, watchPresses } from '../src/index.js'

// H-7 (Harbor findings): a panel drawn from a string and written with
// innerHTML lost clicks — the button under the pointer was replaced between
// press and release — and the focus on every repaint. `paint` patches in
// place and holds off while a button inside is held down. Ported from
// Harbor's src/ui/dom.ts, where it took lost clicks at 64× from 3 in 12 to 0
// in 200.

/** What the markup parses to: the standard `paint` is held to. */
function parsed(html: string): HTMLElement {
  const fresh = document.createElement('div')
  fresh.innerHTML = html
  return fresh
}

function host(): HTMLElement {
  const node = document.createElement('div')
  document.body.append(node)
  return node
}

const press = (target: Element, type: string, button = 0): void => {
  target.dispatchEvent(new window.MouseEvent(type, { bubbles: true, button }) as unknown as Event)
}
const nextTask = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

describe('paint', () => {
  let unwatch = (): void => {}
  beforeEach(() => {
    document.body.innerHTML = ''
    unwatch = watchPresses(document)
  })
  afterEach(() => unwatch())

  it('makes an element match the markup, whatever was there', () => {
    expect(parsed('<p class="a">x</p>').isEqualNode(parsed('<p class="b">x</p>'))).toBe(false)
    const node = host()
    const steps = [
      '<p class="a">one</p>',
      '<p class="b" title="t">two</p><button data-x="1">go</button>',
      'bare text <b>then bold</b> then more',
      '<button data-x="2" class="btn">go</button>',
      '<ul><li>1</li><li>2</li><li>3</li></ul><span></span>',
      '<ul><li>2</li><li>3</li></ul>',
      '<svg class="icon" viewBox="0 0 24 24"><path d="M1 2h3"></path></svg><em>x</em>',
      '',
      '<div><div><i style="flex:3"></i></div></div>',
    ]
    for (const html of steps) {
      expect(paint(node, html)).toBe(true)
      expect(node.isEqualNode(parsed(html)), html).toBe(true)
      expect(paint(node, html)).toBe(false) // nothing to do the second time
    }
  })

  it('keeps the elements that are still wanted, and so the focus', () => {
    const node = host()
    const card = (condition: number): string =>
      `<section><h3>Crane <span class="tag">${condition}%</span></h3>` +
      `<span class="bar"><i style="width:${condition}%"></i></span><button class="btn">Service</button></section>`
    paint(node, card(99))
    const button = node.querySelector('button')!
    const bar = node.querySelector<HTMLElement>('.bar i')!
    button.focus()
    paint(node, card(42))
    expect(node.querySelector('button')).toBe(button)
    expect(node.querySelector('.bar i')).toBe(bar)
    expect(bar.getAttribute('style')).toBe('width:42%')
    expect(document.activeElement).toBe(button)
  })

  it('drops attributes and children that are no longer wanted', () => {
    const node = host()
    paint(node, '<button class="btn poor" title="too dear" disabled>Buy<small>now</small></button><i></i>')
    const button = node.querySelector('button')!
    paint(node, '<button class="btn">Buy</button>')
    expect(node.querySelector('button')).toBe(button)
    expect(button.getAttributeNames()).toEqual(['class'])
    expect(button.childNodes).toHaveLength(1)
    expect(node.children).toHaveLength(1)
  })

  it('leaves an element alone while a button in it is held down, then catches up after the click', () => {
    const node = host()
    const other = host()
    const view = (n: number): string => `<p>${n} idle</p><button>+10</button>`
    paint(node, view(1))
    paint(other, view(1))
    const button = node.querySelector('button')!
    press(button, 'pointerdown')
    expect(paint(node, '<p>the button is gone</p>')).toBe(false)
    expect(button.isConnected).toBe(true)
    expect(paint(other, view(2))).toBe(true) // nothing is held in this one
    expect(paint(node, view(3))).toBe(false)
    press(button, 'pointerup')
    let seen = ''
    document.addEventListener('click', () => {
      seen = node.querySelector('p')!.textContent!
      paint(node, view(5))
    }, { once: true })
    press(button, 'click')
    expect(seen).toBe('1 idle') // the click handler saw what was pressed
    expect(node.querySelector('p')!.textContent).toBe('5 idle') // and the latest markup is painted at once
    expect(node.querySelector('button')).toBe(button)
  })

  it('does not hold for the right button, and lets go when a press ends without a click', async () => {
    const node = host()
    paint(node, '<button>a</button>')
    press(node.querySelector('button')!, 'pointerdown', 2)
    expect(paint(node, '<button>b</button>')).toBe(true)
    press(node.querySelector('button')!, 'pointerdown')
    expect(paint(node, '<button>c</button>')).toBe(false)
    press(node.querySelector('button')!, 'pointerup')
    await nextTask()
    expect(node.textContent).toBe('c')
  })

  it('is per document: an element of another document is never held by this one', () => {
    const node = host()
    paint(node, '<button>a</button>')
    press(node.querySelector('button')!, 'pointerdown')
    const foreign = document.implementation.createHTMLDocument('other')
    const away = foreign.createElement('div')
    foreign.body.append(away)
    expect(paint(away, '<b>x</b>')).toBe(true)
  })
})
