/**
 * Read-only probe of the deck -> collection move path, run against a *copy* of the
 * live database (same convention as probe:decks — never point it at the real one).
 *
 *   npm run probe:move -- <path-to-db-dir> [archidekt-deck-id]
 *
 * Answers one question: for every entry of a deck, does the id the Decks screen
 * renders still find a row in the lookup `moveToCollection` uses? A deck carrying
 * language overrides is where those two diverge — the screen shows
 * COALESCE(o.scryfall_id, dc.scryfall_id) and the lookup used to filter on
 * dc.scryfall_id alone, so nothing matched and every card was refused.
 */
import { getDataDir, getDb, setDataDir } from '../src/main/db/connection.js'
import { moveToCollection } from '../src/main/db/repos/moves.js'
import {
  DECK_FINISH,
  DECK_OVERRIDE_JOIN,
  DECK_PRINTING,
  DECK_PROXIED,
  DECK_TRAITS_JOIN
} from '../src/main/db/repos/decks.js'

const dir = process.argv[2]
if (!dir) {
  console.error('usage: npm run probe:move -- <path-to-db-dir> [archidekt-deck-id]')
  process.exit(1)
}
setDataDir(dir)
console.log(`data dir: ${getDataDir()}`)
if (/AppData[\/]Roaming[\/]matomeru$/i.test(getDataDir())) {
  console.error('refusing to run against the live data dir — copy matomeru.db somewhere first')
  process.exit(1)
}

const wanted = process.argv[3] ?? '22193362'
const db = getDb()

const deck = db.get(
  'SELECT id, name, external_id, default_lang FROM decks WHERE external_id = ? OR id = ?',
  [wanted, Number(wanted) || -1]
) as { id: number; name: string; external_id: string; default_lang: string | null } | undefined

if (!deck) {
  console.error(`no deck matching ${wanted}`)
  const all = db.all('SELECT id, external_id, name FROM decks ORDER BY id') as {
    id: number
    external_id: string
    name: string
  }[]
  for (const d of all) console.error(`  id=${d.id} external=${d.external_id} ${d.name}`)
  process.exit(1)
}

console.log(`\ndeck ${deck.id} (archidekt ${deck.external_id}) — ${deck.name}`)
console.log(`default_lang: ${deck.default_lang ?? '(none)'}`)

interface Row {
  id: number
  oracle_id: string | null
  entry_scryfall_id: string
  override_scryfall_id: string | null
  rendered: string
  label_possession: string | null
  proxied: number
  quantity: number
  finish: string
  categories: string | null
  in_maindeck: number
  name: string
  printing_cached: number
}

const rows = db.all(
  `SELECT dc.id, dc.oracle_id,
          dc.scryfall_id                AS entry_scryfall_id,
          o.scryfall_id                 AS override_scryfall_id,
          ${DECK_PRINTING}              AS rendered,
          dc.label_possession, ${DECK_PROXIED} AS proxied,
          dc.quantity, ${DECK_FINISH}   AS finish,
          dc.categories, dc.in_maindeck, dc.name,
          (SELECT COUNT(*) FROM printings p WHERE p.scryfall_id = ${DECK_PRINTING}) AS printing_cached
   FROM deck_cards dc
   ${DECK_OVERRIDE_JOIN}
   ${DECK_TRAITS_JOIN}
   WHERE dc.deck_id = ?
   ORDER BY dc.name COLLATE NOCASE`,
  [deck.id]
) as Row[]

console.log(`entries: ${rows.length}`)

const overridden = rows.filter((r) => r.override_scryfall_id !== null)
const diverged = rows.filter(
  (r) => r.override_scryfall_id !== null && r.override_scryfall_id !== r.entry_scryfall_id
)
console.log(`  with an override row: ${overridden.length}`)
console.log(`  where rendered id != dc.scryfall_id: ${diverged.length}`)
console.log(`  label_possession='owned': ${rows.filter((r) => r.label_possession === 'owned').length}`)
console.log(`  label_possession=not owned/null: ${rows.filter((r) => r.label_possession !== 'owned').length}`)
console.log(`  proxied: ${rows.filter((r) => r.proxied === 1).length}`)
console.log(`  no cached printing: ${rows.filter((r) => r.printing_cached === 0).length}`)

