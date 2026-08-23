/**
 * Archidekt client.
 *
 * Archidekt publishes no documented API, so these routes were verified by
 * probing the live service. Three work; several plausible-looking ones do not.
 *
 *   WORKS  GET /api/users/username/{username}/   -> user id + public deck list
 *   WORKS  GET /api/users/{userId}/decks/        -> that user's decks
 *   WORKS  GET /api/decks/{deckId}/              -> full deck with cards
 *
 *   DEAD   /api/decks/?owner=            404
 *   DEAD   /api/decks/cards/?owner=      404
 *   DEAD   /api/search/decks/            404
 *   DEAD   /api/users/{username}/        404
 *   DEAD   /api/folders/user/{id}/       404
 *
 *   TRAP   GET /api/decks/v3/?owner={username} returns 200 and looks correct,
 *          but it IGNORES the owner parameter and hands back a global feed of
 *          recent decks from every user. Never use it.
 *
 * Private decks return 404 to unauthenticated requests, and the username route
 * omits them entirely, so `deckCount` can exceed the number of decks listed.
 */

const BASE = 'https://archidekt.com/api'
// No published rate limit, so stay conservative — this is someone else's service.
const MIN_INTERVAL_MS = 500
const HEADERS: Record<string, string> = {
  'User-Agent': 'Matomeru/1.0 (local MTG collection manager)',
  Accept: 'application/json'
}

let lastRequestAt = 0
let chain: Promise<unknown> = Promise.resolve()

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function enqueue<T>(fn: () => Promise<T>): Promise<T> {
  const run = chain.then(async () => {
    const wait = MIN_INTERVAL_MS - (Date.now() - lastRequestAt)
    if (wait > 0) await sleep(wait)
    lastRequestAt = Date.now()
    return fn()
  })
  chain = run.catch(() => undefined)
  return run
}

export class ArchidektError extends Error {
  constructor(
    message: string,
    readonly status: number,
    /** 404 on a deck almost always means "private", not "deleted". */
    readonly likelyPrivate = false
  ) {
    super(message)
    this.name = 'ArchidektError'
  }
}

async function request<T>(path: string, allowNotFound = false): Promise<T | null> {
  return enqueue(async () => {
    let attempt = 0
    for (;;) {
      attempt += 1
      let response: Response
      try {
        response = await fetch(`${BASE}${path}`, { headers: HEADERS })
      } catch (err) {
        if (attempt >= 3) {
          throw new ArchidektError(`Could not reach Archidekt: ${(err as Error).message}`, 0)
        }
        await sleep(600 * attempt)
        continue
      }

      if (response.status === 404) {
        if (allowNotFound) return null
        throw new ArchidektError('Not found on Archidekt.', 404, true)
      }
      if ((response.status === 429 || response.status >= 500) && attempt < 4) {
        await sleep(1200 * attempt)
        continue
      }
      if (!response.ok) {
        throw new ArchidektError(`Archidekt returned ${response.status}`, response.status)
      }
      return (await response.json()) as T
    }
  })
}

// ---------- Response shapes (only the fields we consume) ----------

export interface ArchidektDeckSummary {
  id: number
  name: string
  deckFormat: number | null
  updatedAt: string | null
  createdAt?: string | null
  private: boolean
  unlisted: boolean
  size?: number
  owner?: { id: number; username: string }
}

export interface ArchidektUser {
  id: number
  username: string
  deckCount: number
  decks: ArchidektDeckSummary[]
}

export interface ArchidektDeckCard {
  id: number
  quantity: number
  /** 'Normal' | 'Foil' | 'Etched' */
  modifier: string | null
  /**
   * A single `"name,#color"` string, e.g. `"Don't Have,#F47373"`. The name is
   * frequently empty (`",#656565"`), and there is no deck-level registry of
   * labels — the only way to know which exist is to scan the cards.
   */
  label: string | null
  categories: string[] | null
  card: {
    /** The Scryfall printing id — our exact-match join key. */
    uid: string
    collectorNumber: string | null
    rarity: string | null
    edition?: { editioncode?: string; editionname?: string } | null
    oracleCard?: {
      /** The Scryfall oracle id — our fallback join key. */
      uid: string
      name: string
      lang?: string
    } | null
  }
}

export interface ArchidektDeck {
  id: number
  name: string
  deckFormat: number | null
  updatedAt: string | null
  private: boolean
  unlisted: boolean
  owner?: { id: number; username: string }
  /**
   * `isPremier` marks the commander category (Oathbreaker, Signature Spell, …).
   * Captured here so a refactor cannot quietly drop it; `deckBreakdown` reads it
   * back out of the stored raw JSON, which is what makes commanders resolve on
   * decks that were synced before this existed.
   */
  categories?: { name: string; includedInDeck: boolean; isPremier?: boolean }[] | null
  cards: ArchidektDeckCard[]
}

/**
 * Archidekt encodes formats as integers. These are the common ones; anything
 * unrecognised falls back to null rather than a wrong label.
 */
const DECK_FORMATS: Record<number, string> = {
  1: 'Standard',
  2: 'Modern',
  3: 'Commander / EDH',
  4: 'Legacy',
  5: 'Vintage',
  6: 'Pauper',
  7: 'Custom',
  8: 'Frontier',
  9: 'Future Standard',
  10: 'Penny Dreadful',
  11: 'One-versus-one Commander',
  12: 'Duel Commander',
  13: 'Brawl',
  14: 'Oathbreaker',
  15: 'Pioneer',
  16: 'Historic',
  17: 'Pauper EDH',
  18: 'Alchemy',
  19: 'Explorer',
  20: 'Historic Brawl',
  21: 'Gladiator',
  22: 'Premodern',
  23: 'Predh',
  24: 'Timeless',
  25: 'Canadian Highlander'
}

export function formatName(format: number | null | undefined): string | null {
  if (format === null || format === undefined) return null
  return DECK_FORMATS[format] ?? null
}

/** Resolves a username to its user id and the decks Archidekt will show us. */
export async function userByUsername(username: string): Promise<ArchidektUser | null> {
  const clean = username.trim()
  if (!clean) return null
  return request<ArchidektUser>(`/users/username/${encodeURIComponent(clean)}/`, true)
}

/** Secondary deck listing, by numeric user id. */
export async function decksForUserId(userId: number): Promise<ArchidektDeckSummary[]> {
  const result = await request<{ decks: ArchidektDeckSummary[] }>(`/users/${userId}/decks/`, true)
  return result?.decks ?? []
}

export async function fetchDeck(deckId: string | number): Promise<ArchidektDeck | null> {
  return request<ArchidektDeck>(`/decks/${encodeURIComponent(String(deckId))}/`, true)
}

/** Pulls a deck id out of anything the user is likely to paste. */
export function parseDeckId(input: string): string | null {
  const trimmed = input.trim()
  if (!trimmed) return null
  if (/^\d+$/.test(trimmed)) return trimmed
  const match = trimmed.match(/archidekt\.com\/decks\/(\d+)/i)
  return match ? match[1] : null
}

export function deckUrl(deckId: string | number): string {
  return `https://archidekt.com/decks/${deckId}`
}
