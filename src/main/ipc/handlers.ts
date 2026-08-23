import { BrowserWindow, clipboard, dialog, ipcMain, nativeImage } from 'electron'
import type {
  AddCardInput,
  AppSettings,
  CollectionFilters,
  Condition,
  CsvColumnMap,
  CsvResolvedRow,
  Finish,
  ProgressEvent,
  QuickAddInput
} from '@shared/types'
import {
  bulkRemove,
  bulkUpdate,
  cardLocations,
  forceItemLanguage,
  queryCollection,
  queryFacets,
  removeItem,
  setItemPrinting,
  setQuantity,
  updateItem
} from '../db/repos/collection.js'
import {
  addToPickList,
  cancelPickList,
  confirmPickList,
  createPickList,
  deletePickList,
  ensureDefaultPickList,
  getPickListItems,
  listPickLists,
  removePickItem,
  renamePickList,
  reopenPickList,
  setPickItemQuantity
} from '../db/repos/pickLists.js'
import {
  deckBreakdown,
  deleteDeck,
  discoverLabelColors,
  forceCardLanguage,
  listDecks,
  recomputeLabelPossession,
  setCardFinish,
  setCardPrinting,
  setCardProxied
} from '../db/repos/decks.js'
import { getSettings, updateSettings } from '../db/repos/settings.js'
import { collectionStats } from '../db/repos/stats.js'
import {
  addCard,
  printingsFor,
  printingsPage,
  quickAdd,
  resolveQuick,
  suggestNames
} from '../services/addCards.js'
import { getPrinting } from '../db/repos/printings.js'
import { cachedImage } from '../services/imageCache.js'
import { addDeckByUrl, syncUserDecks } from '../services/deckSync.js'
import { clearCardsLanguage, setCardsLanguage } from '../services/deckLanguage.js'
import { setItemLanguage } from '../services/collectionLanguage.js'
import {
  boosterOddsFor,
  collectionBoosterSets,
  loadBoosterOdds,
  loadBoosterOddsForCollection
} from '../services/boosterOdds.js'
import { createThrottledBroadcaster } from './progressThrottle.js'
import { refreshPrices } from '../services/priceSync.js'
import {
  commitCsv,
  dryRunCsv,
  exportCollectionCsv,
  exportPickListCsv,
  previewCsv,
  writeRejects
} from '../services/csv.js'
import { t } from '@shared/i18n/index'
import type { TranslationKey } from '@shared/types'
import { getLocale } from '../db/repos/settings.js'

/** Localised message, resolved at throw time from the stored locale. */
function tr(key: TranslationKey, vars?: Record<string, string | number>): string {
  return t(getLocale(), key, vars)
}

/**
 * All handlers are wrapped so a thrown error crosses IPC as a plain message
 * rather than Electron's serialized stack, which the renderer cannot read.
 */
function handle<Args extends unknown[], Result>(
  channel: string,
  fn: (...args: Args) => Result | Promise<Result>
): void {
  ipcMain.handle(channel, async (_event, ...args) => {
    try {
      return { ok: true, data: await fn(...(args as Args)) }
    } catch (err) {
      return { ok: false, error: (err as Error).message || 'Unexpected error' }
    }
  })
}

const broadcast = createThrottledBroadcaster((event: ProgressEvent) => {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send('app:progress', event)
  }
})

