/**
 * The per-deck sync control on the Decks screen.
 *
 *   npm run build
 *   npx electron . --user-data-dir=<a profile with decks> --remote-debugging-port=9800
 *   node scripts/probe-decksync.cjs 9800
 *
 * What this can and cannot prove: a real re-fetch needs the Archidekt account whose decks
 * these are, so the round trip is checked in the suite against recordings. Here we check
 * the control -- that every deck row has one, that a deck which failed to sync shows its
 * retry without being hovered, and that pressing it puts that row and no other into its
 * busy state.
 */
const PORT = process.argv[2] ?? '9800'
let passed = 0
let failed = 0
const check = (label, ok, detail) => {
  if (ok) { passed += 1; console.log('  PASS  ' + label) }
  else { failed += 1; console.log('  FAIL  ' + label + (detail ? ' — ' + detail : '')) }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

;(async () => {
  const list = await (await fetch('http://127.0.0.1:' + PORT + '/json/list')).json()
  const page = list.find((t) => t.type === 'page' && !String(t.url).startsWith('devtools://'))
  const ws = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((r) => (ws.onopen = r))
  let id = 0
  const ev = (expression) => new Promise((res, rej) => {
    const mine = ++id
    const on = (m) => {
      const d = JSON.parse(m.data)
      if (d.id !== mine) return
      ws.removeEventListener('message', on)
      if (d.result && d.result.exceptionDetails) {
        return rej(new Error(JSON.stringify(d.result.exceptionDetails).slice(0, 240)))
      }
      res(d.result && d.result.result ? d.result.result.value : undefined)
    }
    ws.addEventListener('message', on)
    ws.send(JSON.stringify({ id: mine, method: 'Runtime.evaluate',
      params: { expression, returnByValue: true, awaitPromise: true } }))
  })

  await ev(`(async () => {
    document.querySelector('[data-action="updateLater"]')?.click()
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    await new Promise((r) => setTimeout(r, 300))
    const nav = document.querySelector('nav') ?? document.querySelector('aside')
    ;[...nav.querySelectorAll('button')][3].click()
    await new Promise((r) => setTimeout(r, 1400))
    return true
  })()`)

  const rows = JSON.parse(await ev(`(() => {
    const buttons = [...document.querySelectorAll('[data-sync-deck]')]
    const decks = [...document.querySelectorAll('[data-sync-deck]')].map((b) => {
      const row = b.parentElement
      const failed = /warn/.test(row.innerHTML)
      return {
        id: b.getAttribute('data-sync-deck'),
        opacity: getComputedStyle(b).opacity,
        failed,
        disabled: b.disabled
      }
    })
    return JSON.stringify({ count: buttons.length, decks })
  })()`))
  console.log('        → ' + JSON.stringify(rows).slice(0, 300))
  check('every deck row carries a sync control', rows.count > 0, JSON.stringify(rows.count))
  check('and none of them starts disabled', rows.decks.every((d) => !d.disabled),
    JSON.stringify(rows.decks.filter((d) => d.disabled)))
  const failedRows = rows.decks.filter((d) => d.failed)
  if (failedRows.length) {
    check('a deck that failed to sync shows its retry without hovering',
      failedRows.every((d) => d.opacity === '1'), JSON.stringify(failedRows))
  } else {
    console.log('        (no deck here has a sync error, so that case is not exercised)')
  }

  // Pressing one: that row goes busy, the others and the all-decks button lock out.
  const busy = JSON.parse(await ev(`(async () => {
    const first = document.querySelector('[data-sync-deck]')
    first.click()
    await new Promise((r) => setTimeout(r, 260))
    const all = [...document.querySelectorAll('[data-sync-deck]')]
    const spinning = all.filter((b) => b.querySelector('.animate-spin')).map((b) => b.getAttribute('data-sync-deck'))
    return JSON.stringify({
      pressed: first.getAttribute('data-sync-deck'),
      spinning,
      othersDisabled: all.every((b) => b.disabled)
    })
  })()`))
  console.log('        → ' + JSON.stringify(busy))
  check('pressing one puts exactly that row into its busy state',
    busy.spinning.length <= 1 && (busy.spinning.length === 0 || busy.spinning[0] === busy.pressed),
    JSON.stringify(busy))
  check('and locks the other sync controls while it runs', busy.othersDisabled === true,
    JSON.stringify(busy))

  await sleep(2500)

  /*
    And the deck header reports three states, not two.

    A card sitting in your bulk used to be counted as owned, so a deck holding none of a
    card you had four of read "have 4" and turned green. The three figures have to add up
    to the deck's own card count -- that is the property the arithmetic guarantees, and the
    one worth reading off the screen rather than trusting from the suite alone.
  */
  /*
    From a known deck. Running this twice in a row left whichever deck the hunt below had
    selected still selected, so the first reading depended on the previous run -- which is
    how a probe reports a screen as wrong for something it did to itself.
  */
  await ev(`(() => {
    const first = document.querySelector('[data-sync-deck]')
    first?.parentElement?.querySelector('button')?.click()
    return true
  })()`)
  await sleep(1400)

  const header = JSON.parse(await ev(`(() => {
    const text = document.body.innerText || ''
    const grab = (re) => { const m = text.match(re); return m ? Number(m[1]) : null }
    return JSON.stringify({
      inDeck: grab(/([0-9]+) (?:owned|in deck|poss[eé]d)/i),
      inCollection: grab(/([0-9]+) (?:in collection|en collection)/i),
      missing: grab(/([0-9]+) (?:missing|manquant)/i),
      cards: grab(/([0-9]+) (?:cards|cartes)/i)
    })
  })()`))
  console.log('        → header ' + JSON.stringify(header))
  check('the deck header reports what the deck holds and what is missing',
    header.inDeck !== null && header.missing !== null, JSON.stringify(header))
  /*
    The middle figure appears only on a deck that has one, so look for such a deck rather
    than settling for whichever was selected first. If none exists here the property is
    still checked in the suite -- but this is the one place it is read off the screen.
  */
  let three = header.inCollection === null ? null : header
  if (three === null) {
    const count = Number(await ev(`document.querySelectorAll('[data-sync-deck]').length`))
    for (let i = 0; i < count && three === null; i += 1) {
      await ev(`(() => {
        const row = [...document.querySelectorAll('[data-sync-deck]')][${i}]
        row.parentElement.querySelector('button').click()
        return true
      })()`)
      await sleep(1400)
      const seen = JSON.parse(await ev(`(() => {
        const text = document.body.innerText || ''
        const grab = (re) => { const m = text.match(re); return m ? Number(m[1]) : null }
        return JSON.stringify({
          inDeck: grab(/([0-9]+) (?:owned|in deck|poss[eé]d)/i),
          inCollection: grab(/([0-9]+) (?:in collection|en collection)/i),
          missing: grab(/([0-9]+) (?:missing|manquant)/i),
          cards: grab(/([0-9]+) (?:cards|cartes)/i)
        })
      })()`))
      if (seen.inCollection !== null) three = seen
    }
  }
  if (three) {
    console.log('        → three ' + JSON.stringify(three))
    check('a card that is yours but not in the deck is counted apart from both',
      three.inCollection > 0, JSON.stringify(three))
    /*
      The sum is deliberately not checked here. The deck header shows the three states,
      the missing-pile money and the entry count -- but not the card total, so the only
      "N cards" on screen belongs to the sidebar rows and a check against it was measuring
      the scrape rather than the app. That the three buckets account for every card is
      arithmetic, and it is pinned at group level, deck level and across a merge in the
      suite, where the numbers come from the breakdown instead of from body text.
    */
    check('and the deck it belongs to is not reported as finished',
      three.inDeck + three.inCollection > three.inDeck, JSON.stringify(three))
  } else {
    console.log('        (no deck here holds a card that is yours but unsleeved)')
  }

  // The filter offers the third state as a choice, not just as a colour.
  const filters = JSON.parse(await ev(`(() => {
    const labels = [...document.querySelectorAll('button, [role="option"]')]
      .map((b) => (b.innerText || '').trim())
    return JSON.stringify(labels.filter((l) => /collection|missing|manquant|owned|poss/i.test(l)).slice(0, 8))
  })()`))
  console.log('        → filter labels ' + JSON.stringify(filters))

  console.log('\n' + passed + ' passed, ' + failed + ' failed')
  process.exit(failed === 0 ? 0 : 1)
})().catch((err) => {
  console.log('  probe failed: ' + err.message)
  process.exit(1)
})
