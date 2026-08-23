/**
 * The finish split, against the real HOB data the bug was measured on.
 *
 *   npm run probe:thranduil -- <dataDir>
 */
import { closeDb, getDb, setDataDir } from '../src/main/db/connection.js'
import {
  boosterOddsFor,
  boosterSetInfo,
  loadBoosterOdds
} from '../src/main/services/boosterOdds.js'

const dir = process.argv[2]
if (!dir) throw new Error('usage: probe-thranduil <dataDir>')
setDataDir(dir)
const db = getDb()

async function main(): Promise<void> {
  await loadBoosterOdds('HOB', () => undefined)


  const rows = db.all(
    `SELECT scryfall_id, collector_number, finishes FROM printings
     WHERE set_code = 'hob' AND name LIKE '%Thranduil%' AND lang = 'en'
     ORDER BY CAST(collector_number AS INTEGER)`
  ) as { scryfall_id: string; collector_number: string; finishes: string }[]

  const pct = (n: number | null | undefined): string =>
    n === null || n === undefined ? '   —   ' : `${(n * 100).toFixed(3)}%`.padStart(8)

  for (const row of rows) {
    const odds = boosterOddsFor(row.scryfall_id, 'hob')
    console.log(`\n#${row.collector_number}  finishes=${row.finishes}`)
    for (const booster of odds.boosters) {
      const parts: string[] = []
      if (booster.nonfoil) parts.push(`nonfoil ${pct(booster.nonfoil.probability)}`)
      else parts.push('nonfoil  (not sold)')
      if (booster.foil) parts.push(`foil ${pct(booster.foil.probability)}`)
      else parts.push('foil  (not sold)')
      console.log(`   ${booster.name.padEnd(30)} ${parts.join('   ')}`)
    }
  }

  console.log('\n--- the invariant, summed across BOTH finishes ---')
  const set = boosterSetInfo('HOB')!
  const sums = new Map(
    (
      db.all(
        `SELECT booster, SUM(expected) AS total FROM booster_odds
         WHERE set_code = 'HOB' GROUP BY booster`
      ) as { booster: string; total: number }[]
    ).map((r) => [r.booster, r.total])
  )
  for (const booster of set.boosters) {
    const summed = sums.get(booster.code) ?? 0
    // Σ expected equals the picks per pack — but only over the cards we can name.
    // Sheets that pull from other sets carry no Scryfall id to join on, so the
    // shortfall should be exactly what `coverage` reports, and no more.
    const accounted = booster.cardsPerPack * booster.coverage
    const ok = Math.abs(summed - accounted) < 0.05
    console.log(
      `   ${booster.code.padEnd(12)} Σ expected ${summed.toFixed(4).padStart(9)}` +
        ` vs ${booster.cardsPerPack} picks × ${(booster.coverage * 100).toFixed(1)}% named` +
        ` = ${accounted.toFixed(4)}   ${ok ? 'OK' : 'MISMATCH'}`
    )
  }

  closeDb()
}

void main()
