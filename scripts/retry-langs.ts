/**
 * Re-tries the cards that were recorded as having no printing in a language,
 * using the current resolution path. Reports how many now resolve, and how many
 * were only findable by searching every printing of the card.
 *
 *   npm run retry:langs -- <path-to-a-copy-of-the-userData-dir> [lang]
 */
import { getDb, setDataDir } from '../src/main/db/connection.js'
import { deckCardIdentities } from '../src/main/db/repos/decks.js'
import { setCardLanguage } from '../src/main/services/deckLanguage.js'

setDataDir(process.argv[2])
const lang = process.argv[3] ?? 'fr'

async function main(): Promise<void> {
  const pending = getDb().all(
    'SELECT deck_id, oracle_id FROM deck_card_lang_requests WHERE requested_lang = ?',
    [lang]
  ) as { deck_id: number; oracle_id: string }[]

  console.log(
    `${pending.length} card(s) previously reported as having no ${lang.toUpperCase()} printing\n`
  )

  let exact = 0
  let viaSearch = 0
  const stillMissing: string[] = []

  for (const row of pending) {
    const [card] = deckCardIdentities(row.deck_id, [row.oracle_id])
    if (!card) continue
    const outcome = await setCardLanguage(row.deck_id, card, lang)
    if (outcome.ok && outcome.viaSearch) {
      viaSearch += 1
      console.log(`  found by search   ${card.name}`)
    } else if (outcome.ok) {
      exact += 1
      console.log(`  found exactly     ${card.name}`)
    } else {
      stillMissing.push(card.name)
      console.log(`  still no ${lang.toUpperCase()}      ${card.name}`)
    }
  }

  console.log(
    `\nresolved ${exact + viaSearch} of ${pending.length} — ` +
      `${viaSearch} of them only findable by searching every printing`
  )
  if (stillMissing.length) console.log('still unavailable:', stillMissing.join(', '))
}

void main()
