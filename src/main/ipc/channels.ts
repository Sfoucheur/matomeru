/** Every IPC channel name in one place, so main and preload cannot drift apart. */
export const CH = {
  // Collection
  collectionQuery: 'collection:query',
  collectionFacets: 'collection:facets',
  collectionAdd: 'collection:add',
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
  pickListsRemoveItem: 'pickLists:removeItem',
  pickListsConfirm: 'pickLists:confirm',
  pickListsCancel: 'pickLists:cancel',
  pickListsReopen: 'pickLists:reopen',
  pickListsDelete: 'pickLists:delete',
  pickListsExport: 'pickLists:export',

  // Decks
  decksList: 'decks:list',
  decksBreakdown: 'decks:breakdown',
  decksSyncUser: 'decks:syncUser',
  decksAddByUrl: 'decks:addByUrl',
  decksDelete: 'decks:delete',
  decksLabelColors: 'decks:labelColors',

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
