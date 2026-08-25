/**
 * The card detail dialog: does it turn the card over, and does it hold its size?
 *
 *   npm run build
 *   npx electron . --user-data-dir=/tmp/probe --remote-debugging-port=9410
 *   npm run probe:flip                (or: node scripts/probe-flip.cjs 9410)
 *
 * Give it a scratch profile: it adds cards.
 *
 * Both things this checks are visual, and neither is visible to a unit test. The dialog
 * used to be as tall as its contents, so turning a card over -- which swaps the rules text
 * -- moved the dialog under the pointer, and every card opened at a different size. And a
 * flip is a flip only if there are frames between the two end states, which means catching
 * the transform mid-rotation.
 */
const PORT = process.argv[2] ?? '9410'
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
  const send = (method, params) =>
    new Promise((res, rej) => {
      const mine = ++id
      const on = (m) => {
        const d = JSON.parse(m.data)
        if (d.id !== mine) return
        ws.removeEventListener('message', on)
        if (d.error) {
          rej(new Error(JSON.stringify(d.error)))
          return
        }
        res(d.result)
      }
      ws.addEventListener('message', on)
      ws.send(JSON.stringify({ id: mine, method, params }))
    })
  const ev = async (expression) => {
    const r = await send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true
    })
    if (r.exceptionDetails) {
      throw new Error(r.exceptionDetails.exception
        ? r.exceptionDetails.exception.description
        : 'threw')
    }
    return r.result ? r.result.value : undefined
  }

  const add = async (line) => {
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

  /*
    A transform card, a paired token, and an ordinary card with a lot of rules text -- the
    third one is what proves the size does not follow the content.
  */
  await add('ecl 61')
  await add('c17 008/011 // 003')
  await add('m10 146')

  const closeDialog = () => ev(`(() => {
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    return true
  })()`)

  const openCard = (needle) => ev(`(async () => {
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    await new Promise((r) => setTimeout(r, 400))
    const nav = document.querySelector('nav') ?? document.querySelector('aside')
    ;[...nav.querySelectorAll('button')][0].click()
    await new Promise((r) => setTimeout(r, 900))
    document.querySelector('[data-view="table"]')?.click()
    await new Promise((r) => setTimeout(r, 800))
    const link = [...document.querySelectorAll('button')]
      .find((b) => new RegExp(${JSON.stringify(needle)}, 'i').test((b.innerText || '').trim()))
    if (!link) throw new Error('no row for ' + ${JSON.stringify(needle)})
    link.click()
    await new Promise((r) => setTimeout(r, 1600))
    return true
  })()`)

  const dialog = () => ev(`(() => {
    const d = document.querySelector('[role="dialog"]')
    if (!d) return JSON.stringify({ open: false })
    const r = d.getBoundingClientRect()
    const card = d.querySelector('[data-flip="card"]')
    const flip = [...d.querySelectorAll('button')].find((b) => /^[^\\n]{2,60}$/.test(
      (b.innerText || '').trim()) && b.querySelector('svg') && !b.getAttribute('aria-label'))
    return JSON.stringify({
      open: true,
      box: { w: Math.round(r.width), h: Math.round(r.height) },
      transform: card ? getComputedStyle(card).transform : null,
      faces: d.querySelectorAll('[data-flip-face]').length,
      backfaces: [...d.querySelectorAll('[data-flip-face]')]
        .map((f) => getComputedStyle(f).backfaceVisibility)
    })
  })()`)

  const clickFlip = () => ev(`(() => {
    const d = document.querySelector('[role="dialog"]')
    const btn = [...d.querySelectorAll('button')].find((b) => b.querySelector('svg') &&
      (b.innerText || '').trim().length > 1 && !b.getAttribute('aria-label'))
    if (!btn) throw new Error('no flip control')
    btn.click()
    return true
  })()`)

  // ---- 1. a transform card: the shape of the flip
  await openCard('Oko')
  const front = JSON.parse(await dialog())
  console.log('        → front ' + JSON.stringify(front))
  check('the dialog opens with both faces present', front.faces === 2,
    `${front.faces} faces`)
  check('and each hides its own back, so the far side shows only past edge-on',
    front.backfaces.length === 2 && front.backfaces.every((v) => v === 'hidden'),
    JSON.stringify(front.backfaces))
  check('at rest the card is not rotated',
    front.transform === 'none' || front.transform === 'matrix(1, 0, 0, 1, 0, 0)',
    String(front.transform))

  // ---- 2. it rotates, rather than cutting
  await clickFlip()
  await sleep(90)
  const midway = JSON.parse(await dialog())
  console.log('        → mid   ' + String(midway.transform).slice(0, 76))
  const settledish = (t) =>
    t === 'none' || t === 'matrix(1, 0, 0, 1, 0, 0)' || /^matrix\(-1, 0, 0, 1/.test(t)
  check('the card is caught mid-turn, so it is a rotation and not a cut',
    !settledish(String(midway.transform)) && /matrix3d|matrix/.test(String(midway.transform)),
    String(midway.transform).slice(0, 90))

  let turned = null
  for (let i = 0; i < 15; i++) {
    await sleep(200)
    turned = JSON.parse(await dialog())
    if (/^matrix3d\(-1|^matrix\(-1/.test(String(turned.transform))) break
  }
  console.log('        → back  ' + String(turned.transform).slice(0, 76))
  check('and it settles turned over',
    /^matrix3d\(-1|^matrix\(-1/.test(String(turned.transform)),
    String(turned.transform).slice(0, 90))

  // ---- 3. the size does not move
  check('the dialog is the same size after turning the card over',
    turned.box.w === front.box.w && turned.box.h === front.box.h,
    JSON.stringify({ before: front.box, after: turned.box }))

  await closeDialog()
  await sleep(700)

  // ---- 4. and the same size for a different card entirely
  for (const [needle, label] of [
    ['Cat Warrior', 'a paired token'],
    ['Lightning Bolt', 'a one-sided card']
  ]) {
    await openCard(needle)
    const other = JSON.parse(await dialog())
    console.log(`        → ${label} ` + JSON.stringify(other.box))
    check(`${label} opens at exactly the same size`,
      other.box.w === front.box.w && other.box.h === front.box.h,
      JSON.stringify({ reference: front.box, got: other.box }))
    await closeDialog()
    await sleep(700)
  }

  /*
    And the column that scrolls is the words, not the card. With a fixed dialog the
    alternative is either clipped text or a scrollbar that carries the artwork away.
  */
  await openCard('Oko')
  const scrolled = JSON.parse(await ev(`(() => {
    const d = document.querySelector('[role="dialog"]')
    const art = d.querySelector('[data-flip="stage"]') ?? d.querySelector('img')
    // The details column is the scrollable one beside the art.
    const col = [...d.querySelectorAll('div')].find(
      (e) => e.scrollHeight > e.clientHeight + 4 && e.clientHeight > 200
    )
    if (!col) return JSON.stringify({ scrollable: false })
    const before = Math.round(art.getBoundingClientRect().top)
    col.scrollTop = col.scrollHeight
    const after = Math.round(art.getBoundingClientRect().top)
    return JSON.stringify({
      scrollable: true,
      moved: col.scrollTop > 0,
      artBefore: before,
      artAfter: after
    })
  })()`))
  console.log('        \u2192 scroll ' + JSON.stringify(scrolled))
  if (scrolled.scrollable) {
    check('the details column scrolls', scrolled.moved === true, JSON.stringify(scrolled))
    check('and the artwork stays where it is while it does',
      scrolled.artBefore === scrolled.artAfter, JSON.stringify(scrolled))
  } else {
    console.log('        (no card here is long enough to need scrolling)')
  }

  console.log('\n' + passed + ' passed, ' + failed + ' failed')
  ws.close()
  process.exit(failed === 0 ? 0 : 1)
})().catch((e) => {
  console.log('  probe failed: ' + e.message)
  process.exit(1)
})
