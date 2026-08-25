/**
 * Fast entry, tokens, and both sides of a double-faced card, in the running app.
 *
 *   npm run build
 *   npx electron . --user-data-dir=/tmp/probe --remote-debugging-port=9340
 *   npm run probe:tokens             (or: node scripts/probe-tokens.cjs 9340 /tmp/probe)
 *
 * Give it a scratch profile rather than your own: it adds cards, and it wants the set
 * cache to start empty -- that lazy sync is what the token disambiguation depends on.
 *
 * What it settles, in the order the bug was found:
 *   - "c17 008/011", the number as printed, reaches the Cat Warrior on C17's token
 *     sheet rather than Teferi's Protection at C17 #8.
 *   - "c17 8" still reaches Teferi's Protection, because that is what that line says.
 *     Trading one silent wrong card for another would be no fix at all.
 *   - a collector number typed in the wrong case still resolves; Scryfall is strict
 *     and inconsistent about it, and nobody reads case off a card.
 *   - a token can be found by name at all, which needed include_extras.
 *   - flipping a double-faced card changes the picture and not only the words, and the
 *     two faces are two different files rather than the front fetched twice.
 */
const fs = require('fs')
const path = require('path')
const PORT = process.argv[2] ?? '9340'
const PROFILE = process.argv[3]
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

  // dismiss anything modal, then Add cards -> Fast entry
  await ev(`(async () => {
    document.querySelector('[data-action="updateLater"]')?.click()
    await new Promise((r) => setTimeout(r, 200))
    const nav = document.querySelector('nav') ?? document.querySelector('aside')
    const items = [...nav.querySelectorAll('button')]
    items[1].click()
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

  // ---- 1. the printed form reaches the token sheet
  await typeLine('c17 008/011')
  await sleep(6000)
  let lines = JSON.parse(await logLines())
  console.log('        → ' + JSON.stringify(lines))
  check('the printed number "c17 008/011" adds the Cat Warrior token',
    lines.some((l) => /Cat Warrior/i.test(l)), JSON.stringify(lines))
  check('and the line names the sheet it actually used, not the code that was typed',
    lines.some((l) => /TC17/i.test(l) && /#8\b/.test(l)), JSON.stringify(lines))
  check('and marks it as a token',
    lines.some((l) => /Cat Warrior/i.test(l) && /token/i.test(l)), JSON.stringify(lines))

  // ---- 2. the regression: the same number without a total is the real card
  await typeLine('c17 8')
  await sleep(5000)
  lines = JSON.parse(await logLines())
  console.log('        → ' + JSON.stringify(lines))
  check('"c17 8" still adds Teferi\'s Protection, which is what that line means',
    lines.some((l) => /Teferi/i.test(l)), JSON.stringify(lines))
  check('and is not marked a token',
    lines.every((l) => !/Teferi/i.test(l) || !/token/i.test(l)), JSON.stringify(lines))

  // ---- 3. a double-faced token, for the flip
  await typeLine('plst tdft-14')
  await sleep(6000)
  lines = JSON.parse(await logLines())
  check('a double-faced token adds by its printed number',
    lines.some((l) => /Max Speed|Start Your Engines/i.test(l)), JSON.stringify(lines))
  console.log('        → ' + JSON.stringify(lines))

  // ---- 4. search by name finds a token at all
  const found = JSON.parse(await ev(`(async () => {
    const tabs = [...document.querySelectorAll('button')]
      .filter((b) => /Recherche|Search/i.test(b.innerText))
    tabs[0]?.click()
    await new Promise((r) => setTimeout(r, 400))
    const input = document.querySelector('input[placeholder*="Entrée"], input[placeholder*="Enter"]')
    if (!input) throw new Error('search input not found')
    const setter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype, 'value').set
    setter.call(input, 'Cat Warrior')
    input.dispatchEvent(new Event('input', { bubbles: true }))
    await new Promise((r) => setTimeout(r, 1200))
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    await new Promise((r) => setTimeout(r, 6000))
    const text = document.body.innerText
    return JSON.stringify({
      mentionsToken: /Cat Warrior/i.test(text),
      tiles: document.querySelectorAll('[data-field="printingTile"], img[alt]').length
    })
  })()`))
  console.log('        → search: ' + JSON.stringify(found))
  check('searching by name finds the token, which returned nothing before',
    found.mentionsToken === true, JSON.stringify(found))


  // Collection, then open the double-faced token's detail
  const opened = JSON.parse(await ev(`(async () => {
    const nav = document.querySelector('nav') ?? document.querySelector('aside')
    ;[...nav.querySelectorAll('button')][0].click()
    await new Promise((r) => setTimeout(r, 1200))
    // The card name is itself the button that opens the detail.
    const rows = [...document.querySelectorAll('button')]
      .filter((e) => /Max Speed|Start Your Engines/i.test(e.innerText || ''))
    const names = rows.map((r) => (r.innerText || '').split('\\n')[0].slice(0, 40))
    // the innermost match is the cell; click it to open the detail modal
    const target = rows[0]
    if (target) target.click()
    await new Promise((r) => setTimeout(r, 1400))
    return JSON.stringify({ matched: rows.length, names: names.slice(-3),
      modal: document.querySelector('[role="dialog"]') !== null })
  })()`))
  console.log('        → ' + JSON.stringify(opened))
  check('the double-faced token is in the collection and opens', opened.modal === true,
    JSON.stringify(opened))

  const imageState = () => ev(`(() => {
    const dialog = document.querySelector('[role="dialog"]')
    if (!dialog) return JSON.stringify({ open: false })
    const img = dialog.querySelector('img')
    const flip = [...dialog.querySelectorAll('button')]
      .find((b) => /Punchcard|Max Speed|Start Your Engines/i.test(b.innerText))
    return JSON.stringify({
      open: true,
      src: img ? img.getAttribute('src') : null,
      w: img ? img.naturalWidth : 0,
      flipLabel: flip ? flip.innerText.replace(/\\s+/g, ' ').trim() : null
    })
  })()`)

  const before = JSON.parse(await imageState())
  console.log('        → front: ' + JSON.stringify(before))
  check('the front is showing, with no face in its URL',
    before.src !== null && !before.src.includes('face='), String(before.src))
  check('and a flip control is offered', before.flipLabel !== null, JSON.stringify(before))

  // flip
  await ev(`(() => {
    const dialog = document.querySelector('[role="dialog"]')
    const flip = [...dialog.querySelectorAll('button')]
      .find((b) => /Punchcard|Max Speed|Start Your Engines/i.test(b.innerText))
    flip.click()
    return true
  })()`)
  await sleep(3500)
  const after = JSON.parse(await imageState())
  console.log('        → back:  ' + JSON.stringify(after))
  check('flipping asks for the second face', String(after.src).includes('face=1'),
    String(after.src))
  check('and that image actually loaded, rather than breaking',
    after.w > 0, 'naturalWidth ' + after.w)

  // the two faces are two files, and two different pictures
  const dir = path.join(PROFILE, 'images')
  const files = fs.existsSync(dir) ? fs.readdirSync(dir) : []
  const backs = files.filter((f) => f.includes('-face1'))
  check('the back is cached as its own file', backs.length > 0,
    files.length + ' cached images, none a back face')
  for (const back of backs) {
    const front = back.replace('-face1', '')
    if (!files.includes(front)) continue
    const a = fs.statSync(path.join(dir, front)).size
    const b = fs.statSync(path.join(dir, back)).size
    check('and it is a different picture, not the front fetched twice', a !== b,
      `${front} and ${back} are both ${a} bytes`)
    console.log(`        → ${front} ${a}B vs ${back} ${b}B`)
  }


  console.log('\n' + passed + ' passed, ' + failed + ' failed')
  ws.close()
  process.exit(failed === 0 ? 0 : 1)
})().catch((e) => {
  console.log('  probe failed: ' + e.message)
  process.exit(1)
})
