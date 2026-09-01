/**
 * Geometry check for the virtualized lists, run against a live app.
 *
 * A virtualized row declares its height up front; if its content is taller, the
 * overflow paints behind the rows below and cards appear doubled at the wrong
 * size. Counting rendered nodes does not catch that — only comparing declared
 * height against actual height does, which is why this exists.
 *
 * Reports, per configuration, how many rows overlap and the worst delta. Expect
 * `overlappingRows: 0` everywhere, a positive `+gap` on tile rows, and a few px
 * of slack on headers and list rows.
 *
 * Also checks the floating-layer order, because "the dropdown renders behind the
 * thing that owns it" has now happened twice: once from a `backdrop-filter`
 * ancestor trapping a z-index, once from a popover inside a modal sitting on the
 * page tier. Both are invisible to typecheck and to the SQL suite.
 *
 *   npm run build
 *   npx electron . --user-data-dir=/tmp/probe --remote-debugging-port=9222
 *   npm run check:geometry
 */
const port = process.argv[2] ?? '9222'

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

function connect(ws) {
  let id = 0
  return (expression) =>
    new Promise((resolve, reject) => {
      const myId = ++id
      const onMessage = (event) => {
        const msg = JSON.parse(event.data)
        if (msg.id !== myId) return
        ws.removeEventListener('message', onMessage)
        if (msg.result?.exceptionDetails) {
          reject(new Error(msg.result.exceptionDetails.exception?.description ?? 'threw'))
        } else resolve(msg.result?.result?.value)
      }
      ws.addEventListener('message', onMessage)
      ws.send(
        JSON.stringify({
          id: myId,
          method: 'Runtime.evaluate',
          params: { expression, returnByValue: true, awaitPromise: true }
        })
      )
    })
}

const PANE = `[...document.querySelectorAll('main > div')].find((p) => !p.classList.contains('hidden'))`

/** Declared vs actual height for every absolutely-positioned virtual row. */
const GEOMETRY = `
  (() => {
    const pane = ${PANE}
    const body = [...pane.querySelectorAll('.overflow-y-auto')]
      .sort((a, b) => b.scrollHeight - a.scrollHeight)[0]
    const rows = [...body.querySelectorAll(':scope > div > div')]
      .filter((d) => d.style.position === 'absolute')
    const deltas = rows.map((row) => {
      const child = row.firstElementChild
      const declared = row.getBoundingClientRect().height
      const actual = child ? child.getBoundingClientRect().height : 0
      return {
        kind: child && child.className.includes('grid') ? 'tiles'
          : child && child.tagName === 'DIV' && child.className.includes('h-11') ? 'row'
          : 'header',
        delta: Math.round((declared - actual) * 10) / 10,
        declared: Math.round(declared),
        actual: Math.round(actual)
      }
    })
    const worst = deltas.slice().sort((a, b) => a.delta - b.delta)[0]
    const overlapping = deltas.filter((d) => d.delta < -0.5)
    return JSON.stringify({
      /*
        Zero rows is a failure, not a clean sheet.

        The body is found as the scroller with the most to scroll, and the deck sidebar is in
        the same pane -- so a short list can hand this the wrong element, which has no
        absolutely-positioned children and therefore no overlaps to report. "overlappingRows:
        0" then reads as a pass while nothing was measured at all.
      */
      measuredNothing: deltas.length === 0,
      rowsMeasured: deltas.length,
      overlappingRows: overlapping.length,
      worst: worst ?? null,
      sample: deltas.slice(0, 4)
    })
  })()
`

/** Every fixed layer with a real z-index, so their order can be asserted. */
const LAYERS = `
  (() => {
    const layers = [...document.querySelectorAll('div')]
      .map((el) => ({ el, cs: getComputedStyle(el) }))
      .filter(({ cs }) => cs.position === 'fixed' && cs.zIndex !== 'auto')
      .map(({ el, cs }) => ({
        z: Number(cs.zIndex),
        kind: /role="dialog"/.test(el.outerHTML.slice(0, 200)) || el.querySelector('[role="dialog"]')
          ? 'modal'
          : el.className.toString().includes('pointer-events-none')
            ? 'toasts'
            : 'popover',
        visible: el.getBoundingClientRect().height > 0
      }))
    return JSON.stringify(layers)
  })()
`

/** Page.reload, which connect()'s evaluate-only channel cannot express. */
function sendReload(ws) {
  return new Promise((resolve) => {
    const id = 999000 + Math.floor(performance.now() % 1000)
    const onMessage = (event) => {
      const msg = JSON.parse(event.data)
      if (msg.id !== id) return
      ws.removeEventListener('message', onMessage)
      resolve()
    }
    ws.addEventListener('message', onMessage)
    ws.send(JSON.stringify({ id, method: 'Page.reload', params: {} }))
  })
}

