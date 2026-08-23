import type { ProgressEvent } from '@shared/types'
import {
  ArchidektError,
  decksForUserId,
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
  listDecks,
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
  /** How many decks the profile actually listed, as opposed to how many exist. */
  listedCount: number
  /** Decks Archidekt would not show us, so the UI can explain rather than hide. */
  unavailable: { id: string; name: string; reason: string }[]
  deckCountReported: number | null
}

/**
 * Decides what a sync should touch, given what Archidekt lists and what we hold.
 *
 * Pure, and separate from the request loop, so the decision can be tested without
 * a network or an account — which is the only reason the bug it fixes was
 * reachable at all. Two faults lived here:
 *
 *   - A deck we already hold that the profile does not list was skipped entirely.
 *     That is precisely what an unlisted deck looks like, so "Sync decks" never
 *     refreshed one and it went stale forever, while the same deck could be
 *     re-imported by link at any time.
 *   - Everything Archidekt counted but did not list was reported as private. A
 *     count difference cannot tell "private" from "unlisted", and it certainly
 *     cannot tell either from "you already added it", so the warning fired every
 *     sync for decks that were sitting right there.
 */
export function planDeckSync(
  listedIds: string[],
  localIds: string[],
  reportedCount: number
): { localOnly: string[]; hidden: number } {
  const listed = new Set(listedIds)
  const localOnly = localIds.filter((id) => !listed.has(id))
  return {
    localOnly,
    // Never negative: Archidekt's count can lag its own listing, and a negative
    // "hidden" would read as a warning about decks that do not exist.
    hidden: Math.max(0, reportedCount - listedIds.length - localOnly.length)
  }
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
    listedCount: 0,
    unavailable: [],
    deckCountReported: null
  }

  onProgress({ job: 'deck-sync', phase: 'Looking up account', done: 0, total: 1 })

  const user = await userByUsername(username)
  if (!user) {
    throw new Error(tr('err.noArchidektAccount', { username }))
  }
  result.deckCountReported = user.deckCount ?? null

  /*
    The profile listing, with the by-id endpoint as a fallback.

    `decksForUserId` has existed unused since this was written. It is worth asking
    when the username response comes back with fewer decks than it claims to have,
    because the two endpoints do not always agree, and a deck we can list is a deck
    we can sync.
  */
  let summaries: ArchidektDeckSummary[] = user.decks ?? []
  if (user.id && summaries.length < (user.deckCount ?? 0)) {
    const secondary = await decksForUserId(user.id)
    if (secondary.length > summaries.length) summaries = secondary
  }

  const plan = planDeckSync(
    summaries.map((d) => String(d.id)),
    listDecks()
      .filter((deck) => deck.source === 'archidekt')
      .map((deck) => deck.external_id),
    user.deckCount ?? 0
  )
  const localOnly = plan.localOnly
  const localOnlyIds = new Set(localOnly)
  result.listedCount = summaries.length
  if (plan.hidden > 0) result.privateCount = plan.hidden

  /*
    Locally-known decks are appended to the queue as bare summaries. They carry no
    profile metadata — that is the point, the profile does not list them — so the
    name and format come from what the fetch returns, and `recordDeckError` falls
    back to what we already stored.
  */
  /*
    The work queue: what the profile listed, then what we hold that it did not.

    A local-only entry has no summary — that is the whole point, the profile does
    not describe it — so it is modelled as an id with no metadata rather than cast
    to a summary shape whose fields would all be undefined. The first version of
    this did exactly that, and `summary.name` reached `recordDeckError` as
    undefined on the failure path.
  */
  const queue: { externalId: string; summary: ArchidektDeckSummary | null }[] = [
    ...summaries.map((summary) => ({ externalId: String(summary.id), summary })),
    ...localOnly.map((externalId) => ({ externalId, summary: null }))
  ]

  const total = queue.length
  onProgress({ job: 'deck-sync', phase: 'Syncing decks', done: 0, total })

  for (let i = 0; i < queue.length; i += 1) {
    const { externalId, summary } = queue[i]

    // Skip decks that have not changed since our last successful sync.
    const state = deckSyncState(externalId)
    if (state && summary?.updatedAt && state.external_updated_at === summary.updatedAt) {
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
        message: summary?.name ?? externalId
      })
    } catch (err) {
      const error = err as ArchidektError
      /*
        A deck we already hold and that the profile does not list is not evidence
        of privacy — it is what an unlisted deck looks like. Only say "private" for
        one Archidekt itself listed, where a 404 really is a permission answer.
      */
      const reason =
        error.likelyPrivate && !localOnlyIds.has(externalId)
          ? 'private — not synced'
          : error.message
      recordDeckError(
        externalId,
        {
          // Undefined leaves whatever is already stored in place: `recordDeckError`
          // only overwrites the error, the timestamp and the private flag, so a
          // deck we already hold keeps its real name rather than gaining a
          // placeholder.
          name: summary?.name,
          format: summary ? formatName(summary.deckFormat) : undefined,
          owner_username: summary?.owner?.username ?? username,
          url: deckUrl(externalId),
          external_updated_at: summary?.updatedAt,
          /*
            A 404 on a deck the profile never listed is not evidence of privacy —
            it is what an unlisted deck looks like from outside, and the reason
            string above already says so. Flagging it private here as well would
            put the padlock back on the very decks this change stopped calling
            private.
          */
          is_private: !summary ? false : error.likelyPrivate || summary.private,
          is_unlisted: summary?.unlisted ?? true
        },
        reason
      )
      result.failed += 1
      result.unavailable.push({ id: externalId, name: summary?.name ?? externalId, reason })
      onProgress({
        job: 'deck-sync',
        phase: 'Syncing decks',
        done: i + 1,
        total,
        message: `${summary?.name ?? externalId} — ${reason}`
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
    throw new ArchidektError(tr('err.deckUnreachable'), 404, true)
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
