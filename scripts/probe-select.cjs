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

  console.log('\n' + passed + ' passed, ' + failed + ' failed')
  process.exit(failed === 0 ? 0 : 1)
})().catch((err) => {
  console.log('  probe failed: ' + err.message)
  process.exit(1)
})
