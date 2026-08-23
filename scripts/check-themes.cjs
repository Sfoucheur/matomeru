/**
 * Measures every colour scheme in the running app, in every mode.
 *
 * Two things here cannot be settled by reading the CSS, which is why this drives
 * the real renderer instead:
 *
 *   1. The ramps are `color-mix(in oklab, var(--seed-tint) …)`, and Tailwind
 *      utilities wrap them again for opacity modifiers. Lightning CSS also emits
 *      a static srgb fallback beside each one under `@supports`, with the
 *      *default* seeds inlined — so if Electron ever took the fallback branch,
 *      every theme would silently collapse to the default palette while the
 *      stylesheet still looked correct. Resolving a token through
 *      `getComputedStyle` is the only way to know which branch won.
 *
 *   2. Contrast. One accent has to serve as text on the shell (~50 uses of
 *      `text-gold-300/400`), as a background under dark text (22 uses of
 *      `bg-gold-500`), and as a border (16 uses). A seed lifted from another
 *      app's palette has no reason to satisfy all three, so each pair is
 *      measured rather than assumed.
 *
 *   npm run build
 *   npx electron . --user-data-dir=/tmp/probe --remote-debugging-port=9222
 *   node scripts/check-themes.cjs
 *
 * Run it on a freshly launched app, and not in the same session as
 * check-features.cjs — that suite is deliberately not idempotent, and either one
 * running after the other will report failures that are nothing but leftovers.
 *
 * The colour sections only read computed styles. The last section drives the
 * real Settings controls, because the stylesheet being correct says nothing
 * about whether clicking a swatch reaches the DOM and the database — and that
 * wiring is the half a CSS measurement cannot see. Both restore what they found,
 * so this is safe to re-run.
 */
const port = process.argv[2] ?? '9222'

/** From THEMES in src/shared/types.ts. */
const THEMES = [
  'matomeru',
  'doom',
  'greenapple',
  'lavender',
  'midnightdusk',
  'strawberry',
  'tadami',
  'tako',
  'tealturquoise',
  'tidalwave',
  'yinyang',
  'yotsuba'
]

/*
  WCAG 2.1 thresholds. Body text needs 4.5:1; large text and non-text boundaries
  such as borders and focus rings need 3:1.
*/
const AA_TEXT = 4.5
const AA_LARGE = 3

let passed = 0
let failed = 0
const failures = []

