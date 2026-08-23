import { getDb, nowIso, transaction } from '../db/connection.js'
import type {
  BoosterChance,
  BoosterOdds,
  BoosterProduct,
  BoosterSetInfo,
  ProgressEvent
} from '@shared/types'
import { t } from '@shared/i18n/index'
import type { TranslationKey } from '@shared/types'
import { getLocale } from '../db/repos/settings.js'

/** Localised message, resolved at throw time from the stored locale. */
function tr(key: TranslationKey, vars?: Record<string, string | number>): string {
  return t(getLocale(), key, vars)
}

/**
 * The chance of pulling a card from a booster, computed from MTGJSON.
 *
 * Scryfall knows whether a card appears in boosters at all; it does not model
 * sealed products or sheet weights. MTGJSON does: for each set it publishes named
 * booster types, each a weighted list of configurations, each configuration
 * drawing a number of picks from named sheets, and each sheet a card-to-weight
 * map. Cards carry `identifiers.scryfallId`, which is how this joins to ours.
 *
 * Per-set files are a few MB of JSON — about 1.3MB on the wire, since MTGJSON's
 * CDN serves them brotli-compressed — so they are fetched **on demand**, distilled
 * into the `booster_odds` table, and discarded. Nothing raw is stored.
 *
 * MTGJSON keys its sheets on `identifiers.scryfallId`, which is always **the
 * English printing's** id. A French card therefore matches nothing on its own, so
 * every read resolves through the English sibling — see `englishSiblingOf`. Before
 * that, every non-English card in a fetched set read "not in this booster", which
 * was simply false.
 *
 * For a card of weight `w` on a sheet of total weight `T`, drawn `picks` times:
 *
 *   P(absent from that sheet)  = (1 − w/T)^picks
 *   P(present | configuration) = 1 − Π over sheets P(absent)
 *   P(present)                 = Σ (configWeight / totalWeight) × P(present | cfg)
 *   expected copies            = Σ (configWeight / totalWeight) × Σ picks × w/T
 *
 * **Accumulated separately for foil and nonfoil**, because every sheet carries an
 * explicit `foil` flag and the two differ enormously. A HOB play booster draws
 * from `common`, `wildcard` and `rareMythic` (nonfoil) as well as `foil` and
 * `foilLand` (foil); Thranduil #167 sits on both sides at 1.75% nonfoil and
 * 0.125% foil. Blending them — as this did at first — overstates a foil copy
 * roughly fifteenfold, which is exactly the case a collector cares about.
 *
 * The model treats each pick as an independent weighted draw, which is what a
 * weighted sheet expresses. Sheets flagged `balanceColors` deliberately skew the
 * draw to even out colours, so any card on one is marked approximate rather than
 * being presented as exact.
 */

const MTGJSON = 'https://mtgjson.com/api/v5'

export type ProgressSink = (event: ProgressEvent) => void

interface MtgjsonSheet {
  cards: Record<string, number>
  totalWeight?: number
  balanceColors?: boolean
  foil?: boolean
}

interface MtgjsonBooster {
  name?: string
  boosters: { contents: Record<string, number>; weight: number }[]
  boostersTotalWeight?: number
  sheets: Record<string, MtgjsonSheet>
}

interface MtgjsonSealedProduct {
  name: string
  category?: string
  subtype?: string
  contents?: Record<string, unknown[]>
}

interface MtgjsonSet {
  data?: {
    booster?: Record<string, MtgjsonBooster>
    sealedProduct?: MtgjsonSealedProduct[]
    cards?: { uuid: string; identifiers?: { scryfallId?: string } }[]
  }
}

/** Sheet weights are per card; the total is either given or the sum of them. */
function sheetTotal(sheet: MtgjsonSheet): number {
  if (sheet.totalWeight && sheet.totalWeight > 0) return sheet.totalWeight
  return Object.values(sheet.cards).reduce((sum, weight) => sum + weight, 0)
}

interface CardOdds {
  probability: number
  expected: number
  approximate: boolean
}

interface Computed {
  /**
   * Keyed `${uuid}|${foil ? 1 : 0}` — uuid because that is what sheets
   * reference, finish because a card's foil and nonfoil chances are different
   * numbers drawn from different sheets.
   */
  byUuid: Map<string, CardOdds>
  /** Σ picks per pack, weighted across configurations — the invariant to check. */
  expectedPicks: number
}

