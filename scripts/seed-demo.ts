/**
 * Seeds a database with a small multilingual sample, for eyeballing the UI.
 *
 * Pass the target data directory as the first argument. Point it at a throwaway
 * directory and launch the app with `--user-data-dir=<same dir>` to inspect the
 * result without touching a real collection.
 */
import { getDb, setDataDir } from '../src/main/db/connection.js'
import { addToPickList, createPickList } from '../src/main/db/repos/pickLists.js'
import { quickAdd } from '../src/main/services/addCards.js'
import { addDeckByUrl } from '../src/main/services/deckSync.js'
import type { Condition, Finish } from '../src/shared/types.js'

const SAMPLE: {
  set: string
  cn: string
  lang: string
  finish: Finish
  condition: Condition
  quantity: number
}[] = [
  { set: 'm10', cn: '146', lang: 'ja', finish: 'nonfoil', condition: 'NM', quantity: 12 },
  { set: 'm10', cn: '146', lang: 'fr', finish: 'foil', condition: 'LP', quantity: 3 },
  { set: 'm10', cn: '146', lang: 'en', finish: 'nonfoil', condition: 'NM', quantity: 8 },
  { set: 'tsp', cn: '227', lang: 'en', finish: 'nonfoil', condition: 'NM', quantity: 1 },
  { set: 'lea', cn: '54', lang: 'en', finish: 'nonfoil', condition: 'MP', quantity: 1 },
  { set: 'mh2', cn: '186', lang: 'de', finish: 'foil', condition: 'NM', quantity: 2 },
  { set: 'neo', cn: '227', lang: 'ja', finish: 'etched', condition: 'NM', quantity: 4 },
  { set: 'znr', cn: '254', lang: 'es', finish: 'nonfoil', condition: 'LP', quantity: 6 },
  { set: 'khm', cn: '253', lang: 'ru', finish: 'nonfoil', condition: 'NM', quantity: 5 },
  { set: 'dom', cn: '1', lang: 'it', finish: 'nonfoil', condition: 'NM', quantity: 2 },
  { set: 'war', cn: '3', lang: 'zhs', finish: 'nonfoil', condition: 'HP', quantity: 3 },
  { set: 'eld', cn: '269', lang: 'ko', finish: 'nonfoil', condition: 'NM', quantity: 1 }
]

async function main(): Promise<void> {
  const dir = process.argv[2]
  if (!dir) {
    console.error('Usage: node seed-demo.cjs <data-dir>')
    process.exitCode = 1
    return
  }
  setDataDir(dir)
  const db = getDb()

  let added = 0
  for (const entry of SAMPLE) {
    try {
      const result = await quickAdd({
        set: entry.set,
        collectorNumber: entry.cn,
        lang: entry.lang,
        finish: entry.finish,
        condition: entry.condition,
        quantity: entry.quantity
      })
      added += 1
      console.log(
        `  + ${entry.quantity}x ${result.printing.printed_name ?? result.printing.name}` +
          ` (${result.printing.lang}) ${result.printing.set_code.toUpperCase()} #${result.printing.collector_number}`
      )
    } catch (err) {
      console.log(`  ! ${entry.set} ${entry.cn} ${entry.lang} — ${(err as Error).message}`)
    }
  }
  console.log(`\nAdded ${added} of ${SAMPLE.length} sample rows.`)

  // A synced deck, so deck badges and the locations panel have something to show.
  try {
    const deck = await addDeckByUrl('1')
    console.log(`Synced deck: ${deck.name}`)
  } catch (err) {
    console.log(`Deck sync skipped: ${(err as Error).message}`)
  }

  // An open pick list, so reservations are visible in the collection view.
  const items = db.all(
    `SELECT ci.id FROM collection_items ci
     JOIN printings p ON p.scryfall_id = ci.scryfall_id
     WHERE p.lang IN ('ja','fr') ORDER BY ci.id LIMIT 2`
  ) as { id: number }[]
  if (items.length) {
    const listId = createPickList('Trade with Alice')
    for (const item of items) addToPickList(listId, item.id, 2)
    console.log(`Staged ${items.length} rows in an open pick list.`)
  }

  const totals = db.get(
    'SELECT COUNT(*) AS rows, COALESCE(SUM(quantity),0) AS cards FROM collection_items'
  ) as { rows: number; cards: number }
  console.log(`Database now holds ${totals.cards} cards across ${totals.rows} rows.`)
}

main().catch((err) => {
  console.error(err)
  process.exitCode = 1
})
