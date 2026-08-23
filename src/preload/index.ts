import { contextBridge, ipcRenderer } from 'electron'
import type {
  BoosterOdds,
  AddCardInput,
  AppSettings,
  BackupResult,
  BackupStatus,
  RestoreResult,
  CardLocations,
  CollectionFilters,
  CollectionPage,
  Condition,
  CsvColumnMap,
  CsvDryRun,
  CsvPreview,
  CsvResolvedRow,
  Deck,
  DeckBreakdown,
  DeckLabelColor,
  FacetCounts,
  Finish,
  PickList,
  PickListItem,
  PickSource,
  Printing,
  DeckSource,
  UndoState,
  PrintingChoice,
  ProgressEvent,
  QuickAddInput,
  Stats
} from '@shared/types'

interface Envelope<T> {
  ok: boolean
  data?: T
  error?: string
}

/**
 * Unwraps the main process envelope. Handlers never reject; they return
 * `{ ok: false, error }`, which is turned back into a throw here so callers can
 * use ordinary try/catch.
 */
async function call<T>(channel: string, ...args: unknown[]): Promise<T> {
  const result = (await ipcRenderer.invoke(channel, ...args)) as Envelope<T>
  if (!result.ok) throw new Error(result.error ?? 'Unknown error')
  return result.data as T
}

