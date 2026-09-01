/**
 * End-to-end verification of the data layer against a real SQLite file and the
 * live Scryfall and Archidekt APIs.
 *
 * Runs in plain Node, no Electron — which is the point of injecting the data
 * directory rather than importing `electron` in the data layer.
 *
 *   npm run verify
 */
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { gunzipSync, gzipSync } from 'node:zlib'
import {
  DEBUG_FLAGS,
  logDebug,
  logDir,
  logError,
  logFile,
  logInfo,
  parseDebugFlag,
  redact,
  RESERVED_FLAGS,
  setVerboseLogging
} from '../src/main/services/log.js'
import { execFileSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join, join as joinPath } from 'node:path'
import { closeDb, getDb, nowIso, setDataDir } from '../src/main/db/connection.js'
import {
  addToCollection,
  cardLocations,
  forceItemLanguage,
  bulkUpdate,
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
  deletePickList,
  getPickListItems,
  revertPickList,
  setPickItemQuantity
} from '../src/main/db/repos/pickLists.js'
import { moveToCollection, moveToDeck, revertMove } from '../src/main/db/repos/moves.js'
import {
  HISTORY_KEPT,
  compress,
  decompress,
  localTouchedSince,
  restoreFromRemote,
  saveToRemote,
  snapshot,
  schemaVersion,
  verifySnapshot,
  type RemoteStore
} from '../src/main/services/backup.js'
import {
  consentUrl,
  DRIVE_SCOPE,
  parseCallback,
  pkcePair
} from '../src/main/services/oauth.js'
import { loopbackOnce, whenListening } from '../src/main/services/loopback.js'
import { chooseSets, numberVariants, parseCollectorNumber } from '../src/shared/quickEntry.js'
import { matchingRowKeys } from '../src/main/db/repos/collection.js'
import { applyLanguageToItem } from '../src/main/services/collectionLanguage.js'
import { setRowLanguages } from '../src/main/services/rowLanguage.js'
import { setCardsLanguage } from '../src/main/services/deckLanguage.js'
import {
  allocateCopies,
  bothSidesTitle,
  hasTwoImages,
  priceOfPrinting,
  twoSides
} from '../src/shared/types.js'
import { ownedCount, ownedCounts } from '../src/main/db/repos/collection.js'
import {
  isNewerVersion,
  notesToText,
  parseFakeUpdate,
  pickAutoUpdater,
  updateMode
} from '../src/main/services/updateCheck.js'
import { shouldPrompt } from '../src/shared/types.js'
import {
  deckBreakdown,
  deckMoves,
  deckTargetsForPrinting,
  discoverLabelColors,
  recomputeLabelPossession,
  replaceDeckCards,
  setCardProxied,
  upsertDeck
} from '../src/main/db/repos/decks.js'
import {
  borrowedPricesFor,
  getPrinting,
  pricedPrintingIds,
  printingsMissingPrices,
  unpricedAmong,
  upsertPrinting
} from '../src/main/db/repos/printings.js'
import {
  byId,
  clearUndoHistory,
  redo,
  undo,
  undoDepth,
  undoable,
  undoableAsync,
  wholeTable,
  type UndoScope
} from '../src/main/db/undo.js'
// The real builders, not restatements of them: testing a journal against scopes
// invented here is what let a bad scope ship.
import {
  collectionKeyScope,
  deckLanguageScopes,
  moveScopes,
  pickListScopes,
  rowLanguageScopes,
  scryfallScopeMany,
  withPickItems
} from '../src/main/db/undoScopes.js'
import { parseLabel } from '../src/main/archidekt/mappers.js'
import { planDeckSync } from '../src/main/services/deckSync.js'
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
  FILL_FLAG,
  fillEnglishPrices,
  fillEnglishPricesQuietly
} from '../src/main/services/priceFill.js'
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
import { FLAT_CARDS, buildDeckBody, buildDeckSections } from '../src/renderer/lib/deckGroups.js'
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
import type { Prices, ProgressEvent } from '../src/shared/types.js'

let passed = 0
let failed = 0
let skipped = 0
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
 * A case the fixture cannot support.
 *
 * Its own outcome, not a pass. These used to be written as `check(label, true)`,
 * which counted an untested path as a verified one and left the total looking
 * healthier than it was — the same failure mode as a check that cannot fail, just
 * spelled differently. Counted separately and printed loudly, so a fixture that
 * quietly stops covering something is visible.
 */
function skip(label: string, why: string): void {
  skipped += 1
  console.log(`  SKIP  ${label} — ${why}`)
}

/**
 * Every card in a deck, flattened out of its groups.
 *
 * The breakdown no longer hands back owned/missing arrays: each card is assigned
 * to exactly one group so the group totals sum to the deck total, and ownership
 * is a property of the card rather than which array it landed in.
 */
/**
 * Two token printings, guaranteed.
 *
 * Synthesised rather than fetched: the recording is a fixed set of Scryfall searches, and
 * whether it happens to contain a token sheet is not something a check should depend on.
 */
function tokenPair(): { a: string; b: string; aName: string; bName: string } {
  const db = getDb()
  const rows = [
    { id: 'verify-token-cat', name: 'Verify Cat', number: '1' },
    { id: 'verify-token-rat', name: 'Verify Rat', number: '3' }
  ]
  for (const row of rows) {
    db.run(
      `INSERT INTO printings
         (scryfall_id, oracle_id, name, lang, set_code, set_name, collector_number,
          rarity, layout, fetched_at)
       VALUES (?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(scryfall_id) DO NOTHING`,
      [row.id, row.id + '-oracle', row.name, 'en', 'tvfy', 'Verify Tokens', row.number,
        'common', 'token', new Date(0).toISOString()]
    )
  }
  return { a: rows[0].id, b: rows[1].id, aName: rows[0].name, bName: rows[1].name }
}

/**
 * Every entry once.
 *
 * It used to flatten the sections, which was the same list while each card belonged to
 * exactly one. A card is now drawn under every category it carries, so flattening returns
 * it several times -- and any check that partitions or counts would be measuring rows.
 */
function allDeckCards(breakdown: DeckBreakdown | null): DeckCardRow[] {
  return breakdown?.cards ?? []
}

/** The UNIQUE key scope an add needs, since the row has no id yet. */
function undoScopeForAdd(scryfallId: string): UndoScope {
  return {
    table: 'collection_items',
    where: 'scryfall_id = ?',
    params: [scryfallId]
  }
}

function section(title: string): void {
  console.log(`\n${title}`)
  console.log('-'.repeat(title.length))
}

const filters = (patch: Partial<CollectionFilters> = {}): CollectionFilters => ({
  ...DEFAULT_FILTERS,
  ...patch
})

/*
  The network, replaced by a recording.

  Two sections of this suite used to call Scryfall and Archidekt for real. That worked
  on one machine and nowhere else: the first CI run was refused by Archidekt with a 403,
  because a shared cloud IP asking for a deck is exactly what gets refused. Deleting the
  sections was not an option either — one of them seeds the printings every later
  section builds on, and the other is thirty checks of mapping and matching.

  So the socket goes and everything else stays. Both clients call the global `fetch`
  (`archidekt/client.ts`, `scryfall/client.ts`, `services/sets.ts`), which means the
  seam already existed and no production code has to know about this. The real clients
  still parse, the real mappers still map, the caching still writes rows.

  An unrecorded URL throws, naming itself. That is the part that makes "the suite does
  not use the network" a property rather than a promise: it stays true when someone adds
  a call later, because their call fails loudly instead of quietly dialling out.
*/
/*
  Gzipped. The recording is 3.6 MB of JSON -- mostly one multilingual Scryfall search and
  one MTGJSON set file -- which compresses about tenfold. `zlib` is built in, and the
  file is machine-written either way, so nothing is lost by not being able to read it
  directly: `npm run verify:record` is how it changes, and the size of the change is
  still visible in the diff.
*/
const FIXTURE = joinPath('scripts', 'fixtures', 'http.json.gz')

interface RecordedResponse {
  status: number
  contentType: string
  body: string
}

function installRecordedHttp(): void {
  const real = globalThis.fetch
  const key = (input: RequestInfo | URL, init?: RequestInit): string =>
    `${init?.method ?? 'GET'} ${String(input)}`

  /*
    The suite's own loopback server is not an API and is never recorded.

    The loopback checks start an HTTP server in this process on an ephemeral port and
    then talk to it. Recording those would capture a port number that will never come
    round again, so the replay would miss and the checks would fail for a reason having
    nothing to do with what they test. Passing them straight through is also honest
    about the rule: nothing leaves the machine.
  */
  const isLoopback = (input: RequestInfo | URL): boolean => {
    try {
      const { hostname } = new URL(String(input))
      return hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '::1'
    } catch {
      return false
    }
  }

  /*
    An argv flag rather than an environment variable: `node .verify.cjs --record` works
    identically from cmd, PowerShell and bash, where quoting an inline env var does not.
  */
  if (process.argv.includes('--record')) {
    const captured: Record<string, RecordedResponse> = {}
    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const response = await real(input, init)
      if (isLoopback(input)) return response
      // Cloned, because the caller still needs to read the body itself.
      const copy = response.clone()
      captured[key(input, init)] = {
        status: copy.status,
        contentType: copy.headers.get('content-type') ?? 'application/json',
        body: await copy.text()
      }
      return response
    }
    process.on('exit', () => {
      mkdirSync(joinPath('scripts', 'fixtures'), { recursive: true })
      // Sorted, so re-recording produces a reviewable diff rather than a reshuffle.
      const sorted = Object.fromEntries(
        Object.entries(captured).sort(([a], [b]) => a.localeCompare(b))
      )
      writeFileSync(FIXTURE, gzipSync(`${JSON.stringify(sorted, null, 2)}\n`))
      console.log(`\nRecorded ${Object.keys(sorted).length} responses to ${FIXTURE}`)
    })
    console.log('Recording live responses — this run DOES use the network.\n')
    return
  }

  let recorded: Record<string, RecordedResponse>
  try {
    recorded = JSON.parse(gunzipSync(readFileSync(FIXTURE)).toString('utf8')) as Record<
      string,
      RecordedResponse
    >
  } catch (err) {
    throw new Error(
      `Could not read ${FIXTURE} (${(err as Error).message}). ` +
        'Run `npm run verify:record` once to create it.'
    )
  }

  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    if (isLoopback(input)) return real(input, init)
    const wanted = key(input, init)
    const hit = recorded[wanted]
    if (!hit) {
      throw new Error(
        `No recorded response for ${wanted}. This suite does not use the network; ` +
          'run `npm run verify:record` to capture it.'
      )
    }
    return new Response(hit.body, {
      status: hit.status,
      headers: { 'content-type': hit.contentType }
    })
  }
}

