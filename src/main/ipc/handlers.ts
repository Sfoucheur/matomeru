import { app, BrowserWindow, clipboard, dialog, ipcMain, nativeImage, shell } from 'electron'
import type {
  AddCardInput,
  AppSettings,
  BackupStatus,
  CollectionFilters,
  Condition,
  CsvColumnMap,
  CsvResolvedRow,
  Finish,
  PickSource,
  ProgressEvent,
  QuickAddInput
} from '@shared/types'
import {
  bulkRemove,
  bulkUpdate,
  cardLocations,
  forceItemLanguage,
  queryCollection,
  matchingRowKeys,
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
  revertPickList,
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
  deckChoices,
  deckSourcesFor,
  forceCardLanguage,
  listDecks,
  recomputeLabelPossession,
  recordDeckError,
  setCardFinish,
  setCardPrinting,
  setCardProxied
} from '../db/repos/decks.js'
import { moveToCollection, moveToDeck, revertMove } from '../db/repos/moves.js'
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
import { applyLanguageToItem } from '../services/collectionLanguage.js'
import { setRowLanguages } from '../services/rowLanguage.js'
import {
  boosterOddsFor,
  collectionBoosterSets,
  loadBoosterOdds,
  loadBoosterOddsForCollection
} from '../services/boosterOdds.js'
import { createThrottledBroadcaster } from './progressThrottle.js'
import { refreshPrices } from '../services/priceSync.js'
import { fillEnglishPrices, fillEnglishPricesQuietly } from '../services/priceFill.js'
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
import {
  collectionKeyScope,
  moveScopes,
  withPickItems,
  deckLanguageScopes,
  deckOverrideScopes,
  pickListScopes,
  rowLanguageScopes,
  scryfallScope,
  scryfallScopeMany
} from '../db/undoScopes.js'
import {
  byId,
  byIds,
  clearUndoHistory,
  redo,
  undo,
  undoState,
  undoable,
  undoableAsync,
  wholeTable
} from '../db/undo.js'
import { getLocale, getRawSetting, setRawSetting } from '../db/repos/settings.js'
import {
  localTouchedSince,
  restoreFromRemote,
  saveToRemote,
  snapshot
} from '../services/backup.js'
import { driveStore, folderName, setFolderName } from '../services/googleDrive.js'
import {
  checkForUpdates,
  downloadUpdate,
  installUpdate,
  openReleasePage,
  updateState
} from '../services/updates.js'
import {
  connect as connectDrive,
  disconnect as disconnectDrive,
  hasBundledClient,
  hasRefreshToken,
  isConfigured
} from '../services/googleAuth.js'
import { hostname } from 'node:os'
import { logDir, logError, logFile, logInfo, logWarn } from '../services/log.js'
import { getDataDir, getDb } from '../db/connection.js'

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
      /*
        Logged here, once, for every channel there is. This wrapper already sees every
        failure the UI will ever show; until it wrote them down, a message could reach
        the screen and leave nothing behind for anyone to look at afterwards.
      */
      logError('ipc', `${channel} failed`, err)
      return { ok: false, error: (err as Error).message || 'Unexpected error' }
    }
  })
}

/**
 * Progress out to every window, throttled.
 *
 * Exported because the launch-time update check runs from `index.ts`, before any
 * handler has been called, and it should report through the same bar as everything
 * else rather than inventing a second channel.
 */
export const broadcastProgress = createThrottledBroadcaster((event: ProgressEvent) => {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send('app:progress', event)
  }
})

/** The name the handlers below have always used. */
const broadcast = broadcastProgress

