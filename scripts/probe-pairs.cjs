/**
 * One physical card with a different token on each side, in the running app.
 *
 *   npm run build
 *   npx electron . --user-data-dir=/tmp/probe --remote-debugging-port=9350
 *   npm run probe:pairs               (or: node scripts/probe-pairs.cjs 9350)
 *
 * Give it a scratch profile rather than your own: it adds cards.
 *
 * A Commander 2017 token card is a Cat Warrior on the front and a Rat on the back, and
 * Scryfall files those as two unrelated single-faced tokens -- its `all_parts` links each
 * one to the spells that create it, never to the other side of the card. So adding both
 * the ordinary way claims two cards when one is in the binder, and nothing in the data
 * can say otherwise.
 *
 * Both routes into a pairing are driven here, because they are reached by different
 * people: the line for a pile being sorted now, the Combine action for rows already in
 * the database.
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

  // Add cards -> Fast entry
  await ev(`(async () => {
    document.querySelector('[data-action="updateLater"]')?.click()
    const nav = document.querySelector('nav') ?? document.querySelector('aside')
    ;[...nav.querySelectorAll('button')][1].click()
    await new Promise((r) => setTimeout(r, 700))
    const tabs = [...document.querySelectorAll('button')]
      .filter((b) => /rapide|Fast/i.test(b.innerText))
    tabs[0]?.click()
    await new Promise((r) => setTimeout(r, 500))
    return true
  })()`)

  const typeLine = (line) => ev(`(async () => {
    const input = document.querySelector('input[placeholder*="m10"]')
    if (!input) throw new Error('fast entry input not found')
    const setter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype, 'value').set
    setter.call(input, ${JSON.stringify(line)})
    input.dispatchEvent(new Event('input', { bubbles: true }))
    await new Promise((r) => setTimeout(r, 120))
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    return true
  })()`)

  const logLines = () => ev(`(() => {
    const rows = [...document.querySelectorAll('li, div')]
      .map((e) => e.innerText || '')
      .filter((t) => /^\\s*\\d+×/.test(t))
      .map((t) => t.split('\\n')[0].trim())
    return JSON.stringify([...new Set(rows)])
  })()`)

  // ---- 1. one line, both sides
  await typeLine('c17 008/011 // 003')
  await sleep(8000)
  const lines = JSON.parse(await logLines())
  console.log('        → ' + JSON.stringify(lines))
  check('one line adds one card that names both sides',
    lines.some((l) => /Cat Warrior/i.test(l) && /Rat/i.test(l)), JSON.stringify(lines))
  check('and names both numbers on the sheet it used',
    lines.some((l) => /TC17/i.test(l) && /#8/.test(l) && /#3/.test(l)), JSON.stringify(lines))

  // ---- 2. the collection shows one row, under both names
  const inCollection = async (search) =>
    JSON.parse(await ev(`(async () => {
      const nav = document.querySelector('nav') ?? document.querySelector('aside')
      ;[...nav.querySelectorAll('button')][0].click()
      await new Promise((r) => setTimeout(r, 900))
      const box = document.querySelector('input[placeholder*="Rechercher"], input[placeholder*="Search"]')
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype, 'value').set
      setter.call(box, ${JSON.stringify('SEARCH')}.replace('SEARCH', ${JSON.stringify(search)}))
      box.dispatchEvent(new Event('input', { bubbles: true }))
      await new Promise((r) => setTimeout(r, 2200))
      const names = [...document.querySelectorAll('button')]
        .map((b) => (b.innerText || '').trim())
        .filter((t) => /Cat Warrior|Rat/i.test(t))
      return JSON.stringify({ names: [...new Set(names)] })
    })()`))

  const front = await inCollection('Cat Warrior')
  console.log('        → searching "Cat Warrior": ' + JSON.stringify(front))
  check('the collection shows one row carrying both names',
    front.names.some((n) => /Cat Warrior \/\/ Rat|Rat \/\/ Cat Warrior/i.test(n)),
    JSON.stringify(front))
  check('and it is one row, not two',
    front.names.length === 1, JSON.stringify(front))

  const back = await inCollection('Rat')
  console.log('        → searching "Rat":         ' + JSON.stringify(back))
  check('searching the back of the card finds that same row',
    back.names.some((n) => /Cat Warrior/i.test(n)), JSON.stringify(back))

  // ---- 3. a second copy joins the row rather than opening another
  await ev(`(async () => {
    const nav = document.querySelector('nav') ?? document.querySelector('aside')
    ;[...nav.querySelectorAll('button')][1].click()
    await new Promise((r) => setTimeout(r, 700))
    return true
  })()`)
  await typeLine('c17 003/011')
  await sleep(7000)
  const after = JSON.parse(await ev(`(async () => {
    const nav = document.querySelector('nav') ?? document.querySelector('aside')
    ;[...nav.querySelectorAll('button')][0].click()
    await new Promise((r) => setTimeout(r, 1400))
    const rows = [...document.querySelectorAll('button')]
      .map((b) => (b.innerText || '').trim())
      .filter((t) => /Cat Warrior|Rat/i.test(t))
    const body = document.body.innerText
    return JSON.stringify({ rows: [...new Set(rows)], twoCopies: /\\b2\\b/.test(body) })
  })()`))
  console.log('        → after a second copy: ' + JSON.stringify(after))
  check('typing the other side later joins the same row, rather than opening a second',
    after.rows.length === 1, JSON.stringify(after))

  // ---------------------------------------------------------------------------
  {
    // The other route: two rows that were added separately, marked as one card.
    // ---------------------------------------------------------------------------
    const typeLine = (line) => ev(`(async () => {
      const nav = document.querySelector('nav') ?? document.querySelector('aside')
      ;[...nav.querySelectorAll('button')][1].click()
      await new Promise((r) => setTimeout(r, 600))
      const tabs = [...document.querySelectorAll('button')]
        .filter((b) => /rapide|Fast/i.test(b.innerText))
      tabs[0]?.click()
      await new Promise((r) => setTimeout(r, 400))
      const input = document.querySelector('input[placeholder*="m10"]')
      if (!input) throw new Error('fast entry input not found')
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype, 'value').set
      setter.call(input, ${JSON.stringify('LINE')}.replace('LINE', ${JSON.stringify(line)}))
      input.dispatchEvent(new Event('input', { bubbles: true }))
      await new Promise((r) => setTimeout(r, 120))
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
      return true
    })()`)

    // Two separate tokens, added the ordinary way — which is what a user has already done.
    await typeLine('tc17 1')
    await sleep(6000)
    await typeLine('tc17 2')
    await sleep(6000)

    const search = (term) => ev(`(async () => {
      const nav = document.querySelector('nav') ?? document.querySelector('aside')
      ;[...nav.querySelectorAll('button')][0].click()
      await new Promise((r) => setTimeout(r, 900))
      const box = document.querySelector('input[placeholder*="Rechercher"], input[placeholder*="Search"]')
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype, 'value').set
      setter.call(box, ${JSON.stringify('TERM')}.replace('TERM', ${JSON.stringify(term)}))
      box.dispatchEvent(new Event('input', { bubbles: true }))
      await new Promise((r) => setTimeout(r, 2200))
      return true
    })()`)

    const state = () => ev(`(() => {
      const boxes = [...document.querySelectorAll('input[type="checkbox"][aria-label]')]
      const names = [...document.querySelectorAll('button')]
        .map((b) => (b.innerText || '').trim())
        .filter((t) => /^(Cat|Bat|Cat \\/\\/ Bat|Bat \\/\\/ Cat)$/i.test(t))
      return JSON.stringify({
        rows: boxes.length,
        names: [...new Set(names)],
        sameCardOffered: document.querySelector('[data-action="sameCard"]') !== null,
        separateOffered: document.querySelector('[data-action="separateSides"]') !== null
      })
    })()`)

    // TC17 #1 is a Cat and #2 is a Bat; searching the set shows both.
    await search('tc17')
    const before = JSON.parse(await state())
    console.log('        → ' + JSON.stringify(before))
    check('two tokens added the ordinary way are two rows',
      before.names.length >= 2, JSON.stringify(before))
    check('and no combine is offered with nothing selected',
      before.sameCardOffered === false, JSON.stringify(before))

    // select exactly two
    const selected = JSON.parse(await ev(`(async () => {
      const boxes = [...document.querySelectorAll('input[type="checkbox"][aria-label]')]
        .filter((b) => /Cat|Bat/i.test(b.getAttribute('aria-label') || ''))
      for (const box of boxes.slice(0, 2)) {
        box.click()
        await new Promise((r) => setTimeout(r, 200))
      }
      await new Promise((r) => setTimeout(r, 600))
      return JSON.stringify({
        offered: document.querySelector('[data-action="sameCard"]') !== null,
        label: document.querySelector('[data-action="sameCard"]')?.innerText.trim() ?? null
      })
    })()`))
    console.log('        → ' + JSON.stringify(selected))
    check('selecting exactly two rows offers to mark them as one card',
      selected.offered === true, JSON.stringify(selected))

    await ev(`document.querySelector('[data-action="sameCard"]').click()`)
    await sleep(2500)
    const after = JSON.parse(await state())
    console.log('        → ' + JSON.stringify(after))
    check('the two rows become one',
      after.names.length === 1 && /\/\//.test(after.names[0]), JSON.stringify(after))
    /*
      One row fewer than before, rather than exactly one row: the search for the set also
      matches the Cat Warrior // Rat card the other probe added, so an absolute count
      would be asserting something about the fixture instead of about the merge.
    */
    check('and one row fewer exists, because two rows of one are one card',
      after.rows === before.rows - 1, `${before.rows} rows before, ${after.rows} after`)
    /*
      The selection survives the merge with the row that survived it -- the view drops
      keys that are no longer on screen -- so the way back is offered without clicking
      anything further. Clicking here would *deselect* it.
    */
    check('and that row offers to be separated again',
      after.separateOffered === true, JSON.stringify(after))
  }

  console.log('\n' + passed + ' passed, ' + failed + ' failed')
  ws.close()
  process.exit(failed === 0 ? 0 : 1)
})().catch((e) => {
  console.log('  probe failed: ' + e.message)
  process.exit(1)
})
