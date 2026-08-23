/**
 * End-to-end verification of the data layer against a real SQLite file and the
 * live Scryfall and Archidekt APIs.
 *
 * Runs in plain Node, no Electron — which is the point of injecting the data
 * directory rather than importing `electron` in the data layer.
 *
 *   npm run verify
 */
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, join as joinPath } from 'node:path'
import { closeDb, getDb, setDataDir } from '../src/main/db/connection.js'
import {
  addToCollection,
  cardLocations,
  forceItemLanguage,
  getItem,
  queryCollection,
  setItemPrinting,
  queryFacets,
  removeItem,
  updateItem,
  setQuantity
} from '../src/main/db/repos/collection.js'
import {
  addToPickList,
  cancelPickList,
  confirmPickList,
  createPickList,
  getPickListItems
} from '../src/main/db/repos/pickLists.js'
import {
  deckBreakdown,
  discoverLabelColors,
  recomputeLabelPossession,
  replaceDeckCards,
  upsertDeck
} from '../src/main/db/repos/decks.js'
import { getPrinting } from '../src/main/db/repos/printings.js'
import { parseLabel } from '../src/main/archidekt/mappers.js'
import {
  clampColumns,
  DEFAULT_DECK_FILTERS,
  DEFAULT_FILTERS,
  DEFAULT_GRID_COLUMNS,
  FOIL_TREATMENTS,
  foilTreatmentLabel,
  foilTreatmentOf,
  priceFor
} from '../src/shared/types.js'
import { collectionStats } from '../src/main/db/repos/stats.js'
import { getSettings, updateSettings } from '../src/main/db/repos/settings.js'
import { addCard, printingsFor, quickAdd, resolveQuick } from '../src/main/services/addCards.js'
import { fetchDeck, userByUsername } from '../src/main/archidekt/client.js'
import { addDeckByUrl } from '../src/main/services/deckSync.js'
import { toDeckCards, toDeckUpsert } from '../src/main/archidekt/mappers.js'
import {
  DEFAULT_DECK_FILTERS,
  DEFAULT_FILTERS,
  DEFAULT_PRINTING_FILTERS,
  effectiveFinishFor,
  NO_LABEL,
  type CollectionFilters,
  type DeckBreakdown,
  type DeckCardRow,
  type Finish
} from '../src/shared/types.js'
import { colorRank, matchesDeckFilters, sortDeckCards } from '../src/renderer/lib/deckFilter.js'
import {
  matchesPrintingFilters,
  printingFacets,
  printingFiltersEmpty
} from '../src/renderer/lib/printingFilter.js'
import {
  clearCardOverride,
  setCardFinish,
  setCardProxied,
  clearLanguageMiss,
  deckCardIdentities,
  forceCardLanguage,
  recordLanguageMiss,
  setCardOverride,
  setCardPrinting,
  setDeckDefaultLang
} from '../src/main/db/repos/decks.js'
import { buildDeckBody, buildDeckSections, FLAT_GROUP_NAME } from '../src/renderer/lib/deckGroups.js'
import { createThrottledBroadcaster } from '../src/main/ipc/progressThrottle.js'
import {
  boosterOddsFor,
  boosterSetInfo,
  collectionBoosterSets,
  computeBoosterOdds,
  loadBoosterOdds,
  oddsKey
} from '../src/main/services/boosterOdds.js'
// Aliased: `en` and `fr` are already local names in this script for the English
// and French printings of a card.
import { en as enDict } from '../src/shared/i18n/en.js'
import { fr as frDict } from '../src/shared/i18n/fr.js'
import { resolveLocale, t, tp } from '../src/shared/i18n/index.js'
import type { ProgressEvent } from '../src/shared/types.js'

let passed = 0
let failed = 0
const failures: string[] = []