export function registerHandlers(): void {
  // ---------- Collection ----------
  handle('collection:query', (filters: CollectionFilters, limit: number, offset: number) =>
    queryCollection(filters, getSettings().currency, limit, offset)
  )
  handle('collection:facets', (filters: CollectionFilters) =>
    queryFacets(filters, getSettings().currency)
  )
  handle('collection:add', (input: AddCardInput) => addCard(input))
  handle('collection:setQuantity', (itemId: number, quantity: number) => {
    setQuantity(itemId, quantity)
    return true
  })
  handle(
    'collection:update',
    (
      itemId: number,
      patch: {
        finish?: Finish
        condition?: Condition
        notes?: string | null
        foil_treatment?: string | null
        proxied?: 0 | 1
      }
    ) => {
      updateItem(itemId, patch)
      return true
    }
  )
  handle('collection:remove', (itemId: number) => {
    removeItem(itemId)
    return true
  })
  handle(
    'collection:bulkUpdate',
    (
      ids: number[],
      patch: {
        finish?: Finish
        condition?: Condition
        foil_treatment?: string | null
        proxied?: 0 | 1
      }
    ) => {
      bulkUpdate(ids, patch)
      return true
    }
  )
  handle('collection:bulkRemove', (ids: number[]) => bulkRemove(ids))
  handle('collection:locations', (scryfallId: string) => cardLocations(scryfallId))

  // Change which printing a copy you entered actually is, or assert a language
  // Scryfall has no printing for. The deck screen has had this; the collection
  // had no way to correct a printing at all short of deleting every copy.
  handle('collection:setPrinting', (itemId: number, scryfallId: string) =>
    setItemPrinting(itemId, scryfallId)
  )
  handle('collection:setLanguage', (itemId: number, lang: string) => setItemLanguage(itemId, lang))
  handle(
    'collection:forceLanguage',
    (itemId: number, lang: string | null, name?: string | null) => {
      forceItemLanguage(itemId, lang, name)
      return true
    }
  )

  // ---------- Cards ----------
  handle('cards:suggest', (query: string) => suggestNames(query))
  handle('cards:printings', (name: string) => printingsFor(name))
  // Same lookup, but reporting how many printings exist so the UI can say when it
  // is only showing the newest page of a heavily reprinted card.
  handle('cards:printingsPage', (name: string) => printingsPage(name))
  handle('cards:quickResolve', (set: string, cn: string, lang: string) =>
    resolveQuick(set, cn, lang)
  )
  handle('cards:quickAdd', (input: QuickAddInput) => quickAdd(input))
  handle('cards:printing', (scryfallId: string) => getPrinting(scryfallId))
  /*
    Copy a card's artwork to the system clipboard.
    Done here rather than in the renderer because the renderer cannot get at the
    bytes: `matomeru://` is allowed as an image source but not by `connect-src`, so
    `fetch` on it fails, and drawing to a canvas to read it back would taint the
    canvas across origins. The main process already has the file on disk.
  */
  handle('cards:copyImage', async (scryfallId: string) => {
    const path = await cachedImage(scryfallId, 'large')
    if (!path) return false
    const image = nativeImage.createFromPath(path)
    if (image.isEmpty()) return false
    clipboard.writeImage(image)
    return true
  })

  // ---------- Pick lists ----------
  handle('pickLists:list', () => listPickLists(getSettings().currency))
  handle('pickLists:create', (name: string, note?: string | null) => createPickList(name, note))
  handle('pickLists:rename', (id: number, name: string, note?: string | null) => {
    renamePickList(id, name, note)
    return true
  })
  handle('pickLists:items', (id: number) => getPickListItems(id, getSettings().currency))
  handle('pickLists:add', (pickListId: number | null, itemId: number, quantity: number) => {
    const target = pickListId ?? ensureDefaultPickList()
    return { pickListId: target, ...addToPickList(target, itemId, quantity) }
  })
  handle(
    'pickLists:addMany',
    (pickListId: number | null, entries: { itemId: number; quantity: number }[]) => {
      const target = pickListId ?? ensureDefaultPickList()
      let added = 0
      let capped = 0
      for (const entry of entries) {
        const result = addToPickList(target, entry.itemId, entry.quantity)
        added += result.added
        if (result.capped) capped += 1
      }
      return { pickListId: target, added, capped }
    }
  )
  handle('pickLists:setQuantity', (pickItemId: number, quantity: number) => {
    setPickItemQuantity(pickItemId, quantity)
    return true
  })
  handle('pickLists:removeItem', (pickItemId: number) => {
    removePickItem(pickItemId)
    return true
  })
  handle('pickLists:confirm', (id: number) => confirmPickList(id))
  handle('pickLists:cancel', (id: number) => {
    cancelPickList(id)
    return true
  })
  handle('pickLists:reopen', (id: number) => {
    reopenPickList(id)
    return true
  })
  handle('pickLists:delete', (id: number) => {
    deletePickList(id)
    return true
  })
  handle('pickLists:export', async (id: number) => {
    const items = getPickListItems(id, getSettings().currency)
    const result = await dialog.showSaveDialog({
      title: 'Export pick list',
      defaultPath: 'pick-list.csv',
      filters: [{ name: 'CSV', extensions: ['csv'] }]
    })
    if (result.canceled || !result.filePath) return { canceled: true, count: 0 }
    const count = await exportPickListCsv(
      result.filePath,
      items.map((item) => ({
        quantity: item.quantity,
        name: item.name,
        printed_name: item.printed_name,
        lang: item.lang,
        set_code: item.set_code,
        collector_number: item.collector_number,
        finish: item.finish,
        condition: item.condition,
        unit_value: item.unit_value
      }))
    )
    return { canceled: false, count, path: result.filePath }
  })

  // ---------- Decks ----------
  handle('decks:list', () => listDecks())
  handle('decks:breakdown', (deckId: number) =>
    deckBreakdown(deckId, getSettings().currency, getSettings().deckMatchExact)
  )
  handle('decks:syncUser', async (username?: string) => {
    const name = (username ?? getSettings().archidektUsername).trim()
    if (!name) throw new Error(tr('err.setUsername'))
    return syncUserDecks(name, broadcast)
  })
  handle('decks:addByUrl', (input: string) => addDeckByUrl(input, broadcast))
  handle('decks:delete', (deckId: number) => {
    deleteDeck(deckId)
    return true
  })
  handle('decks:labelColors', () => discoverLabelColors(getSettings().labelPossession))

  // Language overrides. Archidekt cannot record a language, so these say which
  // printing you actually own — which is also what the exact-printing match uses.
  // Scoped to the cards you selected: the renderer sends oracle ids, and the
  // set/number each lookup needs is read from the database rather than trusted.
  handle('decks:setCardsLanguage', (deckId: number, oracleIds: string[], lang: string) =>
    setCardsLanguage(deckId, oracleIds, lang, broadcast)
  )
  handle('decks:clearCardsLanguage', (deckId: number, oracleIds: string[]) =>
    clearCardsLanguage(deckId, oracleIds)
  )
  // Pick a printing yourself: no lookup, because the printing is already known.
  handle('decks:setCardPrinting', (deckId: number, oracleId: string, scryfallId: string) => {
    setCardPrinting(deckId, oracleId, scryfallId)
    return true
  })
  // Record the finish and foil treatment you physically hold, which Archidekt
  // cannot express and a deck sync would otherwise overwrite.
  handle(
    'decks:setCardFinish',
    (deckId: number, oracleIds: string[], finish: Finish | null, treatment?: string | null) => {
      for (const oracleId of oracleIds) setCardFinish(deckId, oracleId, finish, treatment)
      return oracleIds.length
    }
  )
  // Mark deck entries as filled by proxies. Playable, so they count as held.
  handle('decks:setCardProxied', (deckId: number, oracleIds: string[], proxied: boolean) => {
    for (const oracleId of oracleIds) setCardProxied(deckId, oracleId, proxied)
    return oracleIds.length
  })
  // Assert a language Scryfall has no printing for. Null clears the assertion.
  handle(
    'decks:forceCardLanguage',
    (deckId: number, oracleId: string, lang: string | null, name?: string | null) => {
      forceCardLanguage(deckId, oracleId, lang, name)
      return true
    }
  )

  // ---------- Booster odds ----------
  // Fetched per set on demand: a set file is a few MB of JSON, ~1.3MB on the wire
  // once brotli-compressed, distilled here into a small table and discarded.
  handle('boosters:load', (setCode: string) => loadBoosterOdds(setCode, broadcast))
  handle('boosters:forCard', (scryfallId: string, setCode: string) =>
    boosterOddsFor(scryfallId, setCode)
  )
  // One run for the whole collection, skipping the precon-only sets where
  // Scryfall's booster flag already answers the question.
  handle('boosters:sets', () => collectionBoosterSets())
  handle('boosters:loadForCollection', (refetch?: boolean) =>
    loadBoosterOddsForCollection(broadcast, refetch ?? false)
  )

  // ---------- Prices / stats / settings ----------
  handle('prices:refresh', () => refreshPrices(broadcast))
  handle('stats:get', () => collectionStats())
  handle('settings:get', () => getSettings())
  handle('settings:update', (patch: Partial<AppSettings>) => {
    const settings = updateSettings(patch)
    // Changing what a label colour means re-derives the flag on every deck card
    // from its stored label. Purely local, so it applies instantly without a
    // re-sync and without touching collection_items.
    if (patch.labelPossession !== undefined) {
      recomputeLabelPossession(settings.labelPossession)
    }
    return settings
  })

  // ---------- CSV ----------
  handle('csv:pickImport', async () => {
    const result = await dialog.showOpenDialog({
      title: 'Choose a CSV to import',
      properties: ['openFile'],
      filters: [{ name: 'CSV', extensions: ['csv', 'txt'] }]
    })
    if (result.canceled || !result.filePaths.length) return null
    return result.filePaths[0]
  })
  handle('csv:preview', (filePath: string) => previewCsv(filePath))
  handle('csv:dryRun', (filePath: string, map: CsvColumnMap) =>
    dryRunCsv(filePath, map, broadcast)
  )
  handle('csv:commit', (rows: CsvResolvedRow[]) => commitCsv(rows))
  handle('csv:writeRejects', async (rows: CsvResolvedRow[]) => {
    const result = await dialog.showSaveDialog({
      title: 'Save unresolved rows',
      defaultPath: 'matomeru-rejects.csv',
      filters: [{ name: 'CSV', extensions: ['csv'] }]
    })
    if (result.canceled || !result.filePath) return { canceled: true, count: 0 }
    const count = await writeRejects(result.filePath, rows)
    return { canceled: false, count, path: result.filePath }
  })
  handle('csv:export', async (filters: CollectionFilters) => {
    const result = await dialog.showSaveDialog({
      title: 'Export collection',
      defaultPath: 'matomeru-collection.csv',
      filters: [{ name: 'CSV', extensions: ['csv'] }]
    })
    if (result.canceled || !result.filePath) return { canceled: true, count: 0 }
    const count = await exportCollectionCsv(result.filePath, filters, getSettings().currency)
    return { canceled: false, count, path: result.filePath }
  })
}