async function main(): Promise<void> {
  installRecordedHttp()
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
  section('Language handling (recorded Scryfall)')

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
  section('Fast entry: the number, and the sheet it names')
  {
    const num = parseCollectorNumber

    /*
      The regression that matters most. `c17 8` is Teferi's Protection and `c17 008/011`
      is a Cat Warrior token, and the printed fraction is the only thing that tells the
      two apart -- the point of that work was a wrong card landing silently, so trading
      it for a different wrong card would be no fix at all.

      Asked of the number alone now. Fast entry was one typed line and a parser for it;
      it is four fields, and the number is the only part that still needs reading rather
      than taking at face value.
    */
    check('a bare number asks for no sheet, so nothing about its resolution changes',
      num('8').sheetTotal === null && num('8').collectorNumber === '8',
      JSON.stringify(num('8')))
    check('the printed fraction keeps the number and remembers the total',
      JSON.stringify(num('008/011')) ===
        JSON.stringify({ collectorNumber: '8', sheetTotal: 11 }),
      JSON.stringify(num('008/011')))

    // ---- leading zeros, which the API rejects outright
    check('leading zeros are stripped, because Scryfall 404s on them',
      num('008').collectorNumber === '8', JSON.stringify(num('008')))
    check('but only the zeros, so a suffix survives',
      num('008a').collectorNumber === '8a', JSON.stringify(num('008a')))
    check('a number that is already bare is untouched',
      num('301a').collectorNumber === '301a')
    check('and a star is not a digit',
      num('12\u2605').collectorNumber === '12\u2605', JSON.stringify(num('12\u2605')))
    check('a zero-only number is left alone rather than emptied',
      num('0').collectorNumber === '0', JSON.stringify(num('0')))
    check('and an empty number stays empty, which is what the form refuses on',
      num('').collectorNumber === '' && num('   '.trim()).collectorNumber === '',
      JSON.stringify(num('')))

    /*
      Only digits either side counts as a fraction. No collector number among 512
      sampled from the oddest-numbered sets -- memorabilia, promos, tokens, funny --
      contains a slash at all, so this costs nothing today and leaves room for one.
    */
    check('a slash with anything but digits is part of the number, not a fraction',
      num('1/2a').collectorNumber === '1/2a' && num('1/2a').sheetTotal === null,
      JSON.stringify(num('1/2a')))

    /*
      Case, which is not something anyone reads off a card. Scryfall is strict and
      inconsistent about it -- unf/200a exists and unf/200A does not, plst/TDFT-14
      exists and plst/tdft-14 does not -- so the typed form is tried first and the
      others only on the way to a failure.
    */
    check('the number as typed is always tried first',
      numberVariants('200a')[0] === '200a' && numberVariants('TDFT-14')[0] === 'TDFT-14')
    check('and both cases are tried, since neither convention covers the other',
      numberVariants('tdft-14').includes('TDFT-14') &&
        numberVariants('200A').includes('200a'),
      JSON.stringify(numberVariants('tdft-14')))
    check('a number with no letters costs exactly one attempt',
      numberVariants('146').length === 1, JSON.stringify(numberVariants('146')))

    /*
      And the form refuses what the parser cannot rescue. A set with no number would
      resolve to whatever `/cards/c17/` happens to answer, which is the silent-wrong-card
      failure again from a different direction.
    */
    {
      const view = readFileSync(joinPath('src', 'renderer', 'views', 'AddCardsView.tsx'), 'utf8')
      check('fast entry refuses a missing set or number rather than guessing',
        /if \(!set \|\| !collectorNumber\)/.test(view),
        'a half-filled form would be sent to Scryfall')
      check('and only the number clears between cards when you asked to keep the rest',
        /if \(!keepFields\)/.test(view) && /setNumber\(''\)/.test(view),
        'the set and language would be retyped for every card in a pile')
    }

    // ---- which sheet the total names
    const C17 = [
      { code: 'c17', total: 309 },
      { code: 'tc17', total: 11 }
    ]
    check('the token sheet is chosen when the total is the sheet size',
      JSON.stringify(chooseSets(C17, 'c17', 11)) === JSON.stringify(['tc17', 'c17']),
      JSON.stringify(chooseSets(C17, 'c17', 11)))
    check('the typed set is chosen when the total is its own size',
      JSON.stringify(chooseSets(C17, 'c17', 309)) === JSON.stringify(['c17']),
      JSON.stringify(chooseSets(C17, 'c17', 309)))
    /*
      A null total is not a total of null. The sibling here has an unknown size, so
      without the early return an untyped line would start matching it.
    */
    check('no total means no choice at all, which is how it behaved before',
      JSON.stringify(chooseSets(
        [{ code: 'c17', total: 309 }, { code: 'tc17', total: null }], 'c17', null)) ===
        JSON.stringify(['c17']),
      JSON.stringify(chooseSets(
        [{ code: 'c17', total: 309 }, { code: 'tc17', total: null }], 'c17', null)))
    /*
      The rule that keeps this safe. Bloomburrow prints /261 and Scryfall counts 398,
      so a total matching nothing is normal for an ordinary card and must not stop it
      being added.
    */
    check('a total that matches nothing still adds the card that was typed',
      JSON.stringify(chooseSets([{ code: 'blb', total: 398 }], 'blb', 261)) ===
        JSON.stringify(['blb']),
      JSON.stringify(chooseSets([{ code: 'blb', total: 398 }], 'blb', 261)))
    check('an empty set cache degrades to the typed set rather than refusing',
      JSON.stringify(chooseSets([], 'c17', 11)) === JSON.stringify(['c17']))
    check('a sheet the same size as its parent never steals the exact match',
      JSON.stringify(chooseSets(
        [{ code: 'zzz', total: 20 }, { code: 'tzzz', total: 20 }], 'zzz', 20)) ===
        JSON.stringify(['tzzz', 'zzz']),
      'the typed set must be tried first when both match')
    check('and the order does not depend on the order rows arrived in',
      JSON.stringify(chooseSets(
        [{ code: 'tb', total: 7 }, { code: 'ta', total: 7 }], 'x', 7)) ===
        JSON.stringify(['ta', 'tb', 'x']),
      JSON.stringify(chooseSets([{ code: 'tb', total: 7 }, { code: 'ta', total: 7 }], 'x', 7)))
    check('an unknown size never matches, not even a null total',
      JSON.stringify(chooseSets([{ code: 'q', total: null }], 'q', 11)) ===
        JSON.stringify(['q']))
  }

  section('Both sides of a double-faced card')
  {
    /*
      Which layouts have a picture per face, and which merely have two names.

      Measured against Scryfall, because the distinction is not the one the names
      suggest: a battle is filed under `transform`, while split, flip, adventure and
      meld cards are all called "A // B" and have exactly one image. Getting this
      list wrong in the generous direction shows the front twice and calls it a flip.
    */
    for (const layout of ['transform', 'modal_dfc', 'double_faced_token',
      'reversible_card', 'art_series']) {
      check(`${layout} has a picture per face`, hasTwoImages(layout))
    }
    for (const layout of ['split', 'flip', 'adventure', 'meld', 'normal', 'token', 'saga']) {
      check(`${layout} does not, however its name reads`, !hasTwoImages(layout),
        'the flip would show the front twice')
    }
    check('and an unknown or missing layout is not assumed to flip',
      !hasTwoImages(null) && !hasTwoImages(undefined) && !hasTwoImages('whatever-is-next'))

    /*
      The compatibility rule, as a tripwire on the files.

      Every cached image on disk and every URL already built name the front without
      saying so. If the face were appended unconditionally, the whole cache would be
      orphaned and silently re-downloaded -- which no unit test would notice, because
      the app would still work.
    */
    {
      const cache = readFileSync(joinPath('src', 'main', 'services', 'imageCache.ts'), 'utf8')
      check('face 0 keeps the filename it has always had',
        /face === 0 [?] '' :/.test(cache),
        'every already-cached image would be orphaned')
      check('the route treats a missing face as the front',
        /searchParams\.get\('face'\) === '1' [?] 1 : 0/.test(cache),
        'an old URL would change meaning')
      check('and the in-flight key includes the face, or both sides share a download',
        /\$\{scryfallId\}:\$\{size\}:\$\{face\}/.test(cache),
        'the front download would be handed back for the back')

      const preload = readFileSync(joinPath('src', 'preload', 'index.ts'), 'utf8')
      check('and the URL only mentions a face when it is not the front',
        /face === 1 [?] '&face=1' : ''/.test(preload),
        'every image URL in the app would change shape')
    }
  }

  section('Naming a card that has two sides')
  {
    const KEFKA = {
      scryfall_id: 'kefka',
      name: 'Kefka, Court Mage // Kefka, Ruler of Ruin',
      printed_name: null,
      layout: 'transform'
    }
    const TOKEN = { scryfall_id: 'dft', name: 'Cat Warrior // Rat', printed_name: null,
      layout: 'double_faced_token' }
    const BOLT = { scryfall_id: 'bolt', name: 'Lightning Bolt', printed_name: null,
      layout: 'normal' }
    const SPLIT = { scryfall_id: 'split', name: 'Yeah Nah // Nah Yeah', printed_name: null,
      layout: 'split' }

    // ---- a double-sided token, which is one printing with two faces like any other
    const tokenSides = twoSides(TOKEN)
    check('a double-faced token has two sides',
      tokenSides?.front.title === 'Cat Warrior' && tokenSides?.back.title === 'Rat',
      JSON.stringify(tokenSides))
    check('and the second picture is its second face, not another card',
      tokenSides?.back.scryfallId === 'dft' && tokenSides?.back.face === 1,
      JSON.stringify(tokenSides))

    // ---- one printing, two faces
    const kefkaSides = twoSides(KEFKA)
    check('a transform card has two sides on one printing',
      kefkaSides?.front.scryfallId === 'kefka' && kefkaSides?.back.scryfallId === 'kefka',
      JSON.stringify(kefkaSides))
    check('and the second picture is its second face',
      kefkaSides?.front.face === 0 && kefkaSides?.back.face === 1, JSON.stringify(kefkaSides))
    check('its names come from either side of the separator',
      kefkaSides?.front.title === 'Kefka, Court Mage' &&
        kefkaSides?.back.title === 'Kefka, Ruler of Ruin',
      JSON.stringify(kefkaSides))

    /*
      The trap the layout list exists for: a split card is named "A // B" and has
      exactly one picture, so a stack drawn from the name alone would show the same
      art twice and call it a flip.
    */
    check('a split card has one side, however its name reads',
      twoSides(SPLIT) === null, JSON.stringify(twoSides(SPLIT)))
    check('and an ordinary card has one side',
      twoSides(BOLT) === null)

    // ---- the name a tile shows
    check('a two-faced card keeps the name Scryfall already gave it',
      bothSidesTitle(KEFKA) === 'Kefka, Court Mage // Kefka, Ruler of Ruin',
      bothSidesTitle(KEFKA))
    check('and so does a double-faced token',
      bothSidesTitle(TOKEN) === 'Cat Warrior // Rat', bothSidesTitle(TOKEN))
    check('and a one-sided card is named once',
      bothSidesTitle(BOLT) === 'Lightning Bolt' &&
        bothSidesTitle(SPLIT) === 'Yeah Nah // Nah Yeah',
      `${bothSidesTitle(BOLT)} | ${bothSidesTitle(SPLIT)}`)
    check('a localized name is preferred, on both sides',
      bothSidesTitle({ ...TOKEN, printed_name: 'Guerrier chat // Rat' }) ===
        'Guerrier chat // Rat')

    /*
      The three primitives a tile is handed, from the shape a row actually has.

      The views flatten `twoSides` into `backScryfallId` / `backFace` / `hiddenTitle`
      rather than passing an object, because `CardTile` is memoized and a fresh object
      each render defeats that. This is that flattening, on both kinds of two-sidedness.
    */
    {
      const kefka = twoSides(KEFKA)
      check('a two-faced card hands the tile the same id at face 1',
        kefka?.back.scryfallId === 'kefka' && kefka?.back.face === 1)
      check('and a double-faced token does the same, being one printing',
        twoSides(TOKEN)?.back.scryfallId === 'dft' && twoSides(TOKEN)?.back.face === 1)
      check('the front title is the side that goes in front',
        kefka?.front.title === 'Kefka, Court Mage' &&
          twoSides(TOKEN)?.front.title === 'Cat Warrior')
      check('a one-sided card hands it nothing, so the tile draws one image',
        twoSides(BOLT) === null && twoSides(SPLIT) === null)
    }

    /*
      And the tile actually asks. The table row was taught about the other side and
      the gallery tile is a different component that was not, so a merged card read as
      "Cat Warrior" in the one view a card is usually looked at in.
    */
    {
      const view = readFileSync(joinPath('src', 'renderer', 'views', 'CollectionView.tsx'), 'utf8')
      check('the gallery tile names the card through the helper, not from one printing',
        /title=\{bothSidesTitle\(row\.printing\)\}/.test(view),
        'the gallery tile would show one name for a two-sided card')

      const tile = readFileSync(joinPath('src', 'renderer', 'components', 'CardTile.tsx'), 'utf8')
      check('and the tile draws through the stack rather than a single image',
        tile.includes('<StackedArt') && !tile.includes('<CardImage'),
        'a two-sided card would render as one picture')

      const art = readFileSync(joinPath('src', 'renderer', 'components', 'primitives.tsx'), 'utf8')
      /*
        Two facts that are harmless apart and broke the layout together.

        `CardImage` hardcodes `relative` on its own wrapper, and `StackedArt` used to hand
        it `absolute` through the same `className`. Equal specificity, one element, and
        Tailwind emits `.relative` after `.absolute` -- so the later rule won however the
        classes were ordered in the attribute, every card laid out in normal flow, and the
        tile grew to twice the height of its neighbours.

        Stated as a pair because either one alone is fine. The positioning belongs on the
        wrapper `StackedArt` owns, which is what the `data-side` elements are.
      */
      check('CardImage still positions itself, so nothing may pass it a position',
        /className=\{`relative overflow-hidden/.test(art),
        'CardImage no longer sets relative -- this check has lost its subject')
      {
        const stacked = art.slice(art.indexOf('export function StackedArt'),
          art.indexOf('export function CardImage'))
        /*
          The stack is its own stacking context.

          Without `isolate` its z-10 and z-20 compete with the tile's own name, footer and
          badges -- which are later siblings with no z-index -- and win, so the card
          covered the information printed over it.
        */
        check('the stack is isolated, so its layers cannot cover the tile itself',
          /className=\{`relative isolate/.test(stacked),
          'the cards would paint over the name and the badges again')
        /*
          And the tile is still. Turning cards over on hover came out: the detail dialog
          flips the card properly, so a grid that reacted to the pointer crossing it was
          movement for its own sake.
        */
        check('the stack does not react to the pointer at all',
          // Variants, not the word: the comment above the component explains that the
          // hover came out, and a bare /hover/ matched its own prose.
          !/(group-hover|peer-hover|hover:)/.test(stacked) && !/data-shield/.test(stacked),
          'the tile is turning cards over again')
        check('and the stack positions its own wrappers rather than the cards',
          /data-side="back"/.test(stacked) && /data-side="front"/.test(stacked) &&
            // Attributes only: `[^>]*` stops at the element's own closing bracket, so the
            // next wrapper's `absolute` cannot be mistaken for the card's.
            !/<CardImage[^>]*absolute/.test(stacked),
          'a position handed to CardImage is silently overridden by its own relative')
      }
      /*
        The dialog's size, and where the two sides come from.

        Two requirements that pull against each other, which is why both are stated here.
        It must follow its content -- a short card in a window-height dialog is a lot of
        empty space -- and it must not move while you are using it, because turning a card
        over swaps the rules text and a dialog that resized under the pointer was the
        original complaint.

        The resolution is a ceiling rather than a fixed height, plus both faces' text in
        one grid cell so the taller of the two sets a height that the flip cannot change.
        Take either half away and one of the two requirements breaks silently, so the
        tripwire names both.
      */
      {
        const modal = readFileSync(
          joinPath('src', 'renderer', 'components', 'CardDetailModal.tsx'), 'utf8')
        check('the card dialog asks for a ceiling, not a fixed height',
          /maxHeight="max-h-\[\d+vh\]"/.test(modal) && !/height="h-\[\d+vh\]"/.test(modal),
          'a fixed height leaves a short card sitting in empty space')
        check('and both faces share one cell, so turning a card over cannot resize it',
          /\[grid-area:1\/1\]/.test(modal) && /\[0, 1\]\.map/.test(modal),
          'the height would follow whichever face is showing, moving the dialog mid-flip')
        check('and it derives the two sides from the same helper the tiles use',
          /twoSides\(printing\)/.test(modal),
          'the dialog would answer "what is the back of this card" on its own')
        check('and the card turns over rather than cutting between two pictures',
          /rotateY: turned \? 180 : 0/.test(modal) &&
            /\[transform-style:preserve-3d\]/.test(modal),
          'the sides would swap instantly')
      }
      check('a card with no other side still renders exactly one image',
        /if \(!backScryfallId\) \{\s*return <CardImage/.test(art),
        'the ordinary case no longer short-circuits')
    }
  }

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

  /*
    What the card does, not just what it is called.

    The search box read name, localized name, set, number and both type lines -- so
    "3 damage" found nothing, on a collection full of cards that deal 3 damage. Both text
    columns are searched rather than a COALESCE of them, which is what lets an English term
    find a localized printing and the localized wording find it too.
  */
  {
    const byRules = queryCollection(filters({ search: '3 damage' }), 'usd', 100, 0)
    check('a term only in the rules text finds the card',
      byRules.total === byEnglishName.total && byRules.total > 0,
      `rules=${byRules.total} name=${byEnglishName.total}`)
    check('and it is the same rows the name search finds, not a superset',
      JSON.stringify(byRules.rows.map((r) => r.key).sort()) ===
        JSON.stringify(byEnglishName.rows.map((r) => r.key).sort()),
      JSON.stringify({ rules: byRules.rows.length, name: byEnglishName.rows.length }))

    /*
      The localized text too. Taken from the printing rather than typed in, so this asserts
      what the database actually holds instead of what a Japanese Lightning Bolt is assumed
      to say.
    */
    const jaText = (ja?.printed_text ?? '').trim()
    if (jaText.length >= 4) {
      const fragment = jaText.slice(0, 4)
      const byJaText = queryCollection(filters({ search: fragment }), 'usd', 100, 0)
      check(`a fragment of the localized text "${fragment}" finds the JA rows`,
        byJaText.total === 2, `got ${byJaText.total}`)
    } else {
      check('the JA printing carries localized rules text to search',
        false, `printed_text was ${JSON.stringify(jaText)}`)
    }

    check('and a term in no field still matches nothing',
      queryCollection(filters({ search: 'zzzz-not-in-any-field' }), 'usd', 100, 0).total === 0)
  }

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
  /*
    Select-all has to mean the same thing the list means.

    The list draws one page of what can be a much larger filtered set, so selecting
    "everything" cannot be answered from the rows in hand. Both answers come from the same
    `buildWhere`, and this is what holds them together: a filter the page understands and
    the select-all does not would select the wrong cards silently, which is the worst way
    for a bulk edit to be wrong.
  */
  {
    const cases: [string, ReturnType<typeof filters>][] = [
      ['no filters at all', filters({})],
      ['a name search', filters({ search: 'Lightning Bolt' })],
      ['a language', filters({ langs: ['ja'] })],
      ['a finish', filters({ finishes: ['nonfoil'] })],
      ['something that matches nothing', filters({ search: 'zzzz-no-such-card' })]
    ]
    for (const [label, f] of cases) {
      const page = queryCollection(f, 'usd', 100000, 0)
      const all = matchingRowKeys(f, 'usd')
      const fromPage = page.rows.map((r) => r.key).sort()
      const fromAll = all.rows.map((r) => r.key).sort()
      check(`select-all matches the list for ${label}`,
        JSON.stringify(fromPage) === JSON.stringify(fromAll),
        JSON.stringify({ page: fromPage.length, all: fromAll.length,
          onlyInPage: fromPage.filter((k) => !fromAll.includes(k)).slice(0, 3),
          onlyInAll: fromAll.filter((k) => !fromPage.includes(k)).slice(0, 3) }))
    }
    /*
      And the id travels with the key, because a row the list has not loaded has no row
      object on the other side of the IPC -- an edit would have nothing to apply to.
    */
    const everything = matchingRowKeys(filters({}), 'usd')
    const owned = everything.rows.filter((r) => r.key.startsWith('collection:'))
    check('every collection row carries the id an edit needs',
      owned.length > 0 && owned.every((r) => typeof r.id === 'number'),
      JSON.stringify(owned.slice(0, 3)))
    check('and a sleeved row carries none, because there is nothing to edit',
      everything.rows.filter((r) => r.key.startsWith('deck:')).every((r) => r.id === null))
    // The cap is real and says so, rather than handing over an unbounded array.
    const capped = matchingRowKeys(filters({}), 'usd', 1)
    check('the cap holds, and reports that it held',
      capped.rows.length === 1 && capped.truncated === true,
      JSON.stringify(capped))
    check('and an uncapped answer does not claim it was truncated',
      everything.truncated === false)
  }

  section('Pick list: reserve, then validate')

  const listId = createPickList('Trade with Alice')
  const staged = addToPickList(listId, { kind: 'collection', itemId: jaItemId }, 5)
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
  const over = addToPickList(listId, { kind: 'collection', itemId: jaItemId }, 99)
  check('over-picking is capped, not rejected', over.added === 7 && over.capped, `added ${over.added}`)
  const capped = addToPickList(listId, { kind: 'collection', itemId: jaItemId }, 1)
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
  addToPickList(listId2, { kind: 'collection', itemId: jaItemId }, 5)
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
  addToPickList(listId3, { kind: 'collection', itemId: jaItemId }, 7)
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
  section('Archidekt deck mapping and matching (recorded)')

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

    /*
      Re-fetching one deck, which is what the per-deck button does.

      The all-decks sync skips any deck whose stored `external_updated_at` matches what the
      profile reports, so a deck you re-labelled in Archidekt and nothing else is skipped
      indefinitely and keeps reporting the labels it had. A button that could be skipped
      would be a button that does nothing on the deck you pressed it for.
    */
    {
      // Pretend we are perfectly up to date, which is when the all-decks sync gives up.
      db.run('UPDATE decks SET external_updated_at = ? WHERE id = ?', ['2099-01-01T00:00:00Z', deckId])
      // A sentinel the fetch cannot know about: if the rows are rewritten, it is gone.
      db.run("UPDATE deck_cards SET label = 'sentinel,#000001' WHERE deck_id = ?", [deckId])
      await addDeckByUrl(String(archidektDeck.id))
      const sentinels = (
        db.get("SELECT COUNT(*) AS c FROM deck_cards WHERE deck_id = ? AND label = 'sentinel,#000001'",
          [deckId]) as { c: number }
      ).c
      check('re-fetching one deck rewrites its cards even when it looks unchanged',
        sentinels === 0, `${sentinels} rows survived`)

      /*
        And the possession flag is re-derived as part of it. `syncOneDeck` on its own does
        not do this -- nor does it cache printings -- which is why the handler goes through
        `addDeckByUrl`, the wrapper that completes the sequence.
      */
      const unflagged = (
        db.get(`SELECT COUNT(*) AS c FROM deck_cards
                 WHERE deck_id = ? AND (label IS NULL OR label = '') AND label_possession IS NULL`,
          [deckId]) as { c: number }
      ).c
      check('and the possession flag is re-derived with it', unflagged === 0,
        `${unflagged} unlabelled rows left unflagged`)
    }

    /*
      The handler's own wiring, which no fixture can reach: it is registered on ipcMain.
      Three decisions are pinned here because each one is silent when wrong -- a deck with
      no printings looks like a deck with no prices, and a private deck that only threw
      looks healthy the next time you open the app.
    */
    {
      const src = readFileSync(joinPath('src', 'main', 'ipc', 'handlers.ts'), 'utf8')
      const start = src.indexOf("handle('decks:syncOne'")
      const body = start === -1 ? '' : src.slice(start, src.indexOf("handle('decks:addByUrl'", start))
      check('the per-deck sync handler exists', start !== -1, 'no decks:syncOne handler')
      check('and goes through the wrapper that caches printings and re-derives labels',
        /addDeckByUrl\(/.test(body) && !/syncOneDeck\(/.test(body),
        'calling syncOneDeck directly leaves deck cards with no printing row')
      check('and clears the undo history, like the other two sync paths',
        /clearUndoHistory\(\)/.test(body), 'an undo would reach across a rewrite of every card row')
      check('and records a failure on the deck rather than only throwing',
        /recordDeckError\(/.test(body), 'a private deck would look healthy after a failed retry')
    }

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
        /*
          Two tables, one question. The finish is a correction to the decklist entry and
          lives on the override; the treatment describes the copies and moved to
          `deck_entry_traits` with migration 18. Both have to survive a sync, which is
          what this section is about, so both are read.
        */
        const readBack = (): { finish: string; treatment: string | null } | undefined => {
          const row = db.get(
            'SELECT finish FROM deck_card_overrides WHERE deck_id = ? AND oracle_id = ?',
            [deckId, target.oracle_id]
          ) as { finish: string } | undefined
          if (!row) return undefined
          const trait = db.get(
            `SELECT foil_treatment AS treatment FROM deck_entry_traits
              WHERE deck_id = ? AND oracle_id = ?`,
            [deckId, target.oracle_id]
          ) as { treatment: string | null } | undefined
          return { finish: row.finish, treatment: trait?.treatment ?? null }
        }
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
      const cards0 = (deckBreakdown(deckId, 'usd', false)?.cards ?? [])
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
      /*
        Three buckets now, not two: in the deck, in your bulk, missing. A card sitting in
        your collection used to be counted as owned, so a deck holding none of a card you
        had four of read "have 4" and turned green.
      */
      check(
        'in-deck, in-bulk and missing account for every card, excluded ones included',
        totals.ownedCards + totals.inCollectionCards + totals.missingCards === totals.cards,
        `${totals.ownedCards} + ${totals.inCollectionCards} + ${totals.missingCards}` +
          ` != ${totals.cards}`
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
        'and the sections add up to the same buckets the header reports',
        exact!.groups.reduce((sum, g) => sum + g.ownedCards, 0) === totals.ownedCards &&
          exact!.groups.reduce((sum, g) => sum + g.inCollectionCards, 0) ===
            totals.inCollectionCards &&
          exact!.groups.reduce((sum, g) => sum + g.missingCards, 0) === totals.missingCards,
        `sections ${exact!.groups.reduce((sum, g) => sum + g.missingCards, 0)} missing` +
          ` vs header ${totals.missingCards}`
      )
      /*
        The sections partition the deck.

        A card is drawn under the category Archidekt lists first, not under all of them, so
        the sections add up to the deck exactly. Between these two states this check briefly
        asserted the opposite -- that they over-counted, one appearance per category -- which
        is the model the report after it rejected.
      */
      check(
        'the sections partition the deck: each card is drawn once',
        exact!.groups.reduce((sum, g) => sum + g.cardCount, 0) === totals.cards,
        'the sections do not add up to the deck'
      )
      check(
        'and each card is drawn under a section the breakdown reports',
        exactCards.every((card) => exact!.groups.some((g) => g.name === card.section)),
        'a card names a section the breakdown does not report'
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

    /*
      Everything unlabelled gets a colour the map never mentions, for the reason the
      "I own this" section spells out: an unlabelled card counts as owned now, so a fixture
      that leaves cards unlabelled would have this section measuring that rule rather than
      the one it was written for -- what marking a colour "do not own" does.
    */
    db.run(
      `UPDATE deck_cards SET label = 'Untagged,#123456'
       WHERE label IS NULL OR label = ''`
    )
    recomputeLabelPossession({})

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

    /*
      Baseline with nothing tagged owned. This is the property that lets the rest of the
      suite stand: the union adds nothing until a colour is opted in.

      Every deck card is given a label first, in a colour the map never mentions. An
      *unlabelled* card now counts as owned -- Archidekt sends `label: ""` for a deck
      nobody has marked up, and four real precons reported cards their owner held as
      missing because of it -- so a fixture built on unlabelled cards would start with
      derived rows and this baseline would be measuring the new rule instead of the thing
      it was written for, which is "a colour has to be opted into".
    */
    db.run(
      `UPDATE deck_cards SET label = 'Untagged,#123456'
       WHERE label IS NULL OR label = ''`
    )
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
      /*
        A sleeved card used to be unpullable by construction — the derived branch
        of ROW_SOURCES hardcoded a 0 here. It is pullable now: it is still a card
        you physically hold, and a pick list is exactly the thing for taking it
        out of the deck. What must stay true is that nothing is reserved yet.
      */
      /*
        A sleeved card is not "available" in the collection sense — that number is
        about staging a collection row, and a deck card is reached by moving it or
        by naming its deck on a list. Its quantity is what says the copies exist.
      */
      check('a derived row reports the copies the deck holds', derived?.quantity === fresh.quantity)
      check('and offers none of them as bulk stock', derived?.available === 0)

      /*
        Moving cards between a deck and the collection.

        The governing property is conservation: a move relocates a card, so the
        total count and the total value must be identical either side of it. Every
        assertion here is a before/after comparison rather than a fixed number, so
        it survives whatever the fixture happens to hold.
      */
      /*
        A card with no label at all counts as owned, and a colour still wins where there
        is one.

        This is the fix for four Commander 2017 precons in a real collection: Archidekt
        sends `label: ""` for a deck nobody has marked up, so no colour mapping could
        reach 347 cards and every deck reported cards their owner held as missing. The
        second half is what keeps it a default rather than an override.
      */
      {
        const bare = db.get(
          `SELECT dc.scryfall_id, dc.oracle_id, dc.quantity FROM deck_cards dc
            WHERE dc.deck_id = ? AND dc.oracle_id IS NOT NULL AND dc.scryfall_id != ?
            LIMIT 1`,
          [deckId3, fresh.scryfall_id]
        ) as { scryfall_id: string; oracle_id: string; quantity: number } | undefined
        if (!bare) {
          check('a second deck card to leave unlabelled', false, 'fixture too thin')
        } else {
          const entryOf = (oracleId: string): DeckCardRow | undefined =>
            allDeckCards(deckBreakdown(deckId3, 'usd', false)).find(
              (c) => c.oracle_id === oracleId
            )
          db.run('UPDATE deck_cards SET label = ? WHERE deck_id = ? AND scryfall_id = ?', [
            '',
            deckId3,
            bare.scryfall_id
          ])
          // A map that cannot possibly match an empty label.
          recomputeLabelPossession({ '#4caf50': 'owned' })
          const unlabelled = entryOf(bare.oracle_id)
          check('a card with no label at all counts as owned',
            unlabelled?.label_possession === 'owned',
            JSON.stringify({ possession: unlabelled?.label_possession }))
          check('so the deck stops reporting it as missing',
            (unlabelled?.held ?? 0) >= (unlabelled?.quantity ?? 1),
            JSON.stringify({ held: unlabelled?.held, need: unlabelled?.quantity }))

          // And a colour decides wherever there is one, including one that means "no".
          db.run('UPDATE deck_cards SET label = ? WHERE deck_id = ? AND scryfall_id = ?', [
            'Do not Have,#f47373',
            deckId3,
            bare.scryfall_id
          ])
          recomputeLabelPossession({ '#f47373': 'not_owned' })
          check('a colour still decides where the card has one',
            entryOf(bare.oracle_id)?.label_possession === 'not_owned',
            JSON.stringify({ possession: entryOf(bare.oracle_id)?.label_possession }))

          // Back to the state the rest of this section expects.
          db.run('UPDATE deck_cards SET label = ? WHERE deck_id = ? AND scryfall_id = ?', [
            'Untagged,#123456',
            deckId3,
            bare.scryfall_id
          ])
          recomputeLabelPossession({ '#4caf50': 'owned' })
        }
      }

      const oracleOf = (scryfallId: string): string =>
        (
          db.get('SELECT oracle_id FROM printings WHERE scryfall_id = ?', [scryfallId]) as {
            oracle_id: string
          }
        ).oracle_id
      const moveOracle = oracleOf(fresh.scryfall_id)

      const holdings = (): { quantity: number; value: number } => {
        const page = queryCollection(filters(), 'usd', 500, 0)
        return { quantity: page.totalQuantity, value: page.totalValue ?? 0 }
      }
      const deckCards = (): DeckCardRow[] => allDeckCards(deckBreakdown(deckId3, 'usd', false))
      const entryFor = (oracleId: string): DeckCardRow | undefined =>
        deckCards().find((c) => c.oracle_id === oracleId)
      const fingerprint = (): string =>
        JSON.stringify([
          db.all(
            'SELECT scryfall_id, finish, condition, quantity, foil_treatment, proxied FROM collection_items ORDER BY scryfall_id, finish, condition'
          ),
          db.all('SELECT deck_id, oracle_id, quantity FROM deck_cards ORDER BY deck_id, oracle_id, id'),
          db.all('SELECT deck_id, oracle_id, quantity FROM deck_card_moves ORDER BY id')
        ])

      /*
        Names the section that moved. `stateDiff` is the equivalent for `dbState`
        and is declared much later besides -- reaching for it here read fine and
        threw at run time, since the fingerprint is these three tables and not that
        snapshot's shape.
      */
      const fpDiff = (before: string, after: string): string => {
        if (before === after) return ''
        const a = JSON.parse(before) as unknown[]
        const b = JSON.parse(after) as unknown[]
        const names = ['collection_items', 'deck_cards', 'deck_card_moves']
        const moved = names.filter((_, i) => JSON.stringify(a[i]) !== JSON.stringify(b[i]))
        return `${moved.join(', ')} differ`
      }

      /*
        A resync is replaceDeckCards followed by recomputeLabelPossession — the
        order deckSync.ts uses, because the reinserted rows carry no possession flag
        until it is recomputed. Wrapped together so the fixture cannot drift from
        the real sequence.
      */
      const deckCardsAsUpsert = (): DeckCardUpsert[] =>
        (
          db.all(
            `SELECT scryfall_id, oracle_id, quantity, finish, categories, in_maindeck, name,
                    lang, set_code, collector_number, rarity, image_uri_small, label
             FROM deck_cards WHERE deck_id = ?`,
            [deckId3]
          ) as {
            scryfall_id: string | null
            oracle_id: string | null
            quantity: number
            finish: string
            categories: string
            in_maindeck: number
            name: string
            lang: string
            set_code: string | null
            collector_number: string | null
            rarity: string | null
            image_uri_small: string | null
            label: string | null
          }[]
        ).map((r) => ({
          ...r,
          finish: r.finish as Finish,
          categories: JSON.parse(r.categories) as string[],
          in_maindeck: !!r.in_maindeck
        }))

      const resyncWith = (cards: DeckCardUpsert[]): void => {
        replaceDeckCards(deckId3, cards)
        recomputeLabelPossession({ '#4caf50': 'owned' })
      }
      const snapshot = deckCardsAsUpsert()

      // ---- out of the deck, directly
      const beforeOut = holdings()
      const printOut = fingerprint()
      const outResult = moveToCollection(deckId3, moveOracle, 1)
      check('a card can be moved out of a deck', outResult.moved === 1, JSON.stringify(outResult))
      check(
        'a move creates and destroys nothing: the count is unchanged',
        holdings().quantity === beforeOut.quantity,
        `${beforeOut.quantity} -> ${holdings().quantity}`
      )
      check(
        'and neither is the money',
        Math.abs(holdings().value - beforeOut.value) < 0.005,
        `${beforeOut.value} -> ${holdings().value}`
      )
      check(
        'the deck row itself came down, so nothing is counted twice',
        (
          db.get('SELECT COALESCE(SUM(quantity), 0) AS q FROM deck_cards WHERE deck_id = ? AND oracle_id = ?', [
            deckId3,
            moveOracle
          ]) as { q: number }
        ).q === fresh.quantity - 1
      )
      check(
        'the copy is a real collection row now',
        (
          db.get('SELECT COALESCE(SUM(quantity), 0) AS q FROM collection_items WHERE scryfall_id = ?', [
            fresh.scryfall_id
          ]) as { q: number }
        ).q === 1
      )
      const outMoves = deckMoves(deckId3).get(moveOracle) ?? []
      check(
        'and the ledger records it as an out, so the deck can say the list is stale',
        outMoves.length === 1 && outMoves[0].quantity === -1,
        JSON.stringify(outMoves)
      )

      // ---- and back
      revertMove(outMoves[0].id)
      check(
        'undoing a move puts the database back exactly as it was',
        fingerprint() === printOut,
        'the fingerprint differs after reverting'
      )

      // ---- into a deck, including one that never listed the card
      const spare = db.get(
        `SELECT p.scryfall_id, p.oracle_id FROM printings p
         WHERE NOT EXISTS (SELECT 1 FROM deck_cards dc WHERE dc.deck_id = ? AND dc.oracle_id = p.oracle_id)
           AND p.oracle_id IS NOT NULL
         ORDER BY p.scryfall_id LIMIT 1`,
        [deckId3]
      ) as { scryfall_id: string; oracle_id: string } | undefined

      if (spare) {
        addToCollection({
          scryfall_id: spare.scryfall_id,
          finish: 'nonfoil',
          condition: 'NM',
          quantity: 2
        })
        const spareItem = (
          db.get('SELECT id FROM collection_items WHERE scryfall_id = ?', [
            spare.scryfall_id
          ]) as { id: number }
        ).id

        const beforeIn = holdings()
        const printIn = fingerprint()
        const inResult = moveToDeck(deckId3, spareItem, 1)
        check('a card can be moved into a deck', inResult.moved === 1, JSON.stringify(inResult))
        check(
          'even one the decklist has never mentioned — the row is created',
          (entryFor(spare.oracle_id)?.quantity ?? 0) === 1,
          JSON.stringify(entryFor(spare.oracle_id)?.quantity)
        )
        check(
          'and it counts as held, because you physically put it there',
          (entryFor(spare.oracle_id)?.held ?? 0) >= 1,
          `held ${entryFor(spare.oracle_id)?.held}`
        )
        check(
          'the ledger records it as an in',
          (deckMoves(deckId3).get(spare.oracle_id) ?? [])[0]?.quantity === 1
        )
        check(
          'moving in creates and destroys nothing either',
          holdings().quantity === beforeIn.quantity &&
            Math.abs(holdings().value - beforeIn.value) < 0.005,
          `${beforeIn.quantity}/${beforeIn.value} -> ${holdings().quantity}/${holdings().value}`
        )

        /*
          The ordering trap this design was built to avoid.

          A sync rebuilds deck_cards from the decklist and then recomputes label
          possession from Archidekt labels — which a row you added yourself has
          none of. If either step forgot about it, the card you physically put in
          the deck would quietly stop counting as held.
        */
        resyncWith(deckCardsAsUpsert().filter((c) => c.oracle_id !== spare.oracle_id))
        check(
          'a sync re-applies it, so a card you put in a deck survives one',
          (entryFor(spare.oracle_id)?.quantity ?? 0) === 1,
          `quantity ${entryFor(spare.oracle_id)?.quantity}`
        )
        /*
          Asserted on the label, not on `held`.

          `held` also counts what the collection holds of the same printing, and the
          fixture leaves a copy there — so a version of this that checked `held >= 1`
          passed even with the exemption removed, satisfied by the loose copy rather
          than by the deck vouching for anything. The label is the mechanism under
          test, so the label is what to look at.
        */
        check(
          'and the deck still vouches for it, despite having no Archidekt label',
          entryFor(spare.oracle_id)?.label_possession === 'owned',
          `label_possession ${entryFor(spare.oracle_id)?.label_possession}`
        )

        // ---- reconciliation, the in direction
        const listedNow = deckCardsAsUpsert().map((c) =>
          c.oracle_id === spare.oracle_id ? { ...c, quantity: (c.quantity ?? 0) + 1 } : c
        )
        resyncWith(listedNow)
        check(
          'and once Archidekt lists it, the marker is dropped',
          (deckMoves(deckId3).get(spare.oracle_id) ?? []).length === 0,
          JSON.stringify(deckMoves(deckId3).get(spare.oracle_id))
        )
        check(
          'without the card disappearing — the decklist owns it now',
          (entryFor(spare.oracle_id)?.quantity ?? 0) >= 1
        )

        // Put the fixture back.
        db.run('DELETE FROM deck_card_moves WHERE deck_id = ?', [deckId3])
        db.run('DELETE FROM collection_items WHERE scryfall_id = ?', [spare.scryfall_id])
        resyncWith(snapshot)
        void printIn
      } else {
        skip('moving into a deck', 'no printing outside this deck in the fixture')
      }

      // ---- reconciliation, the out direction
      const pullsNow = (): { quantity: number; deck_quantity_at_move: number }[] =>
        db.all(
          'SELECT quantity, deck_quantity_at_move FROM deck_card_moves WHERE deck_id = ? AND oracle_id = ?',
          [deckId3, moveOracle]
        ) as { quantity: number; deck_quantity_at_move: number }[]

      db.run('UPDATE deck_cards SET quantity = 3 WHERE deck_id = ? AND oracle_id = ?', [
        deckId3,
        moveOracle
      ])
      recomputeLabelPossession({ '#4caf50': 'owned' })
      moveToCollection(deckId3, moveOracle, 2)

      resyncWith(deckCardsAsUpsert().map((c) => (c.oracle_id === moveOracle ? { ...c, quantity: 3 } : c)))
      check(
        'a sync that still lists the copies leaves an out-marker standing',
        pullsNow().length === 1 && pullsNow()[0].quantity === -2,
        JSON.stringify(pullsNow())
      )
      resyncWith(deckCardsAsUpsert().map((c) => (c.oracle_id === moveOracle ? { ...c, quantity: 2 } : c)))
      check(
        'one that absorbed part of it shrinks and rebases it',
        pullsNow().length === 1 && pullsNow()[0].quantity === -1,
        JSON.stringify(pullsNow())
      )
      resyncWith(deckCardsAsUpsert().filter((c) => c.oracle_id !== moveOracle))
      check(
        'and one that dropped the card clears it',
        pullsNow().length === 0,
        JSON.stringify(pullsNow())
      )

      db.run('DELETE FROM deck_card_moves WHERE deck_id = ?', [deckId3])
      db.run('DELETE FROM collection_items WHERE scryfall_id = ?', [fresh.scryfall_id])
      resyncWith(snapshot)

      /*
        Two printings of one oracle.

        The read-time design got this wrong — one copy taken out emptied two slots,
        because the pull was subtracted from every row sharing the oracle. Nothing
        is subtracted at read time now, so it should be impossible; asserted anyway,
        because that is exactly the kind of thing this codebase has been bitten by.
      */
      const sibling = db.get(
        `SELECT scryfall_id FROM printings
         WHERE scryfall_id != ? AND scryfall_id NOT IN (SELECT scryfall_id FROM deck_cards WHERE deck_id = ?)
         ORDER BY scryfall_id LIMIT 1`,
        [fresh.scryfall_id, deckId3]
      ) as { scryfall_id: string } | undefined
      if (sibling) {
        const original = db.get(
          'SELECT quantity, finish, categories, in_maindeck, name, lang, set_code, collector_number, rarity, image_uri_small, label FROM deck_cards WHERE deck_id = ? AND scryfall_id = ?',
          [deckId3, fresh.scryfall_id]
        ) as {
          quantity: number
          finish: string
          categories: string
          in_maindeck: number
          name: string
          lang: string
          set_code: string | null
          collector_number: string | null
          rarity: string | null
          image_uri_small: string | null
          label: string | null
        }
        db.run(
          `INSERT INTO deck_cards (deck_id, scryfall_id, oracle_id, quantity, finish, categories,
                                   in_maindeck, name, lang, set_code, collector_number, rarity,
                                   image_uri_small, label)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          [
            deckId3,
            sibling.scryfall_id,
            moveOracle,
            1,
            original.finish,
            original.categories,
            original.in_maindeck,
            original.name,
            original.lang,
            original.set_code,
            original.collector_number,
            original.rarity,
            original.image_uri_small,
            original.label
          ]
        )
        recomputeLabelPossession({ '#4caf50': 'owned' })

        const twoRows = queryCollection(filters(), 'usd', 500, 0).deckQuantity
        moveToCollection(deckId3, moveOracle, 1)
        const afterOne = queryCollection(filters(), 'usd', 500, 0).deckQuantity
        check(
          'taking one copy out empties exactly one slot, with the oracle on two rows',
          twoRows - afterOne === 1,
          `sleeved ${twoRows} -> ${afterOne}, a drop of ${twoRows - afterOne} for one copy`
        )

        /*
          The two SQL paths, compared while a multi-copy entry is partly moved.

          stats.ts keeps its own copy of the row sources. When quantities were
          adjusted at read time, this copy never learned about the adjustment and
          Stats reported a card and $485 more than the Collection. The multi-copy
          part is what makes the comparison bite: with a single copy the grouping
          drops out entirely and two wrongs cancel.
        */
        const statsNow = collectionStats()
        const collNow = queryCollection(filters(), 'usd', 500, 0)
        check(
          'Stats and the Collection agree on the count while a move is in effect',
          statsNow.totalCards === collNow.totalQuantity,
          `stats ${statsNow.totalCards} vs collection ${collNow.totalQuantity}`
        )
        check(
          'and on the money',
          Math.abs(statsNow.totalValue - (collNow.totalValue ?? 0)) < 0.005,
          `stats ${statsNow.totalValue} vs collection ${collNow.totalValue}`
        )

        db.run('DELETE FROM deck_card_moves WHERE deck_id = ?', [deckId3])
        db.run('DELETE FROM collection_items WHERE scryfall_id = ?', [fresh.scryfall_id])
        db.run('DELETE FROM deck_cards WHERE deck_id = ? AND scryfall_id = ?', [
          deckId3,
          sibling.scryfall_id
        ])
        resyncWith(snapshot)
      } else {
        skip('one oracle across two printings', 'no spare printing to build the case with')
      }

      /*
        A pick list can still hold a deck card, and the destination is what it adds:
        pulling a card out to keep is not the same errand as pulling it out to sell.
      */
      {
        const keepBefore = holdings().quantity
        const keep = createPickList('Pull to keep')
        addToPickList(
          keep,
          { kind: 'deck', deckId: deckId3, oracleId: moveOracle, destination: 'collection' },
          1
        )
        const keepResult = confirmPickList(keep)
        check(
          'validating a pull that keeps the card reports it as freed, not removed',
          keepResult.cardsFreedFromDecks === 1 && keepResult.cardsRemoved === 0,
          JSON.stringify(keepResult)
        )
        check(
          'and the count is unchanged, because it only moved',
          holdings().quantity === keepBefore,
          `${keepBefore} -> ${holdings().quantity}`
        )
        revertPickList(keep)
        check('reverting it restores the count', holdings().quantity === keepBefore)
        cancelPickList(keep)
        db.run('DELETE FROM deck_card_moves WHERE deck_id = ?', [deckId3])
        db.run('DELETE FROM collection_items WHERE scryfall_id = ?', [fresh.scryfall_id])

        const sellBefore = holdings().quantity
        const sell = createPickList('Pull to sell')
        addToPickList(
          sell,
          { kind: 'deck', deckId: deckId3, oracleId: moveOracle, destination: 'gone' },
          1
        )
        const sellResult = confirmPickList(sell)
        check(
          'validating a pull that sells the card reports it as removed',
          sellResult.cardsRemoved === 1 && sellResult.cardsFreedFromDecks === 0,
          JSON.stringify(sellResult)
        )
        check(
          'and the count drops, because it did leave',
          holdings().quantity === sellBefore - 1,
          `${sellBefore} -> ${holdings().quantity}`
        )
        check(
          'with no collection row invented for it',
          (
            db.get('SELECT COALESCE(SUM(quantity), 0) AS q FROM collection_items WHERE scryfall_id = ?', [
              fresh.scryfall_id
            ]) as { q: number }
          ).q === 0
        )
        revertPickList(sell)
        check(
          'and reverting puts it back in the deck',
          holdings().quantity === sellBefore,
          `${holdings().quantity} vs ${sellBefore}`
        )
        cancelPickList(sell)
        db.run('DELETE FROM deck_card_moves WHERE deck_id = ?', [deckId3])
        resyncWith(snapshot)
      }

      /*
        What a move must not lose.

        A move relocates, so the copies have to arrive as the copies that left. Two
        things about a copy are not re-derivable, and both were being dropped: a
        foil treatment you corrected by hand — the only case where the printing's own
        tags do not imply it — and a proxy's worthlessness.
      */
      {
        // ---- a corrected treatment survives out and back
        const treatOracle = moveOracle
        setCardFinish(deckId3, treatOracle, 'foil', 'surgefoil')
        const beforeTreat = fingerprint()
        moveToCollection(deckId3, treatOracle, 1)
        const landed = db.get(
          'SELECT foil_treatment FROM collection_items WHERE scryfall_id = ?',
          [fresh.scryfall_id]
        ) as { foil_treatment: string | null } | undefined
        check(
          'a corrected foil type arrives with the copies',
          landed?.foil_treatment === 'surgefoil',
          `treatment ${landed?.foil_treatment}`
        )
        const backMove = db.get(
          'SELECT id FROM deck_card_moves WHERE deck_id = ? ORDER BY id DESC LIMIT 1',
          [deckId3]
        ) as { id: number }
        revertMove(backMove.id)
        check(
          'and undoing the move puts everything back, treatment included',
          fingerprint() === beforeTreat,
          // The per-table differ lives with the undo cases further down; reaching
          // forward for it here is a use-before-initialization.
          'the fingerprint differs after reverting the move'
        )
        clearCardOverride(deckId3, treatOracle)
        recomputeLabelPossession({ '#4caf50': 'owned' })
        db.run('DELETE FROM deck_card_moves WHERE deck_id = ?', [deckId3])
        db.run('DELETE FROM collection_items WHERE scryfall_id = ?', [fresh.scryfall_id])

        // ---- a proxy stays worth nothing
        const proxySpare = db.get(
          `SELECT p.scryfall_id FROM printings p
           WHERE p.oracle_id IS NOT NULL
             AND NOT EXISTS (
               SELECT 1 FROM deck_cards dc
               WHERE dc.deck_id = ? AND dc.oracle_id = p.oracle_id
             )
             AND NOT EXISTS (
               SELECT 1 FROM collection_items ci WHERE ci.scryfall_id = p.scryfall_id
             )
           ORDER BY p.scryfall_id LIMIT 1`,
          [deckId3]
        ) as { scryfall_id: string } | undefined

        if (proxySpare) {
          addToCollection({
            scryfall_id: proxySpare.scryfall_id,
            finish: 'nonfoil',
            condition: 'NM',
            quantity: 1
          })
          const proxyItem = (
            db.get('SELECT id FROM collection_items WHERE scryfall_id = ?', [
              proxySpare.scryfall_id
            ]) as { id: number }
          ).id
          updateItem(proxyItem, { proxied: 1 })

          const valueBefore = queryCollection(filters(), 'usd', 500, 0).totalValue ?? 0
          moveToDeck(deckId3, proxyItem, 1)
          const valueAfter = queryCollection(filters(), 'usd', 500, 0).totalValue ?? 0
          check(
            'a proxy is still worth nothing after moving into a deck',
            Math.abs(valueAfter - valueBefore) < 0.005,
            `${valueBefore} -> ${valueAfter}`
          )

          db.run('DELETE FROM deck_card_moves WHERE deck_id = ?', [deckId3])
          db.run('DELETE FROM deck_card_overrides WHERE deck_id = ? AND oracle_id = (SELECT oracle_id FROM printings WHERE scryfall_id = ?)', [
            deckId3,
            proxySpare.scryfall_id
          ])
          db.run('DELETE FROM deck_cards WHERE deck_id = ? AND scryfall_id = ?', [
            deckId3,
            proxySpare.scryfall_id
          ])
          db.run('DELETE FROM collection_items WHERE scryfall_id = ?', [proxySpare.scryfall_id])
        } else {
          skip('a proxy is still worth nothing after moving into a deck', 'no spare printing')
        }

        /*
          The other direction, which is the one that needs the ledger.

          Moving out and back was the wrong test for this: the treatment lives in
          `deck_card_overrides`, which the move does not touch, so the round trip
          passed with the ledger column blanked and the check proved nothing.
          Moving *in* deletes the collection row outright, so its corrected
          treatment exists nowhere else, and only `deck_card_moves.foil_treatment`
          can bring it back. The fingerprint holds no ids, so a row recreated under
          a new id still compares equal.
        */
        const treatSpare = db.get(
          `SELECT p.scryfall_id FROM printings p
           WHERE p.oracle_id IS NOT NULL
             AND NOT EXISTS (
               SELECT 1 FROM deck_cards dc
               WHERE dc.deck_id = ? AND dc.oracle_id = p.oracle_id
             )
             AND NOT EXISTS (
               SELECT 1 FROM collection_items ci WHERE ci.scryfall_id = p.scryfall_id
             )
           ORDER BY p.scryfall_id LIMIT 1`,
          [deckId3]
        ) as { scryfall_id: string } | undefined

        if (treatSpare) {
          addToCollection({
            scryfall_id: treatSpare.scryfall_id,
            finish: 'foil',
            condition: 'NM',
            quantity: 1
          })
          const treatItem = (
            db.get('SELECT id FROM collection_items WHERE scryfall_id = ?', [
              treatSpare.scryfall_id
            ]) as { id: number }
          ).id
          updateItem(treatItem, { foil_treatment: 'surgefoil' })

          const beforeIn = fingerprint()
          moveToDeck(deckId3, treatItem, 1)
          // Counted rather than compared against an empty result, so the assertion
          // states the property -- the copies left the collection -- instead of
          // depending on what the driver hands back for no rows.
          const gone =
            (db.get('SELECT COUNT(*) AS n FROM collection_items WHERE id = ?', [treatItem]) as {
              n: number
            }).n === 0
          const inMove = db.get(
            'SELECT id FROM deck_card_moves WHERE deck_id = ? ORDER BY id DESC LIMIT 1',
            [deckId3]
          ) as { id: number }
          revertMove(inMove.id)
          const restored = db.get(
            'SELECT foil_treatment FROM collection_items WHERE scryfall_id = ?',
            [treatSpare.scryfall_id]
          ) as { foil_treatment: string | null } | undefined
          check(
            'undoing a move into a deck restores the treatment you corrected',
            gone && restored?.foil_treatment === 'surgefoil',
            `row ${gone ? 'was consumed' : 'survived'}, back as ${restored?.foil_treatment}`
          )
          check(
            'and that undo leaves the database exactly as it was',
            fingerprint() === beforeIn,
            fpDiff(beforeIn, fingerprint())
          )

          db.run('DELETE FROM deck_card_moves WHERE deck_id = ?', [deckId3])
          db.run(
            `DELETE FROM deck_card_overrides WHERE deck_id = ?
               AND oracle_id = (SELECT oracle_id FROM printings WHERE scryfall_id = ?)`,
            [deckId3, treatSpare.scryfall_id]
          )
          db.run('DELETE FROM deck_cards WHERE deck_id = ? AND scryfall_id = ?', [
            deckId3,
            treatSpare.scryfall_id
          ])
          db.run('DELETE FROM collection_items WHERE scryfall_id = ?', [treatSpare.scryfall_id])
        } else {
          skip('undoing a move into a deck restores the treatment you corrected', 'no spare printing')
          skip('and that undo leaves the database exactly as it was', 'no spare printing')
        }
      }

      /*
        The refusals. Both stop a move inventing a card: an entry under any other
        label is a wishlist line rather than a card you hold, and a proxy cannot
        become a collection row without dragging real copies of the same printing
        into being proxies too.
      */
      const otherEntry = db.get(
        `SELECT oracle_id FROM deck_cards
         WHERE deck_id = ? AND oracle_id IS NOT NULL AND label_possession IS NOT 'owned'
         LIMIT 1`,
        [deckId3]
      ) as { oracle_id: string } | undefined
      if (otherEntry) {
        let refused = ''
        try {
          moveToCollection(deckId3, otherEntry.oracle_id, 1)
        } catch (err) {
          refused = (err as Error).message
        }
        check(
          'an entry you have not marked as owned cannot be moved out',
          refused.length > 0,
          refused || 'it moved anyway'
        )
      } else {
        skip('an entry you have not marked as owned cannot be moved out', 'no such entry')
      }

      setCardProxied(deckId3, moveOracle, true)
      let proxyRefused = ''
      try {
        moveToCollection(deckId3, moveOracle, 1)
      } catch (err) {
        proxyRefused = (err as Error).message
      }
      check(
        'and neither can a slot filled by a proxy',
        proxyRefused.length > 0,
        proxyRefused || 'it moved anyway'
      )
      setCardProxied(deckId3, moveOracle, false)

      let tooMany = ''
      try {
        moveToCollection(deckId3, moveOracle, 99)
      } catch (err) {
        tooMany = (err as Error).message
      }
      check(
        'asking for more copies than the deck holds is refused',
        tooMany.length > 0,
        tooMany || 'it moved anyway'
      )

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

  section('A move belongs to one printing, not to a card')
  {
    const db = getDb()

    /*
      Everything a local move records is keyed by oracle id, and a deck can hold two
      printings of one card -- so a fact about one copy was being applied to both. Three
      things reported from use, all of it:

        - remove print A, add print B: the emptied entry showed B's art and B's proxy badge
        - and neither entry carried the "out" tag any more, the -1 and +1 having cancelled
        - and an entry the decklist never mentioned stayed at quantity 0 for ever

      Each sequence below is written the way it was hit, through the real repo functions.
    */
    /*
      Two printings of one card, neither of them already in the collection.

      The "neither" matters: this section adds a copy of the second one and deletes it
      again on the way out, and picking one a later section was already using deleted a
      row out from under it.
    */
    /*
      Two printings of one card, neither already in the collection. Deliberately *not*
      tokens here: this section is about a deck holding two printings of the same card,
      which has nothing to do with pairing.
    */
    const pair = db.get(
      `SELECT a.scryfall_id AS a, b.scryfall_id AS b, a.oracle_id AS oracle, a.name AS name
         FROM printings a
         JOIN printings b ON b.oracle_id = a.oracle_id AND b.scryfall_id > a.scryfall_id
        WHERE a.oracle_id IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM collection_items ci WHERE ci.scryfall_id = a.scryfall_id)
          AND NOT EXISTS (SELECT 1 FROM collection_items ci WHERE ci.scryfall_id = b.scryfall_id)
        ORDER BY a.scryfall_id LIMIT 1`
    ) as { a: string; b: string; oracle: string; name: string } | undefined

    if (!pair) {
      check('two printings of one card are cached', false, 'fixture too thin')
    } else {
      const deck = upsertDeck({
        external_id: 'verify-prints',
        name: 'Print attribution',
        format: null,
        owner_username: null,
        url: null,
        external_updated_at: null,
        is_private: false,
        is_unlisted: false
      })
      const listPrintA = (): void => {
        replaceDeckCards(deck, [
          {
            scryfall_id: pair.a,
            oracle_id: pair.oracle,
            quantity: 1,
            finish: 'nonfoil',
            categories: [],
            in_maindeck: true,
            name: pair.name,
            lang: 'en',
            set_code: null,
            collector_number: null,
            rarity: null,
            image_uri_small: null,
            label: 'Have it,#4CAF50'
          }
        ])
        recomputeLabelPossession({ '#4caf50': 'owned' })
      }
      /*
        A clean slate between scenarios. Clearing the ledger alone is not enough: the
        proxy flag lives in its own table and outlives the move that recorded it, which
        is how the second scenario below first refused to run at all.
      */
      const reset = (): void => {
        db.run('DELETE FROM deck_card_moves WHERE deck_id = ?', [deck])
        db.run('DELETE FROM deck_card_overrides WHERE deck_id = ?', [deck])
        db.run('DELETE FROM deck_entry_traits WHERE deck_id = ?', [deck])
        listPrintA()
      }
      const entries = (): DeckCardRow[] =>
        allDeckCards(deckBreakdown(deck, 'usd', false)).filter((c) => c.oracle_id === pair.oracle)
      const holdB = (proxied: boolean): number => {
        addToCollection({ scryfall_id: pair.b, finish: 'nonfoil', condition: 'NM', quantity: 1 })
        const id = (
          db.get(
            `SELECT id FROM collection_items WHERE scryfall_id = ? AND finish = 'nonfoil'`,
            [pair.b]
          ) as { id: number }
        ).id
        /*
          Set either way, not only when true: `addToCollection` merges into the row that
          is already there, which still carries the flag from the sequence before this
          one -- and a proxy cannot be moved into a deck that holds real copies.
        */
        bulkUpdate([id], { proxied: proxied ? 1 : 0 })
        return id
      }

      // ---- the reported sequence: out with print A, in with print B
      listPrintA()
      moveToCollection(deck, pair.oracle, 1)
      moveToDeck(deck, holdB(true), 1)

      const rows = entries()
      const rowA = rows.find((c) => c.scryfall_id === pair.a)
      const rowB = rows.find((c) => c.scryfall_id === pair.b)
      console.log(
        '        \u2192 ' +
          JSON.stringify(
            rows.map((c) => ({ id: c.scryfall_id?.slice(0, 8), qty: c.quantity,
              proxied: c.proxied, moved: c.moved }))
          )
      )
      check('the deck has one entry per printing', rows.length === 2, `${rows.length} entries`)
      check('the emptied entry still reports the printing the decklist named',
        rowA !== undefined, 'it reports the printing that was moved in instead')
      check('and is not a proxy, because the proxy went into the other entry',
        rowA?.proxied === false, JSON.stringify({ proxied: rowA?.proxied }))
      check('while the entry the proxy went into is marked as one',
        rowB?.proxied === true, JSON.stringify({ proxied: rowB?.proxied }))
      check('the out tag hangs on the entry that lost copies',
        rowA?.moved === -1, JSON.stringify({ moved: rowA?.moved }))
      check('and the in tag on the one that gained them',
        rowB?.moved === 1, JSON.stringify({ moved: rowB?.moved }))

      /*
        And a proxy in one entry must not lock the other.

        `moveToCollection` reads the proxy flag for the whole card, so with a proxy of
        print B in the deck, taking the real print A out was refused as "that slot is
        filled by a proxy" -- about a slot that holds no proxy at all. This scenario ran
        straight into it.
      */
      check('a proxy in one entry does not stop the real card leaving the other',
        (() => {
          try {
            moveToCollection(deck, pair.oracle, 1, pair.a)
            return true
          } catch {
            return false
          }
        })(),
        'taking out a real printing was refused because another entry holds a proxy')

      // ---- an entry the decklist never mentioned, in and back out again
      reset()
      const inThenOut = holdB(false)
      moveToDeck(deck, inThenOut, 1)
      moveToCollection(deck, pair.oracle, 1, pair.b)
      check('a card the decklist never mentioned leaves no entry behind once its moves cancel',
        entries().every((c) => c.scryfall_id !== pair.b),
        JSON.stringify(entries().map((c) => ({ id: c.scryfall_id?.slice(0, 8), qty: c.quantity }))))

      // and it must not come back when the next sync replays the ledger
      listPrintA()
      check('and it does not come back on the next sync',
        entries().every((c) => c.scryfall_id !== pair.b),
        JSON.stringify(entries().map((c) => ({ id: c.scryfall_id?.slice(0, 8), qty: c.quantity }))))

      /*
        The slot that has to stay, which is what the guard was protecting: the decklist
        wants a card the deck no longer has, and that emptied row is where the tag hangs
        and what you click to undo.
      */
      reset()
      moveToCollection(deck, pair.oracle, 1)
      const emptied = entries().find((c) => c.scryfall_id === pair.a)
      check('an emptied decklist entry keeps its slot, and its tag',
        emptied?.quantity === 0 && emptied?.moved === -1,
        JSON.stringify({ quantity: emptied?.quantity, moved: emptied?.moved }))

      /*
        Two empty entries of one card, for opposite reasons -- which is the state the
        reported deck was actually in, and what a per-card rule gets wrong: the decklist
        entry lost its copy and must keep its slot, while beside it sits an entry a move
        invented and cancelled.
      */
      reset()
      moveToCollection(deck, pair.oracle, 1, pair.a)
      moveToDeck(deck, holdB(false), 1)
      moveToCollection(deck, pair.oracle, 1, pair.b)
      const mixed = entries()
      check('an emptied decklist entry survives beside a cancelled one',
        mixed.some((c) => c.scryfall_id === pair.a && c.quantity === 0) &&
          mixed.every((c) => c.scryfall_id !== pair.b),
        JSON.stringify(mixed.map((c) => ({ id: c.scryfall_id?.slice(0, 8), qty: c.quantity }))))

      // ---- and taking copies out takes them from the printing that was asked for
      reset()
      moveToDeck(deck, holdB(false), 1)
      moveToCollection(deck, pair.oracle, 1, pair.b)
      const afterOut = entries()
      check('removing one printing leaves the other alone',
        afterOut.find((c) => c.scryfall_id === pair.a)?.quantity === 1,
        JSON.stringify(afterOut.map((c) => ({ id: c.scryfall_id?.slice(0, 8), qty: c.quantity }))))

      /*
        And what a card tile needs to draw two sides.

        Three galleries draw a card tile -- the collection, a deck and a pick list -- and
        the deck and pick-list queries did not return the printing's layout at all, so
        those two could not tell a two-sided card from any other. Asserted against the
        query rather than the component, because a missing join is the way this breaks.
      */
      const tokens = tokenPair()
      replaceDeckCards(deck, [
        {
          scryfall_id: tokens.a,
          oracle_id: tokens.a + '-oracle',
          quantity: 1,
          finish: 'nonfoil',
          categories: [],
          in_maindeck: true,
          name: tokens.aName,
          lang: 'en',
          set_code: 'tvfy',
          collector_number: '1',
          rarity: 'common',
          image_uri_small: null,
          label: 'Have it,#4CAF50'
        }
      ])
      recomputeLabelPossession({ '#4caf50': 'owned' })
      const tokenEntry = (): DeckCardRow | undefined =>
        allDeckCards(deckBreakdown(deck, 'usd', false)).find((c) => c.scryfall_id === tokens.a)

      const entry = tokenEntry()
      check('a deck entry reports the printing layout a tile needs',
        entry?.layout === 'token', JSON.stringify({ layout: entry?.layout }))

      // clean up, so later sections see the shape they expect
      db.run('DELETE FROM decks WHERE external_id = ?', ['verify-prints'])
      db.run('DELETE FROM collection_items WHERE scryfall_id = ?', [pair.b])
      recomputeLabelPossession({})
    }
  }

  // ------------------------------------------------- groups, commanders, langs
  section('One meaning per table')
  {
    /*
      The two columns migration 18 emptied out, and the promise that nothing reads them.

      They are still on `deck_card_overrides` -- dropping them would mean rebuilding a
      table for no gain -- so nothing but a check stops a query joining that table and
      reading the flag for the whole card again, which is the bug the migration exists to
      end. Cheap to state, and the failure it prevents is invisible until someone owns two
      printings of one card.
    */
    const mainFiles: string[] = []
    const walkMain = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = joinPath(dir, entry.name)
        if (entry.isDirectory()) walkMain(full)
        else if (entry.name.endsWith('.ts')) mainFiles.push(full)
      }
    }
    walkMain(joinPath('src', 'main'))
    const offenders = mainFiles.filter((file) => {
      if (file.endsWith('schema.ts')) return false
      const source = readFileSync(file, 'utf8')
      /*
        Plain string tests, not a word-boundary regex. The first attempt at this
        line was written through a shell heredoc, which turned its \\b into a
        literal backspace -- so the pattern matched nothing and the check passed
        while the very thing it forbids was in the file.

        The leading character keeps `row.proxied` and friends out of it: what is
        being forbidden is the `o.` alias, which is the override table.
      */
      return /[^a-zA-Z_]o[.]proxied/.test(source) ||
        /[^a-zA-Z_]o[.]foil_treatment/.test(source)
    })
    /*
      And joining two printings into one card by hand stays gone.

      It was three separate faults in the end -- it could be told nonsense, it outlived
      the copies it described, and it renamed cards in the catalogue that had nothing to
      do with any collection -- and each fix was another rule to hold. Migration 20 drops
      the table. This is the tripwire, because the idea is reasonable enough to be
      reintroduced by someone reading the migration history.
    */
    {
      /*
        Asked of the database, not of the migration's text. The first version of this
        check tested the source for /DROP TABLE IF EXISTS printing_pairs/ and passed
        happily when that line was commented out -- a check that reads a statement
        rather than its effect cannot tell the difference between running and being
        mentioned. This database has had every migration applied to it.
      */
      const leftovers = getDb().all(
        `SELECT name FROM sqlite_master
          WHERE name IN ('printing_pairs', 'idx_printing_pairs_paired',
                         'drop_unheld_pairings')`
      ) as { name: string }[]
      check('a migrated database holds nothing the feature wrote',
        leftovers.length === 0, JSON.stringify(leftovers.map((row) => row.name)))
      /*
        And nothing outside the migration history speaks to it. Whole-source rather than
        one file: the table reached eleven files at its widest -- both repos, the pick
        lists, the catalogue, the IPC layer, the undo scopes and four views -- so naming
        any one of them would be a check that passes while the feature comes back
        somewhere else.
      */
      const speaks: string[] = []
      const walkSrc = (dir: string): void => {
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
          const full = joinPath(dir, entry.name)
          if (entry.isDirectory()) walkSrc(full)
          else if (/\.tsx?$/.test(entry.name) && entry.name !== 'schema.ts' &&
            /printing_pairs/.test(readFileSync(full, 'utf8'))) {
            speaks.push(full)
          }
        }
      }
      walkSrc(joinPath('src'))
      check('and nothing outside the migration history mentions the table',
        speaks.length === 0, speaks.join(', '))
    }

    check('no query reads the proxy flag or the treatment off the override table',
      offenders.length === 0,
      offenders.map((f) => f.split(/[\/]/).pop()).join(', '))

    check('and the traits table is what they read instead',
      readFileSync(joinPath('src', 'main', 'db', 'repos', 'decks.ts'), 'utf8')
        .includes('deck_entry_traits'),
      'nothing joins deck_entry_traits')
    console.log(`        → swept ${mainFiles.length} main-process files`)
  }

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
            // Defined and never used: a category you made and left empty is still a
            // category, and must still be offered as a filter.
            { name: 'Sideboard', includedInDeck: true },
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
        entry(ajaniJa, ajaniJa.oracle_id ?? 'y', 2, ['Maybeboard']),
        /*
          The case the whole decision turns on, and the one no fixture had: an excluded
          category carried *alongside* an included one. It is drawn under Ramp, and it does
          not count towards the deck -- which on the deck that prompted this is 57 of 145
          entries, and the difference between a 157-card Commander deck and a 100-card one.
        */
        entry(fr, boltOracleId, 2, ['Maybeboard', 'Ramp'])
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
      /*
        The behaviour that changed, so this is now the check that proves it.

        Those eight copies are loose in the collection -- the fixture adds them with
        `addToCollection` and the deck entry carries no "owned" label -- so they are yours
        and the deck holds none of them. They used to count as owned, which is exactly the
        complaint: "don't categorize cards that are not in a deck but in the collection as
        owned". They are `inCollectionCards`, and nothing is missing because nothing needs
        buying.
      */
      check(
        'eight loose copies are in your collection, not in the deck',
        landGroup?.ownedCards === 0 &&
          landGroup?.inCollectionCards === 8 &&
          landGroup?.missingCards === 0,
        `owned=${landGroup?.ownedCards} inCollection=${landGroup?.inCollectionCards}` +
          ` missing=${landGroup?.missingCards}`
      )
      /*
        And the same entry, once the deck vouches for it, moves the other way. The pair is
        the whole feature: the copies did not move, only what the deck says about them.
      */
      {
        /*
          The flag is set on the one row rather than through `recomputeLabelPossession`,
          which is global: called here it also marks every unlabelled row in this shared
          fixture as owned, and the override checks further down measure `held` on those.
          What is under test is how the breakdown reads the flag, not how the flag is
          derived -- that has its own checks.
        */
        db.run("UPDATE deck_cards SET label_possession = 'owned' WHERE deck_id = ? AND quantity = 8",
          [groupDeck])
        const vouched = deckBreakdown(groupDeck, 'usd', true)!.groups.find(
          (g) => g.name === 'Land'
        )
        check('and an "owned" label moves them into the deck instead',
          vouched?.ownedCards === 8 && vouched?.inCollectionCards === 0,
          `owned=${vouched?.ownedCards} inCollection=${vouched?.inCollectionCards}`)
        db.run('UPDATE deck_cards SET label_possession = NULL WHERE deck_id = ? AND quantity = 8',
          [groupDeck])
      }
      /*
        And the missing pile is unchanged by the split, which is the point worth pinning:
        the old `missing` was `quantity - held` and `held` already counted loose copies, so
        a card in your bulk was never money you had to spend. Only the owned side split.
      */
      {
        const land = grouped.groups.find((g) => g.name === 'Land')
        check('a card covered by your bulk costs nothing to finish',
          land?.inCollectionCards === 8 && land?.missingValue === 0,
          `inCollection=${land?.inCollectionCards} missingValue=${land?.missingValue}`)
      }
      check(
        'totals reconcile: the three buckets are every card, entries is separate',
        grouped.totals.ownedCards +
          grouped.totals.inCollectionCards +
          grouped.totals.missingCards ===
          grouped.totals.cards &&
          grouped.totals.cards === 15 &&
          grouped.totals.inDeckCards === 11 &&
          grouped.totals.entries === 6,
        `buckets=${grouped.totals.ownedCards}+${grouped.totals.inCollectionCards}+${grouped.totals.missingCards}` +
          ` inDeck=${grouped.totals.inDeckCards} cards=${grouped.totals.cards} entries=${grouped.totals.entries}`
      )
      check(
        'an excluded category is separated from the deck proper',
        grouped.totals.inDeckCards === 11 && grouped.totals.excludedCards === 4,
        `${grouped.totals.inDeckCards} in / ${grouped.totals.excludedCards} out`
      )
      /*
        The header agrees with the filter.

        The report: filtering for missing listed cards while the counter above them read 0.
        The counters were computed over the entries that count towards the deck and the
        filter over all of them, so a deck whose shortfall sat in the Maybeboard disagreed
        with itself. Both sides are stated here on the same rows -- and on this fixture
        rather than the Archidekt one, which has no excluded entry for them to disagree
        about. One side lives in the main process and one in the renderer, which is why
        nothing caught this.
      */
      {
        const excluded = grouped.cards.filter((card) => !card.counts)
        const shortfall = excluded.reduce((sum, c) => sum + allocateCopies(c).missing, 0)
        check(
          'an excluded entry you lack copies of is counted missing, not silently dropped',
          shortfall > 0 && grouped.totals.missingCards >= shortfall,
          JSON.stringify({
            excluded: excluded.length,
            shortfall,
            missingTotal: grouped.totals.missingCards
          })
        )
        for (const [ownership, field] of [
          ['owned', 'ownedCards'],
          ['inCollection', 'inCollectionCards'],
          ['missing', 'missingCards']
        ] as const) {
          const shown = grouped.cards.filter((card) =>
            matchesDeckFilters(card, { ...DEFAULT_DECK_FILTERS, ownership })
          )
          const sum = shown.reduce((total, card) => {
            const allocated = allocateCopies(card)
            return (
              total +
              (ownership === 'owned'
                ? allocated.inDeck
                : ownership === 'inCollection'
                  ? allocated.fromCollection
                  : allocated.missing)
            )
          }, 0)
          check(
            `the ${ownership} counter is what filtering for ${ownership} adds up to`,
            sum === grouped.totals[field],
            `filter ${sum} over ${shown.length} rows vs counter ${grouped.totals[field]}`
          )
        }
      }
      /*
        The decision, checked where it bites: a card in Maybeboard *and* Ramp is drawn under
        Ramp and counts for nothing. Without this the rule is untestable -- and it was, until
        the fixture gained that entry.
      */
      {
        const ramp = grouped.groups.find((g) => g.name === 'Ramp')
        const maybeboard = grouped.groups.find((g) => g.name === 'Maybeboard')
        check(
          'an excluded main category takes its cards with it, out of the deck and out of Ramp',
          ramp?.cardCount === 1 && maybeboard?.cardCount === 4,
          `Ramp ${ramp?.cardCount}, Maybeboard ${maybeboard?.cardCount}`
        )
      }
      check(
        'excluded groups sort last',
        grouped.groups[grouped.groups.length - 1]?.inDeck === false,
        `last group: ${grouped.groups[grouped.groups.length - 1]?.name}`
      )

      // A card carrying several categories is counted once but still shows both.
      const multi = allDeckCards(grouped).find((c) => c.scryfall_id === ajaniEn.scryfall_id)!
      /*
        Asserted against `categories`, which is what Archidekt sent, and never against
        `section`, which is what the display derived from it. Comparing the derivation to
        itself passes however wrong it is -- as it did when a version of this first ran
        against a deliberately broken build.
      */
      check(
        'a multi-category card is drawn under its first category, and only that one',
        grouped.groups.filter((g) => g.cards.some((c) => c.id === multi.id)).length === 1 &&
          multi.section === multi.categories[0],
        `section ${multi.section} of ${JSON.stringify(multi.categories)}`
      )
      /*
        The original report, as a check: a card whose *first* category is one Archidekt
        excludes belongs in that category. The rule this replaces skipped excluded categories
        when choosing, so such a card surfaced under whatever it carried second -- which is
        how cards went missing from the Maybeboard pile and appeared in Ramp instead.
      */
      {
        /*
          The mixed entry specifically: Maybeboard *and* a real category.

          Picking any card whose first category is Maybeboard finds the pure-Maybeboard one,
          which lands in Maybeboard under the broken rule too -- so the check passed against a
          deliberately broken build until this said which card it meant.
        */
        const maybe = allDeckCards(grouped).find(
          (c) => c.categories[0] === 'Maybeboard' && c.categories.length > 1
        )!
        check(
          'a card whose main category is excluded is drawn there, not in its second category',
          maybe.section === 'Maybeboard' &&
            grouped.groups
              .find((g) => g.name === 'Ramp')!
              .cards.every((c) => c.id !== maybe.id),
          `${JSON.stringify(maybe.categories)} drawn under ${maybe.section}`
        )
      }
      check(
        'and still reports its other categories',
        multi.categories.length === 2 && multi.categories.includes('Draw'),
        JSON.stringify(multi.categories)
      )
      /*
        The category list is Archidekt's own, not the buckets that happened to fill.

        Derived from the groups, as it was, a category you defined and left empty could not
        be offered as a filter -- and neither could one whose every card also carried an
        earlier category, which is how a whole category used to vanish from the screen *and*
        from the dropdown at once.
      */
      check(
        'the category list is the deck definitions, not the sections that filled',
        grouped.categories.some((c) => c.name === 'Sideboard' && c.cardCount === 0) &&
          grouped.categories.length > grouped.groups.length,
        JSON.stringify(grouped.categories.map((c) => `${c.name}:${c.cardCount}`))
      )
      check(
        'and a category with no cards is a filter option, not an empty section',
        !grouped.groups.some((g) => g.name === 'Sideboard'),
        JSON.stringify(grouped.groups.map((g) => g.name))
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
      /*
        Three options, and they must partition the deck exactly: a card is in it, or yours
        but not in it, or neither. Two of them used to cover everything because "owned"
        counted your bulk.
      */
      {
        const inFilter = (ownership: 'owned' | 'inCollection' | 'missing'): DeckCardRow[] =>
          all.filter((c) => matchesDeckFilters(c, deckFilters({ ownership })))
        const owned = inFilter('owned')
        const inCollection = inFilter('inCollection')
        const missing = inFilter('missing')
        check(
          'the three ownership filters partition the deck',
          owned.length + inCollection.length + missing.length === all.length,
          `${owned.length} + ${inCollection.length} + ${missing.length} != ${all.length}`
        )
        check(
          'and none of them overlaps another',
          new Set([...owned, ...inCollection, ...missing].map((c) => c.id)).size === all.length,
          'a card matched more than one ownership filter'
        )
        check(
          'a card in your collection but not in the deck is not in the owned filter',
          inCollection.every((c) => !owned.includes(c)) &&
            inCollection.every((c) => allocateCopies(c).inDeck < c.quantity),
          JSON.stringify(inCollection.slice(0, 2).map((c) => c.name))
        )
      }
      /*
        The filter matches what the screen shows.

        This asserted the opposite until now -- that ticking a secondary tag found the card --
        which was right while a card could be drawn under a category other than the one you
        ticked. Under one section per card it would show the card under a heading you did not
        ask for, which is the report that produced this rule.
      */
      check(
        'the category filter matches the section a card is drawn in, not its other tags',
        all
          .filter((c) => matchesDeckFilters(c, deckFilters({ categories: ['Draw'] })))
          .every((c) => c.section === 'Draw'),
        'a card was found by a category it is not drawn under'
      )
      check(
        'and ticking its own category does find it',
        all
          .filter((c) => matchesDeckFilters(c, deckFilters({ categories: ['Ramp'] })))
          .some((c) => c.scryfall_id === ajaniEn.scryfall_id),
        'a card was not found by the category it is drawn under'
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
      /*
        And what the card does, which the deck's haystack did not read either. Asserted
        against the text the breakdown actually shipped, so this measures the query and the
        filter together rather than an assumption about a Lightning Bolt.
      */
      {
        const withText = all.filter((c) => (c.search_text ?? '').includes('3 damage'))
        check('the deck breakdown carries the rules text for searching',
          withText.length > 0, JSON.stringify(all.map((c) => (c.search_text ?? '').slice(0, 20))))
        const found = all.filter((c) => matchesDeckFilters(c, deckFilters({ search: '3 damage' })))
        check('and a rules-text term keeps exactly the cards whose text has it',
          JSON.stringify(found.map((c) => c.id).sort()) ===
            JSON.stringify(withText.map((c) => c.id).sort()),
          JSON.stringify({ found: found.length, withText: withText.length }))
      }
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

      /*
        Flat mode is now where each card appears once.

        These checks used to assert a merge: an invented section called "Deck" holding the
        in-deck categories, with the commander pinned above it and the excluded piles below.
        With the categories overlapping, one list of every card exactly once is worth more
        than the invented heading was -- and it is the only view that can answer "how many
        cards is this" by counting what is drawn.
      */
      check(
        'the flat list and the sections agree on the deck, because both count each card once',
        cardsIn(flat) === grouped.totals.cards && cardsIn(byCategory) === cardsIn(flat),
        `flat ${cardsIn(flat)} vs sections ${cardsIn(byCategory)}, deck ${grouped.totals.cards}`
      )
      /*
        One heading in the flat list, and it is the commander's.

        These asserted no heading at all until now. The heading the app used to invent -- a
        section called "Deck" -- had to go, and the commander's pinning went out with it; the
        commander is the one category Archidekt marks premier, so it comes back and nothing
        else does.
      */
      const flatCards = flat.flatMap((section) => section.cards)
      const flatHeaders = buildDeckBody(flat, 'rows', 8).items.filter((i) => i.kind === 'header')
      check(
        'the flat list pins the commander at the top, under its own heading',
        flat[0].isPremier === true &&
          flat[0].header === true &&
          flatHeaders.length === 2 &&
          flatHeaders[0].kind === 'header' &&
          flatHeaders[0].group.isPremier === true,
        JSON.stringify(flat.map((s) => ({ name: s.name, header: s.header })))
      )
      check(
        'and names the rest of the deck as one section of cards, not as its categories',
        flat.length === 2 && flat[1].name === FLAT_CARDS && flat[1].header === true,
        JSON.stringify(flat.map((s) => ({ name: s.name, header: s.header })))
      )
      check(
        'the excluded cards stay in that section rather than becoming piles of their own',
        flat[1].cards.some((c) => !c.counts) && flat.length === 2,
        JSON.stringify(flat.map((s) => `${s.name}:${s.cards.length}`))
      )
      check(
        'and the commander is marked on its row too, not only by its section',
        flat[0].cards.some((c) => c.is_commander),
        'no card in the pinned section reports itself as the commander'
      )
      check(
        'the flat list holds every entry exactly once',
        flatCards.length === grouped.cards.length &&
          new Set(flatCards.map((c) => c.id)).size === flatCards.length,
        `${flatCards.length} of ${grouped.cards.length} entries`
      )
      check(
        'and it reports the deck, counted the way the header counts it',
        cardsIn(flat) === grouped.totals.cards,
        `${cardsIn(flat)} vs ${grouped.totals.cards}`
      )
      /*
        Two headings, in order, with the boundary between the runs asserted.

        The commander's block used to end where the next row began, with nothing between
        them -- a rule was tried there before the run below was named instead.
      */
      {
        const items = buildDeckBody(flat, 'rows', 8).items
        const at = items.findIndex((i) => i.kind === 'header' && i.group.name === FLAT_CARDS)
        const before = items[at - 1]
        const after = items[at + 1]
        check(
          'the cards heading falls between the commander and the rest of the deck',
          at > 0 &&
            before?.kind === 'row' &&
            before.section === flat[0].name &&
            after?.kind === 'row' &&
            after.section === FLAT_CARDS,
          JSON.stringify(items.slice(0, 4).map((i) => `${i.kind}:${i.key}`))
        )
        check(
          'and every item in the flat list has its own key',
          new Set(items.map((i) => i.key)).size === items.length,
          'two items share a key, so the virtualizer will hand one another height'
        )
      }
      check(
        'the cards section belongs to the flat list alone',
        byCategory.every((section) => section.name !== FLAT_CARDS) &&
          allDeckCards(grouped).every((card) => card.section !== FLAT_CARDS),
        'the flat heading leaked into the categories'
      )
      /*
        Filtering to something the commander is not in leaves the list and drops the heading,
        because an emptied section is dropped like any other.
      */
      {
        const onlyLand = { ...DEFAULT_DECK_FILTERS, categories: ['Land'] }
        const filtered = buildDeckSections(grouped, onlyLand, false)
        check(
          'filtering to another category in flat mode leaves the cards section alone',
          filtered.length === 1 && filtered[0].name === FLAT_CARDS,
          JSON.stringify(filtered.map((s) => ({ name: s.name, header: s.header })))
        )
        check(
          'and it keeps its heading, being a section like any other',
          buildDeckBody(filtered, 'rows', 8).items.filter((i) => i.kind === 'header')
            .length === 1,
          'the surviving section drew no heading'
        )
      }
      const rows = buildDeckBody(byCategory, 'rows', 8)
      check(
        'row mode emits one row per card plus one header per section',
        rows.items.filter((i) => i.kind === 'row').length === rows.ordered.length &&
          rows.items.filter((i) => i.kind === 'header').length === byCategory.length,
        `${rows.items.length} items for ${rows.ordered.length} distinct cards`
      )
      check(
        'the range order holds each card once, whatever the sections draw',
        rows.ordered.length === new Set(rows.ordered.map((c) => c.id)).size &&
          rows.ordered.length === grouped.cards.length,
        `${rows.ordered.length} ordered, ${new Set(rows.ordered.map((c) => c.id)).size} distinct`
      )
      check(
        'and every item drawn has its own key',
        new Set(rows.items.map((i) => i.key)).size === rows.items.length,
        'two items share a key, so the virtualizer will hand one another height'
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
        check(
          `no tile row straddles two sections at ${columns} columns`,
          grid.items.every((item) =>
            item.kind !== 'tiles'
              ? true
              : item.cards.every((c) => c.section === item.section) &&
                new Set(item.cards.map((c) => c.id)).size === item.cards.length
          ),
          'a tile row mixed cards from two categories'
        )
        check(
          `every grid item at ${columns} columns has its own key`,
          new Set(grid.items.map((i) => i.key)).size === grid.items.length,
          'two items share a key'
        )
        {
          // Tiles too: the boundary is between sections, so it does not depend on what a
          // section draws. The commander's tile row, the cards heading, then the rest.
          const flatGrid = buildDeckBody(flat, 'grid', columns).items
          const at = flatGrid.findIndex(
            (i) => i.kind === 'header' && i.group.name === FLAT_CARDS
          )
          const before = flatGrid[at - 1]
          const after = flatGrid[at + 1]
          check(
            `the flat grid at ${columns} columns splits in the same place`,
            flatGrid.filter((i) => i.kind === 'header').length === 2 &&
              before?.kind === 'tiles' &&
              before.section === flat[0].name &&
              after?.kind === 'tiles' &&
              after.section === FLAT_CARDS,
            JSON.stringify(flatGrid.map((i) => i.kind))
          )
        }
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
      addToPickList(older, { kind: 'collection', itemId: row.id }, 1)
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
        addToPickList(older, { kind: 'collection', itemId: row.id }, 1)
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
      // 'foil' and 'etched' do: they are the words French players use. The filter
      // and sort labels said 'Finition' while every sentence around them said
      // 'finish', so they were brought into line rather than left disagreeing.
      'finishPicker.finish', 'bulk.setFinish', 'add.finish',
      'filters.finish', 'sort.finish',
      // French players say 'proxy' and 'proxies', like 'foil'.
      'proxy.badge', 'proxy.filter',
      // The default backup folder is the app's own name, which does not translate.
      'settings.backupFolderPlaceholder',
      // 'Version' is the same word in French, and the number is interpolated.
      'updates.current',
      // 'Collection' is the same word in French. 'Apparence' is not, so it is not here.
      'settings.tabCollection',
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
      /*
        Tolerates a missing counterpart rather than crashing on it. The Record type
        normally makes that impossible, but this suite runs through esbuild, which
        strips types — so a key added to one dictionary only reached here as
        undefined and took the whole run down with a TypeError instead of naming the
        key. A missing translation is a mismatch, and should be reported as one.
      */
      const holes = (value: string | undefined): string =>
        [...(value ?? '').matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(',')
      const fr = (frDict as Record<string, string | undefined>)[k]
      if (fr === undefined) return true
      return holes((enDict as Record<string, string>)[k]) !== holes(fr)
    })
    check(
      'every placeholder survives translation',
      mismatched.length === 0,
      mismatched.slice(0, 8).join(', ')
    )

    check('interpolation fills named holes', t('fr', 'common.of', { shown: 3, total: 9 }) === '3 sur 9')
    /*
      Plural selection, per language, on a pair that exists.

      What was here compared `test.plural` -- a key in neither dictionary -- and then said
      `|| true`, so it could not fail. Twelve pairs exist, and one of them is asserted now.

      The zero is the interesting case and the reason this is per language: English takes
      the plural for none ("Staged 0 cards"), French takes the singular ("0 carte
      préparée"). A selector that only asks `count === 1` gets French wrong at zero.
    */
    check('English pluralises one and not the other',
      tp('en', 'coll.staged', 1) === 'Staged 1 card' &&
        tp('en', 'coll.staged', 3) === 'Staged 3 cards',
      `${tp('en', 'coll.staged', 1)} / ${tp('en', 'coll.staged', 3)}`)
    check('and French agrees, including in the singular',
      tp('fr', 'coll.staged', 1) === '1 carte préparée' &&
        tp('fr', 'coll.staged', 3) === '3 cartes préparées',
      `${tp('fr', 'coll.staged', 1)} / ${tp('fr', 'coll.staged', 3)}`)
    check('English takes the plural for none, as English does',
      tp('en', 'coll.staged', 0) === 'Staged 0 cards', tp('en', 'coll.staged', 0))
    check('and French takes the singular for none, as French does',
      tp('fr', 'coll.staged', 0) === '0 carte préparée', tp('fr', 'coll.staged', 0))

    /*
      And no French string hedges a plural with "(s)".

      "{count} carte(s)" is the single most machine-translated thing a French UI can say,
      and two of them were ungrammatical either way -- "{count} exemplaire(s) a quitté ce
      deck" agrees with neither reading. The plural pairs above are the way to say it; this
      is what stops the hedge coming back.
    */
    {
      const hedged = Object.entries(frDict as Record<string, string>)
        .filter(([, value]) => /\(s\)|\(e\)|\(es\)/.test(value))
        .map(([key]) => key)
      check('no French string hedges a plural with "(s)"',
        hedged.length === 0, `${hedged.length}: ${hedged.slice(0, 6).join(', ')}`)
    }

    /*
      And no accent was written through the wrong codec.

      Three strings shipped mis-encoded -- "SystÃ¨me suit Windows", "Ã©crans OLED", and
      "Change lâinterface" -- which is UTF-8 read back as if it were cp1252. It is invisible
      in a diff and unmissable on screen. The tell is a capital A-tilde or A-circumflex, or a
      lone circumflex-a, carrying a high byte behind it: no French word does that, so the
      pattern only matches damage.
    */
    {
      const mojibake = Object.entries(frDict as Record<string, string>)
        .filter(([, value]) => /[\u00c2\u00c3\u00e2][\u0080-\u00ff\u2013-\u2122]/.test(value))
        .map(([key]) => key)
      check('no French string was written through the wrong codec',
        mojibake.length === 0, mojibake.join(', '))
    }
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
        /*
          Prose sitting between tags rather than in an attribute.

          This is the gap the two sweeps above left, and it was not hypothetical:
          "Showing the first N of M rows" and "Card data from Scryfall. Decks from
          Archidekt." rendered in English inside the French app for as long as both
          existed. Neither is an attribute and neither looks like a string literal,
          so nothing saw them — and the runtime French sweep could not either,
          because it matches a curated list of phrases and therefore only finds
          leftovers someone already knew about.

          Extracted first and judged second, rather than in one regular
          expression: the first attempt at this was a single pattern and it
          silently failed to span the full stop between two sentences, so it
          reported the file clean while the offending line was still there.
        */
        for (const match of text.matchAll(/>([^<>{}]+)</g)) {
          const prose = match[1].replace(/\s+/g, ' ').trim()
          if (!/^[A-Z]/.test(prose)) continue
          // Anything with code punctuation is a fragment of an expression, not
          // copy the user reads.
          if (/[=;()[\]|&]/.test(prose)) continue
          const words = prose.match(/[A-Za-z]{3,}/g) ?? []
          // Three real words is a sentence. Fewer is a label, and every label in
          // this codebase is either translated or a proper noun.
          if (words.length < 3) continue
          if (words.every((w) => /^(Archidekt|Scryfall|Matomeru|MTGJSON)$/.test(w))) continue
          offenders.push(`${name}: "${prose.slice(0, 48)}"`)
        }
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
      /*
        The same sweep over the main process, where the errors are thrown.

        Worth its own pass because the renderer sweep cannot see these: a message
        thrown in main reaches the user verbatim through the renderer's single
        error funnel. And it found the sharpest version of this bug — two keys,
        `err.archidektUnreachable` and `err.archidektStatus`, existed and were
        translated, while the throw sites next to them built English strings by
        hand. The translation was written and then not used.

        `connection.ts` is exempt: it throws before any window exists, so its
        message is for whoever is running the app, not for a user.
      */
      {
        const mainFiles: string[] = []
        const walkMain = (dir: string): void => {
          for (const entry of readdirSync(dir, { withFileTypes: true })) {
            const full = joinPath(dir, entry.name)
            if (entry.isDirectory()) walkMain(full)
            else if (entry.name.endsWith('.ts')) mainFiles.push(full)
          }
        }
        walkMain(joinPath('src', 'main'))

        const thrown: string[] = []
        for (const file of mainFiles) {
          const name = file.split(/[\\/]/).pop() ?? ''
          if (name === 'connection.ts') continue
          const text = readFileSync(file, 'utf8')
          for (const match of text.matchAll(/throw new \w*Error\(\s*([`'"])([^`'"]{6,})\1/g)) {
            const message = match[2]
            // A capital and two words is prose. Anything else is an identifier or
            // a formatting fragment.
            if (!/^[A-Z]/.test(message)) continue
            if ((message.match(/[A-Za-z]{3,}/g) ?? []).length < 2) continue
            thrown.push(`${name}: "${message.slice(0, 44)}"`)
          }
        }
      /*
        Keys nothing references.

        Said last review that unused keys "sit there indefinitely because nothing
        polices them" — and then left six behind when the pull model became the move
        model. A dictionary that accumulates dead entries is one nobody trusts to
        read, and it makes the real question — is this string still shown anywhere —
        unanswerable by grep.

        Plural keys are matched on their base: `x_one` and `x_other` are reached
        through `t.p('x', n)`, so the suffix never appears in source.
      */
      {
        const sources: string[] = []
        const walkSrc = (dir: string): void => {
          for (const entry of readdirSync(dir, { withFileTypes: true })) {
            const full = joinPath(dir, entry.name)
            if (entry.isDirectory()) walkSrc(full)
            else if (/\.(ts|tsx)$/.test(entry.name) && !full.includes(joinPath('shared', 'i18n'))) {
              sources.push(readFileSync(full, 'utf8'))
            }
          }
        }
        walkSrc('src')
        const haystack = sources.join('\n')

        /*
          Prefixes built at runtime are exempt: their keys never appear as literals
          anywhere. Any template of the form `prefix.${...}` counts, not just one
          written inside t() — `rarityName` builds its key into a variable first, and
          a narrower pattern missed it and reported the whole rarity vocabulary as
          dead. Detected rather than allowlisted, so a new dynamic family cannot
          silently start reporting dozens of orphans.
        */
        const dynamic = [...haystack.matchAll(/`([a-zA-Z]+)\.\$\{/g)].map((m) => m[1])
        const orphans = Object.keys(enDict).filter((key) => {
          const base = key.replace(/_(one|other)$/, '')
          if (dynamic.some((prefix) => key.startsWith(`${prefix}.`))) return false
          return !haystack.includes(`'${key}'`) && !haystack.includes(`'${base}'`)
        })
        check(
          'every translation key is referenced somewhere',
          orphans.length === 0,
          `${orphans.length} unused: ${orphans.join(', ')}`
        )
        console.log(`        → swept ${Object.keys(enDict).length} keys`)
      }

        check(
          'no main-process error is thrown as hard-coded English',
          thrown.length === 0,
          thrown.slice(0, 6).join(' | ')
        )
        console.log(`        → swept ${mainFiles.length} main-process files`)
      }

      check(
        'no renderer file hard-codes a user-visible label or sentence',
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
    // `tix` is spelled out even though nothing here reads it: Prices requires it,
    // and this fixture only compiled before because scripts/ was outside the
    // typecheck — which is also how three stale addToPickList calls survived.
    const prices: Prices = {
      usd: '1.00',
      usd_foil: '5.00',
      usd_etched: '9.00',
      eur: '0.80',
      eur_foil: '4.00',
      tix: null
    }
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
    addToPickList(guardList, { kind: 'collection', itemId: survivor }, 1)
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

  /*
    One language, applied to the rows you picked.

    Four outcomes, and three of them are not failures. This is the first asynchronous,
    partially-failing action on the collection's bulk bar, so what it reports has to be
    exactly what happened -- a run that did what was asked must not look broken.
  */
  if (en && ja) {
    const langRow = addToCollection({
      scryfall_id: en.scryfall_id,
      finish: 'etched', // a finish nothing else in this run uses, so nothing merges by surprise
      condition: 'GD',
      quantity: 1
    })
    const applied = await setRowLanguages([`collection:${langRow}`], 'ja', () => undefined)
    check('applying a language repoints the row it was given',
      applied.converted === 1 && applied.failed === 0 && applied.gone === 0,
      JSON.stringify(applied))
    const after = getItem(langRow) ?? getItem(
      (getDb().get('SELECT id FROM collection_items WHERE scryfall_id = ? AND condition = ?',
        [ja.scryfall_id, 'GD']) as { id: number } | undefined)?.id ?? -1
    )
    check('and the row now reports that language',
      after?.printing.lang === 'ja', JSON.stringify({ lang: after?.printing.lang }))
    /*
      And the row is on the *same* print, in the other language.

      The assertion this whole path was missing. Language application used to fall back to
      searching every printing of the card and taking the closest, so a row could come
      back on a print from another set entirely -- a card its owner does not hold. Asserted
      on the row rather than on the two fixtures: comparing the fixtures to each other only
      proves what the recording contains, and would pass however wrong the code got.
    */
    const started = getPrinting(en.scryfall_id)
    check('and on the same print it started on, not another one in that language',
      after?.printing.set_code === started?.set_code &&
        after?.printing.collector_number === started?.collector_number &&
        after?.scryfall_id !== en.scryfall_id,
      JSON.stringify({
        from: `${started?.set_code} ${started?.collector_number} (${started?.lang})`,
        to: `${after?.printing.set_code} ${after?.printing.collector_number} ` +
          `(${after?.printing.lang})`
      }))

    /*
      A row already in that language. Worth stating: the repoint is a merge into whatever
      row already holds the target printing, and if that lookup did not exclude the row
      itself, asking for the language a row is already in would delete it.
    */
    const already = await setRowLanguages([`collection:${langRow}`], 'ja', () => undefined)
    check('asking for the language a row already has changes nothing',
      already.converted === 1 && already.failed === 0 && already.gone === 0,
      JSON.stringify(already))
    check('and the row is still there afterwards',
      (getDb().get('SELECT COUNT(*) AS n FROM collection_items WHERE condition = ?',
        ['GD']) as { n: number }).n > 0,
      'the row was deleted by being pointed at itself')

    /*
      An id the collection no longer holds. A selection can outlive the page it was made
      on now, so this is reachable rather than theoretical -- and it must read as "gone",
      not as a failure, or a successful run would look broken.
    */
    const stale = await setRowLanguages(
      ['collection:999999999', `deck:${crypto.randomUUID()}:nonfoil`, 'not-a-key'],
      'ja',
      () => undefined
    )
    /*
      Three ways of naming nothing, and none of them is a failure.

      A stale collection id, a deck group that is no longer there, and a key that does not
      parse at all. A selection outlives the page it was made on, so all three are
      reachable rather than theoretical -- and a run that met one must not look broken.
    */
    check('keys that name nothing are reported as gone, not as failures',
      stale.gone === 3 && stale.failed === 0 && stale.converted === 0,
      JSON.stringify(stale))

    /*
      And a row an open pick list is holding refuses to move, for the reason `removeItem`
      refuses: the list is counting on those copies.
    */
    const heldRow = addToCollection({
      scryfall_id: en.scryfall_id,
      finish: 'etched',
      condition: 'PL',
      quantity: 2
    })
    const guardList = createPickList('Language refusal')
    addToPickList(guardList, { kind: 'collection', itemId: heldRow }, 1)
    const refused = await setRowLanguages([`collection:${heldRow}`], 'ja', () => undefined)
    /*
      Reported as a skip rather than a failure, which is what it is: nothing broke, those
      copies are promised to a list. It used to be counted as `failed`, which made a
      perfectly ordinary run look like it had gone wrong.
    */
    check('a row an open pick list is holding is skipped, not failed',
      refused.reserved === 1 && refused.failed === 0 && refused.converted === 0,
      JSON.stringify(refused))
    check('and it is still the printing it was',
      getItem(heldRow)?.scryfall_id === en.scryfall_id,
      JSON.stringify({ now: getItem(heldRow)?.scryfall_id }))
    /*
      And it was not quietly declared instead.

      Declaring would move nothing, so it looks harmless -- but the list has promised
      those copies to someone, and relabelling them changes what it says it is picking.
    */
    check('and it was not declared either, so the list still says what it did',
      getItem(heldRow)?.language_forced === false,
      JSON.stringify({ forced: getItem(heldRow)?.language_forced }))
    db.run('DELETE FROM pick_lists WHERE id = ?', [guardList])
    db.run('DELETE FROM collection_items WHERE id = ?', [heldRow])

    // Progress is reported per row, so a long run is not a frozen window.
    const seen: number[] = []
    const another = addToCollection({
      scryfall_id: en.scryfall_id, finish: 'etched', condition: 'HP', quantity: 1
    })
    const jobs = new Set<string>()
    await setRowLanguages([`collection:${another}`], 'ja', (event) => {
      seen.push(event.done)
      jobs.add(event.job)
    })
    check('progress is reported as it goes, and finishes',
      seen.length >= 2 && seen[0] === 0 && seen[seen.length - 1] === 1,
      JSON.stringify(seen))
    /*
      One job, whichever kinds of row were selected.

      The job name is the progress bar's identity and the throttle's key, and the bar
      hides on the first `finished` it sees -- so a run that reported its deck half under
      a second name would hide the bar halfway through its own work.
    */
    check('and as one job, because it was one action',
      jobs.size === 1 && jobs.has('collection-language'),
      [...jobs].join(', '))
  }

  /*
    Setting a language from the Collection screen, on both kinds of row.

    The Collection screen lists copies you entered and copies sleeved in a synced deck as
    one list. The action behind it took numeric ids, a sleeved row has none, and every one
    of them was dropped between the selection and the call -- so selecting everything and
    setting a language left the sleeved cards untouched and reported success. Nothing here
    existed before, which is why nobody noticed.
  */
  section('Set language across a mixed selection')

  if (en && ja) {
    const langDeckA = upsertDeck({
      external_id: 'verify-lang-a',
      name: 'Language A',
      format: 'commander',
      owner_username: 'verify',
      url: 'https://archidekt.com/decks/verify-lang-a',
      external_updated_at: null,
      last_synced_at: new Date(0).toISOString(),
      is_private: false,
      is_unlisted: false,
      raw_json: '{}'
    })
    const langDeckB = upsertDeck({
      external_id: 'verify-lang-b',
      name: 'Language B',
      format: 'commander',
      owner_username: 'verify',
      url: 'https://archidekt.com/decks/verify-lang-b',
      external_updated_at: null,
      last_synced_at: new Date(0).toISOString(),
      is_private: false,
      is_unlisted: false,
      raw_json: '{}'
    })

    /*
      A print with no collector number, for the case where no version exists.

      The resolver answers null without a request when it has no set and number to ask
      about, which is the same null a 404 produces -- so the declare path is exercised
      exactly, offline, and without making the recording carry a 404 for a card that only
      exists inside this suite.
    */
    const noNumber = 'verify-lang-nonumber'
    getDb().run(
      `INSERT INTO printings
         (scryfall_id, oracle_id, name, lang, set_code, set_name, collector_number,
          rarity, layout, fetched_at)
       VALUES (?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(scryfall_id) DO NOTHING`,
      [noNumber, 'verify-lang-oracle', 'Verify Untranslatable', 'en', 'tvfy',
        'Verify Tokens', '', 'common', 'normal', new Date(0).toISOString()]
    )

    const enPrinting = getPrinting(en.scryfall_id)
    const deckCard = (
      scryfallId: string,
      oracleId: string,
      setCode: string | null,
      number: string | null,
      name: string
    ): DeckCardUpsert => ({
      scryfall_id: scryfallId,
      oracle_id: oracleId,
      quantity: 1,
      finish: 'nonfoil',
      categories: [],
      in_maindeck: true,
      name,
      lang: 'en',
      set_code: setCode,
      collector_number: number,
      rarity: 'common',
      image_uri_small: null,
      label: 'Have it,#4CAF50'
    })

    // The same card in both decks, so "every deck holding it" is a real question.
    const boltOracle = enPrinting?.oracle_id ?? 'verify-bolt-oracle'
    replaceDeckCards(langDeckA, [
      deckCard(en.scryfall_id, boltOracle, enPrinting?.set_code ?? null,
        enPrinting?.collector_number ?? null, enPrinting?.name ?? 'Bolt'),
      deckCard(noNumber, 'verify-lang-oracle', 'tvfy', '', 'Verify Untranslatable')
    ])
    replaceDeckCards(langDeckB, [
      deckCard(en.scryfall_id, boltOracle, enPrinting?.set_code ?? null,
        enPrinting?.collector_number ?? null, enPrinting?.name ?? 'Bolt')
    ])
    /*
      Marked owned by hand rather than through `recomputeLabelPossession`.

      That function is global -- it walks every deck against a colour map -- so calling it
      here would rewrite the possession of fixtures other sections are still asserting on.
      A check that quietly moves another check's ground is worse than no check.
    */
    getDb().run(
      `UPDATE deck_cards SET label_possession = 'owned' WHERE deck_id IN (?,?)`,
      [langDeckA, langDeckB]
    )

    const deckRows = queryCollection(filters({}), 'usd', 500, 0).rows.filter(
      (row) => row.source === 'deck'
    )
    check('the sleeved rows show up in the collection at all',
      deckRows.length >= 2, `${deckRows.length} derived rows`)

    /*
      Every derived row resolves back to the deck entries it was built from.

      The two queries are inverses of each other by construction, and this is the coupling
      that matters: a row that appears in the list and answers with no target here is a row
      the action would skip -- which is the bug, exactly.
    */
    const unresolvable = deckRows.filter(
      (row) => deckTargetsForPrinting(row.scryfall_id, row.finish).length === 0
    )
    check('and every one of them resolves back to a deck entry',
      unresolvable.length === 0,
      unresolvable.map((row) => `${row.printing.name} ${row.finish}`).join(', '))

    // ---- a sleeved row, converted, in both decks that hold it
    const boltKey = `deck:${en.scryfall_id}:nonfoil`
    const converted = await setRowLanguages([boltKey], 'ja', () => undefined)
    check('a sleeved row is applied rather than skipped',
      converted.converted === 1 && converted.failed === 0 && converted.gone === 0,
      JSON.stringify(converted))
    check('and in every deck holding it, not just one',
      converted.decks === 2, JSON.stringify({ decks: converted.decks }))
    const overrides = getDb().all(
      `SELECT deck_id, scryfall_id, lang, forced_lang FROM deck_card_overrides
       WHERE oracle_id = ? ORDER BY deck_id`,
      [boltOracle]
    ) as { deck_id: number; scryfall_id: string; lang: string; forced_lang: string | null }[]
    check('the override names the printing in that language',
      overrides.length === 2 && overrides.every((o) => o.scryfall_id === ja.scryfall_id),
      JSON.stringify(overrides))
    const jaPrinting = getPrinting(ja.scryfall_id)
    check('and it is the same print it was on, not another one in that language',
      jaPrinting?.set_code === enPrinting?.set_code &&
        jaPrinting?.collector_number === enPrinting?.collector_number,
      JSON.stringify({
        from: `${enPrinting?.set_code} ${enPrinting?.collector_number}`,
        to: `${jaPrinting?.set_code} ${jaPrinting?.collector_number}`
      }))

    // ---- and one with no version in that language: the print stays, the language is kept
    const noNumberRow = addToCollection({
      scryfall_id: noNumber,
      finish: 'nonfoil',
      condition: 'NM',
      quantity: 1
    })
    const declared = await setRowLanguages(
      [`collection:${noNumberRow}`, `deck:${noNumber}:nonfoil`],
      'ja',
      () => undefined
    )
    check('a print with no version in that language is declared, not moved',
      declared.declared === 2 && declared.converted === 0 && declared.failed === 0,
      JSON.stringify(declared))
    const declaredRow = getItem(noNumberRow)
    check('the row keeps the print it was on',
      declaredRow?.scryfall_id === noNumber, JSON.stringify({ now: declaredRow?.scryfall_id }))
    check('and reads in the language you asked for, marked as yours',
      declaredRow?.printing.lang === 'ja' && declaredRow?.language_forced === true,
      JSON.stringify({
        lang: declaredRow?.printing.lang,
        forced: declaredRow?.language_forced
      }))
    const deckDeclared = getDb().get(
      `SELECT scryfall_id, forced_lang FROM deck_card_overrides
       WHERE deck_id = ? AND oracle_id = ?`,
      [langDeckA, 'verify-lang-oracle']
    ) as { scryfall_id: string; forced_lang: string | null } | undefined
    check('the deck entry keeps its print and records the language too',
      deckDeclared?.scryfall_id === noNumber && deckDeclared?.forced_lang === 'ja',
      JSON.stringify(deckDeclared))
    /*
      And no "language unavailable" flag was written.

      That flag used to be the whole answer here: the card kept its printing and got a
      warning badge, and its language did not change. Declaring says the same thing about
      Scryfall while also recording what you actually hold, so writing both would leave the
      screen contradicting itself.
    */
    const missRows = (
      getDb().get(
        `SELECT COUNT(*) AS n FROM deck_card_lang_requests WHERE deck_id IN (?,?)`,
        [langDeckA, langDeckB]
      ) as { n: number }
    ).n
    check('and no unavailable-language flag was left behind', missRows === 0, `${missRows} rows`)

    /*
      ---- every selected key comes back in exactly one count

      Through the real select-all query, and narrowed to this section's own card by name.
      Not the whole collection: running it unfiltered set every row in the fixture to
      Japanese and quietly broke a price check three sections later. A check that moves
      another check's ground is worse than no check.

      The filter still returns both kinds of row -- this card sits in the collection and
      in a deck -- which is the mixed selection the invariant is about.
    */
    const allKeys = matchingRowKeys(filters({ search: 'Verify Untranslatable' }), 'usd')
      .rows.map((row) => row.key)
    check('the select-all query returns both kinds of row for it',
      allKeys.length === 2 &&
        allKeys.some((k) => k.startsWith('collection:')) &&
        allKeys.some((k) => k.startsWith('deck:')),
      allKeys.join(' | '))
    const everything = await setRowLanguages(allKeys, 'ja', () => undefined)
    const tallied =
      everything.converted + everything.declared + everything.reserved +
      everything.gone + everything.failed
    /*
      The invariant, and the point of the whole change.

      Not "most rows worked" but "every row was answered for". Dropping a kind of row on
      the floor is unrepresentable if this holds, and it is what did not hold before: the
      sleeved rows were neither applied nor counted.
    */
    check('every selected row is accounted for, whichever kind it is',
      tallied === allKeys.length,
      JSON.stringify({ keys: allKeys.length, ...everything }))

    // ---- two prints of one card in one deck: the first wins, and both are answered for
    const otherPrint = getDb().get(
      `SELECT scryfall_id FROM printings WHERE oracle_id = ? AND scryfall_id NOT IN (?,?)
       LIMIT 1`,
      [boltOracle, en.scryfall_id, ja.scryfall_id]
    ) as { scryfall_id: string } | undefined
    if (otherPrint) {
      const twin = getPrinting(otherPrint.scryfall_id)
      replaceDeckCards(langDeckB, [
        deckCard(en.scryfall_id, boltOracle, enPrinting?.set_code ?? null,
          enPrinting?.collector_number ?? null, enPrinting?.name ?? 'Bolt'),
        deckCard(otherPrint.scryfall_id, boltOracle, twin?.set_code ?? null,
          twin?.collector_number ?? null, twin?.name ?? 'Bolt')
      ])
      getDb().run(`UPDATE deck_cards SET label_possession = 'owned' WHERE deck_id = ?`,
        [langDeckB])
      getDb().run('DELETE FROM deck_card_overrides WHERE oracle_id = ?', [boltOracle])
      /*
        Two rows, one override.

        `deck_card_overrides` is keyed on (deck, card), not on the print, so two prints of
        one card in one deck are two rows in the list and one row there. Writing the first
        one therefore moves *both* rows onto the printing it chose -- and the second key,
        which names a printing nothing holds any more, correctly reads as naming nothing.

        Worth pinning rather than glossing: it looks like a row was skipped, and it is the
        one case where that is the honest answer. What must not happen is the totals losing
        it, which is what the invariant catches.
      */
      const twoPrints = await setRowLanguages(
        [`deck:${en.scryfall_id}:nonfoil`, `deck:${otherPrint.scryfall_id}:nonfoil`],
        'ja',
        () => undefined
      )
      check('two prints of one card in one deck are both answered for',
        twoPrints.converted + twoPrints.declared + twoPrints.reserved +
          twoPrints.gone + twoPrints.failed === 2 && twoPrints.converted >= 1,
        JSON.stringify(twoPrints))
      check('and the second reads as naming nothing, because the first absorbed it',
        twoPrints.gone === 1, JSON.stringify(twoPrints))
      const survivingOverride = getDb().all(
        'SELECT deck_id, scryfall_id FROM deck_card_overrides WHERE oracle_id = ?',
        [boltOracle]
      ) as { deck_id: number; scryfall_id: string }[]
      check('and one override per deck is what is left',
        survivingOverride.length === new Set(survivingOverride.map((o) => o.deck_id)).size,
        JSON.stringify(survivingOverride))
    }

    // Leave nothing behind: these decks and rows are this section's own.
    getDb().run('DELETE FROM decks WHERE id IN (?,?)', [langDeckA, langDeckB])
    getDb().run('DELETE FROM collection_items WHERE scryfall_id = ?', [noNumber])
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

  section('Prices: the English printing fills in for the French one')

  /*
    The report this section exists for: a French card showed no price at all, in a synced deck
    and in the collection alike.

    Scryfall prices a printing, and it prices non-English printings almost never — the
    fixture proves it, `m10/146/fr` carries null in every currency while `/en` at the same set
    and number carries both. The read path has always been willing to borrow a *cached*
    sibling's figure; nothing ever cached the English twin, so there was nothing to borrow.
    Migration 21 asks for the fill and `fillEnglishPrices` performs it.

    Built on printings this suite inserts itself rather than on whatever the fixture happens
    to hold, because the whole question is what is cached and what is not.
  */
  {
    const priceless = JSON.stringify({
      usd: null,
      usd_foil: null,
      usd_etched: null,
      eur: null,
      eur_foil: null,
      tix: null
    })
    const withPrice = JSON.stringify({
      usd: '4.00',
      usd_foil: '9.00',
      usd_etched: null,
      eur: '3.00',
      eur_foil: '7.00',
      tix: null
    })
    const insert = (
      id: string,
      lang: string,
      set: string,
      number: string,
      oracle: string | null,
      prices: string
    ): void => {
      db.run(
        `INSERT OR REPLACE INTO printings (
           scryfall_id, oracle_id, name, printed_name, lang, set_code, set_name,
           collector_number, rarity, colors, color_identity, layout, finishes,
           prices_json, price_updated_at, fetched_at
         ) VALUES (?,?,?,?,?,?,?,?,?,'[]','[]','normal','["nonfoil"]',?, ?, ?)`,
        [
          id,
          oracle,
          `Fill Test ${number}`,
          null,
          lang,
          set,
          'Fill Set',
          number,
          'rare',
          prices,
          nowIso(),
          nowIso()
        ]
      )
    }

    // A French card whose English twin nobody has cached: the reported case.
    insert('fill-fr-alone', 'fr', 'fst', '1', 'oracle-alone', priceless)
    // A French card whose English twin is cached and priced: already answerable.
    insert('fill-fr-twinned', 'fr', 'fst', '2', 'oracle-twinned', priceless)
    insert('fill-en-twin', 'en', 'fst', '2', 'oracle-twinned', withPrice)
    // A French card with no oracle id at all — Scryfall omits it on reversible and
    // art-series cards — whose twin can only be found by set and collector number.
    insert('fill-fr-nooracle', 'fr', 'fst', '3', null, priceless)
    insert('fill-en-nooracle', 'en', 'fst', '3', null, withPrice)
    // An English card nothing prices: no twin exists and none would help.
    insert('fill-en-orphan', 'en', 'fst', '4', 'oracle-orphan', priceless)

    for (const id of [
      'fill-fr-alone',
      'fill-fr-twinned',
      'fill-fr-nooracle',
      'fill-en-orphan'
    ]) {
      addToCollection({ scryfall_id: id, finish: 'nonfoil', condition: 'NM', quantity: 1 })
    }

    /*
      Asked of the selection query, which is what decides whether a request is made.

      `prices_json` is not NULL for these rows — the mapper keeps every key Scryfall sends,
      so an unpriced printing holds an object full of nulls. A selection written against
      `prices_json IS NULL` would find nothing and the fill would do nothing at all.
    */
    const wanted = printingsMissingPrices().map((row) => row.scryfall_id)
    check(
      'the fill wants the French card whose English twin is not cached',
      wanted.includes('fill-fr-alone'),
      JSON.stringify(wanted.filter((id) => id.startsWith('fill-')))
    )
    check(
      'and leaves alone the one whose twin is cached and priced',
      !wanted.includes('fill-fr-twinned'),
      JSON.stringify(wanted.filter((id) => id.startsWith('fill-')))
    )
    check(
      'and the card with no oracle id, because its twin is found by set and number',
      !wanted.includes('fill-fr-nooracle'),
      JSON.stringify(wanted.filter((id) => id.startsWith('fill-')))
    )
    /*
      The work is finite, which is the property that makes this safe to run on every launch.

      An English row is never queued: its own twin is itself, so there is nothing to fetch.
      And a card whose English twin is already cached is never queued again even when that
      twin turned out to be unpriced -- otherwise a card Scryfall prices in no language would
      be asked about for ever, and the fill would never stop having work to do.
    */
    check(
      'an English printing is never queued: its twin is itself',
      !wanted.includes('fill-en-orphan'),
      JSON.stringify(wanted.filter((id) => id.startsWith('fill-')))
    )
    check(
      'and a card whose twin is cached but unpriced is not asked about again',
      (() => {
        insert('fill-fr-asked', 'fr', 'fst', '6', 'oracle-asked', priceless)
        insert('fill-en-asked', 'en', 'fst', '6', 'oracle-asked', priceless)
        addToCollection({
          scryfall_id: 'fill-fr-asked',
          finish: 'nonfoil',
          condition: 'NM',
          quantity: 1
        })
        return (
          !printingsMissingPrices().some((row) => row.scryfall_id === 'fill-fr-asked') &&
          unpricedAmong(['fill-fr-asked']).length === 0
        )
      })(),
      'the fill would keep re-fetching a card Scryfall prices in no language'
    )
    check(
      'the selection carries the set and number the English printing is fetched by',
      printingsMissingPrices().every(
        (row) => !!row.set_code && !!row.collector_number
      ),
      'a selected row has no set or collector number to look the twin up with'
    )
    check(
      'and asking about specific printings gives the same answer',
      JSON.stringify(unpricedAmong(['fill-fr-alone', 'fill-fr-twinned']).map((r) => r.scryfall_id)) ===
        JSON.stringify(['fill-fr-alone']),
      JSON.stringify(unpricedAmong(['fill-fr-alone', 'fill-fr-twinned']))
    )
    check(
      'nothing is requested for a card that is already priced',
      unpricedAmong(['fill-en-twin']).length === 0,
      'a priced printing was queued for a fetch it does not need'
    )

    /*
      The report, end to end: with the twin cached the French row prices, and says the figure
      is not its own. Both are needed -- a borrowed figure shown as exact is the other half
      of the same bug.
    */
    {
      const rows = queryCollection(filters({ search: 'Fill Test' }), 'eur', 50, 0).rows
      const twinned = rows.find((row) => row.scryfall_id === 'fill-fr-twinned')
      const alone = rows.find((row) => row.scryfall_id === 'fill-fr-alone')
      const noOracle = rows.find((row) => row.scryfall_id === 'fill-fr-nooracle')
      check(
        'a French row with a cached English twin shows a price, marked as borrowed',
        twinned?.unit_value === 3 && twinned?.price_is_proxy === true,
        `value=${twinned?.unit_value} proxy=${twinned?.price_is_proxy}`
      )
      check(
        'a French row with no oracle id borrows through set and collector number',
        noOracle?.unit_value === 3 && noOracle?.price_is_proxy === true,
        `value=${noOracle?.unit_value} proxy=${noOracle?.price_is_proxy}`
      )
      check(
        'and the one whose twin is missing still reports null rather than 0',
        alone?.unit_value === null && alone?.price_is_proxy === false,
        `value=${alone?.unit_value} proxy=${alone?.price_is_proxy}`
      )
    }

    /*
      And the same answer for the screens that hold a `Printing` rather than a row: the
      details price grid, the printing picker, the Add-cards tiles. They read the object over
      IPC and had no way back to the database, which is why they drew an em dash for every
      French card even when the twin was cached.
    */
    {
      const twinned = getPrinting('fill-fr-twinned')
      const alone = getPrinting('fill-fr-alone')
      const twin = getPrinting('fill-en-twin')
      check(
        'a printing carries its twin’s prices when it has none of its own',
        twinned?.borrowed_prices?.eur === '3.00' && twinned?.prices?.eur === null,
        JSON.stringify({ own: twinned?.prices?.eur, borrowed: twinned?.borrowed_prices?.eur })
      )
      check(
        'and priceOfPrinting resolves own, then borrowed, then null',
        priceOfPrinting(twin!, 'nonfoil', 'eur').value === 3 &&
          priceOfPrinting(twin!, 'nonfoil', 'eur').borrowed === false &&
          priceOfPrinting(twinned!, 'nonfoil', 'eur').value === 3 &&
          priceOfPrinting(twinned!, 'nonfoil', 'eur').borrowed === true &&
          priceOfPrinting(alone!, 'nonfoil', 'eur').value === null,
        JSON.stringify({
          own: priceOfPrinting(twin!, 'nonfoil', 'eur'),
          borrowed: priceOfPrinting(twinned!, 'nonfoil', 'eur'),
          neither: priceOfPrinting(alone!, 'nonfoil', 'eur')
        })
      )
      check(
        'a borrowed foil price comes from the twin’s foil column, not its plain one',
        priceOfPrinting(twinned!, 'foil', 'eur').value === 7,
        `${priceOfPrinting(twinned!, 'foil', 'eur').value}`
      )
    }

    /*
      The picker and the Add-cards tiles, which hold printings off a Scryfall search rather
      than rows out of the database.

      This was the gap the first attempt left: `priceOfPrinting` was wired into all three
      screens, but nothing on that path ever set `borrowed_prices`, so every translated row
      went on drawing an em dash next to a priced English one. `cache()` in addCards resolves
      them in one query now, and this asserts the query rather than the screen.
    */
    {
      const lent = borrowedPricesFor(['fill-fr-twinned', 'fill-en-twin', 'fill-fr-alone'])
      check(
        'a batch lookup lends the twin’s prices to the printing that has none',
        JSON.parse(lent.get('fill-fr-twinned') ?? '{}').eur === '3.00',
        JSON.stringify([...lent.entries()])
      )
      check(
        'and lends nothing to a printing that has its own, or has no lender',
        !lent.has('fill-en-twin') && !lent.has('fill-fr-alone'),
        JSON.stringify([...lent.keys()])
      )
      check(
        'and it survives more ids than SQLite will bind at once',
        borrowedPricesFor([
          ...Array.from({ length: 40000 }, (_, i) => `bulk-${i}`),
          'fill-fr-twinned'
        ]).has('fill-fr-twinned'),
        'a large batch threw or lost its answer'
      )
      check(
        'so does the unpriced lookup, which a large CSV import hands its whole file',
        unpricedAmong([
          ...Array.from({ length: 40000 }, (_, i) => `bulk-${i}`),
          'fill-fr-alone'
        ]).some((row) => row.scryfall_id === 'fill-fr-alone'),
        'a large batch threw or lost its answer'
      )
    }

    /*
      A price is never worth the operation it rode in on.

      Two shapes of the same mistake, both found in review before they shipped: fast entry
      awaited the price fetch *before* writing the row, so a 503 from Scryfall meant the card
      somebody typed was never added; and the bulk language flows awaited it after every row
      was committed but inside `undoableAsync`, which records its undo step only once the
      action resolves -- so a throw there left the conversion done and impossible to undo.

      Driven by making the fetch actually fail, on a card the fill actually asks about. The
      first version of these checks used a card whose English twin was already cached, so the
      fill returned early, the POST was never reached and both checks passed against code that
      had been deliberately broken. This is that lesson, kept.
    */
    {
      const realFetch = globalThis.fetch
      const withDeadPost = async <T>(run: () => Promise<T>): Promise<T> => {
        globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
          if ((init?.method ?? 'GET') === 'POST' && String(input).includes('/cards/collection')) {
            throw new Error('Scryfall is down')
          }
          return realFetch(input, init)
        }) as typeof fetch
        try {
          return await run()
        } finally {
          globalThis.fetch = realFetch
        }
      }

      // The card the fill genuinely wants: French, unpriced, no English twin cached.
      check(
        'the fill really does reach the network for a card with no twin',
        unpricedAmong(['fill-fr-alone']).length === 1,
        'the checks below would prove nothing about a card that is never fetched'
      )

      let loudThrew = false
      await withDeadPost(async () => {
        try {
          await fillEnglishPrices(['fill-fr-alone'])
        } catch {
          loudThrew = true
        }
      })
      check(
        'a failed price fetch is a real failure when someone asked for it',
        loudThrew,
        'the fill swallowed a fetch failure the Stats button needs to see'
      )

      const quiet = await withDeadPost(() => fillEnglishPricesQuietly(['fill-fr-alone']))
      check(
        'but it costs the caller nothing when it was nobody’s errand',
        quiet.requested === 0 && quiet.filled === 0,
        JSON.stringify(quiet)
      )

      /*
        And the order fast entry does its two jobs in, which no fixture can reach: the card
        this suite can add is one whose twin is already cached, so the fetch never runs and a
        behavioural check cannot tell the two orders apart. Asserted as text, deliberately,
        because the alternative is asserting nothing -- and the failure it guards against is
        losing a card somebody typed.
      */
      {
        const source = readFileSync(joinPath('src', 'main', 'services', 'addCards.ts'), 'utf8')
        check(
          'fast entry writes the row before it asks about prices',
          source.indexOf('addToCollection({') < source.indexOf('fillEnglishPricesQuietly('),
          'the price fetch is back in front of the write it must not be able to veto'
        )
      }
    }

    /*
      What the price refresh covers. It was the collection alone, which is how a synced deck's
      French cards went un-refreshed indefinitely: the only job that updates prices could not
      see them.
    */
    {
      /*
        A printing nobody owns, named only by a deck -- which is the reported case: the cards
        with no price were in a deck synced from Archidekt, and the refresh could not see
        them. Inserted straight into `deck_cards`, with no collection row anywhere, because
        that is the shape of the problem.
      */
      insert('fill-deck-only', 'fr', 'fst', '5', 'oracle-deck-only', priceless)
      const anyDeck = db.get('SELECT id FROM decks LIMIT 1') as { id: number } | undefined
      if (anyDeck) {
        db.run(
          `INSERT INTO deck_cards (deck_id, scryfall_id, oracle_id, quantity, name, lang,
                                   set_code, collector_number)
           VALUES (?,?,?,?,?,?,?,?)`,
          [anyDeck.id, 'fill-deck-only', 'oracle-deck-only', 1, 'Fill Test 5', 'fr', 'fst', '5']
        )
      }

      const ids = pricedPrintingIds()
      check(
        'the price refresh covers a printing only a deck names',
        anyDeck ? ids.includes('fill-deck-only') : false,
        anyDeck
          ? 'a deck-only printing is invisible to the only job that refreshes prices'
          : 'no deck to hang the check on'
      )
      check(
        'and the fill wants it too, since nothing prices it',
        printingsMissingPrices().some((row) => row.scryfall_id === 'fill-deck-only'),
        'a deck-only unpriced printing was not selected for the fill'
      )
      check(
        'the price refresh covers the English twins it borrows from',
        ids.includes('fill-en-twin'),
        'a twin nobody owns would never be refreshed again'
      )
      check(
        'and every printing the collection holds',
        ids.includes('fill-fr-alone') && ids.includes('fill-fr-twinned'),
        'a held printing is missing from the refresh set'
      )
    }

    /*
      Migration 21 asked for all of this, and it is the only thing that makes the fill run on
      an existing database. Asked of the settings row rather than of the migration's text: a
      check that greps the source cannot tell running from being mentioned.
    */
    check(
      'migration 21 leaves the English price fill pending',
      (db.get('SELECT value FROM settings WHERE key = ?', [FILL_FLAG]) as
        | { value: string }
        | undefined)?.value === 'pending',
      JSON.stringify(db.get('SELECT * FROM settings WHERE key = ?', [FILL_FLAG]))
    )
    check(
      'and running its statement again changes nothing',
      (() => {
        db.exec(
          "INSERT OR REPLACE INTO settings (key, value) VALUES ('prices.fillEnglish', 'pending')"
        )
        const rows = db.all('SELECT value FROM settings WHERE key = ?', [FILL_FLAG]) as {
          value: string
        }[]
        return rows.length === 1 && rows[0].value === 'pending'
      })(),
      'the flag is not a single pending row after a second run'
    )

    /*
      The value filter, which threw for as long as it existed: `priceExpr`'s default finish
      column names an alias that is scoped inside the union this query selects from. Nothing
      in the suite ever set a value range, so nothing caught it.
    */
    check(
      'a value range filters instead of throwing',
      (() => {
        try {
          const page = queryCollection(filters({ valueMin: 1 }), 'eur', 50, 0)
          return page.rows.every((row) => (row.unit_value ?? 0) >= 1)
        } catch (err) {
          return `threw: ${(err as Error).message}` === ''
        }
      })(),
      'setting a minimum value raised instead of filtering'
    )
    check(
      'and a maximum too, with the facets it drives',
      (() => {
        try {
          queryFacets(filters({ valueMax: 2 }))
          return true
        } catch {
          return false
        }
      })(),
      'the facet query raised on a value range'
    )
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
  section('Undo and redo')

  /*
    One property, applied to every undoable action: do it, undo it, and the whole
    database must be byte-identical to what it was; then redo it, and it must be
    identical to what it was straight after the action.

    Written as a property rather than as per-action assertions on purpose. The way
    a before/after journal fails is a **scope that is too narrow** — it captures
    some of the rows an action touched and silently misses the rest — and no
    hand-written assertion about one field would notice that. A whole-database
    fingerprint does.

    The fingerprint covers every table an action here can reach. `sqlite_sequence`
    is deliberately excluded: an AUTOINCREMENT counter does not go backwards when
    a row is removed, so it legitimately differs after an undo and comparing it
    would fail every insert case for no reason.
  */
  /*
    Everything the fingerprint deliberately ignores. Everything else is included by
    being in the database at all.

    This used to be the other way round -- a hand-written list of the tables to
    compare -- and it failed exactly as a hand-written list does: a table was added,
    no undo scope covered it, and the property test that exists to catch a too-narrow
    scope reported nothing, because the new table was not in its list either.
    Inverting it makes forgetting safe: a table added tomorrow is compared without
    anyone remembering to say so, and only a deliberate exclusion is silent.

    The exclusions are the caches and the counters. `printings`, `sets` and the
    booster tables are Scryfall and MTGJSON data with thousands of rows and a
    `raw_json` column apiece -- fingerprinting them on every step would be slow and
    would prove nothing, since no undoable action writes them. `sqlite_sequence` is
    excluded because an AUTOINCREMENT counter does not go backwards when a row is
    removed, so it legitimately differs after an undo, and `schema_version` because
    migrations are not undoable.
  */
  const UNDO_IGNORED = [
    'printings',
    'sets',
    'settings',
    'booster_odds',
    'booster_sets',
    'schema_version',
    'sqlite_sequence'
  ]

  const UNDO_TABLES = (
    getDb().all(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'"
    ) as { name: string }[]
  )
    .map((row) => row.name)
    .filter((name) => !UNDO_IGNORED.includes(name))
    .sort()

  check(
    'the undo fingerprint covers every table that is not a cache',
    UNDO_TABLES.includes('collection_items') &&
      UNDO_TABLES.includes('pick_list_items') &&
      UNDO_TABLES.includes('deck_entry_traits') &&
      !UNDO_TABLES.includes('printings'),
    UNDO_TABLES.join(', ')
  )
  console.log(`        \u2192 fingerprinting ${UNDO_TABLES.length} tables`)

  const dbState = (): string =>
    JSON.stringify(
      UNDO_TABLES.map((table) => [table, getDb().all(`SELECT * FROM ${table}`)])
    )

  /**
   * Which table a fingerprint mismatch is in, and how it differs.
   *
   * A bare "the fingerprint differs" says something is wrong and nothing about
   * what, which is most of the work. Naming the table and showing the first row
   * that disagrees is the difference between a failing check and a diagnosis.
   */
  const stateDiff = (before: string, after: string): string => {
    const a = JSON.parse(before) as [string, Record<string, unknown>[]][]
    const b = JSON.parse(after) as [string, Record<string, unknown>[]][]
    for (let i = 0; i < a.length; i += 1) {
      const [table, rowsA] = a[i]
      const rowsB = b[i][1]
      if (JSON.stringify(rowsA) === JSON.stringify(rowsB)) continue
      if (rowsA.length !== rowsB.length) {
        return `${table}: ${rowsA.length} rows before, ${rowsB.length} after`
      }
      for (let r = 0; r < rowsA.length; r += 1) {
        if (JSON.stringify(rowsA[r]) === JSON.stringify(rowsB[r])) continue
        const changed = Object.keys(rowsA[r]).filter(
          (k) => JSON.stringify(rowsA[r][k]) !== JSON.stringify(rowsB[r][k])
        )
        return `${table}.${changed.join(',')}: ${changed
          .map((k) => `${JSON.stringify(rowsA[r][k])} -> ${JSON.stringify(rowsB[r][k])}`)
          .join('; ')}`
      }
    }
    return 'no per-table difference found'
  }

  /**
   * Runs one action through the whole cycle.
   *
   * `perform` must go through the same path the app does, so the scope under test
   * is the real one rather than one restated by the test.
   */
  /**
   * The same round trip, for an action that awaits something.
   *
   * The bulk language change is the first of these on the collection: it asks Scryfall
   * once per row before it writes. A synchronous round trip would snapshot the after-image
   * while the promise was still in flight and compare two identical states, which is a
   * check that always passes.
   */
  const asyncRoundTrip = async (name: string, perform: () => Promise<unknown>): Promise<void> => {
    const before = dbState()
    await perform()
    const after = dbState()
    if (before === after) {
      check(`${name}: the action changed something`, false, 'nothing changed, so nothing is proven')
      return
    }
    const undone = undo()
    check(`${name}: undo reports what it took back`, undone !== null, 'undo() returned null')
    check(`${name}: undo restores the database exactly`, dbState() === before,
      stateDiff(before, dbState()))
    const redone = redo()
    check(`${name}: redo reports what it put back`, redone !== null, 'redo() returned null')
    check(`${name}: redo reproduces the action exactly`, dbState() === after,
      stateDiff(after, dbState()))
    clearUndoHistory()
  }

  const roundTrip = (name: string, perform: () => void): void => {
    const before = dbState()
    perform()
    const after = dbState()
    if (before === after) {
      check(`${name}: the action changed something`, false, 'nothing changed, so nothing is proven')
      return
    }
    const undone = undo()
    check(`${name}: undo reports what it took back`, undone !== null, 'undo() returned null')
    check(
      `${name}: undo restores the database exactly`,
      dbState() === before,
      stateDiff(before, dbState())
    )
    const redone = redo()
    check(`${name}: redo reports what it put back`, redone !== null, 'redo() returned null')
    check(
      `${name}: redo reproduces the action exactly`,
      dbState() === after,
      stateDiff(after, dbState())
    )
    // Leave the stack clean so each case starts from a known depth.
    undo()
    clearUndoHistory()
  }

  {
    const printing = getDb().get(
      `SELECT scryfall_id FROM printings
       WHERE NOT EXISTS (SELECT 1 FROM collection_items ci WHERE ci.scryfall_id = printings.scryfall_id)
       ORDER BY scryfall_id LIMIT 1`
    ) as { scryfall_id: string } | undefined

    if (printing) {
      // Adding a row that does not exist yet — the case an id-based scope misses.
      roundTrip('adding a card', () =>
        undoable('undo.addCard', [undoScopeForAdd(printing.scryfall_id)], () =>
          addToCollection({
            scryfall_id: printing.scryfall_id,
            finish: 'nonfoil',
            condition: 'NM',
            quantity: 3
          })
        )
      )

      // With the row present, the update, merge and delete cases.
      addToCollection({
        scryfall_id: printing.scryfall_id,
        finish: 'nonfoil',
        condition: 'NM',
        quantity: 3
      })
      const added = (
        getDb().get('SELECT id FROM collection_items WHERE scryfall_id = ?', [
          printing.scryfall_id
        ]) as { id: number }
      ).id

      roundTrip('changing a quantity', () =>
        undoable('undo.setQuantity', [{ table: 'collection_items', where: 'id = ?', params: [added] }], () =>
          setQuantity(added, 7)
        )
      )

      roundTrip('editing a copy', () =>
        undoable(
          'undo.editCopy',
          [{ table: 'collection_items', where: 'scryfall_id = ?', params: [printing.scryfall_id] }],
          () => updateItem(added, { foil_treatment: 'surgefoil', proxied: 1 })
        )
      )

      /*
        The merge case, and the reason `collection:update` is scoped on the whole
        printing rather than on the row's id. Changing a finish moves the row
        across its own UNIQUE key: it merges into the sibling and deletes itself,
        so an id-scoped image would restore the row it was told about and leave the
        sibling holding the extra copies.
      */
      addToCollection({
        scryfall_id: printing.scryfall_id,
        finish: 'foil',
        condition: 'NM',
        quantity: 2
      })
      roundTrip('a finish change that merges two rows', () =>
        undoable(
          'undo.editCopy',
          [{ table: 'collection_items', where: 'scryfall_id = ?', params: [printing.scryfall_id] }],
          () => updateItem(added, { finish: 'foil' })
        )
      )

      roundTrip('removing copies', () =>
        undoable('undo.removeCopies', [{ table: 'collection_items', where: 'id = ?', params: [added] }], () =>
          removeItem(added)
        )
      )

      getDb().run('DELETE FROM collection_items WHERE scryfall_id = ?', [printing.scryfall_id])
    } else {
      check('undo round trips (no spare printing in the fixture)', false, 'fixture too thin')
    }
  }

  /*
    Proof the property can fail, run in-process rather than left to a comment.

    The scope here names only the row's id, while the action also merges a sibling
    row away — exactly the mistake the wide scopes above exist to avoid. If this
    "passes", the property test is not measuring anything and none of the results
    above mean what they say.
  */
  {
    const spare = getDb().get(
      `SELECT scryfall_id FROM printings
       WHERE NOT EXISTS (SELECT 1 FROM collection_items ci WHERE ci.scryfall_id = printings.scryfall_id)
       ORDER BY scryfall_id DESC LIMIT 1`
    ) as { scryfall_id: string } | undefined
    if (spare) {
      addToCollection({ scryfall_id: spare.scryfall_id, finish: 'nonfoil', condition: 'NM', quantity: 1 })
      addToCollection({ scryfall_id: spare.scryfall_id, finish: 'foil', condition: 'NM', quantity: 1 })
      const target = (
        getDb().get(
          "SELECT id FROM collection_items WHERE scryfall_id = ? AND finish = 'nonfoil'",
          [spare.scryfall_id]
        ) as { id: number }
      ).id

      const before = dbState()
      undoable('undo.editCopy', [{ table: 'collection_items', where: 'id = ?', params: [target] }], () =>
        updateItem(target, { finish: 'foil' })
      )
      undo()
      check(
        'a scope too narrow to cover the action fails the round trip, as it must',
        dbState() !== before,
        'an under-scoped step round-tripped cleanly, so this property proves nothing'
      )
      clearUndoHistory()
      getDb().run('DELETE FROM collection_items WHERE scryfall_id = ?', [spare.scryfall_id])
    } else {
      check('the property can fail (no spare printing)', false, 'fixture too thin')
    }
  }

  /*
    The same property, over the scopes the *handlers* declare.

    This is the gap that let a real bug ship. The cases above call `undoable()`
    with scopes written here, which tests the journal but not the configuration —
    and the configuration is the only part that can be wrong. `pickListScopes`
    listed `pick_list_items` before the `collection_items` rows it references, so
    the restore re-inserted a pick item pointing at a row it had not put back yet
    and every undo of a validated pick list died with "FOREIGN KEY constraint
    failed". Importing the real builders is what makes this test mean something.
  */
  {
    const spare = db.get(
      `SELECT scryfall_id FROM printings
       WHERE NOT EXISTS (SELECT 1 FROM collection_items ci WHERE ci.scryfall_id = printings.scryfall_id)
       ORDER BY scryfall_id LIMIT 1`
    ) as { scryfall_id: string } | undefined

    if (spare) {
      addToCollection({
        scryfall_id: spare.scryfall_id,
        finish: 'nonfoil',
        condition: 'NM',
        quantity: 2
      })
      const itemId = (
        db.get('SELECT id FROM collection_items WHERE scryfall_id = ?', [
          spare.scryfall_id
        ]) as { id: number }
      ).id

      /*
        The row-level cases run first, on purpose: the pick list below stages this
        row in full, so validating deletes it and anything addressing it afterwards
        would silently do nothing — which is exactly how this case first "passed"
        while asserting nothing.
      */
      roundTrip('a bulk edit (real scopes)', () =>
        undoable('undo.bulkEdit', [scryfallScopeMany([itemId])], () => {
          // Condition, not a foil treatment: the app correctly refuses to store a
          // treatment on a nonfoil copy, so that would have been a no-op too.
          bulkUpdate([itemId], { condition: 'LP' })
          return true
        })
      )
      /*
        A language across several rows, through the real scopes.

        The scope has to be the whole table: the printings these rows land on come back
        from Scryfall, so a scope built from the ids in hand covers where they started and
        not where they end up. The fingerprint is what proves it -- narrow the scope and
        the undo leaves rows behind on their new printings.
      */
      if (en && ja) {
        const langA = addToCollection({
          scryfall_id: en.scryfall_id, finish: 'nonfoil', condition: 'GD', quantity: 1
        })
        await asyncRoundTrip('a language across several rows (real scopes)', () =>
          undoableAsync(
            'undo.bulkSetLanguage',
            // The real builder, not a copy of it: a scope that drifts from the handler's
            // is exactly the failure this round trip exists to catch.
            rowLanguageScopes(),
            () => setRowLanguages([`collection:${langA}`], 'ja', () => undefined)
          )
        )
        db.run('DELETE FROM collection_items WHERE condition = ? AND scryfall_id IN (?, ?)',
          ['GD', en.scryfall_id, ja.scryfall_id])

        /*
          And the same action reaching a deck.

          This is the half the scope had never covered, because until now the action could
          not reach a deck at all. Two tables are in play and both are easy to forget:
          `deck_card_overrides`, which the write lands in, and `deck_card_lang_requests`,
          which it *deletes* from -- so an undo that does not capture the second cannot put
          back a flag that was there before. Drop either from `rowLanguageScopes` and the
          fingerprint below fails.
        */
        const undoDeck = upsertDeck({
          external_id: 'verify-undo-lang',
          name: 'Undo Language',
          format: 'commander',
          owner_username: 'verify',
          url: 'https://archidekt.com/decks/verify-undo-lang',
          external_updated_at: null,
          last_synced_at: new Date(0).toISOString(),
          is_private: false,
          is_unlisted: false,
          raw_json: '{}'
        })
        const undoPrinting = getPrinting(en.scryfall_id)
        const undoOracle = undoPrinting?.oracle_id ?? 'verify-undo-oracle'
        replaceDeckCards(undoDeck, [
          {
            scryfall_id: en.scryfall_id,
            oracle_id: undoOracle,
            quantity: 1,
            finish: 'nonfoil',
            categories: [],
            in_maindeck: true,
            name: undoPrinting?.name ?? 'Bolt',
            lang: 'en',
            set_code: undoPrinting?.set_code ?? null,
            collector_number: undoPrinting?.collector_number ?? null,
            rarity: 'common',
            image_uri_small: null,
            label: 'Have it,#4CAF50'
          }
        ])
        db.run(`UPDATE deck_cards SET label_possession = 'owned' WHERE deck_id = ?`, [undoDeck])
        // A flag already standing, so the undo has something to put back rather than
        // only something to remove.
        db.run(
          `INSERT INTO deck_card_lang_requests (deck_id, oracle_id, requested_lang, created_at)
           VALUES (?,?,?,?)
           ON CONFLICT(deck_id, oracle_id) DO NOTHING`,
          [undoDeck, undoOracle, 'de', new Date(0).toISOString()]
        )
        await asyncRoundTrip('a language reaching a deck row (real scopes)', () =>
          undoableAsync('undo.bulkSetLanguage', rowLanguageScopes(), () =>
            setRowLanguages([`deck:${en.scryfall_id}:nonfoil`], 'ja', () => undefined)
          )
        )

        /*
          And the deck screen's own version of the action.

          It writes one more thing than its scopes admitted: the language it was asked for
          is remembered on the deck row itself, to preselect the menu next time. `decks` is
          in the fingerprint, but no round trip had ever run this action, so an undo that
          left `default_lang` changed went unnoticed for as long as the feature existed.
        */
        await asyncRoundTrip('a deck language apply (real scopes)', () =>
          undoableAsync('undo.setDeckLanguage', deckLanguageScopes(undoDeck), () =>
            setCardsLanguage(undoDeck, [undoOracle], 'ja', () => undefined)
          )
        )
        db.run('DELETE FROM decks WHERE id = ?', [undoDeck])
      }
      roundTrip('an add (real scopes)', () =>
        undoable(
          'undo.addCard',
          [
            collectionKeyScope({
              scryfall_id: spare.scryfall_id,
              finish: 'etched',
              condition: 'NM'
            })
          ],
          () =>
            addToCollection({
              scryfall_id: spare.scryfall_id,
              finish: 'etched',
              condition: 'NM',
              quantity: 1
            })
        )
      )

      /*
        Staged in full so validating empties the row and deletes it. That is what
        makes the pick item's `collection_item_id` go NULL and come back pointing
        at a row that has to be re-created — the ordering the bug tripped over.
      */
      const list = createPickList('Real-scope undo')
      addToPickList(list, { kind: 'collection', itemId }, 2)

      /*
        Moving a card between a deck and the collection, through the real scopes.

        Untested until a bug turned up in use: Ctrl+Z after taking a card out of a
        deck left the card in the collection and did not put it back in the deck.
        The property test covered the collection and pick-list scopes and never
        `moveScopes`, so the one set of scopes belonging to the newest feature was
        the one nothing checked.
      */
      {
        /*
          Its own owned row. By this point in the suite the label mapping has been
          reset, so querying for one that is already owned found nothing and the
          case skipped — reporting SKIP rather than passing, which is the only
          reason that was visible at all.
        */
        const anyDeckRow = db.get(
          `SELECT deck_id, oracle_id, scryfall_id FROM deck_cards
           WHERE oracle_id IS NOT NULL AND scryfall_id IS NOT NULL AND quantity > 0
           LIMIT 1`
        ) as { deck_id: number; oracle_id: string; scryfall_id: string } | undefined
        if (anyDeckRow) {
          db.run('UPDATE deck_cards SET label = ? WHERE deck_id = ? AND scryfall_id = ?', [
            'Have it,#4CAF50',
            anyDeckRow.deck_id,
            anyDeckRow.scryfall_id
          ])
          recomputeLabelPossession({ '#4caf50': 'owned' })
        }
        const deckRow = db.get(
          `SELECT deck_id, oracle_id FROM deck_cards
           WHERE label_possession = 'owned' AND oracle_id IS NOT NULL AND quantity > 0
           LIMIT 1`
        ) as { deck_id: number; oracle_id: string } | undefined

        if (deckRow) {
          roundTrip('moving a card out of a deck (real scopes)', () =>
            undoable('undo.moveToCollection', moveScopes(deckRow.deck_id), () =>
              moveToCollection(deckRow.deck_id, deckRow.oracle_id, 1)
            )
          )

          /*
            Undoing a *validated pull* of a deck card — the case that was reported.

            Validating takes the copies off the deck row, so `pickListScopes` has to
            capture those rows. It did not, and undoing put the card back in the
            collection while leaving the deck still missing it. Tested through the
            real builder, because the builder is what was wrong.
          */
          /*
            The list is created and staged *outside* the measured region. Only
            validating is under test, and undoing it should not be expected to
            un-create the list — the first version of this staged inside the
            callback and failed on the extra pick_lists row, which was the test
            being wrong rather than the code.
          */
          const deckPullList = createPickList('Deck pull undo')
          addToPickList(
            deckPullList,
            {
              kind: 'deck',
              deckId: deckRow.deck_id,
              oracleId: deckRow.oracle_id,
              destination: 'collection'
            },
            1
          )
          // Built before the action, exactly as the handler builds them.
          const deckPullScopes = pickListScopes(deckPullList)
          roundTrip('undoing a validated deck pull (real scopes)', () =>
            undoable('undo.validatePull', deckPullScopes, () => confirmPickList(deckPullList))
          )
          db.run("DELETE FROM pick_lists WHERE name = 'Deck pull undo'")
          db.run('DELETE FROM deck_card_moves WHERE deck_id = ?', [deckRow.deck_id])

          // And the other direction, which creates a deck row rather than editing one.
          const intoDeck = db.get(
            `SELECT ci.id FROM collection_items ci WHERE ci.quantity > 0 LIMIT 1`
          ) as { id: number } | undefined
          if (intoDeck) {
            roundTrip('moving a card into a deck (real scopes)', () =>
              undoable('undo.moveToDeck', moveScopes(deckRow.deck_id), () =>
                moveToDeck(deckRow.deck_id, intoDeck.id, 1)
              )
            )
            /*
              And a proxy, which is the case that writes a trait.

              Worth its own round trip: moving a plain copy touches three tables and
              moving a proxy touches a fourth, so the scope that covered the first would
              have looked complete while leaving a proxy flag behind after an undo.
            */
            const proxyIn = db.get(
              `SELECT ci.id, p.oracle_id FROM collection_items ci
               JOIN printings p ON p.scryfall_id = ci.scryfall_id
               WHERE ci.quantity > 0 AND p.oracle_id IS NOT NULL
                 AND NOT EXISTS (SELECT 1 FROM deck_cards dc
                                  WHERE dc.deck_id = ? AND dc.oracle_id = p.oracle_id)
               LIMIT 1`,
              [deckRow.deck_id]
            ) as { id: number; oracle_id: string } | undefined
            if (proxyIn) {
              bulkUpdate([proxyIn.id], { proxied: 1 })
              roundTrip('moving a proxy into a deck (real scopes)', () =>
                undoable('undo.moveToDeck', moveScopes(deckRow.deck_id), () =>
                  moveToDeck(deckRow.deck_id, proxyIn.id, 1)
                )
              )
              bulkUpdate([proxyIn.id], { proxied: 0 })
            } else {
              skip('moving a proxy into a deck (real scopes)', 'no spare collection row')
            }
          } else {
            skip('moving a card into a deck (real scopes)', 'no collection row to move')
          }
        } else {
          skip('moving a card out of a deck (real scopes)', 'no owned deck row in the fixture')
        }
      }

      roundTrip('validating a pick list (real scopes)', () =>
        undoable('undo.validatePull', pickListScopes(list), () => confirmPickList(list))
      )

      // And the two neighbouring actions on the same scopes.
      confirmPickList(list)
      roundTrip('reverting a validated list (real scopes)', () =>
        undoable('undo.revertPull', pickListScopes(list), () => revertPickList(list))
      )
      roundTrip('deleting a validated list (real scopes)', () =>
        undoable('undo.deleteList', pickListScopes(list), () => {
          deletePickList(list)
          return true
        })
      )

      db.run('DELETE FROM pick_lists WHERE id = ?', [list])
      db.run('DELETE FROM collection_items WHERE scryfall_id = ?', [spare.scryfall_id])
      clearUndoHistory()
    } else {
      check('undo over the real handler scopes (fixture too thin)', false, 'no spare printing')
    }
  }

  check(
    'a sync throws the history away, since it can move rows out from under a step',
    (() => {
      clearUndoHistory()
      return undoDepth().undo === 0 && undoDepth().redo === 0
    })()
  )

  section('What a deck sync decides to touch')

  /*
    An unlisted deck is absent from a public profile listing, by definition. Two
    things used to follow from that, both wrong: it was never re-synced, and it was
    counted as private on every run. Tested through the pure planner rather than a
    live sync, because reproducing it end to end needs an Archidekt account with an
    unlisted deck — which is exactly why it went unnoticed.
  */
  {
    // The reported case: profile lists two, you also hold one added by URL.
    const p1 = planDeckSync(['10', '20'], ['10', '20', '99'], 3)
    check(
      'a deck you hold that the profile does not list is queued for sync',
      p1.localOnly.length === 1 && p1.localOnly[0] === '99',
      JSON.stringify(p1)
    )
    check(
      'and it is not counted as private, because you plainly have it',
      p1.hidden === 0,
      `hidden ${p1.hidden}`
    )

    // A genuinely unreachable deck still gets reported.
    const p2 = planDeckSync(['10'], ['10'], 3)
    check(
      'a deck Archidekt counts but neither lists nor you hold is still reported',
      p2.hidden === 2 && p2.localOnly.length === 0,
      JSON.stringify(p2)
    )

    // Everything listed: nothing extra, nothing hidden.
    const p3 = planDeckSync(['1', '2', '3'], ['1', '2'], 3)
    check(
      'when the profile lists everything, nothing is queued or reported',
      p3.localOnly.length === 0 && p3.hidden === 0,
      JSON.stringify(p3)
    )

    /*
      Archidekt's own count can lag its listing, which would make the difference
      negative — and a negative would render as a warning about decks that do not
      exist.
    */
    const p4 = planDeckSync(['1', '2', '3', '4'], [], 2)
    check('a count that lags the listing never reports a negative', p4.hidden === 0, `hidden ${p4.hidden}`)
  }

  // ---------------------------------------------------------------- backup
  section('Backup and restore')

  {
    /*
      The remote, faked in memory.

      `RemoteStore` was kept to four operations precisely so this could be small
      enough to trust: it is a Buffer and a list, so what these checks exercise is
      the real save/restore logic rather than a second implementation of it. The
      parts a fake cannot cover — OAuth, resumable chunking, Drive's own error
      shapes — are covered by the pure checks below and by a live smoke test that
      skips loudly when no credentials are configured.
    */
    const fake = (): {
      store: RemoteStore
      writes: () => number
      history: () => number
      corrupt: (payload: Buffer, sha?: string) => void
      restamp: (patch: Partial<BackupManifest>) => void
    } => {
      let current: { data: Buffer; manifest: BackupManifest | null } | null = null
      const history: { data: Buffer; manifest: BackupManifest | null }[] = []
      let writes = 0
      // Whatever the last upload actually was, so restore takes the same path the
      // real store would take rather than a path the test chose for it.
      let compressedRemote = true
      return {
        writes: () => writes,
        history: () => history.length,
        corrupt: (payload, sha) => {
          if (!current) return
          current = {
            data: payload,
            manifest: current.manifest
              ? { ...current.manifest, sha256: sha ?? current.manifest.sha256 }
              : null
          }
        },
        restamp: (patch) => {
          if (current?.manifest) current = { ...current, manifest: { ...current.manifest, ...patch } }
        },
        store: {
          label: () => 'FakeDrive',
          isCompressed: () => compressedRemote,
          stat: async () =>
            current === null ? null : { bytes: current.data.byteLength, manifest: current.manifest },
          put: async (path, manifest, onProgress) => {
            if (current) history.unshift(current)
            compressedRemote = path.endsWith('.gz')
            const data = readFileSync(path)
            current = { data, manifest }
            writes += 1
            onProgress(data.byteLength, data.byteLength)
          },
          get: async (target, onProgress) => {
            if (!current) throw new Error('nothing to get')
            writeFileSync(target, current.data)
            onProgress(current.data.byteLength, current.data.byteLength)
          },
          rotate: async (keep) => {
            const dropped = Math.max(0, history.length - keep)
            history.length = Math.min(history.length, keep)
            return dropped
          }
        }
      }
    }

    const quiet = (): void => {}

    /**
     * Every table, so a restore is judged on the whole database and not on the three
     * tables one feature happens to touch. A lost column somewhere unrelated is
     * exactly the failure a narrower fingerprint would wave through.
     */
    const wholeDb = (): string => {
      const tables = (
        getDb().all(
          "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
        ) as { name: string }[]
      ).map((row) => row.name)
      return JSON.stringify(
        tables.map((table) => [table, getDb().all(`SELECT * FROM ${table}`)])
      )
    }

    // ---- a snapshot round-trips
    const remote = fake()
    const before = wholeDb()
    const saved = await saveToRemote(remote.store, quiet)
    check('a backup writes a snapshot to the remote', saved.uploaded && remote.writes() === 1,
      `uploaded ${saved.uploaded}, writes ${remote.writes()}`)

    // Something the restore has to undo.
    getDb().run("INSERT INTO settings (key, value) VALUES ('backup.probe', 'dirt') " +
      'ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    check('and the local database really did change', wholeDb() !== before, 'no change to undo')

    await restoreFromRemote(remote.store, quiet)
    check('restoring puts the whole database back, every table of it',
      wholeDb() === before, 'the restored database differs')

    /*
      ---- the snapshot travels compressed

      Two things worth asserting separately: that the payload really is smaller (a
      compression step that quietly did nothing would otherwise pass every other
      check), and that what comes back out is byte-identical to what went in. The
      round-trip above already proves the restore path end to end; this proves it is
      doing so through gzip.
    */
    {
      const taken = await snapshot()
      const packed = await compress(taken.path)
      check('the uploaded snapshot is materially smaller than the database',
        packed.bytes < taken.bytes * 0.8,
        `${taken.bytes} -> ${packed.bytes} bytes`)

      const roundTripped = join(dir, 'backup-tmp', 'unpacked-check.db')
      await decompress(packed.path, roundTripped)
      check('and unpacks to exactly the database that was packed',
        readFileSync(roundTripped).equals(readFileSync(taken.path)),
        'the unpacked file differs from the original')

      check('the remote holds the compressed form',
        (await remote.store.isCompressed()) === true, 'the remote is not compressed')

      rmSync(taken.path, { force: true })
      rmSync(packed.path, { force: true })
      rmSync(roundTripped, { force: true })
    }

    /*
      ---- nothing written, nothing sent

      Tested on its own remote, and after a save rather than after a restore: a
      restore replaces the database file outright, so the very next save has a file
      it has never sent and uploading it is correct. What must be skipped is the
      reflexive second Ctrl+S, and that is what this asserts.
    */
    {
      const idle = fake()
      const first = await saveToRemote(idle.store, quiet, null)
      // The marker the app keeps, handed back in as the handler does.
      const second = await saveToRemote(idle.store, quiet, first.at)
      check('a second backup with nothing written since sends nothing',
        first.uploaded && !second.uploaded && idle.writes() === 1,
        `first ${first.uploaded}, second ${second.uploaded}, writes ${idle.writes()}`)

      // And a write in between is noticed. The timestamp goes back far enough that
      // the comparison cannot turn on the filesystem's mtime resolution.
      getDb().run(
        "INSERT INTO settings (key, value) VALUES ('backup.probe', 'touched') " +
          'ON CONFLICT(key) DO UPDATE SET value = excluded.value'
      )
      const third = await saveToRemote(idle.store, quiet, '2000-01-01T00:00:00.000Z')
      check('but a backup after a write does send',
        third.uploaded && idle.writes() === 2,
        `uploaded ${third.uploaded}, writes ${idle.writes()}`)
      check('and the write is what the skip test itself reports',
        localTouchedSince('2000-01-01T00:00:00.000Z') &&
          !localTouchedSince('2999-01-01T00:00:00.000Z'),
        'the mtime test does not distinguish past from future')
      getDb().run("DELETE FROM settings WHERE key = 'backup.probe'")
    }

    // ---- the safety copy
    const copies = readdirSync(dir).filter(
      (name) => name.startsWith('before-restore-') && name.endsWith('.db')
    )
    check('a copy of the local database is kept before it is replaced',
      copies.length >= 1, `${copies.length} copies`)
    check('and that copy is itself a usable database',
      copies.length > 0 && verifySnapshot(join(dir, copies[0])).ok,
      copies.length ? JSON.stringify(verifySnapshot(join(dir, copies[0]))) : 'none')

    /**
     * The fingerprint, or why it could not be taken.
     *
     * A refused restore must leave the database not merely equal but *readable*, and
     * the two are different claims: sabotaging the order so the file is replaced
     * before it is checked left a garbage file in place, and a bare `wholeDb()` then
     * threw inside the driver and took the whole run down. A crash is a signal but
     * not an answer — it names no check. Returning the failure as a value makes the
     * assertion below report it by name, which is what a guard this important
     * deserves.
     */
    const readableWholeDb = (): string => {
      try {
        return wholeDb()
      } catch (err) {
        return `UNREADABLE: ${(err as Error).message}`
      }
    }

    /*
      ---- a download whose checksum is wrong is refused

      The payload is a perfectly good database — the current snapshot, in fact — and
      only the recorded hash is wrong. An unreadable payload would not test this:
      the integrity check would refuse it and the checksum guard could be deleted
      with every check still passing, which is exactly what the first version of
      this check did.
    */
    const intact = readableWholeDb()
    {
      const good = await snapshot()
      const validPayload = readFileSync(good.path)
      remote.corrupt(validPayload, 'f'.repeat(64))
      let rejected = ''
      try {
        await restoreFromRemote(remote.store, quiet)
      } catch (err) {
        rejected = (err as Error).message
      }
      check('a valid database with the wrong checksum recorded is still refused',
        rejected.length > 0, rejected || 'it was accepted')
      check('and that refusal leaves the local database readable and unchanged',
        readableWholeDb() === intact, readableWholeDb().slice(0, 60))
    }

    remote.corrupt(Buffer.from('not a database at all'))
    let refused = ''
    try {
      await restoreFromRemote(remote.store, quiet)
    } catch (err) {
      refused = (err as Error).message
    }
    check('a download that does not match its checksum is refused',
      refused.length > 0, refused || 'it was accepted')
    check('and the local database is untouched by the attempt',
      readableWholeDb() === intact, readableWholeDb().slice(0, 60))

    // ---- garbage that hashes correctly is still refused, by SQLite this time
    const garbage = Buffer.concat([Buffer.from('SQLite format 3'), Buffer.from([0]), Buffer.from('and then lies')])
    remote.corrupt(garbage, createHash('sha256').update(garbage).digest('hex'))
    refused = ''
    try {
      await restoreFromRemote(remote.store, quiet)
    } catch (err) {
      refused = (err as Error).message
    }
    check('a payload with a correct checksum but no database in it is refused',
      refused.length > 0, refused || 'it was accepted')
    check('and the local database is still untouched',
      readableWholeDb() === intact, readableWholeDb().slice(0, 60))

    // ---- a snapshot from a newer app is refused
    const fresh = fake()
    await saveToRemote(fresh.store, quiet)
    fresh.restamp({ schemaVersion: schemaVersion() + 1 })
    refused = ''
    try {
      await restoreFromRemote(fresh.store, quiet)
    } catch (err) {
      refused = (err as Error).message
    }
    check('a backup from a newer version of the app is refused, not migrated backwards',
      refused.includes(String(schemaVersion() + 1)), refused || 'it was accepted')

    // ---- rotation
    const rotating = fake()
    for (let round = 0; round < HISTORY_KEPT + 3; round += 1) {
      // A different database each round, or the hash check would skip the upload
      // and there would be nothing to rotate.
      getDb().run(
        "INSERT INTO settings (key, value) VALUES ('backup.probe', ?) " +
          'ON CONFLICT(key) DO UPDATE SET value = excluded.value',
        [`round-${round}`]
      )
      // Null, so the skip never applies and every round really uploads.
      await saveToRemote(rotating.store, quiet, null)
    }
    check(`the remote keeps ${HISTORY_KEPT} previous snapshots and no more`,
      rotating.history() === HISTORY_KEPT, `${rotating.history()} kept`)
    getDb().run("DELETE FROM settings WHERE key = 'backup.probe'")
  }

  // ---------------------------------------------------------------- logging
  section('Logging')

  {
    /*
      The log exists to be shared, which makes a leaked credential the failure that
      matters. Redaction is therefore part of the writer rather than a rule to remember
      at each call site, and this is the check that proves it.
    */
    const dangerous = [
      'client secret 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 rejected',
      'stored value enc:AQAAANCMnd8BFdERjHoAwE/Cl+sBAAAA now unreadable',
      'plain:c2VjcmV0LXZhbHVlLWhlcmU= was written on a keyring-less box',
      'request failed with Authorization: Bearer ya29.a0AfB_byC-not-a-real-token',
      'refresh 1//0gLongRefreshTokenValueHere failed'
    ].join(' | ')
    const cleaned = redact(dangerous)

    check('a Google client secret never reaches the log',
      !cleaned.includes('GOCSPX-jcdSy'), cleaned)
    check('nor a sealed settings value',
      !cleaned.includes('AQAAANCMnd8') && !cleaned.includes('c2VjcmV0'), cleaned)
    check('nor a bearer token, however it is spelled',
      !/ya29\.[A-Za-z0-9]/.test(cleaned) && !/Bearer\s+[A-Za-z0-9]/.test(cleaned), cleaned)
    check('nor a refresh token', !cleaned.includes('1//0gLong'), cleaned)
    check('and what is left still says what happened',
      cleaned.includes('rejected') &&
        cleaned.includes('request failed') &&
        cleaned.includes('keyring-less'),
      'redaction removed the message along with the secret')
    console.log(`        → ${cleaned.slice(0, 96)}…`)

    /*
      The flag name, pinned.

      `--debug` was the first choice and it stops the app launching: Node claims the name
      and Electron exits with DEP0062 before any of this code runs. Nothing in a unit test
      can observe that — only starting the app can — so what is asserted here is the rule
      learned from it: our flag is not one of the names something else owns.
    */
    check('the debug flag is recognised',
      parseDebugFlag(['electron', '.', '--verbose']) &&
        parseDebugFlag(['electron', '.', '--debug-mode']),
      'the documented flag is not accepted')
    check('an ordinary run is not verbose',
      !parseDebugFlag(['electron', '.']) && !parseDebugFlag(['electron', '.', '--user-data-dir=x']))
    check('and none of our flags is a name Node or Electron already claims',
      DEBUG_FLAGS.every((flag) => !RESERVED_FLAGS.includes(flag)),
      `${DEBUG_FLAGS.filter((f) => RESERVED_FLAGS.includes(f)).join(', ')} is reserved`)
    /*
      The fabricated update, and the one thing about it that matters.

      `--fake-update` exists so the update dialog can be looked at without waiting for a
      release — the dialog only appears in `auto` mode, which only exists in a packaged
      install, so without a seam the path that matters is again the one nothing can
      exercise. What keeps that acceptable is that it cannot fire in anything shipped,
      and that is what this asserts.
    */
    check('a fabricated update is ignored in a packaged build, whatever the flag says',
      parseFakeUpdate(['electron', '.', '--fake-update=9.9.9'], true) === null,
      'a test seam would have been live in a release')
    check('and is honoured in a development one',
      parseFakeUpdate(['electron', '.', '--fake-update=0.9.9'], false) === '0.9.9',
      'the flag does nothing where it is meant to work')
    check('a malformed version is refused rather than shown',
      parseFakeUpdate(['electron', '.', '--fake-update=nightly'], false) === null &&
        parseFakeUpdate(['electron', '.', '--fake-update='], false) === null)
    check('and no flag means no fabricated update',
      parseFakeUpdate(['electron', '.'], false) === null)

    check('--debug in particular is not accepted, because it prevents startup',
      !parseDebugFlag(['electron', '.', '--debug']),
      'the app would refuse to launch with the flag it documents')

    // ---- it writes, and it says which level and when
    logError('probe', 'something went wrong')
    logInfo('probe', 'and something merely happened')
    const written = readFileSync(logFile(), 'utf8')
    check('errors and info reach the file',
      written.includes('ERROR [probe] something went wrong') &&
        written.includes('INFO  [probe] and something merely happened'),
      written.split('\n').slice(-3).join(' / '))
    check('every line is timestamped',
      written
        .split('\n')
        .filter((line) => line.length > 0)
        .every((line) => /^\d{4}-\d{2}-\d{2}T[\d:.]+Z /.test(line)),
      'a line has no timestamp')

    // ---- debug output is off unless asked for
    const beforeDebug = readFileSync(logFile(), 'utf8').length
    logDebug('probe', 'chatter nobody asked for')
    check('debug lines are silent without --debug',
      readFileSync(logFile(), 'utf8').length === beforeDebug,
      'a debug line was written anyway')
    setVerboseLogging(true)
    logDebug('probe', 'chatter that was asked for')
    check('and appear once it is on',
      readFileSync(logFile(), 'utf8').includes('chatter that was asked for'))
    setVerboseLogging(false)

    /*
      ---- and it cannot grow without bound

      A log that fills a disk is a bug of its own. One megabyte, then a single rollover,
      so two files is the entire footprint however long the app runs.
    */
    writeFileSync(logFile(), 'x'.repeat(1024 * 1024 + 10))
    logInfo('probe', 'the line that tips it over')
    const rolled = `${logFile()}.old`
    check('the log rolls over at its cap',
      existsSync(rolled) && statSync(logFile()).size < 4096,
      `old ${existsSync(rolled)}, new ${statSync(logFile()).size} bytes`)
    check('and keeps exactly one old file, never a third',
      readdirSync(logDir()).filter((name) => name.startsWith('main.log')).length === 2,
      readdirSync(logDir()).join(', '))
  }

  // ---------------------------------------------------------------- updates
  {
    /*
      Which build may update itself.

      The whole feature hangs off this: `auto` in a portable build downloads an
      installer it can never install, and `auto` in a dev build throws on the first
      call because there is no app-update.yml to read. Neither failure is visible from
      reading the code, and both are one boolean away.
    */
    check('an installed build updates itself',
      updateMode({ packaged: true, portableDir: undefined }) === 'auto',
      updateMode({ packaged: true, portableDir: undefined }))
    check('a portable build only reports, because nothing can be installed over it',
      updateMode({ packaged: true, portableDir: 'C:/somewhere' }) === 'notify',
      updateMode({ packaged: true, portableDir: 'C:/somewhere' }))
    check('and an empty portable path is not a portable build',
      updateMode({ packaged: true, portableDir: '' }) === 'auto',
      updateMode({ packaged: true, portableDir: '' }))
    check('running from source does nothing at all',
      updateMode({ packaged: false, portableDir: undefined }) === 'disabled',
      updateMode({ packaged: false, portableDir: undefined }))

    /*
      And whether a release is newer.

      Compared as numbers, because the string comparison that looks right stops
      offering updates at the tenth minor release -- '0.10.0' < '0.9.0' as text. A tag
      carries a `v` and the app's own version does not, so both spellings have to mean
      the same thing.
    */
    check('a later patch is newer', isNewerVersion('0.1.1', '0.1.0'))
    check('a v prefix on the tag makes no difference', isNewerVersion('v0.2.0', '0.1.9'))
    check('0.10.0 beats 0.9.0, which string comparison gets backwards',
      isNewerVersion('0.10.0', '0.9.0'))
    check('the same version is not newer', !isNewerVersion('0.1.0', '0.1.0'))
    check('an older version is not newer', !isNewerVersion('0.1.0', '0.2.0'))
    check('a shorter version is compared by segment, not by length',
      isNewerVersion('1.0', '0.9.9') && !isNewerVersion('1.0', '1.0.1'))
    /*
      Digging the updater out of a dynamic import.

      This is the bug that reached a release: `const { autoUpdater } = await import(...)`
      returned undefined in the packaged app, and the next line read `.checkForUpdates`
      off it. Nothing here could have caught it, because the only mode that runs that
      import is `auto`, and a development run is always `disabled`. So the logic moved
      somewhere testable, and these are the shapes it has to survive.
    */
    const realShape = { default: { autoUpdater: { checkForUpdates: () => null } } }
    check('the updater is found when it arrives only under default',
      pickAutoUpdater(realShape) !== null,
      'the shape electron-updater actually presents was not handled')
    check('and when it arrives as a named export',
      pickAutoUpdater({ autoUpdater: { checkForUpdates: () => null } }) !== null)
    check('a namespace with neither yields null, rather than something that fails later',
      pickAutoUpdater({}) === null && pickAutoUpdater(undefined) === null,
      'a missing updater was reported as present')

    /*
      And the platform rule the fix rests on, exercised for real rather than assumed.

      A fixture CommonJS module with electron-updater's exact export shape -- an arrow
      getter, which `cjs-module-lexer` does not recognise -- imported from a genuine ESM
      context in a child process. This is the check that would have caught the original
      bug: it asserts the named export is *absent* and that `default` carries it. If a
      future Node teaches the lexer this form, this fails and tells us the workaround has
      become unnecessary, rather than leaving it there forever.
    */
    {
      const fixture = join(dir, 'cjs-arrow-getter.cjs')
      writeFileSync(
        fixture,
        [
          'let made = null',
          'function build() { made = { checkForUpdates: () => null }; return made }',
          'Object.defineProperty(exports, "autoUpdater", {',
          '  enumerable: true,',
          '  get: () => { return made || build() }',
          '})',
          ''
        ].join('\n')
      )
      const script =
        `const m = await import(${JSON.stringify(pathToFileURL(fixture).href)});` +
        'console.log(JSON.stringify({' +
        '  named: typeof m.autoUpdater,' +
        '  viaDefault: typeof m.default?.autoUpdater' +
        '}))'
      const shape = JSON.parse(
        execFileSync(process.execPath, ['--input-type=module', '-e', script], {
          encoding: 'utf8'
        }).trim()
      ) as { named: string; viaDefault: string }
      check('a CJS arrow-getter export is invisible to the ESM named-export lexer',
        shape.named === 'undefined',
        `named export was ${shape.named} — the workaround may no longer be needed`)
      check('and the same export is reachable through default, which is what the fix uses',
        shape.viaDefault === 'object',
        `default gave ${shape.viaDefault}`)
      rmSync(fixture, { force: true })
    }

    /*
      The tripwire. The two checks above test the helper; this one tests that the app
      still goes through it, which is the part a careless revert would undo.
    */
    {
      const source = readFileSync(joinPath('src', 'main', 'services', 'updates.ts'), 'utf8')
      check('the updater is not destructured straight out of a dynamic import',
        !/const\s*\{\s*autoUpdater\s*\}\s*=\s*await import/.test(source),
        'updates.ts destructures autoUpdater again — that is the bug that shipped')
      check('and goes through the interop-safe accessor',
        source.includes('pickAutoUpdater('),
        'updates.ts no longer calls pickAutoUpdater')
    }

    /*
      Release notes arrive as HTML, and the dialog shows text.

      electron-updater's GitHub provider reads the releases feed, whose content is HTML,
      so the first packaged update put markup in front of the user. The obvious test for
      a converter — "no angle bracket survives" — is also passed by a function that
      deletes everything, so both halves are asserted: the tags are gone, the words are
      not.
    */
    {
      const feed = [
        '<h2>Highlights</h2>',
        '<p>Backups are smaller &amp; faster.</p>',
        '<ul>',
        '<li>Fixed the <code>Ctrl+S</code> dialog</li>',
        '<li>It&#39;s no longer 96&nbsp;MB</li>',
        '</ul>',
        '<p>See <a href="https://example.test">the notes</a>.<br>Thanks.</p>'
      ].join('')
      const text = notesToText(feed)
      check('no markup survives the conversion',
        !text.includes('<') && !text.includes('>'), text)
      check('nor an undecoded entity',
        !/&(amp|lt|gt|quot|nbsp|apos|#\d+);/i.test(text), text)
      check('and the words are all still there, which over-stripping would lose',
        ['Highlights', 'Backups are smaller & faster', 'Ctrl+S', 'the notes', 'Thanks']
          .every((phrase) => text.includes(phrase)),
        text)
      check('a list reads as a list',
        text.split('\n').filter((line) => line.startsWith('\u2022 ')).length === 2, text)
      check('and the list is not double-spaced, which is how it looked in the app',
        !/\n\n\u2022 /.test(text), JSON.stringify(text))
      check('while a real paragraph break survives',
        /Highlights\n\nBackups/.test(text), JSON.stringify(text))
      check('an apostrophe entity decodes to an apostrophe',
        text.includes("It's no longer 96 MB"), text)
      check('blocks are separated rather than run together',
        !/faster\.Fixed/.test(text) && !/dialogIt/.test(text), text)
      check('plain text passes through unharmed',
        notesToText('Just a line.') === 'Just a line.')
      check('and nothing arrives wrapped in blank lines',
        notesToText('<p>one</p>') === 'one', JSON.stringify(notesToText('<p>one</p>')))
      console.log('        \u2192 ' + JSON.stringify(text).slice(0, 116) + '…')
    }

    /*
      When the dialog goes up, as a function of the state.

      The case this exists for is the middle row: the dialog closes on Download so the
      progress bar is visible, and if a download in progress did not suppress the prompt,
      the next announcement — one arrives per progress event — would reopen the dialog on
      top of its own progress.
    */
    {
      const pending = { version: '0.2.0', notes: '', url: 'https://example.test' }
      check('an available update prompts',
        shouldPrompt({ available: pending, downloading: false, downloaded: false }))
      check('nothing available never prompts',
        !shouldPrompt({ available: null, downloading: false, downloaded: false }))
      check('a download in progress does not reopen the dialog over itself',
        !shouldPrompt({ available: pending, downloading: true, downloaded: false }),
        'the dialog would reappear on top of the progress it started')
      check('and a landed download prompts again, which is the install-or-not question',
        shouldPrompt({ available: pending, downloading: false, downloaded: true }),
        'the download would sit there with nobody asked whether to install it')
    }

    /*
      The four flags, as a tripwire on the file.

      Every one of these is a line in the log of the real 0.1.3 → 0.2.0 update, and none
      of them can be observed from a test: they are read by electron-updater inside a
      packaged install. What is checkable is that they are still said.
    */
    {
      const source = readFileSync(joinPath('src', 'main', 'services', 'updates.ts'), 'utf8')
      check('no blockmap is hunted for, because none is built',
        /autoUpdater\.disableDifferentialDownload\s*=\s*true/.test(source),
        'the updater logs a 404 on a .blockmap that was never going to exist')
      check('the web installer is declined out loud, as the warning asked',
        /autoUpdater\.disableWebInstaller\s*=\s*true/.test(source),
        'WARN disableWebInstaller is set to false')
      check('nothing installs on quit, so Later means later',
        /autoUpdater\.autoInstallOnAppQuit\s*=\s*false/.test(source),
        'choosing Later and closing the app would install the update anyway')
      check('and the download says it started before it waits for it',
        /state\.downloading = true[\s\S]{0,600}?announce\(\)[\s\S]{0,200}?await updater\(/
          .test(source),
        'the button would keep saying Download while 96 MB moved behind it')
    }

    /*
      The rehearsal, and the one thing that makes it acceptable.

      `--fake-update` now reports `auto` mode and simulates a transfer, which is a lot of
      pretending to have in a shipped file. All of it hangs off one variable, so what is
      asserted is that the variable has exactly one source — the flag parser that refuses
      to work in a packaged build — and that every rehearsed path is behind it.
    */
    {
      const source = readFileSync(joinPath('src', 'main', 'services', 'updates.ts'), 'utf8')
      const assignments = source.match(/^\s*pretending = .*$/gm) ?? []
      check('the rehearsal has exactly one source, and it is the flag parser',
        assignments.length === 1 && /pretending = faked/.test(assignments[0]),
        JSON.stringify(assignments))
      check('the fabricated mode is behind it, so a real build still reports its own',
        /pretending === null \? mode\(\) : 'auto'/.test(source),
        'updateState no longer asks whether it is pretending')
      check('and the rehearsed download and install are both gated on it',
        /if \(pretending !== null\) return rehearseDownload/.test(source) &&
          /export async function installUpdate[\s\S]{0,120}if \(pretending !== null\)/
            .test(source),
        'a rehearsed path is reachable without the flag')
    }

    /*
      And the click, from the other side: the dialog has to get out of the way.

      Awaiting the download inside the handler is what made it look inert — the modal sat
      there, unchanged, for the length of the transfer.
    */
    {
      const source = readFileSync(
        joinPath('src', 'renderer', 'components', 'UpdateDialog.tsx'), 'utf8')
      const handler = source
        .slice(source.indexOf('const download'), source.indexOf('const install'))
        // Comments out first: this one explains that it is deliberately not awaited, and
        // a check that reads the explanation instead of the code proves nothing.
        .replace(/\/\*[\s\S]*?\*\//g, '')
      check('the update dialog closes on Download rather than waiting on it',
        handler.includes('onClose()') && !handler.includes('await'),
        handler.replace(/\s+/g, ' ').slice(0, 140))
    }

    check('and nonsense never triggers an update prompt',
      !isNewerVersion('nightly', '0.1.0') && !isNewerVersion('', '0.1.0') &&
        !isNewerVersion('0.1.0', 'nightly'),
      'a malformed tag read as newer')
  }

  // ------------------------------------------------------- loopback and picker
  {
    /*
      The loopback server both browser flows depend on.

      Worth its own checks because the failure modes are invisible from the outside:
      a listener left behind after the user closes the tab, or a second request
      resolving a promise that was already answered. Both are testable here without
      Google, which is the whole reason the transport was split from the semantics.
    */
    const first = loopbackOnce({
      callbackPath: '/done',
      timeoutMs: 5000,
      onTimeout: () => new Error('timed out'),
      serve: (path) => (path === '/page' ? '<p>hello</p>' : null),
      done: () => '<p>thanks</p>'
    })
    const origin = await whenListening(first)
    check('the loopback server reports a usable local origin',
      /^http:\/\/127\.0\.0\.1:\d+$/.test(origin), origin)

    const served = await fetch(`${origin}/page`)
    const servedBody = await served.text()
    check('it serves the page it was given', servedBody.includes('hello'), servedBody.slice(0, 40))

    const ignored = await fetch(`${origin}/favicon.ico`)
    check('and answers anything else with no content, rather than treating it as the reply',
      ignored.status === 204, String(ignored.status))

    const answered = await fetch(`${origin}/done?id=abc&name=Cards`)
    const answeredBody = await answered.text()
    const landed = await first.landed
    check('the callback resolves with its query',
      landed.get('id') === 'abc' && landed.get('name') === 'Cards',
      landed.toString())
    check('and the browser is answered before the caller is told, so the page arrives',
      answeredBody.includes('thanks'), answeredBody.slice(0, 40))

    /*
      And it is gone. A server still listening after the flow finished is a port held
      for the life of the app and a second reply that could resolve nothing.
    */
    let stillUp = false
    try {
      await fetch(`${origin}/done`)
      stillUp = true
    } catch {
      stillUp = false
    }
    check('the server stops listening once it has landed', !stillUp, 'it is still accepting')
    /*
      Stopped explicitly as well, so a leak cannot take the run down with it. An open
      listener keeps Node's event loop alive: when this was sabotaged the check
      correctly noticed, and then the process never exited and the whole suite hung
      with no output. Catching a fault is not much use if catching it also silences
      the report.
    */
    first.stop()

    // ---- and it gives up rather than waiting forever
    const patient = loopbackOnce({
      callbackPath: '/done',
      timeoutMs: 150,
      onTimeout: () => new Error('nobody came'),
      serve: () => null,
      done: () => ''
    })
    await whenListening(patient)
    /*
      Raced against a deadline of its own, because the failure being guarded against
      is a promise that never settles. Awaiting it directly would hang this suite
      instead of failing it -- which is what happened when the timeout was removed on
      purpose: no output, no verdict, just a run that never ended.
    */
    const verdict = await Promise.race([
      patient.landed.then(() => 'it landed by itself').catch((err) => (err as Error).message),
      new Promise<string>((resolve) => setTimeout(() => resolve('never gave up'), 1200))
    ])
    patient.stop()
    check('a flow nobody completes times out instead of hanging',
      verdict === 'nobody came', verdict)
  }

  // ---------------------------------------------------------------- oauth
  {
    /*
      The OAuth pieces that are pure functions. What is worth asserting is not that
      they run but that they say the right thing: a challenge that is not the hash
      of its verifier makes the exchange fail, and a consent URL missing
      `access_type=offline` succeeds and then dies an hour later with no refresh
      token — the kind of bug that only shows up long after the code that caused it.
    */
    const { verifier, challenge } = pkcePair()
    const expected = createHash('sha256')
      .update(verifier)
      .digest('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '')
    check('the PKCE challenge really is the hash of its verifier',
      challenge === expected, `${challenge} vs ${expected}`)
    check('and the verifier is long enough to be worth hashing',
      verifier.length >= 43, `${verifier.length} chars`)

    const url = new URL(
      consentUrl({ clientId: 'abc.apps.googleusercontent.com', redirectUri: 'http://127.0.0.1:5555',
        challenge, state: 'xyz' })
    )
    check('the consent URL asks for offline access, or there is no refresh token',
      url.searchParams.get('access_type') === 'offline',
      String(url.searchParams.get('access_type'))
    )
    check('and re-consents, so reconnecting returns a refresh token again',
      url.searchParams.get('prompt') === 'consent',
      String(url.searchParams.get('prompt'))
    )
    check('and asks for nothing broader than the files this app creates',
      url.searchParams.get('scope') === DRIVE_SCOPE,
      String(url.searchParams.get('scope'))
    )
    check('and carries the state that ties the reply to this request',
      url.searchParams.get('state') === 'xyz' &&
        url.searchParams.get('code_challenge_method') === 'S256',
      `${url.searchParams.get('state')} / ${url.searchParams.get('code_challenge_method')}`
    )

    const back = parseCallback('/?code=4/abc&state=xyz')
    check('the loopback reply is read back out of the query',
      back.code === '4/abc' && back.state === 'xyz' && back.error === null,
      JSON.stringify(back)
    )
    const denied = parseCallback('/?error=access_denied&state=xyz')
    check('and a refusal arrives as an error rather than as a missing code',
      denied.error === 'access_denied' && denied.code === null,
      JSON.stringify(denied)
    )
  }

  section('Persistence')
  /*
    `getDb()` rather than the `db` captured at the top of this run. A restore closes
    the database and leaves it closed — deliberately, since the app relaunches — so
    from the backup section onwards that captured facade wraps a closed handle and
    every call on it throws inside the driver. This is the harness catching the same
    stale-handle hazard the real code has to respect.
  */
  const countBefore = (getDb().get('SELECT COUNT(*) AS c FROM collection_items') as { c: number }).c
  closeDb()
  setDataDir(dir)
  const reopened = getDb()
  const countAfter = (reopened.get('SELECT COUNT(*) AS c FROM collection_items') as { c: number }).c
  check('data survives a close and reopen', countBefore === countAfter, `${countBefore} vs ${countAfter}`)
  check('settings survive a reopen', getSettings().archidektUsername === 'tester')

  closeDb()
  rmSync(dir, { recursive: true, force: true })

  console.log(`\n${'='.repeat(52)}`)
  console.log(
    `${passed} passed, ${failed} failed${skipped ? `, ${skipped} skipped` : ''}`
  )
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