const api = {
  collection: {
    query: (filters: CollectionFilters, limit: number, offset: number) =>
      call<CollectionPage>('collection:query', filters, limit, offset),
    facets: (filters: CollectionFilters) => call<FacetCounts>('collection:facets', filters),
    add: (input: AddCardInput) => call<{ itemId: number; owned: number }>('collection:add', input),
    setQuantity: (itemId: number, quantity: number) =>
      call<boolean>('collection:setQuantity', itemId, quantity),
    update: (
      itemId: number,
      patch: {
        finish?: Finish
        condition?: Condition
        notes?: string | null
        /** Which kind of foil; null clears it back to the printing's own tag. */
        foil_treatment?: string | null
        /** 1 when this copy is a proxy you printed rather than bought. */
        proxied?: 0 | 1
      }
    ) => call<boolean>('collection:update', itemId, patch),
    remove: (itemId: number) => call<boolean>('collection:remove', itemId),
    bulkUpdate: (
      ids: number[],
      patch: {
        finish?: Finish
        condition?: Condition
        foil_treatment?: string | null
        proxied?: 0 | 1
      }
    ) => call<boolean>('collection:bulkUpdate', ids, patch),
    bulkRemove: (ids: number[]) =>
      call<{ removed: number; skipped: number }>('collection:bulkRemove', ids),
    locations: (scryfallId: string) => call<CardLocations | null>('collection:locations', scryfallId),
    /** Repoints a copy you entered at a different printing; returns the surviving row id. */
    setPrinting: (itemId: number, scryfallId: string) =>
      call<number>('collection:setPrinting', itemId, scryfallId),
    /** Switches a copy to another language, resolving the printing for it. */
    setLanguage: (itemId: number, lang: string) =>
      call<{ ok: boolean; viaSearch?: boolean; itemId?: number; reason?: string }>(
        'collection:setLanguage',
        itemId,
        lang
      ),
    /** Asserts a language Scryfall has no printing for; null clears it. */
    forceLanguage: (itemId: number, lang: string | null, name?: string | null) =>
      call<boolean>('collection:forceLanguage', itemId, lang, name)
  },

  cards: {
    suggest: (query: string) => call<string[]>('cards:suggest', query),
    printings: (name: string) => call<PrintingChoice[]>('cards:printings', name),
    /** Printings plus the true total, since a common card's results are capped. */
    printingsPage: (name: string) =>
      call<{ printings: PrintingChoice[]; total: number; truncated: boolean }>(
        'cards:printingsPage',
        name
      ),
    quickResolve: (set: string, collectorNumber: string, lang: string) =>
      call<PrintingChoice | null>('cards:quickResolve', set, collectorNumber, lang),
    quickAdd: (input: QuickAddInput) =>
      call<{ itemId: number; printing: PrintingChoice }>('cards:quickAdd', input),
    /** One cached printing, for the card detail view. */
    /** Puts the card's artwork on the system clipboard. */
    copyImage: (scryfallId: string) => call<boolean>('cards:copyImage', scryfallId),
    printing: (scryfallId: string) => call<Printing | null>('cards:printing', scryfallId)
  },

  pickLists: {
    list: () => call<PickList[]>('pickLists:list'),
    create: (name: string, note?: string | null) => call<number>('pickLists:create', name, note),
    rename: (id: number, name: string, note?: string | null) =>
      call<boolean>('pickLists:rename', id, name, note),
    items: (id: number) => call<PickListItem[]>('pickLists:items', id),
    add: (pickListId: number | null, source: PickSource, quantity: number) =>
      call<{ pickListId: number; added: number; capped: boolean }>(
        'pickLists:add',
        pickListId,
        source,
        quantity
      ),
    addMany: (pickListId: number | null, entries: { source: PickSource; quantity: number }[]) =>
      call<{ pickListId: number; added: number; capped: number }>(
        'pickLists:addMany',
        pickListId,
        entries
      ),
    setQuantity: (pickItemId: number, quantity: number) =>
      call<boolean>('pickLists:setQuantity', pickItemId, quantity),
    removeItem: (pickItemId: number) => call<boolean>('pickLists:removeItem', pickItemId),
    confirm: (id: number) =>
      call<{
        pickListId: number
        cardsRemoved: number
        rowsDeleted: number
        cardsFreedFromDecks: number
      }>('pickLists:confirm', id),
    cancel: (id: number) => call<boolean>('pickLists:cancel', id),
    reopen: (id: number) => call<boolean>('pickLists:reopen', id),
    revert: (id: number) =>
      call<{ pickListId: number; cardsRestored: number; cardsReturnedToDecks: number }>(
        'pickLists:revert',
        id
      ),
    remove: (id: number) => call<boolean>('pickLists:delete', id),
    exportCsv: (id: number) =>
      call<{ canceled: boolean; count: number; path?: string }>('pickLists:export', id)
  },

  decks: {
    list: () => call<Deck[]>('decks:list'),
    breakdown: (deckId: number) => call<DeckBreakdown | null>('decks:breakdown', deckId),
    syncUser: (username?: string) =>
      call<{
        synced: number
        skipped: number
        failed: number
        privateCount: number
        listedCount: number
        unavailable: { id: string; name: string; reason: string }[]
        deckCountReported: number | null
      }>('decks:syncUser', username),
    addByUrl: (input: string) => call<{ deckId: number; name: string }>('decks:addByUrl', input),
    remove: (deckId: number) => call<boolean>('decks:delete', deckId),
    /** Label colours found across synced decks, for the "don't own" picker. */
    labelColors: () => call<DeckLabelColor[]>('decks:labelColors'),
    pullSources: (scryfallId: string, finish: string) =>
      call<DeckSource[]>('decks:pullSources', scryfallId, finish),
    choices: () => call<{ deck_id: number; deck_name: string }[]>('decks:choices'),
    moveToCollection: (deckId: number, oracleId: string, quantity: number) =>
      call<{ moved: number }>('decks:moveToCollection', deckId, oracleId, quantity),
    moveToDeck: (deckId: number, itemId: number, quantity: number) =>
      call<{ moved: number }>('decks:moveToDeck', deckId, itemId, quantity),
    revertMove: (moveId: number) =>
      call<{ deckId: number; quantity: number }>('decks:revertMove', moveId),
    /** Records which printing you own, for the cards you selected and no others. */
    setCardsLanguage: (deckId: number, oracleIds: string[], lang: string) =>
      call<{ converted: number; unavailable: { name: string; lang: string }[]; failed: number }>(
        'decks:setCardsLanguage',
        deckId,
        oracleIds,
        lang
      ),
    /** Returns the selected cards to whatever printing Archidekt reports. */
    clearCardsLanguage: (deckId: number, oracleIds: string[]) =>
      call<number>('decks:clearCardsLanguage', deckId, oracleIds),
    /** Points a deck entry at a printing you picked yourself. */
    setCardPrinting: (deckId: number, oracleId: string, scryfallId: string) =>
      call<boolean>('decks:setCardPrinting', deckId, oracleId, scryfallId),
    /** Asserts a language Scryfall has no printing for; null clears it. */
    forceCardLanguage: (
      deckId: number,
      oracleId: string,
      lang: string | null,
      name?: string | null
    ) => call<boolean>('decks:forceCardLanguage', deckId, oracleId, lang, name),
    /**
     * Records the finish and foil treatment you physically hold these entries in.
     * Null finish falls back to what Archidekt reported.
     */
    setCardFinish: (
      deckId: number,
      oracleIds: string[],
      finish: Finish | null,
      treatment?: string | null
    ) => call<number>('decks:setCardFinish', deckId, oracleIds, finish, treatment),
    /** Marks these deck entries as filled by proxies, or clears the flag. */
    setCardProxied: (deckId: number, oracleIds: string[], proxied: boolean) =>
      call<number>('decks:setCardProxied', deckId, oracleIds, proxied)
  },

  boosters: {
    /** Downloads and distils one set's booster recipes. */
    load: (setCode: string) =>
      call<{ boosters: number; cards: number }>('boosters:load', setCode),
    /** The chance of pulling this printing from each of its set's boosters. */
    forCard: (scryfallId: string, setCode: string) =>
      call<BoosterOdds>('boosters:forCard', scryfallId, setCode),
    /** Sets you own booster-eligible cards from, and whether each is fetched. */
    sets: () =>
      call<{ set_code: string; cards: number; fetched: boolean }[]>('boosters:sets'),
    /** Fetches every set in the collection that needs it, in one run. */
    loadForCollection: (refetch?: boolean) =>
      call<{ sets: number; skipped: number; failed: string[]; noData: string[] }>(
        'boosters:loadForCollection',
        refetch
      )
  },

  prices: {
    refresh: () =>
      call<{ requested: number; updated: number; unpriced: number; syncedAt: string }>(
        'prices:refresh'
      )
  },

  stats: {
    get: () => call<Stats>('stats:get')
  },

  undo: {
    undo: () => call<{ label: string } | null>('undo:undo'),
    redo: () => call<{ label: string } | null>('undo:redo'),
    state: () => call<UndoState>('undo:state')
  },
  backup: {
    /** Never returns a credential — only what the dialog needs to describe things. */
    status: () => call<BackupStatus>('backup:status'),
    connect: () => call<boolean>('backup:connect'),
    disconnect: () => call<boolean>('backup:disconnect'),
    /** `force` carries the user's acknowledgement that a newer remote may be replaced. */
    save: (force = false) => call<BackupResult>('backup:save', force),
    restore: () => call<RestoreResult>('backup:restore'),
    /** Names the Drive folder backups go into. Blank falls back to the default. */
    setFolderName: (name: string) => call<string>('backup:setFolderName', name),
    snapshotSize: () => call<number>('backup:snapshotSize')
  },

  settings: {
    get: () => call<AppSettings>('settings:get'),
    update: (patch: Partial<AppSettings>) => call<AppSettings>('settings:update', patch)
  },

  csv: {
    pickImportFile: () => call<string | null>('csv:pickImport'),
    preview: (filePath: string) => call<CsvPreview>('csv:preview', filePath),
    dryRun: (filePath: string, map: CsvColumnMap) => call<CsvDryRun>('csv:dryRun', filePath, map),
    commit: (rows: CsvResolvedRow[]) =>
      call<{ imported: number; cards: number; skipped: number }>('csv:commit', rows),
    writeRejects: (rows: CsvResolvedRow[]) =>
      call<{ canceled: boolean; count: number; path?: string }>('csv:writeRejects', rows),
    exportCollection: (filters: CollectionFilters) =>
      call<{ canceled: boolean; count: number; path?: string }>('csv:export', filters)
  },

  /** Subscribes to long-running job progress. Returns an unsubscribe function. */
  onProgress: (listener: (event: ProgressEvent) => void): (() => void) => {
    const handler = (_e: unknown, payload: ProgressEvent): void => listener(payload)
    ipcRenderer.on('app:progress', handler)
    return () => ipcRenderer.removeListener('app:progress', handler)
  },

  /** URL for a locally cached card image, served by the main process. */
  imageUrl: (scryfallId: string, size: 'small' | 'normal' | 'large' = 'small'): string =>
    `matomeru://image/${scryfallId}?size=${size}`
}

export type MatomeruApi = typeof api

contextBridge.exposeInMainWorld('api', api)
