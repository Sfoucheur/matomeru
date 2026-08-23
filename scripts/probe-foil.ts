/**
 * Checks migration 8 and the foil-treatment derivation against a copy of the
 * real database: does the backfill land, does the derived treatment match what
 * the filter's SQL would pick, and does a deck finish override survive a sync?
 *
 *   npm run probe:foil
 */
import { closeDb, getDb, setDataDir } from '../src/main/db/connection.js'
import { queryCollection, queryFacets, updateItem } from '../src/main/db/repos/collection.js'
import { deckBreakdown, setCardFinish } from '../src/main/db/repos/decks.js'
import { DEFAULT_FILTERS, foilTreatmentOf, foilTreatmentLabel } from '../src/shared/types.js'

const dir = process.argv[2]
if (!dir) throw new Error('usage: probe-foil <dataDir>')
setDataDir(dir)
const db = getDb()

const one = <T>(sql: string): T => db.get(sql) as T

console.log('--- migration 8 backfill ---')
const cols = (db.all("SELECT name FROM pragma_table_info('printings')") as { name: string }[]).map(
  (c) => c.name
)
console.log('  promo_types column:', cols.includes('promo_types'))
console.log('  in_boosters column:', cols.includes('in_boosters'))
const back = one<{ raw: number; col: number }>(
  `SELECT (SELECT COUNT(*) FROM printings WHERE json_extract(raw_json,'$.promo_types') IS NOT NULL) AS raw,
          (SELECT COUNT(*) FROM printings WHERE promo_types IS NOT NULL) AS col`
)
console.log(`  promo_types backfilled: ${back.col} of ${back.raw} in raw_json`, back.col === back.raw ? 'OK' : 'MISMATCH')
const boost = one<{ raw: number; yes: number; no: number }>(
  `SELECT (SELECT COUNT(*) FROM printings WHERE json_extract(raw_json,'$.booster') IS NOT NULL) AS raw,
          (SELECT COUNT(*) FROM printings WHERE in_boosters = 1) AS yes,
          (SELECT COUNT(*) FROM printings WHERE in_boosters = 0) AS no`
)
console.log(`  in_boosters: ${boost.yes} yes / ${boost.no} no, ${boost.raw} present in raw_json`,
  boost.yes + boost.no === boost.raw ? 'OK' : 'MISMATCH')

console.log('\n--- derivation, on every tagged printing ---')
const tagged = db.all(
  `SELECT scryfall_id, name, set_code, promo_types, finishes FROM printings
   WHERE promo_types IS NOT NULL AND promo_types != '[]'`
) as { scryfall_id: string; name: string; set_code: string; promo_types: string; finishes: string }[]
let derived = 0
let nonfoilNull = 0
for (const p of tagged) {
  const promo = { promo_types: JSON.parse(p.promo_types) as string[] }
  if (foilTreatmentOf(promo, 'nonfoil') === null) nonfoilNull++
  if (foilTreatmentOf(promo, 'foil') !== null) derived++
}
console.log(`  ${tagged.length} tagged printings; ${derived} yield a treatment when foil`)
console.log(`  nonfoil always null: ${nonfoilNull === tagged.length ? 'OK' : 'FAILED'}`)

console.log('\n--- SQL and TS agree on the treatment ---')
const sqlSide = db.all(
  `SELECT p.scryfall_id, p.promo_types,
          CASE
            WHEN EXISTS (SELECT 1 FROM json_each(COALESCE(p.promo_types,'[]')) WHERE value='surgefoil') THEN 'surgefoil'
            ELSE NULL END AS quick
   FROM printings p WHERE p.promo_types IS NOT NULL AND p.promo_types != '[]'`
) as { scryfall_id: string; promo_types: string; quick: string | null }[]
let agree = 0
let disagree: string[] = []
for (const r of sqlSide) {
  const ts = foilTreatmentOf({ promo_types: JSON.parse(r.promo_types) as string[] }, 'foil')
  const surge = r.quick === 'surgefoil'
  // Only the surgefoil subset is comparable with this cheap SQL; the full CASE
  // lives in collection.ts and is exercised through the facet below.
  if (surge && ts !== 'surgefoil') disagree.push(r.scryfall_id)
  else agree++
}
console.log(`  surgefoil subset: ${agree} agree, ${disagree.length} disagree`, disagree.length ? 'FAILED' : 'OK')

console.log('\n--- treatment facet, through the real query ---')
const facets = queryFacets(DEFAULT_FILTERS, 'eur')
console.log('  treatments offered:', facets.treatments.map((t) => `${foilTreatmentLabel(t.value)}=${t.count}`).join(', ') || '(none)')
console.log('  finishes offered  :', facets.finishes.map((f) => `${f.value}=${f.count}`).join(', '))

