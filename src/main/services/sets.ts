import { getDb, nowIso, transaction } from '../db/connection.js'

/**
 * Scryfall's set list, kept for the symbols the set filters draw.
 *
 * One request to `/sets` returns every set — about 1050 of them, ~600KB — with
 * its symbol URL, so this is a single fetch rather than a lookup per set. The
 * alternative, asking `/sets/{code}` for each of the 200-odd sets a collection
 * touches, would be 200 requests to answer the same question.
 *
 * Fetched lazily: nothing here runs until something actually asks for an icon,
 * so a user who never opens a set filter never pays for it.
 */

const SETS_URL = 'https://api.scryfall.com/sets'

/** Refreshed at most this often. Sets appear a few times a year, not hourly. */
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000

interface ScryfallSet {
  code: string
  name: string
  set_type?: string
  released_at?: string
  card_count?: number
  icon_svg_uri?: string
}

/** One sync at a time, however many icons ask for it at once. */
let inFlight: Promise<number> | null = null

function lastFetchedAt(): string | null {
  const row = getDb().get('SELECT MAX(fetched_at) AS at FROM sets') as { at: string | null }
  return row?.at ?? null
}

async function fetchSets(): Promise<number> {
  const response = await fetch(SETS_URL, {
    headers: { 'User-Agent': 'Matomeru/1.0 (local MTG collection manager)' }
  })
  if (!response.ok) throw new Error(`Scryfall returned ${response.status} for the set list.`)
  const body = (await response.json()) as { data?: ScryfallSet[] }
  const sets = body.data ?? []
  const now = nowIso()

  // One transaction: a thousand individual commits is the difference between
  // instant and visibly slow with a synchronous driver.
  transaction((db) => {
    for (const set of sets) {
      db.run(
        `INSERT INTO sets (code, name, set_type, released_at, card_count, icon_svg_uri, fetched_at)
         VALUES (?,?,?,?,?,?,?)
         ON CONFLICT(code) DO UPDATE SET
           name = excluded.name,
           set_type = excluded.set_type,
           released_at = excluded.released_at,
           card_count = excluded.card_count,
           icon_svg_uri = excluded.icon_svg_uri,
           fetched_at = excluded.fetched_at`,
        [
          set.code.toLowerCase(),
          set.name,
          set.set_type ?? null,
          set.released_at ?? null,
          set.card_count ?? null,
          set.icon_svg_uri ?? null,
          now
        ]
      )
    }
  })
  return sets.length
}

/**
 * Makes sure the set list is present and not stale.
 *
 * Concurrent callers share one request — forty icons rendering at once must not
 * become forty downloads of the same 600KB list.
 */
export function syncSets(force = false): Promise<number> {
  if (inFlight) return inFlight
  const at = lastFetchedAt()
  const fresh = at !== null && Date.now() - new Date(at).getTime() < MAX_AGE_MS
  if (fresh && !force) return Promise.resolve(0)
  inFlight = fetchSets().finally(() => {
    inFlight = null
  })
  return inFlight
}

/**
 * The symbol URL for a set, fetching the list first if it is missing.
 *
 * Returns null for a code Scryfall does not know, which is a real answer — the
 * caller renders nothing rather than a broken image.
 */
export async function setIconUrl(code: string): Promise<string | null> {
  const lookup = (): string | null => {
    const row = getDb().get('SELECT icon_svg_uri AS uri FROM sets WHERE code = ?', [
      code.toLowerCase()
    ]) as { uri: string | null } | undefined
    return row?.uri ?? null
  }

  const existing = lookup()
  if (existing) return existing

  // Either the list has never been fetched, or this set is newer than the copy we
  // have. Both are answered by refreshing once.
  try {
    await syncSets()
  } catch {
    return null
  }
  return lookup()
}

/** What the renderer needs to label and draw a set. */
export function knownSets(): { code: string; name: string; icon: boolean }[] {
  return (
    getDb().all(
      `SELECT code, name, icon_svg_uri IS NOT NULL AS icon FROM sets ORDER BY released_at DESC`
    ) as { code: string; name: string; icon: number }[]
  ).map((row) => ({ code: row.code, name: row.name, icon: row.icon === 1 }))
}
