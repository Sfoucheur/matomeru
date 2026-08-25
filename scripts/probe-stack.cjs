/**
 * A card with two sides, drawn as two cards, in the running app.
 *
 *   npm run build
 *   npx electron . --user-data-dir=/tmp/probe --remote-debugging-port=9380
 *   npm run probe:stack               (or: node scripts/probe-stack.cjs 9380)
 *
 * Give it a scratch profile: it adds cards.
 *
 * Two kinds of two-sided card go through the same tile and both are checked here -- a
 * paired token, whose sides are two printings, and a transform card, whose sides are two
 * faces of one printing. The tile is not told which it has.
 *
 * The tile does not turn cards over -- the detail dialog does, and `probe-flip.cjs`
 * checks that. What is left is what a still stack has to get right: it fits one card's
 * box, the two pictures overlap rather than stacking in flow, and the tile's own name and
 * badges are in front of the artwork rather than behind it. All of that is geometry and
 * layering, which is why it is measured in a running window.
 */
const PORT = process.argv[2]
let passed = 0
let failed = 0
const check = (label, ok, detail) => {
  if (ok) {
    passed++
    console.log('  PASS  ' + label)
  } else {
    failed++
    console.log('  FAIL  ' + label + (detail ? ' — ' + detail : ''))
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

;(async () => {
  const list = await (await fetch('http://127.0.0.1:' + PORT + '/json/list')).json()
  const page = list.find((t) => t.type === 'page' && !String(t.url).startsWith('devtools://'))
  const ws = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((r) => (ws.onopen = r))
  let id = 0
  const ev = (expression) =>
    new Promise((res, rej) => {
      const mine = ++id
      const on = (m) => {
        const d = JSON.parse(m.data)
        if (d.id !== mine) return
        ws.removeEventListener('message', on)
        if (d.result && d.result.exceptionDetails) {
          rej(new Error(d.result.exceptionDetails.exception
            ? d.result.exceptionDetails.exception.description
            : 'threw'))
          return
        }
        res(d.result && d.result.result ? d.result.result.value : undefined)
      }
      ws.addEventListener('message', on)
      ws.send(JSON.stringify({
        id: mine,
        method: 'Runtime.evaluate',
        params: { expression, returnByValue: true, awaitPromise: true }
      }))
    })

  // a paired token, and an ordinary card to compare against
  for (const line of ['c17 008/011 // 003', 'm10 146']) {
    await ev(`(async () => {
      document.querySelector('[data-action="updateLater"]')?.click()
      const nav = document.querySelector('nav') ?? document.querySelector('aside')
      ;[...nav.querySelectorAll('button')][1].click()
      await new Promise((r) => setTimeout(r, 700))
      ;[...document.querySelectorAll('button')]
        .filter((b) => /rapide|Fast/i.test(b.innerText))[0]?.click()
      await new Promise((r) => setTimeout(r, 400))
      const input = document.querySelector('input[placeholder*="m10"]')
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype, 'value').set
      setter.call(input, ${JSON.stringify(line)})
      input.dispatchEvent(new Event('input', { bubbles: true }))
      await new Promise((r) => setTimeout(r, 120))
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
      return true
    })()`)
    await sleep(8000)
  }

  // the collection, in gallery mode
  const tiles = JSON.parse(await ev(`(async () => {
    const nav = document.querySelector('nav') ?? document.querySelector('aside')
    ;[...nav.querySelectorAll('button')][0].click()
    await new Promise((r) => setTimeout(r, 1000))
    document.querySelector('[data-view="gallery"]')?.click()
    await new Promise((r) => setTimeout(r, 2000))
    const out = []
    for (const art of document.querySelectorAll('[data-stack]')) {
      const imgs = [...art.querySelectorAll('img')]
      out.push({
        stacked: true,
        images: imgs.map((i) => (i.getAttribute('src') || '').replace('matomeru://image/', '')),
        zOrder: imgs.map((i) => getComputedStyle(i.parentElement ?? i).zIndex)
      })
    }
    // and the ordinary tiles, for contrast
    const plain = [...document.querySelectorAll('button[title]')]
      .filter((b) => /Lightning Bolt/i.test(b.getAttribute('title') || ''))
      .map((b) => b.querySelectorAll('img').length)
    return JSON.stringify({ stacks: out, plainImageCounts: plain })
  })()`))
  console.log('        → ' + JSON.stringify(tiles).slice(0, 260))

  check('the paired card draws a stack', tiles.stacks.length >= 1, JSON.stringify(tiles.stacks))
  const stack = tiles.stacks[0] ?? { images: [] }
  check('with two different pictures in it',
    stack.images.length === 2 && new Set(stack.images.map((s) => s.split('?')[0])).size === 2,
    JSON.stringify(stack.images))
  check('an ordinary card still draws exactly one picture',
    tiles.plainImageCounts.length > 0 && tiles.plainImageCounts.every((n) => n === 1),
    JSON.stringify(tiles.plainImageCounts))

  // the hover swap: which one is on top
  const swap = JSON.parse(await ev(`(async () => {
    const art = document.querySelector('[data-stack]')
    const read = () => [...art.querySelectorAll('img')].map((i) => ({
      id: (i.getAttribute('src') || '').replace('matomeru://image/', '').split('?')[0].slice(0, 8),
      z: getComputedStyle(i).zIndex,
      area: i.getBoundingClientRect().width * i.getBoundingClientRect().height
    }))
    const before = read()
    art.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }))
    art.dispatchEvent(new PointerEvent('pointerover', { bubbles: true }))
    await new Promise((r) => setTimeout(r, 400))
    const after = read()
    return JSON.stringify({ before, after })
  })()`))
  console.log('        → hover: ' + JSON.stringify(swap))
  check('both cards are drawn at the same size, so the pair reads as a pair',
    swap.before.length === 2 && Math.abs(swap.before[0].area - swap.before[1].area) < 2,
    JSON.stringify(swap.before))

  // ----------------------------------------------------------------------------
  // Where the cards actually are. Everything above says which pictures a tile asks
  // for; none of it says whether they land inside the tile.
  // ----------------------------------------------------------------------------
  {
    const geometry = JSON.parse(await ev(`(async () => {
      const round = (r) => ({
        x: Math.round(r.left),
        y: Math.round(r.top),
        w: Math.round(r.width),
        h: Math.round(r.height)
      })
      const art = document.querySelector('[data-stack]')
      const stackTile = art ? art.closest('button') : null
      // A tile with one picture, to compare against.
      const plainTile = [...document.querySelectorAll('button[title]')].find(
        (b) => b.querySelectorAll('img').length === 1 && b.querySelector('img')
      )
      return JSON.stringify({
        tile: stackTile ? round(stackTile.getBoundingClientRect()) : null,
        plain: plainTile ? round(plainTile.getBoundingClientRect()) : null,
        cards: art
          ? [...art.querySelectorAll('img')].map((i) => round(i.getBoundingClientRect()))
          : []
      })
    })()`))
    console.log('        \u2192 tile  ' + JSON.stringify(geometry.tile))
    console.log('        \u2192 plain ' + JSON.stringify(geometry.plain))
    for (const c of geometry.cards) console.log('        \u2192 card  ' + JSON.stringify(c))

    const { tile, plain, cards } = geometry
    check('a two-sided tile is the same size as a one-sided one',
      tile !== null && plain !== null &&
        Math.abs(tile.w - plain.w) <= 1 && Math.abs(tile.h - plain.h) <= 1,
      JSON.stringify({ tile, plain }))

    const inside = (c) =>
      c.x >= tile.x - 1 && c.y >= tile.y - 1 &&
      c.x + c.w <= tile.x + tile.w + 1 && c.y + c.h <= tile.y + tile.h + 1
    check('and both cards are drawn inside it',
      cards.length === 2 && cards.every(inside),
      JSON.stringify(cards))

    const [a, b] = cards.length === 2 ? cards : [null, null]
    const overlapW = a && b ? Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x) : 0
    const overlapH = a && b ? Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y) : 0
    check('the two cards overlap, rather than sitting one below the other',
      overlapW > 0 && overlapH > 0, JSON.stringify({ overlapW, overlapH }))
    check('and they are offset, so the one behind is visible at all',
      a && b && (Math.abs(a.x - b.x) > 2 || Math.abs(a.y - b.y) > 2),
      JSON.stringify({ a, b }))
  }

  // ----------------------------------------------------------------------------
  // Layering: the tile's own name and badges must sit above the artwork.
  // ----------------------------------------------------------------------------
  {
    const layering = JSON.parse(await ev(`(() => {
      const art = document.querySelector('[data-stack]')
      const tile = art ? art.closest('button') : null
      if (!tile) return JSON.stringify({ found: false })
      const at = (el) => {
        const r = el.getBoundingClientRect()
        const hit = document.elementFromPoint(
          Math.round(r.left + r.width / 2),
          Math.round(r.top + r.height / 2)
        )
        return hit ? hit.tagName : null
      }
      const name = tile.querySelector('p')
      const badge = tile.querySelector('[class*="right-1.5"] *')
      return JSON.stringify({
        found: true,
        nameText: name ? name.innerText.trim().slice(0, 40) : null,
        overName: name ? at(name) : null,
        overBadge: badge ? at(badge) : null
      })
    })()`))
    console.log('        \u2192 layering ' + JSON.stringify(layering))
    check("the tile's name is in front of the artwork, not behind it",
      layering.overName !== null && layering.overName !== 'IMG',
      `the topmost element over the name is <${layering.overName}>`)
    if (layering.overBadge !== null) {
      check('and so are its badges',
        layering.overBadge !== 'IMG',
        `the topmost element over a badge is <${layering.overBadge}>`)
    }
  }

  console.log('\n' + passed + ' passed, ' + failed + ' failed')
  ws.close()
  process.exit(failed === 0 ? 0 : 1)
})().catch((e) => {
  console.log('  probe failed: ' + e.message)
  process.exit(1)
})