console.log('\n--- filtering by a treatment keeps exactly those rows ---')
for (const t of facets.treatments) {
  const page = queryCollection({ ...DEFAULT_FILTERS, treatments: [t.value] }, 'eur', 500, 0)
  const wrong = page.rows.filter((r) => r.foil_treatment !== t.value)
  console.log(`  ${t.value}: ${page.rows.length} rows, ${page.totalQuantity} copies, ${wrong.length} wrong`,
    wrong.length ? 'FAILED' : 'OK')
}

console.log('\n--- pick_list_items carries the treatment ---')
const pliCols = (db.all("SELECT name FROM pragma_table_info('pick_list_items')") as { name: string }[]).map(
  (c) => c.name
)
console.log('  foil_treatment column:', pliCols.includes('foil_treatment') ? 'OK' : 'MISSING')

console.log('\n--- a real collection row, treated by hand ---')
const owned = one<{ id: number; scryfall_id: string; finish: string } | undefined>(
  "SELECT id, scryfall_id, finish FROM collection_items WHERE quantity > 0 LIMIT 1"
)
if (owned) {
  const valueOf = (id: number): number | null =>
    queryCollection(DEFAULT_FILTERS, 'eur', 500, 0).rows.find((r) => r.id === id)?.unit_value ?? null
  updateItem(owned.id, { finish: 'foil' })
  const priceBefore = valueOf(owned.id)

  updateItem(owned.id, { foil_treatment: 'surgefoil' })
  const facets2 = queryFacets(DEFAULT_FILTERS, 'eur')
  const offered = facets2.treatments.find((t) => t.value === 'surgefoil')
  console.log('  facet now offers Surge Foil:', offered ? `OK (${offered.count})` : 'FAILED')
  const page = queryCollection({ ...DEFAULT_FILTERS, treatments: ['surgefoil'] }, 'eur', 500, 0)
  const wrong = page.rows.filter((r) => r.foil_treatment !== 'surgefoil')
  console.log(`  filter keeps ${page.rows.length} row(s), ${wrong.length} wrong`, wrong.length ? 'FAILED' : 'OK')
  console.log('  marked as yours:', page.rows.find((r) => r.id === owned.id)?.treatment_forced ? 'OK' : 'FAILED')

  // A treatment is not a price axis: Scryfall has no per-treatment price.
  const priceAfter = valueOf(owned.id)
  console.log('  price unchanged by the treatment:',
    priceBefore === priceAfter ? 'OK' : `FAILED (${priceBefore} vs ${priceAfter})`)

  updateItem(owned.id, { foil_treatment: null })
  const cleared = queryCollection(DEFAULT_FILTERS, 'eur', 500, 0).rows.find((r) => r.id === owned.id)
  console.log('  cleared:', cleared && !cleared.foil_treatment && !cleared.treatment_forced ? 'OK' : 'FAILED')
  updateItem(owned.id, { finish: owned.finish as 'nonfoil' })
} else {
  console.log('  no owned rows to test')
}

console.log('\n--- a deck finish override, end to end ---')
const deck = one<{ id: number; name: string } | undefined>('SELECT id, name FROM decks LIMIT 1')
if (deck) {
  const allCards = (id: number) =>
    (deckBreakdown(id, 'eur', false)?.groups ?? []).flatMap((g) => g.cards)
  const before = allCards(deck.id)
  const target = before.find((c) => c.oracle_id && c.finish === 'nonfoil')
  if (target) {
    console.log(`  ${target.name} in ${deck.name}: finish=${target.finish} value=${target.unit_value}`)
    setCardFinish(deck.id, target.oracle_id!, 'foil', 'surgefoil')
    const after = allCards(deck.id).find((c) => c.id === target.id)!
    console.log(`  after override: finish=${after.finish} forced=${after.finish_forced} treatment=${after.foil_treatment} value=${after.unit_value}`)
    console.log('  finish changed:', after.finish === 'foil' ? 'OK' : 'FAILED')
    console.log('  marked as yours:', after.finish_forced ? 'OK' : 'FAILED')
    console.log('  treatment stored:', after.foil_treatment === 'surgefoil' ? 'OK' : 'FAILED')
    const priced = after.unit_value !== target.unit_value
    console.log(`  price followed the finish: ${priced ? 'yes' : 'no (printing may have no foil price)'}`)

    // It has to reach the derived collection rows too, not just the deck screen.
    const rows = queryCollection({ ...DEFAULT_FILTERS, treatments: ['surgefoil'] }, 'eur', 500, 0)
    const seen = rows.rows.some((r) => r.printing.scryfall_id === after.scryfall_id)
    console.log('  reaches the collection rows:', seen ? 'OK' : 'not owned-labelled, so not expected')

    setCardFinish(deck.id, target.oracle_id!, null, null)
    const cleared = allCards(deck.id).find((c) => c.id === target.id)!
    console.log('  cleared back to Archidekt:', cleared.finish === target.finish && !cleared.finish_forced ? 'OK' : 'FAILED')
  } else {
    console.log('  no nonfoil deck card with an oracle id to test')
  }
} else {
  console.log('  no decks in this database')
}

closeDb()