/** Categories, as the screen groups them. */
function cats(row: Row): string[] {
  try {
    return JSON.parse(row.categories ?? '[]') as string[]
  } catch {
    return []
  }
}

const byCategory = new Map<string, Row[]>()
for (const row of rows) {
  for (const name of cats(row).length ? cats(row) : ['(none)']) {
    const list = byCategory.get(name) ?? []
    list.push(row)
    byCategory.set(name, list)
  }
}
console.log('\ncategories:')
for (const [name, list] of [...byCategory].sort((a, b) => b[1].length - a[1].length)) {
  console.log(`  ${name}: ${list.length}`)
}

/**
 * The lookup as it stands in moves.ts, and as this plan changes it. Both are run
 * with the id the screen would pass — the rendered one.
 */
function lookup(row: Row, matchOn: 'entry' | 'rendered'): number {
  const clause =
    matchOn === 'entry'
      ? 'AND (? IS NULL OR dc.scryfall_id = ?)'
      : `AND (? IS NULL OR ${DECK_PRINTING} = ?)`
  const found = db.all(
    `SELECT dc.id
     FROM deck_cards dc
     ${DECK_OVERRIDE_JOIN}
     ${DECK_TRAITS_JOIN}
     WHERE dc.deck_id = ? AND dc.oracle_id = ? AND ${DECK_PRINTING} IS NOT NULL
       ${clause}`,
    [deck.id, row.oracle_id, row.rendered, row.rendered]
  )
  return found.length
}

const target = process.argv[4] ?? 'cut'
const inTarget = rows.filter((r) => cats(r).some((c) => c.toLowerCase() === target.toLowerCase()))
console.log(`\ncategory "${target}": ${inTarget.length} entries`)

let brokenNow = 0
let fixedAfter = 0
for (const row of inTarget) {
  const before = lookup(row, 'entry')
  const after = lookup(row, 'rendered')
  if (before === 0) brokenNow += 1
  if (after > 0) fixedAfter += 1
  console.log(
    `  ${row.name}` +
      ` q=${row.quantity} poss=${row.label_possession ?? 'null'} proxied=${row.proxied}` +
      ` cached=${row.printing_cached}` +
      ` dc=${row.entry_scryfall_id.slice(0, 8)}` +
      ` o=${row.override_scryfall_id ? row.override_scryfall_id.slice(0, 8) : '-'}` +
      ` -> lookup(dc.scryfall_id)=${before} lookup(DECK_PRINTING)=${after}`
  )
}
console.log(
  `\nrefused by the current lookup: ${brokenNow}/${inTarget.length}` +
    ` · found by the fixed lookup: ${fixedAfter}/${inTarget.length}`
)

/*
  And the real thing, end to end: run `moveToCollection` exactly as the Decks screen
  would, with the id the screen renders. Mutates the database, which is why it is behind
  a flag and why this script refuses to open the live one.
*/
if (process.argv.includes('--apply')) {
  console.log(`
applying moveToCollection to "${target}" with the id the screen renders:`)
  let moved = 0
  const refusals = new Map<string, number>()
  for (const row of inTarget) {
    try {
      moved += moveToCollection(deck.id, row.oracle_id as string, 1, row.rendered).moved
    } catch (err) {
      const reason = (err as Error).message
      refusals.set(reason, (refusals.get(reason) ?? 0) + 1)
    }
  }
  console.log(`  moved: ${moved}/${inTarget.length}`)
  for (const [reason, n] of refusals) console.log(`  refused x${n}: ${reason}`)
  const landed = db.get(
    `SELECT COUNT(*) AS rows, COALESCE(SUM(quantity), 0) AS copies
       FROM collection_items ci
      WHERE EXISTS (SELECT 1 FROM deck_card_moves m
                     WHERE m.deck_id = ? AND m.quantity < 0
                       AND m.scryfall_id = ci.scryfall_id)`,
    [deck.id]
  ) as { rows: number; copies: number }
  console.log(`  collection rows created or topped up: ${landed.rows} (${landed.copies} copies)`)
}