async function main() {
  const ws = new WebSocket((await findPage()).webSocketDebuggerUrl)
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve)
    ws.addEventListener('error', reject)
  })
  const run = connect(ws)

  /*
    Measure in English.

    This script drives the UI through aria-labels and titles — "Row view",
    "One flat list", "Sort this deck" — and every one of those now translates, so
    a French session made it click null. Row heights do not depend on language,
    so pinning it is both safe and what makes the run deterministic. The setting
    is restored at the end.

    A reload is required: window.api.settings.update writes the database but not
    the renderer store, so the live UI would keep its old language.
  */
  const originalLocale = await run(
    `(async () => (await window.api.settings.get()).locale)()`
  )
  const setLocale = async (locale) => {
    await run(`window.api.settings.update({ locale: '${locale}' })`)
    await sendReload(ws)
    for (let i = 0; i < 40; i += 1) {
      await new Promise((r) => setTimeout(r, 250))
      if (await run(`!!document.querySelector('nav button')`).catch(() => false)) break
    }
    await new Promise((r) => setTimeout(r, 700))
  }
  if (originalLocale !== 'en') await setLocale('en')

  await run(`
    (async () => {
      [...document.querySelectorAll('nav button')]
        .find((b) => (b.textContent || '').trim().startsWith('Decks')).click()
      await new Promise((r) => setTimeout(r, 3000))
    })()
  `)

  const setColumns = (target) => `
    (async () => {
      const pane = ${PANE}
      const readout = () => {
        const el = [...pane.querySelectorAll('span')].find((s) =>
          (s.textContent || '').trim().endsWith('/row')
        )
        return el ? Number(el.textContent.trim().split('/')[0]) : null
      }
      for (let i = 0; i < 24; i += 1) {
        const shown = readout()
        if (shown === ${target} || shown === null) break
        const label = shown < ${target} ? 'More columns, smaller cards' : 'Fewer columns, bigger cards'
        const button = pane.querySelector('[aria-label="' + label + '"]')
        if (!button) break
        button.click()
        await new Promise((r) => setTimeout(r, 200))
      }
      await new Promise((r) => setTimeout(r, 1000))
      return readout()
    })()
  `

  for (const columns of [2, 5, 8, 14]) {
    const actual = await run(setColumns(columns))
    console.log(`grid, ${String(actual).padStart(2)} columns:`, await run(GEOMETRY))
  }

  // Grouping off: one big Deck section, so almost every row is full.
  await run(`
    (async () => {
      ${PANE}.querySelector('[aria-label="One flat list"]').click()
      await new Promise((r) => setTimeout(r, 1600))
    })()
  `)
  console.log('grid, grouping off:      ', await run(GEOMETRY))
  await run(`
    (async () => {
      ${PANE}.querySelector('[aria-label="Group by Archidekt category"]').click()
      await new Promise((r) => setTimeout(r, 1600))
    })()
  `)

  /*
    Scrolled to the bottom, where the excluded piles live -- and paged to the end first, since
    a long deck no longer draws at once. Without the page turns the bottom of page one is not
    the bottom of the deck, and the configuration this measurement exists for is unreachable.
  */
  console.log(
    'grid, scrolled to end:   ',
    await run(`
      (async () => {
        const pane = ${PANE}
        for (let i = 0; i < 40; i += 1) {
          const next = pane.querySelector('[data-action="nextPage"]')
          if (!next || next.disabled) break
          next.click()
          await new Promise((r) => setTimeout(r, 350))
        }
        const body = [...pane.querySelectorAll('.overflow-y-auto')]
          .sort((a, b) => b.scrollHeight - a.scrollHeight)[0]
        body.scrollTop = body.scrollHeight
        await new Promise((r) => setTimeout(r, 1200))
        return 'scrolled'
      })()
    `).then(() => run(GEOMETRY))
  )

  // Layer order: a popover on the page belongs below the modal tier, and one
  // opened from inside a modal belongs above it.
  console.log(
    'page popover layer:       ',
    await run(`
      (async () => {
        // Close anything already open, or this measures the previous popover.
        for (let i = 0; i < 3; i += 1) {
          document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
          await new Promise((r) => setTimeout(r, 250))
        }
        const pane = ${PANE}
        const sort = [...pane.querySelectorAll('button')].find((b) => /Sort this deck/.test(b.getAttribute('title') || ''))
        if (!sort) return 'sort control not found'
        sort.click()
        await new Promise((r) => setTimeout(r, 700))
        // Identify it by its own content, not by being "the visible popover".
        const panel = [...document.querySelectorAll('div')].find(
          (el) => getComputedStyle(el).position === 'fixed' &&
            getComputedStyle(el).zIndex !== 'auto' &&
            /Sort by/.test(el.textContent || '')
        )
        const z = panel ? Number(getComputedStyle(panel).zIndex) : null
        sort.click()
        return JSON.stringify({ popover: z, expected: 45, ok: z === 45 })
      })()
    `)
  )

  // Row mode, to check the header and row constants.
  await run(`
    (async () => {
      ${PANE}.querySelector('[aria-label="Row view"]').click()
      await new Promise((r) => setTimeout(r, 1600))
    })()
  `)
  console.log('row mode:                ', await run(GEOMETRY))

  // Row mode with grouping off: the one configuration that draws the rule under the
  // pinned commander, which declares a height of its own like any other item.
  await run(`
    (async () => {
      ${PANE}.querySelector('[aria-label="One flat list"]').click()
      await new Promise((r) => setTimeout(r, 1600))
    })()
  `)
  console.log('row mode, grouping off:  ', await run(GEOMETRY))
  await run(`
    (async () => {
      ${PANE}.querySelector('[aria-label="Group by Archidekt category"]').click()
      await new Promise((r) => setTimeout(r, 1600))
    })()
  `)
  await run(`
    (async () => {
      ${PANE}.querySelector('[aria-label="Grid view"]').click()
      await new Promise((r) => setTimeout(r, 1200))
    })()
  `)
  if (originalLocale !== 'en') await setLocale(originalLocale)
  ws.close()
}

main().catch((err) => {
  console.error('geometry check failed:', err.message)
  process.exit(1)
})
