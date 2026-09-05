/** Every IPC channel name in one place, so main and preload cannot drift apart. */
export const CH = {
  // Collection
  collectionQuery: 'collection:query',
  collectionMatchingKeys: 'collection:matchingKeys',
  collectionSetLanguages: 'collection:setLanguages',
  collectionFacets: 'collection:facets',
  collectionAdd: 'collection:add',
  collectionAddVariant: 'collection:addVariant',
  collectionSetQuantity: 'collection:setQuantity',
  collectionUpdate: 'collection:update',
  collectionRemove: 'collection:remove',
  collectionBulkUpdate: 'collection:bulkUpdate',
  collectionBulkRemove: 'collection:bulkRemove',
  collectionLocations: 'collection:locations',

  // Cards / Scryfall
  cardsSuggest: 'cards:suggest',
  cardsPrintings: 'cards:printings',
  cardsQuickResolve: 'cards:quickResolve',
  cardsQuickAdd: 'cards:quickAdd',
  cardsPrinting: 'cards:printing',

  // Pick lists
  pickListsList: 'pickLists:list',
  pickListsCreate: 'pickLists:create',
  pickListsRename: 'pickLists:rename',
  pickListsItems: 'pickLists:items',
  pickListsAdd: 'pickLists:add',
  pickListsAddMany: 'pickLists:addMany',
  pickListsSetQuantity: 'pickLists:setQuantity',
  pickListsSetItemSource: 'pickLists:setItemSource',
  pickListsRemoveItem: 'pickLists:removeItem',
  pickListsConfirm: 'pickLists:confirm',
  pickListsCancel: 'pickLists:cancel',
  pickListsReopen: 'pickLists:reopen',
  pickListsRevert: 'pickLists:revert',
  pickListsDelete: 'pickLists:delete',
  pickListsExport: 'pickLists:export',

  // Decks
  decksList: 'decks:list',
  decksBreakdown: 'decks:breakdown',
  decksSyncUser: 'decks:syncUser',
  decksSyncOne: 'decks:syncOne',
  decksAddByUrl: 'decks:addByUrl',
  decksDelete: 'decks:delete',
  decksLabelColors: 'decks:labelColors',
  decksPullSources: 'decks:pullSources',
  decksChoices: 'decks:choices',
  decksMoveToCollection: 'decks:moveToCollection',
  decksMoveToDeck: 'decks:moveToDeck',
  decksRevertMove: 'decks:revertMove',

  // Undo / redo
  undoUndo: 'undo:undo',
  undoRedo: 'undo:redo',
  undoState: 'undo:state',

  // Prices / stats / settings
  pricesRefresh: 'prices:refresh',
  statsGet: 'stats:get',
  settingsGet: 'settings:get',
  settingsUpdate: 'settings:update',

  // CSV
  csvPickImport: 'csv:pickImport',
  csvPreview: 'csv:preview',
  csvDryRun: 'csv:dryRun',
  csvCommit: 'csv:commit',
  csvWriteRejects: 'csv:writeRejects',
  csvExport: 'csv:export',

  // Events pushed from main to renderer
  progress: 'app:progress'
} as const
