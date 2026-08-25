/**
 * Scryfall HTTP client.
 *
 * Scryfall requires a descriptive User-Agent and an explicit Accept header —
 * generic agents get a 403 — and asks for no more than ~10 requests a second.
 * Every call in the app funnels through the one queue below so that limit holds
 * no matter how many features are talking to the API at once.
 */

import { t } from '@shared/i18n/index'
import type { TranslationKey } from '@shared/types'
import { getLocale } from '../db/repos/settings.js'

/**
 * Localised message, resolved at throw time from the stored locale.
 *
 * These reach the user verbatim through the renderer's single error funnel — a
 * failed lookup is exactly when someone reads the message.
 */
function tr(key: TranslationKey, vars?: Record<string, string | number>): string {
  return t(getLocale(), key, vars)
}

const BASE = 'https://api.scryfall.com'
/*
  Scryfall asks for under 10 requests a second and warns that sustained abuse
  earns a network block. 150ms leaves headroom over their stated ceiling — a
  picker lookup is not worth risking access over, and the difference is
  imperceptible for the handful of requests a normal action makes.
*/
const MIN_INTERVAL_MS = 150

/**
 * How many search pages one lookup will follow.
 *
 * Scryfall pages at 175 cards. A common card is brutal without a cap: "Forest"
 * has **3,890** printings across every language, which is 23 requests for one
 * keystroke — the kind of traffic their docs tell you to use the bulk data
 * download for instead. Three pages is plenty to pick the copy in your hand, and
 * callers are told when there was more so the UI can say so rather than pretend
 * the list is complete.
 */
const MAX_SEARCH_PAGES = 3
const HEADERS: Record<string, string> = {
  'User-Agent': 'Matomeru/1.0 (local MTG collection manager)',
  Accept: 'application/json'
}

let lastRequestAt = 0
let chain: Promise<unknown> = Promise.resolve()

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** Serializes all Scryfall traffic through a single throttled queue. */
function enqueue<T>(fn: () => Promise<T>): Promise<T> {
  const run = chain.then(async () => {
    const wait = MIN_INTERVAL_MS - (Date.now() - lastRequestAt)
    if (wait > 0) await sleep(wait)
    lastRequestAt = Date.now()
    return fn()
  })
  // Keep the chain alive even when a call rejects, or every later request dies with it.
  chain = run.catch(() => undefined)
  return run
}

export class ScryfallError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly notFound: boolean
  ) {
    super(message)
    this.name = 'ScryfallError'
  }
}

interface RequestOptions {
  method?: 'GET' | 'POST'
  body?: unknown
  /** 404 is a normal answer for "no such printing" — let callers opt into null. */
  allowNotFound?: boolean
}

async function request<T>(path: string, options: RequestOptions = {}): Promise<T | null> {
  return enqueue(async () => {
    const url = path.startsWith('http') ? path : `${BASE}${path}`
    let attempt = 0

    for (;;) {
      attempt += 1
      let response: Response
      try {
        response = await fetch(url, {
          method: options.method ?? 'GET',
          headers: options.body ? { ...HEADERS, 'Content-Type': 'application/json' } : HEADERS,
          body: options.body ? JSON.stringify(options.body) : undefined
        })
      } catch (err) {
        if (attempt >= 3) {
          throw new ScryfallError(
            tr('err.scryfallUnreachable', { message: (err as Error).message }),
            0,
            false
          )
        }
        await sleep(500 * attempt)
        continue
      }

      if (response.status === 404) {
        if (options.allowNotFound) return null
        throw new ScryfallError(tr('err.scryfallNotFound'), 404, true)
      }

      // 429 means we have been too eager; back off and retry the same request.
      if (response.status === 429 && attempt < 4) {
        await sleep(1000 * attempt)
        continue
      }

      if (response.status >= 500 && attempt < 3) {
        await sleep(500 * attempt)
        continue
      }

      if (!response.ok) {
        let detail = ''
        try {
          const body = (await response.json()) as { details?: string }
          detail = body.details ? ` — ${body.details}` : ''
        } catch {
          /* non-JSON error body */
        }
        throw new ScryfallError(
          tr('err.scryfallStatus', { status: response.status, detail }),
          response.status,
          false
        )
      }

      return (await response.json()) as T
    }
  })
}

// ---------- Card object shape (only the fields we consume) ----------

export interface ScryfallCard {
  id: string
  oracle_id?: string
  name: string
  printed_name?: string
  lang: string
  set: string
  set_name: string
  /** Read by `holdable`: 'alchemy' is digital-only and cannot be in a paper binder. */
  set_type?: string
  /** Also read by `holdable`. Set on cards that exist only in Arena or MTGO. */
  digital?: boolean
  collector_number: string
  rarity: string
  mana_cost?: string
  cmc?: number
  type_line?: string
  printed_type_line?: string
  printed_text?: string
  oracle_text?: string
  colors?: string[]
  color_identity?: string[]
  layout: string
  finishes?: string[]
  /** Tags like `surgefoil`, `galaxyfoil`, `serialized` — describes the foil version. */
  promo_types?: string[]
  /** Whether the card is sold in booster packs at all. */
  booster?: boolean
  released_at?: string
  image_uris?: Record<string, string>
  card_faces?: {
    name?: string
    image_uris?: Record<string, string>
    printed_name?: string
    printed_type_line?: string
    printed_text?: string
    oracle_text?: string
    type_line?: string
    mana_cost?: string
  }[]
  prices?: Record<string, string | null>
}

interface ScryfallList<T> {
  data: T[]
  has_more: boolean
  next_page?: string
  total_cards?: number
}

