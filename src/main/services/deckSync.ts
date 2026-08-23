import type { ProgressEvent } from '@shared/types'
import {
  ArchidektError,
  fetchDeck,
  formatName,
  parseDeckId,
  userByUsername,
  deckUrl,
  type ArchidektDeckSummary
} from '../archidekt/client.js'
import { toDeckCards, toDeckUpsert } from '../archidekt/mappers.js'
import {
  deckPrintingsNeedingCache,
  deckSyncState,
  recomputeLabelPossession,
  recordDeckError,
  replaceDeckCards,
  upsertDeck
} from '../db/repos/decks.js'
import { getLabelPossession } from '../db/repos/settings.js'
import { upsertPrinting } from '../db/repos/printings.js'
import { cardsByIds } from '../scryfall/client.js'
import { toPrinting } from '../scryfall/mappers.js'
import { t } from '@shared/i18n/index'
import type { TranslationKey } from '@shared/types'
import { getLocale } from '../db/repos/settings.js'

/** Localised message, resolved at throw time from the stored locale. */
function tr(key: TranslationKey, vars?: Record<string, string | number>): string {
  return t(getLocale(), key, vars)
}

export type ProgressSink = (event: ProgressEvent) => void

export interface DeckSyncResult {
  synced: number
  skipped: number
  failed: number
  privateCount: number
  /** Decks Archidekt would not show us, so the UI can explain rather than hide. */
  unavailable: { id: string; name: string; reason: string }[]
  deckCountReported: number | null
}

/**
 * Pulls every deck we can see for a username.
 *
 * Private decks are unreachable without authentication, and Archidekt omits
 * them from the username response, so the reported `deckCount` is often larger
 * than the list we get back. That gap is surfaced rather than swallowed.
 */
export async function syncUserDecks(
  username: string,
  onProgress: ProgressSink
): Promise<DeckSyncResult> {
  const result: DeckSyncResult = {
    synced: 0,
    skipped: 0,
    failed: 0,
    privateCount: 0,
    unavailable: [],
    deckCountReported: null
  }

  onProgress({ job: 'deck-sync', phase: 'Looking up account', done: 0, total: 1 })

  const user = await userByUsername(username)
  if (!user) {
    throw new Error(tr('err.noArchidektAccount', { username }))
  }
  result.deckCountReported = user.deckCount ?? null

  const summaries: ArchidektDeckSummary[] = user.decks ?? []
  const hidden = (user.deckCount ?? 0) - summaries.length
  if (hidden > 0) {
    result.privateCount = hidden
  }

  const total = summaries.length
  onProgress({ job: 'deck-sync', phase: 'Syncing decks', done: 0, total })

  for (let i = 0; i < summaries.length; i += 1) {
    const summary = summaries[i]
    const externalId = String(summary.id)

    // Skip decks that have not changed since our last successful sync.
    const state = deckSyncState(externalId)
    if (state && summary.updatedAt && state.external_updated_at === summary.updatedAt) {
      result.skipped += 1
      onProgress({
        job: 'deck-sync',
        phase: 'Syncing decks',
        done: i + 1,
        total,
        message: `${summary.name} — unchanged`
      })
      continue
    }

    try {
      await syncOneDeck(externalId)
      result.synced += 1
      onProgress({
        job: 'deck-sync',
        phase: 'Syncing decks',
        done: i + 1,
        total,
        message: summary.name
      })
    } catch (err) {
      const error = err as ArchidektError
      const reason = error.likelyPrivate ? 'private — not synced' : error.message
      recordDeckError(
        externalId,
        {
          name: summary.name,
          format: formatName(summary.deckFormat),
          owner_username: summary.owner?.username ?? username,
          url: deckUrl(externalId),
          external_updated_at: summary.updatedAt,
          is_private: error.likelyPrivate || summary.private,
          is_unlisted: summary.unlisted
        },
        reason
      )
      result.failed += 1
      result.unavailable.push({ id: externalId, name: summary.name, reason })
      onProgress({
        job: 'deck-sync',
        phase: 'Syncing decks',
        done: i + 1,
        total,
        message: `${summary.name} — ${reason}`
      })
    }
  }

  await cacheDeckPrintings(onProgress)
  // Freshly written deck_cards carry a raw label but no flag yet.
  recomputeLabelPossession(getLabelPossession())
  onProgress({ job: 'deck-sync', phase: 'Done', done: total, total, finished: true })
  return result
}

/**
 * Fetches and stores one deck. Returns its local id and name so callers do not
 * have to re-fetch the deck just to label it — every request here is throttled.
 */
export async function syncOneDeck(externalId: string): Promise<{ deckId: number; name: string }> {
  const deck = await fetchDeck(externalId)
  if (!deck) {
    throw new ArchidektError(
      'Archidekt returned 404 — the deck is private or no longer exists.',
      404,
      true
    )
  }
  const deckId = upsertDeck(toDeckUpsert(deck))
  replaceDeckCards(deckId, toDeckCards(deck))
  return { deckId, name: deck.name }
}

/** Adds a single deck from a pasted URL or id. */
export async function addDeckByUrl(
  input: string,
  onProgress?: ProgressSink
): Promise<{ deckId: number; name: string }> {
  const externalId = parseDeckId(input)
  if (!externalId) {
    throw new Error(tr('err.notADeckUrl'))
  }
  const report: ProgressSink = onProgress ?? (() => undefined)
  report({ job: 'deck-sync', phase: 'Fetching deck', done: 0, total: 1 })
  const { deckId, name } = await syncOneDeck(externalId)
  // Caching must happen regardless of whether a progress sink was supplied —
  // skipping it leaves deck cards with no printing row, so they lose their
  // images and prices and cannot be added to the collection.
  await cacheDeckPrintings(report)
  recomputeLabelPossession(getLabelPossession())
  report({ job: 'deck-sync', phase: 'Done', done: 1, total: 1, finished: true })
  return { deckId, name }
}

/**
 * Caches Scryfall printings for cards that decks reference but the collection
 * has never seen, so deck views can show images and prices for cards you do not
 * own yet. Batched by id, which preserves each card's language.
 */
async function cacheDeckPrintings(onProgress: ProgressSink): Promise<void> {
  const missing = deckPrintingsNeedingCache(1000)
  if (!missing.length) return

  onProgress({ job: 'deck-sync', phase: 'Caching deck cards', done: 0, total: missing.length })
  const cards = await cardsByIds(missing)
  for (const card of cards) {
    upsertPrinting(toPrinting(card), card)
  }
  onProgress({
    job: 'deck-sync',
    phase: 'Caching deck cards',
    done: missing.length,
    total: missing.length
  })
}
