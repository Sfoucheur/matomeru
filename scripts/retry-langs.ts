/**
 * Re-tries the cards that kept their printing because Scryfall had no version of it in
 * the language you asked for, in case it has one now.
 *
 *   npm run retry:langs -- <path-to-a-copy-of-the-userData-dir> [lang]
 *
 * It reads the declared languages rather than the old "no printing in that language"
 * flags. Those flags were what the deck path used to record on a miss; a miss now records
 * the language you hold the print in, which is a better source in two ways: it is written
 * for collection rows as well as deck entries, and it says what you claim rather than only
 * what could not be found.
 *
 * A card that resolves this time stops being a declaration and becomes a real printing —
 * `setCardLanguage` and the collection's own path both clear the assertion on success.
 */
import { getDb, setDataDir } from '../src/main/db/connection.js'
import { deckCardIdentities } from '../src/main/db/repos/decks.js'
import { setCardLanguage } from '../src/main/services/deckLanguage.js'
import { applyLanguageToItem } from '../src/main/services/collectionLanguage.js'

setDataDir(process.argv[2])
const lang = process.argv[3] ?? 'fr'

async function main(): Promise<void> {
  const db = getDb()
  const deckPending = db.all(
    `SELECT deck_id, oracle_id FROM deck_card_overrides WHERE forced_lang = ?
     UNION
     -- The flags the old path wrote. Nothing writes them any more, but a database that
     -- has been through both still carries them, and they mean the same thing.
     SELECT deck_id, oracle_id FROM deck_card_lang_requests WHERE requested_lang = ?`,
    [lang, lang]
  ) as { deck_id: number; oracle_id: string }[]
  const itemPending = db.all(
    'SELECT id FROM collection_items WHERE forced_lang = ?',
    [lang]
  ) as { id: number }[]

  const total = deckPending.length + itemPending.length
  console.log(
    `${total} card(s) holding a print with no ${lang.toUpperCase()} version — ` +
      `${deckPending.length} in decks, ${itemPending.length} in the collection\n`
  )

  let resolved = 0
  const stillMissing: string[] = []

  for (const row of deckPending) {
    const [card] = deckCardIdentities(row.deck_id, [row.oracle_id])
    if (!card) continue
    const outcome = await setCardLanguage(row.deck_id, card, lang)
    if (outcome === 'converted') {
      resolved += 1
      console.log(`  now exists        ${card.name}`)
    } else {
      stillMissing.push(card.name)
      console.log(`  still no ${lang.toUpperCase()}      ${card.name}`)
    }
  }

  for (const row of itemPending) {
    const named = db.get(
      `SELECT COALESCE(p.name, '?') AS name FROM collection_items ci
       LEFT JOIN printings p ON p.scryfall_id = ci.scryfall_id WHERE ci.id = ?`,
      [row.id]
    ) as { name: string } | undefined
    const name = named?.name ?? String(row.id)
    const outcome = await applyLanguageToItem(row.id, lang)
    if (outcome === 'converted') {
      resolved += 1
      console.log(`  now exists        ${name}`)
    } else {
      stillMissing.push(name)
      console.log(`  ${outcome.padEnd(16)}${name}`)
    }
  }

  console.log(`\nresolved ${resolved} of ${total}`)
  if (stillMissing.length) console.log('still declared:', stillMissing.join(', '))
}

void main()