/** The composite key used throughout: one card in one finish. */
export function oddsKey(uuid: string, foil: boolean): string {
  return `${uuid}|${foil ? 1 : 0}`
}

/**
 * Probability and expected count for every card in one booster type.
 *
 * Exported so `verify` can assert the arithmetic without a network call: summed
 * over every card, `expected` must equal `expectedPicks`, because each pick yields
 * exactly one card.
 */
export function computeBoosterOdds(booster: MtgjsonBooster): Computed {
  const configs = booster.boosters ?? []
  const totalWeight =
    booster.boostersTotalWeight ?? configs.reduce((sum, c) => sum + (c.weight ?? 0), 0)
  const byUuid = new Map<string, { probability: number; expected: number; approximate: boolean }>()
  let expectedPicks = 0
  if (!configs.length || totalWeight <= 0) return { byUuid, expectedPicks }

  // Precompute each sheet's total once rather than per card per configuration.
  const totals = new Map<string, number>()
  for (const [name, sheet] of Object.entries(booster.sheets ?? {})) {
    totals.set(name, sheetTotal(sheet))
  }

  for (const config of configs) {
    const share = (config.weight ?? 0) / totalWeight
    if (share <= 0) continue
    const entries = Object.entries(config.contents ?? {})
    expectedPicks += share * entries.reduce((sum, [, picks]) => sum + picks, 0)

    // Cards can appear on more than one sheet in the same pack, so "absent" is
    // accumulated across sheets before being turned into a probability — but
    // only across sheets of the *same* finish, since pulling the nonfoil does
    // not get you the foil.
    const absent = new Map<string, number>()
    const seen = new Set<string>()
    for (const [sheetName, picks] of entries) {
      const sheet = booster.sheets?.[sheetName]
      const total = totals.get(sheetName) ?? 0
      if (!sheet || total <= 0 || picks <= 0) continue
      const foil = sheet.foil === true
      for (const [uuid, weight] of Object.entries(sheet.cards)) {
        const key = oddsKey(uuid, foil)
        const chance = weight / total
        absent.set(key, (absent.get(key) ?? 1) * Math.pow(1 - chance, picks))
        seen.add(key)
        const entry = byUuid.get(key) ?? { probability: 0, expected: 0, approximate: false }
        entry.expected += share * picks * chance
        if (sheet.balanceColors) entry.approximate = true
        byUuid.set(key, entry)
      }
    }
    for (const key of seen) {
      const entry = byUuid.get(key)!
      entry.probability += share * (1 - (absent.get(key) ?? 1))
    }
  }

  return { byUuid, expectedPicks }
}

/** Sealed products worth naming: the ones that contain boosters. */
function summariseProducts(products: MtgjsonSealedProduct[]): BoosterProduct[] {
  const summary: BoosterProduct[] = []
  for (const product of products) {
    const packs = (product.contents?.pack ?? []) as { code?: string }[]
    const sealed = (product.contents?.sealed ?? []) as { count?: number; name?: string }[]
    // A product either names booster packs directly, or contains other products
    // that do. Only the direct case can be turned into odds honestly.
    const boosterCodes = packs.map((p) => p.code).filter((c): c is string => !!c)
    if (!boosterCodes.length) continue
    const count =
      sealed.reduce((sum, s) => sum + (s.count ?? 0), 0) || packs.length || 1
    summary.push({
      name: product.name,
      category: product.category ?? null,
      subtype: product.subtype ?? null,
      booster: boosterCodes[0],
      boosterCount: count
    })
  }
  return summary
}

/**
 * Fetches one set's booster data and stores the distilled odds.
 *
 * Idempotent: calling it again replaces that set's rows.
 */
