/**
 * Read-only probe of the real deck data, run against a *copy* of the live
 * database. Prints what the Decks screen will show, so the counts can be checked
 * against Archidekt without clicking through the UI.
 *
 *   npm run probe:decks -- <path-to-db-dir>
 */
import { setDataDir } from '../src/main/db/connection.js'
import { deckBreakdown, listDecks } from '../src/main/db/repos/decks.js'

setDataDir(process.argv[2])

for (const deck of listDecks()) {
  const breakdown = deckBreakdown(deck.id, 'usd', false)
  if (!breakdown) continue
  const { totals, groups } = breakdown
  console.log(`\n${deck.name} — ${deck.format ?? '?'} (${deck.cardCount} cards reported)`)
  console.log(
    `  totals: ${totals.cards} cards / ${totals.entries} entries · ` +
      `${totals.ownedCards} owned + ${totals.missingCards} missing · ` +
      `in deck ${totals.inDeckCards}, outside ${totals.excludedCards}`
  )
  console.log(
    `  reconciles: owned+missing=${totals.ownedCards + totals.missingCards} ` +
      `(${totals.ownedCards + totals.missingCards === totals.cards ? 'OK' : 'MISMATCH'}), ` +
      `groups sum=${groups.reduce((s, g) => s + g.cardCount, 0)} ` +
      `(${groups.reduce((s, g) => s + g.cardCount, 0) === totals.cards ? 'OK' : 'MISMATCH'})`
  )
  for (const group of groups) {
    const tag = group.isPremier ? ' [PREMIER]' : group.inDeck ? '' : ' [not in deck]'
    console.log(
      `    ${group.name}${tag}: ${group.cardCount} cards ` +
        `(${group.ownedCards} owned, ${group.missingCards} missing)` +
        (group.isPremier ? ` → ${group.cards.map((c) => c.name).join(', ')}` : '')
    )
  }
  const biggest = groups
    .flatMap((g) => g.cards)
    .filter((c) => c.quantity > 1)
    .sort((a, b) => b.quantity - a.quantity)
    .slice(0, 3)
  for (const card of biggest) {
    console.log(`    x${card.quantity} ${card.name} → held ${card.held} (${card.sections.join(', ')})`)
  }
  console.log(`    labels: ${JSON.stringify(breakdown.labels)}`)
}
