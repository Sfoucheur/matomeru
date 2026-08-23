/**
 * Does the booster panel now answer correctly for a non-English collection?
 *
 *   npm run probe:boosters
 */
import { closeDb, getDb, setDataDir } from '../src/main/db/connection.js'
import { boosterOddsFor, collectionBoosterSets } from '../src/main/services/boosterOdds.js'

const dir = process.argv[2]
if (!dir) throw new Error('usage: probe-boosters <dataDir>')
setDataDir(dir)
const db = getDb()

console.log('--- the false negatives, before and after ---')
const broken = db.all(
  `SELECT p.scryfall_id, p.name, p.set_code, p.collector_number, p.lang
   FROM printings p
   JOIN booster_sets bs ON bs.set_code = UPPER(p.set_code)
   WHERE p.in_boosters = 1
     AND NOT EXISTS (SELECT 1 FROM booster_odds bo WHERE bo.scryfall_id = p.scryfall_id)`
) as { scryfall_id: string; name: string; set_code: string; collector_number: string; lang: string }[]
console.log(`  ${broken.length} printings have no odds row of their own`)

let repaired = 0
let stillNothing: string[] = []
for (const p of broken) {
  const odds = boosterOddsFor(p.scryfall_id, p.set_code)
  const any = odds.boosters.some((b) => b.probability > 0)
  if (any) repaired += 1
  else stillNothing.push(`${p.name} (${p.set_code} #${p.collector_number} ${p.lang})`)
}
console.log(`  ${repaired} now report real odds via the English sibling`)
console.log(`  ${stillNothing.length} still report none:`)
for (const s of stillNothing.slice(0, 6)) console.log('     ', s)

console.log('\n--- a French card matches its English sibling exactly ---')
const pair = db.get(
  `SELECT f.scryfall_id AS fr, e.scryfall_id AS en, f.name, f.set_code
   FROM printings f
   JOIN printings e ON e.set_code = f.set_code
                   AND e.collector_number = f.collector_number
                   AND e.lang = 'en'
   JOIN booster_odds bo ON bo.scryfall_id = e.scryfall_id
   JOIN booster_sets bs ON bs.set_code = UPPER(f.set_code)
   WHERE f.lang = 'fr' AND bo.probability > 0
   LIMIT 1`
) as { fr: string; en: string; name: string; set_code: string } | undefined
if (pair) {
  const frOdds = boosterOddsFor(pair.fr, pair.set_code)
  const enOdds = boosterOddsFor(pair.en, pair.set_code)
  const same =
    JSON.stringify(frOdds.boosters.map((b) => [b.code, b.probability])) ===
    JSON.stringify(enOdds.boosters.map((b) => [b.code, b.probability]))
  console.log(`  ${pair.name} (${pair.set_code}):`, same ? 'identical OK' : 'DIFFERENT — FAILED')
  console.log('  marked as matched via English:', frOdds.via_english ? 'OK' : 'FAILED')
  console.log('  the English one is not marked:', enOdds.via_english ? 'FAILED' : 'OK')
  const best = frOdds.boosters.filter((b) => b.probability > 0)
  for (const b of best.slice(0, 3)) {
    console.log(`     ${b.name}: ${(b.probability * 100).toFixed(2)}%`)
  }
} else {
  console.log('  no French card with a priced English sibling in a fetched set')
}

console.log('\n--- the three states are exclusive ---')
const sample = db.all(
  `SELECT scryfall_id, name, set_code, in_boosters FROM printings
   WHERE in_boosters IS NOT NULL ORDER BY in_boosters LIMIT 400`
) as { scryfall_id: string; name: string; set_code: string; in_boosters: number }[]
let notListed = 0
let pending = 0
let known = 0
let withOddsAnyway = 0
for (const p of sample) {
  const o = boosterOddsFor(p.scryfall_id, p.set_code)
  if (o.fetched) known += 1
  else if (o.in_boosters === true) pending += 1
  else notListed += 1
  if (o.in_boosters === false) {
    // A false flag must NOT hide real odds: Scryfall sets it on the default
    // printing, so a showcase version reads false and is still pullable. Real
    // measured odds always win, which is what this asserts.
    if (o.boosters.some((b) => b.probability > 0)) withOddsAnyway += 1
  }
}
console.log(
  `  computed: ${known}, flagged in-boosters awaiting a fetch: ${pending}, not listed as booster cards: ${notListed}`
)
console.log(`  flagged "not a booster card" yet carrying real odds: ${withOddsAnyway}`)
console.log('    (these keep their odds rather than being hidden — the whole point of the fix)')

console.log('\n--- which sets a collection-wide fetch would touch ---')
const sets = collectionBoosterSets()
console.log(`  ${sets.length} sets hold booster cards you own; ${sets.filter((s) => s.fetched).length} already fetched`)
for (const s of sets.slice(0, 12)) {
  console.log(`     ${s.set_code.padEnd(5)} ${String(s.cards).padStart(4)} cards  ${s.fetched ? 'fetched' : '—'}`)
}
const allSets = (db.get('SELECT COUNT(DISTINCT set_code) AS n FROM printings') as { n: number }).n
console.log(`  (out of ${allSets} sets cached; the precon-only ones are deliberately skipped)`)

closeDb()