export async function loadBoosterOdds(
  setCode: string,
  onProgress: ProgressSink
): Promise<{ boosters: number; cards: number; noData?: boolean }> {
  const code = setCode.toUpperCase()
  const phase = `Booster odds for ${code}`
  onProgress({ job: 'booster-odds', phase, done: 0, total: 3 })

  const response = await fetch(`${MTGJSON}/${code}.json`, {
    headers: { 'User-Agent': 'Matomeru/1.0 (local MTG collection manager)' }
  })
  if (!response.ok) {
    onProgress({ job: 'booster-odds', phase, done: 3, total: 3, finished: true })
    // A 404 is MTGJSON's answer, not a transport hiccup: this set has no booster
    // file and never will. Record that so it stops being offered and stops
    // counting as something to retry — token sets and some precon-only products
    // are simply not there. Anything else (a 5xx, a timeout) is worth retrying,
    // so it throws.
    if (response.status === 404) {
      markSetHasNoData(code)
      return { boosters: 0, cards: 0, noData: true }
    }
    throw new Error(tr('err.mtgjsonNoData', { set: code, status: response.status }))
  }
  onProgress({ job: 'booster-odds', phase, done: 1, total: 3, message: 'Reading' })

  const parsed = (await response.json()) as MtgjsonSet
  const boosters = parsed.data?.booster ?? {}
  onProgress({ job: 'booster-odds', phase, done: 2, total: 3, message: 'Computing' })

  // uuid → scryfall id. Sheets can reference cards from other sets (bonus sheets,
  // The List), which simply do not map — they still count towards a sheet's total,
  // which is why the denominator uses the sheet's own weights.
  const scryfallByUuid = new Map<string, string>()
  for (const card of parsed.data?.cards ?? []) {
    const id = card.identifiers?.scryfallId
    if (id) scryfallByUuid.set(card.uuid, id)
  }

  const names: BoosterSetInfo['boosters'] = []
  const rows: {
    booster: string
    scryfall_id: string
    foil: number
    probability: number
    expected: number
    approximate: number
  }[] = []

  for (const [name, booster] of Object.entries(boosters)) {
    const { byUuid, expectedPicks } = computeBoosterOdds(booster)
    if (!byUuid.size) continue

    // How much of this booster we can actually name. Sheets reference cards from
    // other sets, whose uuids are absent from this set's card list and so carry
    // no Scryfall id to join on — so the odds we store cover only part of the
    // pack. Measured in picks rather than card count, since one slot on a
    // 40-card box-topper sheet matters far more than one of 300 commons.
    let namedExpected = 0
    for (const [key, odds] of byUuid) {
      if (scryfallByUuid.get(key.split('|')[0])) namedExpected += odds.expected
    }

    names.push({
      code: name,
      name: booster.name ?? name,
      cardsPerPack: Math.round(expectedPicks * 10) / 10,
      coverage: expectedPicks > 0 ? namedExpected / expectedPicks : 0
    })
    for (const [key, odds] of byUuid) {
      const [uuid, foil] = key.split('|')
      const scryfallId = scryfallByUuid.get(uuid)
      if (!scryfallId) continue
      rows.push({
        booster: name,
        scryfall_id: scryfallId,
        foil: Number(foil),
        probability: odds.probability,
        expected: odds.expected,
        approximate: odds.approximate ? 1 : 0
      })
    }
  }

  const products = summariseProducts(parsed.data?.sealedProduct ?? [])

  transaction((db) => {
    db.run('DELETE FROM booster_odds WHERE set_code = ?', [code])
    db.run('DELETE FROM booster_sets WHERE set_code = ?', [code])
    db.run(
      'INSERT INTO booster_sets (set_code, fetched_at, boosters, products) VALUES (?,?,?,?)',
      [code, nowIso(), JSON.stringify(names), JSON.stringify(products)]
    )
    for (const row of rows) {
      db.run(
        `INSERT INTO booster_odds
           (set_code, booster, scryfall_id, foil, probability, expected, approximate)
         VALUES (?,?,?,?,?,?,?)
         ON CONFLICT(set_code, booster, scryfall_id, foil) DO UPDATE SET
           probability = excluded.probability,
           expected = excluded.expected,
           approximate = excluded.approximate`,
        [
          code,
          row.booster,
          row.scryfall_id,
          row.foil,
          row.probability,
          row.expected,
          row.approximate
        ]
      )
    }
  })

  onProgress({ job: 'booster-odds', phase, done: 3, total: 3, finished: true })
  return { boosters: names.length, cards: rows.length }
}

/**
 * The sets worth fetching booster data for: ones you own cards from, where at
 * least one of those cards actually comes in a booster.
 *
 * Skipping the rest is the point. A collection is mostly Commander precons —
 * `tmc`, `lcc`, `soc` and friends contain no booster-eligible cards at all — and
 * `in_boosters` already answers those without a download. Fetching all 46 sets a
 * collection touches would spend most of its bandwidth confirming a "no" that is
 * already known.
 *
 * Counts both real collection rows and cards sleeved in decks, because both are
 * cards you hold.
 */