function check(label, ok, detail) {
  if (ok) {
    passed += 1
  } else {
    failed += 1
    failures.push(`${label}${detail ? ` — ${detail}` : ''}`)
  }
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${ok || !detail ? '' : ` — ${detail}`}`)
}

function section(name) {
  console.log(`\n${name}\n${'-'.repeat(name.length)}`)
}

/**
 * The page hands back `[r, g, b]` already, so this only guards the shape.
 *
 * It used to parse the computed string here, and that was wrong in a way worth
 * recording: a token defined as `color-mix(in oklab, …)` computes to
 * `oklab(0.159 -0.0003 -0.011)`, not `rgb(…)`. Reading those three numbers as
 * 0-255 channels turned every colour into near-black, so every contrast ratio
 * came out at about 1.00 and twelve checks "failed" while the themes were fine.
 * Conversion now happens in the page, against real painted pixels.
 */
function parseRgb(value) {
  return Array.isArray(value) && value.length === 3 ? value : null
}

function luminance([r, g, b]) {
  const f = (c) => {
    const s = c / 255
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b)
}

function contrast(a, b) {
  const [x, y] = [luminance(a), luminance(b)].sort((m, n) => n - m)
  return (x + 0.05) / (y + 0.05)
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

/*
  Tokens are read through a real element rather than off `documentElement`,
  because `getComputedStyle(el).getPropertyValue('--x')` hands back the *unused*
  declared text — the very string we are trying to prove resolves. Assigning the
  var to a real colour property forces the engine to resolve it, and `color`
  always computes to an absolute rgb().
*/
const READ_TOKENS = (tokens) => `(() => {
  const probe = document.createElement('span')
  probe.style.position = 'fixed'
  probe.style.pointerEvents = 'none'
  probe.style.opacity = '0'
  document.body.appendChild(probe)

  /*
    Computed colours come back in whatever space they were authored in — a mixed
    token reads as \`oklab(0.159 -0.0003 -0.011)\`. Canvas converts to sRGB using
    the same pipeline that paints the window, gamut clamping included, so this
    measures the bytes the screen actually gets rather than a space-blind parse.
  */
  const canvas = document.createElement('canvas')
  canvas.width = 1
  canvas.height = 1
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  const srgb = (color) => {
    ctx.clearRect(0, 0, 1, 1)
    ctx.fillStyle = '#000000'
    ctx.fillStyle = color
    ctx.fillRect(0, 0, 1, 1)
    const d = ctx.getImageData(0, 0, 1, 1).data
    return [d[0], d[1], d[2]]
  }

  const out = {}
  for (const name of ${JSON.stringify(tokens)}) {
    probe.style.color = ''
    probe.style.color = 'var(' + name + ')'
    const computed = getComputedStyle(probe).color
    out[name] = srgb(computed)
    out['raw:' + name] = computed
  }
  // The opacity-modifier shape Tailwind generates, e.g. \`bg-ink-800/60\`: our
  // mixed token nested inside a further color-mix. If nesting breaks anywhere,
  // it breaks here rather than in the plain read above.
  probe.style.color = ''
  probe.style.color = 'color-mix(in oklab, var(--color-ink-800) 60%, white)'
  out['--nested'] = srgb(getComputedStyle(probe).color)
  out['raw:--nested'] = getComputedStyle(probe).color

  /*
    Proof the conversion path itself works, so a silent canvas failure cannot
    make every colour read as the same value and every ratio as 1.00 — which is
    exactly how this probe was wrong the first time.
  */
  out['--selftest'] = srgb('rgb(12, 200, 87)')
  probe.remove()
  return out
})()`

async function main() {
  const page = await findPage()
  const ws = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((r) => (ws.onopen = r))
  const call = rpc(ws)
  const evaluate = async (expression) =>
    (await call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }))
      ?.result?.value

  const TOKENS = [
    '--color-ink-950',
    '--color-ink-900',
    '--color-ink-850',
    '--color-ink-800',
    '--color-ink-700',
    '--color-ink-600',
    '--color-ink-400',
    '--color-ink-300',
    '--color-ink-200',
    '--color-ink-100',
    '--color-gold-600',
    '--color-gold-500',
    '--color-gold-400',
    '--color-gold-300',
    '--color-mana-b',
    '--color-mana-g',
    '--color-rarity-mythic',
    '--color-rarity-rare'
  ]

  /** Puts <html> in a given state and reads every token back. */
  const measure = async (theme, dark, black) => {
    await evaluate(`(() => {
      const r = document.documentElement
      r.classList.toggle('dark', ${dark})
      r.dataset.theme = '${theme}'
      if (${black} && ${dark}) r.dataset.black = '1'
      else delete r.dataset.black
      return r.className + '|' + r.dataset.theme
    })()`)
    await wait(30)
    return evaluate(READ_TOKENS(TOKENS))
  }

  // Remember what the user actually had, so this probe leaves no trace.
  const original = await evaluate(`(() => {
    const r = document.documentElement
    return {
      theme: r.dataset.theme ?? 'matomeru',
      dark: r.classList.contains('dark'),
      black: r.dataset.black === '1'
    }
  })()`)

  /* ------------------------------------------------------ resolution */
  section('color-mix() actually resolves')

  const base = await measure('lavender', true, false)

  // Before trusting any number below, prove the reading apparatus itself works.
  check(
    'the canvas readback is faithful — a known colour comes back unchanged',
    (base['--selftest'] ?? []).join(',') === '12,200,87',
    JSON.stringify(base['--selftest'])
  )

  const inkPlain = parseRgb(base['--color-ink-900'])
  check(
    'a mixed token computes to a real colour, not an unresolved string',
    inkPlain !== null && base['raw:--color-ink-900'] !== 'var(--color-ink-900)',
    JSON.stringify(base['raw:--color-ink-900'])
  )
  const nested = parseRgb(base['--nested'])
  check(
    'and still resolves nested inside a second color-mix (the /opacity shape)',
    nested !== null && nested.join(',') !== inkPlain.join(','),
    `${JSON.stringify(base['raw:--nested'])} -> ${JSON.stringify(nested)}`
  )

  /*
    The decisive one. Lightning CSS's srgb fallback has the *default* seeds baked
    in, so if it were winning, every theme's shell would read identically to
    Matomeru's while the themes still "applied". Comparing two tinted themes
    against the untinted default is what tells the branches apart.
  */
  const shellOf = async (theme) =>
    ((await measure(theme, true, false))['--color-ink-900'] ?? []).join(',')
  const defaultShell = await shellOf('matomeru')
  const lavenderShell = await shellOf('lavender')
  const takoShell = await shellOf('tako')
  check(
    'the seed override reaches the ramp — a tinted theme differs from the default',
    lavenderShell !== defaultShell && takoShell !== defaultShell,
    `default ${defaultShell}, lavender ${lavenderShell}, tako ${takoShell}`
  )
  check(
    'and two different tints differ from each other, not just from the default',
    lavenderShell !== takoShell,
    `lavender ${lavenderShell} vs tako ${takoShell}`
  )
  console.log(`        default ${defaultShell} · lavender ${lavenderShell} · tako ${takoShell}`)

  /* ------------------------------------------------------ contrast */
  for (const dark of [true, false]) {
    for (const black of dark ? [false, true] : [false]) {
      section(`Contrast — ${dark ? 'dark' : 'light'}${black ? ' + pure black' : ''}`)
      const rows = []
      for (const theme of THEMES) {
        const v = await measure(theme, dark, black)
        const shell = parseRgb(v['--color-ink-850'])
        const page = parseRgb(v['--color-ink-900'])
        const body = parseRgb(v['--color-ink-200'])
        const muted = parseRgb(v['--color-ink-400'])
        const g300 = parseRgb(v['--color-gold-300'])
        const g400 = parseRgb(v['--color-gold-400'])
        const g500 = parseRgb(v['--color-gold-500'])
        const onAccent = parseRgb(v['--color-ink-950'])
        if (!shell || !g300 || !g400 || !g500 || !body || !muted || !page || !onAccent) {
          check(`${theme}: every token resolved`, false, JSON.stringify(v))
          continue
        }
        rows.push({
          theme,
          // Accent as text, on the panel it actually sits on.
          accentText: Math.min(contrast(g300, shell), contrast(g400, shell)),
          // Accent as a filled background, under the darkest ink (buttons).
          accentFill: contrast(g500, onAccent),
          // The accent as a border or focus ring, against the panel.
          accentEdge: contrast(g500, shell),
          bodyText: contrast(body, shell),
          mutedText: contrast(muted, page)
        })
      }

      for (const r of rows) {
        console.log(
          `        ${r.theme.padEnd(14)} text ${r.accentText.toFixed(2).padStart(5)}` +
            `  fill ${r.accentFill.toFixed(2).padStart(5)}` +
            `  edge ${r.accentEdge.toFixed(2).padStart(5)}` +
            `  body ${r.bodyText.toFixed(2).padStart(5)}` +
            `  muted ${r.mutedText.toFixed(2).padStart(5)}`
        )
      }

      const worst = (key) => rows.reduce((a, b) => (b[key] < a[key] ? b : a))
      const wt = worst('accentText')
      check(
        `accent-as-text clears ${AA_TEXT}:1 in every theme`,
        wt.accentText >= AA_TEXT,
        `worst is ${wt.theme} at ${wt.accentText.toFixed(2)}:1`
      )
      const wf = worst('accentFill')
      check(
        `text on a filled accent clears ${AA_TEXT}:1 in every theme`,
        wf.accentFill >= AA_TEXT,
        `worst is ${wf.theme} at ${wf.accentFill.toFixed(2)}:1`
      )
      const we = worst('accentEdge')
      check(
        `accent borders and focus rings clear ${AA_LARGE}:1 in every theme`,
        we.accentEdge >= AA_LARGE,
        `worst is ${we.theme} at ${we.accentEdge.toFixed(2)}:1`
      )
      const wb = worst('bodyText')
      check(
        `body text clears ${AA_TEXT}:1 in every theme`,
        wb.bodyText >= AA_TEXT,
        `worst is ${wb.theme} at ${wb.bodyText.toFixed(2)}:1`
      )
      const wm = worst('mutedText')
      check(
        `secondary text clears ${AA_LARGE}:1 in every theme`,
        wm.mutedText >= AA_LARGE,
        `worst is ${wm.theme} at ${wm.mutedText.toFixed(2)}:1`
      )
    }
  }

  /* ------------------------------------------------------ card colours */
  section('Card colours are never themed')

  const cardTokens = ['--color-mana-b', '--color-mana-g', '--color-rarity-mythic', '--color-rarity-rare']
  const reference = await measure('matomeru', true, false)
  let drift = null
  for (const theme of THEMES) {
    for (const dark of [true, false]) {
      const v = await measure(theme, dark, false)
      for (const token of cardTokens) {
        const got = (v[token] ?? []).join(',')
        const want = (reference[token] ?? []).join(',')
        if (got !== want) {
          drift = `${theme}/${dark ? 'dark' : 'light'} ${token}: ${got} vs ${want}`
        }
      }
    }
  }
  check(
    'mana and rarity colours are identical across all 12 themes and both modes',
    drift === null,
    drift ?? ''
  )

  /*
    Proves the check above can fail. A test that only ever sees correct input is
    indistinguishable from one that asserts nothing — and this particular check
    compares a theme against a reference captured by the same code path, which is
    exactly the shape that passes vacuously if the read is broken.
  */
  const sabotaged = await evaluate(`(() => {
    document.documentElement.style.setProperty('--color-mana-g', '#ff00ff')
    const probe = document.createElement('span')
    probe.style.color = 'var(--color-mana-g)'
    document.body.appendChild(probe)
    const got = getComputedStyle(probe).color
    probe.remove()
    document.documentElement.style.removeProperty('--color-mana-g')
    return got
  })()`)
  check(
    'and that check would notice: forcing a mana colour changes what is read back',
    sabotaged !== reference['raw:--color-mana-g'],
    `forced ${sabotaged}, reference ${reference['raw:--color-mana-g']}`
  )

  /* ------------------------------------------------------ pure black */
  section('Pure black')

  const normalDark = await measure('matomeru', true, false)
  const blackDark = await measure('matomeru', true, true)
  const pageBlack = parseRgb(blackDark['--color-ink-900'])
  check(
    'the page goes fully black',
    pageBlack !== null && pageBlack.every((c) => c === 0),
    blackDark['--color-ink-900']
  )
  const panelBlack = parseRgb(blackDark['--color-ink-850'])
  check(
    'but panels stay off pure black, so scrolling content is still separable',
    panelBlack !== null && panelBlack.some((c) => c > 0),
    blackDark['--color-ink-850']
  )
  check(
    'and it changes something — the normal dark page is not already black',
    normalDark['--color-ink-900'].join(',') !== blackDark['--color-ink-900'].join(','),
    `${normalDark['--color-ink-900']} vs ${blackDark['--color-ink-900']}`
  )
  const blackLight = (await measure('matomeru', false, true))['--color-ink-900'].join(',')
  const plainLight = (await measure('matomeru', false, false))['--color-ink-900'].join(',')
  check('pure black does not leak into light mode', blackLight === plainLight, `${blackLight} vs ${plainLight}`)

  /* ------------------------------------------------------ the wiring */
  section('The Settings controls actually do something')

  // Settings is the last item in the sidebar; reached by index because the
  // labels are exactly what changes when the language does.
  await evaluate(`(() => {
    const nav = document.querySelector('nav') ?? document.querySelector('aside')
    const buttons = [...(nav ?? document).querySelectorAll('button')]
    buttons[buttons.length - 1]?.click()
    return true
  })()`)
  await wait(600)

  const swatches = await evaluate(`(() => {
    const found = [...document.querySelectorAll('button[aria-pressed]')].filter(
      (b) => b.querySelector('span[aria-hidden]')
    )
    return found.map((b) => b.textContent.trim())
  })()`)
  check(
    'all twelve schemes are offered as swatches',
    Array.isArray(swatches) && swatches.length === 12,
    `${Array.isArray(swatches) ? swatches.length : 'none'}: ${JSON.stringify(swatches)}`
  )
  check(
    'named, not just coloured',
    Array.isArray(swatches) && swatches.includes('Midnight Dusk') && swatches.includes('Tako'),
    JSON.stringify(swatches)
  )

  /*
    React 19 ignores a plain `.value = x` on a <select>, so the change has to go
    through the native setter for React's own listener to see it.
    `settings.get()` is read straight from the database afterwards: applying a
    theme to <html> without persisting it would look identical on screen and
    vanish on the next launch.
  */
  const pick = async (label) =>
    evaluate(`(() => {
      const button = [...document.querySelectorAll('button[aria-pressed]')].find(
        (b) => b.textContent.trim() === ${JSON.stringify(label)}
      )
      if (!button) return 'no such swatch'
      button.click()
      return 'clicked'
    })()`)

  /*
    By option *value*, and via `[data-setting]` rather than a visible label. The
    first version of this matched on the English words "Light" and "Pure black",
    found nothing because the app was in French, and reported three passes it had
    not earned — the same mistake this codebase has already been burned by once.
  */
  const setMode = async (value) =>
    evaluate(`(() => {
      const select = document.querySelector('[data-setting="themeMode"] select')
      if (!select) return 'no themeMode control on screen'
      const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set
      setter.call(select, ${JSON.stringify(value)})
      select.dispatchEvent(new Event('change', { bubbles: true }))
      return select.value
    })()`)

  check('clicking a swatch is possible', (await pick('Lavender')) === 'clicked')
  await wait(450)
  check(
    'and it repaints the document',
    (await evaluate('document.documentElement.dataset.theme')) === 'lavender',
    await evaluate('document.documentElement.dataset.theme')
  )
  check(
    'and it is written to the database, so it survives a restart',
    (await evaluate('window.api.settings.get().then((s) => s.theme)')) === 'lavender',
    await evaluate('window.api.settings.get().then((s) => s.theme)')
  )
  check(
    'the chosen swatch is the pressed one',
    (await evaluate(`[...document.querySelectorAll('button[aria-pressed="true"]')]
      .map((b) => b.textContent.trim()).join(',')`)) === 'Lavender',
    await evaluate(`[...document.querySelectorAll('button[aria-pressed="true"]')]
      .map((b) => b.textContent.trim()).join(',')`)
  )

  /*
    A reload is the closest thing to a restart that leaves the probe connected,
    and it exercises the real boot path: index.html ships `class="dark"` and the
    store has to correct it from the stored setting.
  */
  await call('Page.reload')
  await wait(2600)
  check(
    'and it is still there after a reload',
    (await evaluate('document.documentElement.dataset.theme')) === 'lavender',
    await evaluate('document.documentElement.dataset.theme')
  )

  await evaluate(`(() => {
    const nav = document.querySelector('nav') ?? document.querySelector('aside')
    const buttons = [...(nav ?? document).querySelectorAll('button')]
    buttons[buttons.length - 1]?.click()
    return true
  })()`)
  await wait(600)

  const pureBlackShown = async () =>
    evaluate(`!!document.querySelector('[data-setting="pureBlack"]')`)
  const darkClass = async () =>
    evaluate('document.documentElement.classList.contains("dark")')

  check('pure black is offered in dark mode', (await pureBlackShown()) === true)

  /*
    The select is controlled, so reading `.value` straight after the dispatch
    hands back the pre-update value — React has not re-rendered yet. Assert what
    it settles on, together with what reached the database.
  */
  const modeState = async () =>
    evaluate(`Promise.resolve(window.api.settings.get()).then((s) => [
      document.querySelector('[data-setting="themeMode"] select').value,
      s.themeMode
    ].join('/'))`)

  await setMode('light')
  await wait(500)
  check('the control and the database agree on Light', (await modeState()) === 'light/light', await modeState())
  check('choosing Light removes the dark class', (await darkClass()) === false)

  /*
    Light mode shipped written but unreachable — index.html hardcoded
    `class="dark"` and nothing ever removed it. So this asserts the page is
    genuinely light now, by luminance, rather than merely that a class changed.
  */
  const pageIn = async () =>
    evaluate(`(() => {
      const canvas = document.createElement('canvas')
      canvas.width = canvas.height = 1
      const ctx = canvas.getContext('2d', { willReadFrequently: true })
      const probe = document.createElement('span')
      document.body.appendChild(probe)
      probe.style.color = 'var(--color-ink-900)'
      ctx.fillStyle = '#000000'
      ctx.fillStyle = getComputedStyle(probe).color
      ctx.fillRect(0, 0, 1, 1)
      probe.remove()
      const d = ctx.getImageData(0, 0, 1, 1).data
      return [d[0], d[1], d[2]]
    })()`)
  const lightPage = await pageIn()
  check(
    'and the page is actually light — this palette was unreachable before',
    luminance(lightPage) > 0.7,
    `page reads ${lightPage}, luminance ${luminance(lightPage).toFixed(3)}`
  )
  check(
    'and pure black is hidden there, since it would mean nothing',
    (await pureBlackShown()) === false
  )

  await setMode('dark')
  await wait(500)
  check('the control and the database agree on Dark', (await modeState()) === 'dark/dark', await modeState())
  check('choosing Dark puts it back', (await darkClass()) === true)
  const darkPage = await pageIn()
  check(
    'and the page is dark again',
    luminance(darkPage) < 0.05,
    `page reads ${darkPage}, luminance ${luminance(darkPage).toFixed(3)}`
  )

  /*
    The paint hint. index.html hardcodes `class="dark"`, so without a hint a
    light-mode user gets a dark flash on every launch while the settings read
    crosses IPC. Asserting the hint's *content* rather than its presence is the
    point: a hint that exists but disagrees with the setting would still flash.
  */
  const hint = await evaluate(`localStorage.getItem('matomeru.theme')`)
  check(
    'the applied theme is mirrored for the next launch to paint immediately',
    typeof hint === 'string' && JSON.parse(hint).dark === true,
    String(hint)
  )
  await setMode('light')
  await wait(500)
  const lightHint = await evaluate(`localStorage.getItem('matomeru.theme')`)
  check(
    'and the mirror follows the mode, so it cannot flash the wrong one',
    typeof lightHint === 'string' && JSON.parse(lightHint).dark === false,
    String(lightHint)
  )
  await setMode('dark')
  await wait(400)

  // Leave the app on the scheme and mode it was found with.
  await pick('Matomeru')
  await wait(300)
  await evaluate(`window.api.settings.update({
    theme: '${original.theme}',
    themeMode: '${original.dark ? 'dark' : 'light'}',
    pureBlack: ${original.black}
  })`)
  await measure(original.theme, original.dark, original.black)

  console.log(`\n${'='.repeat(52)}\n${passed} passed, ${failed} failed`)
  if (failures.length) {
    console.log('\nFailures:')
    for (const f of failures) console.log(`  - ${f}`)
  }
  ws.close()
  process.exit(failed === 0 ? 0 : 1)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
