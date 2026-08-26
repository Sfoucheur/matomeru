/**
 * Selecting cards in the collection's list, and the two controls that act on a selection.
 *
 *   npm run build
 *   npx electron . --user-data-dir=/tmp/probe --remote-debugging-port=9600
 *   node scripts/probe-select.cjs 9600
 *
 * Give it a scratch profile with a few cards in it: it selects and edits.
 *
 * Ctrl-click and Shift-click were the report. They worked in the gallery and did nothing
 * in the list, because the dispatcher that reads the modifiers was never handed to the
 * table -- so this drives the real rows through synthetic MouseEvents carrying the
 * modifier flags, which is the only way to check a gesture.
 */
const PORT = process.argv[2] ?? '9600'
let passed = 0
let failed = 0
const check = (label, ok, detail) => {
  if (ok) {
    passed += 1
    console.log('  PASS  ' + label)
  } else {
    failed += 1
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
          return rej(new Error(JSON.stringify(d.result.exceptionDetails).slice(0, 260)))
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

  // ---- the collection, in list mode
  await ev(`(async () => {
    document.querySelector('[data-action="updateLater"]')?.click()
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    await new Promise((r) => setTimeout(r, 300))
    const nav = document.querySelector('nav') ?? document.querySelector('aside')
    ;[...nav.querySelectorAll('button')][0].click()
    await new Promise((r) => setTimeout(r, 900))
    document.querySelector('[data-view="table"]')?.click()
    await new Promise((r) => setTimeout(r, 900))
    return true
  })()`)

  /*
    How many rows are selected, read off the bulk bar rather than from React. The bar
    only exists while something is selected, which is itself part of what is checked.
  */
  const selectedCount = () => ev(`(() => {
    const bar = [...document.querySelectorAll('div')].find((d) =>
      /\\d+\\s*(selected|sélectionnée)/i.test(d.innerText || '') && d.querySelector('button'))
    if (!bar) return '0'
    const m = (bar.innerText || '').match(/(\\d+)\\s*(?:selected|sélectionnée)/i)
    return m ? m[1] : '0'
  })()`)

  const clickRow = (index, mods) => ev(`(() => {
    const rows = [...document.querySelectorAll('[data-collection-row]')]
    if (rows.length <= ${index}) return 'only ' + rows.length + ' rows'
    rows[${index}].dispatchEvent(new MouseEvent('click', Object.assign(
      { bubbles: true }, ${JSON.stringify(mods)})))
    return 'ok'
  })()`)

  const rowCount = Number(await ev(
    `document.querySelectorAll('[data-collection-row]').length`
  ))
  console.log('        → ' + rowCount + ' rows drawn')
  check('the list rows carry a handle at all', rowCount > 0, String(rowCount))
  if (rowCount < 3) {
    console.log('  (need three rows to check a range; add some cards to this profile)')
    console.log('\n' + passed + ' passed, ' + failed + ' failed')
    process.exit(failed === 0 ? 0 : 1)
  }

  // ---- 1. a plain click selects exactly one
  await clickRow(0, {})
  await sleep(500)
  check('a plain click on a row selects it', (await selectedCount()) === '1',
    'selected ' + (await selectedCount()))

  // ---- 2. ctrl adds
  await clickRow(1, { ctrlKey: true })
  await sleep(400)
  check('ctrl+click adds a second row', (await selectedCount()) === '2',
    'selected ' + (await selectedCount()))

  // ---- 3. ctrl removes again
  await clickRow(1, { ctrlKey: true })
  await sleep(400)
  check('and ctrl+click on it again takes it back off', (await selectedCount()) === '1',
    'selected ' + (await selectedCount()))

  // ---- 4. shift takes a range from the last one clicked
  await clickRow(2, { shiftKey: true })
  await sleep(400)
  const ranged = Number(await selectedCount())
  check('shift+click takes the range from the last row clicked', ranged === 3,
    'selected ' + ranged)

  // ---- 5. a plain click collapses it again
  await clickRow(1, {})
  await sleep(400)
  check('and a plain click puts it back to one', (await selectedCount()) === '1',
    'selected ' + (await selectedCount()))

  // ---- 6. the language control is offered for the selection
  const controls = JSON.parse(await ev(`(() => JSON.stringify({
    language: !!document.querySelector('[data-action="setLanguage"]'),
    selectAll: !!document.querySelector('[data-action="selectAllMatching"]')
  }))()`))
  console.log('        → controls ' + JSON.stringify(controls))
  check('a selection is offered a language to set', controls.language === true,
    JSON.stringify(controls))

  // ---- 7. select-all reaches every matching row, not only the drawn ones
  check('and select-all is offered whatever the size of the collection',
    controls.selectAll === true, JSON.stringify(controls))
  const total = Number(await ev(`(() => {
    const b = document.querySelector('[data-action="selectAllMatching"]')
    const m = (b?.innerText || '').match(/(\\d+)/)
    return m ? m[1] : '0'
  })()`))
  await ev(`(() => { document.querySelector('[data-action="selectAllMatching"]').click(); return true })()`)
  await sleep(1200)
  const all = Number(await selectedCount())
  console.log('        → select-all took ' + all + ' of ' + total)
  check('select-all selects every row it said it would', all === total && all > 0,
    JSON.stringify({ took: all, said: total }))

  /*
    ---- 8. "where the copies are" is reachable without opening More.

    Found by its handle, not by its label: the app runs in whatever language you set, and
    a check that greps for English text reports a French window as broken.
  */
  const filterPlace = JSON.parse(await ev(`(() => {
    const el = document.querySelector('[data-filter="source"]')
    if (!el) return JSON.stringify({ present: false })
    // The advanced panel is the collapsible one; anything inside it is behind a click.
    const collapsible = [...document.querySelectorAll('div')].find(
      (d) => d.className && String(d.className).includes('overflow-hidden') &&
        d.querySelector('[data-filter="source"]')
    )
    const r = el.getBoundingClientRect()
    return JSON.stringify({
      present: true,
      insideMore: !!collapsible,
      visible: r.width > 0 && r.height > 0
    })
  })()`))
  console.log('        → filter ' + JSON.stringify(filterPlace))
  check('"where the copies are" is in the filter bar, not behind More',
    filterPlace.present === true && filterPlace.insideMore === false &&
      filterPlace.visible === true,
    JSON.stringify(filterPlace))

  /*
    ---- 8b. a selection outlives the filter.

    The reported case, in order: select everything on screen, narrow to one card, take that
    one out, widen again. What is left must be everything except the one that was removed.
    Every filter change used to empty the selection, so the first keystroke threw it away.

    The search box is the filter here because it is the one the report describes, and
    because it is the only filter that can be driven without knowing what is in the
    profile: it is typed with the card's own name, read off a row.
  */
  const across = JSON.parse(await ev(`(async () => {
    const rows = () => [...document.querySelectorAll('[data-collection-row]')]
    const box = () => document.querySelector('[data-search]')
    const bar = () => [...document.querySelectorAll('div')].find((d) =>
      /\\d+\\s*(?:selected|sélectionnée)/i.test(d.innerText || '') && d.querySelector('button'))
    const count = () => {
      const m = (bar()?.innerText || '').match(/(\\d+)\\s*(?:selected|sélectionnée)/i)
      return m ? Number(m[1]) : 0
    }
    const type = (value) => {
      const el = box()
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype, 'value').set
      setter.call(el, value)
      el.dispatchEvent(new Event('input', { bubbles: true }))
    }
    if (!box()) return JSON.stringify({ search: false })

    // Start clean, then take everything on screen.
    document.querySelector('[data-action="clearSelection"]')?.click()
    // Waited for: checked is React state, and reading it in the same tick as the clear
    // reported the old value, so the tick below was skipped and nothing got selected.
    await new Promise((r) => setTimeout(r, 400))
    const header = document.querySelector('[data-action="toggleAllShown"]')
    if (!header) return JSON.stringify({ header: false })
    if (!header.checked) header.click()
    await new Promise((r) => setTimeout(r, 500))
    const selectedAll = count()

    // The name of a card that is selected, read off the first row.
    const first = rows()[0]
    const name = (first.getAttribute('data-name') || '').trim()
    if (!name) return JSON.stringify({ name: false })

    type(name)
    // Past the search debounce and the refetch.
    await new Promise((r) => setTimeout(r, 1200))
    const afterFilter = count()
    const rowsShown = rows().length
    const barStillThere = bar() !== null

    // Take that one out of the selection: ctrl+click is "toggle".
    const target = rows().find((r) => r.getAttribute('data-name') === name)
    if (target) {
      target.dispatchEvent(new MouseEvent('click', { bubbles: true, ctrlKey: true }))
    }
    await new Promise((r) => setTimeout(r, 400))
    const afterDeselect = count()

    // And widen again.
    type('')
    await new Promise((r) => setTimeout(r, 1200))
    const afterClearing = count()

    /*
      Then the opposite corner: a filter that matches nothing at all. The bar used to be
      drawn only when a selected row was on screen, so this emptied the screen of the one
      control that could clear the selection.
    */
    type('zzzzz-no-such-card-zzzzz')
    await new Promise((r) => setTimeout(r, 1200))
    const withNothingShown = { rows: rows().length, count: count(), bar: bar() !== null }
    type('')
    await new Promise((r) => setTimeout(r, 1200))

    return JSON.stringify({
      selectedAll, afterFilter, rowsShown, barStillThere,
      afterDeselect, afterClearing, withNothingShown, name
    })
  })()`))
  console.log('        → across ' + JSON.stringify(across))
  if (across.selectedAll > 1) {
    check('narrowing the filter leaves the selection alone',
      across.afterFilter === across.selectedAll, JSON.stringify(across))
    check('and the bar is still there while the filter hides most of it',
      across.barStillThere === true, JSON.stringify(across))
    check('taking one row out takes exactly one out',
      across.afterDeselect === across.selectedAll - 1, JSON.stringify(across))
    check('and widening again keeps everything except that one',
      across.afterClearing === across.selectedAll - 1, JSON.stringify(across))
    check('a filter that matches nothing still leaves a selection to clear',
      across.withNothingShown.rows === 0 &&
        across.withNothingShown.count === across.selectedAll - 1 &&
        across.withNothingShown.bar === true,
      JSON.stringify(across.withNothingShown))
  } else {
    console.log('        (not enough rows selected to tell anything; skipped)')
  }

  /*
    ---- 8c. the header box speaks about the rows it can see.

    Ticking it adds this page to whatever was already selected; unticking takes only this
    page back out. It used to compare the whole selection against the row count on screen,
    which was the same number only while a selection could not outlive a filter.
  */
  const headerBox = JSON.parse(await ev(`(async () => {
    const header = () => document.querySelector('[data-action="toggleAllShown"]')
    const rows = () => [...document.querySelectorAll('[data-collection-row]')]
    const bar = () => [...document.querySelectorAll('div')].find((d) =>
      /\\d+\\s*(?:selected|sélectionnée)/i.test(d.innerText || '') && d.querySelector('button'))
    const count = () => {
      const m = (bar()?.innerText || '').match(/(\\d+)\\s*(?:selected|sélectionnée)/i)
      return m ? Number(m[1]) : 0
    }
    document.querySelector('[data-action="clearSelection"]')?.click()
    await new Promise((r) => setTimeout(r, 400))

    // One row by hand, then the header: the box should read part-way, then all.
    rows()[0].dispatchEvent(new MouseEvent('click', { bubbles: true, ctrlKey: true }))
    await new Promise((r) => setTimeout(r, 300))
    const partial = { count: count(), indeterminate: header().indeterminate, checked: header().checked }

    header().click()
    await new Promise((r) => setTimeout(r, 400))
    const all = { count: count(), indeterminate: header().indeterminate, checked: header().checked }

    header().click()
    await new Promise((r) => setTimeout(r, 400))
    /*
      Measured on the rows, not on the total.

      Unticking promises to release the rows in this list and to leave the rest alone, so
      the total is the wrong thing to assert: a straggler from an earlier filter is exactly
      what it is supposed to keep. What must be true is that nothing drawn stays ticked.
    */
    const stillTicked = rows().filter((r) => r.querySelector('input')?.checked).length
    const none = { count: count(), checked: header().checked, stillTicked }
    /*
      Read from the footer, not from the number of row elements.

      The list is virtualized: about twenty-five rows exist in the DOM out of the two
      hundred the page holds, and the header box is about the list rather than about what
      happens to be painted. Comparing against the DOM count made this fail while the code
      was right.
    */
    const listed = Number((document.body.innerText.match(/(\d+)\s*(?:rows|lignes)/) || [])[1] || 0)
    return JSON.stringify({ painted: rows().length, listed, partial, all, none })
  })()`))
  console.log('        → header ' + JSON.stringify(headerBox))
  check('one row selected reads as part-way, not as all',
    headerBox.partial.indeterminate === true && headerBox.partial.checked === false,
    JSON.stringify(headerBox))
  check('and ticking the header takes every row in the list, not just the painted ones',
    headerBox.all.checked === true && headerBox.all.count > headerBox.painted,
    JSON.stringify(headerBox))
  check('and unticking it releases every row in the list',
    headerBox.none.stillTicked === 0 && headerBox.none.checked === false,
    JSON.stringify(headerBox))

  /*
    ---- 9. the card under the pointer, drawn big enough to read.

    In list mode the thumbnail is 28px wide, so the artwork is the one thing the list
    cannot show. Hovering it opens a panel beside the row.

    Everything here is measured rather than eyeballed, and the pointer-events assertion is
    the one that matters most: a panel that could take the pointer would take it from the
    thumbnail underneath, whose mouseleave would close the panel, which would hand the
    pointer back -- a flicker loop that looks like a rendering bug and is really a
    hit-testing one.
  */
  const hover = JSON.parse(await ev(`(async () => {
    const thumbs = [...document.querySelectorAll('[data-collection-row] [data-thumb]')]
    if (thumbs.length < 2) return JSON.stringify({ thumbs: thumbs.length })
    const panel = () => document.querySelector('[data-hover-preview]')
    const srcOf = (el) => el?.querySelector('img')?.getAttribute('src') || ''
    // Split rather than match: a backslash inside this template literal is one
    // interpretation away from ending it, and an id needs no regex to read.
    const idOf = (el) => (srcOf(el).split('image/')[1] || '').split('?')[0]

    const a = thumbs[0]
    const b = thumbs[1]
    const idA = idOf(a)

    a.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }))
    // Before the delay is up there must be nothing: that delay is what stops a pointer
    // crossing a long list from asking the cache for a hundred images.
    await new Promise((r) => setTimeout(r, 60))
    const tooEarly = panel() !== null
    await new Promise((r) => setTimeout(r, 420))

    /*
      Everything about the panel, read now.

      A first version of this read the style and the src at the end of the run, by which
      time the panel had been closed on purpose two steps earlier -- so it reported an
      empty pointer-events and no image and looked like four product bugs. A computed
      style is live: once the element is gone it answers with empty strings.
    */
    const shown = panel()
    const box = shown ? shown.getBoundingClientRect() : null
    const cs = shown ? getComputedStyle(shown) : null
    const thumbBox = a.getBoundingClientRect()
    const up = shown === null ? null : {
      shows: idA !== '' && srcOf(shown).includes(idA),
      size: (srcOf(shown).split('size=')[1] || '').split('&')[0] || null,
      wideEnough: box.width > 200,
      pointerEvents: cs.pointerEvents,
      zIndex: cs.zIndex,
      portalled: shown.parentElement === document.body,
      overlapsThumb: box.left < thumbBox.right && box.right > thumbBox.left &&
        box.top < thumbBox.bottom && box.bottom > thumbBox.top,
      onScreen: box.top >= 0 && box.bottom <= window.innerHeight + 1 &&
        box.left >= 0 && box.right <= window.innerWidth + 1,
      hidden: shown.getAttribute('aria-hidden') === 'true'
    }

    // Crossing from one row's thumbnail to the next must not blank it, the same way the
    // printing list must not: sample between the leave and the arrival.
    a.dispatchEvent(new MouseEvent('mouseout', { bubbles: true, relatedTarget: document.body }))
    await new Promise((r) => setTimeout(r, 70))
    const duringGap = panel() !== null
    b.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }))
    await new Promise((r) => setTimeout(r, 90))
    const switchedToB = panel() !== null && srcOf(panel()).includes(idOf(b))

    // Leaving for good closes it, past the grace.
    b.dispatchEvent(new MouseEvent('mouseout', { bubbles: true, relatedTarget: document.body }))
    await new Promise((r) => setTimeout(r, 320))
    const closed = panel() === null

    /*
      And a scroll closes it, because the row it was measured against may be recycled.

      The scroller is found by what it does, not by a class: the one ancestor of a row
      that actually has somewhere to scroll. Reported, so a run where nothing scrolled
      cannot pass this by accident.
    */
    a.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }))
    await new Promise((r) => setTimeout(r, 420))
    const beforeScroll = panel() !== null
    let scroller = a.parentElement
    while (scroller && scroller.scrollHeight <= scroller.clientHeight + 8) {
      scroller = scroller.parentElement
    }
    const startedAt = scroller ? scroller.scrollTop : null
    if (scroller) scroller.scrollTop = startedAt + 200
    await new Promise((r) => setTimeout(r, 200))
    const reallyScrolled = scroller !== null && scroller.scrollTop !== startedAt
    const closedByScroll = panel() === null

    document.body.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }))
    await new Promise((r) => setTimeout(r, 320))

    return JSON.stringify({
      thumbs: thumbs.length, tooEarly, appeared: up !== null, ...(up ?? {}),
      duringGap, switchedToB, closed, beforeScroll, reallyScrolled, closedByScroll
    })
  })()`))
  console.log('        → hover ' + JSON.stringify(hover))
  if (hover.thumbs >= 2) {
    check('hovering a row thumbnail previews the card', hover.appeared === true,
      JSON.stringify(hover))
    check('and not before the delay is up', hover.tooEarly === false, JSON.stringify(hover))
    check('and it is that row card, drawn big enough to read',
      hover.shows === true && hover.wideEnough === true, JSON.stringify(hover))
    check('and it is hidden from a screen reader, which has the row itself',
      hover.hidden === true, JSON.stringify(hover))
    check('the panel takes no pointer events, so it cannot steal its own trigger',
      hover.pointerEvents === 'none', String(hover.pointerEvents))
    check('and sits on the popover layer, portalled out of the virtualized row',
      hover.zIndex === '45' && hover.portalled === true,
      JSON.stringify({ z: hover.zIndex, portalled: hover.portalled }))
    check('it does not cover the thumbnail it belongs to', hover.overlapsThumb === false,
      JSON.stringify(hover))
    check('and stays inside the window', hover.onScreen === true, JSON.stringify(hover))
    check('crossing to the next row keeps a card on screen', hover.duringGap === true,
      JSON.stringify(hover))
    check('and shows the row arrived at', hover.switchedToB === true, JSON.stringify(hover))
    check('leaving the list closes it', hover.closed === true, JSON.stringify(hover))
    check('scrolling closes it, rather than leaving it anchored to a recycled row',
      hover.beforeScroll === true && hover.reallyScrolled === true &&
        hover.closedByScroll === true, JSON.stringify(hover))
  } else {
    console.log('        (fewer than two rows loaded, so no hover to measure)')
  }

  /*
    ---- 10. and the same on the deck screen's list.

    Reachable by handle now: that toggle had no attribute at all, so the only way in was
    its translated label.
  */
  const deckHover = JSON.parse(await ev(`(async () => {
    const nav = document.querySelector('nav') ?? document.querySelector('aside')
    const buttons = [...nav.querySelectorAll('button')]
    // The Decks entry, by position: the labels are exactly what changes with the language.
    buttons[3].click()
    await new Promise((r) => setTimeout(r, 1400))
    const deck = [...document.querySelectorAll('button')].find((b) =>
      b.closest('aside, nav') === null &&
      (b.innerText || '').trim().length > 3)
    if (deck) deck.click()
    await new Promise((r) => setTimeout(r, 1600))
    const rows = document.querySelector('[data-view="rows"]')
    if (!rows) return JSON.stringify({ toggle: false })
    rows.click()
    await new Promise((r) => setTimeout(r, 900))
    const thumb = document.querySelector('[data-deck-card] [data-thumb]')
    if (!thumb) return JSON.stringify({ toggle: true, thumb: false })
    thumb.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }))
    await new Promise((r) => setTimeout(r, 420))
    const panel = document.querySelector('[data-hover-preview]')
    const out = {
      toggle: true,
      thumb: true,
      appeared: panel !== null,
      pointerEvents: panel ? getComputedStyle(panel).pointerEvents : null
    }
    thumb.dispatchEvent(new MouseEvent('mouseout', { bubbles: true, relatedTarget: document.body }))
    await new Promise((r) => setTimeout(r, 320))
    out.closed = document.querySelector('[data-hover-preview]') === null

    /*
      And the same thumbnail opens the closer look, as the collection's does.

      Also that it does not select the row on the way: the click is stopped at the
      thumbnail, so asking to see the art is not also a selection gesture.
    */
    // Counted by what the class list contains rather than by a selector: the selected
    // border is border-gold-500/60, and a slash in a CSS selector needs escaping through
    // three layers of quoting to get here intact. (No backticks in this comment -- it
    // lives inside a template literal, and one would end it.)
    const selectedRows = () => [...document.querySelectorAll('[data-deck-card]')]
      .filter((el) => String(el.className).includes('border-gold-500')).length
    const selectedBefore = selectedRows()
    out.zoomBefore = document.querySelector('[data-zoom]') !== null
    thumb.click()
    await new Promise((r) => setTimeout(r, 600))
    out.zoomOpened = document.querySelector('[data-zoom]') !== null
    out.selectionUnchanged = selectedRows() === selectedBefore
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    await new Promise((r) => setTimeout(r, 400))
    out.zoomClosed = document.querySelector('[data-zoom]') === null
    return JSON.stringify(out)
  })()`))
  console.log('        → deck hover ' + JSON.stringify(deckHover))
  check('the deck list mode is reachable by handle', deckHover.toggle === true,
    JSON.stringify(deckHover))
  if (deckHover.thumb) {
    check('a deck row thumbnail previews the card too', deckHover.appeared === true,
      JSON.stringify(deckHover))
    check('with the same panel that takes no pointer events',
      deckHover.pointerEvents === 'none', JSON.stringify(deckHover))
    check('and closes when the pointer leaves', deckHover.closed === true,
      JSON.stringify(deckHover))
    check('clicking a deck thumbnail opens the closer look, as the collection does',
      deckHover.zoomBefore === false && deckHover.zoomOpened === true,
      JSON.stringify(deckHover))
    check('and it closes again, without having changed the selection',
      deckHover.zoomClosed === true && deckHover.selectionUnchanged === true,
      JSON.stringify(deckHover))
  } else {
    console.log('        (no deck row on screen, so nothing to hover)')
  }

  /*
    ---- 11. the deck screen, same rule, and an action that reaches what is hidden.

    The deck used to prune its selection to the filtered cards continuously, and every
    action derived its targets by walking that same filtered list -- so a card the filter
    hid was not refused, it was silently skipped. That is the half of this that no count on
    screen can show, so it is checked by doing something and reading the result back:
    select two cards, hide one, mark proxies, and both must come back marked.

    Proxy rather than a language or a pull: one click, no dialog, and "Proxy" is the same
    word in both languages, so reading it back does not depend on the locale.
  */
  const deckSel = JSON.parse(await ev(`(async () => {
    const rows = () => [...document.querySelectorAll('[data-deck-card]')]
    const bar = () => [...document.querySelectorAll('div')].find((d) =>
      /\\d+\\s*(?:selected|sélectionnée)/i.test(d.innerText || '') && d.querySelector('button'))
    const count = () => {
      const m = (bar()?.innerText || '').match(/(\\d+)\\s*(?:selected|sélectionnée)/i)
      return m ? Number(m[1]) : 0
    }
    const search = () => [...document.querySelectorAll('[data-search]')]
      .find((el) => el.offsetParent !== null)
    const type = (el, value) => {
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype, 'value').set
      setter.call(el, value)
      el.dispatchEvent(new Event('input', { bubbles: true }))
    }

    /*
      Open the biggest deck, rather than trusting whatever an earlier section left open.

      Each sidebar entry carries a per-deck sync button, which is the only stable handle in
      that list; the deck's own button is its sibling, and its second paragraph is the card
      count. Picking the largest deck is what makes "select two, hide one" possible at all.
    */
    const entries = [...document.querySelectorAll('[data-sync-deck]')].map((sync) => {
      const button = sync.parentElement?.querySelector('button')
      const count = parseInt(button?.querySelectorAll('p')[1]?.textContent ?? '0', 10)
      return { button, id: Number(sync.getAttribute('data-sync-deck')),
               count: Number.isFinite(count) ? count : 0 }
    })
    const biggest = entries.sort((a, b) => b.count - a.count)[0]
    if (biggest?.button) {
      biggest.button.click()
      await new Promise((r) => setTimeout(r, 1600))
      document.querySelector('[data-view="rows"]')?.click()
      await new Promise((r) => setTimeout(r, 900))
    }
    if (search()) {
      type(search(), '')
      await new Promise((r) => setTimeout(r, 700))
    }
    if (rows().length < 3 || !search()) {
      return JSON.stringify({ rows: rows().length, opened: biggest?.count ?? null })
    }
    document.querySelector('[data-action="clearSelection"]')?.click()
    await new Promise((r) => setTimeout(r, 400))

    // Two cards that are not already proxies, so the mark is a real change.
    const plain = rows().filter((r) => !(r.innerText || '').includes('Proxy'))
    if (plain.length < 2) return JSON.stringify({ plain: plain.length })
    /*
      The name button, by position: the checkbox, then the thumbnail, then the name. Read
      as textContent rather than by splitting innerText on a line break -- this whole
      block is a template literal, and a backslash-n in it becomes a real newline that
      ends the string it sits in.
    */
    const nameOf = (r) => (r.querySelectorAll('button')[2]?.textContent || '').trim()
    const ids = [plain[0], plain[1]].map((r) => r.getAttribute('data-deck-card'))
    const names = [plain[0], plain[1]].map(nameOf)
    for (const row of [plain[0], plain[1]]) {
      row.dispatchEvent(new MouseEvent('click', { bubbles: true, ctrlKey: true }))
      await new Promise((r) => setTimeout(r, 250))
    }
    const selectedBoth = count()
    /*
      Their state before, from the breakdown.

      The proxy control is a toggle, so which way it goes depends on what is already
      marked -- and "Proxy" in a row's text is not a reliable read of that. What the check
      is really about is whether the write reached the card the filter hid, so it records
      both flags and asserts they both changed, in whichever direction the toggle went.
    */
    const before = await window.api.decks.breakdown(biggest.id)
    const flagOf = (bd, id) => (bd?.groups ?? [])
      .flatMap((g) => g.cards)
      .filter((c) => String(c.id) === String(id))
      .map((c) => !!c.proxied)[0]
    const wasProxied = ids.map((id) => flagOf(before, id))

    // Hide one of the two by searching for the other.
    type(search(), names[0])
    await new Promise((r) => setTimeout(r, 700))
    const afterFilter = count()
    const shownNow = rows().length

    // One click, on a selection whose second card is not on screen.
    const proxyButton = [...(bar()?.querySelectorAll('button') ?? [])].find((b) =>
      /Proxy|proxy/.test(b.innerText || ''))
    if (!proxyButton) return JSON.stringify({ selectedBoth, afterFilter, proxyButton: false })
    proxyButton.click()
    await new Promise((r) => setTimeout(r, 1600))

    // Widen again and read both rows back.
    type(search(), '')
    await new Promise((r) => setTimeout(r, 900))
    /*
      Read back from the data, not from a badge.

      What matters is whether the write reached the card the filter was hiding, and the
      deck breakdown answers that directly -- a badge answers "is it drawn and marked",
      which is two questions at once and the wrong two.
    */
    const after = await window.api.decks.breakdown(biggest.id)
    const all = (after?.groups ?? []).flatMap((g) => g.cards)
    const nowProxied = ids.map((id) => flagOf(after, id))
    const changed = ids.filter((id, i) => nowProxied[i] !== wasProxied[i]).length
    const toast = ([...document.querySelectorAll('div')]
      .map((d) => (d.innerText || '').trim())
      .find((txt) => txt.length > 0 && txt.length < 90 && /proxy|Proxy/.test(txt))) ?? null

    return JSON.stringify({
      selectedBoth, afterFilter, shownNow, names, wasProxied, nowProxied, changed, toast,
      stillSelected: count(), deckCards: all.length
    })
  })()`))
  console.log('        → deck selection ' + JSON.stringify(deckSel))
  if (deckSel.selectedBoth === 2) {
    check('a deck selection survives its filter too',
      deckSel.afterFilter === 2 && deckSel.shownNow < 2, JSON.stringify(deckSel))
    check('and an action reaches the card the filter was hiding',
      deckSel.changed === 2, JSON.stringify(deckSel))
  } else {
    console.log('        (could not select two plain cards here; skipped)')
  }

  console.log('\n' + passed + ' passed, ' + failed + ' failed')
  process.exit(failed === 0 ? 0 : 1)
})().catch((err) => {
  console.log('  probe failed: ' + err.message)
  process.exit(1)
})