export function collectionBoosterSets(): { set_code: string; cards: number; fetched: boolean }[] {
  return getDb().all(
    `WITH owned AS (
       SELECT ci.scryfall_id FROM collection_items ci WHERE ci.quantity > 0
       UNION
       SELECT COALESCE(o.scryfall_id, dc.scryfall_id)
       FROM deck_cards dc
       LEFT JOIN deck_card_overrides o
              ON o.deck_id = dc.deck_id AND o.oracle_id = dc.oracle_id
       WHERE COALESCE(o.scryfall_id, dc.scryfall_id) IS NOT NULL
     )
     SELECT UPPER(p.set_code) AS set_code,
            COUNT(*) AS cards,
            EXISTS (SELECT 1 FROM booster_sets bs WHERE bs.set_code = UPPER(p.set_code)) AS fetched
     FROM owned
     JOIN printings p ON p.scryfall_id = owned.scryfall_id
     WHERE p.in_boosters = 1
     GROUP BY UPPER(p.set_code)
     ORDER BY cards DESC`
  ) as { set_code: string; cards: number; fetched: boolean }[]
}

/**
 * Fetches booster data for every set in your collection that needs it.
 *
 * One set at a time, sequentially: these are multi-megabyte files from someone
 * else's CDN, and a burst of parallel requests is neither faster in practice nor
 * polite. Already-fetched sets are skipped, so running it again after adding a
 * deck only downloads what is new, and a set MTGJSON has no data for is counted
 * rather than aborting the run.
 */
export async function loadBoosterOddsForCollection(
  onProgress: ProgressSink,
  refetch = false
): Promise<{ sets: number; skipped: number; failed: string[]; noData: string[] }> {
  const wanted = collectionBoosterSets().filter((s) => refetch || !s.fetched)
  const skipped = collectionBoosterSets().length - wanted.length
  // Two different outcomes, kept apart because only one is worth retrying: a set
  // MTGJSON has no file for is settled, a set that failed to download is not.
  const failed: string[] = []
  const noData: string[] = []
  const phase = 'Booster odds for your collection'

  onProgress({ job: 'booster-odds', phase, done: 0, total: wanted.length })
  let done = 0
  for (const set of wanted) {
    try {
      const result = await loadBoosterOdds(set.set_code, () => {
        // Swallow the per-set progress: one bar for the whole run reads better
        // than a bar that restarts fifteen times.
      })
      if (result.noData) noData.push(set.set_code)
    } catch {
      failed.push(set.set_code)
    }
    done += 1
    onProgress({ job: 'booster-odds', phase, done, total: wanted.length, message: set.set_code })
  }
  onProgress({ job: 'booster-odds', phase, done: wanted.length, total: wanted.length, finished: true })
  return {
    sets: wanted.length - failed.length - noData.length,
    skipped,
    failed,
    noData
  }
}

/**
 * Records that MTGJSON has no booster file for a set.
 *
 * Stored as an ordinary `booster_sets` row with no boosters, which every reader
 * already handles: `boosterSetInfo` returns it, `boosterOddsFor` reports
 * `fetched: true` with an empty list, and the panel says so. Without this the set
 * stayed "never fetched" forever and was offered on every run.
 */
function markSetHasNoData(code: string): void {
  transaction((db) => {
    db.run('DELETE FROM booster_sets WHERE set_code = ?', [code])
    db.run(
      'INSERT INTO booster_sets (set_code, fetched_at, boosters, products) VALUES (?,?,?,?)',
      [code, nowIso(), '[]', '[]']
    )
  })
}

/**
 * The English printing of the same card, which is what MTGJSON's ids point at.
 *
 * Matched on set and collector number — the pair that identifies one physical
 * card across languages, and the same route `siblingPrice` takes to price a
 * translated printing. Returns the id unchanged for a printing that is already
 * English, or when no English sibling is cached yet.
 */
function englishSiblingOf(scryfallId: string): { id: string; substituted: boolean } {
  const row = getDb().get(
    `SELECT e.scryfall_id AS id
     FROM printings p
     JOIN printings e
       ON e.set_code = p.set_code
      AND e.collector_number = p.collector_number
      AND e.lang = 'en'
     WHERE p.scryfall_id = ? AND p.lang != 'en'
     LIMIT 1`,
    [scryfallId]
  ) as { id: string } | undefined
  return row ? { id: row.id, substituted: true } : { id: scryfallId, substituted: false }
}