export function registerHandlers(): void {
  // ---------- Collection ----------
  handle('collection:query', (filters: CollectionFilters, limit: number, offset: number) =>
    queryCollection(filters, getSettings().currency, limit, offset)
  )
  handle('collection:facets', (filters: CollectionFilters) =>
    queryFacets(filters, getSettings().currency)
  )
  /*
    Every row the filters match, for a select-all that means what it says.

    Read-only and not undoable: it answers a question, it changes nothing.
  */
  handle('collection:matchingKeys', (filters: CollectionFilters) =>
    matchingRowKeys(filters, getSettings().currency)
  )
  /*
    Scoped on the UNIQUE (scryfall_id, finish, condition) key rather than on an
    id, because the row may not exist yet — that is the whole point of an add.
    Getting this wrong is the one way a before/after journal fails silently, so
    every scope below is stated on something a new row already satisfies.
  */
  handle('collection:add', (input: AddCardInput) =>
    undoable('undo.addCard', [collectionKeyScope(input)], () => addCard(input))
  )
  handle('collection:setQuantity', (itemId: number, quantity: number) =>
    undoable('undo.setQuantity', [byId('collection_items', itemId)], () => {
      setQuantity(itemId, quantity)
      return true
    })
  )
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
    ) =>
      /*
        A finish or condition change moves the row across its own UNIQUE key, so
        it can merge into a sibling row and delete itself. Scoping the whole
        printing rather than this one id is what makes that undoable.
      */
      undoable('undo.editCopy', withPickItems(scryfallScope(itemId)), () => {
        updateItem(itemId, patch)
        return true
      })
  )
  handle('collection:remove', (itemId: number) =>
    undoable('undo.removeCopies', withPickItems(byId('collection_items', itemId)), () => {
      removeItem(itemId)
      return true
    })
  )
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
    ) =>
      undoable('undo.bulkEdit', withPickItems(scryfallScopeMany(ids)), () => {
        bulkUpdate(ids, patch)
        return true
      })
  )
  handle('collection:bulkRemove', (ids: number[]) =>
    undoable('undo.bulkRemove', withPickItems(byIds('collection_items', ids)), () => bulkRemove(ids))
  )
  handle('collection:locations', (scryfallId: string) => cardLocations(scryfallId))

  // Change which printing a copy you entered actually is, or assert a language
  // Scryfall has no printing for. The deck screen has had this; the collection
  // had no way to correct a printing at all short of deleting every copy.
  handle('collection:setPrinting', (itemId: number, scryfallId: string) =>
    // Two printings are in play: the one it is and the one it becomes, which it
    // may merge into.
    undoable(
      'undo.setPrinting',
      withPickItems(scryfallScope(itemId), {
        table: 'collection_items',
        where: 'scryfall_id = ?',
        params: [scryfallId]
      }),
      () => setItemPrinting(itemId, scryfallId)
    )
  )
  /*
    A language change is a *repoint*: the row moves onto the printing that is in that
    language, which Scryfall has to be asked for first.

    Two things about the wrapper, both of which were wrong here. It has to be
    `undoableAsync`, because `undoable` snapshots the after-image the moment the function
    returns -- and an async function returns a promise before it has written anything, so
    the two images were identical and redo did nothing. And the scope has to go through
    `withPickItems`, because a repoint can merge two rows and delete one, which an open
    list's `collection_item_id` follows with ON DELETE SET NULL.
  */
  handle('collection:setLanguage', (itemId: number, lang: string) =>
    undoableAsync('undo.setLanguage', withPickItems(scryfallScope(itemId)), async () => {
      // One row, so one extra request at most: the English twin of whatever it just became,
      // without which a French row shows no price at all.
      const cached: string[] = []
      const outcome = await applyLanguageToItem(itemId, lang, cached)
      // Quietly: the row is already converted, and `undoableAsync` records the step only
      // once this resolves -- a throw here would leave the change with no way back.
      await fillEnglishPricesQuietly(cached)
      return outcome
    })
  )
  /*
    The same, for a whole selection — and it takes the selection's own row keys.

    Not ids. The Collection screen lists copies you entered alongside copies sleeved in a
    synced deck, and a sleeved row has no id, so mapping the selection to ids dropped
    every one of them silently. The keys say which kind each row is, so nothing has to be
    guessed and nothing can be quietly left out.

    Renamed with the signature, deliberately. This boundary is not type-checked, so a call
    site left passing `number[]` would parse to zero targets and do nothing at all — the
    very failure being fixed. A channel that no longer exists is loud instead.
  */
  handle('collection:setRowLanguages', (keys: string[], lang: string) =>
    undoableAsync('undo.bulkSetLanguage', rowLanguageScopes(), () =>
      setRowLanguages(keys, lang, broadcast)
    )
  )
  handle(
    'collection:forceLanguage',
    (itemId: number, lang: string | null, name?: string | null) =>
      undoable('undo.forceLanguage', [byId('collection_items', itemId)], () => {
        forceItemLanguage(itemId, lang, name)
        return true
      })
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
  /*
    quickAdd resolves the printing itself, so the row's identity is not knowable
    from the arguments. Scoped on the printing that matches the set, number and
    language it was given — the same lookup quickAdd performs — rather than on
    the whole table, which would journal every row you own for one add.
  */
  handle('cards:quickAdd', async (input: QuickAddInput) => {
    const printing = await resolveQuick(input.set, input.collectorNumber, input.lang)
    if (!printing) return quickAdd(input)
    return undoableAsync(
      'undo.addCard',
      [
        {
          table: 'collection_items',
          where: 'scryfall_id = ? AND finish = ? AND condition = ?',
          params: [printing.scryfall_id, input.finish, input.condition]
        }
      ],
      () => quickAdd(input)
    )
  })
  handle('cards:printing', (scryfallId: string) => getPrinting(scryfallId))
  /*
    Copy a card's artwork to the system clipboard.
    Done here rather than in the renderer because the renderer cannot get at the
    bytes: `matomeru://` is allowed as an image source but not by `connect-src`, so
    `fetch` on it fails, and drawing to a canvas to read it back would taint the
    canvas across origins. The main process already has the file on disk.
  */
  handle('cards:copyImage', async (scryfallId: string, face: 0 | 1 = 0) => {
    // The face matters: what lands on the clipboard has to be the side being looked at,
    // and `cachedImage` already keys on it so the front is never handed back for a back.
    const path = await cachedImage(scryfallId, 'large', face)
    if (!path) return false
    const image = nativeImage.createFromPath(path)
    if (image.isEmpty()) return false
    clipboard.writeImage(image)
    return true
  })

  // ---------- Pick lists ----------
  handle('pickLists:list', () => listPickLists(getSettings().currency))
  handle('pickLists:create', (name: string, note?: string | null) =>
    undoable('undo.createList', [wholeTable('pick_lists')], () => createPickList(name, note))
  )
  handle('pickLists:rename', (id: number, name: string, note?: string | null) =>
    undoable('undo.renameList', [byId('pick_lists', id)], () => {
      renamePickList(id, name, note)
      return true
    })
  )
  handle('pickLists:items', (id: number) => getPickListItems(id, getSettings().currency))
  handle('pickLists:add', (pickListId: number | null, source: PickSource, quantity: number) =>
    // The list itself is in scope because a null target creates one.
    undoable('undo.stage', [wholeTable('pick_lists'), wholeTable('pick_list_items')], () => {
      const target = pickListId ?? ensureDefaultPickList()
      return { pickListId: target, ...addToPickList(target, source, quantity) }
    })
  )
  handle(
    'pickLists:addMany',
    (pickListId: number | null, entries: { source: PickSource; quantity: number }[]) =>
      // One step for the whole batch: staging thirty rows was one action, so it
      // should be one Ctrl+Z rather than thirty.
      undoable('undo.stage', [wholeTable('pick_lists'), wholeTable('pick_list_items')], () => {
        const target = pickListId ?? ensureDefaultPickList()
        let added = 0
        let capped = 0
        for (const entry of entries) {
          const result = addToPickList(target, entry.source, entry.quantity)
          added += result.added
          if (result.capped) capped += 1
        }
        return { pickListId: target, added, capped }
      })
  )
  handle('pickLists:setQuantity', (pickItemId: number, quantity: number) =>
    /*
      Two scopes: setting a staged quantity to zero removes the row entirely, and
      it is addressed by its own id, so the list is scoped too — otherwise undoing
      would restore an item whose parent had also gone.
    */
    undoable(
      'undo.stageQuantity',
      [wholeTable('pick_lists'), byId('pick_list_items', pickItemId)],
      () => {
        setPickItemQuantity(pickItemId, quantity)
        return true
      }
    )
  )
  handle('pickLists:removeItem', (pickItemId: number) =>
    undoable('undo.unstage', [byId('pick_list_items', pickItemId)], () => {
      removePickItem(pickItemId)
      return true
    })
  )
  /*
    The widest step in the app. Validating a pull touches four tables at once, and
    `collection_items` has to be scoped on the printings involved rather than on
    ids: a row emptied by the confirm is deleted and comes back with a new id, so
    an id-based scope would not see it return.
  */
  handle('pickLists:confirm', (id: number) =>
    undoable('undo.validatePull', pickListScopes(id), () => confirmPickList(id))
  )
  handle('pickLists:cancel', (id: number) =>
    undoable('undo.cancelList', [byId('pick_lists', id)], () => {
      cancelPickList(id)
      return true
    })
  )
  // Undoes a validated pull: cards go back to the collection, and pulled copies
  // back into their decks. The list returns to open.
  handle('pickLists:revert', (id: number) =>
    undoable('undo.revertPull', pickListScopes(id), () => revertPickList(id))
  )
  handle('pickLists:reopen', (id: number) =>
    undoable('undo.reopenList', [byId('pick_lists', id)], () => {
      reopenPickList(id)
      return true
    })
  )
  handle('pickLists:delete', (id: number) =>
    undoable('undo.deleteList', pickListScopes(id), () => {
      deletePickList(id)
      return true
    })
  )
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
  /*
    Syncs are not undoable, and they clear the history.

    A sync rewrites every card row of every deck it touches, so a step recorded
    before it describes rows that may no longer exist — restoring that image could
    resurrect deck cards the sync had removed, or reattach an override to an entry
    that has gone. Losing the ability to undo edits made before a sync is a much
    smaller cost than applying a step to state it was never recorded against.

    They also do not need undoing: both refetch from Archidekt and can be run
    again.
  */
  handle('decks:syncUser', async (username?: string) => {
    const name = (username ?? getSettings().archidektUsername).trim()
    if (!name) throw new Error(tr('err.setUsername'))
    const result = await syncUserDecks(name, broadcast)
    clearUndoHistory()

    /*
      And the backup marker goes with it. It recorded when *this* machine last
      uploaded, which said something about the database that was just replaced; the
      database now on disk was written seconds ago and has never been backed up from
      here. Leaving the old timestamp would make the next Ctrl+S report "up to date"
      about a file it has never sent.
    */
    setRawSetting(KEY_LAST_AT, null)
    return result
  })
  /*
    One deck, re-fetched now.

    `addDeckByUrl` is the sequence rather than `syncOneDeck` on its own, deliberately:
    `syncOneDeck` leaves `cacheDeckPrintings` and `recomputeLabelPossession` to its callers,
    and skipping the first leaves deck cards with no printing row — no images, no prices.
    Reusing the wrapper means a fourth step added tomorrow reaches this path too. Its name
    says "add"; what it does is fetch one deck properly, and `upsertDeck` conflicts on
    (source, external_id) so it refreshes rather than duplicating.

    It also never consults the unchanged-skip `syncUserDecks` applies, which is the whole
    point of a button: a deck whose labels changed in Archidekt without its `updatedAt`
    moving is otherwise skipped by the all-decks sync indefinitely.
  */
  handle('decks:syncOne', async (externalId: string) => {
    try {
      const result = await addDeckByUrl(externalId, broadcast)
      clearUndoHistory()
      // The backup marker goes with it, for the reason `decks:syncUser` gives.
      setRawSetting(KEY_LAST_AT, null)
      return result
    } catch (error) {
      /*
        Recorded on the deck, not merely thrown. A toast disappears; the lock icon and the
        note beside the deck are what tell you tomorrow that this one is private or gone,
        and the all-decks sync already works that way.
      */
      const archidekt = error as { message?: string; likelyPrivate?: boolean }
      recordDeckError(
        externalId,
        { is_private: archidekt.likelyPrivate ?? false },
        archidekt.message ?? String(error)
      )
      throw error
    }
  })
  handle('decks:addByUrl', async (input: string) => {
    const result = await addDeckByUrl(input, broadcast)
    clearUndoHistory()
    return result
  })
  /*
    Deleting a deck cascades to its cards, overrides, language requests and pull
    markers, so all five tables are in scope. Scoped per deck rather than whole:
    a deck's rows are the only ones that can move, and `deck_cards` can hold
    hundreds of rows a whole-table image would copy for nothing.
  */
  handle('decks:delete', (deckId: number) =>
    undoable(
      'undo.deleteDeck',
      [
        byId('decks', deckId),
        { table: 'deck_cards', where: 'deck_id = ?', params: [deckId] },
        { table: 'deck_card_overrides', where: 'deck_id = ?', params: [deckId] },
        { table: 'deck_card_lang_requests', where: 'deck_id = ?', params: [deckId] },
        { table: 'deck_card_moves', where: 'deck_id = ?', params: [deckId] }
      ],
      () => {
        deleteDeck(deckId)
        return true
      }
    )
  )
  handle('decks:labelColors', () => discoverLabelColors(getSettings().labelPossession))
  /*
    Which decks a staged copy could come from. Asked on demand rather than
    carried on every collection row: a derived row groups a card across every
    deck holding it, so the answer is only needed at the moment someone stages
    one, and putting it on the row would mean a GROUP_CONCAT of deck names that
    any name containing a comma would break.
  */
  handle('decks:pullSources', (scryfallId: string, finish: string) =>
    deckSourcesFor(scryfallId, finish)
  )
  // Every deck, for the chooser that asks where to put a card.
  handle('decks:choices', () => deckChoices())
  /*
    Moving cards between a deck and the collection, directly. Immediate and
    lossless: the card is yours before and after, it has only changed where it
    lives — which is what makes it a different act from a pick list.
  */
  handle(
    'decks:moveToCollection',
    (deckId: number, oracleId: string, quantity: number, scryfallId?: string | null) =>
      undoable('undo.moveToCollection', moveScopes(deckId), () =>
        moveToCollection(deckId, oracleId, quantity, scryfallId)
      )
  )
  handle('decks:moveToDeck', (deckId: number, itemId: number, quantity: number) =>
    undoable('undo.moveToDeck', moveScopes(deckId), () => moveToDeck(deckId, itemId, quantity))
  )
  handle('decks:revertMove', (moveId: number) =>
    undoable('undo.revertMove', moveScopes(null), () => revertMove(moveId))
  )

  // Language overrides. Archidekt cannot record a language, so these say which
  // printing you actually own — which is also what the exact-printing match uses.
  // Scoped to the cards you selected: the renderer sends oracle ids, and the
  // set/number each lookup needs is read from the database rather than trusted.
  handle('decks:setCardsLanguage', (deckId: number, oracleIds: string[], lang: string) =>
    // Async: this looks the printing up on Scryfall before writing anything.
    // The deck row is in scope too: applying a language remembers it there.
    undoableAsync('undo.setDeckLanguage', deckLanguageScopes(deckId), () =>
      setCardsLanguage(deckId, oracleIds, lang, broadcast)
    )
  )
  handle('decks:clearCardsLanguage', (deckId: number, oracleIds: string[]) =>
    undoable('undo.clearDeckOverride', deckOverrideScopes(deckId), () =>
      clearCardsLanguage(deckId, oracleIds)
    )
  )
  // Pick a printing yourself: no lookup, because the printing is already known.
  handle('decks:setCardPrinting', (deckId: number, oracleId: string, scryfallId: string) =>
    undoable('undo.setDeckPrinting', deckOverrideScopes(deckId), () => {
      setCardPrinting(deckId, oracleId, scryfallId)
      return true
    })
  )
  // Record the finish and foil treatment you physically hold, which Archidekt
  // cannot express and a deck sync would otherwise overwrite.
  handle(
    'decks:setCardFinish',
    (deckId: number, oracleIds: string[], finish: Finish | null, treatment?: string | null) =>
      undoable('undo.setDeckFinish', deckOverrideScopes(deckId), () => {
        for (const oracleId of oracleIds) setCardFinish(deckId, oracleId, finish, treatment)
        return oracleIds.length
      })
  )
  // Mark deck entries as filled by proxies. Playable, so they count as held.
  handle('decks:setCardProxied', (deckId: number, oracleIds: string[], proxied: boolean) =>
    undoable('undo.setProxied', deckOverrideScopes(deckId), () => {
      for (const oracleId of oracleIds) setCardProxied(deckId, oracleId, proxied)
      return oracleIds.length
    })
  )
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
  /*
    Filling in the English prices by hand, for anyone who does not want to wait for the
    once-per-version run -- or who was offline when it happened.
  */
  handle('prices:fill', () => fillEnglishPrices(undefined, broadcast))
  handle('stats:get', () => collectionStats())
  handle('settings:get', () => getSettings())
  // ---------- Undo / redo ----------
  /*
    Session-only, and held here rather than in the renderer because this is where
    the database is. `settings:update` is deliberately absent: changing a currency
    or a theme is not the kind of edit Ctrl+Z should take back, and it also
    recomputes label possession across every deck, which is not a row-level change
    a journal can meaningfully reverse.
  */
  handle('undo:undo', () => undo())
  handle('undo:redo', () => redo())
  handle('undo:state', () => undoState())

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

  // ---------- Backup ----------

  /*
    The keys the renderer never sees. `getSettings()` reads named fields and ignores
    everything else, so these live in the same table without being handed out — and
    the client secret and refresh token are not among them at all: those are sealed
    with safeStorage inside googleAuth, and nothing here can read them back.
  */
  const KEY_LAST_AT = 'backup.lastBackupAt'

  handle('backup:status', async (): Promise<BackupStatus> => {
    const configured = isConfigured()
    const connected = configured && hasRefreshToken()
    const lastBackupAt = getRawSetting(KEY_LAST_AT)
    const folder = folderName()
    const base: BackupStatus = {
      configured,
      bundled: hasBundledClient(),
      folderName: folder,
      connected,
      label: folder,
      lastBackupAt,
      remote: null,
      remoteIsNewer: false,
      upToDate: false,
      error: null
    }
    if (!connected) return base

    const store = driveStore()
    try {
      const remote = await store.stat()
      if (!remote?.manifest) return { ...base, label: store.label() }
      const manifest = remote.manifest
      return {
        ...base,
        label: store.label(),
        remote: { ...manifest, bytes: remote.bytes },
        // Another machine wrote something we have never pulled down.
        remoteIsNewer:
          manifest.machine !== hostname() && manifest.snapshotAt > (lastBackupAt ?? ''),
        // The same test the save itself applies, so the dialog cannot promise one
        // thing and the action do another.
        upToDate: !localTouchedSince(lastBackupAt)
      }
    } catch (err) {
      // A revoked token or a dead network must not stop the dialog opening; it
      // reports what went wrong instead of failing to appear.
      return { ...base, error: (err as Error).message }
    }
  })

  handle('backup:connect', async () => {
    await connectDrive()
    return true
  })

  handle('backup:disconnect', () => {
    disconnectDrive()
    return true
  })

  /**
   * Naming the folder backups go into.
   *
   * A name rather than a folder browsed to in Drive. Browsing would mean either
   * Google's Picker — which needs a second credential and its own window — or the
   * full `drive` scope, which is restricted, verification-gated, and would make the
   * consent screen say this app can read everything you own. Under `drive.file` the
   * app can create and reuse a folder of its own perfectly well; what it cannot do is
   * list the ones it did not create. So: you name it, the app makes it, and you can
   * drag it anywhere in Drive afterwards because it is tracked by id.
   */
  handle('backup:setFolderName', (name: string) => setFolderName(name))

  handle('backup:save', async (force = false) => {
    if (!isConfigured()) throw new Error(tr('err.backupNotConfigured'))
    if (!hasRefreshToken()) throw new Error(tr('err.backupNotConnected'))
    const store = driveStore()

    /*
      The clobber guard, enforced here and not only in the dialog.

      The renderer asks for the acknowledgement, but a guard that lives only in the
      renderer is a guard that a second window, a stale dialog, or a future call
      site walks straight past. `force` is the acknowledgement crossing the wire.
    */
    if (!force) {
      const remote = await store.stat()
      const manifest = remote?.manifest
      const lastBackupAt = getRawSetting(KEY_LAST_AT)
      if (
        manifest &&
        manifest.machine !== hostname() &&
        manifest.snapshotAt > (lastBackupAt ?? '')
      ) {
        throw new Error(
          tr('err.backupWouldClobber', { machine: manifest.machine })
        )
      }
    }

    const result = await saveToRemote(store, broadcast, getRawSetting(KEY_LAST_AT))
    if (result.uploaded) setRawSetting(KEY_LAST_AT, result.at)
    return result
  })

  handle('backup:restore', async () => {
    if (!isConfigured()) throw new Error(tr('err.backupNotConfigured'))
    if (!hasRefreshToken()) throw new Error(tr('err.backupNotConnected'))
    const result = await restoreFromRemote(driveStore(), broadcast)

    /*
      The undo journal describes rows in the database that was just replaced. Its
      before-images point at ids that may now mean different cards, so replaying one
      would corrupt rather than undo — the same reasoning that clears it after a deck
      sync, only more so.
    */
    clearUndoHistory()

    /*
      Relaunch rather than reopen. `invalidate()` only refreshes the visible view,
      and a restore also replaces settings, theme, locale, the first-paint theme
      hint in localStorage, and every piece of session state — selections, filters,
      the open deck, a half-finished CSV import. Restarting resets all of it
      provably; reloading each part by hand is a list nobody keeps correct.

      Deferred so this reply reaches the renderer first, which is what lets it say
      what happened before the window goes.
    */
    setTimeout(() => {
      app.relaunch()
      app.quit()
    }, 500)
    return result
  })

  /** The snapshot alone, for the tests and for a status read that wants real bytes. */
  handle('backup:snapshotSize', async () => {
    const { bytes } = await snapshot()
    return bytes
  })

  // ---------- Updates ----------

  /*
    Four verbs, and none of them do more than they say. A check reports; a download
    downloads; installing quits. The renderer decides which to offer from the mode in
    the state, so a portable build never sees a button that cannot work.
  */
  handle('updates:state', () => updateState())
  handle('updates:check', () => checkForUpdates(broadcast))
  handle('updates:download', () => downloadUpdate(broadcast))
  handle('updates:install', () => installUpdate(broadcast))
  handle('updates:openRelease', () => openReleasePage())

  // ---------- Diagnostics ----------

  /*
    Reaching the logs without a terminal, which is the whole point: a packaged Electron
    app on Windows has no console, so "look at the output" is not advice anyone can act
    on. `shell.openPath` hands the file to whatever the user reads text with.
  */
  /*
    The renderer's own crashes. An uncaught render error used to be a blank window and
    silence; now it reaches the same file as everything else, tagged so its origin is
    obvious in the log.
  */
  handle('logs:record', (level: 'error' | 'warn' | 'info', message: string) => {
    if (level === 'error') logError('renderer', message)
    else if (level === 'warn') logWarn('renderer', message)
    else logInfo('renderer', message)
    return true
  })

  handle('logs:openFile', () => shell.openPath(logFile()))
  handle('logs:openFolder', () => shell.openPath(logDir()))

  /**
   * The answers to the questions a bug report always needs, on the clipboard.
   *
   * Deliberately no secrets and no card data: versions, paths, the update mode, whether
   * Drive is connected, and how much is in the database. Enough to place a report,
   * nothing anyone would mind pasting into a public issue.
   */
  handle('diagnostics:copy', () => {
    const settings = getSettings()
    const report = [
      `Matomeru ${app.getVersion()}`,
      `electron ${process.versions.electron} · chrome ${process.versions.chrome} · node ${process.versions.node}`,
      `platform ${process.platform} ${process.arch}`,
      `packaged ${app.isPackaged}${process.env.PORTABLE_EXECUTABLE_DIR ? ' (portable)' : ''}`,
      `update mode ${updateState().mode}`,
      `locale ${settings.locale} · theme ${settings.theme}/${settings.themeMode}`,
      `drive ${hasBundledClient() ? 'client compiled in' : 'no client'}, ${
        hasRefreshToken() ? 'connected' : 'not connected'
      }, folder "${folderName()}"`,
      `data ${getDataDir()}`,
      `log ${logFile()}`,
      ...(
        [
          ['collection_items', 'collection rows'],
          ['decks', 'decks'],
          ['pick_lists', 'pick lists'],
          ['printings', 'cached printings']
        ] as const
      ).map(([table, label]) => {
        const row = getDb().get(`SELECT COUNT(*) AS n FROM ${table}`) as { n: number }
        return `${label} ${row.n}`
      })
    ].join('\n')
    clipboard.writeText(report)
    return report
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