/** English name suggestions for the search box. */
export async function autocomplete(query: string): Promise<string[]> {
  if (query.trim().length < 2) return []
  /*
    `include_extras` is what makes a token suggestable at all. Scryfall leaves
    extras out by default, so typing "Cat Warri" offered "Cat Warriors" and
    "Mirri, Cat Warrior" -- every card with that name except the token actually in
    your hand. Face names are indexed too, so the back of a double-faced token
    finds it: "Max Speed" returns "Start Your Engines! // Max Speed".
  */
  const result = await request<{ data: string[] }>(
    `/cards/autocomplete?q=${encodeURIComponent(query.trim())}&include_extras=true`,
    { allowNotFound: true }
  )
  return result?.data ?? []
}

/**
 * Every printing of a card, in every language.
 *
 * `include_multilingual=true` is what surfaces the non-English printings — the
 * default search only returns English. `include_extras=true` is the same story for
 * tokens: without it `!"Cat Warrior"` is a 404 rather than the four token printings
 * it has, so a token could be added by number and then never found by name again.
 *
 * The cost is small and measured: `!"Lightning Bolt"` goes from 158 printings to
 * 170, the additions being 8 memorabilia, 2 art series, 1 alchemy and 1 draft
 * innovation. `holdable` in the mappers is what keeps the digital-only ones out.
 */
export async function printingsForName(
  name: string
): Promise<{ cards: ScryfallCard[]; total: number; truncated: boolean }> {
  const query = encodeURIComponent(`!"${name.replace(/"/g, '')}"`)
  const cards: ScryfallCard[] = []
  // Newest first: when the cap bites, recent printings are the ones somebody is
  // most likely to be holding, and `sortPrintings` reorders for display anyway.
  let path: string | null =
    `/cards/search?q=${query}&unique=prints&include_multilingual=true` +
    `&include_extras=true&order=released&dir=desc`

  let total = 0
  let pages = 0
  let more = false
  while (path && pages < MAX_SEARCH_PAGES) {
    const page: ScryfallList<ScryfallCard> | null = await request<ScryfallList<ScryfallCard>>(
      path,
      { allowNotFound: true }
    )
    if (!page) break
    cards.push(...page.data)
    total = page.total_cards ?? cards.length
    pages += 1
    more = !!(page.has_more && page.next_page)
    path = more ? (page.next_page ?? null) : null
  }
  return { cards, total: Math.max(total, cards.length), truncated: more }
}

/** Free-text search, used when an exact name match finds nothing. */
export async function searchCards(query: string, multilingual = true): Promise<ScryfallCard[]> {
  const params = new URLSearchParams({
    q: query,
    unique: 'prints',
    order: 'released',
    dir: 'asc',
    // Same reason as the exact route above: a token is an extra to Scryfall, and a
    // search that cannot return one leaves a token row's printing picker listing
    // unrelated cards that merely share its name.
    include_extras: 'true'
  })
  if (multilingual) params.set('include_multilingual', 'true')
  const page = await request<ScryfallList<ScryfallCard>>(`/cards/search?${params}`, {
    allowNotFound: true
  })
  return page?.data ?? []
}

/**
 * One exact printing, including its language.
 *
 * This is the *only* reliable way to reach a specific language: both
 * `/cards/named?lang=` and the `lang` key on `/cards/collection` are silently
 * ignored by the API and hand back the English card instead.
 */
export async function printingBySetNumberLang(
  set: string,
  collectorNumber: string,
  lang = 'en'
): Promise<ScryfallCard | null> {
  const path =
    `/cards/${encodeURIComponent(set.toLowerCase())}` +
    `/${encodeURIComponent(collectorNumber)}` +
    (lang && lang !== 'en' ? `/${encodeURIComponent(lang)}` : '/en')
  return request<ScryfallCard>(path, { allowNotFound: true })
}

export async function cardById(scryfallId: string): Promise<ScryfallCard | null> {
  return request<ScryfallCard>(`/cards/${encodeURIComponent(scryfallId)}`, { allowNotFound: true })
}

const COLLECTION_BATCH = 75

/**
 * Batch lookup by Scryfall id, 75 at a time.
 *
 * Identifying by `id` is important: a Scryfall id names one specific
 * language printing, so batching this way preserves language. Identifying by
 * `{set, collector_number, lang}` does *not* — the API ignores `lang` there and
 * returns English.
 */
export async function cardsByIds(ids: string[]): Promise<ScryfallCard[]> {
  const found: ScryfallCard[] = []
  for (let i = 0; i < ids.length; i += COLLECTION_BATCH) {
    const batch = ids.slice(i, i + COLLECTION_BATCH)
    const result = await request<{ data: ScryfallCard[] }>('/cards/collection', {
      method: 'POST',
      body: { identifiers: batch.map((id) => ({ id })) },
      allowNotFound: true
    })
    if (result) found.push(...result.data)
  }
  return found
}

/** Batch lookup by name (English only — the API has no multilingual batch route). */
export async function cardsByNames(
  names: string[]
): Promise<{ found: ScryfallCard[]; notFound: string[] }> {
  const found: ScryfallCard[] = []
  const notFound: string[] = []
  for (let i = 0; i < names.length; i += COLLECTION_BATCH) {
    const batch = names.slice(i, i + COLLECTION_BATCH)
    const result = await request<{
      data: ScryfallCard[]
      not_found: { name?: string }[]
    }>('/cards/collection', {
      method: 'POST',
      body: { identifiers: batch.map((name) => ({ name })) },
      allowNotFound: true
    })
    if (result) {
      found.push(...result.data)
      notFound.push(...result.not_found.map((n) => n.name ?? ''))
    }
  }
  return { found, notFound }
}