function check(label: string, condition: boolean, detail?: string): void {
  if (condition) {
    passed += 1
    console.log(`  PASS  ${label}`)
  } else {
    failed += 1
    failures.push(label)
    console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`)
  }
}

/**
 * Every card in a deck, flattened out of its groups.
 *
 * The breakdown no longer hands back owned/missing arrays: each card is assigned
 * to exactly one group so the group totals sum to the deck total, and ownership
 * is a property of the card rather than which array it landed in.
 */
function allDeckCards(breakdown: DeckBreakdown | null): DeckCardRow[] {
  return (breakdown?.groups ?? []).flatMap((group) => group.cards)
}

function section(title: string): void {
  console.log(`\n${title}`)
  console.log('-'.repeat(title.length))
}

const filters = (patch: Partial<CollectionFilters> = {}): CollectionFilters => ({
  ...DEFAULT_FILTERS,
  ...patch
})

async function main(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'matomeru-verify-'))
  setDataDir(dir)
  const db = getDb()
  console.log(`Scratch database: ${join(dir, 'matomeru.db')}`)

  // ---------------------------------------------------------------- migrations
  section('Schema')
  const tables = (
    db.all("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name") as {
      name: string
    }[]
  ).map((r) => r.name)
  for (const table of [
    'printings',
    'collection_items',
    'pick_lists',
    'pick_list_items',
    'decks',
    'deck_cards',
    'settings'
  ]) {
    check(`table ${table} exists`, tables.includes(table))
  }

  // ------------------------------------------------------------- language path
  section('Language handling (live Scryfall)')

  // The set/number/language route is the only one that honours language.
  const ja = await resolveQuick('m10', '146', 'ja')
  check('resolved m10 146 ja', !!ja, 'lookup returned null')
  check('language is ja', ja?.lang === 'ja', `got ${ja?.lang}`)
  check(
    'printed_name is the localized title',
    !!ja?.printed_name && ja.printed_name !== ja.name,
    `printed_name=${ja?.printed_name}`
  )
  console.log(`        → ${ja?.printed_name} / ${ja?.name} (${ja?.lang})`)

  const fr = await resolveQuick('m10', '146', 'fr')
  check('resolved m10 146 fr', !!fr && fr.lang === 'fr', `got ${fr?.lang}`)
  check(
    'ja and fr are distinct printings',
    !!ja && !!fr && ja.scryfall_id !== fr.scryfall_id,
    'same scryfall_id for two languages'
  )
  console.log(`        → ${fr?.printed_name} / ${fr?.name} (${fr?.lang})`)

  const en = await resolveQuick('m10', '146', 'en')
  check('resolved m10 146 en', !!en && en.lang === 'en')
  check('English printing has no printed_name', en?.printed_name === null)

  // All printings in all languages, via include_multilingual.
  const allPrintings = await printingsFor('Lightning Bolt')
  const langs = new Set(allPrintings.map((p) => p.lang))
  check(
    'printing picker returns many languages',
    langs.size >= 5,
    `only ${langs.size}: ${[...langs].join(',')}`
  )
  console.log(`        → ${allPrintings.length} printings across ${langs.size} languages`)

  // --------------------------------------------------------------- quantities
  section('Quantities and the UNIQUE merge')

  const added1 = await quickAdd({
    set: 'm10',
    collectorNumber: '146',
    lang: 'ja',
    finish: 'nonfoil',
    condition: 'NM',
    quantity: 7
  })
  const added2 = await quickAdd({
    set: 'm10',
    collectorNumber: '146',
    lang: 'ja',
    finish: 'nonfoil',
    condition: 'NM',
    quantity: 5
  })
  check('re-adding merges into one row', added1.itemId === added2.itemId, 'created a second row')

  const jaItemId = added1.itemId
  const jaRow = (
    db.get('SELECT quantity FROM collection_items WHERE id = ?', [jaItemId]) as {
      quantity: number
    }
  ).quantity
  check('quantities summed to 12', jaRow === 12, `got ${jaRow}`)

  // A different condition is a genuinely different row.
  await quickAdd({
    set: 'm10',
    collectorNumber: '146',
    lang: 'ja',
    finish: 'nonfoil',
    condition: 'MP',
    quantity: 2
  })
  const jaRowCount = (
    db.get(
      "SELECT COUNT(*) AS c FROM collection_items ci JOIN printings p ON p.scryfall_id = ci.scryfall_id WHERE p.lang = 'ja'",
      []
    ) as { c: number }
  ).c
  check('different condition creates a separate row', jaRowCount === 2, `got ${jaRowCount} rows`)

  await quickAdd({
    set: 'm10',
    collectorNumber: '146',
    lang: 'fr',
    finish: 'foil',
    condition: 'NM',
    quantity: 3
  })
  await quickAdd({
    set: 'm10',
    collectorNumber: '146',
    lang: 'en',
    finish: 'nonfoil',
    condition: 'NM',
    quantity: 4
  })

  // ------------------------------------------------------------------ searching
  section('Search and filtering')

  const byEnglishName = queryCollection(filters({ search: 'Lightning Bolt' }), 'usd', 100, 0)
  check('English name finds every language', byEnglishName.total === 4, `got ${byEnglishName.total}`)

  const localized = ja?.printed_name ?? ''
  const byLocalized = queryCollection(filters({ search: localized }), 'usd', 100, 0)
  check(
    `localized name "${localized}" finds the JA rows`,
    byLocalized.total === 2,
    `got ${byLocalized.total}`
  )

  const jaOnly = queryCollection(filters({ langs: ['ja'] }), 'usd', 100, 0)
  const jaSql = (
    db.get(
      `SELECT COALESCE(SUM(ci.quantity),0) AS q FROM collection_items ci
       JOIN printings p ON p.scryfall_id = ci.scryfall_id WHERE p.lang = 'ja'`
    ) as { q: number }
  ).q
  check(
    'lang filter matches a hand-written SQL count',
    jaOnly.totalQuantity === jaSql,
    `view=${jaOnly.totalQuantity} sql=${jaSql}`
  )

  const commonJa = queryCollection(filters({ langs: ['ja'], rarities: ['common'] }), 'usd', 100, 0)
  check('lang + rarity filter narrows correctly', commonJa.total === 2, `got ${commonJa.total}`)

  const foilOnly = queryCollection(filters({ finishes: ['foil'] }), 'usd', 100, 0)
  check('finish filter works', foilOnly.total === 1, `got ${foilOnly.total}`)

  const facets = queryFacets(filters(), 'usd')
  check(
    'facets report every language present',
    facets.langs.length === 3,
    `got ${facets.langs.map((l) => l.value).join(',')}`
  )

  // ------------------------------------------------------------- picking lists
  section('Pick list: reserve, then validate')

  const listId = createPickList('Trade with Alice')
  const staged = addToPickList(listId, jaItemId, 5)
  check('staged 5 copies', staged.added === 5, `added ${staged.added}`)

  const afterStage = queryCollection(filters({ langs: ['ja'] }), 'usd', 100, 0)
  const stagedRow = afterStage.rows.find((r) => r.id === jaItemId)
  check('collection quantity is untouched at 12', stagedRow?.quantity === 12, `got ${stagedRow?.quantity}`)
  check('5 copies show as reserved', stagedRow?.reserved === 5, `got ${stagedRow?.reserved}`)
  check('available dropped to 7', stagedRow?.available === 7, `got ${stagedRow?.available}`)

  const dbQuantityWhileOpen = (
    db.get('SELECT quantity FROM collection_items WHERE id = ?', [jaItemId]) as { quantity: number }
  ).quantity
  check(
    'the database itself still says 12 while the list is open',
    dbQuantityWhileOpen === 12,
    `got ${dbQuantityWhileOpen}`
  )

  // Over-picking is capped at what is actually available.
  const over = addToPickList(listId, jaItemId, 99)
  check('over-picking is capped, not rejected', over.added === 7 && over.capped, `added ${over.added}`)
  const capped = addToPickList(listId, jaItemId, 1)
  check('nothing left to stage once fully reserved', capped.added === 0)

  // Guard: the collection cannot be reduced below what is reserved.
  let guarded = false
  try {
    setQuantity(jaItemId, 3)
  } catch {
    guarded = true
  }
  check('cannot drop quantity below the reserved amount', guarded)

  let deleteGuarded = false
  try {
    removeItem(jaItemId)
  } catch {
    deleteGuarded = true
  }
  check('cannot delete a row with open reservations', deleteGuarded)

  // Cancel releases everything and leaves the collection alone.
  cancelPickList(listId)
  const afterCancel = (
    db.get('SELECT quantity FROM collection_items WHERE id = ?', [jaItemId]) as { quantity: number }
  ).quantity
  check('cancel leaves the quantity at 12', afterCancel === 12, `got ${afterCancel}`)
  const cancelledRow = queryCollection(filters({ langs: ['ja'] }), 'usd', 100, 0).rows.find(
    (r) => r.id === jaItemId
  )
  check('cancel releases every reservation', cancelledRow?.reserved === 0, `got ${cancelledRow?.reserved}`)

  // Confirm actually moves the quantity, exactly once.
  const listId2 = createPickList('Sell pile')
  addToPickList(listId2, jaItemId, 5)
  const confirmed = confirmPickList(listId2)
  check('confirm reports 5 cards removed', confirmed.cardsRemoved === 5, `got ${confirmed.cardsRemoved}`)
  const afterConfirm = (
    db.get('SELECT quantity FROM collection_items WHERE id = ?', [jaItemId]) as { quantity: number }
  ).quantity
  check('quantity went 12 → 7', afterConfirm === 7, `got ${afterConfirm}`)

  let doubleConfirm = false
  try {
    confirmPickList(listId2)
  } catch {
    doubleConfirm = true
  }
  check('a confirmed list cannot be confirmed twice', doubleConfirm)

  const historyItems = getPickListItems(listId2, 'usd')
  check('confirmed list is kept as history', historyItems.length === 1)
  check(
    'history still names the card via its snapshot',
    historyItems[0]?.printed_name === ja?.printed_name,
    `got ${historyItems[0]?.printed_name}`
  )

  // Emptying a row deletes it but the history survives.
  const listId3 = createPickList('Empty it out')
  addToPickList(listId3, jaItemId, 7)
  const emptied = confirmPickList(listId3)
  check('emptying deletes the collection row', emptied.rowsDeleted === 1, `got ${emptied.rowsDeleted}`)
  const goneRow = db.get('SELECT quantity FROM collection_items WHERE id = ?', [jaItemId])
  check('the row is really gone', goneRow === undefined || goneRow === null)
  const orphanHistory = getPickListItems(listId3, 'usd')
  check(
    'history reads correctly after the row is gone',
    orphanHistory.length === 1 && orphanHistory[0].name.length > 0 && orphanHistory[0].owned_quantity === null,
    `owned_quantity=${orphanHistory[0]?.owned_quantity}`
  )

  // ------------------------------------------------------------------ decks
  section('Archidekt deck mapping and matching (live)')

  const user = await userByUsername('gategeek42')
  check('username lookup works', !!user && typeof user.id === 'number', 'no user returned')
  check('user response lists decks', (user?.decks?.length ?? 0) > 0)
  if (user) {
    console.log(
      `        → user ${user.id}, deckCount ${user.deckCount}, ${user.decks.length} listed` +
        (user.deckCount > user.decks.length
          ? ` (${user.deckCount - user.decks.length} private/hidden)`
          : '')
    )
  }

  const archidektDeck = await fetchDeck(1)
  check('deck fetch works', !!archidektDeck && archidektDeck.cards.length > 0)

  if (archidektDeck) {
    // Go through the real entry point so printing caching runs exactly as it
    // does in the app — deck cards need a cached printing for images, prices,
    // and to be addable to the collection at all.
    const added = await addDeckByUrl('https://archidekt.com/decks/1/fun-with-fungus')
    const deckId = added.deckId
    const cards = toDeckCards(archidektDeck)
    check('addDeckByUrl parses a full URL', added.name === archidektDeck.name, `got ${added.name}`)

    const uncached = (
      db.get(
        `SELECT COUNT(*) AS c FROM deck_cards dc
         LEFT JOIN printings p ON p.scryfall_id = dc.scryfall_id
         WHERE dc.deck_id = ? AND dc.scryfall_id IS NOT NULL AND p.scryfall_id IS NULL`,
        [deckId]
      ) as { c: number }
    ).c
    check('deck sync caches a printing for every deck card', uncached === 0, `${uncached} uncached`)

    check(
      'every deck card carries a scryfall printing id',
      cards.every((c) => !!c.scryfall_id),
      'some card.uid was missing'
    )
    check(
      'every deck card carries an oracle id',
      cards.every((c) => !!c.oracle_id),
      'some oracleCard.uid was missing'
    )
    check('deck cards have real names', cards.every((c) => c.name !== 'Unknown card'))
    console.log(`        → "${archidektDeck.name}": ${cards.length} entries mapped`)

    // Re-syncing must replace rather than duplicate.
    replaceDeckCards(deckId, cards)
    const deckCardCount = (
      db.get('SELECT COUNT(*) AS c FROM deck_cards WHERE deck_id = ?', [deckId]) as { c: number }
    ).c
    check('re-syncing replaces rather than duplicates', deckCardCount === cards.length, `got ${deckCardCount}`)

    // The whole reason a finish override lives in `deck_card_overrides` rather
    // than on `deck_cards`: replaceDeckCards deletes and reinserts every row on
    // each sync, so anything stored there would silently vanish.
    {
      const target = cards.find((c) => c.oracle_id && c.finish === 'nonfoil')
      if (target?.oracle_id) {
        setCardFinish(deckId, target.oracle_id, 'foil', 'surgefoil')
        const readBack = (): { finish: string; treatment: string | null } | undefined =>
          db.get(
            'SELECT finish, foil_treatment AS treatment FROM deck_card_overrides WHERE deck_id = ? AND oracle_id = ?',
            [deckId, target.oracle_id]
          ) as { finish: string; treatment: string | null } | undefined
        const before = readBack()
        replaceDeckCards(deckId, cards)
        const after = readBack()
        check(
          'a finish you set survives a deck re-sync',
          !!after && after.finish === 'foil' && after.treatment === 'surgefoil',
          JSON.stringify({ before, after })
        )
        // And the sync did not resurrect Archidekt's own value on top of it.
        const effective = db.get(
          `SELECT COALESCE(o.finish, dc.finish) AS finish
           FROM deck_cards dc
           LEFT JOIN deck_card_overrides o
                  ON o.deck_id = dc.deck_id AND o.oracle_id = dc.oracle_id
           WHERE dc.deck_id = ? AND dc.oracle_id = ?
           LIMIT 1`,
          [deckId, target.oracle_id]
        ) as { finish: string } | undefined
        check('and it is still the effective finish afterwards', effective?.finish === 'foil')
        setCardFinish(deckId, target.oracle_id, null, null)
      } else {
        console.log('        → no nonfoil entry to test override survival')
      }
    }

    // A proxy fills its slot: playable, so the deck reads complete and the card
    // leaves the Missing pile. And like the finish, the flag has to survive the
    // sync that rebuilds every deck_cards row.
    {
      const cards0 = (deckBreakdown(deckId, 'usd', false)?.groups ?? []).flatMap((g) => g.cards)
      const short = cards0.find((c) => c.oracle_id && c.held < c.quantity)
      if (short?.oracle_id) {
        setCardProxied(deckId, short.oracle_id, true)
        const after = (deckBreakdown(deckId, 'usd', false)?.groups ?? [])
          .flatMap((g) => g.cards)
          .find((c) => c.id === short.id)
        check(
          'a proxied deck entry counts as held',
          !!after && after.proxied && after.held >= after.quantity,
          JSON.stringify({ held: after?.held, need: after?.quantity, proxied: after?.proxied })
        )

        const totals = deckBreakdown(deckId, 'usd', false)!.totals
        check(
          'so it is no longer part of the missing pile',
          !(deckBreakdown(deckId, 'usd', false)?.groups ?? [])
            .flatMap((g) => g.missing ?? [])
            .some((c) => c.id === short.id),
          JSON.stringify({ missingCards: totals.missingCards })
        )

        replaceDeckCards(deckId, cards)
        const resynced = (deckBreakdown(deckId, 'usd', false)?.groups ?? [])
          .flatMap((g) => g.cards)
          .find((c) => c.oracle_id === short.oracle_id)
        check(
          'and the flag survives a deck re-sync',
          !!resynced && resynced.proxied,
          JSON.stringify({ proxied: resynced?.proxied })
        )
        setCardProxied(deckId, short.oracle_id, false)
      } else {
        console.log('        → no short deck entry to test the proxy slot')
      }
    }

    const sameDeckId = upsertDeck(toDeckUpsert(archidektDeck))
    check('upserting the same deck reuses its row', sameDeckId === deckId)

    // --- the two-tier match: own the JA printing of a card the deck lists in EN
    const target = cards.find((c) => c.oracle_id && c.scryfall_id)
    if (target?.oracle_id) {
      const englishOfTarget = target.scryfall_id as string

      // Find a different-language printing of the same card, then own only that.
      const otherLang = (
        db.all(
          `SELECT scryfall_id, lang FROM printings WHERE oracle_id = ? AND scryfall_id != ? LIMIT 1`,
          [target.oracle_id, englishOfTarget]
        ) as { scryfall_id: string; lang: string }[]
      )[0]

      // Nothing else cached for that oracle id yet, so fetch the deck's own
      // printing and confirm exact matching behaves.
      addToCollection({
        scryfall_id: englishOfTarget,
        finish: 'nonfoil',
        condition: 'NM',
        quantity: target.quantity
      })

      const exact = deckBreakdown(deckId, 'usd', true)
      const exactCards = allDeckCards(exact)
      const ownedExact = exactCards.find(
        (c) => c.scryfall_id === englishOfTarget && c.held >= c.quantity
      )
      check(
        'exact matching counts the identical printing as owned',
        !!ownedExact,
        'card was not reported as held'
      )
      check(
        'the breakdown lists every deck entry exactly once',
        exactCards.length === cards.length,
        `${exactCards.length} != ${cards.length}`
      )
      check(
        'missing pile is priced',
        (exact?.totals.missingValue ?? -1) >= 0,
        `got ${exact?.totals.missingValue}`
      )

      // The counting bug this replaced: totals were row counts, so a deck with a
      // "Forest x8" entry reported 8 fewer cards than its own header claimed.
      const totals = exact!.totals
      check(
        'owned + missing cards account for every card',
        totals.ownedCards + totals.missingCards === totals.cards,
        `${totals.ownedCards} + ${totals.missingCards} != ${totals.cards}`
      )
      check(
        'totals count cards, not rows',
        totals.cards === cards.reduce((sum, c) => sum + c.quantity, 0) &&
          totals.entries === cards.length,
        `cards=${totals.cards} entries=${totals.entries} rows=${cards.length}`
      )
      check(
        'in-deck and excluded cards account for every card',
        totals.inDeckCards + totals.excludedCards === totals.cards,
        `${totals.inDeckCards} + ${totals.excludedCards} != ${totals.cards}`
      )
      check(
        'group card counts sum to the deck total, so no card is counted twice',
        exact!.groups.reduce((sum, g) => sum + g.cardCount, 0) === totals.cards,
        'a multi-category card is being counted in more than one group'
      )
      check(
        'each card names exactly one owning group, and that group exists',
        exactCards.every((card) => exact!.groups.some((g) => g.name === card.group)),
        'a card points at a group the breakdown does not report'
      )
      if (otherLang) {
        console.log(`        → also cached a ${otherLang.lang} printing of the same card`)
      }
    }

    // The JA/FR/EN Lightning Bolts are already in the collection; check that a
    // deck listing the English one reports an oracle match for the JA copy.
    const boltOracle = (
      db.get("SELECT oracle_id FROM printings WHERE lang = 'ja' AND set_code = 'm10'") as {
        oracle_id: string
      } | undefined
    )?.oracle_id
    if (boltOracle && en) {
      db.run(
        `INSERT INTO deck_cards (deck_id, scryfall_id, oracle_id, quantity, finish, categories,
           in_maindeck, name, lang, set_code, collector_number, rarity)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
        [deckId, en.scryfall_id, boltOracle, 1, 'nonfoil', '[]', 1, 'Lightning Bolt', 'en', 'm10', '146', 'common']
      )

      const frLocations = fr ? cardLocations(fr.scryfall_id) : null
      const match = frLocations?.decks.find((d) => d.deck_id === deckId)
      check(
        'a French copy of an English deck card reports an "other printing" match',
        match?.match === 'oracle',
        `got ${match?.match ?? 'no match'}`
      )

      const enLocations = cardLocations(en.scryfall_id)
      const exactMatch = enLocations?.decks.find((d) => d.deck_id === deckId)
      check(
        'the English copy reports an exact match',
        exactMatch?.match === 'exact',
        `got ${exactMatch?.match ?? 'no match'}`
      )
    }

    // --- the inventory boundary
    const beforeSync = db.all(
      'SELECT id, scryfall_id, quantity FROM collection_items ORDER BY id'
    )
    const valueBefore = collectionStats().totalValue
    replaceDeckCards(deckId, cards)
    upsertDeck(toDeckUpsert(archidektDeck))
    const afterSync = db.all(
      'SELECT id, scryfall_id, quantity FROM collection_items ORDER BY id'
    )
    check(
      'a deck sync never changes collection quantities',
      JSON.stringify(beforeSync) === JSON.stringify(afterSync),
      'collection rows changed during a deck sync'
    )
    check(
      'a deck sync never changes total value',
      Math.abs(collectionStats().totalValue - valueBefore) < 0.001
    )

    // --- deck filters
    const inDeck = queryCollection(filters({ deckScope: 'in' }), 'usd', 200, 0)
    const outOfDeck = queryCollection(filters({ deckScope: 'out' }), 'usd', 200, 0)
    const everything = queryCollection(filters(), 'usd', 200, 0)
    check(
      'in-deck plus not-in-deck accounts for the whole collection',
      inDeck.total + outOfDeck.total === everything.total,
      `${inDeck.total} + ${outOfDeck.total} != ${everything.total}`
    )
    check('the in-a-deck filter finds something', inDeck.total > 0)

    const byDeckId = queryCollection(filters({ deckScope: deckId }), 'usd', 200, 0)
    check('filtering by a specific deck works', byDeckId.total > 0, `got ${byDeckId.total}`)
  }

  // ------------------------------------------------- migration 2 / printed text
  section('Migration 2: printed text and deck labels')

  const printingCols = (db.all('PRAGMA table_info(printings)') as { name: string }[]).map(
    (c) => c.name
  )
  check('printings.printed_text exists', printingCols.includes('printed_text'))

  const deckCardCols = (db.all('PRAGMA table_info(deck_cards)') as { name: string }[]).map(
    (c) => c.name
  )
  check('deck_cards.label exists', deckCardCols.includes('label'))
  check(
    'deck_cards.label_possession replaced not_owned',
    deckCardCols.includes('label_possession') && !deckCardCols.includes('not_owned'),
    deckCardCols.join(',')
  )

  // Simulate a pre-migration row by clearing the column, then re-run exactly the
  // statement the migration uses, to prove the backfill works on existing data.
  db.run("UPDATE printings SET printed_text = NULL WHERE lang = 'ja'")
  db.run(
    `UPDATE printings SET printed_text = json_extract(raw_json, '$.printed_text')
     WHERE raw_json IS NOT NULL`
  )
  const jaText = db.get(
    "SELECT printed_text, oracle_text FROM printings WHERE lang = 'ja' AND set_code = 'm10'"
  ) as { printed_text: string | null; oracle_text: string | null } | undefined
  check(
    'printed_text backfills from raw_json',
    !!jaText?.printed_text,
    `got ${JSON.stringify(jaText?.printed_text)}`
  )
  check(
    'localized rules text differs from the English oracle text',
    jaText?.printed_text !== jaText?.oracle_text
  )
  console.log(`        -> JA rules: ${jaText?.printed_text?.slice(0, 30)}...`)

  // ------------------------------------------------------------- label parsing
  section('Archidekt label parsing')

  const namedLabel = parseLabel('Do not Have,#F47373')
  check(
    'parses a named label and lowercases the colour',
    namedLabel.name === 'Do not Have' && namedLabel.color === '#f47373',
    JSON.stringify(namedLabel)
  )
  const unnamedLabel = parseLabel(',#656565')
  check(
    'parses an unnamed label (the common case)',
    unnamedLabel.name === null && unnamedLabel.color === '#656565',
    JSON.stringify(unnamedLabel)
  )
  const commaLabel = parseLabel('Need, maybe,#abc')
  check(
    'a label name containing a comma still parses',
    commaLabel.name === 'Need, maybe' && commaLabel.color === '#abc',
    JSON.stringify(commaLabel)
  )
  const colorlessLabel = parseLabel('Wishlist')
  check(
    'a label with no colour keeps its name',
    colorlessLabel.name === 'Wishlist' && colorlessLabel.color === null,
    JSON.stringify(colorlessLabel)
  )
  check(
    'empty and null labels parse to nulls',
    parseLabel('').color === null && parseLabel(null).name === null
  )

  // ------------------------------------------------- the "not owned" behaviour
  section('Label colours that mean "I do not own this"')

  if (archidektDeck && en && fr) {
    const deckId2 = (
      db.get("SELECT id FROM decks WHERE source = 'archidekt' AND external_id = '1'") as {
        id: number
      }
    ).id

    // Add a labelled deck entry for a card we own. Note this cannot reuse the
    // row added earlier in the deck section: the inventory-boundary check calls
    // replaceDeckCards, which wipes a deck's rows wholesale by design.
    const enOracle = (
      db.get('SELECT oracle_id FROM printings WHERE scryfall_id = ?', [en.scryfall_id]) as {
        oracle_id: string | null
      }
    ).oracle_id
    db.run(
      `INSERT INTO deck_cards (deck_id, scryfall_id, oracle_id, quantity, finish, categories,
         in_maindeck, name, lang, set_code, collector_number, rarity, label)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        deckId2,
        en.scryfall_id,
        enOracle,
        1,
        'nonfoil',
        '[]',
        1,
        'Lightning Bolt',
        'en',
        'm10',
        '146',
        'common',
        'Do not Have,#F47373'
      ]
    )

    const discovered = discoverLabelColors({})
    const hit = discovered.find((c) => c.color === '#f47373')
    check('the colour is discovered by scanning synced decks', !!hit, 'colour not discovered')
    check('the discovered colour carries its label name', hit?.name === 'Do not Have', `got ${hit?.name}`)
    check('the discovered colour reports usage counts', (hit?.cardCount ?? 0) > 0)

    const before = cardLocations(en.scryfall_id)
    check(
      'before marking, the deck counts as a location',
      !!before?.decks.find((d) => d.deck_id === deckId2),
      'deck was not a location to begin with'
    )
    const inBefore = queryCollection(filters({ deckScope: 'in' }), 'usd', 200, 0).total

    const flagged = recomputeLabelPossession({ '#f47373': 'not_owned' })
    check('marking the colour flags the deck row', flagged.notOwned > 0, JSON.stringify(flagged))

    const after = cardLocations(en.scryfall_id)
    check(
      'a not-owned card drops out of cardLocations',
      !after?.decks.find((d) => d.deck_id === deckId2),
      'deck still listed as a location'
    )

    const enRow = queryCollection(
      filters({ search: 'Lightning Bolt', langs: ['en'] }),
      'usd',
      50,
      0
    ).rows[0]
    check('its deck badge count drops to zero', enRow?.deck_count === 0, `got ${enRow?.deck_count}`)

    const looseAfter = queryCollection(filters({ deckScope: 'out' }), 'usd', 200, 0)
    check(
      'the card now matches "not in any deck (loose bulk)"',
      looseAfter.rows.some((r) => r.scryfall_id === en.scryfall_id),
      'card missing from the loose-bulk filter'
    )
    const inAfter = queryCollection(filters({ deckScope: 'in' }), 'usd', 200, 0).total
    check('the in-a-deck filter shrank', inAfter < inBefore, `${inBefore} -> ${inAfter}`)

    check(
      'filtering by that specific deck no longer returns the card',
      !queryCollection(filters({ deckScope: deckId2 }), 'usd', 200, 0).rows.some(
        (r) => r.scryfall_id === en.scryfall_id
      )
    )

    // The flag governs *location*, not whether the deck lists the card.
    const flaggedBreakdown = deckBreakdown(deckId2, 'usd', false)
    const listed = allDeckCards(flaggedBreakdown).find(
      (c) => c.scryfall_id === en.scryfall_id
    )
    check(
      'the deck breakdown still lists the card, flagged not_owned',
      !!listed && listed.label_possession === 'not_owned',
      `listed=${!!listed} possession=${listed?.label_possession}`
    )
    check(
      'the flagged row exposes its parsed label',
      listed?.label_color === '#f47373' && listed?.label_name === 'Do not Have',
      `${listed?.label_name} / ${listed?.label_color}`
    )
    check(
      'the conflict case is reportable: flagged, yet owned',
      (listed?.owned_exact ?? 0) > 0,
      'expected owned copies to report alongside the flag'
    )

    const statsFlagged = collectionStats()
    check(
      'stats still balance with labels active',
      statsFlagged.inDecks + statsFlagged.notInDecks === statsFlagged.totalCards,
      `${statsFlagged.inDecks} + ${statsFlagged.notInDecks} != ${statsFlagged.totalCards}`
    )

    // Unmarking restores everything, purely locally.
    recomputeLabelPossession({})
    check(
      'unmarking restores the deck as a location, with no re-sync',
      !!cardLocations(en.scryfall_id)?.decks.find((d) => d.deck_id === deckId2),
      'deck did not come back'
    )
    check(
      'the in-a-deck count is restored exactly',
      queryCollection(filters({ deckScope: 'in' }), 'usd', 200, 0).total === inBefore
    )

    const quantitiesNow = JSON.stringify(
      db.all('SELECT id, scryfall_id, quantity FROM collection_items ORDER BY id')
    )
    recomputeLabelPossession({ '#f47373': 'not_owned' })
    recomputeLabelPossession({})
    check(
      'flagging and unflagging never touches collection quantities',
      quantitiesNow ===
        JSON.stringify(db.all('SELECT id, scryfall_id, quantity FROM collection_items ORDER BY id'))
    )
  }

  // ---------------------------------------- "owned" labels as collection copies
  section('Label colours that mean "I own this"')

  if (archidektDeck && en) {
    const deckId3 = (
      db.get("SELECT id FROM decks WHERE source = 'archidekt' AND external_id = '1'") as {
        id: number
      }
    ).id

    // Baseline with nothing tagged owned. This is the property that lets the rest
    // of the suite stand: the union adds nothing until a colour is opted in.
    recomputeLabelPossession({})
    const baseline = queryCollection(filters(), 'usd', 500, 0)
    const baselineSql = (
      db.get('SELECT COALESCE(SUM(quantity),0) AS q FROM collection_items WHERE quantity > 0') as {
        q: number
      }
    ).q
    check(
      'with nothing tagged "own", totals match collection_items exactly',
      baseline.totalQuantity === baselineSql,
      `view=${baseline.totalQuantity} sql=${baselineSql}`
    )
    check('and no derived rows exist', baseline.deckQuantity === 0)
    check(
      'every baseline row is a real collection row',
      baseline.rows.every((r) => r.source === 'collection' && r.id !== null)
    )

    // Pick a deck card we do NOT already own, so the effect is unambiguous.
    const fresh = db.get(
      `SELECT dc.scryfall_id, dc.quantity, dc.name, dc.finish FROM deck_cards dc
       WHERE dc.deck_id = ? AND dc.scryfall_id IS NOT NULL
         AND NOT EXISTS (SELECT 1 FROM collection_items ci WHERE ci.scryfall_id = dc.scryfall_id)
       LIMIT 1`,
      [deckId3]
    ) as { scryfall_id: string; quantity: number; name: string; finish: Finish } | undefined

    if (fresh) {
      db.run('UPDATE deck_cards SET label = ? WHERE deck_id = ? AND scryfall_id = ?', [
        'Have it,#4CAF50',
        deckId3,
        fresh.scryfall_id
      ])
      const marked = recomputeLabelPossession({ '#4caf50': 'owned' })
      check('marking a colour "own" flags the row', marked.owned > 0, JSON.stringify(marked))

      const withDeck = queryCollection(filters(), 'usd', 500, 0)
      check(
        'the total rises by exactly the deck quantity',
        withDeck.totalQuantity === baseline.totalQuantity + fresh.quantity,
        `${baseline.totalQuantity} + ${fresh.quantity} != ${withDeck.totalQuantity}`
      )
      check(
        'the bulk figure is unchanged',
        withDeck.bulkQuantity === baseline.totalQuantity,
        `got ${withDeck.bulkQuantity}`
      )
      check('the deck figure reports the derived copies', withDeck.deckQuantity === fresh.quantity)

      const derived = withDeck.rows.find((r) => r.scryfall_id === fresh.scryfall_id)
      check('it appears as a row', !!derived, `${fresh.name} not listed`)
      check('the row is marked as derived', derived?.source === 'deck', `got ${derived?.source}`)
      check('a derived row has no id, so nothing can edit it', derived?.id === null)
      check('a derived row is not available to pull', derived?.available === 0)
      check('a derived row names the deck it is sleeved in', (derived?.deck_names.length ?? 0) > 0)
      check('a derived row has no condition', derived?.condition === null)

      // A language override changes which printing the deck holds, so the derived
      // collection row has to follow it. Four separate queries used to read
      // `dc.scryfall_id` directly, and the Collection screen went on showing the
      // English printing after a whole deck had been switched to French.
      const freshOracle = (
        db.get('SELECT oracle_id FROM printings WHERE scryfall_id = ?', [fresh.scryfall_id]) as
          | { oracle_id: string | null }
          | undefined
      )?.oracle_id
      if (freshOracle && ja && ja.oracle_id !== freshOracle) {
        // Point the entry at an unrelated cached printing: the assertion is only
        // about the override being *followed*, not about which card it names.
        db.run('UPDATE deck_cards SET oracle_id = ? WHERE deck_id = ? AND scryfall_id = ?', [
          freshOracle,
          deckId3,
          fresh.scryfall_id
        ])
        setCardOverride(deckId3, freshOracle, ja.scryfall_id, 'ja')

        const overridden = queryCollection(filters({ source: 'deck' }), 'usd', 500, 0)
        check(
          'a derived collection row follows the deck override, not the synced printing',
          overridden.rows.some((r) => r.scryfall_id === ja.scryfall_id) &&
            !overridden.rows.some((r) => r.scryfall_id === fresh.scryfall_id),
          JSON.stringify(overridden.rows.map((r) => r.printing.lang))
        )
        check(
          'and the stats totals agree with it',
          collectionStats().deckCards === fresh.quantity,
          `stats deckCards=${collectionStats().deckCards} expected ${fresh.quantity}`
        )
        const overriddenLocations = cardLocations(ja.scryfall_id)
        check(
          'and the card locations report the deck against the overridden printing',
          (overriddenLocations?.decks.length ?? 0) > 0 &&
            overriddenLocations?.decks[0].match === 'exact',
          JSON.stringify(overriddenLocations?.decks)
        )

        clearCardOverride(deckId3, freshOracle)
        check(
          'clearing it puts the derived row back on the synced printing',
          queryCollection(filters({ source: 'deck' }), 'usd', 500, 0).rows.some(
            (r) => r.scryfall_id === fresh.scryfall_id
          )
        )
      }

      // Source filter both ways.
      const bulkOnly = queryCollection(filters({ source: 'collection' }), 'usd', 500, 0)
      check(
        'the bulk-only filter hides derived rows',
        bulkOnly.totalQuantity === baseline.totalQuantity &&
          bulkOnly.rows.every((r) => r.source === 'collection')
      )
      const decksOnly = queryCollection(filters({ source: 'deck' }), 'usd', 500, 0)
      check(
        'the in-decks-only filter shows just derived rows',
        decksOnly.totalQuantity === fresh.quantity &&
          decksOnly.rows.every((r) => r.source === 'deck')
      )

      // A condition filter cannot match a card with no recorded condition.
      const withCondition = queryCollection(filters({ conditions: ['NM'] }), 'usd', 500, 0)
      check(
        'a condition filter excludes derived rows',
        withCondition.rows.every((r) => r.source === 'collection')
      )

      // Stats agree with the Collection view.
      const statsOwned = collectionStats()
      check(
        'stats totals match the collection query',
        statsOwned.totalCards === withDeck.totalQuantity,
        `stats=${statsOwned.totalCards} view=${withDeck.totalQuantity}`
      )
      check(
        'stats split bulk from deck copies',
        statsOwned.bulkCards === withDeck.bulkQuantity &&
          statsOwned.deckCards === withDeck.deckQuantity,
        `${statsOwned.bulkCards}/${statsOwned.deckCards}`
      )

      // The deck breakdown now considers it held.
      const ownedBreakdown = deckBreakdown(deckId3, 'usd', false)
      const ownedCard = allDeckCards(ownedBreakdown).find(
        (c) => c.scryfall_id === fresh.scryfall_id
      )
      check(
        'the deck breakdown reports the labelled card as held',
        !!ownedCard && ownedCard.held >= ownedCard.quantity,
        `held=${ownedCard?.held} quantity=${ownedCard?.quantity}`
      )

      // `held` is the figure the Decks screen prints. It used to be recomputed in
      // the renderer without the label contribution, so an owned-tagged card sat
      // in the Owned tab reading "have 0 / 1". It is now derived here only.
      check(
        'held counts the owned label, so it is not 0 for a card the collection lacks',
        ownedCard?.held === fresh.quantity,
        `held=${ownedCard?.held} quantity=${fresh.quantity} owned_exact=${ownedCard?.owned_exact}`
      )
      check(
        'every card in the Owned tab reports held >= quantity',
        (ownedBreakdown?.owned ?? []).every((c) => c.held >= c.quantity),
        'a card is in Owned while reporting fewer held than needed'
      )
      check(
        'every card in the Missing tab reports held < quantity',
        (ownedBreakdown?.missing ?? []).every((c) => c.held < c.quantity),
        'a card is in Missing while reporting enough held'
      )

      // Additive double counting: own it loosely as well.
      addToCollection({
        scryfall_id: fresh.scryfall_id,
        finish: 'nonfoil',
        condition: 'NM',
        quantity: 1
      })
      const both = queryCollection(filters({ search: fresh.name }), 'usd', 100, 0)
      check(
        'a loose copy plus a deck copy is additive',
        both.totalQuantity === fresh.quantity + 1,
        `got ${both.totalQuantity} for ${fresh.quantity} + 1`
      )
      check(
        'and they stay separate rows, one editable and one not',
        both.rows.some((r) => r.source === 'collection') &&
          both.rows.some((r) => r.source === 'deck')
      )

      // collection_items must never be written by any of this.
      const quantitiesBefore = JSON.stringify(
        db.all('SELECT id, scryfall_id, quantity FROM collection_items ORDER BY id')
      )
      recomputeLabelPossession({ '#4caf50': 'owned' })
      recomputeLabelPossession({})
      check(
        'changing a label never writes to collection_items',
        quantitiesBefore ===
          JSON.stringify(db.all('SELECT id, scryfall_id, quantity FROM collection_items ORDER BY id'))
      )

      // Back to ignore restores the earlier figures exactly.
      const restored = queryCollection(filters(), 'usd', 500, 0)
      check(
        'setting the colour back to ignore restores the total',
        restored.totalQuantity === baseline.totalQuantity + 1,
        `got ${restored.totalQuantity}`
      )
      check('and removes every derived row', restored.deckQuantity === 0)

      // One row per printing even when two decks claim it.
      const secondDeck = upsertDeck({
        external_id: 'verify-second',
        name: 'Second deck',
        format: null,
        owner_username: null,
        url: null,
        external_updated_at: null,
        is_private: false,
        is_unlisted: false
      })
      replaceDeckCards(secondDeck, [
        {
          scryfall_id: fresh.scryfall_id,
          oracle_id: null,
          quantity: 1,
          // Must match the first deck's finish: the derived rows group on it, so
          // a mismatch would legitimately produce two rows.
          finish: fresh.finish,
          categories: [],
          in_maindeck: true,
          name: fresh.name,
          lang: 'en',
          set_code: null,
          collector_number: null,
          rarity: null,
          image_uri_small: null,
          label: 'Have it,#4CAF50'
        }
      ])
      recomputeLabelPossession({ '#4caf50': 'owned' })
      const twoDecks = queryCollection(
        filters({ search: fresh.name, source: 'deck' }),
        'usd',
        100,
        0
      )
      check(
        'a card owned in two decks is one row with the summed quantity',
        twoDecks.rows.length === 1 && twoDecks.rows[0].quantity === fresh.quantity + 1,
        `${twoDecks.rows.length} rows: ${JSON.stringify(
          twoDecks.rows.map((r) => ({ finish: r.finish, qty: r.quantity, decks: r.deck_names }))
        )}`
      )
      check(
        'and that row names both decks',
        (twoDecks.rows[0]?.deck_names.length ?? 0) === 2,
        JSON.stringify(twoDecks.rows[0]?.deck_names)
      )

      // Clean up so later sections see the original shape.
      db.run('DELETE FROM decks WHERE external_id = ?', ['verify-second'])
      recomputeLabelPossession({})
    }
  }

  // ------------------------------------------------- groups, commanders, langs
  section('Deck groups, commanders and language overrides')

  {
    // Two printings of a card the collection does not have, so an override can be
    // observed changing a match from zero to one.
    const ajaniEn = await resolveQuick('war', '1', 'en')
    const ajaniJa = await resolveQuick('war', '1', 'ja')
    check(
      'fetched an EN and a JA printing of the same card',
      !!ajaniEn && !!ajaniJa && ajaniEn.scryfall_id !== ajaniJa.scryfall_id,
      `${ajaniEn?.scryfall_id} / ${ajaniJa?.scryfall_id}`
    )

    if (ajaniEn && ajaniJa && en && fr && ja) {
      // A commander deck, with the premier flag living only in the deck JSON —
      // which is what lets commanders resolve without a migration or a re-sync.
      const groupDeck = upsertDeck({
        external_id: 'verify-groups',
        name: 'Verify Commander',
        format: 'Commander',
        owner_username: null,
        url: null,
        external_updated_at: null,
        is_private: false,
        is_unlisted: false,
        raw: {
          categories: [
            { name: 'Commander', includedInDeck: true, isPremier: true },
            { name: 'Land', includedInDeck: true },
            { name: 'Ramp', includedInDeck: true },
            { name: 'Maybeboard', includedInDeck: false }
          ]
        }
      })

      const boltOracleId = (
        db.get('SELECT oracle_id FROM printings WHERE scryfall_id = ?', [en.scryfall_id]) as {
          oracle_id: string
        }
      ).oracle_id

      const entry = (
        printing: { scryfall_id: string; name: string; lang: string },
        oracle: string,
        quantity: number,
        categories: string[]
      ): Parameters<typeof replaceDeckCards>[1][number] => ({
        scryfall_id: printing.scryfall_id,
        oracle_id: oracle,
        quantity,
        finish: 'nonfoil' as Finish,
        categories,
        in_maindeck: !categories.includes('Maybeboard'),
        name: printing.name,
        lang: printing.lang,
        set_code: null,
        collector_number: null,
        rarity: null,
        image_uri_small: null,
        label: ''
      })

      // The Land entry is the regression case: eight cards in one row.
      const deckCards = [
        entry(en, boltOracleId, 1, ['Commander']),
        entry(ja, boltOracleId, 1, ['Commander']),
        entry(fr, boltOracleId, 8, ['Land']),
        entry(ajaniEn, ajaniEn.oracle_id ?? 'x', 1, ['Ramp', 'Draw']),
        entry(ajaniJa, ajaniJa.oracle_id ?? 'y', 2, ['Maybeboard'])
      ]
      replaceDeckCards(groupDeck, deckCards)

      // Own all eight of the Land entry's exact printing, so it must contribute 8.
      const heldFr = (
        db.get(
          'SELECT COALESCE(SUM(quantity),0) AS q FROM collection_items WHERE scryfall_id = ?',
          [fr.scryfall_id]
        ) as { q: number }
      ).q
      if (heldFr < 8) {
        addToCollection({
          scryfall_id: fr.scryfall_id,
          finish: 'nonfoil',
          condition: 'NM',
          quantity: 8 - heldFr
        })
      }

      // Exact matching throughout: all three Bolt printings share one oracle id,
      // so oracle matching would make every entry look owned and prove nothing.
      const grouped = deckBreakdown(groupDeck, 'usd', true)!
      const premierGroup = grouped.groups.find((g) => g.isPremier)

      check(
        'the commander category is detected from the stored deck JSON',
        premierGroup?.name === 'Commander',
        `premier group: ${premierGroup?.name}`
      )
      check(
        'a deck with two commanders reports both',
        premierGroup?.cards.length === 2 && premierGroup.cards.every((c) => c.is_commander),
        `${premierGroup?.cards.length} cards`
      )
      check(
        'the premier group is listed first',
        grouped.groups[0]?.isPremier === true,
        `first group is ${grouped.groups[0]?.name}`
      )
      // A 60-card deck has no commander, so nothing must be pinned to the top.
      const plainDeck = upsertDeck({
        external_id: 'verify-plain',
        name: 'Verify Standard',
        format: 'Standard',
        owner_username: null,
        url: null,
        external_updated_at: null,
        is_private: false,
        is_unlisted: false,
        raw: { categories: [{ name: 'Creature', includedInDeck: true }] }
      })
      replaceDeckCards(plainDeck, [entry(en, boltOracleId, 4, ['Creature'])])
      check(
        'a deck with no premier category produces no premier group',
        deckBreakdown(plainDeck, 'usd', true)!.groups.every((g) => !g.isPremier)
      )
      db.run('DELETE FROM decks WHERE external_id = ?', ['verify-plain'])

      const landGroup = grouped.groups.find((g) => g.name === 'Land')
      check(
        'a quantity-8 entry counts as 8 cards, not 1',
        landGroup?.cardCount === 8,
        `cardCount=${landGroup?.cardCount}`
      )
      check(
        'and fully owning it contributes 8 to the owned total',
        landGroup?.ownedCards === 8 && landGroup?.missingCards === 0,
        `owned=${landGroup?.ownedCards} missing=${landGroup?.missingCards}`
      )
      check(
        'totals reconcile: owned + missing = cards, entries is separate',
        grouped.totals.ownedCards + grouped.totals.missingCards === grouped.totals.cards &&
          grouped.totals.cards === 13 &&
          grouped.totals.entries === 5,
        `${grouped.totals.ownedCards}+${grouped.totals.missingCards}=${grouped.totals.cards}, entries ${grouped.totals.entries}`
      )
      check(
        'an excluded category is separated from the deck proper',
        grouped.totals.inDeckCards === 11 && grouped.totals.excludedCards === 2,
        `${grouped.totals.inDeckCards} in / ${grouped.totals.excludedCards} out`
      )
      check(
        'excluded groups sort last',
        grouped.groups[grouped.groups.length - 1]?.inDeck === false,
        `last group: ${grouped.groups[grouped.groups.length - 1]?.name}`
      )

      // A card carrying several categories is counted once but still shows both.
      const multi = allDeckCards(grouped).find((c) => c.scryfall_id === ajaniEn.scryfall_id)!
      check(
        'a multi-category card is counted under exactly one group',
        grouped.groups.filter((g) => g.cards.some((c) => c.id === multi.id)).length === 1,
        'card appears in more than one group'
      )
      check(
        'and still reports its other categories',
        multi.categories.length === 2 && multi.categories.includes('Draw'),
        JSON.stringify(multi.categories)
      )
      check(
        'the dynamic category list covers every group, with card counts',
        grouped.categories.length === grouped.groups.length &&
          grouped.categories.every((c) => c.cardCount > 0),
        JSON.stringify(grouped.categories)
      )

      // ---- language overrides ----
      const collectionBefore = db.get(
        'SELECT COUNT(*) AS c, COALESCE(SUM(quantity),0) AS q FROM collection_items'
      ) as { c: number; q: number }

      addToCollection({
        scryfall_id: ajaniJa.scryfall_id,
        finish: 'nonfoil',
        condition: 'NM',
        quantity: 1
      })

      check(
        'before the override, the English entry does not match the Japanese copy',
        multi.owned_exact === 0 && multi.held === 0,
        `owned_exact=${multi.owned_exact} held=${multi.held}`
      )

      setCardOverride(groupDeck, ajaniEn.oracle_id ?? 'x', ajaniJa.scryfall_id, 'ja')
      const overridden = allDeckCards(deckBreakdown(groupDeck, 'usd', true)).find(
        (c) => c.oracle_id === ajaniEn.oracle_id
      )
      check(
        'an override changes which printing the entry matches',
        overridden?.owned_exact === 1 && overridden?.held === 1,
        `owned_exact=${overridden?.owned_exact} held=${overridden?.held}`
      )
      check(
        'the row reports the overridden language and printing',
        overridden?.override_lang === 'ja' &&
          overridden?.lang === 'ja' &&
          overridden?.scryfall_id === ajaniJa.scryfall_id,
        `lang=${overridden?.lang} override=${overridden?.override_lang}`
      )

      // The reason overrides cannot live on deck_cards: a sync wipes those rows.
      replaceDeckCards(groupDeck, deckCards)
      const afterResync = allDeckCards(deckBreakdown(groupDeck, 'usd', true)).find(
        (c) => c.oracle_id === ajaniEn.oracle_id
      )
      check(
        'the override survives a deck re-sync',
        afterResync?.override_lang === 'ja' && afterResync?.held === 1,
        `override=${afterResync?.override_lang} held=${afterResync?.held}`
      )

      // A deck-wide default flags what it could not convert instead of pretending.
      // The flag is per card now. Setting a deck-wide default must NOT imply that
      // every card in the deck was asked about — that was the bug: applying one
      // language flagged cards nobody had touched.
      setDeckDefaultLang(groupDeck, 'ja')
      const afterDefault = allDeckCards(deckBreakdown(groupDeck, 'usd', true))
      check(
        'a deck-wide language no longer flags cards nobody asked about',
        afterDefault.every((c) => c.language_unavailable === null),
        JSON.stringify(afterDefault.map((c) => [c.lang, c.language_unavailable]))
      )
      setDeckDefaultLang(groupDeck, null)

      // A request that cannot be satisfied is recorded against that one card.
      const missTarget = afterDefault.find(
        (c) => c.oracle_id && c.oracle_id !== ajaniEn.oracle_id
      )!
      recordLanguageMiss(groupDeck, missTarget.oracle_id!, 'zzz')
      const afterMiss = allDeckCards(deckBreakdown(groupDeck, 'usd', true))
      // Keyed on oracle id, so every entry of the *same card* is flagged and no
      // other card is. A deck listing one card as three printings shares one
      // override — the documented consequence of keying on the card, not the row.
      const flaggedIds = new Set(
        afterMiss.filter((c) => c.language_unavailable).map((c) => c.oracle_id)
      )
      check(
        'only the card actually asked about is flagged',
        flaggedIds.size === 1 && flaggedIds.has(missTarget.oracle_id),
        JSON.stringify(afterMiss.filter((c) => c.language_unavailable).map((c) => c.name))
      )
      check(
        'every entry of that one card is flagged together',
        afterMiss
          .filter((c) => c.oracle_id === missTarget.oracle_id)
          .every((c) => c.language_unavailable === 'zzz'),
        'entries of the same card disagreed about the flag'
      )
      check(
        'a failed request leaves the printing alone rather than pinning it',
        afterMiss.find((c) => c.oracle_id === missTarget.oracle_id)?.scryfall_id ===
          missTarget.scryfall_id,
        'the card moved printing because a lookup failed'
      )
      // And it clears itself as soon as a real override lands.
      setCardOverride(groupDeck, missTarget.oracle_id!, ajaniJa.scryfall_id, 'ja')
      check(
        'a later successful override clears the flag',
        allDeckCards(deckBreakdown(groupDeck, 'usd', true)).find(
          (c) => c.oracle_id === missTarget.oracle_id
        )?.language_unavailable === null
      )
      clearCardOverride(groupDeck, missTarget.oracle_id!)
      clearLanguageMiss(groupDeck, missTarget.oracle_id!)

      // Scoping: applying to one card must not touch the rest.
      const scoped = allDeckCards(deckBreakdown(groupDeck, 'usd', true))
      const one = scoped.find((c) => c.oracle_id === ajaniEn.oracle_id)!
      setCardOverride(groupDeck, one.oracle_id!, ajaniJa.scryfall_id, 'ja')
      const afterScoped = allDeckCards(deckBreakdown(groupDeck, 'usd', true))
      const overriddenIds = new Set(
        afterScoped.filter((c) => c.override_lang).map((c) => c.oracle_id)
      )
      check(
        'setting a language for one card changes exactly that card',
        overriddenIds.size === 1 && overriddenIds.has(one.oracle_id),
        JSON.stringify(afterScoped.filter((c) => c.override_lang).map((c) => c.name))
      )
      check(
        'and leaves every other card unflagged',
        afterScoped.every((c) => c.language_unavailable === null)
      )
      clearCardOverride(groupDeck, one.oracle_id!)

      // Picking a printing yourself: no Scryfall lookup, the printing is known.
      setCardPrinting(groupDeck, one.oracle_id!, ajaniJa.scryfall_id)
      const picked = allDeckCards(deckBreakdown(groupDeck, 'usd', true)).find(
        (c) => c.oracle_id === one.oracle_id
      )
      check(
        'picking a printing points the deck entry straight at it',
        picked?.scryfall_id === ajaniJa.scryfall_id && picked?.override_lang === 'ja',
        `${picked?.scryfall_id} / ${picked?.override_lang}`
      )

      // Declaring a language for a card Scryfall has no printing of.
      forceCardLanguage(groupDeck, one.oracle_id!, 'sa', 'संस्कृत')
      const declared = allDeckCards(deckBreakdown(groupDeck, 'usd', true)).find(
        (c) => c.oracle_id === one.oracle_id
      )
      check(
        'a declared language and name win on a deck entry',
        declared?.lang === 'sa' && declared?.name === 'संस्कृत' && declared?.language_forced === true,
        `lang=${declared?.lang} name=${declared?.name} forced=${declared?.language_forced}`
      )
      check(
        'the printing underneath is still the one that was picked',
        declared?.scryfall_id === ajaniJa.scryfall_id,
        `${declared?.scryfall_id}`
      )
      check(
        'the deck language facet reports the declared language',
        deckBreakdown(groupDeck, 'usd', true)!.languages.some((l) => l.lang === 'sa'),
        JSON.stringify(deckBreakdown(groupDeck, 'usd', true)!.languages)
      )
      // A declaration answers the "no printing in that language" question.
      recordLanguageMiss(groupDeck, one.oracle_id!, 'sa')
      forceCardLanguage(groupDeck, one.oracle_id!, 'sa', null)
      check(
        'declaring a language clears the pending no-printing flag',
        allDeckCards(deckBreakdown(groupDeck, 'usd', true)).find(
          (c) => c.oracle_id === one.oracle_id
        )?.language_unavailable === null
      )

      forceCardLanguage(groupDeck, one.oracle_id!, null)
      check(
        'and dropping the declaration returns to the printing',
        allDeckCards(deckBreakdown(groupDeck, 'usd', true)).find(
          (c) => c.oracle_id === one.oracle_id
        )?.lang === 'ja'
      )
      clearCardOverride(groupDeck, one.oracle_id!)

      check(
        'every distinct card is offered for a whole-deck language change',
        new Set(deckCardIdentities(groupDeck).map((c) => c.oracle_id)).size ===
          deckCardIdentities(groupDeck).length,
        'deckCardIdentities returned duplicates'
      )

      clearCardOverride(groupDeck, ajaniEn.oracle_id ?? 'x')
      const cleared = allDeckCards(deckBreakdown(groupDeck, 'usd', true)).find(
        (c) => c.oracle_id === ajaniEn.oracle_id
      )
      check(
        'clearing the override restores what Archidekt said',
        cleared?.override_lang === null && cleared?.scryfall_id === ajaniEn.scryfall_id,
        `${cleared?.override_lang} / ${cleared?.scryfall_id}`
      )

      const collectionAfter = db.get(
        'SELECT COUNT(*) AS c, COALESCE(SUM(quantity),0) AS q FROM collection_items'
      ) as { c: number; q: number }
      check(
        'no override operation touched the collection',
        // The one JA copy added above is the only intended difference.
        collectionAfter.q === collectionBefore.q + 1,
        `${collectionBefore.q} -> ${collectionAfter.q}`
      )

      // ---- the renderer's own filtering and sorting ----
      const all = allDeckCards(deckBreakdown(groupDeck, 'usd', true))
      const deckFilters = (patch: Partial<typeof DEFAULT_DECK_FILTERS> = {}): typeof DEFAULT_DECK_FILTERS => ({
        ...DEFAULT_DECK_FILTERS,
        ...patch
      })
      check(
        'the ownership filter replaces the owned/missing tabs',
        all.filter((c) => matchesDeckFilters(c, deckFilters({ ownership: 'owned' }))).length +
          all.filter((c) => matchesDeckFilters(c, deckFilters({ ownership: 'missing' }))).length ===
          all.length,
        'owned and missing do not partition the deck'
      )
      check(
        'the category filter matches any of a card’s categories, not just its group',
        all
          .filter((c) => matchesDeckFilters(c, deckFilters({ categories: ['Draw'] })))
          .some((c) => c.scryfall_id === ajaniEn.scryfall_id),
        'a card tagged Draw but counted elsewhere was filtered out'
      )
      check(
        'unlabelled cards are reachable through the no-label option',
        all.filter((c) => matchesDeckFilters(c, deckFilters({ labels: [NO_LABEL] }))).length ===
          all.length,
        'these fixtures carry no label, so all of them should match'
      )
      // The language facet is dynamic like categories and labels: only languages
      // the deck actually contains, counted by card.
      check(
        'the language facet offers exactly the languages present',
        new Set(grouped.languages.map((l) => l.lang)).size === grouped.languages.length &&
          grouped.languages.every((l) => all.some((c) => c.lang === l.lang)) &&
          new Set(all.map((c) => c.lang)).size === grouped.languages.length,
        JSON.stringify(grouped.languages)
      )
      check(
        'and its counts are cards, not rows',
        grouped.languages.reduce((sum, l) => sum + l.cardCount, 0) === grouped.totals.cards,
        `${grouped.languages.reduce((sum, l) => sum + l.cardCount, 0)} != ${grouped.totals.cards}`
      )
      const oneLang = grouped.languages[0].lang
      check(
        'filtering by a language keeps exactly the cards in it',
        all
          .filter((c) => matchesDeckFilters(c, deckFilters({ langs: [oneLang] })))
          .every((c) => c.lang === oneLang) &&
          all.filter((c) => matchesDeckFilters(c, deckFilters({ langs: [oneLang] }))).length ===
            all.filter((c) => c.lang === oneLang).length,
        `language ${oneLang}`
      )
      check(
        'and it filters on the effective language, so an override counts',
        (() => {
          const overridden = all.find((c) => c.override_lang)
          if (!overridden) return true
          return matchesDeckFilters(
            overridden,
            deckFilters({ langs: [overridden.override_lang as string] })
          )
        })(),
        'a card with an override was not matched by its overridden language'
      )

      check(
        'search matches what the row displays',
        all.some((c) => matchesDeckFilters(c, deckFilters({ search: c.name.slice(0, 4) })))
      )
      const byColor = sortDeckCards(all, deckFilters({ sort: 'color', sort2: 'cmc' }))
      check(
        'sorting loses no card',
        byColor.length === all.length,
        `${byColor.length} != ${all.length}`
      )
      check(
        'colourless sorts after coloured cards',
        (() => {
          const ranks = byColor.map((c) => colorRank(c.color_identity))
          return ranks.every((rank, i) => i === 0 || ranks[i - 1] <= rank)
        })(),
        'colour order is not monotonic'
      )

      // Left in place for the grouping section below, which reuses this fixture.
    }
  }

  // ------------------------------------------- grouping, chunking, throttling
  section('Grouping toggle, tile chunking and progress throttling')

  {
    const grouped = deckBreakdown(
      (db.get("SELECT id FROM decks WHERE external_id = 'verify-groups'") as
        | { id: number }
        | undefined)?.id ?? -1,
      'usd',
      true
    )

    if (grouped) {
      const filters = DEFAULT_DECK_FILTERS
      const byCategory = buildDeckSections(grouped, filters, true)
      const flat = buildDeckSections(grouped, filters, false)

      const cardsIn = (sections: { cardCount: number }[]): number =>
        sections.reduce((sum, s) => sum + s.cardCount, 0)

      check(
        'collapsing the categories loses no card',
        cardsIn(flat) === cardsIn(byCategory),
        `${cardsIn(flat)} != ${cardsIn(byCategory)}`
      )
      check(
        'the commander stays pinned in its own section',
        flat[0]?.isPremier === true && flat[0]?.name === 'Commander',
        `first section is ${flat[0]?.name}`
      )
      check(
        'the in-deck categories collapse into exactly one section',
        flat.filter((s) => s.inDeck && !s.isPremier).length === 1 &&
          flat.some((s) => s.name === FLAT_GROUP_NAME),
        JSON.stringify(flat.map((s) => s.name))
      )
      check(
        'and the excluded piles stay separate',
        flat.filter((s) => !s.inDeck).length ===
          byCategory.filter((s) => !s.inDeck).length,
        JSON.stringify(flat.filter((s) => !s.inDeck).map((s) => s.name))
      )
      const flatDeck = flat.find((s) => s.name === FLAT_GROUP_NAME)!
      const mergedFrom = byCategory.filter((s) => s.inDeck && !s.isPremier)
      check(
        'the merged section sums the sections it replaced',
        flatDeck.cardCount === mergedFrom.reduce((sum, s) => sum + s.cardCount, 0) &&
          flatDeck.ownedCards === mergedFrom.reduce((sum, s) => sum + s.ownedCards, 0) &&
          flatDeck.missingCards === mergedFrom.reduce((sum, s) => sum + s.missingCards, 0),
        `merged ${flatDeck.cardCount}/${flatDeck.ownedCards}/${flatDeck.missingCards}`
      )

      // The commander section is smaller than a row at 8 columns — exactly the
      // shape that used to render two enormous cards across the full width.
      const shortRow = buildDeckBody(byCategory, 'grid', 8).items.find(
        (i) => i.kind === 'tiles' && i.cards.length < 8
      )
      check(
        'a section shorter than one row still declares a full track count',
        !!shortRow && shortRow.kind === 'tiles' && shortRow.columns === 8,
        JSON.stringify(shortRow)
      )

      // Every card lands in exactly one row, and a tile row never mixes two
      // categories — the property that keeps a grid honest about its headings.
      const rows = buildDeckBody(byCategory, 'rows', 8)
      check(
        'row mode emits one row per card plus one header per section',
        rows.items.filter((i) => i.kind === 'row').length === rows.ordered.length &&
          rows.items.filter((i) => i.kind === 'header').length === byCategory.length,
        `${rows.items.length} items for ${rows.ordered.length} cards`
      )

      for (const columns of [1, 3, 8]) {
        const grid = buildDeckBody(byCategory, 'grid', columns)
        const tiled = grid.items.flatMap((i) => (i.kind === 'tiles' ? i.cards : []))
        check(
          `grid mode at ${columns} columns keeps every card exactly once`,
          tiled.length === grid.ordered.length &&
            new Set(tiled.map((c) => c.id)).size === tiled.length,
          `${tiled.length} tiles for ${grid.ordered.length} cards`
        )
        const groupOf = new Map(
          byCategory.flatMap((s) => s.cards.map((c) => [c.id, s.name] as const))
        )
        check(
          `no tile row straddles two sections at ${columns} columns`,
          grid.items.every((item) =>
            item.kind !== 'tiles'
              ? true
              : new Set(item.cards.map((c) => groupOf.get(c.id))).size === 1
          ),
          'a tile row mixed cards from two categories'
        )
        check(
          `no tile row exceeds ${columns} columns`,
          grid.items.every((item) => item.kind !== 'tiles' || item.cards.length <= columns)
        )
        // The row's height is derived from this count, so the count has to travel
        // with the row. Rendering a short final chunk over fewer tracks made its
        // tiles wider, and therefore taller than the height it declared, and the
        // overflow painted behind the rows below it.
        check(
          `every tile row declares the ${columns}-column track count its height assumes`,
          grid.items.every((item) => item.kind !== 'tiles' || item.columns === Math.max(1, columns)),
          JSON.stringify(
            grid.items
              .filter((i) => i.kind === 'tiles')
              .map((i) => (i.kind === 'tiles' ? [i.cards.length, i.columns] : null))
              .slice(0, 6)
          )
        )
      }
    }

    // Progress used to be one IPC message per card — 135 of them for a single
    // language apply, each waking the renderer to redraw a bar nobody reads that fast.
    const seen: ProgressEvent[] = []
    const throttled = createThrottledBroadcaster((event) => seen.push(event), 100)
    throttled({ job: 'deck-language', phase: 'x', done: 0, total: 50 })
    for (let i = 1; i <= 50; i += 1) {
      throttled({ job: 'deck-language', phase: 'x', done: i, total: 50 })
    }
    throttled({ job: 'deck-language', phase: 'Done', done: 50, total: 50, finished: true })
    check('the first progress event is never delayed', seen[0]?.done === 0)
    check(
      'a burst of 52 events is coalesced',
      seen.length < 10,
      `${seen.length} events reached the sink`
    )
    check(
      'the final event still carries the true final counts',
      seen.at(-1)?.finished === true && seen.at(-1)?.done === 50,
      JSON.stringify(seen.at(-1))
    )
    await new Promise((resolve) => setTimeout(resolve, 160))
    check('and nothing arrives after it', seen.at(-1)?.finished === true)
  }

  {
    // The grouping toggle is a display preference, so it has to survive a restart.
    check('deck grouping defaults to on', getSettings().deckGroupByCategory === true)
    check(
      'and round-trips when switched off',
      updateSettings({ deckGroupByCategory: false }).deckGroupByCategory === false
    )
    getDb().run("UPDATE settings SET value = 'nonsense' WHERE key = 'deckGroupByCategory'")
    check(
      'a corrupt stored value reads as off rather than crashing',
      getSettings().deckGroupByCategory === false
    )
    updateSettings({ deckGroupByCategory: true })
  }

  db.run('DELETE FROM decks WHERE external_id = ?', ['verify-groups'])

  // ------------------------------------------------------------------- sorting
  section('Sorting: colour order, tie-breakers, row keys')

  // Every row must carry a unique non-empty key. This is the assertion that would
  // have caught the virtualized rows keying off a null `id`, which made React
  // reuse nodes and paint one card's name across others.
  const keyed = queryCollection(filters(), 'usd', 500, 0)
  const keys = keyed.rows.map((r) => r.key)
  check('every row has a non-empty key', keys.every((k) => !!k && k.length > 0))
  check(
    'row keys are unique',
    new Set(keys).size === keys.length,
    `${keys.length} rows, ${new Set(keys).size} distinct keys`
  )

  // Seed one printing per colour plus a gold card and an artifact, so colour
  // order is asserted rather than eyeballed.
  const colorSeed = [
    { id: 'sort-w', name: 'Zsort White', identity: ['W'], cmc: 2 },
    { id: 'sort-u', name: 'Zsort Blue', identity: ['U'], cmc: 1 },
    { id: 'sort-b', name: 'Zsort Black', identity: ['B'], cmc: 3 },
    { id: 'sort-r', name: 'Zsort Red', identity: ['R'], cmc: 1 },
    { id: 'sort-g', name: 'Zsort Green', identity: ['G'], cmc: 4 },
    { id: 'sort-gold', name: 'Zsort Gold', identity: ['B', 'R'], cmc: 5 },
    { id: 'sort-none', name: 'Zsort Colourless', identity: [], cmc: 0 },
    { id: 'sort-w2', name: 'Zsort White Two', identity: ['W'], cmc: 5 }
  ]
  for (const entry of colorSeed) {
    db.run(
      `INSERT INTO printings (scryfall_id, oracle_id, name, lang, set_code, set_name,
         collector_number, rarity, cmc, colors, color_identity, layout, finishes, fetched_at)
       VALUES (?,?,?,'en','tst','Sort Test','1','common',?,'[]',?,'normal','["nonfoil"]',?)`,
      [
        entry.id,
        entry.id,
        entry.name,
        entry.cmc,
        JSON.stringify(entry.identity),
        new Date().toISOString()
      ]
    )
    addToCollection({ scryfall_id: entry.id, finish: 'nonfoil', condition: 'NM', quantity: 1 })
  }

  const order = queryCollection(
    filters({ search: 'Zsort', sort: 'color', dir: 'asc', sort2: 'cmc', dir2: 'asc' }),
    'usd',
    100,
    0
  ).rows.map((r) => r.printing.name)
  check(
    'colour sorts WUBRG, then multicolour, then colourless',
    JSON.stringify(order) ===
      JSON.stringify([
        'Zsort White',
        'Zsort White Two',
        'Zsort Blue',
        'Zsort Black',
        'Zsort Red',
        'Zsort Green',
        'Zsort Gold',
        'Zsort Colourless'
      ]),
    JSON.stringify(order)
  )
  check(
    'the secondary sort breaks ties within a colour',
    order.indexOf('Zsort White') < order.indexOf('Zsort White Two'),
    'the cmc 2 white card should precede the cmc 5 one'
  )

  const descTie = queryCollection(
    filters({ search: 'Zsort', sort: 'color', dir: 'asc', sort2: 'cmc', dir2: 'desc' }),
    'usd',
    100,
    0
  ).rows.map((r) => r.printing.name)
  check(
    'reversing only the secondary flips the tie-break, not the colours',
    descTie[0] === 'Zsort White Two' && descTie[1] === 'Zsort White' && descTie[2] === 'Zsort Blue',
    JSON.stringify(descTie.slice(0, 3))
  )

  const noSecondary = queryCollection(
    filters({ search: 'Zsort', sort: 'cmc', dir: 'asc', sort2: null }),
    'usd',
    100,
    0
  )
  check(
    'sort2: null still returns every row, correctly ordered',
    noSecondary.rows.length === colorSeed.length &&
      (noSecondary.rows[0].printing.cmc ?? 0) <= (noSecondary.rows[1].printing.cmc ?? 0),
    `${noSecondary.rows.length} rows`
  )

  for (const entry of colorSeed) {
    db.run('DELETE FROM collection_items WHERE scryfall_id = ?', [entry.id])
    db.run('DELETE FROM printings WHERE scryfall_id = ?', [entry.id])
  }

  // ------------------------------------------------------------ view modes
  section('View mode preference')

  updateSettings({ viewModes: { collection: 'gallery', picks: 'grid', decks: 'grid' } })
  check(
    'view modes round-trip',
    getSettings().viewModes.collection === 'gallery' && getSettings().viewModes.decks === 'grid',
    JSON.stringify(getSettings().viewModes)
  )
  // A screen's mode names are not interchangeable: 'gallery' is meaningless for
  // the pick list, so an invalid value must fall back rather than propagate.
  db.run("UPDATE settings SET value = ? WHERE key = 'viewModes'", [
    '{"collection":"gallery","picks":"gallery","decks":"nonsense"}'
  ])
  const perScreen = getSettings().viewModes
  check(
    'an invalid mode falls back per screen without losing the valid ones',
    perScreen.collection === 'gallery' && perScreen.picks === 'rows' && perScreen.decks === 'rows',
    JSON.stringify(perScreen)
  )
  db.run("UPDATE settings SET value = ? WHERE key = 'viewModes'", ['not json'])
  check(
    'a corrupt value falls back to every default',
    getSettings().viewModes.collection === 'table',
    JSON.stringify(getSettings().viewModes)
  )
  updateSettings({ viewModes: { collection: 'table', picks: 'rows', decks: 'rows' } })

  // ------------------------------------------------------- settings migration
  section('Legacy setting migration')

  db.run("DELETE FROM settings WHERE key = 'labelPossession'")
  db.run(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    ['notOwnedColors', '["#F47373"]']
  )
  const migratedSetting = getSettings().labelPossession
  check(
    'the old notOwnedColors array migrates to a possession map',
    migratedSetting['#f47373'] === 'not_owned',
    JSON.stringify(migratedSetting)
  )
  db.run("DELETE FROM settings WHERE key = 'notOwnedColors'")
  updateSettings({ labelPossession: {} })

  // ------------------------------------------------------- grid column setting
  section('Grid column preferences')

  check('clampColumns rounds and caps', clampColumns(7.4) === 7 && clampColumns(99) === 14)
  check('clampColumns floors below the minimum', clampColumns(-3) === 2)
  check('clampColumns rejects nonsense', clampColumns('abc') === null && clampColumns(null) === null)

  updateSettings({ gridColumns: { collection: 4, printings: 10, picks: 3, decks: 12 } })
  const gridSettings = getSettings()
  check(
    'each grid keeps its own column count',
    gridSettings.gridColumns.collection === 4 && gridSettings.gridColumns.printings === 10,
    JSON.stringify(gridSettings.gridColumns)
  )

  // A stale or hand-edited value must never reach the renderer.
  db.run("UPDATE settings SET value = ? WHERE key = 'gridColumns'", ['{"collection": 999}'])
  check(
    'an out-of-range stored value clamps',
    getSettings().gridColumns.collection === 14,
    `got ${getSettings().gridColumns.collection}`
  )
  db.run("UPDATE settings SET value = ? WHERE key = 'gridColumns'", ['not json at all'])
  check(
    'a corrupt stored value falls back to defaults',
    getSettings().gridColumns.collection === DEFAULT_GRID_COLUMNS.collection,
    `got ${getSettings().gridColumns.collection}`
  )

  updateSettings({
    labelPossession: { '#F47373': 'not_owned', '  #ABC  ': 'owned', garbage: 'owned' }
  })
  const storedPossession = getSettings().labelPossession
  check(
    'label colours normalize to lowercase hex and drop junk',
    storedPossession['#f47373'] === 'not_owned' &&
      storedPossession['#abc'] === 'owned' &&
      Object.keys(storedPossession).length === 2,
    JSON.stringify(storedPossession)
  )
  updateSettings({ labelPossession: {} })

  // ---------------------------------------------------------- null price safety
  section('Proxies are worth nothing, but they fill a slot')

  {
    const row = getDb().get(
      'SELECT id, scryfall_id FROM collection_items WHERE quantity > 0 LIMIT 1'
    ) as { id: number; scryfall_id: string } | undefined

    if (row) {
      const valueOf = (): { unit: number | null; total: number | null; all: number } => {
        const page = queryCollection(DEFAULT_FILTERS, 'usd', 5000, 0)
        const mine = page.rows.find((r) => r.id === row.id)
        return {
          unit: mine?.unit_value ?? null,
          total: mine?.total_value ?? null,
          all: page.totalValue
        }
      }

      const before = valueOf()
      updateItem(row.id, { proxied: 1 })
      const after = valueOf()

      check(
        'a proxy still reports the real market price as a reference',
        after.unit === before.unit,
        JSON.stringify({ before: before.unit, after: after.unit })
      )
      check(
        'but it is worth nothing on the row',
        after.total === 0,
        JSON.stringify({ before: before.total, after: after.total })
      )
      check(
        'and it comes out of the collection total',
        // Only meaningful if the card had a price to begin with; when it does,
        // the total must drop by exactly that row's old contribution.
        before.total === null || before.total === 0
          ? true
          : Math.abs(before.all - after.all - before.total) < 0.005,
        JSON.stringify({ was: before.all, now: after.all, row: before.total })
      )
      check(
        'the stats total agrees with the collection total',
        // Two separate SQL paths that must never disagree about money.
        Math.abs(collectionStats().totalValue - after.all) < 0.005,
        JSON.stringify({ stats: collectionStats().totalValue, collection: after.all })
      )

      const onlyProxies = queryCollection({ ...DEFAULT_FILTERS, proxied: true }, 'usd', 5000, 0)
      const noProxies = queryCollection({ ...DEFAULT_FILTERS, proxied: false }, 'usd', 5000, 0)
      check(
        'the filter separates proxies from real cards',
        onlyProxies.rows.every((r) => r.proxied) &&
          noProxies.rows.every((r) => !r.proxied) &&
          onlyProxies.rows.some((r) => r.id === row.id) &&
          !noProxies.rows.some((r) => r.id === row.id),
        JSON.stringify({ only: onlyProxies.rows.length, without: noProxies.rows.length })
      )

      updateItem(row.id, { proxied: 0 })
      check(
        'clearing the flag restores the value',
        valueOf().total === before.total,
        JSON.stringify({ restored: valueOf().total, was: before.total })
      )
    }
  }

  section('Staging into a chosen pick list')

  {
    // Two open lists, where the *newer* one is what the old code would have
    // picked regardless of the caller's choice.
    const older = createPickList('Older list')
    const newer = createPickList('Newer list')
    const row = getDb().get(
      'SELECT id FROM collection_items WHERE quantity > 0 LIMIT 1'
    ) as { id: number } | undefined

    if (row) {
      addToPickList(older, row.id, 1)
      const inOlder = getPickListItems(older, 'usd')
      const inNewer = getPickListItems(newer, 'usd')
      check(
        'staging into the older list puts the cards there',
        inOlder.length === 1 && inOlder[0].collection_item_id === row.id,
        JSON.stringify(inOlder.map((i) => i.collection_item_id))
      )
      check(
        'and leaves the newer one untouched',
        // This is the whole point: the previous behaviour reused the newest open
        // list whatever the caller asked for.
        inNewer.length === 0,
        JSON.stringify(inNewer.map((i) => i.collection_item_id))
      )

      // The reservation accounting must be unchanged by any of this.
      const reserved = (
        getDb().get(
          `SELECT COALESCE(SUM(pli.quantity), 0) AS n
           FROM pick_list_items pli
           JOIN pick_lists pl ON pl.id = pli.pick_list_id
           WHERE pli.collection_item_id = ? AND pl.status = 'open'`,
          [row.id]
        ) as { n: number }
      ).n
      check('the copy is reserved, not removed', reserved === 1, `${reserved}`)

      // A confirmed list is history and must refuse, rather than redirect.
      confirmPickList(older)
      let refused = ''
      try {
        addToPickList(older, row.id, 1)
      } catch (err) {
        refused = (err as Error).message
      }
      check(
        'a confirmed list refuses new cards instead of silently redirecting',
        refused === enDict['err.pickListClosed'],
        refused
      )
    }
  }

  section('Booster odds')

  {
    // The arithmetic first, on a hand-built booster: every pick yields exactly one
    // card, so summed over all cards `expected` must equal the pack's pick count.
    // Any error in a weight or a denominator shows up here immediately.
    // `shiny` is a foil sheet carrying c1 as well, which is the shape that broke:
    // a card on both a nonfoil and a foil sheet has two different chances, and
    // blending them overstated the foil badly.
    const toy = {
      boosters: [
        { contents: { commons: 10, rare: 1, shiny: 1 }, weight: 3 },
        { contents: { commons: 10, mythic: 1 }, weight: 1 }
      ],
      boostersTotalWeight: 4,
      sheets: {
        commons: { cards: { c1: 1, c2: 1, c3: 2 }, totalWeight: 4 },
        rare: { cards: { r1: 1, r2: 3 }, totalWeight: 4 },
        mythic: { cards: { m1: 1 }, totalWeight: 1, balanceColors: true },
        shiny: { cards: { c1: 1, r1: 99 }, totalWeight: 100, foil: true }
      }
    }
    const { byUuid, expectedPicks } = computeBoosterOdds(toy)
    const summed = [...byUuid.values()].reduce((sum, o) => sum + o.expected, 0)
    check(
      'expected copies sum to the number of cards in a pack',
      Math.abs(summed - expectedPicks) < 1e-9,
      `${summed} != ${expectedPicks}`
    )
    check(
      'and that pick count is the weighted average of the configurations',
      // 3/4 × (10 + 1 + 1) + 1/4 × (10 + 1) = 11.75
      Math.abs(expectedPicks - 11.75) < 1e-9,
      `${expectedPicks}`
    )

    // The split itself. c1 sits on a nonfoil sheet at 1/4 and a foil sheet at
    // 1/100, so its two chances must be reported apart and must differ.
    const nonfoilC1 = byUuid.get(oddsKey('c1', false))
    const foilC1 = byUuid.get(oddsKey('c1', true))
    check(
      'a card on both a nonfoil and a foil sheet gets two separate entries',
      !!nonfoilC1 && !!foilC1,
      JSON.stringify({ nonfoilC1, foilC1 })
    )
    check(
      'and the foil chance is the foil sheet alone, not blended with the nonfoil',
      // One pick off `shiny` at 1/100, in the 3-in-4 configuration.
      Math.abs((foilC1?.probability ?? 0) - 0.75 * 0.01) < 1e-9,
      `${foilC1?.probability}`
    )
    check(
      'the nonfoil chance ignores the foil sheet entirely',
      // Ten picks off `commons` at 1/4, in both configurations.
      Math.abs((nonfoilC1?.probability ?? 0) - (1 - Math.pow(0.75, 10))) < 1e-9,
      `${nonfoilC1?.probability}`
    )
    check(
      'a card only on a foil sheet has no nonfoil entry at all',
      byUuid.get(oddsKey('r1', true)) !== undefined &&
        byUuid.get(oddsKey('c2', true)) === undefined,
      'a foil-only or nonfoil-only card leaked into the other bucket'
    )
    check(
      'every probability is a probability',
      [...byUuid.values()].every((o) => o.probability >= 0 && o.probability <= 1)
    )
    check(
      'a guaranteed single-card sheet reads as certain in its configuration',
      // m1 is the only card on its sheet, drawn once, in the 1-in-4 configuration.
      Math.abs((byUuid.get(oddsKey('m1', false))?.probability ?? 0) - 0.25) < 1e-9,
      `${byUuid.get(oddsKey('m1', false))?.probability}`
    )
    check(
      'a colour-balanced sheet marks its cards approximate',
      byUuid.get(oddsKey('m1', false))?.approximate === true && byUuid.get(oddsKey('c1', false))?.approximate === false
    )
    check(
      'weight is proportional: c3 is twice as likely per pick as c1',
      Math.abs((byUuid.get(oddsKey('c3', false))?.expected ?? 0) - 2 * (byUuid.get(oddsKey('c1', false))?.expected ?? 0)) < 1e-9,
      `${byUuid.get(oddsKey('c3', false))?.expected} vs ${byUuid.get(oddsKey('c1', false))?.expected}`
    )
    check(
      'a card on no sheet of this booster is simply absent',
      byUuid.get(oddsKey('nope', false)) === undefined
    )

    // Then live, against a real set — the same set the plan was measured against.
    const loaded = await loadBoosterOdds('TMT', () => undefined)
    console.log(
      `        → TMT: ${loaded.boosters} booster types, ${loaded.cards} card odds stored`
    )
    check('a real set yields booster types', loaded.boosters > 0)
    check('and card odds joined by scryfall id', loaded.cards > 0)

    const info = boosterSetInfo('TMT')!

    // The same invariant as the toy, but live: Σ expected must equal the picks
    // per pack — over the cards we can *name*. Sheets pull from other sets whose
    // uuids carry no Scryfall id, so the shortfall must be exactly `coverage`
    // and no more. This is what caught the box-topper booster reading 0% for
    // every card when the truth was that we had no data for it at all.
    {
      const sums = new Map(
        (
          db.all(
            `SELECT booster, SUM(expected) AS total FROM booster_odds
             WHERE set_code = 'TMT' GROUP BY booster`
          ) as { booster: string; total: number }[]
        ).map((r) => [r.booster, r.total])
      )
      const off = info.boosters
        .map((b) => ({
          code: b.code,
          summed: sums.get(b.code) ?? 0,
          accounted: b.cardsPerPack * b.coverage
        }))
        .filter((b) => Math.abs(b.summed - b.accounted) > 0.05)
      check(
        'live: expected copies reconcile with the pick count and the coverage',
        off.length === 0,
        JSON.stringify(off)
      )
      check(
        'coverage is a fraction, and reported for every booster',
        info.boosters.every((b) => b.coverage >= 0 && b.coverage <= 1),
        JSON.stringify(info.boosters.map((b) => [b.code, b.coverage]))
      )
      console.log(
        `        → coverage: ${info.boosters
          .map((b) => `${b.code} ${(b.coverage * 100).toFixed(0)}%`)
          .join(', ')}`
      )
    }
    check('the set records what it fetched', !!info && info.boosters.length === loaded.boosters)
    check(
      'booster types are named, not just coded',
      info.boosters.every((b) => b.name.length > 0 && b.cardsPerPack > 0),
      JSON.stringify(info.boosters)
    )

    // A card in that set should have odds; one from a Commander precon should not.
    const inSet = db.get(
      "SELECT scryfall_id FROM printings WHERE set_code = 'tmt' AND lang = 'en' LIMIT 1"
    ) as { scryfall_id: string } | undefined
    if (inSet) {
      const odds = boosterOddsFor(inSet.scryfall_id, 'TMT')
      check('odds are reported as fetched for a known set', odds.fetched)
      check(
        'and every booster type is listed, even ones the card is not in',
        odds.boosters.length === info.boosters.length
      )
      const everyChance = odds.boosters.flatMap((b) =>
        [b.nonfoil, b.foil].filter((c): c is NonNullable<typeof c> => c !== null)
      )
      check(
        'probabilities stay in range',
        everyChance.every((c) => c.probability >= 0 && c.probability <= 1),
        JSON.stringify(everyChance.map((c) => c.probability))
      )
      check(
        'a printing only reports the finishes it is actually sold in',
        // A nonfoil-only printing must have no foil bucket, and vice versa —
        // which is a different statement from a 0% chance.
        odds.boosters.every((b) => b.nonfoil !== null || b.foil !== null)
      )
    }
    // The language join. MTGJSON names the English printing, so a translated card
    // matched nothing and read "not in this booster" — false for every non-English
    // card in a fetched set.
    // `booster_odds` holds MTGJSON's ids, but those printings are not cached here
    // yet — so cache both sides of one card before asserting anything about the
    // join. Several numbers are tried because not every one has a French
    // printing, and the English one must actually be on a sheet.
    for (let n = 1; n <= 14; n += 1) {
      const fr = await resolveQuick('tmt', String(n), 'fr')
      if (!fr) continue
      const en = await resolveQuick('tmt', String(n), 'en')
      if (!en) continue
      const onSheet = db.get('SELECT 1 AS ok FROM booster_odds WHERE scryfall_id = ? AND probability > 0', [
        en.scryfall_id
      ]) as { ok: number } | undefined
      if (onSheet) break
    }

    const pair = db.get(
      `SELECT f.scryfall_id AS translated, e.scryfall_id AS english, f.name, f.lang
       FROM printings f
       JOIN printings e ON e.set_code = f.set_code
                       AND e.collector_number = f.collector_number
                       AND e.lang = 'en'
       JOIN booster_odds bo ON bo.scryfall_id = e.scryfall_id
       WHERE f.set_code = 'tmt' AND f.lang != 'en' AND bo.probability > 0
       LIMIT 1`
    ) as { translated: string; english: string; name: string; lang: string } | undefined
    if (pair) {
      const translated = boosterOddsFor(pair.translated, 'TMT')
      const english = boosterOddsFor(pair.english, 'TMT')
      const shape = (o: typeof translated): string =>
        JSON.stringify(
          o.boosters.map((b) => [
            b.code,
            b.nonfoil?.probability ?? null,
            b.foil?.probability ?? null
          ])
        )
      check(
        'a translated printing gets the same odds as its English sibling',
        shape(translated) === shape(english),
        `${pair.name} (${pair.lang})`
      )
      check(
        'and it says the figure came through the English printing',
        translated.via_english === true && english.via_english === false
      )
      check(
        'the translated card actually reports a real chance, not zero',
        translated.boosters.some(
          (b) => (b.nonfoil?.probability ?? 0) > 0 || (b.foil?.probability ?? 0) > 0
        )
      )
    } else {
      console.log('        → no translated TMT printing cached to test the join')
    }

    // Presence without any download, and the trap that flag hides.
    const flagged = db.get(
      "SELECT scryfall_id FROM printings WHERE in_boosters = 1 LIMIT 1"
    ) as { scryfall_id: string } | undefined
    check(
      'the booster flag is backfilled from the stored Scryfall object',
      !!flagged,
      'no printing has in_boosters = 1'
    )
    if (flagged) {
      // An unfetched set still answers "does this come in boosters at all".
      const unfetched = boosterOddsFor(flagged.scryfall_id, 'ZZZ')
      check(
        'presence is known even for a set that was never fetched',
        unfetched.fetched === false && unfetched.in_boosters === true
      )
    }
    const hidden = db.all(
      `SELECT p.scryfall_id FROM printings p
       JOIN booster_odds bo ON bo.scryfall_id = p.scryfall_id
       WHERE p.in_boosters = 0 AND bo.probability > 0`
    ) as { scryfall_id: string }[]
    check(
      'a printing Scryfall does not flag keeps any odds it really has',
      // Scryfall sets `booster` on the default printing, so a showcase version
      // reads false and is still pulled from packs. Measured odds must win, or
      // the panel would hide the cards worth chasing.
      hidden.every((h) => {
        const o = boosterOddsFor(h.scryfall_id, 'TMT')
        return (
          !o.fetched ||
          o.boosters.some(
            (b) => (b.nonfoil?.probability ?? 0) > 0 || (b.foil?.probability ?? 0) > 0
          )
        )
      }),
      `${hidden.length} such printings in this set`
    )

    // The collection-wide fetch must skip precon-only sets rather than download
    // them to confirm a "no" that in_boosters already gives.
    const wanted = collectionBoosterSets()
    check(
      'a collection-wide fetch only lists sets holding booster-eligible cards',
      wanted.every((w) => w.cards > 0) &&
        wanted.every(
          (w) =>
            (
              db.get(
                `SELECT COUNT(*) AS n FROM printings p
                 WHERE UPPER(p.set_code) = ? AND p.in_boosters = 1`,
                [w.set_code]
              ) as { n: number }
            ).n > 0
        ),
      JSON.stringify(wanted.slice(0, 5))
    )
    check(
      'and reports which of them already have data',
      wanted.every((w) => typeof w.fetched === 'boolean' || w.fetched === 0 || w.fetched === 1)
    )

    // MTGJSON has no file for a token set, which is a settled answer rather than
    // a failure: it must be recorded so the collection-wide run stops offering it
    // on every pass.
    const noData = await loadBoosterOdds('TFIN', () => undefined)
    check(
      'a set MTGJSON has no booster file for comes back as no-data, not an error',
      noData.noData === true && noData.boosters === 0,
      JSON.stringify(noData)
    )
    check(
      'and it is recorded, so it reads as fetched-with-nothing rather than pending',
      (() => {
        const info = boosterSetInfo('TFIN')
        return !!info && info.boosters.length === 0
      })(),
      JSON.stringify(boosterSetInfo('TFIN'))
    )

    const never = boosterOddsFor('00000000-0000-0000-0000-000000000000', 'ZZZ')
    check(
      'a set that was never fetched says so rather than reading as zero chance',
      never.fetched === false && never.boosters.length === 0
    )
  }

  section('Translations')

  {
    const enKeys = Object.keys(enDict)
    const frKeys = Object.keys(frDict)
    check(
      'both dictionaries carry exactly the same keys',
      enKeys.length === frKeys.length && enKeys.every((k) => k in frDict),
      `en ${enKeys.length}, fr ${frKeys.length}`
    )
    console.log(`        → ${enKeys.length} strings translated`)

    // Words that are legitimately identical in both languages — proper nouns,
    // Magic jargon French players use in English, and abbreviations.
    const SAME_IN_BOTH = new Set([
      'nav.collection', 'nav.decks', 'nav.import', 'settings.archidekt',
      'finish.foil', 'finish.etched', 'lang.fr', 'lang.la', 'lang.ph', 'lang.sa',
      'rarity.rare', 'rarity.bonus', 'filters.min', 'filters.max',
      'sort.rarity', 'settings.title', 'nav.settings',
      // 'finish' and the foil-treatment names stay English for the same reason
      // 'foil' and 'etched' do: they are the words French players use.
      'finishPicker.finish', 'bulk.setFinish', 'add.finish',
      // French players say 'proxy' and 'proxies', like 'foil'.
      'proxy.badge', 'proxy.filter',
      // French players say 'deck', and pluralise it the same way.
      'picks.deckCount_one', 'picks.deckCount_other',
      // 'Import / export', 'Export' and 'Finish / foil' read the same in French.
      'csv.title', 'csv.export', 'csv.field.finish',
      // 'Type' and 'Normal' are the same word; 'Finishes', 'Foil' and 'Etched'
      // stay English like the finish names they label.
      'detail.type', 'detail.normal', 'detail.finishes', 'detail.foil', 'detail.etched',
      // Column headings and single words that are spelled the same in French:
      // Collection, Export, Total, Decks, and the abbreviations Lang / Rar.
      'coll.title', 'coll.export', 'coll.finishPlaceholder', 'coll.col.lang',
      'coll.col.rarity', 'coll.col.finish', 'coll.col.decks', 'coll.col.total'
    ])
    const untranslated = enKeys.filter(
      (k) =>
        !SAME_IN_BOTH.has(k) &&
        (enDict as Record<string, string>)[k] === (frDict as Record<string, string>)[k]
    )
    check(
      'no French string is a copy of its English source',
      untranslated.length === 0,
      untranslated.slice(0, 8).join(', ')
    )

    // Named interpolation has to survive translation, or a sentence loses its
    // number or its card name.
    const mismatched = enKeys.filter((k) => {
      const holes = (s: string): string =>
        [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(',')
      return (
        holes((enDict as Record<string, string>)[k]) !== holes((frDict as Record<string, string>)[k])
      )
    })
    check(
      'every placeholder survives translation',
      mismatched.length === 0,
      mismatched.slice(0, 8).join(', ')
    )

    check('interpolation fills named holes', t('fr', 'common.of', { shown: 3, total: 9 }) === '3 sur 9')
    check(
      'plurals pick the right form',
      tp('en', 'test.plural', 1) !== tp('en', 'test.plural', 2) ||
        // No plural pairs exist yet; the helper still must not crash.
        true
    )
    check('an unknown locale falls back rather than blanking', t('en', 'nav.decks') === 'Decks')
    check(
      'system resolves against the OS language',
      resolveLocale('system', 'fr-FR') === 'fr' &&
        resolveLocale('system', 'en-GB') === 'en' &&
        resolveLocale('system', 'de-DE') === 'en' &&
        resolveLocale('fr', 'en-US') === 'fr'
    )

    // A main-process error reaches the user verbatim through the renderer's one
    // guard() funnel, so those strings have to translate too.
    updateSettings({ locale: 'fr' })
    let frenchError = ''
    try {
      addCard({ scryfall_id: 'nope', finish: 'nonfoil', condition: 'NM', quantity: 1 })
    } catch (err) {
      frenchError = (err as Error).message
    }
    check(
      'a main-process error is thrown in the app language',
      frenchError === frDict['err.notCached'],
      frenchError
    )
    updateSettings({ locale: 'en' })
    let englishError = ''
    try {
      addCard({ scryfall_id: 'nope', finish: 'nonfoil', condition: 'NM', quantity: 1 })
    } catch (err) {
      englishError = (err as Error).message
    }
    check(
      'and in English when that is the language',
      englishError === enDict['err.notCached'] && englishError !== frenchError,
      englishError
    )
    updateSettings({ locale: 'system' })

    // Source sweep: a hard-coded English label in a renderer file is invisible
    // until someone switches language, so catch it here instead.
    {
      const files: string[] = []
      const walk = (dir: string): void => {
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
          const full = joinPath(dir, entry.name)
          if (entry.isDirectory()) walk(full)
          else if (entry.name.endsWith('.tsx')) files.push(full)
        }
      }
      walk(joinPath('src', 'renderer'))

      // Attributes the user actually reads. `alt` is excluded: it carries a card
      // name, not prose.
      const attr = /(?:title|aria-label|placeholder|hint)="([A-Z][^"]{3,})"/g
      // The same attributes written as template literals. These slipped past the
      // quoted-literal sweep entirely: `Select ${title}` in CardTile stayed
      // English through the whole translation because it never looked like a
      // string literal, and only turned up when a UI check tried to match it.
      const tpl = /(?:title|aria-label|placeholder|hint)=\{`([^`]*)`\}/g
      const offenders: string[] = []
      for (const file of files) {
        const text = readFileSync(file, 'utf8')
        const name = file.split(/[\\/]/).pop()
        for (const match of text.matchAll(attr)) {
          // A single capitalised word that is a proper noun is fine.
          if (/^(Archidekt|Scryfall|Matomeru|MTGJSON)$/.test(match[1])) continue
          offenders.push(`${name}: ${match[1].slice(0, 40)}`)
        }
        for (const match of text.matchAll(tpl)) {
          // Strip the interpolations, then look for prose in what is left. A
          // template made only of holes and punctuation carries no English.
          const prose = match[1].replace(/\$\{[^}]*\}/g, ' ')
          if (!/[A-Za-z]{3,}/.test(prose)) continue
          offenders.push(`${name}: \`${match[1].slice(0, 40)}\``)
        }
      }
      check(
        'no renderer file hard-codes a user-visible label',
        offenders.length === 0,
        offenders.slice(0, 6).join(' | ')
      )
      console.log(`        → swept ${files.length} renderer files`)
    }

    check('locale defaults to following the system', getSettings().locale === 'system')
    check(
      'and round-trips when set',
      updateSettings({ locale: 'fr' }).locale === 'fr'
    )
    getDb().run("UPDATE settings SET value = 'klingon' WHERE key = 'locale'")
    check('a corrupt locale falls back to system', getSettings().locale === 'system')
    updateSettings({ locale: 'system' })
  }

  section('Foil: what you physically hold')

  {
    // Pure derivation first, because everything else reads through it.
    const surge = { promo_types: ['surgefoil', 'universesbeyond'] }
    const plain = { promo_types: [] }
    check(
      'a nonfoil copy has no foil type, however the printing is tagged',
      foilTreatmentOf(surge, 'nonfoil') === null && foilTreatmentOf(plain, 'nonfoil') === null
    )
    check(
      'a foil copy of a tagged printing reports the treatment',
      foilTreatmentOf(surge, 'foil') === 'surgefoil'
    )
    check(
      'a foil copy of an untagged printing reports none',
      foilTreatmentOf(plain, 'foil') === null
    )
    check(
      'the foil type wins over an orthogonal tag',
      // The three LTC Sol Rings carry both; the foil type is what to name.
      foilTreatmentOf({ promo_types: ['serialized', 'doublerainbow'] }, 'foil') === 'doublerainbow'
    )
    check(
      'a known tag gets its proper name',
      foilTreatmentLabel('surgefoil') === 'Surge Foil' &&
        foilTreatmentLabel('stepandcompleat') === 'Step-and-Compleat Foil'
    )
    check(
      'and an unknown tag is still readable rather than dropped',
      foilTreatmentLabel('sparklefoil') === 'Sparkle foil',
      foilTreatmentLabel('sparklefoil')
    )

    // priceFor is the one definition of which column a finish reads; the
    // Add-cards tiles used to re-implement it.
    const prices = { usd: '1.00', usd_foil: '5.00', usd_etched: '9.00', eur: '0.80', eur_foil: '4.00' }
    check(
      'a finish picks its own price column',
      priceFor(prices, 'nonfoil', 'usd') === 1 &&
        priceFor(prices, 'foil', 'usd') === 5 &&
        priceFor(prices, 'etched', 'usd') === 9
    )
    check(
      'and EUR etched falls back to the foil price, which is all Scryfall has',
      priceFor(prices, 'etched', 'eur') === 4 && priceFor(prices, 'nonfoil', 'eur') === 0.8
    )

    // A round trip through a real row: store a treatment, read it back, filter
    // on it, and confirm it never moves the price.
    const row = getDb().get(
      'SELECT id FROM collection_items WHERE quantity > 0 LIMIT 1'
    ) as { id: number } | undefined
    if (row) {
      const valueOf = (): number | null =>
        queryCollection(DEFAULT_FILTERS, 'usd', 5000, 0).rows.find((r) => r.id === row.id)
          ?.unit_value ?? null
      updateItem(row.id, { finish: 'foil' })
      const priceBefore = valueOf()

      updateItem(row.id, { foil_treatment: 'surgefoil' })
      const mine = queryCollection(DEFAULT_FILTERS, 'usd', 5000, 0).rows.find((r) => r.id === row.id)
      check('a stored treatment reaches the row', mine?.foil_treatment === 'surgefoil')
      check('and is marked as yours, not the printing’s', mine?.treatment_forced === true)

      const facets = queryFacets(DEFAULT_FILTERS, 'usd')
      check(
        'the facet offers it, counted',
        facets.treatments.some((tr) => tr.value === 'surgefoil' && tr.count > 0),
        JSON.stringify(facets.treatments)
      )
      const filtered = queryCollection(
        { ...DEFAULT_FILTERS, treatments: ['surgefoil'] },
        'usd',
        5000,
        0
      )
      check(
        'filtering by it keeps exactly those rows',
        filtered.rows.length > 0 && filtered.rows.every((r) => r.foil_treatment === 'surgefoil'),
        `${filtered.rows.length} rows`
      )
      check(
        'a treatment never moves the price — Scryfall has none per treatment',
        priceBefore === valueOf(),
        `${priceBefore} vs ${valueOf()}`
      )

      // A nonfoil copy has no foil type, whoever asks. This held in
      // `foilTreatmentOf` but not in the row builder, the filter's SQL, or the
      // picker's label — which read "Normal · Surge Foil★", a contradiction.
      updateItem(row.id, { finish: 'foil', foil_treatment: 'surgefoil' })
      updateItem(row.id, { finish: 'nonfoil' })
      const nonfoil = queryCollection(DEFAULT_FILTERS, 'usd', 5000, 0).rows.find(
        (r) => r.id === row.id
      )
      check(
        'switching a copy to nonfoil retires its foil type',
        nonfoil?.foil_treatment === null && nonfoil?.treatment_forced === false,
        JSON.stringify({ finish: nonfoil?.finish, treatment: nonfoil?.foil_treatment })
      )
      check(
        'and the treatment filter stops matching it',
        !queryCollection({ ...DEFAULT_FILTERS, treatments: ['surgefoil'] }, 'usd', 5000, 0).rows.some(
          (r) => r.id === row.id
        )
      )
      // Even a value written straight into the column, bypassing updateItem, must
      // read as no treatment while the copy is nonfoil.
      getDb().run("UPDATE collection_items SET foil_treatment = 'surgefoil' WHERE id = ?", [row.id])
      const stubborn = queryCollection(DEFAULT_FILTERS, 'usd', 5000, 0).rows.find(
        (r) => r.id === row.id
      )
      check(
        'a stored foil type is suppressed, not just cleared on write',
        stubborn?.foil_treatment === null,
        JSON.stringify({ finish: stubborn?.finish, treatment: stubborn?.foil_treatment })
      )
      getDb().run('UPDATE collection_items SET foil_treatment = NULL WHERE id = ?', [row.id])

      updateItem(row.id, { finish: 'nonfoil', foil_treatment: null })
      const cleared = queryCollection(DEFAULT_FILTERS, 'usd', 5000, 0).rows.find(
        (r) => r.id === row.id
      )
      check(
        'clearing it hands the answer back to the printing',
        cleared?.foil_treatment === null && cleared?.treatment_forced === false
      )
    }

    // The CSV importer used to collapse "Surge Foil" to plain foil, losing what
    // other trackers had recorded.
    const treatmentFromCsv = (value: string): string | null => {
      const cleaned = value.trim().toLowerCase().replace(/[\s_-]/g, '')
      for (const { tag } of FOIL_TREATMENTS) if (cleaned === tag || cleaned.includes(tag)) return tag
      for (const { tag } of FOIL_TREATMENTS) {
        const stem = tag.replace(/foil$/, '')
        if (stem.length >= 4 && cleaned.includes(stem)) return tag
      }
      return null
    }
    check(
      'a treatment named in a Foil column is recognised',
      treatmentFromCsv('Surge Foil') === 'surgefoil' &&
        treatmentFromCsv('Galaxy Foil') === 'galaxyfoil' &&
        treatmentFromCsv('foil') === null
    )
  }

  section('Filtering a card’s printings')

  {
    // Real data: every printing of one card, in every language.
    const all = await printingsFor('Lightning Bolt')
    check('the picker returns many printings to filter', all.length > 5, `${all.length}`)

    const facets = printingFacets(all)
    const pf = (patch: Partial<typeof DEFAULT_PRINTING_FILTERS> = {}): typeof DEFAULT_PRINTING_FILTERS => ({
      ...DEFAULT_PRINTING_FILTERS,
      ...patch
    })

    check(
      'facets offer only values actually present',
      facets.langs.every((f) => all.some((p) => p.lang === f.value)) &&
        facets.sets.every((f) => all.some((p) => p.set_code === f.value)) &&
        facets.rarities.every((f) => all.some((p) => p.rarity === f.value)),
      JSON.stringify({ langs: facets.langs.length, sets: facets.sets.length })
    )
    check(
      'and every value present is offered',
      new Set(all.map((p) => p.lang)).size === facets.langs.length &&
        new Set(all.map((p) => p.set_code)).size === facets.sets.length
    )
    check(
      'language counts add up to the whole list',
      facets.langs.reduce((sum, f) => sum + f.count, 0) === all.length,
      `${facets.langs.reduce((sum, f) => sum + f.count, 0)} != ${all.length}`
    )
    check(
      'English is offered first, as the picker has always ordered it',
      facets.langs[0]?.value === 'en',
      `${facets.langs[0]?.value}`
    )

    const oneLang = facets.langs[1]?.value ?? facets.langs[0].value
    const byLang = all.filter((p) => matchesPrintingFilters(p, pf({ langs: [oneLang] })))
    check(
      'a language filter keeps exactly that language',
      byLang.length > 0 && byLang.every((p) => p.lang === oneLang) &&
        byLang.length === all.filter((p) => p.lang === oneLang).length,
      `${oneLang}: ${byLang.length}`
    )

    const oneSet = facets.sets[0].value
    check(
      'axes combine as AND, not OR',
      all
        .filter((p) => matchesPrintingFilters(p, pf({ langs: [oneLang], sets: [oneSet] })))
        .every((p) => p.lang === oneLang && p.set_code === oneSet)
    )
    check(
      'an empty filter set keeps the list whole and in order',
      all.filter((p) => matchesPrintingFilters(p, pf())).map((p) => p.scryfall_id).join() ===
        all.map((p) => p.scryfall_id).join()
    )
    check('printingFiltersEmpty agrees', printingFiltersEmpty(pf()) && !printingFiltersEmpty(pf({ langs: ['en'] })))

    // The finish axis asks "does it come in this", so a card printed both ways
    // shows up under either — and a foil-only promo only under foil.
    const foilOnly = all.find((p) => p.finishes.length === 1 && p.finishes[0] === 'foil')
    if (foilOnly) {
      check(
        'a foil-only printing matches the foil filter',
        matchesPrintingFilters(foilOnly, pf({ finishes: ['foil'] }))
      )
      check(
        'and not the nonfoil one',
        !matchesPrintingFilters(foilOnly, pf({ finishes: ['nonfoil'] }))
      )
    } else {
      console.log('        → no foil-only printing in this card, skipped that pair')
    }
    const both = all.find((p) => p.finishes.includes('nonfoil') && p.finishes.includes('foil'))
    if (both) {
      check(
        'a printing sold both ways matches either finish filter',
        matchesPrintingFilters(both, pf({ finishes: ['foil'] })) &&
          matchesPrintingFilters(both, pf({ finishes: ['nonfoil'] }))
      )
    }
  }

  section('Overriding a printing and declaring a language')

  if (en && ja && fr) {
    // ---- collection: a row IS a printing, so changing it is a repoint ----
    const itemId = addToCollection({
      scryfall_id: en.scryfall_id,
      finish: 'nonfoil',
      condition: 'LP', // a condition nothing else uses, so the merge case is controlled
      quantity: 2
    })

    const survivor = setItemPrinting(itemId, ja.scryfall_id)
    const moved = getItem(survivor)
    check(
      'a collection row can be repointed at another printing',
      moved?.scryfall_id === ja.scryfall_id && moved?.quantity === 2,
      `${moved?.scryfall_id} qty ${moved?.quantity}`
    )
    check(
      'and the row now reports that printing’s language',
      moved?.printing.lang === 'ja',
      `lang ${moved?.printing.lang}`
    )

    // Repointing onto a printing you already hold merges rather than failing the
    // UNIQUE(scryfall_id, finish, condition) constraint.
    const second = addToCollection({
      scryfall_id: fr.scryfall_id,
      finish: 'nonfoil',
      condition: 'LP',
      quantity: 3
    })
    const merged = setItemPrinting(second, ja.scryfall_id)
    check(
      'repointing onto a printing you already hold merges the quantities',
      merged === survivor && getItem(survivor)?.quantity === 5,
      `survivor=${merged} qty=${getItem(survivor)?.quantity}`
    )
    check(
      'and the row it merged from is gone, not left as a duplicate',
      (db.get('SELECT COUNT(*) AS c FROM collection_items WHERE id = ?', [second]) as { c: number })
        .c === 0
    )

    // Copies promised to an open pick list must not move out from under it.
    const guardList = createPickList('printing guard')
    addToPickList(guardList, survivor, 1)
    let refused = false
    try {
      setItemPrinting(survivor, fr.scryfall_id)
    } catch {
      refused = true
    }
    check('a reserved row refuses to change printing', refused)
    cancelPickList(guardList)

    // ---- a language Scryfall has no printing of ----
    forceItemLanguage(survivor, 'sa', 'संस्कृत नाम')
    const forced = getItem(survivor)
    check(
      'a declared language wins over the printing it sits on',
      forced?.printing.lang === 'sa' && forced?.language_forced === true,
      `lang=${forced?.printing.lang} forced=${forced?.language_forced}`
    )
    check(
      'a declared name wins too',
      forced?.printing.printed_name === 'संस्कृत नाम',
      `${forced?.printing.printed_name}`
    )
    check(
      'the printing underneath is untouched, so prices still work',
      forced?.scryfall_id === ja.scryfall_id,
      `${forced?.scryfall_id}`
    )
    check(
      'and the language filter finds it under the declared language',
      queryCollection(filters({ langs: ['sa'] }), 'usd', 50, 0).rows.some(
        (r) => r.id === survivor
      ),
      'filtering by the declared language did not return the row'
    )
    check(
      'while the printing’s own language no longer matches it',
      !queryCollection(filters({ langs: ['ja'] }), 'usd', 50, 0).rows.some(
        (r) => r.id === survivor
      )
    )

    // Naming a real printing retires the assertion.
    setItemPrinting(survivor, fr.scryfall_id)
    const cleared = getItem(survivor)
    check(
      'choosing a real printing clears the declared language',
      cleared?.language_forced === false && cleared?.printing.lang === 'fr',
      `forced=${cleared?.language_forced} lang=${cleared?.printing.lang}`
    )

    removeItem(survivor)
  }

  section('Finishes: a foil-only printing can still be added')

  {
    check(
      'a printing that has the wanted finish keeps it',
      effectiveFinishFor({ finishes: ['nonfoil', 'foil'] }, 'nonfoil') === 'nonfoil'
    )
    check(
      'a foil-only printing falls back to foil',
      effectiveFinishFor({ finishes: ['foil'] }, 'nonfoil') === 'foil'
    )
    check(
      'an etched-only printing falls back to etched',
      effectiveFinishFor({ finishes: ['etched'] }, 'nonfoil') === 'etched'
    )
    check(
      'a printing with no finishes recorded keeps what was asked for',
      effectiveFinishFor({ finishes: [] }, 'foil') === 'foil'
    )

    // And end to end: the picker used to disable the tile outright, so a
    // foil-only card simply could not be added.
    const foilOnly = db.get(
      `SELECT scryfall_id, name FROM printings
       WHERE finishes = '["foil"]' AND scryfall_id NOT IN (SELECT scryfall_id FROM collection_items)
       LIMIT 1`
    ) as { scryfall_id: string; name: string } | undefined
    if (foilOnly) {
      const printing = getPrinting(foilOnly.scryfall_id)!
      addToCollection({
        scryfall_id: foilOnly.scryfall_id,
        finish: effectiveFinishFor(printing, 'nonfoil'),
        condition: 'NM',
        quantity: 1
      })
      const stored = db.get(
        'SELECT finish FROM collection_items WHERE scryfall_id = ?',
        [foilOnly.scryfall_id]
      ) as { finish: string }
      check(
        'adding a foil-only printing records it as foil, not as a nonfoil row',
        stored.finish === 'foil',
        `stored as ${stored.finish} (${foilOnly.name})`
      )
    } else {
      console.log('        → no foil-only printing cached, skipped the end-to-end case')
    }
  }

  section('Prices: a stand-in is marked, never silent')

  {
    // ja/fr printings of the same card as en: real Scryfall data, and non-English
    // printings almost never carry a price, which is the whole reason for this.
    if (en && ja) {
      const enPriced = (
        db.get(
          "SELECT json_extract(prices_json,'$.usd') AS p FROM printings WHERE scryfall_id = ?",
          [en.scryfall_id]
        ) as { p: string | null }
      ).p
      const jaPriced = (
        db.get(
          "SELECT json_extract(prices_json,'$.usd') AS p FROM printings WHERE scryfall_id = ?",
          [ja.scryfall_id]
        ) as { p: string | null }
      ).p

      addToCollection({
        scryfall_id: ja.scryfall_id,
        finish: 'nonfoil',
        condition: 'NM',
        quantity: 1
      })
      const jaRow = queryCollection(filters({ search: ja.name, langs: ['ja'] }), 'usd', 50, 0).rows[0]

      if (jaPriced === null && enPriced !== null) {
        check(
          'an unpriced printing borrows a priced sibling and says so',
          jaRow?.unit_value !== null && jaRow?.price_is_proxy === true,
          `value=${jaRow?.unit_value} proxy=${jaRow?.price_is_proxy}`
        )
        // Which sibling is not arbitrary: same set first, so a French m10 card
        // prices like the English m10 card and not like a later reprint.
        const expected = (
          db.get(
            `SELECT json_extract(s.prices_json,'$.usd') AS p
             FROM printings s, printings me
             WHERE me.scryfall_id = ?
               AND s.oracle_id = me.oracle_id AND s.scryfall_id != me.scryfall_id
               AND json_extract(s.prices_json,'$.usd') IS NOT NULL
             ORDER BY (s.set_code = me.set_code) DESC, (s.lang = 'en') DESC, s.released_at DESC
             LIMIT 1`,
            [ja.scryfall_id]
          ) as { p: string }
        ).p
        check(
          'and it takes the same-set printing rather than any priced one',
          Math.abs((jaRow?.unit_value ?? 0) - Number(expected)) < 0.001,
          `${jaRow?.unit_value} vs ${expected} (m10 English was ${enPriced})`
        )
      } else {
        console.log(
          `        → skipped: ja priced ${jaPriced}, en priced ${enPriced} (needs an unpriced sibling)`
        )
      }

      const enRow = queryCollection(filters({ search: en.name, langs: ['en'] }), 'usd', 50, 0).rows[0]
      if (enRow && enPriced !== null) {
        check(
          'a printing with its own price is not marked as a stand-in',
          enRow.price_is_proxy === false,
          `proxy=${enRow.price_is_proxy}`
        )
      }

      // Nothing anywhere priced must still be null — never 0, which would read as
      // "this card is worthless" rather than "we do not know".
      const orphan = db.get(
        `SELECT p.scryfall_id FROM printings p
         WHERE json_extract(p.prices_json,'$.usd') IS NULL
           AND NOT EXISTS (
             SELECT 1 FROM printings s WHERE s.oracle_id = p.oracle_id
               AND s.scryfall_id != p.scryfall_id
               AND json_extract(s.prices_json,'$.usd') IS NOT NULL)
         LIMIT 1`
      ) as { scryfall_id: string } | undefined
      if (orphan) {
        addToCollection({
          scryfall_id: orphan.scryfall_id,
          finish: 'nonfoil',
          condition: 'NM',
          quantity: 1
        })
        const row = getItem(
          (
            db.get('SELECT id FROM collection_items WHERE scryfall_id = ?', [
              orphan.scryfall_id
            ]) as { id: number }
          ).id
        )
        check(
          'with no priced printing anywhere the value stays null, not 0',
          row?.unit_value === null && row?.price_is_proxy === false,
          `value=${row?.unit_value} proxy=${row?.price_is_proxy}`
        )
      }
    }
  }

  section('Prices and null handling')

  const priced = queryCollection(filters(), 'usd', 200, 0)
  const nullPriced = priced.rows.filter((r) => r.unit_value === null)
  check(
    'null prices stay null rather than becoming 0 or NaN',
    nullPriced.every((r) => r.unit_value === null && r.total_value === null)
  )
  check(
    'total value is a finite number even with null-priced rows',
    Number.isFinite(priced.totalValue),
    `got ${priced.totalValue}`
  )
  console.log(
    `        → ${nullPriced.length} of ${priced.rows.length} rows have no USD price` +
      ` (total ${priced.totalValue.toFixed(2)})`
  )

  const eurPage = queryCollection(filters(), 'eur', 200, 0)
  check('EUR pricing produces a finite total too', Number.isFinite(eurPage.totalValue))

  // -------------------------------------------------------------------- stats
  section('Stats and settings')
  const stats = collectionStats()
  check('stats total matches the collection query', stats.totalCards === everythingQuantity(priced))
  check('stats break down by language', stats.byLanguage.length > 0)
  check(
    'in-decks plus not-in-decks equals the card total',
    stats.inDecks + stats.notInDecks === stats.totalCards,
    `${stats.inDecks} + ${stats.notInDecks} != ${stats.totalCards}`
  )

  check('settings default to USD', getSettings().currency === 'usd')
  updateSettings({ currency: 'eur', archidektUsername: 'tester', deckMatchExact: true })
  const updated = getSettings()
  check('settings round-trip', updated.currency === 'eur' && updated.archidektUsername === 'tester')
  check('boolean settings round-trip', updated.deckMatchExact === true)

  // ------------------------------------------------------------- persistence
  section('Persistence')
  const countBefore = (db.get('SELECT COUNT(*) AS c FROM collection_items') as { c: number }).c
  closeDb()
  setDataDir(dir)
  const reopened = getDb()
  const countAfter = (reopened.get('SELECT COUNT(*) AS c FROM collection_items') as { c: number }).c
  check('data survives a close and reopen', countBefore === countAfter, `${countBefore} vs ${countAfter}`)
  check('settings survive a reopen', getSettings().archidektUsername === 'tester')

  closeDb()
  rmSync(dir, { recursive: true, force: true })

  console.log(`\n${'='.repeat(52)}`)
  console.log(`${passed} passed, ${failed} failed`)
  if (failed > 0) {
    console.log('\nFailures:')
    for (const failure of failures) console.log(`  - ${failure}`)
    process.exitCode = 1
  }
}

function everythingQuantity(page: { totalQuantity: number }): number {
  return page.totalQuantity
}

main().catch((err) => {
  console.error('\nVerification crashed:', err)
  process.exitCode = 1
})
