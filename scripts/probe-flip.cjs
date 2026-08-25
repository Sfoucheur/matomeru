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
      // Fast entry is four fields now; the old single line split the same way.
      const parts = ${JSON.stringify(line)}.trim().split(' ').filter(Boolean)
      const put = (sel, value) => {
        const el = document.querySelector(sel)
        if (!el) throw new Error('no fast-entry field ' + sel)
        Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')
          .set.call(el, value)
        el.dispatchEvent(new Event('input', { bubbles: true }))
        return el
      }
      put('[data-field="set"]', parts[0])
      const number = put('[data-field="number"]', parts[1] ?? '')
      await new Promise((r) => setTimeout(r, 140))
      number.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
      return true
    })()`)
    await sleep(8000)
  }

  /*
    A transform card, an ordinary card with almost no rules text, and one with a great
    deal of it. The last two are what prove the size does not follow the content.
  */
  await add('ecl 61')
  await add('m10 146')
  await add('c17 8')

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
    return JSON.stringify({
      open: true,
      box: { w: Math.round(r.width), h: Math.round(r.height) },
      viewport: { w: window.innerWidth, h: window.innerHeight },
      // Both: the intent the component holds, and what the browser actually drew. A
      // failure reporting turned=true with no rotation is the animation; one reporting
      // turned=false after a click is the control. (No backticks here: this comment is
      // inside a template literal, and one would end it.)
      turned: card ? card.dataset.turned : null,
      transform: card ? getComputedStyle(card).transform : null,
      faces: d.querySelectorAll('[data-flip-face]').length,
      backfaces: [...d.querySelectorAll('[data-flip-face]')]
        .map((f) => getComputedStyle(f).backfaceVisibility)
    })
  })()`)

  /*
    By its handle, not by shape. This used to hunt for "a button with an icon, some text
    and no aria-label", which in a dialog full of icon buttons is a guess.
  */
  const clickFlip = () => ev(`(() => {
    const btn = document.querySelector('[role="dialog"] [data-action="flipCard"]')
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

  /*
    ---- 3b. the ceiling.

    The dialog follows its content and stops at 92% of the window. On the default window
    every card's details are taller than that, so what is measured here is the ceiling --
    against the window rather than a pixel count, which is the only way it catches a clamp:
    `Modal` used to carry a hardcoded max-h-[85vh] alongside the height a caller stated, and
    max-h beats h, so the dialog asked for 88vh and was drawn at 85 with nothing to say so.
  */
  {
    const cap = Math.round(front.viewport.h * 0.92)
    check('the dialog never grows past the window ceiling',
      front.box.h <= cap + 2,
      JSON.stringify({ got: front.box.h, cap, viewport: front.viewport.h }))
    check('and it uses the width of the window it is in',
      front.box.w >= Math.min(front.viewport.w - 48, 1120),
      JSON.stringify({ got: front.box.w, viewport: front.viewport.w }))
  }

  /*
    ---- 3c. the card is card-shaped.

    A Magic card is 488x680, ratio 0.7176. `object-contain` keeps the *picture's* ratio but
    says nothing about the frame around it: the rounded corners and the ring belong to the
    box, and when that box is the column's width by the details column's height, the result
    is a card floating in a tall letterbox. Measured on the framed element itself, because
    that is the thing whose shape you see.
  */
  {
    // Opens its own card: the section above closes the dialog, and a check that measures
    // whatever the previous one left behind is a check that reports its own ordering.
    await openCard('Oko')
    const frame = JSON.parse(await ev(`(() => {
      const el = document.querySelector('[role="dialog"] [data-card-frame]')
      if (!el) return JSON.stringify({ found: false })
      const r = el.getBoundingClientRect()
      const body = el.closest('[role="dialog"]').getBoundingClientRect()
      const column = el.parentElement.parentElement.getBoundingClientRect()
      return JSON.stringify({
        found: true,
        w: Math.round(r.width),
        h: Math.round(r.height),
        ratio: Number((r.width / r.height).toFixed(3)),
        column: Math.round(column.width),
        viewport: window.innerWidth,
        insideWidth: r.right <= body.right + 1,
        insideHeight: r.bottom <= body.bottom + 1
      })
    })()`))
    console.log('        → frame ' + JSON.stringify(frame))
    check('the framed card keeps a card its shape',
      frame.found && Math.abs(frame.ratio - 488 / 680) <= 0.02,
      JSON.stringify(frame))
    check('and it stays inside the dialog on both axes',
      frame.insideWidth === true && frame.insideHeight === true, JSON.stringify(frame))
    /*
      And it is actually big. Taking the picture out of the layout flow -- which is what
      lets the dialog follow its content -- left nothing in that column asking for width,
      so it collapsed to its floor and the card came out at 224px, smaller than before the
      dialog was ever made to grow. A ratio check alone passes happily on a tiny card.
    */
    check('it fills the column it is in, rather than sitting in a letterbox',
      frame.w >= frame.column - 2, JSON.stringify(frame))
    if (frame.viewport >= 1200) {
      check('and on a wide window it is a card you can actually read',
        frame.w >= 320, JSON.stringify(frame))
    }
    await closeDialog()
    await sleep(500)
  }

  /*
    ---- 4. and below the ceiling it follows its content.

    Measured in a taller viewport on purpose. On the default window every card's details
    exceed the ceiling, so three cards agree at 92vh and a check there would pass whether
    the height followed the content or ignored it entirely -- which is exactly what it did
    before this: one fixed size for every card, leaving a short card in a lot of empty
    space. With room to breathe, a card with two lines of rules text must not produce the
    same dialog as one with a paragraph.
  */
  {
    await send('Emulation.setDeviceMetricsOverride',
      { width: front.viewport.w, height: 1500, deviceScaleFactor: 1, mobile: false })
    await sleep(700)
    const heights = {}
    for (const [needle, label] of [
      ['Lightning Bolt', 'short'],
      ['Teferi', 'wordy']
    ]) {
      await openCard(needle)
      const seen = JSON.parse(await dialog())
      heights[label] = seen.box.h
      const cap = Math.round(seen.viewport.h * 0.92)
      console.log(`        → ${label}: ` + JSON.stringify({ h: seen.box.h, cap }))
      check(`a ${label} card sits under the ceiling when there is room for it`,
        seen.box.h < cap, JSON.stringify({ got: seen.box.h, cap }))
      await closeDialog()
      await sleep(500)
    }
    check('a card with less to say gets a shorter dialog',
      heights.short < heights.wordy, JSON.stringify(heights))
    await send('Emulation.clearDeviceMetricsOverride', {})
    await sleep(500)
  }

  /*
    And when the content does exceed the ceiling, one thing scrolls, not two.

    The details column used to own a scroll inside a fixed-height dialog, which kept the
    artwork still. The dialog follows its content now, so the body is the scroller and the
    two columns move together -- what must not happen is two nested scrollers fighting over
    one gesture, which is what a leftover `overflow-y-auto` on the column would produce.
  */
  await openCard('Oko')
  const scrolled = JSON.parse(await ev(`(() => {
    const d = document.querySelector('[role="dialog"]')
    const art = d.querySelector('[data-flip="stage"]') ?? d.querySelector('img')
    const scrollers = [...d.querySelectorAll('div')].filter(
      (e) => e.scrollHeight > e.clientHeight + 4 && e.clientHeight > 200
    )
    if (!scrollers.length) return JSON.stringify({ scrollable: false })
    const body = scrollers[0]
    const before = Math.round(art.getBoundingClientRect().top)
    body.scrollTop = body.scrollHeight
    return JSON.stringify({
      scrollable: true,
      scrollers: scrollers.length,
      moved: body.scrollTop > 0,
      artBefore: before,
      artAfter: Math.round(art.getBoundingClientRect().top)
    })
  })()`))
  console.log('        \u2192 scroll ' + JSON.stringify(scrolled))
  if (scrolled.scrollable) {
    check('the dialog scrolls when its content passes the ceiling',
      scrolled.moved === true, JSON.stringify(scrolled))
    check('and exactly one thing scrolls, so no two scrollers fight over the gesture',
      scrolled.scrollers === 1, JSON.stringify(scrolled))
    check('and the columns move together, the artwork with the words',
      scrolled.artBefore !== scrolled.artAfter, JSON.stringify(scrolled))
  } else {
    console.log('        (nothing here is long enough to need scrolling)')
  }

  /*
    ---- 6. editing a quantity does not throw you back to the top.

    The fetch effect raised `loading` on every invalidation, and editing a quantity here
    invalidates by design -- so the body was replaced by the skeleton, the scrolling
    column was remounted, and the scroll position went with it. The face went too, since
    the same effect reset it: bump a quantity while looking at the back of a card and it
    turned itself over.
  */
  await openCard('Oko')
  await sleep(400)
  await clickFlip()
  await sleep(900)
  const held = JSON.parse(await ev(`(async () => {
    const d = document.querySelector('[role="dialog"]')
    const col = [...d.querySelectorAll('div')].find((el) => el.scrollHeight > el.clientHeight + 20)
    if (!col) return JSON.stringify({ scrollable: false })
    col.scrollTop = 90
    await new Promise((r) => setTimeout(r, 200))
    const before = { top: col.scrollTop, turned: d.querySelector('[data-flip=\"card\"]').dataset.turned }
    const plus = [...d.querySelectorAll('button')].find((b) =>
      /augmenter|increase/i.test(b.getAttribute('aria-label') || ''))
    if (!plus) return JSON.stringify({ scrollable: true, stepper: false, before })
    plus.click()
    // Long enough for the round trip and the refetch it triggers.
    await new Promise((r) => setTimeout(r, 2200))
    const same = [...document.querySelectorAll('[role="dialog"] div')]
      .find((el) => el.scrollHeight > el.clientHeight + 20)
    return JSON.stringify({
      scrollable: true,
      stepper: true,
      before,
      after: {
        top: same ? same.scrollTop : -1,
        turned: document.querySelector('[data-flip=\"card\"]')?.dataset.turned ?? null
      }
    })
  })()`))
  console.log('        \u2192 quantity: ' + JSON.stringify(held))
  if (held.stepper) {
    check('editing a quantity keeps the details column where it was',
      held.after.top === held.before.top,
      JSON.stringify({ before: held.before.top, after: held.after.top }))
    check('and keeps the card on the side you had turned it to',
      held.after.turned === held.before.turned,
      JSON.stringify({ before: held.before.turned, after: held.after.turned }))
  } else {
    check('a copy is held, so the quantity control is there to press',
      false, JSON.stringify(held))
  }

  /*
    ---- 7. the zoomed view opens on the side you were looking at, and turns over too.

    Clicking the artwork of a card you had flipped showed the front, because the zoom was
    handed a scryfall id and nothing else.
  */
  const zoomState = () => ev(`(() => {
    const img = document.querySelector('.fixed.inset-0.flex img[src*="matomeru://image/"]')
    const flip = document.querySelector('[data-action="flipZoom"]')
    return JSON.stringify({
      open: !!img,
      src: img ? img.getAttribute('src') : null,
      canFlip: !!flip
    })
  })()`)
  await ev(`(() => {
    document.querySelector('[role="dialog"] [data-flip="stage"]')?.closest('button')?.click()
    return true
  })()`)
  await sleep(900)
  const zoomBack = JSON.parse(await zoomState())
  console.log('        \u2192 zoom: ' + JSON.stringify(zoomBack))
  check('the zoom opens on the side the dialog was showing',
    zoomBack.open && String(zoomBack.src).includes('face=1'), JSON.stringify(zoomBack))
  check('and offers to turn the card over in there too', zoomBack.canFlip === true,
    JSON.stringify(zoomBack))
  await ev(`(() => { document.querySelector('[data-action="flipZoom"]').click(); return true })()`)
  await sleep(700)
  const zoomFront = JSON.parse(await zoomState())
  console.log('        \u2192 zoom flipped: ' + JSON.stringify(zoomFront))
  check('turning it over in the zoom shows the other side',
    zoomFront.open && !String(zoomFront.src).includes('face='), JSON.stringify(zoomFront))
  // Escape closes the zoom without closing the dialog under it.
  await ev(`(() => {
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    return true
  })()`)
  await sleep(400)

  // Leave nothing open: the next probe's hit tests would answer through it.
  await closeDialog()

  console.log('\n' + passed + ' passed, ' + failed + ' failed')
  ws.close()
  process.exit(failed === 0 ? 0 : 1)
})().catch((e) => {
  console.log('  probe failed: ' + e.message)
  process.exit(1)
})
