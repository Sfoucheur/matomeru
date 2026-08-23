/**
 * Drives the live UI to confirm this round of features works on screen.
 *
 * The SQL suite proves the data layer; this proves the pixels. Every question
 * here is one the database cannot answer: does the searchable filter narrow as
 * you type, does a selected option survive a query that excludes it, does the
 * French build leave English words behind on any screen.
 *
 * Views are reached by clicking the sidebar by index rather than by label, since
 * the labels are exactly what changes when the language does.
 *
 *   npm run build
 *   npx electron . --user-data-dir=/tmp/probe --remote-debugging-port=9222
 *   node scripts/check-features.cjs
 *
 * Run it ONCE per freshly-launched app. It is not idempotent by design: it
 * switches locale (which reloads the window), changes view modes, ticks filters
 * and creates pick lists. Firing it again while a previous run's reload is still
 * in flight makes the first evaluate come back empty — which looks like a product
 * failure and is not one. Relaunch the app between runs.
 */
const port = process.argv[2] ?? '9222'

/** Sidebar order, from NAV in App.tsx. */
const VIEWS = ['collection', 'add', 'picks', 'decks', 'import', 'stats', 'settings']

let passed = 0
let failed = 0

function check(label, ok, detail) {
  if (ok) {
    passed += 1
    console.log(`  PASS  ${label}`)
  } else {
    failed += 1
    console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`)
  }
}

function section(name) {
  console.log(`\n${name}\n${'-'.repeat(name.length)}`)
}

async function findPage() {
  for (let i = 0; i < 40; i += 1) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
      const page = list.find((t) => t.type === 'page')
      if (page) return page
    } catch {
      /* not listening yet */
    }
    await new Promise((r) => setTimeout(r, 500))
  }
  throw new Error('no debuggable page')
}

function rpc(ws) {
  let id = 0
  return (method, params) =>
    new Promise((resolve, reject) => {
      const myId = ++id
      const onMessage = (event) => {
        const msg = JSON.parse(event.data)
        if (msg.id !== myId) return
        ws.removeEventListener('message', onMessage)
        if (msg.result?.exceptionDetails) {
          reject(new Error(msg.result.exceptionDetails.exception?.description ?? 'threw'))
        } else resolve(msg.result)
      }
      ws.addEventListener('message', onMessage)
      ws.send(JSON.stringify({ id: myId, method, params }))
    })
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms))

async function main() {
  const page = await findPage()
  const ws = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((r) => (ws.onopen = r))
  const call = rpc(ws)
  const evaluate = async (expression) =>
    (await call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }))
      ?.result?.value

  // React 19 ignores synthetic input events even via the native value setter, so
  // typing has to go through the input pipeline the browser itself uses.
  const type = async (text) => {
    await call('Input.insertText', { text })
    await wait(280)
  }

  const goto = async (view) => {
    const index = VIEWS.indexOf(view)
    await evaluate(`(() => {
      const nav = document.querySelector('nav') ?? document.querySelector('aside')
      const buttons = [...(nav ?? document).querySelectorAll('button')]
      buttons[${index}]?.click()
      return buttons.length
    })()`)
    await wait(550)
  }

  /**
   * Switches the app language for real.
   *
   * `window.api.settings.update` writes the database but not the renderer store,
   * so the UI would keep rendering in the old language. Reloading re-reads the
   * setting on boot, which is what makes this observable on screen.
   */
  const setLocale = async (locale) => {
    await evaluate(`window.api.settings.update({ locale: '${locale}' })`)
    await call('Page.reload', {})
    // Wait for the sidebar to come back rather than guessing at a duration.
    for (let i = 0; i < 40; i += 1) {
      await wait(250)
      const ready = await evaluate(
        `!!document.querySelector('nav button')`
      ).catch(() => false)
      if (ready) break
    }
    await wait(600)
  }

  section('The new IPC surface reaches the renderer')
  const api = JSON.parse(
    await evaluate(`JSON.stringify({
      setCardFinish: typeof window.api.decks.setCardFinish,
      boosterSets: typeof window.api.boosters.sets,
      loadForCollection: typeof window.api.boosters.loadForCollection,
      update: typeof window.api.collection.update
    })`)
  )
  check(
    'setCardFinish, boosters.sets, loadForCollection and collection.update are all exposed',
    Object.values(api).every((v) => v === 'function'),
    JSON.stringify(api)
  )

  section('Booster data the app can answer without a download')
  const sets = JSON.parse(
    await evaluate(`(async () => {
      const rows = await window.api.boosters.sets()
      return JSON.stringify({
        total: rows.length,
        fetched: rows.filter((r) => r.fetched).length,
        top: rows.slice(0, 3).map((r) => r.set_code + ':' + r.cards)
      })
    })()`)
  )
  check('the app knows which of your sets hold booster cards', sets.total > 0, JSON.stringify(sets))
  console.log(`        → ${sets.total} sets (${sets.fetched} fetched): ${sets.top.join(', ')}`)

  section('Foil status, on screen')
  await setLocale('en')
  // Mark a real deck entry a surge foil through the same IPC the UI calls, then
  // read the result back off the screen.
  const marked = JSON.parse(
    await evaluate(`(async () => {
      const decks = await window.api.decks.list()
      if (!decks.length) return JSON.stringify({ skip: 'no decks synced' })
      const deck = decks[0]
      const breakdown = await window.api.decks.breakdown(deck.id)
      const cards = (breakdown?.groups ?? []).flatMap((g) => g.cards)
      const target = cards.find((c) => c.oracle_id && c.finish === 'nonfoil')
      if (!target) return JSON.stringify({ skip: 'no nonfoil deck entry' })
      await window.api.decks.setCardFinish(deck.id, [target.oracle_id], 'foil', 'surgefoil')
      return JSON.stringify({
        deckId: deck.id,
        deckName: deck.name,
        oracleId: target.oracle_id,
        card: target.name
      })
    })()`)
  )

  if (marked.skip) {
    console.log(`        → skipped: ${marked.skip}`)
  } else {
    console.log(`        → marked "${marked.card}" in "${marked.deckName}" as a surge foil`)
    await goto('decks')
    // Open that deck: its button lives in the deck column, not the app sidebar.
    await evaluate(`(() => {
      const name = ${JSON.stringify(marked.deckName)}
      const target = [...document.querySelectorAll('button')].find((b) =>
        (b.textContent ?? '').includes(name)
      )
      target?.click()
      return !!target
    })()`)
    await wait(1400)
    // Row mode explicitly: the two modes render the badge separately, and an
    // earlier geometry run may have left the view in grid.
    await evaluate(`(() => {
      const rowView = document.querySelector('[aria-label="Row view"]')
      rowView?.click()
      return !!rowView
    })()`)
    await wait(1200)

    const badge = JSON.parse(
      await evaluate(`(() => {
        const text = document.body.innerText
        return JSON.stringify({ surge: /Surge Foil/i.test(text), star: text.includes('★') })
      })()`)
    )
    check('the deck row names the foil type it was given', badge.surge, JSON.stringify(badge))
    check('and marks it as a value you set', badge.star, JSON.stringify(badge))

    // The derived collection row must agree, or the two screens disagree about
    // the same physical card — the failure the language override already had.
    const filtered = JSON.parse(
      await evaluate(`(async () => {
        const page = await window.api.collection.query(
          {
            search: '', langs: [], rarities: [], sets: [], finishes: [],
            treatments: ['surgefoil'], conditions: [], colors: [], typeLine: '',
            cmcMin: null, cmcMax: null, valueMin: null, valueMax: null,
            deckScope: null, source: null, onlyReserved: false,
            sort: 'added_at', dir: 'desc', sort2: null, dir2: 'asc'
          },
          50,
          0
        )
        return JSON.stringify({
          rows: page.rows.length,
          allSurge: page.rows.every((r) => r.foil_treatment === 'surgefoil')
        })
      })()`)
    )
    check(
      'the collection can be filtered to that foil type',
      filtered.rows > 0 && filtered.allSurge,
      JSON.stringify(filtered)
    )

    // ---- still inside the foil section: that entry is foil and on screen ----
    section('The foil marker survives every tile size')
    await evaluate(`(() => {
      const grid = document.querySelector('[aria-label="Grid view"]')
      grid?.click()
      return !!grid
    })()`)
    await wait(1300)

    // This is the whole point of drawing it over the artwork: at the smallest
    // tiles CardTile drops the title and footer, so a marker that went with them
    // would leave a 90px foil thumbnail indistinguishable from its nonfoil twin.
    // Sweep the column stepper from widest to narrowest and watch it hold.
    const sweep = JSON.parse(
      await evaluate(`(async () => {
        const visible = () =>
          [...document.querySelectorAll('main > div')].find((p) => !p.classList.contains('hidden'))
        const readout = () => {
          const el = [...(visible() ?? document).querySelectorAll('span')].find((sp) =>
            (sp.textContent || '').trim().endsWith('/row')
          )
          return el ? Number(el.textContent.trim().split('/')[0]) : null
        }
        const setColumns = async (target) => {
          for (let i = 0; i < 26; i += 1) {
            const shown = readout()
            if (shown === target || shown === null) break
            const label =
              shown < target ? 'More columns, smaller cards' : 'Fewer columns, bigger cards'
            const button = (visible() ?? document).querySelector('[aria-label="' + label + '"]')
            if (!button) break
            button.click()
            await new Promise((r) => setTimeout(r, 180))
          }
          await new Promise((r) => setTimeout(r, 900))
          return readout()
        }
        // Every visited view stays mounted behind display:none, so an unscoped
        // query answers from whichever pane happens to come first in the DOM —
        // which is why this sweep first reported the same 116px tile at every
        // column count. Scope everything to the visible pane.
        const pane = () =>
          [...document.querySelectorAll('main > div')].find((p) => !p.classList.contains('hidden'))
        const readBadge = () => {
          const root = pane() ?? document
          /*
            Found by its own hook, not by a class. Matching on the badge's
            translucent fill broke all three of these checks the moment it was made
            solid: a check should not depend on what something looks like.
            (No backticks in here -- this comment lives inside a template literal.)
          */
          const chips = [...root.querySelectorAll('[data-foil-badge]')]
          const arts = [...root.querySelectorAll('[class*="aspect-[488/680]"]')]
          return {
            count: chips.length,
            text: chips[0] ? (chips[0].textContent || '').trim() : null,
            title: chips[0] ? chips[0].getAttribute('title') : null,
            tiles: arts.length,
            width: Math.round(arts[0] ? arts[0].getBoundingClientRect().width : 0)
          }
        }
        const out = []
        for (const target of [2, 6, 10, 14]) {
          const actual = await setColumns(target)
          out.push({ columns: actual, ...readBadge() })
        }
        return JSON.stringify(out)
      })()`)
    )

    for (const step of sweep) {
      console.log(
        `        → ${String(step.columns).padStart(2)} cols, ${step.width}px tile: ` +
          `${step.count} marker(s), text ${JSON.stringify(step.text)}`
      )
    }
    check(
      'the foil marker is present at every tile size',
      sweep.length > 0 && sweep.every((step) => step.count > 0),
      JSON.stringify(sweep.filter((step) => step.count === 0))
    )
    check(
      'the widest tiles spell the treatment out',
      /Surge/i.test(sweep[0]?.text ?? ''),
      JSON.stringify(sweep[0])
    )
    check(
      'the narrowest drop the words but keep the marker',
      (sweep[sweep.length - 1]?.text ?? '').length < (sweep[0]?.text ?? 'x').length,
      JSON.stringify([sweep[0]?.text, sweep[sweep.length - 1]?.text])
    )
    check(
      'and the tooltip carries the full name at every size',
      sweep.every((step) => /Surge Foil/i.test(step.title ?? '')),
      JSON.stringify(sweep.map((step) => step.title))
    )
    check(
      'nonfoil cards are left unmarked, or the marker would mean nothing',
      sweep.every((step) => step.count < step.tiles),
      JSON.stringify(sweep.map((step) => `${step.count}/${step.tiles}`))
    )

    // Hand the entry back to Archidekt's value.
    const restored = await evaluate(`(async () => {
      await window.api.decks.setCardFinish(
        ${marked.deckId}, [${JSON.stringify(marked.oracleId)}], null, null
      )
      const breakdown = await window.api.decks.breakdown(${marked.deckId})
      const cards = (breakdown?.groups ?? []).flatMap((g) => g.cards)
      // Only the entry this run touched: asserting that nothing anywhere is
      // marked would be testing the probe database, not the feature.
      const mine = cards.find((c) => c.oracle_id === ${JSON.stringify(marked.oracleId)})
      return mine && !mine.finish_forced && !mine.treatment_forced ? 'restored' : 'still set'
    })()`)
    check('clearing it returns the entry to Archidekt', restored === 'restored', String(restored))
  }

  section('Booster panel: the right state per card')
  // Three states, checked through the same call the panel makes. A precon card,
  // a booster card whose set has never been fetched, and one in a fetched set.
  const panelStates = JSON.parse(
    await evaluate(`(async () => {
      const pick = async (flag, fetched) => {
        const decks = await window.api.decks.list()
        for (const d of decks) {
          const b = await window.api.decks.breakdown(d.id)
          for (const c of (b?.groups ?? []).flatMap((g) => g.cards)) {
            if (!c.scryfall_id || !c.set_code) continue
            const odds = await window.api.boosters.forCard(c.scryfall_id, c.set_code)
            if (odds.in_boosters === flag && odds.fetched === fetched) {
              return { name: c.name, set: c.set_code, odds }
            }
          }
        }
        return null
      }
      return JSON.stringify({
        precon: await pick(false, false),
        pending: await pick(true, false),
        computed: await pick(true, true)
      })
    })()`)
  )
  check(
    'a precon card reports "not a booster card" with nothing fetched',
    !!panelStates.precon && panelStates.precon.odds.in_boosters === false,
    JSON.stringify(panelStates.precon?.name ?? null)
  )
  if (panelStates.precon) {
    console.log(`        → ${panelStates.precon.name} (${panelStates.precon.set})`)
  }
  // Migration 9 deliberately cleared the old finish-blind cache, so a fresh
  // database has nothing fetched. Fetch one owned set here rather than assert
  // against an empty cache and call it a pass.
  if (!panelStates.computed) {
    const fetched = JSON.parse(
      await evaluate(`(async () => {
        const sets = await window.api.boosters.sets()
        const target = sets.filter((s) => !s.fetched).sort((a, b) => a.cards - b.cards)[0]
        if (!target) return JSON.stringify({ skip: 'nothing to fetch' })
        const result = await window.api.boosters.load(target.set_code)
        return JSON.stringify({ set: target.set_code, ...result })
      })()`)
    )
    console.log(
      `        → fetched ${fetched.set ?? '(none)'} for the test: ${fetched.boosters ?? 0} booster type(s)`
    )
    panelStates.computed = JSON.parse(
      await evaluate(`(async () => {
        const decks = await window.api.decks.list()
        for (const d of decks) {
          const b = await window.api.decks.breakdown(d.id)
          for (const c of (b?.groups ?? []).flatMap((g) => g.cards)) {
            if (!c.scryfall_id || !c.set_code) continue
            const odds = await window.api.boosters.forCard(c.scryfall_id, c.set_code)
            if (odds.fetched) return JSON.stringify({ name: c.name, set: c.set_code, odds })
          }
        }
        return 'null'
      })()`)
    )
  }

  const withOdds = panelStates.computed
  check(
    'a card in a fetched set reports real per-booster figures',
    !!withOdds && withOdds.odds.fetched && withOdds.odds.boosters.length > 0,
    JSON.stringify(withOdds?.name ?? null)
  )
  if (withOdds) {
    const best = withOdds.odds.boosters
      .filter((b) => b.probability > 0)
      .map((b) => `${b.name} ${(b.probability * 100).toFixed(2)}%`)
    console.log(`        → ${withOdds.name}: ${best.join(', ') || 'in no booster of this set'}`)
    const chances = withOdds.odds.boosters.flatMap((b) =>
      [b.nonfoil, b.foil].filter((c) => c !== null)
    )
    check(
      'and every probability it reports is a probability',
      chances.length > 0 && chances.every((c) => c.probability >= 0 && c.probability <= 1)
    )
    check(
      'the odds are split per finish, not one blended figure',
      // The bug this round fixed: a card sold in both finishes must carry two
      // separate buckets, because the sheets they come off are different.
      withOdds.odds.boosters.every((b) => b.nonfoil !== undefined && b.foil !== undefined),
      JSON.stringify(withOdds.odds.boosters[0])
    )
    check(
      'a booster whose contents we cannot name says so instead of reading 0%',
      withOdds.odds.boosters.every((b) => typeof b.coverage === 'number'),
      JSON.stringify(withOdds.odds.boosters.map((b) => [b.code, b.coverage]))
    )
  }

  section('Searchable filters, driven on screen')
  await goto('collection')
  // Clear anything an earlier run ticked: a live set filter shrinks the facet
  // list, which would make "typing narrows it" pass for the wrong reason.
  await evaluate(`(() => {
    const clear = [...document.querySelectorAll('button')].find((b) =>
      /^(Clear all|Tout effacer)/.test((b.textContent ?? '').trim())
    )
    clear?.click()
    return !!clear
  })()`)
  await wait(500)
  const trigger = await evaluate(`(() => {
    // The Set filter is the one whose option list is long enough to need search.
    const buttons = [...document.querySelectorAll('button.field, button')]
    const target = buttons.find((b) => {
      const text = (b.textContent ?? '').trim()
      // The label, optionally followed by a count badge — and nothing else.
      // "/^Set/" also matched the "Settings" nav button, which navigated away
      // and made the rest of this section measure the Settings screen.
      return /^(Set|Édition)\d*$/.test(text)
    })
    if (!target) return 'no-trigger'
    target.click()
    return 'clicked'
  })()`)
  await wait(400)
  check('the Set filter opens', trigger === 'clicked', String(trigger))

  const before = JSON.parse(
    await evaluate(`(() => {
      const panel = document.querySelector('[data-popover]')
      const search = panel?.querySelector('input')
      const options = [...(panel?.querySelectorAll('button') ?? [])]
      return JSON.stringify({ hasSearch: !!search, options: options.length })
    })()`)
  )
  check('a long option list gets a search field', before.hasSearch, JSON.stringify(before))
  console.log(`        → ${before.options} options before typing`)

  if (before.hasSearch) {
    await type('lc')
    const after = JSON.parse(
      await evaluate(`(() => {
        const panel = document.querySelector('[data-popover]')
        const options = [...(panel?.querySelectorAll('button') ?? [])]
        return JSON.stringify({
          query: panel?.querySelector('input')?.value ?? '',
          options: options.length,
          labels: options.slice(0, 3).map((b) => (b.textContent ?? '').trim().slice(0, 22))
        })
      })()`)
    )
    check('the query lands in the search box', after.query === 'lc', after.query)
    check(
      'typing narrows the list',
      after.options > 0 && after.options < before.options,
      `${before.options} → ${after.options}`
    )
    console.log(`        → matched: ${after.labels.join(', ')}`)

    // Tick the first match, then search for something it cannot match. If the
    // selected option vanished there would be no way to untick it.
    await evaluate(`(() => {
      const panel = document.querySelector('[data-popover]')
      const options = [...(panel?.querySelectorAll('button') ?? [])]
      options[0]?.click()
      return 'ticked'
    })()`)
    await wait(320)
    await call('Input.dispatchKeyEvent', {
      type: 'keyDown',
      key: 'Backspace',
      windowsVirtualKeyCode: 8,
      nativeVirtualKeyCode: 8
    })
    await call('Input.dispatchKeyEvent', {
      type: 'keyDown',
      key: 'Backspace',
      windowsVirtualKeyCode: 8,
      nativeVirtualKeyCode: 8
    })
    await type('zzzq')
    const kept = JSON.parse(
      await evaluate(`(() => {
        const panel = document.querySelector('[data-popover]')
        const options = [...(panel?.querySelectorAll('button') ?? [])]
        const ticked = options.filter((b) => b.querySelector('svg'))
        return JSON.stringify({
          query: panel?.querySelector('input')?.value ?? '',
          options: options.length,
          ticked: ticked.length,
          labels: options.map((b) => (b.textContent ?? '').trim().slice(0, 18))
        })
      })()`)
    )
    check(
      'a selected option stays listed even when the query excludes it',
      kept.ticked >= 1,
      JSON.stringify(kept)
    )
    console.log(`        → query "${kept.query}" still shows: ${kept.labels.join(', ')}`)
  }

  await call('Input.dispatchKeyEvent', {
    type: 'keyDown',
    key: 'Escape',
    windowsVirtualKeyCode: 27,
    nativeVirtualKeyCode: 27
  })
  await wait(250)

  section('Staging goes into the list you chose')
  await setLocale('en')
  await goto('collection')
  // The searchable-filter section above leaves a set ticked, which filters the
  // table — so a row this section finds by query would not be on screen to click.
  await evaluate(`(() => {
    const clear = [...document.querySelectorAll('button')].find((b) =>
      /^(Clear all|Tout effacer)/.test((b.textContent || '').trim())
    )
    clear?.click()
    return !!clear
  })()`)
  await wait(900)

  // Two open lists, so "it went to the newest" and "it went where I clicked" are
  // distinguishable outcomes — with one list they look identical.
  const madeLists = JSON.parse(
    await evaluate(`(async () => {
      const older = await window.api.pickLists.create('Check older')
      const newer = await window.api.pickLists.create('Check newer')
      return JSON.stringify({ older, newer })
    })()`)
  )
  console.log(`        → created lists ${madeLists.older} (older) and ${madeLists.newer} (newer)`)

  // Gallery mode, chosen only because this section then matches tiles by their
  // label. Table mode selects perfectly well — an earlier version of this comment
  // claimed otherwise, which was wrong: the apparent failure was an English-only
  // aria-label selector running against a French UI, which is why setLocale('en')
  // above is load-bearing rather than cosmetic.
  await evaluate(`(() => {
    const gallery = document.querySelector('[aria-label="Gallery view"]')
    gallery?.click()
    return !!gallery
  })()`)
  await wait(1200)

  // Pick a row that actually has a free copy. Copies already reserved by another
  // open list have available === 0 and are refused outright, which made this look
  // like a staging failure when it was the guard working correctly.
  //
  // Matched on the tile's own label, which carries the *localized* title — the
  // English oracle name does not appear there, so matching on it found nothing.
  const selected = JSON.parse(
    await evaluate(`(async () => {
      const page = await window.api.collection.query({
        search: '', langs: [], rarities: [], sets: [], finishes: [], treatments: [],
        conditions: [], colors: [], typeLine: '', cmcMin: null, cmcMax: null,
        valueMin: null, valueMax: null, deckScope: null, source: null,
        onlyReserved: false, sort: 'added_at', dir: 'desc', sort2: null, dir2: 'asc'
      }, 400, 0)
      /*
        Any row with a free copy will do now, whichever source it has: a card
        sleeved in a deck became stageable, so restricting this to
        collection_items skipped the whole section on a collection made up of
        deck-derived rows — which is exactly what this fixture is.
      */
      const own = page.rows
      const free = own.find((r) => r.available > 0)
      if (!free) {
        return JSON.stringify({
          error: own.length
            ? 'all ' + own.length + ' row(s) already reserved'
            : 'no rows at all'
        })
      }
      const title = free.printing.printed_name ?? free.printing.name
      const box = [...document.querySelectorAll('button[aria-label]')].find(
        (b) => b.getAttribute('aria-label') === 'Select ' + title
      )
      box?.click()
      return JSON.stringify({
        card: title,
        available: free.available,
        clicked: !!box
      })
    })()`)
  )
  // Staging needs a real `collection_items` row: deck-derived rows are not
  // selectable by design. With none — an empty collection, or every copy already
  // reserved — this section has nothing to exercise and says so instead of
  // failing four checks and then crashing the whole run on a null panel.
  const canStage = selected.clicked === true
  if (!canStage) {
    console.log(`        → skipped: ${selected.error ?? 'no selectable row with a free copy'}`)
  } else {
    console.log(`        → selected ${JSON.stringify(selected.card)} (${selected.available} free)`)
  }

  if (canStage) {
    await wait(700)
    const opened = await evaluate(`(() => {
      const pane = [...document.querySelectorAll('main > div')].find(
        (p) => !p.classList.contains('hidden')
      )
      const b = [...pane.querySelectorAll('button')].find((x) =>
        /Add to pick list/.test((x.textContent || '').trim())
      )
      b?.click()
      return !!b
    })()`)
    await wait(900)

    const menu = JSON.parse(
      await evaluate(`(() => {
        // A dialog now, not a popover: the destination used to be a dropdown in the
        // header beside a separate chooser button, which is two controls for one
        // decision. Both questions moved into the dialog the action opens.
        const panel = document.querySelector('[role="dialog"]')
        if (!panel) return JSON.stringify({ height: 0, options: [], checkbox: false })
        return JSON.stringify({
          height: Math.round(panel.getBoundingClientRect().height),
          options: [...panel.querySelectorAll('label')].map((l) => (l.textContent || '').trim()),
          checkbox: !!panel.querySelector('[data-field="alsoRemove"]')
        })
      })()`)
    )
    check('the dialog opens', opened === true && menu.options.length > 0, JSON.stringify(menu))
    check(
      'it lists the open lists and offers a new one',
      menu.options.some((o) => o.startsWith('Check older')) &&
        menu.options.some((o) => o.startsWith('Check newer')) &&
        menu.options.some((o) => o.includes('New list')),
      JSON.stringify(menu.options)
    )
    check(
      'and it is on screen rather than clipped by the animating bulk bar',
      // The bar is a motion.div with overflow-hidden, so anything in-tree would be
      // cut to nothing. A Modal is portalled and centred; this asserts it rendered
      // at a real size and above the bar.
      menu.height > 60,
      `${menu.height}px`
    )

    // Pick the OLDER list — the one the previous behaviour would never have used —
    // and confirm, which is now a separate step from choosing.
    const staged = JSON.parse(
      await evaluate(`(async () => {
        const panel = document.querySelector('[role="dialog"]')
        const label = [...panel.querySelectorAll('label')].find((l) =>
          (l.textContent || '').startsWith('Check older')
        )
        const radio = label && label.querySelector('input[type="radio"]')
        if (!radio) return JSON.stringify({ error: 'older list not offered' })
        radio.click()
        const confirm = panel.querySelector('[data-action="confirmAddToList"]')
        if (!confirm) return JSON.stringify({ error: 'no confirm button' })
        confirm.click()
        await new Promise((r) => setTimeout(r, 1400))
        const older = await window.api.pickLists.items(${madeLists.older})
        const newer = await window.api.pickLists.items(${madeLists.newer})
        return JSON.stringify({
          older: older.length,
          newer: newer.length,
          // Unticked by default, so the copies should be kept.
          destination: older[0] ? older[0].destination : null
        })
      })()`)
    )
    check(
      'the cards land in the list that was chosen',
      staged.older > 0,
      JSON.stringify(staged)
    )
    check(
      'and not in the most recently created one',
      // Exactly the bug this control was built for: the old code called
      // ensureDefaultPickList() and always took the newest open list, whatever the
      // caller asked for. Both conditions together, so this cannot pass by nothing
      // having been staged at all.
      staged.older > 0 && staged.newer === 0,
      JSON.stringify(staged)
    )

    // Tidy up: cancel both, releasing the reservations.
    await evaluate(`(async () => {
      await window.api.pickLists.cancel(${madeLists.older})
      await window.api.pickLists.cancel(${madeLists.newer})
      return 'cancelled'
    })()`)

    section('Proxied cards')
    await setLocale('en')
    await goto('collection')

    // Set it through the same IPC the bulk bar calls, then reload — a direct IPC
    // call writes the database but not the renderer store, so the rows on screen
    // would otherwise still be the pre-change ones.
    const FILTERS = `{
      search: '', langs: [], rarities: [], sets: [], finishes: [], treatments: [],
      proxied: null, conditions: [], colors: [], typeLine: '', cmcMin: null, cmcMax: null,
      valueMin: null, valueMax: null, deckScope: null, source: 'collection',
      onlyReserved: false, sort: 'added_at', dir: 'desc', sort2: null, dir2: 'asc'
    }`
    const money = JSON.parse(
      await evaluate(`(async () => {
        const before = await window.api.collection.query(${FILTERS}, 500, 0)
        const target = before.rows.find((r) => r.unit_value && r.unit_value > 0)
        if (!target) return JSON.stringify({ skip: 'no priced row to flag' })
        await window.api.collection.update(target.id, { proxied: 1 })
        const after = await window.api.collection.query(${FILTERS}, 500, 0)
        const mine = after.rows.find((r) => r.id === target.id)
        return JSON.stringify({
          id: target.id,
          card: target.printing.name,
          unitBefore: target.unit_value,
          unitAfter: mine.unit_value,
          totalAfter: mine.total_value,
          collectionBefore: before.totalValue,
          collectionAfter: after.totalValue,
          proxied: mine.proxied
        })
      })()`)
    )

    if (money.skip) {
      console.log(`        → skipped: ${money.skip}`)
    } else {
      console.log(
        `        → flagged ${JSON.stringify(money.card)}: unit ${money.unitAfter}, ` +
          `total ${money.totalAfter}, collection ${money.collectionBefore} → ${money.collectionAfter}`
      )
      check('the flag sticks', money.proxied === true, JSON.stringify(money))
      check(
        'a proxy keeps its real market price as a reference',
        money.unitAfter === money.unitBefore,
        JSON.stringify({ before: money.unitBefore, after: money.unitAfter })
      )
      check('but is worth nothing on the row', money.totalAfter === 0, `${money.totalAfter}`)
      check(
        'and comes out of the collection total exactly',
        Math.abs(money.collectionBefore - money.collectionAfter - money.unitBefore) < 0.005,
        JSON.stringify(money)
      )

      // The chip has to be visible in both view modes, or the flag is invisible in
      // whichever one you happen to use.
      await setLocale('en')
      await goto('collection')
      for (const mode of ['Table view', 'Gallery view']) {
        await evaluate(`(() => {
          document.querySelector('[aria-label="${mode}"]')?.click()
          return 1
        })()`)
        await wait(1300)
        const chips = JSON.parse(
          await evaluate(`(() => {
            const pane = [...document.querySelectorAll('main > div')].find(
              (p) => !p.classList.contains('hidden')
            )
            const found = [...pane.querySelectorAll('span')].filter(
              (sp) => (sp.textContent || '').trim() === 'Proxy'
            )
            return JSON.stringify({ chips: found.length })
          })()`)
        )
        check(`the chip shows in ${mode.toLowerCase()}`, chips.chips > 0, JSON.stringify(chips))
      }

      await evaluate(`window.api.collection.update(${money.id}, { proxied: 0 })`)
    }
  }

  section('Card artwork: closer look and copy')
  await setLocale('en')
  await goto('collection')
  await evaluate(`(() => {
    document.querySelector('[aria-label="Gallery view"]')?.click()
    return 1
  })()`)
  await wait(1400)

  const openedCard = await evaluate(`(() => {
    const pane = [...document.querySelectorAll('main > div')].find(
      (p) => !p.classList.contains('hidden')
    )
    // A tile, not a header button: match the ones that actually contain artwork.
    const tile = [...pane.querySelectorAll('button[title]')].find((b) =>
      b.querySelector('img[src^="matomeru://image/"]')
    )
    tile?.click()
    return tile ? tile.getAttribute('title') : null
  })()`)
  await wait(1600)
  check('a card detail opens from a tile', !!openedCard, String(openedCard))

  const clicked = await evaluate(`(() => {
    const dlg = document.querySelector('[role="dialog"]')
    const art = [...(dlg?.querySelectorAll('button') ?? [])].find(
      (b) => (b.getAttribute('title') || '') === 'Click for a closer look'
    )
    art?.click()
    return !!art
  })()`)
  check('the artwork itself is the control', clicked === true)
  await wait(1000)

  const overlay = JSON.parse(
    await evaluate(`(() => {
      const found = [...document.querySelectorAll('div')].filter((d) => {
        const cs = getComputedStyle(d)
        return cs.position === 'fixed' && Number(cs.zIndex) === 55
      })
      const o = found[0]
      if (!o) return JSON.stringify({ overlay: false })
      const img = o.querySelector('img')
      return JSON.stringify({
        overlay: true,
        imgW: img?.naturalWidth ?? 0,
        imgH: img?.naturalHeight ?? 0,
        buttons: [...o.querySelectorAll('button')].map((b) =>
          (b.getAttribute('title') || '').trim()
        )
      })
    })()`)
  )
  check('a closer look opens above the dialog', overlay.overlay === true, JSON.stringify(overlay))
  check(
    'and shows the large artwork, not the tile-sized one',
    overlay.imgW === 672 && overlay.imgH === 936,
    `${overlay.imgW}x${overlay.imgH}`
  )
  check(
    'with exactly copy and close — no size control to press',
    overlay.buttons.filter(Boolean).sort().join('|') === 'Close|Copy image',
    JSON.stringify(overlay.buttons)
  )

  // Both sizing branches, by emulating the viewport rather than trusting whatever
  // this machine happens to show. The card is 936px tall; the default window is
  // 900, so the scaled-down branch is the common one.
  const sizeAt = async (height) => {
    await call('Emulation.setDeviceMetricsOverride', {
      width: 1440,
      height,
      deviceScaleFactor: 1,
      mobile: false
    })
    await wait(900)
    return JSON.parse(
      await evaluate(`(() => {
        const found = [...document.querySelectorAll('div')].filter((d) => {
          const cs = getComputedStyle(d)
          return cs.position === 'fixed' && Number(cs.zIndex) === 55
        })
        const img = found[0]?.querySelector('img')
        if (!img) return JSON.stringify({ w: 0, h: 0 })
        const r = img.getBoundingClientRect()
        return JSON.stringify({ w: Math.round(r.width), h: Math.round(r.height) })
      })()`)
    )
  }

  const tall = await sizeAt(1200)
  check(
    'a window with room shows the artwork at actual size',
    tall.h === 936 && tall.w === 672,
    JSON.stringify(tall)
  )
  const short = await sizeAt(700)
  check(
    'and a shorter window scales it down instead of cropping or overflowing',
    short.h > 0 && short.h < 936 && short.h <= 700,
    JSON.stringify(short)
  )
  check(
    'keeping the card proportions while it does',
    // 488/680 is the card aspect; allow a pixel of rounding either way.
    Math.abs(short.w / short.h - 488 / 680) < 0.01,
    JSON.stringify({ ...short, ratio: (short.w / short.h).toFixed(4) })
  )
  await call('Emulation.clearDeviceMetricsOverride', {})
  await wait(600)

  const copied = await evaluate(`(async () => {
    const found = [...document.querySelectorAll('div')].filter((d) => {
      const cs = getComputedStyle(d)
      return cs.position === 'fixed' && Number(cs.zIndex) === 55
    })
    const b = [...found[0].querySelectorAll('button')].find(
      (x) => (x.getAttribute('title') || '') === 'Copy image'
    )
    b?.click()
    await new Promise((r) => setTimeout(r, 1200))
    return found[0].textContent.includes('Copied')
  })()`)
  // The clipboard itself was confirmed from outside the app — a 672x936 image via
  // System.Windows.Forms.Clipboard — which is not reachable from in here, so this
  // asserts the round trip reported success.
  check('copying the image reports success', copied === true, String(copied))

  // Escape must close the closer look without closing the dialog under it.
  await call('Input.dispatchKeyEvent', {
    type: 'keyDown',
    key: 'Escape',
    windowsVirtualKeyCode: 27,
    nativeVirtualKeyCode: 27
  })
  await wait(900)
  const layers = JSON.parse(
    await evaluate(`(() => {
      const zoom = [...document.querySelectorAll('div')].some((d) => {
        const cs = getComputedStyle(d)
        return cs.position === 'fixed' && Number(cs.zIndex) === 55
      })
      return JSON.stringify({ zoom, dialog: !!document.querySelector('[role="dialog"]') })
    })()`)
  )
  check(
    'Escape closes the closer look but leaves the dialog open',
    layers.zoom === false && layers.dialog === true,
    JSON.stringify(layers)
  )
  await call('Input.dispatchKeyEvent', {
    type: 'keyDown',
    key: 'Escape',
    windowsVirtualKeyCode: 27,
    nativeVirtualKeyCode: 27
  })
  await wait(700)

  section('Nothing still carries the old name')
  /*
    The rename swept the app's name and missed a bare letter: the sidebar mark was
    a hardcoded "B", invisible to anything matching "BulkOS" or "bulkos". So check
    the mark by what it shows, and sweep every screen for the old name rather than
    trusting a grep over the source.
  */
  await setLocale('en')
  const mark = JSON.parse(
    await evaluate(`(() => {
      const aside = document.querySelector('aside')
      const badge = aside?.querySelector('div.bg-gold-500')
      const words = [...(aside?.querySelectorAll('p') ?? [])].map((p) => p.textContent.trim())
      return JSON.stringify({ mark: (badge?.textContent ?? '').trim(), words: words.slice(0, 2) })
    })()`)
  )
  console.log(`        → mark ${JSON.stringify(mark.mark)}, wordmark ${JSON.stringify(mark.words[0])}`)
  check('the sidebar mark is the app glyph', mark.mark === 'ま', JSON.stringify(mark))
  check(
    'not a leftover Latin initial',
    // The exact shape of the bug: a single A-Z character sitting where the brand
    // mark goes, which no name-based rename would ever touch.
    !/^[A-Za-z]$/.test(mark.mark),
    JSON.stringify(mark)
  )
  check('and the wordmark is the app name', mark.words[0] === 'Matomeru', JSON.stringify(mark.words))

  for (const view of VIEWS) {
    await goto(view)
    const stale = await evaluate(`(() => {
      const text = document.body.innerText
      return /bulkos/i.test(text) ? text.match(/.{0,24}bulkos.{0,24}/i)[0] : ''
    })()`)
    check(`${view}: no trace of the old name`, stale === '', String(stale))
  }

  section('A sleeved card reaches a list through the UI')

  /*
    Driven through the screen, not the IPC.

    The API-level check below passes and has always passed, while this path was
    broken the whole time: the staging function filtered the selection on
    `available > 0`, which is 0 for a sleeved card by design, so every deck row was
    dropped and confirming reported "nothing to pick".

    The API is still the right tool for asserting the *outcome* — what landed in the
    database — but something has to press the button, or a check like this one is
    only testing itself.
  */
  await goto('collection')
  /*
    Switched by hook, and the switch is asserted.

    This used to look for [aria-label="Table view"], which matches nothing whenever
    the app is in French -- so the click was a silent no-op and the check went on to
    hunt for a table control in gallery mode. It only ever worked because an earlier
    check happened to leave the locale in English.
  */
  const inTable = await evaluate(`(() => {
    const table = document.querySelector('[data-view="table"]')
    table?.click()
    return !!table
  })()`)
  check('the collection can be switched to table view at all', inTable === true, String(inTable))
  await wait(900)

  const uiStage = JSON.parse(
    await evaluate(`(async () => {
      // Setup through the API: which card is sleeved, and a list to put it on.
      const filters = {
        search: '', langs: [], rarities: [], sets: [], finishes: [], treatments: [],
        conditions: [], colors: [], typeLine: '', cmcMin: null, cmcMax: null,
        valueMin: null, valueMax: null, deckScope: null, source: 'deck',
        onlyReserved: false, sort: 'added_at', dir: 'desc', sort2: null, dir2: 'asc'
      }
      const rows = await window.api.collection.query(filters, 400, 0)
      const sleeved = rows.rows.filter((r) => r.quantity > 0)
      if (!sleeved.length) return JSON.stringify({ error: 'no sleeved card in this profile' })
      const list = await window.api.pickLists.create('UI stage probe')

      /*
        Selected through the header box rather than by hunting for one card's row.
        The list is virtualized, so a named row is usually not in the DOM at all —
        the first attempt at this looked one up and reported "no selectable row",
        which is the probe failing to reach the screen rather than the screen being
        wrong. Select-all takes whatever is rendered, and this fixture is almost
        entirely sleeved cards.
      */
      const header = document.querySelector('input[type="checkbox"]')
      if (!header) return JSON.stringify({ error: 'no select-all box' })
      header.click()
      await new Promise((r) => setTimeout(r, 600))

      const open = document.querySelector('[data-action="addToList"]')
      if (!open) return JSON.stringify({ error: 'no add-to-list button appeared' })
      open.click()
      await new Promise((r) => setTimeout(r, 700))

      const dialog = document.querySelector('[role="dialog"]')
      if (!dialog) return JSON.stringify({ error: 'the dialog did not open' })
      const hasCheckbox = !!dialog.querySelector('[data-field="alsoRemove"]')
      const pick = [...dialog.querySelectorAll('label')].find((l) =>
        (l.textContent || '').includes('UI stage probe')
      )
      const radio = pick && pick.querySelector('input[type="radio"]')
      if (!radio) return JSON.stringify({ error: 'the new list was not offered' })
      radio.click()
      dialog.querySelector('[data-action="confirmAddToList"]').click()
      await new Promise((r) => setTimeout(r, 1600))

      const items = await window.api.pickLists.items(list)
      await window.api.pickLists.cancel(list)
      await window.api.pickLists.remove(list)
      // Drop the selection again. A check that leaves global UI state behind is a
      // check that breaks a later one: this selection kept the Collection bulk bar
      // mounted, and the deck-screen control count then saw two of them.
      if (header.checked) header.click()
      return JSON.stringify({
        hasCheckbox,
        items: items.length,
        // Non-null means the row came from a deck, which is the point.
        fromDecks: items.filter((i) => i.destination !== null).length,
        destinations: [...new Set(items.map((i) => i.destination))]
      })
    })()`)
  )

  if (uiStage.error) {
    console.log(`        → skipped: ${uiStage.error}`)
  } else {
    console.log(`        → ${JSON.stringify(uiStage)}`)
    check(
      'the dialog offers the destination for a sleeved selection',
      uiStage.hasCheckbox === true,
      JSON.stringify(uiStage)
    )
    check(
      'and confirming actually stages something',
      uiStage.items > 0,
      `${uiStage.items} item(s) landed`
    )
    check(
      'including the sleeved cards, which is what was broken',
      uiStage.fromDecks > 0,
      `${uiStage.fromDecks} of ${uiStage.items} came from a deck`
    )
    check(
      'and they keep the copies by default',
      uiStage.destinations.includes('collection') && !uiStage.destinations.includes('gone'),
      JSON.stringify(uiStage.destinations)
    )
  }

  section('What a pull does with the copies')

  /*
    The checkbox is the whole reason the dialog exists, so its two jobs are checked
    separately: appearing only when there is a decision to make, and actually
    sending the answer. Asserted on the staged row in the database rather than on
    the UI — a checkbox that looks right and sends the wrong thing is precisely the
    bug worth catching.
  */
  const destinationDialog = JSON.parse(
    await evaluate(`(async () => {
      const filters = {
        search: '', langs: [], rarities: [], sets: [], finishes: [], treatments: [],
        conditions: [], colors: [], typeLine: '', cmcMin: null, cmcMax: null,
        valueMin: null, valueMax: null, deckScope: null, source: 'deck',
        onlyReserved: false, sort: 'added_at', dir: 'desc', sort2: null, dir2: 'asc'
      }
      const rows = await window.api.collection.query(filters, 400, 0)
      const sleeved = rows.rows.find((r) => r.quantity > 0)
      if (!sleeved) return JSON.stringify({ error: 'no sleeved card in this profile' })
      const sources = await window.api.decks.pullSources(sleeved.scryfall_id, sleeved.finish)
      if (!sources.length) return JSON.stringify({ error: 'no deck can give it up' })
      const source = {
        kind: 'deck',
        deckId: sources[0].deck_id,
        oracleId: sources[0].oracle_id
      }

      // Left alone: the copies are kept, which is what the default is for.
      const kept = await window.api.pickLists.create('Kept probe')
      await window.api.pickLists.add(kept, { ...source, destination: 'collection' }, 1)
      const keptItems = await window.api.pickLists.items(kept)

      /*
        The first list is cancelled before the second is staged. Staging reserves,
        so leaving it open meant the only free copy was already claimed and the
        second add was correctly capped to nothing — which read as the destination
        being wrong when it was the probe not releasing the reservation.
      */
      await window.api.pickLists.cancel(kept)

      // Ticked: the copies leave your possession.
      const gone = await window.api.pickLists.create('Gone probe')
      await window.api.pickLists.add(gone, { ...source, destination: 'gone' }, 1)
      const goneItems = await window.api.pickLists.items(gone)

      await window.api.pickLists.cancel(gone)
      await window.api.pickLists.remove(kept)
      await window.api.pickLists.remove(gone)
      return JSON.stringify({
        kept: keptItems[0] ? keptItems[0].destination : null,
        gone: goneItems[0] ? goneItems[0].destination : null
      })
    })()`)
  )

  if (destinationDialog.error) {
    console.log(`        → skipped: ${destinationDialog.error}`)
  } else {
    check(
      'leaving the box unticked keeps the copies',
      destinationDialog.kept === 'collection',
      `destination ${destinationDialog.kept}`
    )
    check(
      'and ticking it sends them out of the collection',
      destinationDialog.gone === 'gone',
      `destination ${destinationDialog.gone}`
    )
  }

  /*
    Where the checkbox appears. On the Decks screen everything selectable is a deck
    card, so the question always has two answers; in the Collection it only does
    when a sleeved row is selected, and offering it otherwise would be offering a
    decision that does not exist.
  */
  await goto('decks')
  await wait(900)
  const deckSide = await evaluate(`(async () => {
    /*
      Ctrl+click, which is how the app selects a deck card — the tile's checkbox
      only exists on hover and the row has none at all, so clicking checkboxes
      selected nothing and the whole case reported "no button" instead of failing
      honestly.
    */
    const card = document.querySelector('[data-deck-card]')
      ?? [...document.querySelectorAll('div[role="button"], button')].find((el) =>
        el.querySelector('img')
      )
    if (!card) return 'no deck card on screen'
    card.dispatchEvent(new MouseEvent('click', { bubbles: true, ctrlKey: true }))
    await new Promise((r) => setTimeout(r, 600))
    const open = document.querySelector('[data-action="addToList"]')
    if (!open) return 'no add-to-list button on the deck screen'
    open.click()
    await new Promise((r) => setTimeout(r, 600))
    const has = !!document.querySelector('[data-field="alsoRemove"]')
    /*
      Visible ones only. Visited views stay mounted behind a hidden attribute so
      their scroll position survives, so the Collection pane's own bar is still in
      the document while the deck screen is showing -- counting nodes reported two
      controls for one on-screen control. offsetParent is null under display:none,
      which is also exactly why the hidden one cannot be clicked.
      (No backticks in here: this comment lives inside a template literal.)
    */
    const controls = [...document.querySelectorAll('[data-action="addToList"]')].filter(
      (el) => el.offsetParent !== null
    ).length
    document.querySelector('[role="dialog"] button')?.click()
    return JSON.stringify({ has, controls })
  })()`)
  if (typeof deckSide === 'string' && deckSide.startsWith('no ')) {
    console.log(`        → skipped: ${deckSide}`)
  } else {
    const parsed = JSON.parse(deckSide)
    check(
      'the deck screen offers the choice, since every card there is in a deck',
      parsed.has === true,
      deckSide
    )
    check(
      'and the header carries one pull control, not a button plus a dropdown',
      parsed.controls === 1,
      `${parsed.controls} control(s)`
    )
  }

  section('Cards move between decks and the collection')

  /*
    The stepper's ceiling.

    Reserved copies are promised to leaving your possession, so moveToDeck refuses
    them; a dialog capped at the row's quantity therefore offered an amount that
    could only fail, and the failure arrived as "nothing could be moved" with no
    reason given. Driven through the screen because the cap lives in the component:
    reserve one copy of a two-copy row, then hold the plus button down and see where
    it stops. One, not two.
  */
  await goto('collection')
  // The select-all box is a table-view control; in grid mode there is no header row
  // to hold it, and looking for one there reported "no select-all box".
  await evaluate(`(() => {
    document.querySelector('[data-view="table"]')?.click()
    return true
  })()`)
  await wait(900)

  const cap = JSON.parse(
    await evaluate(`(async () => {
      /*
        Scoped to the pane on screen. Visited views stay mounted behind a hidden
        attribute, so a bare document query hands back whichever pane was visited
        first -- the Decks search box while the Collection is showing -- which is how
        this check first reported "no move control" for a control that was there.
      */
      const pane = [...document.querySelectorAll('main > div')].find(
        (el) => el.offsetParent !== null
      ) || document
      const setValue = (el, value) => {
        Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')
          .set.call(el, value)
        el.dispatchEvent(new Event('input', { bubbles: true }))
      }

      const filters = {
        search: '', langs: [], rarities: [], sets: [], finishes: [], treatments: [],
        conditions: [], colors: [], typeLine: '', cmcMin: null, cmcMax: null,
        valueMin: null, valueMax: null, deckScope: null, source: 'collection',
        onlyReserved: false, sort: 'added_at', dir: 'desc', sort2: null, dir2: 'asc'
      }
      /*
        Built rather than looked for, and built on a name that brings back exactly
        one row.

        A real profile need not hold two unreserved copies of anything, so the copy
        is added here and taken away at the end. The uniqueness matters just as
        much: the cap is the smallest amount any selected row can part with, so a
        second row for the same name -- another finish, another condition, or the
        deck-derived row -- drags that minimum down to its own and hides the
        difference between capping on what is held and capping on what is free.
        Searching on a name that other names contain does the same thing.
      */
      const everything = await window.api.collection.query(
        { ...filters, source: null }, 800, 0
      )
      const nameOf = (r) => r.printing.name
      const names = everything.rows.map(nameOf)
      const base = everything.rows.find(
        (r) =>
          r.reserved === 0 &&
          r.id !== null &&
          r.source === 'collection' &&
          names.filter((n) => n === nameOf(r)).length === 1 &&
          names.filter((n) => n.includes(nameOf(r))).length === 1
      )
      if (!base) return JSON.stringify({ error: 'no card in this profile sits on a row of its own' })

      let list = null
      let grown = false
      let search = null
      let header = null
      try {
        if (base.quantity < 2) {
          await window.api.collection.setQuantity(base.id, 2)
          grown = true
        }
        const held = grown ? 2 : base.quantity

        // Reserve exactly one copy, so what can move is one less than what is held.
        list = await window.api.pickLists.create('Cap probe')
        await window.api.pickLists.add(list, { kind: 'collection', itemId: base.id }, 1)
        await new Promise((r) => setTimeout(r, 500))

        // Narrow to this one card, so select-all selects only it.
        /*
          The search field by hook. Guessing at input[placeholder] picked up
          whichever filter input came first, so the card name went into the wrong
          box, the table filtered down to nothing, and its header -- with the
          select-all box in it -- stopped being rendered at all.
        */
        search = pane.querySelector('[data-search]')
        if (!search) return JSON.stringify({ broken: 'no search box' })
        setValue(search, base.printing.name)
        // The field is debounced, so the query lands a beat after the keystroke.
        await new Promise((r) => setTimeout(r, 1600))

        header = pane.querySelector('input[type="checkbox"]')
        if (!header) return JSON.stringify({ broken: 'no select-all box after filtering to ' + base.printing.name })
        if (!header.checked) header.click()
        await new Promise((r) => setTimeout(r, 500))

        const move = pane.querySelector('[data-action="moveToDeck"]')
        if (!move) return JSON.stringify({ broken: 'no move control' })
        move.click()
        await new Promise((r) => setTimeout(r, 800))

        const field = document.querySelector('[data-field="moveHowMany"]')
        if (!field) return JSON.stringify({ broken: 'the move dialog did not open' })
        // Hold the plus down and see where it stops.
        const up = field.querySelector('[data-step="up"]')
        for (let i = 0; i < 6; i++) {
          if (!up.disabled) up.click()
          await new Promise((r) => setTimeout(r, 90))
        }
        const ceiling = Number(field.querySelector('[data-step="value"]').value)
        return JSON.stringify({ card: base.printing.name, held, ceiling })
      } finally {
        /*
          In a finally, because the returns above are all early exits and one of
          them leaving a bumped quantity behind is not a local mess: it moved the
          collection total, and the value checks further down failed on it.
        */
        document.querySelector('[role="dialog"] button')?.click()
        await new Promise((r) => setTimeout(r, 400))
        if (header && header.checked) header.click()
        if (search) setValue(search, '')
        if (list !== null) {
          await window.api.pickLists.cancel(list).catch(() => {})
          await window.api.pickLists.remove(list).catch(() => {})
        }
        if (grown) await window.api.collection.setQuantity(base.id, base.quantity)
        await new Promise((r) => setTimeout(r, 400))
      }
    })()`)
  )

  if (cap.broken) {
    /*
      A skip has to mean "this profile has nothing to test with", never "the screen
      did not answer". Both were printed the same way, and the first two attempts at
      this check skipped on a broken selector while reporting a clean run.
    */
    check('the move dialog stops at the copies that are free, not at the copies held',
      false, cap.broken)
  } else if (cap.error) {
    console.log(`        → skipped: ${cap.error}`)
  } else {
    console.log(`        → ${JSON.stringify(cap)}`)
    check(
      'the move dialog stops at the copies that are free, not at the copies held',
      cap.ceiling === cap.held - 1,
      `held ${cap.held}, one reserved, stepper reached ${cap.ceiling}`
    )
  }

  /*
    The direct route, which is what taking a card out of a deck actually is: it
    moves, it does not leave. Asserted on the database either side rather than on
    the screen, because a toast can appear without anything having happened — and
    the property that matters is that nothing is created or destroyed.
  */
  const moveCycle = JSON.parse(
    await evaluate(`(async () => {
      const filters = {
        search: '', langs: [], rarities: [], sets: [], finishes: [], treatments: [],
        conditions: [], colors: [], typeLine: '', cmcMin: null, cmcMax: null,
        valueMin: null, valueMax: null, deckScope: null, source: null,
        onlyReserved: false, sort: 'added_at', dir: 'desc', sort2: null, dir2: 'asc'
      }
      const totals = async () => {
        const page = await window.api.collection.query(filters, 1, 0)
        return { cards: page.totalQuantity, value: page.totalValue }
      }
      const deckRows = await window.api.collection.query(
        { ...filters, source: 'deck' }, 400, 0
      )
      const sleeved = deckRows.rows.find((r) => r.quantity > 0)
      if (!sleeved) return JSON.stringify({ error: 'no sleeved card in this profile' })
      const sources = await window.api.decks.pullSources(sleeved.scryfall_id, sleeved.finish)
      if (!sources.length) return JSON.stringify({ error: 'no deck can give that card up' })

      const before = await totals()
      const out = await window.api.decks.moveToCollection(
        sources[0].deck_id, sources[0].oracle_id, 1
      )
      const after = await totals()

      // The badge reads from the breakdown, so check the ledger reached it.
      const breakdown = await window.api.decks.breakdown(sources[0].deck_id)
      const cards = (breakdown?.groups ?? []).flatMap((g) => g.cards)
      const entry = cards.find((c) => c.oracle_id === sources[0].oracle_id)

      return JSON.stringify({
        name: sleeved.printing.printed_name ?? sleeved.printing.name,
        moved: out.moved,
        beforeCards: before.cards,
        afterCards: after.cards,
        valueDrift: Math.abs((after.value ?? 0) - (before.value ?? 0)),
        moved_field: entry ? entry.moved : null,
        moveCount: entry ? entry.moves.length : 0,
        moveId: entry && entry.moves[0] ? entry.moves[0].id : null
      })
    })()`)
  )

  if (moveCycle.error) {
    console.log(`        → skipped: ${moveCycle.error}`)
  } else {
    console.log(`        → ${JSON.stringify(moveCycle)}`)
    check('a card can be moved out of a deck', moveCycle.moved === 1, JSON.stringify(moveCycle))
    check(
      'and nothing is created or destroyed by it',
      moveCycle.afterCards === moveCycle.beforeCards && moveCycle.valueDrift < 0.005,
      `${moveCycle.beforeCards} -> ${moveCycle.afterCards}, value drift ${moveCycle.valueDrift}`
    )
    check(
      'the deck entry reports the divergence, so the badge has something to show',
      moveCycle.moved_field === -1 && moveCycle.moveCount === 1,
      `moved ${moveCycle.moved_field}, ${moveCycle.moveCount} move(s)`
    )

    // And back, which is what the badge offers.
    const undone = JSON.parse(
      await evaluate(`(async () => {
        const back = await window.api.decks.revertMove(${moveCycle.moveId})
        const page = await window.api.collection.query({
          search: '', langs: [], rarities: [], sets: [], finishes: [], treatments: [],
          conditions: [], colors: [], typeLine: '', cmcMin: null, cmcMax: null,
          valueMin: null, valueMax: null, deckScope: null, source: null,
          onlyReserved: false, sort: 'added_at', dir: 'desc', sort2: null, dir2: 'asc'
        }, 1, 0)
        return JSON.stringify({ quantity: back.quantity, cards: page.totalQuantity })
      })()`)
    )
    check(
      'undoing the move puts it back',
      undone.quantity === 1 && undone.cards === moveCycle.beforeCards,
      JSON.stringify(undone)
    )
  }

  /*
    A pick list can still hold a deck card, and now carries what to do with it.
    Both destinations are exercised: keeping the card is a move, selling it is not.
  */
  const destinations = JSON.parse(
    await evaluate(`(async () => {
      const filters = {
        search: '', langs: [], rarities: [], sets: [], finishes: [], treatments: [],
        conditions: [], colors: [], typeLine: '', cmcMin: null, cmcMax: null,
        valueMin: null, valueMax: null, deckScope: null, source: 'deck',
        onlyReserved: false, sort: 'added_at', dir: 'desc', sort2: null, dir2: 'asc'
      }
      const rows = await window.api.collection.query(filters, 400, 0)
      const sleeved = rows.rows.find((r) => r.quantity > 0)
      if (!sleeved) return JSON.stringify({ error: 'no sleeved card' })
      const sources = await window.api.decks.pullSources(sleeved.scryfall_id, sleeved.finish)
      if (!sources.length) return JSON.stringify({ error: 'no deck can give it up' })

      const list = await window.api.pickLists.create('Destination probe')
      const staged = await window.api.pickLists.add(
        list,
        {
          kind: 'deck',
          deckId: sources[0].deck_id,
          oracleId: sources[0].oracle_id,
          destination: 'gone'
        },
        1
      )
      const items = await window.api.pickLists.items(list)
      await window.api.pickLists.cancel(list)
      await window.api.pickLists.remove(list)
      return JSON.stringify({ added: staged ? staged.added : 0, items: items.length })
    })()`)
  )
  if (destinations.error) {
    console.log(`        → skipped: ${destinations.error}`)
  } else {
    check(
      'a deck card can be staged with a destination',
      destinations.added === 1 && destinations.items === 1,
      JSON.stringify(destinations)
    )
  }

  section('A validated pick list can be undone or cleared')

  /*
    It used to render no controls at all, just a line saying it was kept as
    history. Found by the action each button calls, not by its words: matching
    visible text is what made three theme checks pass against a French UI without
    testing anything.
  */
  const validatedId = await evaluate(`(async () => {
    const list = await window.api.pickLists.create('Validated probe')
    await window.api.pickLists.confirm(list)
    return list
  })()`)
  await goto('picks')
  await wait(900)
  const openedValidated = await evaluate(`(() => {
    // The sidebar lists every pick list; click the one just created, by name.
    const button = [...document.querySelectorAll('button')].find((b) =>
      b.textContent.includes('Validated probe')
    )
    button?.click()
    return !!button
  })()`)
  await wait(700)
  check('a validated list can be opened', openedValidated === true)
  const actions = await evaluate(`(() => ({
    revert: !!document.querySelector('[data-action="revertPull"]'),
    del: !!document.querySelector('[data-action="deleteList"]')
  }))()`)
  check(
    'it offers to put the cards back',
    actions.revert === true,
    JSON.stringify(actions)
  )
  check('and to delete itself, so validated lists cannot pile up forever', actions.del === true)
  await evaluate(`window.api.pickLists.remove(${validatedId})`)

  section('Ctrl+Z')

  /*
    Asserted on the database rather than on the screen: a toast could appear
    without anything having been rolled back. The action goes through the same IPC
    the UI uses, so the scope under test is the real one.
  */
  const undoCycle = JSON.parse(
    await evaluate(`(async () => {
      const lists = await window.api.pickLists.list()
      await window.api.pickLists.create('Undo probe')
      const after = await window.api.pickLists.list()
      const state = await window.api.undo.state()
      const step = await window.api.undo.undo()
      const rolled = await window.api.pickLists.list()
      return JSON.stringify({
        grew: after.length - lists.length,
        label: state.undoLabel,
        undone: step ? step.label : null,
        shrank: after.length - rolled.length
      })
    })()`)
  )
  console.log(`        → ${JSON.stringify(undoCycle)}`)
  check(
    'an action becomes undoable and is named',
    undoCycle.grew === 1 && typeof undoCycle.label === 'string' && undoCycle.label.length > 0,
    JSON.stringify(undoCycle)
  )
  check(
    'undo reports the action it took back',
    undoCycle.undone === undoCycle.label,
    `${undoCycle.undone} vs ${undoCycle.label}`
  )
  check(
    'and the row it created is gone again',
    undoCycle.shrank === 1,
    `${undoCycle.shrank} removed`
  )

  // Typing keeps its own undo: stealing Ctrl+Z inside a text field would roll
  // back a database write while you were fixing a typo in the search box.
  const inField = await evaluate(`(() => {
    const input = document.querySelector('input[type="text"], input:not([type])')
    if (!input) return 'no text field'
    input.focus()
    const event = new KeyboardEvent('keydown', {
      key: 'z', ctrlKey: true, bubbles: true, cancelable: true
    })
    input.dispatchEvent(event)
    return event.defaultPrevented ? 'intercepted' : 'left to the browser'
  })()`)
  check(
    'Ctrl+Z inside a text field is left to the browser',
    inField === 'left to the browser',
    String(inField)
  )

  section('The artwork can be seen from a list row')

  /*
    A list row is 36px tall, so its thumbnail is unreadable as art — this was the
    one place a card could not be looked at properly. The same closer look the
    detail dialog offers now opens from the row.
  */
  await goto('collection')
  // By hook, not by label: [aria-label="Table view"] matches nothing while the app
  // is in French, so this click was silently doing nothing whenever the locale had
  // been switched by an earlier check.
  await evaluate(`(() => {
    document.querySelector('[data-view="table"]')?.click()
    return true
  })()`)
  await wait(900)
  const rowZoom = JSON.parse(
    await evaluate(`(async () => {
      const trigger = [...document.querySelectorAll('button')].find(
        (b) => b.className.includes('cursor-zoom-in') && b.querySelector('img, div')
      )
      if (!trigger) return JSON.stringify({ error: 'no zoomable thumbnail in a row' })
      const cursor = getComputedStyle(trigger).cursor
      trigger.click()
      await new Promise((r) => setTimeout(r, 700))
      const overlay = document.querySelector('[aria-label], .fixed')
      const big = [...document.querySelectorAll('img')].filter(
        (i) => i.getBoundingClientRect().width > 200
      ).length
      // Escape closes it, as in the detail dialog.
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
      await new Promise((r) => setTimeout(r, 500))
      const stillBig = [...document.querySelectorAll('img')].filter(
        (i) => i.getBoundingClientRect().width > 200
      ).length
      return JSON.stringify({ cursor, big, stillBig, overlay: !!overlay })
    })()`)
  )
  if (rowZoom.error) {
    console.log(`        → skipped: ${rowZoom.error}`)
  } else {
    console.log(`        → ${JSON.stringify(rowZoom)}`)
    check(
      'the thumbnail offers the magnifier cursor',
      rowZoom.cursor === 'zoom-in',
      String(rowZoom.cursor)
    )
    check(
      'clicking it shows the artwork at a readable size',
      rowZoom.big > 0,
      `${rowZoom.big} large image(s)`
    )
    check('and Escape closes it again', rowZoom.stillBig === 0, `${rowZoom.stillBig} left`)
  }

  section('Cursors say what is clickable')
  // Settings first: it has real checkboxes and disabled controls. Views stay
  // mounted, so visiting once makes the measurement below deterministic instead
  // of dependent on whether the collection happens to have rows.
  await goto('settings')
  await wait(900)
  await goto('collection')
  await wait(900)
  // Tailwind v4's preflight declares no cursor at all, so before this every one of
  // the app's buttons hovered with the plain arrow.
  const cursors = JSON.parse(
    await evaluate(`(() => {
      const pane = [...document.querySelectorAll('main > div')].find(
        (p) => !p.classList.contains('hidden')
      )
      const of = (el) => (el ? getComputedStyle(el).cursor : 'missing')
      const buttons = [...pane.querySelectorAll('button')]
      // Across the document for these two: every visited view stays mounted, and
      // the gallery renders neither a disabled button nor a real checkbox, so
      // scoping to the visible pane made both checks pass on 'missing'.
      return JSON.stringify({
        button: of(buttons.find((b) => !b.disabled)),
        disabled: of([...document.querySelectorAll('button')].find((b) => b.disabled)),
        checkbox: of(document.querySelector('input[type="checkbox"]')),
        text: of(document.querySelector('input[type="text"], input:not([type])')),
        nav: of(document.querySelector('nav button'))
      })
    })()`)
  )
  console.log(`        → ${JSON.stringify(cursors)}`)
  check('buttons offer a pointer', cursors.button === 'pointer', cursors.button)
  check('the sidebar too', cursors.nav === 'pointer', cursors.nav)
  check('checkboxes as well', cursors.checkbox === 'pointer', cursors.checkbox)
  check(
    'a text field keeps its I-beam',
    // The label rule uses :has() precisely so it does not reach text inputs.
    cursors.text === 'text' || cursors.text === 'auto' || cursors.text === 'missing',
    cursors.text
  )
  if (cursors.disabled !== 'missing') {
    check('and a disabled control says so', cursors.disabled === 'not-allowed', cursors.disabled)
  }

  // The two that are not "pointer": the artwork and the backdrop behind it.
  await evaluate(`(() => {
    document.querySelector('[aria-label="Gallery view"]')?.click()
    return 1
  })()`)
  await wait(1300)
  await evaluate(`(() => {
    const pane = [...document.querySelectorAll('main > div')].find(
      (p) => !p.classList.contains('hidden')
    )
    const tile = [...pane.querySelectorAll('button[title]')].find((b) =>
      b.querySelector('img[src^="matomeru://image/"]')
    )
    tile?.click()
    return !!tile
  })()`)
  await wait(1600)
  const artCursor = await evaluate(`(() => {
    const dlg = document.querySelector('[role="dialog"]')
    const art = [...(dlg?.querySelectorAll('button') ?? [])].find(
      (b) => (b.getAttribute('title') || '') === 'Click for a closer look'
    )
    return art ? getComputedStyle(art).cursor : 'missing'
  })()`)
  check('the artwork offers the magnifier', artCursor === 'zoom-in', String(artCursor))

  await evaluate(`(() => {
    const dlg = document.querySelector('[role="dialog"]')
    const art = [...(dlg?.querySelectorAll('button') ?? [])].find(
      (b) => (b.getAttribute('title') || '') === 'Click for a closer look'
    )
    art?.click()
    return 1
  })()`)
  await wait(1000)
  const backdrop = JSON.parse(
    await evaluate(`(() => {
      const found = [...document.querySelectorAll('div')].filter((d) => {
        const cs = getComputedStyle(d)
        return cs.position === 'fixed' && Number(cs.zIndex) === 55
      })
      const o = found[0]
      const img = o?.querySelector('img')
      return JSON.stringify({
        backdrop: o ? getComputedStyle(o).cursor : 'missing',
        image: img ? getComputedStyle(img).cursor : 'missing'
      })
    })()`)
  )
  check(
    'the backdrop says clicking it closes',
    backdrop.backdrop === 'zoom-out',
    JSON.stringify(backdrop)
  )
  check(
    'and the artwork itself is not pretending to be a control',
    backdrop.image === 'default' || backdrop.image === 'auto',
    JSON.stringify(backdrop)
  )

  /*
    What is actually under the pointer beside the card — not what a property on
    the backdrop element says. Reading the element alone passed while a
    full-bleed wrapper covered it, swallowing every click outside the card and
    hiding this cursor. Probe a real point and then click it for real.
  */
  const beside = JSON.parse(
    await evaluate(`(() => {
      const found = [...document.querySelectorAll('div')].filter((d) => {
        const cs = getComputedStyle(d)
        return cs.position === 'fixed' && Number(cs.zIndex) === 55
      })
      const overlay = found[0]
      const img = overlay?.querySelector('img')
      if (!overlay || !img) return JSON.stringify({ error: 'no overlay' })
      const art = img.getBoundingClientRect()
      // Midway between the overlay's left edge and the card: empty space.
      const x = Math.round(art.left / 2)
      const y = Math.round(art.top + art.height / 2)
      const el = document.elementFromPoint(x, y)
      return JSON.stringify({
        x,
        y,
        cursorThere: el ? getComputedStyle(el).cursor : 'nothing',
        isOverlay: el === overlay
      })
    })()`)
  )
  check(
    'the empty space beside the card really is the backdrop',
    beside.isOverlay === true && beside.cursorThere === 'zoom-out',
    JSON.stringify(beside)
  )

  await call('Input.dispatchMouseEvent', {
    type: 'mousePressed',
    x: beside.x,
    y: beside.y,
    button: 'left',
    clickCount: 1
  })
  await call('Input.dispatchMouseEvent', {
    type: 'mouseReleased',
    x: beside.x,
    y: beside.y,
    button: 'left',
    clickCount: 1
  })
  await wait(900)
  const afterClick = JSON.parse(
    await evaluate(`(() => {
      const zoom = [...document.querySelectorAll('div')].some((d) => {
        const cs = getComputedStyle(d)
        return cs.position === 'fixed' && Number(cs.zIndex) === 55
      })
      return JSON.stringify({ zoom, dialog: !!document.querySelector('[role="dialog"]') })
    })()`)
  )
  check(
    'clicking outside the card closes the closer look',
    afterClick.zoom === false,
    JSON.stringify(afterClick)
  )
  check(
    'and leaves the card dialog open behind it',
    afterClick.dialog === true,
    JSON.stringify(afterClick)
  )
  // The overlay is already closed by the click above; this closes the dialog.
  await call('Input.dispatchKeyEvent', {
    type: 'keyDown',
    key: 'Escape',
    windowsVirtualKeyCode: 27,
    nativeVirtualKeyCode: 27
  })
  await wait(600)

  section('Set symbols in the filters')
  // The renderer never reaches Scryfall: the main process resolves each symbol
  // from its cached set list, downloads it once and serves it over matomeru://.
  // Checked through the <img> elements, because a CSP that allows img-src for the
  // scheme does not allow fetch() — an earlier version of this check "failed"
  // purely because it asked the wrong way.
  await setLocale('en')
  await goto('collection')
  await evaluate(`(() => {
    const b = [...document.querySelectorAll('button')].find((x) =>
      /^(Set|Édition)\d*$/.test((x.textContent || '').trim())
    )
    b?.click()
    return !!b
  })()`)
  await wait(1600)
  const icons = JSON.parse(
    await evaluate(`(() => {
      const imgs = [...document.querySelectorAll('img[src^="matomeru://seticon/"]')]
      return JSON.stringify({
        rendered: imgs.length,
        loaded: imgs.filter((i) => i.complete && i.naturalWidth > 0).length,
        sample: imgs.slice(0, 3).map((i) => i.getAttribute('src').split('/').pop())
      })
    })()`)
  )
  check('the set filter draws a symbol per option', icons.rendered > 0, JSON.stringify(icons))
  check(
    'and every one of them actually loads',
    icons.rendered > 0 && icons.loaded === icons.rendered,
    `${icons.loaded} of ${icons.rendered}`
  )
  console.log(`        → ${icons.rendered} symbols, e.g. ${icons.sample.join(', ')}`)
  await call('Input.dispatchKeyEvent', {
    type: 'keyDown',
    key: 'Escape',
    windowsVirtualKeyCode: 27,
    nativeVirtualKeyCode: 27
  })
  await wait(250)

  section('French: nothing English left on any screen')
  await setLocale('fr')
  const shownLocale = await evaluate(
    `(async () => (await window.api.settings.get()).locale)()`
  )
  check('the app is running in French', shownLocale === 'fr', String(shownLocale))

  // UI words that only exist in the English dictionary. Card names, set names
  // and the deliberately-untranslated jargon (foil, etched, Finish) are not
  // here — those are data or decisions, not leftovers.
  const NEEDLES = [
    'Collection value', 'Total cards', 'Distinct rows', 'Refresh prices',
    'Add to pick list', 'Validate pull', 'Cancel pull', 'Confirmed lists are kept',
    'Pick lists', 'New pick list', 'Nothing staged', 'No pick list selected',
    'Archidekt decks', 'Label meanings', 'Select a deck', 'Require the exact printing',
    'Search by name', 'Fast entry', 'Look up a card', 'Nothing logged yet',
    'By language', 'By rarity', 'Most valuable cards', 'Top sets by value',
    'Choose a file', 'Map the columns', 'How rows are matched', 'Export collection',
    'Where your data lives', 'Reduce motion', 'Sync now', 'Where it is',
    'Sort the collection', 'Table view', 'Gallery view', 'Row view', 'Grid view'
  ]
  const needleJson = JSON.stringify(NEEDLES)

  for (const view of VIEWS) {
    await goto(view)
    const leftovers = JSON.parse(
      await evaluate(`(() => {
        const text = document.body.innerText
        return JSON.stringify(${needleJson}.filter((n) => text.includes(n)))
      })()`)
    )
    check(`${view}: no English UI words`, leftovers.length === 0, leftovers.join(' | '))
  }

  // Confirm the sweep can actually fail, or it proves nothing: switch back to
  // English and the same words must reappear.
  await setLocale('en')
  await goto('stats')
  const englishBack = JSON.parse(
    await evaluate(`(() => {
      const text = document.body.innerText
      return JSON.stringify(${needleJson}.filter((n) => text.includes(n)))
    })()`)
  )
  check(
    'the sweep is real: those words come back in English',
    englishBack.length > 0,
    `found ${englishBack.length}`
  )
  console.log(`        → e.g. ${englishBack.slice(0, 3).join(', ')}`)

  section('Ctrl+S offers a backup')

  /*
    What can be driven without a Drive account, which is most of what matters here:
    that the shortcut opens the dialog at all, that an unconfigured app says so
    instead of offering a button that cannot work, and that the destructive half
    stays out of reach until it can be done safely.

    The save and restore logic itself — the refusals, the round trip, the safety
    copy — is driven in `npm run verify` against an in-memory remote, where a
    corrupt payload can be produced on purpose. Injecting a fake remote into the
    running app would mean a seam in shipped code whose only purpose is to be
    tested, and the guards it would cover are already covered there.
  */
  await goto('collection')
  await wait(500)

  const shortcut = JSON.parse(
    await evaluate(`(async () => {
      // Dispatched on the document, which is where App listens.
      const event = new KeyboardEvent('keydown', {
        key: 's', ctrlKey: true, bubbles: true, cancelable: true
      })
      document.dispatchEvent(event)
      await new Promise((r) => setTimeout(r, 900))
      const dialog = document.querySelector('[data-dialog="backup"]')
      const status = await window.api.backup.status()
      return JSON.stringify({
        prevented: event.defaultPrevented,
        opened: !!dialog,
        bundled: status.bundled,
        canPickFolder: status.canPickFolder,
        // Which state it opened in. A profile with no credentials must land here.
        unavailable: !!document.querySelector('[data-field="unavailable"]'),
        settingsButton: !!document.querySelector('[data-action="backupOpenSettings"]'),
        confirm: !!document.querySelector('[data-action="confirmBackup"]')
      })
    })()`)
  )
  console.log(`        → ${JSON.stringify(shortcut)}`)
  check(
    'Ctrl+S opens the backup dialog',
    shortcut.opened === true,
    JSON.stringify(shortcut)
  )
  check(
    "and takes the keystroke, so Chromium's own save dialog never appears",
    shortcut.prevented === true,
    `prevented ${shortcut.prevented}`
  )
  /*
    Which state the dialog opens in depends on the build, so the assertion has to as
    well. A build with an OAuth client compiled in is configured before anyone touches
    it — that is the whole point of compiling one in — and would never show the
    "not set up" panel. Asserting the panel unconditionally would fail on exactly the
    build that ships.
  */
  if (shortcut.bundled) {
    check(
      'a build with its own client goes straight to the connect state',
      shortcut.unavailable === true && shortcut.settingsButton === true,
      JSON.stringify(shortcut)
    )
    console.log('        → a client is compiled into this build')
  } else {
    check(
      'with no credentials entered it explains that, instead of offering a dead button',
      shortcut.unavailable === true &&
        shortcut.settingsButton === true &&
        shortcut.confirm === false,
      JSON.stringify(shortcut)
    )
  }

  // Inside a text field the keystroke belongs to the field.
  const inBox = await evaluate(`(() => {
    document.querySelector('[role="dialog"] button')?.click()
    const input = document.querySelector('[data-search]')
    if (!input) return 'no search box'
    input.focus()
    const event = new KeyboardEvent('keydown', {
      key: 's', ctrlKey: true, bubbles: true, cancelable: true
    })
    input.dispatchEvent(event)
    return event.defaultPrevented ? 'intercepted' : 'left to the field'
  })()`)
  check(
    'Ctrl+S while typing is left alone',
    inBox === 'left to the field',
    String(inBox)
  )

  // The Settings panel: the credential fields exist, and the destructive action is
  // out of reach until there is something to restore from.
  await goto('settings')
  await wait(900)
  const panel = JSON.parse(
    await evaluate(`(async () => {
      const section = document.querySelector('[data-setting="backup"]')
      if (!section) return JSON.stringify({ missing: true })
      const status = await window.api.backup.status()
      const restore = section.querySelector('[data-action="backupRestore"]')
      const now = section.querySelector('[data-action="backupNow"]')
      const connect = section.querySelector('[data-action="backupConnect"]')
      const name = section.querySelector('[data-field="backupFolderName"]')
      return JSON.stringify({
        missing: false,
        bundled: status.bundled,
        folderName: status.folderName,
        // The credential fields are gone entirely, not merely hidden.
        credentialFields:
          section.querySelectorAll('[data-field="backupClientId"], ' +
            '[data-field="backupClientSecret"], [data-field="backupOwnClient"]').length,
        nameField: !!name,
        nameValue: name ? name.value : null,
        nameDisabled: name ? name.disabled : null,
        restoreDisabled: restore ? restore.disabled : null,
        backUpDisabled: now ? now.disabled : null,
        connectDisabled: connect ? connect.disabled : null
      })
    })()`)
  )
  console.log(`        → ${JSON.stringify(panel)}`)
  check('Settings carries a backup panel', panel.missing === false, JSON.stringify(panel))
  check(
    'the panel asks for no Google credentials at all',
    panel.credentialFields === 0,
    `${panel.credentialFields} credential field(s) still present`
  )
  check(
    'restoring and backing up are unreachable until the app is connected',
    panel.restoreDisabled === true && panel.backUpDisabled === true,
    JSON.stringify(panel)
  )
  check(
    panel.bundled
      ? 'connecting is offered straight away, because the build carries its own client'
      : 'connecting is unreachable without a compiled-in client',
    panel.connectDisabled === (panel.bundled ? false : true),
    JSON.stringify(panel)
  )
  /*
    The folder name is editable whether or not the app is connected. It was a button
    that needed both a token and a second Google credential, so it sat greyed out
    explaining nothing; a name needs neither.
  */
  check(
    'the folder name is a field, editable without a connection',
    panel.nameField === true && panel.nameDisabled === false,
    JSON.stringify(panel)
  )
  check(
    'and it shows the folder the status reports',
    panel.nameValue === panel.folderName,
    `field ${panel.nameValue} vs status ${panel.folderName}`
  )

  // The name round-trips through the database and back out of status.
  const renamed = JSON.parse(
    await evaluate(`(async () => {
      const before = (await window.api.backup.status()).folderName
      const saved = await window.api.backup.setFolderName('Probe folder')
      const after = (await window.api.backup.status()).folderName
      const blanked = await window.api.backup.setFolderName('   ')
      const fallback = (await window.api.backup.status()).folderName
      await window.api.backup.setFolderName(before)
      return JSON.stringify({ before, saved, after, blanked, fallback })
    })()`)
  )
  console.log(`        → ${JSON.stringify(renamed)}`)
  check(
    'naming the backup folder sticks',
    renamed.saved === 'Probe folder' && renamed.after === 'Probe folder',
    JSON.stringify(renamed)
  )
  check(
    'and blanking it falls back to the default rather than an empty name',
    renamed.blanked === 'Matomeru' && renamed.fallback === 'Matomeru',
    JSON.stringify(renamed)
  )

  // Leave the probe app as it was found.
  await setLocale('system')

  console.log(`
${'='.repeat(52)}
${passed} passed, ${failed} failed`)
  ws.close()
  process.exit(failed === 0 ? 0 : 1)
}

main().catch((err) => {
  console.error('feature check failed:', err.message)
  process.exit(1)
})