/** Whether Scryfall says this card comes in boosters at all. */
function inBoosters(scryfallId: string): boolean | null {
  const row = getDb().get('SELECT in_boosters FROM printings WHERE scryfall_id = ?', [
    scryfallId
  ]) as { in_boosters: number | null } | undefined
  if (!row || row.in_boosters === null) return null
  return row.in_boosters === 1
}

/** What we know about a set's boosters, or null if it has never been fetched. */
export function boosterSetInfo(setCode: string): BoosterSetInfo | null {
  const row = getDb().get(
    'SELECT set_code, fetched_at, boosters, products FROM booster_sets WHERE set_code = ?',
    [setCode.toUpperCase()]
  ) as { set_code: string; fetched_at: string; boosters: string; products: string } | undefined
  if (!row) return null
  return {
    set_code: row.set_code,
    fetched_at: row.fetched_at,
    boosters: JSON.parse(row.boosters) as BoosterSetInfo['boosters'],
    products: JSON.parse(row.products) as BoosterProduct[]
  }
}

/** The odds for one printing, plus what its set's boosters are called. */
export function boosterOddsFor(scryfallId: string, setCode: string): BoosterOdds {
  const present = inBoosters(scryfallId)
  const info = boosterSetInfo(setCode)
  // MTGJSON's sheets name the English printing, so a translated card has to be
  // looked up through it or it matches nothing at all.
  const { id: lookupId, substituted } = englishSiblingOf(scryfallId)

  if (!info) {
    return {
      fetched: false,
      in_boosters: present,
      set_code: setCode.toUpperCase(),
      boosters: [],
      products: [],
      via_english: false
    }
  }

  const rows = getDb().all(
    `SELECT booster, foil, probability, expected, approximate
     FROM booster_odds WHERE set_code = ? AND scryfall_id = ?`,
    [setCode.toUpperCase(), lookupId]
  ) as {
    booster: string
    foil: number
    probability: number
    expected: number
    approximate: number
  }[]

  // Which finishes this printing is even sold in. A foil-only surge printing has
  // no nonfoil version, and saying "0%" there would imply one exists that you
  // simply never hit.
  const sold = printingFinishes(scryfallId)

  const byKey = new Map(rows.map((r) => [`${r.booster}|${r.foil}`, r]))
  const chanceFor = (boosterCode: string, foil: boolean): BoosterChance | null => {
    if (!sold.has(foil ? 'foil' : 'nonfoil')) return null
    const row = byKey.get(`${boosterCode}|${foil ? 1 : 0}`)
    // No row means the card is on none of this booster's sheets in that finish,
    // which is a real answer — "not in this booster" — not a missing measurement.
    return {
      probability: row ? row.probability : 0,
      expected: row ? row.expected : 0,
      approximate: row ? row.approximate === 1 : false
    }
  }

  return {
    fetched: true,
    in_boosters: present,
    set_code: info.set_code,
    products: info.products,
    // Only worth saying when it actually changed the answer.
    via_english: substituted && rows.length > 0,
    boosters: info.boosters.map((booster) => ({
      code: booster.code,
      name: booster.name,
      cardsPerPack: booster.cardsPerPack,
      // Data stored before coverage was recorded has none; treat it as complete
      // rather than annotating every row of an older cache.
      coverage: booster.coverage ?? 1,
      nonfoil: chanceFor(booster.code, false),
      foil: chanceFor(booster.code, true)
    }))
  }
}

/**
 * The finishes a printing is sold in.
 *
 * Etched counts as foil for booster purposes: MTGJSON's sheets only distinguish
 * foil from nonfoil, and an etched card is drawn from a foil sheet.
 */
function printingFinishes(scryfallId: string): Set<'nonfoil' | 'foil'> {
  const row = getDb().get('SELECT finishes FROM printings WHERE scryfall_id = ?', [
    scryfallId
  ]) as { finishes: string } | undefined
  const out = new Set<'nonfoil' | 'foil'>()
  if (!row) {
    // Unknown printing: report both rather than silently hiding a real chance.
    out.add('nonfoil')
    out.add('foil')
    return out
  }
  let list: string[] = []
  try {
    list = JSON.parse(row.finishes) as string[]
  } catch {
    list = ['nonfoil']
  }
  for (const finish of list) out.add(finish === 'nonfoil' ? 'nonfoil' : 'foil')
  return out
}
