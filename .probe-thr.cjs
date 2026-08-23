var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));

// src/main/db/connection.ts
var import_node_fs = require("node:fs");
var import_node_path = require("node:path");
var import_node_sqlite3_wasm = __toESM(require("node-sqlite3-wasm"), 1);

// src/main/db/schema.ts
var MIGRATIONS = [
  {
    version: 1,
    name: "initial",
    sql: `
      -- One row per language-specific Scryfall printing. This is the table that
      -- carries the language information: the JA and FR printings of a card are
      -- separate rows with distinct scryfall_ids.
      CREATE TABLE printings (
        scryfall_id       TEXT PRIMARY KEY,
        oracle_id         TEXT,
        name              TEXT NOT NULL,
        printed_name      TEXT,
        lang              TEXT NOT NULL,
        set_code          TEXT NOT NULL,
        set_name          TEXT NOT NULL,
        collector_number  TEXT NOT NULL,
        rarity            TEXT NOT NULL,
        mana_cost         TEXT,
        cmc               REAL,
        type_line         TEXT,
        printed_type_line TEXT,
        oracle_text       TEXT,
        colors            TEXT NOT NULL DEFAULT '[]',
        color_identity    TEXT NOT NULL DEFAULT '[]',
        layout            TEXT NOT NULL DEFAULT 'normal',
        finishes          TEXT NOT NULL DEFAULT '["nonfoil"]',
        image_uri_normal  TEXT,
        image_uri_small   TEXT,
        released_at       TEXT,
        prices_json       TEXT,
        price_updated_at  TEXT,
        -- The whole Scryfall object, so future features never need a re-fetch.
        raw_json          TEXT,
        fetched_at        TEXT NOT NULL
      );
      CREATE INDEX idx_printings_name ON printings(name);
      CREATE INDEX idx_printings_printed_name ON printings(printed_name);
      CREATE INDEX idx_printings_lang ON printings(lang);
      CREATE INDEX idx_printings_rarity ON printings(rarity);
      CREATE INDEX idx_printings_set ON printings(set_code);
      CREATE INDEX idx_printings_oracle ON printings(oracle_id);
      CREATE INDEX idx_printings_set_cn_lang ON printings(set_code, collector_number, lang);

      -- What you actually own. The UNIQUE constraint is what makes re-adding the
      -- same card bump the quantity instead of creating a duplicate row.
      CREATE TABLE collection_items (
        id             INTEGER PRIMARY KEY AUTOINCREMENT,
        scryfall_id    TEXT NOT NULL REFERENCES printings(scryfall_id) ON DELETE CASCADE,
        finish         TEXT NOT NULL DEFAULT 'nonfoil',
        condition      TEXT NOT NULL DEFAULT 'NM',
        quantity       INTEGER NOT NULL CHECK (quantity >= 0),
        purchase_price REAL,
        notes          TEXT,
        added_at       TEXT NOT NULL,
        updated_at     TEXT NOT NULL,
        UNIQUE (scryfall_id, finish, condition)
      );
      CREATE INDEX idx_collection_scryfall ON collection_items(scryfall_id);

      CREATE TABLE pick_lists (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        name       TEXT NOT NULL,
        status     TEXT NOT NULL DEFAULT 'open',
        created_at TEXT NOT NULL,
        closed_at  TEXT,
        note       TEXT
      );
      CREATE INDEX idx_pick_lists_status ON pick_lists(status);

      -- Items carry a denormalized snapshot so a confirmed pick list still reads
      -- correctly after the collection row it came from has been emptied and deleted.
      CREATE TABLE pick_list_items (
        id                 INTEGER PRIMARY KEY AUTOINCREMENT,
        pick_list_id       INTEGER NOT NULL REFERENCES pick_lists(id) ON DELETE CASCADE,
        collection_item_id INTEGER REFERENCES collection_items(id) ON DELETE SET NULL,
        quantity           INTEGER NOT NULL CHECK (quantity > 0),
        scryfall_id        TEXT NOT NULL,
        name               TEXT NOT NULL,
        printed_name       TEXT,
        lang               TEXT NOT NULL,
        set_code           TEXT NOT NULL,
        set_name           TEXT NOT NULL,
        collector_number   TEXT NOT NULL,
        rarity             TEXT NOT NULL,
        finish             TEXT NOT NULL,
        condition          TEXT NOT NULL,
        image_uri_small    TEXT,
        created_at         TEXT NOT NULL
      );
      CREATE INDEX idx_pli_list ON pick_list_items(pick_list_id);
      CREATE INDEX idx_pli_item ON pick_list_items(collection_item_id);
      CREATE INDEX idx_pli_scryfall ON pick_list_items(scryfall_id);

      -- Synced Archidekt decks. Read-only reference data: syncing must never
      -- change what the app thinks you own.
      CREATE TABLE decks (
        id                  INTEGER PRIMARY KEY AUTOINCREMENT,
        source              TEXT NOT NULL DEFAULT 'archidekt',
        external_id         TEXT NOT NULL,
        name                TEXT NOT NULL,
        format              TEXT,
        owner_username      TEXT,
        url                 TEXT,
        external_updated_at TEXT,
        last_synced_at      TEXT,
        is_private          INTEGER NOT NULL DEFAULT 0,
        is_unlisted         INTEGER NOT NULL DEFAULT 0,
        sync_error          TEXT,
        raw_json            TEXT,
        UNIQUE (source, external_id)
      );

      CREATE TABLE deck_cards (
        id               INTEGER PRIMARY KEY AUTOINCREMENT,
        deck_id          INTEGER NOT NULL REFERENCES decks(id) ON DELETE CASCADE,
        -- From Archidekt card.uid: the Scryfall printing id (exact match key).
        scryfall_id      TEXT,
        -- From Archidekt card.oracleCard.uid: the Scryfall oracle id (fallback key).
        oracle_id        TEXT,
        quantity         INTEGER NOT NULL DEFAULT 1,
        finish           TEXT NOT NULL DEFAULT 'nonfoil',
        categories       TEXT NOT NULL DEFAULT '[]',
        in_maindeck      INTEGER NOT NULL DEFAULT 1,
        name             TEXT NOT NULL,
        lang             TEXT NOT NULL DEFAULT 'en',
        set_code         TEXT,
        collector_number TEXT,
        rarity           TEXT,
        image_uri_small  TEXT
      );
      CREATE INDEX idx_deck_cards_deck ON deck_cards(deck_id);
      CREATE INDEX idx_deck_cards_scryfall ON deck_cards(scryfall_id);
      CREATE INDEX idx_deck_cards_oracle ON deck_cards(oracle_id);

      CREATE TABLE settings (
        key   TEXT PRIMARY KEY,
        value TEXT
      );
    `
  },
  {
    version: 2,
    name: "printed_text_and_deck_labels",
    sql: `
      -- Localized rules text, for the card detail view. Without this a Japanese
      -- card would show English rules, which undercuts the whole point.
      ALTER TABLE printings ADD COLUMN printed_text TEXT;

      -- Archidekt's per-card label, stored raw as "name,#color". Keeping the raw
      -- string means the "I don't own this" flag can be recomputed locally when
      -- the setting changes, with no re-sync.
      ALTER TABLE deck_cards ADD COLUMN label     TEXT;
      ALTER TABLE deck_cards ADD COLUMN not_owned INTEGER NOT NULL DEFAULT 0;

      -- Backfill from the Scryfall object we already keep, so existing
      -- collections gain printed text without touching the network.
      UPDATE printings SET printed_text = json_extract(raw_json, '$.printed_text')
        WHERE raw_json IS NOT NULL;

      -- Force one re-sync of every deck. syncUserDecks skips decks whose
      -- Archidekt updatedAt is unchanged, so without this deck_cards.label would
      -- stay NULL forever on an existing database and the feature would silently
      -- never work.
      UPDATE decks SET external_updated_at = NULL;

      CREATE INDEX idx_deck_cards_not_owned ON deck_cards(not_owned);
    `
  },
  {
    version: 3,
    name: "label_possession_tristate",
    sql: `
      -- One tristate column replaces the boolean, so a label colour cannot be
      -- both "owned" and "not owned" at once. NULL means the colour is ignored
      -- and ownership comes purely from the collection.
      ALTER TABLE deck_cards ADD COLUMN label_possession TEXT;

      UPDATE deck_cards SET label_possession = 'not_owned' WHERE not_owned = 1;

      DROP INDEX IF EXISTS idx_deck_cards_not_owned;
      ALTER TABLE deck_cards DROP COLUMN not_owned;
      CREATE INDEX idx_deck_cards_possession ON deck_cards(label_possession);
    `
  },
  {
    version: 4,
    name: "deck_language_overrides",
    sql: `
      -- Archidekt has no language field, so the printing it reports is always the
      -- English one. This records which printing you actually own for a deck entry.
      --
      -- It cannot live on deck_cards: replaceDeckCards deletes and reinserts a
      -- deck's rows on every sync, which would destroy the override. Keyed on
      -- oracle_id rather than the synced printing, so it also survives Archidekt
      -- switching the entry to a different printing.
      CREATE TABLE deck_card_overrides (
        deck_id     INTEGER NOT NULL REFERENCES decks(id) ON DELETE CASCADE,
        oracle_id   TEXT    NOT NULL,
        scryfall_id TEXT    NOT NULL,
        lang        TEXT    NOT NULL,
        created_at  TEXT    NOT NULL,
        PRIMARY KEY (deck_id, oracle_id)
      );
      CREATE INDEX idx_overrides_deck ON deck_card_overrides(deck_id);

      -- A whole-deck default that per-card overrides take precedence over.
      ALTER TABLE decks ADD COLUMN default_lang TEXT;
    `
  },
  {
    version: 5,
    name: "deck_card_lang_requests",
    sql: `
      -- A language you asked for that Scryfall has no printing in.
      --
      -- Deliberately its own table rather than a nullable column on
      -- deck_card_overrides: that table's scryfall_id is NOT NULL, so a failure
      -- row would have to name some printing, and naming the card's current one
      -- would pin it there \u2014 the next time Archidekt moved the entry to another
      -- printing, a lookup that *failed* would silently win. One meaning per
      -- table: an override says which printing you own, a request says which
      -- language you could not get.
      CREATE TABLE deck_card_lang_requests (
        deck_id        INTEGER NOT NULL REFERENCES decks(id) ON DELETE CASCADE,
        oracle_id      TEXT    NOT NULL,
        requested_lang TEXT    NOT NULL,
        created_at     TEXT    NOT NULL,
        PRIMARY KEY (deck_id, oracle_id)
      );
      CREATE INDEX idx_lang_requests_deck ON deck_card_lang_requests(deck_id);
    `
  },
  {
    version: 6,
    name: "forced_language_and_name",
    sql: `
      -- A language you assert for a card Scryfall has no printing of.
      --
      -- Both tables keep pointing at a real printing: collection_items.scryfall_id
      -- and deck_card_overrides.scryfall_id are NOT NULL and reference printings,
      -- and inventing a printing row would break every join that assumes a
      -- Scryfall id means a Scryfall card. So the printing stays real and carries
      -- the prices, type line and mana cost, while these two columns carry what
      -- you are actually claiming: the language, and optionally the localized name.
      ALTER TABLE collection_items    ADD COLUMN forced_lang TEXT;
      ALTER TABLE collection_items    ADD COLUMN forced_name TEXT;
      ALTER TABLE deck_card_overrides ADD COLUMN forced_lang TEXT;
      ALTER TABLE deck_card_overrides ADD COLUMN forced_name TEXT;
    `
  },
  {
    version: 7,
    name: "booster_odds",
    sql: `
      -- Which sets we have distilled booster data for, and when.
      --
      -- MTGJSON publishes the actual booster recipes: named booster types, each a
      -- weighted list of configurations, each configuration drawing a number of
      -- picks from named sheets, each sheet a card-to-weight map. That is enough
      -- to compute a real probability rather than a guess. A set file is a few MB
      -- of JSON but arrives brotli-compressed (~1.3MB on the wire); it is distilled
      -- into the table below and then thrown away \u2014 none of the raw file is kept.
      CREATE TABLE booster_sets (
        set_code   TEXT PRIMARY KEY,
        fetched_at TEXT NOT NULL,
        -- JSON summary for display: booster type names and their pack sizes.
        boosters   TEXT NOT NULL,
        -- JSON list of sealed products that contain boosters, with counts.
        products   TEXT NOT NULL
      );

      CREATE TABLE booster_odds (
        set_code    TEXT NOT NULL,
        booster     TEXT NOT NULL,
        scryfall_id TEXT NOT NULL,
        -- P(at least one copy in one pack).
        probability REAL NOT NULL,
        -- Expected copies per pack, which is what makes the arithmetic checkable:
        -- summed over every card it must equal the pack's pick count.
        expected    REAL NOT NULL,
        -- 1 when a colour-balanced sheet is involved, which skews the draw away
        -- from the plain weighted model, so the figure is shown as approximate.
        approximate INTEGER NOT NULL,
        PRIMARY KEY (set_code, booster, scryfall_id)
      );
      CREATE INDEX idx_booster_odds_card ON booster_odds(scryfall_id);
    `
  },
  {
    version: 8,
    name: "foil_treatment_and_booster_presence",
    sql: `
      -- Which kind of foil a printing's foil version is, and whether the card is
      -- sold in boosters at all. Both come straight out of the Scryfall object we
      -- already store, so this backfills from disk with no re-fetch \u2014 the same
      -- trick migration 2 used for printed_text.
      --
      -- promo_types is Scryfall's tag list: surgefoil, ripplefoil, galaxyfoil and
      -- friends. It describes THE FOIL VERSION of a printing, not the printing as
      -- a whole: a surge-foil card is sold as ["nonfoil","foil"], and only the foil
      -- one is a surge foil. That is why a treatment is only ever shown for a foil
      -- copy, and why it is derived rather than stored per copy.
      ALTER TABLE printings ADD COLUMN promo_types TEXT;
      -- Scryfall's own answer to "does this card come in booster packs". Present
      -- for every printing, which means "not sold in boosters" \u2014 most of a
      -- Commander-precon collection \u2014 can be answered offline, with no MTGJSON
      -- download, and distinguished from "in boosters, chance not computed yet".
      ALTER TABLE printings ADD COLUMN in_boosters INTEGER;

      UPDATE printings
         SET promo_types = json_extract(raw_json, '$.promo_types'),
             in_boosters = json_extract(raw_json, '$.booster')
       WHERE raw_json IS NOT NULL;

      CREATE INDEX idx_printings_in_boosters ON printings(in_boosters);

      -- What you physically hold, where the printing cannot say it.
      --
      -- The treatment is normally derived from the printing above, so this column
      -- is an override for the cases the data gets wrong: null means "whatever the
      -- printing says". It deliberately stays OUT of the
      -- UNIQUE (scryfall_id, finish, condition) identity: two treatments of the
      -- same printing and finish cannot coexist, so it corrects a row rather than
      -- splitting one \u2014 and changing that constraint would mean rebuilding a table
      -- that pick_list_items references.
      ALTER TABLE collection_items ADD COLUMN foil_treatment TEXT;

      -- Deck cards had no settable finish at all: deck_cards.finish comes from
      -- Archidekt's modifier and replaceDeckCards deletes and reinserts every row
      -- on each sync, so anything set there would be lost. These two live in the
      -- override table for the same reason forced_lang does \u2014 it survives a sync.
      ALTER TABLE deck_card_overrides ADD COLUMN finish         TEXT;
      ALTER TABLE deck_card_overrides ADD COLUMN foil_treatment TEXT;

      -- Snapshotted like every other column on this table, so a confirmed list
      -- still reads correctly after the collection row it came from is gone.
      ALTER TABLE pick_list_items ADD COLUMN foil_treatment TEXT;
    `
  },
  {
    version: 9,
    name: "booster_odds_by_finish",
    sql: `
      -- Booster odds have to be per finish, because MTGJSON's sheets are.
      --
      -- A play booster draws from \`common\`, \`wildcard\` and \`rareMythic\` (all
      -- nonfoil) *and* from \`foil\` and \`foilLand\` (foil) \u2014 each sheet carries an
      -- explicit \`foil\` flag. The first version of this table ignored it and
      -- blended both into one number per card, which overstated a foil copy
      -- badly: Thranduil #167 in a HOB play booster is 1.75% nonfoil but only
      -- 0.125% foil, and the blended figure reported 1.867% for both \u2014 15x too
      -- high for the foil.
      --
      -- The old rows cannot be corrected in place, only recomputed, so the cache
      -- is dropped and booster_sets cleared to force a re-fetch. Nothing is lost
      -- but a download: this table has always been a distillation of MTGJSON,
      -- never a record of anything you own.
      DROP TABLE IF EXISTS booster_odds;

      CREATE TABLE booster_odds (
        set_code    TEXT NOT NULL,
        booster     TEXT NOT NULL,
        scryfall_id TEXT NOT NULL,
        -- 1 for the odds of pulling a FOIL copy, 0 for a nonfoil one. A card can
        -- have both, with very different numbers.
        foil        INTEGER NOT NULL,
        -- P(at least one copy in one pack), for that finish.
        probability REAL NOT NULL,
        -- Expected copies per pack. Summed over every card AND both finishes it
        -- must equal the pack's pick count, which is what makes this checkable:
        -- every pick comes off exactly one sheet, and a sheet is one finish.
        expected    REAL NOT NULL,
        approximate INTEGER NOT NULL,
        PRIMARY KEY (set_code, booster, scryfall_id, foil)
      );
      CREATE INDEX idx_booster_odds_card ON booster_odds(scryfall_id);

      DELETE FROM booster_sets;
    `
  }
];

// src/main/db/connection.ts
var { Database } = import_node_sqlite3_wasm.default;
var handle = null;
var facade = null;
var dataDir = "";
function wrap(raw) {
  return {
    run: (sql, params) => {
      raw.run(sql, params);
    },
    all: (sql, params) => raw.all(sql, params),
    get: (sql, params) => raw.get(sql, params),
    exec: (sql) => {
      raw.exec(sql);
    }
  };
}
function setDataDir(dir2) {
  dataDir = dir2;
  (0, import_node_fs.mkdirSync)(dataDir, { recursive: true });
}
function getDataDir() {
  if (!dataDir) {
    throw new Error("Data directory not configured \u2014 call setDataDir() at startup.");
  }
  return dataDir;
}
function getDb() {
  if (facade) return facade;
  const file = (0, import_node_path.join)(getDataDir(), "matomeru.db");
  handle = new Database(file);
  facade = wrap(handle);
  facade.run("PRAGMA journal_mode = WAL");
  facade.run("PRAGMA foreign_keys = ON");
  facade.run("PRAGMA synchronous = NORMAL");
  migrate(facade);
  return facade;
}
function migrate(db2) {
  db2.run(`CREATE TABLE IF NOT EXISTS schema_version (
    version    INTEGER PRIMARY KEY,
    name       TEXT NOT NULL,
    applied_at TEXT NOT NULL
  )`);
  const applied = new Set(
    db2.all("SELECT version FROM schema_version").map((r) => r.version)
  );
  for (const migration of MIGRATIONS) {
    if (applied.has(migration.version)) continue;
    db2.run("BEGIN");
    try {
      db2.exec(migration.sql);
      db2.run("INSERT INTO schema_version (version, name, applied_at) VALUES (?, ?, ?)", [
        migration.version,
        migration.name,
        (/* @__PURE__ */ new Date()).toISOString()
      ]);
      db2.run("COMMIT");
      console.log(`[db] applied migration ${migration.version} (${migration.name})`);
    } catch (err) {
      db2.run("ROLLBACK");
      throw new Error(
        `Migration ${migration.version} (${migration.name}) failed: ${err.message}`
      );
    }
  }
}
function transaction(fn) {
  const db2 = getDb();
  db2.run("BEGIN");
  try {
    const result = fn(db2);
    db2.run("COMMIT");
    return result;
  } catch (err) {
    db2.run("ROLLBACK");
    throw err;
  }
}
function closeDb() {
  if (handle) {
    handle.close();
    handle = null;
    facade = null;
  }
}
function nowIso() {
  return (/* @__PURE__ */ new Date()).toISOString();
}

// src/shared/i18n/en.ts
var en = {
  // ---------------------------------------------------------------- navigation
  "nav.collection": "Collection",
  "nav.add": "Add cards",
  "nav.picks": "Pick lists",
  "nav.decks": "Decks",
  "nav.import": "Import / export",
  "nav.stats": "Stats",
  "nav.settings": "Settings",
  "app.tagline": "MTG bulk manager",
  // -------------------------------------------------------------- common verbs
  "common.save": "Save",
  "common.cancel": "Cancel",
  "common.remove": "Remove",
  "common.close": "Close",
  "common.clearAll": "Clear all",
  "common.clearSelection": "Clear selection",
  "common.selectAllShown": "Select all shown",
  "search.placeholder": "Search\u2026",
  "search.clear": "Clear search",
  "columns.title": "Cards per row \u2014 fewer columns means bigger cards (Ctrl+= / Ctrl+\u2212 / Ctrl+0, or Ctrl+scroll)",
  "columns.perRow": "{count}/row",
  "columns.fewer": "Fewer columns, bigger cards",
  "columns.more": "More columns, smaller cards",
  "common.search": "Search",
  "common.loading": "Loading\u2026",
  "common.never": "never",
  "common.none": "none",
  "common.of": "{shown} of {total}",
  "common.selected": "{count} selected",
  "common.retry": "Try again",
  // -------------------------------------------------------------- vocabulary
  "rarity.common": "Common",
  "rarity.uncommon": "Uncommon",
  "rarity.rare": "Rare",
  "rarity.mythic": "Mythic",
  "rarity.special": "Special",
  "rarity.bonus": "Bonus",
  "color.W": "White",
  "color.U": "Blue",
  "color.B": "Black",
  "color.R": "Red",
  "color.G": "Green",
  "color.C": "Colorless",
  "finish.nonfoil": "Normal",
  "finish.foil": "Foil",
  "finish.etched": "Etched",
  "lang.en": "English",
  "lang.fr": "French",
  "lang.de": "German",
  "lang.it": "Italian",
  "lang.es": "Spanish",
  "lang.pt": "Portuguese",
  "lang.ja": "Japanese",
  "lang.ko": "Korean",
  "lang.ru": "Russian",
  "lang.zhs": "Chinese (S)",
  "lang.zht": "Chinese (T)",
  "lang.he": "Hebrew",
  "lang.la": "Latin",
  "lang.grc": "Ancient Greek",
  "lang.ar": "Arabic",
  "lang.sa": "Sanskrit",
  "lang.ph": "Phyrexian",
  // ------------------------------------------------------------ relative time
  "time.justNow": "just now",
  "time.minutes": "{count}m ago",
  "time.hours": "{count}h ago",
  "time.days": "{count}d ago",
  // ----------------------------------------------------------------- settings
  "settings.title": "Settings",
  "settings.archidekt": "Archidekt",
  "settings.username": "Username",
  "settings.usernameHint": "Public decks only. Private decks return 404 to anyone not logged in, so they cannot be synced \u2014 add them by URL if they are unlisted.",
  "settings.usernamePlaceholder": "your-archidekt-username",
  "settings.saveUsername": "Save",
  "settings.syncNow": "Sync now",
  "settings.labels": "What your deck labels mean",
  "settings.pricesMatching": "Prices & matching",
  "settings.currency": "Currency",
  "settings.currencyHint": "Scryfall has no separate EUR price for etched foils, so those fall back to the regular foil price.",
  "settings.currencySourceUsd": "USD prices come from TCGplayer, via Scryfall.",
  "settings.currencySourceEur": "EUR prices come from Cardmarket, via Scryfall.",
  "settings.exactPrinting": "Require the exact printing for deck matches",
  "settings.exactPrintingHint": "With this on, owning the Japanese printing does not count as owning a card a deck lists in English.",
  "settings.appearance": "Appearance",
  "settings.language": "Language",
  "settings.languageHint": "The language of the app itself. Card names stay in whatever language the printing you own is in.",
  "settings.languageSystem": "Follow Windows",
  "settings.reduceMotion": "Reduce motion",
  "settings.reduceMotionHint": "Stills the animations, including the ones drawn by JavaScript rather than CSS.",
  "settings.data": "Data",
  "settings.dataHint": "Everything lives in one SQLite file, plus a folder of cached card images. Copy it anywhere to move or back up your collection.",
  "settings.savedUsername": "Archidekt username set to {name}.",
  "settings.clearedUsername": "Username cleared.",
  "settings.enterUsernameFirst": "Enter your Archidekt username first.",
  "settings.languageChanged": "The app is now in {language}.",
  // ------------------------------------------------------------------ filters
  "finishPicker.title": "Set the finish you physically hold",
  "finishPicker.finish": "Finish",
  "finishPicker.declareAnyway": "Declare anyway",
  "finishPicker.fromPrinting": "(from the printing)",
  "finishPicker.plainFoil": "Plain foil",
  "finishPicker.yours": "You set this, rather than Scryfall",
  "filters.language": "Language",
  "filters.rarity": "Rarity",
  "filters.set": "Set",
  "filters.finish": "Finish",
  "filters.nothingYet": "Nothing to filter yet",
  "filters.noMatch": 'No match for "{query}"',
  "filters.treatment": "Foil type",
  "filters.condition": "Condition",
  "filters.colors": "Colors",
  "filters.manaValue": "Mana value",
  "filters.unitValue": "Unit value",
  "filters.typeLine": "Type line",
  "filters.typeLinePlaceholder": "Creature, Instant\u2026",
  "filters.more": "More",
  "filters.min": "min",
  "filters.max": "max",
  "filters.searchPlaceholder": "Search name, localized name, set, number, type\u2026",
  "filters.deckLocation": "Deck location",
  "filters.anywhere": "Anywhere",
  "filters.inADeck": "In a deck",
  "filters.notInAnyDeck": "Not in any deck (loose bulk)",
  "filters.whereCopies": "Where the copies are",
  "filters.bulkAndDecks": "Bulk and decks",
  "filters.bulkOnly": "Bulk only",
  "filters.inDecksOnly": "In decks only",
  "filters.onlyReserved": "Only reserved by a pick list",
  "filters.conditionHint": "Deck copies come from Archidekt labels you have marked as cards you own. They have no recorded condition, so a condition filter only ever matches cards you entered yourself.",
  "filters.deckPrefix": "deck: {name}",
  "filters.typePrefix": "type: {value}",
  "filters.cmcRange": "cmc {min}\u2013{max}",
  "filters.valueRange": "value {min}\u2013{max}",
  "filters.reserved": "reserved",
  // --------------------------------------------------------------- deck view
  "deck.ownershipAll": "Owned and missing",
  "deck.ownershipOwned": "Owned only",
  "deck.ownershipMissing": "Missing only",
  "deck.category": "Category",
  "deck.categoryNotInDeck": "{name} (not in deck)",
  "deck.label": "Label",
  "deck.noLabel": "No label",
  "deck.searchPlaceholder": "Search this deck \u2014 name, set, number, type\u2026",
  "deck.sortTitle": "Sort this deck",
  "deck.groupByCategory": "Group by Archidekt category",
  "deck.flatList": "One flat list",
  "deck.flatListHint": "One flat list \u2014 commander and the Cut/Maybeboard piles stay separate",
  "deck.selectAllHint": "Select every card currently shown, so a language applies to exactly these",
  "deck.cardsShown": "{shown} of {total} cards",
  "deck.typeLinePlaceholder": "Type line\u2026",
  // ------------------------------------------------------ sort and printings
  "sort.by": "Sort by",
  "sort.thenBy": "Then by",
  "sort.ascending": "Ascending",
  "sort.descending": "Descending",
  "sort.removeTiebreak": "Remove the tie-breaker",
  "sort.collection": "Sort the collection",
  "sort.name": "Card name",
  "sort.color": "Colour",
  "sort.cmc": "Mana value",
  "sort.rarity": "Rarity",
  "sort.set_code": "Set",
  "sort.collector_number": "Collector number",
  "sort.lang": "Language",
  "sort.finish": "Finish",
  "sort.condition": "Condition",
  "sort.quantity": "Quantity",
  "sort.unit_value": "Unit value",
  "sort.total_value": "Total value",
  "sort.added_at": "Recently added",
  "sort.ownership": "Ownership",
  "sort.price": "Price",
  "printing.printings": "Printings",
  "printing.forDeck": "for {name}",
  "printing.forYourCopy": "for your copy",
  "printing.notListed": "Not listed?",
  "printing.declared": "Declared {lang}",
  "printing.declaredHint": "Record a language Scryfall has no printing for",
  "printing.showAll": "Show every printing and language",
  "printing.looking": "Looking up every printing\u2026",
  "printing.noneListed": 'Scryfall lists no printings under this name. If you hold the card anyway, use "Not listed?" to record its language.',
  "printing.allFiltered": "All {count} printings are filtered out. Clear a filter above to see them.",
  "printing.inUse": "This is the printing in use",
  "printing.usePrinting": "Use the {set} {lang} printing",
  "printing.own": "own {count}",
  "printing.count": "{count} printings",
  "printing.nameExample": "Forest",
  "printing.localizedName": "Localized name (optional)",
  "printing.forceHint": "For a card Scryfall has no printing of in your language. The printing above stays as it is \u2014 it is where prices and rules text come from \u2014 and only the language and name become what you say they are.",
  "printing.stopDeclaring": "Stop declaring a language",
  "printing.declaredToast": "Recorded as {language}. The printing underneath is unchanged, so prices still work.",
  "printing.backToArchidekt": "Back to describing its printing.",
  "printing.deckUses": "{deck} now uses the {lang} printing.",
  "printing.copyIsNow": "Your copy is now the {lang} printing.",
  // ------------------------------------------------------------ bulk actions
  "bulk.setLanguage": "Set language",
  "bulk.working": "Working\u2026",
  "bulk.setLanguageHint": "Record which language of these cards you actually own",
  "bulk.setFinish": "Finish\u2026",
  "bulk.setFinishHint": "Record the finish and foil type you physically hold these cards in",
  "bulk.finishHint": "Archidekt only says foil or not. What you set here survives a deck sync.",
  "bulk.finishFromArchidekt": "Back to Archidekt\u2019s value",
  "bulk.finishDone": "Set {count} card(s) to {finish}.",
  "bulk.finishCleared": "Returned {count} card(s) to Archidekt\u2019s finish.",
  "bulk.clearOverride": "Clear override",
  "bulk.languageHint": "One lookup per card. Any card with no printing in that language keeps the one it has and is flagged.",
  "bulk.converted": "{count} set to {lang}",
  "bulk.viaSearch": "{count} found under another set",
  "bulk.unavailable": "{count} have no {lang} printing",
  "bulk.failed": "{count} failed",
  "bulk.cleared": "{count} back to what Archidekt says",
  // ------------------------------------------------------------ booster odds
  "picks.title": "Pick lists",
  "picks.new": "New pick list",
  "picks.cardsAndValue": "{cards} cards \xB7 {value}",
  "picks.none": "No pick lists yet. Select cards in the collection and choose \u201CAdd to pick list\u201D.",
  "picks.noneSelected": "No pick list selected",
  "picks.noneSelectedHint": "A pick list stages cards for pulling. Your collection stays untouched until you validate the pull, so cancelling costs nothing.",
  "picks.emptyTitle": "Nothing staged",
  "picks.emptyHint": "Select rows in the collection and use \u201CAdd to pick list\u201D. Staged copies are reserved but stay in your collection until you validate.",
  "picks.deckWarning_one": "{count} staged card is used by a synced deck. Pulling it will leave that deck incomplete.",
  "picks.deckWarning_other": "{count} staged cards are used by a synced deck. Pulling them will leave those decks incomplete.",
  "picks.cardsInGroup": "{count} cards",
  "picks.cancelled": "Pick list cancelled \u2014 every reservation released, collection untouched.",
  "picks.deleted": "Pick list deleted.",
  "picks.exported": "Exported {count} rows.",
  "picks.statusOpen": "Open \u2014 reserving, not yet removed",
  "picks.statusConfirmed": "Confirmed {when} \u2014 history",
  "picks.statusCancelled": "Cancelled \u2014 nothing was removed",
  "picks.summary": "{cards} cards in {rows} rows \xB7 {value}",
  "picks.rowView": "Row view",
  "picks.gridView": "Grid view",
  "picks.export": "Export",
  "picks.cancelPull": "Cancel pull",
  "picks.validatePull": "Validate pull",
  "picks.reopen": "Reopen",
  "picks.delete": "Delete",
  "picks.confirmedKept": "Confirmed lists are kept as history.",
  "picks.rowGone": "(row no longer in collection)",
  "picks.deckCount_one": "{count} deck",
  "picks.deckCount_other": "{count} decks",
  "picks.removeItem": "Remove from pick list",
  "picks.picked": "{count} picked",
  "picks.confirmTitle": "Validate this pull",
  "picks.confirmBody_one": "This removes {count} card from your collection in one step. Until you press confirm, nothing has been deducted.",
  "picks.confirmBody_other": "This removes {count} cards from your collection in one step. Until you press confirm, nothing has been deducted.",
  "picks.inDeck_one": "{count} of these cards is in a deck",
  "picks.inDeck_other": "{count} of these cards are in a deck",
  "picks.andMore": "\u2026and {count} more",
  "picks.emptying_one": "{count} row will hit zero and be removed from the collection. This pick list keeps its own record of them, so the history stays readable.",
  "picks.emptying_other": "{count} rows will hit zero and be removed from the collection. This pick list keeps its own record of them, so the history stays readable.",
  "picks.notYet": "Not yet",
  "picks.removing": "Removing\u2026",
  "picks.confirmAction": "Confirm \u2014 remove {count}",
  "picks.pulled_one": "Pulled {count} card",
  "picks.pulled_other": "Pulled {count} cards",
  "picks.pulledRows": "; {count} row(s) emptied and removed",
  "picks.defaultName": "Pick list",
  "labels.dontOwn": "don't own",
  "labels.dontOwnHint": "A wishlist entry. The deck stops counting as a place this card lives, and it contributes nothing to your collection.",
  "labels.ignore": "ignore",
  "labels.ignoreHint": "The label means nothing here. Ownership comes purely from the cards you have entered.",
  "labels.own": "own",
  "labels.ownHint": "Those copies count as part of your collection \u2014 your physical cards, sleeved in a deck rather than loose in bulk.",
  "labels.intro1": "Say what each Archidekt label colour means.",
  "labels.intro2": "treats those deck entries as a wishlist \u2014 the deck stops counting as a place the card lives.",
  "labels.intro3": "treats them as your cards, sleeved in a deck, so they count towards your collection.",
  "labels.intro4": "leaves ownership to the cards you have entered yourself.",
  "labels.emptyTitle": "No labels found yet",
  "labels.emptyHint": "Sync a deck that uses coloured labels and they will appear here. You can also add a colour by hex below.",
  "labels.unnamed": "(unnamed label)",
  "labels.usage_one": "{cards} cards in {count} deck",
  "labels.usage_other": "{cards} cards in {count} decks",
  "labels.unused": "not used by any synced deck",
  "labels.addColour": "Add colour",
  "labels.badHex": "Enter a hex colour, for example #f47373.",
  "labels.addHint1": "For a colour used only in a deck you have not synced yet. Added as",
  "labels.addHint2": "change it here afterwards.",
  "stats.title": "Stats",
  "stats.lastRefreshed": "Prices last refreshed {when}",
  "stats.refreshing": "Refreshing\u2026",
  "stats.refreshPrices": "Refresh prices",
  "stats.refreshed": "Refreshed {updated} of {requested} printings.",
  "stats.refreshedUnpriced": " {count} have no price on Scryfall \u2014 common for non-English printings.",
  "stats.emptyTitle": "No cards to measure yet",
  "stats.emptyHint": "Add some cards and this page will break your collection down by rarity, language, set and value.",
  "stats.totalCards": "Total cards",
  "stats.splitCards": "{bulk} in bulk + {deck} sleeved in decks",
  "stats.distinctRows": "Distinct rows",
  "stats.collectionValue": "Collection value",
  "stats.splitValue": "{bulk} bulk + {deck} in decks",
  "stats.looseVsDecks": "Loose vs in decks",
  "stats.looseVsDecksHint": "cards not in any deck / cards a synced deck uses",
  "stats.byLanguage": "By language",
  "stats.byLanguageHint": "Click a row to filter the collection",
  "stats.byRarity": "By rarity",
  "stats.topSets": "Top sets by value",
  "stats.topCards": "Most valuable cards",
  "csv.field.quantity": "Quantity",
  "csv.field.name": "Card name",
  "csv.field.set": "Set code",
  "csv.field.collectorNumber": "Collector number",
  "csv.field.lang": "Language",
  "csv.field.langHint": "Needed to import non-English printings",
  "csv.field.finish": "Finish / foil",
  "csv.field.condition": "Condition",
  "csv.field.scryfallId": "Scryfall id",
  "csv.field.scryfallIdHint": "Most precise if present",
  "csv.field.purchasePrice": "Purchase price",
  "csv.title": "Import / export",
  "csv.subtitle": "Nothing is written until you review the preview and press import.",
  "csv.step1": "1 \xB7 Choose a file",
  "csv.chooseFile": "Choose CSV",
  "csv.detected": "Detected {preset} layout \xB7 {rows} rows \xB7 {columns} columns",
  "csv.step2": "2 \xB7 Map the columns",
  "csv.notMapped": "\u2014 not mapped \u2014",
  "csv.resolving": "Resolving\u2026",
  "csv.previewImport": "Preview import",
  "csv.resolveHint": "Rows with a language are resolved one at a time \u2014 the batch endpoint ignores language, so this can take a moment on a large file.",
  "csv.step3": "3 \xB7 Review, then import",
  "csv.matched": "Matched",
  "csv.ambiguous": "Ambiguous",
  "csv.unmatched": "Unmatched",
  "csv.candidates": "{count} candidate printings \u2014 needs a set or number",
  "csv.showingFirst": "Showing the first 300 of {count} rows. All of them will be imported.",
  "csv.importing": "Importing\u2026",
  "csv.importMatched": "Import {count} matched rows",
  "csv.saveUnresolved": "Save unresolved rows",
  "csv.unresolvedSkipped": "Unresolved rows are skipped, never guessed at.",
  "csv.emptyTitle": "Bulk-load an existing list",
  "csv.emptyHint": "Presets are built in for ManaBox, Moxfield and Deckbox exports, and anything else can be mapped by hand.",
  "csv.export": "Export",
  "csv.exportHint": "Exports whatever the Collection view is currently filtered to, with columns that round-trip back through this importer.",
  "csv.exportCollection": "Export collection",
  "csv.howMatched": "How rows are matched",
  "csv.match1": "Scryfall id \u2014 exact, no guessing",
  "csv.match2": "Set + number + language",
  "csv.match3": "Name + set",
  "csv.match4": "Name alone",
  "csv.matchNote": "A name on its own often matches many printings. Those rows are flagged ambiguous and left out rather than assigned to an arbitrary printing.",
  "csv.imported": "Imported {cards} cards across {rows} rows",
  "csv.importedSkipped": "; skipped {count} unresolved.",
  "csv.wroteRejects": "Wrote {count} unresolved rows to {path}",
  "csv.exported": "Exported {count} rows to {path}",
  "detail.card": "Card",
  "detail.viewOnScryfall": "View on Scryfall",
  "detail.notCached": "This card is not cached yet.",
  "detail.set": "Set",
  "detail.number": "Number",
  "detail.cost": "Cost",
  "detail.type": "Type",
  "detail.released": "Released",
  "detail.finishes": "Finishes",
  "detail.foilType": "Foil type",
  "detail.prices": "Prices",
  "detail.normal": "Normal",
  "detail.foil": "Foil",
  "detail.etched": "Etched",
  "detail.na": "n/a",
  "detail.whereItIs": "Where it is",
  "detail.inCollection": "In the collection",
  "detail.totalHeld": "{total} total",
  "detail.totalHeldReserved": "{total} total, {held} held",
  "detail.dontOwnPrinting": "You do not own this printing.",
  "detail.heldBadge": "{count} held",
  "detail.reservedTooltip": "Copies are reserved by an open pick list",
  "detail.removeRow": "Remove every copy of this row",
  "detail.stagedIn": "Staged in pick lists",
  "detail.notStaged": "Not staged for pulling.",
  "detail.inDecks": "In decks",
  "detail.noDecks": "Not used by any synced deck.",
  "detail.matchExact": "This deck uses this exact printing, in this language",
  "detail.matchOracle": "This deck uses the same card in a different printing or language",
  "detail.exact": "exact",
  "detail.otherPrinting": "other printing",
  "detail.oracleNote1": "An",
  "detail.oracleNote2": "match means the deck lists this card in a different printing or language than the one you own \u2014 the physical card in that deck is not this one.",
  "detail.excludedNote": "Decks where this card is marked as one you do not own are excluded \u2014 a wishlist entry is not a place a card lives. Values shown in {currency}.",
  "add.title": "Add cards",
  "add.tabSearch": "Search by name",
  "add.tabQuick": "Fast entry",
  "add.noPrintings": "No printings found for \u201C{name}\u201D.",
  "add.added": "Added {quantity}\xD7 {name} ({lang}){note} \u2014 you now hold {owned}.",
  "add.addedFinishNote": " as {finish}, the only finish it comes in",
  "add.searchPlaceholder": "Card name \u2014 press Enter to see every printing",
  "add.finish": "Finish",
  "add.condition": "Condition",
  "add.quantity": "Quantity",
  "add.perRow": "Per row",
  "add.truncated": "This card has {total} printings across all languages. Showing the {shown} most recent \u2014 Scryfall asks that bulk browsing go through their data downloads rather than page-by-page requests, so the lookup stops there. Narrow by set or language, or use Fast entry if you know the set and number.",
  "add.lookupTitle": "Look up a card",
  "add.lookupHint": "Type a name and press Enter. You will get every printing in every language \u2014 pick the exact one you are holding.",
  "add.allFilteredTitle": "Every printing is filtered out",
  "add.allFilteredHint_one": "This card has {count} printing, and the filters above hide all of them. Clear one to see them again.",
  "add.allFilteredHint_other": "This card has {count} printings, and the filters above hide all of them. Clear one to see them again.",
  "add.onlyFinish": "{name} comes in {finish} only \u2014 adds as {finish}",
  "add.addCard": "Add {name}",
  "add.foilIs": "This printing\u2019s foil is {treatment}",
  "add.finishOnly": "{finish} only",
  "add.owned": "own {count}",
  "add.badFormat": 'Format is: SET NUMBER [LANG] [xN] \u2014 for example "m10 146 ja x3".',
  "add.quickIntro": "The fastest way to log a physical pile. Type the set code, the collector number, and the language, then press Enter. This route is the only one that reliably reaches a specific language printing.",
  "add.quickLabel": "Set \xB7 number \xB7 language \xB7 quantity",
  "add.adding": "Adding\u2026",
  "add.add": "Add",
  "add.logEmptyTitle": "Nothing logged yet",
  "add.logEmptyHint": "Added cards appear here so you can keep your eyes on the pile instead of the screen.",
  "coll.title": "Collection",
  "coll.loading": "Loading\u2026",
  "coll.summary": "{cards} cards in {rows} rows \xB7 ",
  "coll.deckSplit": "({bulk} in bulk + {deck} in decks)",
  "coll.deckSplitHint": "Cards sleeved in decks under a label colour you have marked as one you own",
  "coll.sortTitle": "Sort the collection",
  "coll.tableView": "Table view",
  "coll.galleryView": "Gallery view",
  "coll.export": "Export",
  "coll.emptyTitle": "Your collection is empty",
  "coll.noMatchTitle": "No cards match these filters",
  "coll.emptyHint": "Add cards from the Add cards tab, or bulk-load an existing list from Import / export.",
  "coll.noMatchHint": "Try clearing a filter or two.",
  "coll.nothingToPick": "Nothing available to pick \u2014 those copies are already reserved.",
  "coll.staged_one": "Staged {count} card",
  "coll.staged_other": "Staged {count} cards",
  "coll.stagedCapped": " ({count} row(s) capped by availability)",
  "coll.exported": "Exported {count} rows to {path}",
  "coll.selectAll": "Select all rows",
  "coll.selectRow": "Select {name}",
  "coll.cardDetails": "Card details",
  "coll.youSetThis": "You set this",
  "coll.inDecksHint_one": "In {count} deck \u2014 click for details",
  "coll.inDecksHint_other": "In {count} decks \u2014 click for details",
  "coll.sleevedIn": "Sleeved in {decks} \u2014 edit it in Archidekt",
  "coll.sleevedInShort": "Sleeved in {decks}",
  "coll.inDeckBadge": "in deck",
  "coll.inDeckCount": "In {count} deck(s)",
  "coll.reservedBadge": "{count} reserved by an open pick list",
  "coll.rowRemoved": "Row removed.",
  "coll.removeRow": "Remove row",
  "coll.addToPickList": "Add to pick list",
  "coll.finishPlaceholder": "Finish\u2026",
  "coll.treatmentPlaceholder": "Foil type\u2026",
  "coll.fromThePrinting": "From the printing",
  "coll.conditionPlaceholder": "Condition\u2026",
  "coll.remove": "Remove",
  "coll.setFinishDone": "Set {count} row(s) to {finish}.",
  "coll.setTreatmentDone": "Set {count} row(s) to {treatment}.",
  "coll.clearedTreatment": "Cleared the foil type on {count} row(s).",
  "coll.setConditionDone": "Set {count} row(s) to {condition}.",
  "coll.removedRows": "Removed {count} row(s)",
  "coll.removedSkipped": "; {count} skipped \u2014 reserved by an open pick list.",
  "coll.col.card": "Card",
  "coll.col.lang": "Lang",
  "coll.col.rarity": "Rar",
  "coll.col.set": "Set",
  "coll.col.finish": "Finish",
  "coll.col.condition": "Cond",
  "coll.col.decks": "Decks",
  "coll.col.qty": "Qty",
  "coll.col.unit": "Unit",
  "coll.col.total": "Total",
  "decks.sidebarTitle": "Archidekt decks",
  "decks.syncing": "Syncing\u2026",
  "decks.syncUser": "Sync {username}",
  "decks.setUsernameFirst": "Set username first",
  "decks.addUsernameHint": "Add your Archidekt username in Settings to sync automatically.",
  "decks.labelMeanings": "Label meanings",
  "decks.urlPlaceholder": "Deck URL or id",
  "decks.syncResult": "Decks: {parts}.",
  "decks.syncSynced": "{count} synced",
  "decks.syncUnchanged": "{count} unchanged",
  "decks.syncUnavailable": "{count} unavailable",
  "decks.privateWarning": "Archidekt reports {reported} decks but only shared {shared}. Private decks cannot be read without logging in \u2014 add them by URL if they are unlisted.",
  "decks.added": "Added \u201C{name}\u201D.",
  "decks.cardCount": "{count} cards",
  "decks.noneYet": "No decks yet. Sync your Archidekt account, or paste a deck URL above.",
  "decks.selectADeck": "Select a deck",
  "decks.noneSynced": "No decks synced",
  "decks.selectHint": "Pick a deck to see which cards you already own and which you are missing.",
  "decks.noneSyncedHint": "Syncing decks never changes your collection \u2014 decks are read-only reference data that tell you where a card already is.",
  "decks.removedLocally": "Deck removed locally.",
  "decks.labelsModalTitle": "What your deck labels mean",
  "decks.cardsCount": "{count} cards",
  "decks.inDeckSplit": "({inDeck} in the deck, {outside} outside)",
  "decks.syncedAt": "synced {when}",
  "decks.rowView": "Row view",
  "decks.gridView": "Grid view",
  "decks.remove": "Remove",
  "decks.syncErrorNote": "{error}. Private decks return 404 to any unauthenticated request, so this one cannot be read. Unlisted decks work if you add them by URL.",
  "decks.owned": "{count} owned",
  "decks.missing": "{count} missing",
  "decks.missingPile": "Missing pile \u2248 ",
  "decks.entries": "{count} entries",
  "decks.exactOnlyHint": "With this on, owning the Japanese printing does not count as owning a card the deck lists in English.",
  "decks.exactOnly": "Require the exact printing",
  "decks.nothingMatches": "Nothing matches",
  "decks.nothingMatchesHint": "No card in this deck matches the current search and filters.",
  "decks.notCountedHint": "Archidekt does not count this category towards the deck.",
  "decks.notInDeck": "not in deck",
  "decks.deselect": "Deselect {name}",
  "decks.select": "Select {name}",
  "decks.langForced": "You declared this language \u2014 Scryfall has no printing of this card in it",
  "decks.langOverride": "You set this to {lang}",
  "decks.langUnavailable": "No {lang} printing of this card exists, so it was left as it is",
  "decks.langUnavailableTile": "No {lang} printing of this card exists, so it was left on the one it had.",
  "decks.have": "have {held}",
  "decks.haveOf": "have {held} / {needed}",
  "decks.otherPrintingHint": "You own {count} of this card, but in a different printing or language",
  "decks.otherPrinting": "other printing",
  "decks.labelOwnedHint": 'Marked "{label}" in Archidekt as a card you own, so these {count} count towards your collection.',
  "decks.labelOwnedShort": "have it",
  "decks.labelLooseHint": 'Marked "{label}" in Archidekt, so this deck is not holding your copies \u2014 your {held} should be loose in your bulk.',
  "decks.labelLoose": "not in deck \xB7 {held} in bulk",
  "decks.labelNotOwnedHint": 'Marked "{label}" in Archidekt \u2014 a card you do not own, so this deck does not count as a place it lives.',
  "decks.labelNotOwnedShort": "don't own",
  "decks.ownedInArchidekt": "Marked as a card you own in Archidekt \u2014 counts towards your collection",
  "decks.notOwnedInArchidekt": "Marked as a card you do not own in Archidekt",
  "decks.notOwnedButHeld": " \u2014 your {held} copies are loose in your bulk",
  "decks.langSet": "{count} set to {lang}",
  "decks.langNoPrinting": "{count} have no {lang} printing",
  "decks.langFailed": "{count} failed",
  "decks.clearedOverrides": "{count} back to what Archidekt says.",
  "common.removeFilter": "Remove filter",
  "common.decrease": "Decrease",
  "common.increase": "Increase",
  "common.quantity": "Quantity",
  "common.dismiss": "Dismiss",
  "settings.usernameSet": "Archidekt username set to {username}.",
  "settings.usernameCleared": "Username cleared.",
  "settings.usernameFirst": "Enter your Archidekt username first.",
  "settings.syncing": "Syncing\u2026",
  "settings.syncNote": "Syncing pulls every public and unlisted deck on the account. Deck data is read-only reference: it tells you where a card already is and never changes what your collection says you own.",
  "settings.privateNote": "Private decks return 404 to any unauthenticated request, so they cannot be synced. Matomeru stores no credentials \u2014 if a deck is unlisted rather than private, add it by URL from the Decks tab.",
  "settings.openArchidekt": "Open Archidekt",
  "settings.labelsTitle": "What your deck labels mean",
  "settings.pricesTitle": "Prices & matching",
  "settings.exactMatch": "Require the exact printing for deck matches",
  "settings.exactMatchHint": "Off: owning any language of a card counts as owning it. On: only the identical printing counts, so the Japanese copy will not satisfy a deck that lists the English one.",
  "settings.pricesRefreshed": "Prices last refreshed {when}.",
  "settings.dataTitle": "Where your data lives",
  "settings.dataNote1": "The collection database and the card image cache live in your Windows app-data folder, deliberately outside the application directory, so reinstalling or updating Matomeru never touches your collection.",
  "settings.dataNote2": "Card data comes from Scryfall; deck data from Archidekt. Neither is affiliated with this app, and nothing is uploaded anywhere \u2014 every request is a read.",
  "err.noDataDir": "Data directory not configured \u2014 call setDataDir() at startup.",
  "err.reserved": "Cannot delete: copies are reserved by an open pick list.",
  "err.itemNotFound": "Collection item not found.",
  "err.notCached": "That printing is not cached yet \u2014 look the card up first.",
  "err.noLangAnchor": "That deck entry has no printing to anchor a language to.",
  "err.noFinishAnchor": "That deck entry has no printing to anchor a finish to.",
  "err.pickListNotFound": "Pick list not found.",
  "err.pickListClosed": "That pick list is already closed.",
  "err.pickItemNotFound": "Pick list item not found.",
  "err.confirmedIsHistory": "A confirmed pick list is history and cannot be reopened.",
  "err.onlyAvailable": "Only {count} available to pick.",
  "err.setUsername": "Set your Archidekt username in Settings first.",
  "err.quantityAtLeastOne": "Quantity must be at least 1.",
  "err.notADeckUrl": "That does not look like an Archidekt deck URL or id.",
  "err.noArchidektAccount": 'No Archidekt account found for "{username}".',
  "err.mtgjsonNoData": "MTGJSON has no data for {set} ({status}).",
  "err.archidektUnreachable": "Could not reach Archidekt: {message}",
  "err.archidektStatus": "Archidekt returned {status}",
  "csv.reasonDeckRow": "Skipped \u2014 this row is a deck copy, already counted via its label.",
  "csv.reasonNoIdentity": "Row has no name, id, or set + number.",
  "boosters.title": "Where to get it",
  "boosters.load": "Load booster odds for {set}",
  "boosters.loading": "Downloading {set} booster data\u2026",
  "boosters.loadHint": "Downloads this set\u2019s booster recipes from MTGJSON (a few MB, once per set) and keeps only the odds.",
  "boosters.noData": "MTGJSON lists no boosters for {set}. Cards from Commander decks, Secret Lairs and similar products are not sold in boosters at all.",
  "boosters.notInBooster": "not in this booster",
  "boosters.perPack": "{percent} per pack",
  "boosters.oneIn": "about 1 in {count} packs",
  "boosters.expected": "{count} per pack on average",
  "boosters.cardsPerPack": "{count} cards per pack",
  "boosters.approximate": "Approximate: this card sits on a colour-balanced sheet, which skews the draw away from plain weights.",
  "boosters.products": "In sealed products",
  "boosters.productChance": "{count} packs \u2014 {percent}",
  "boosters.notListed": "Scryfall does not list this printing as a booster card \u2014 but a showcase or borderless version of the same card often still is, so the odds below are worth checking.",
  "boosters.isInBoosters": "This card does come in boosters. Load {set} below for the actual odds.",
  "boosters.viaEnglish": "Matched through the English printing, which is what the booster data names.",
  "boosters.loadAll": "Get booster data for my collection",
  "boosters.loadAllHint": "Fetches the sets you own booster cards from, skipping precon-only sets",
  "boosters.loadAllRunning": "Fetching {done} of {total}\u2026",
  "boosters.loadAllDone": "Loaded {sets} set(s); {skipped} already had data.",
  "boosters.loadAllFailed": "Loaded {sets} set(s). MTGJSON has no data for {failed}.",
  "boosters.loadAllNothing": "Every set you own booster cards from already has data.",
  "boosters.notCovered": "no data for this booster",
  "boosters.partial": "partly from other sets",
  "boosters.partialHint": "Some slots in this booster are filled from other sets, which this data cannot name \u2014 so the chance shown is a floor, not the whole story.",
  "boosters.source": "Booster recipes from MTGJSON. Percentages are the chance of at least one copy in a single pack.",
  "boosters.refresh": "Refresh",
  "boosters.loaded": "{boosters} booster types, {cards} cards priced for {set}.",
  // ------------------------------------------------------------------- errors
  "error.printingNotCached": "That printing is not cached yet \u2014 look the card up first.",
  "error.quantityAtLeastOne": "Quantity must be at least 1.",
  "error.noPrintingFound": 'No printing found for {set} #{number} in "{lang}".',
  "error.noArchidektAccount": 'No Archidekt account found for "{name}".',
  "error.deckPrivateOr404": "Archidekt returned 404 \u2014 the deck is private or no longer exists.",
  "error.notADeckUrl": "That does not look like an Archidekt deck URL or id.",
  "error.setUsernameFirst": "Set your Archidekt username in Settings first.",
  "error.pickListNotFound": "Pick list not found.",
  "error.pickListClosed": "That pick list is already closed.",
  "error.pickListConfirmed": "A confirmed pick list is history and cannot be reopened.",
  "error.collectionItemNotFound": "Collection item not found.",
  "error.pickItemNotFound": "Pick list item not found.",
  "error.onlyAvailable": "Only {count} available to pick.",
  "error.pickListShort": "Pick list asks for {wanted} copies but only {held} are held. Refresh and try again.",
  "error.reservedQuantity": "Cannot set quantity to {quantity}: {reserved} copies are reserved by an open pick list.",
  "error.reservedDelete": "Cannot delete: copies are reserved by an open pick list.",
  "error.reservedPrinting": "Cannot change the printing: copies are reserved by an open pick list. Cancel or confirm it first.",
  "error.noAnchorPrinting": "That deck entry has no printing to anchor a language to.",
  "error.archidektUnreachable": "Could not reach Archidekt: {message}",
  "error.archidektNotFound": "Not found on Archidekt.",
  "error.archidektStatus": "Archidekt returned {status}",
  "error.noSetNumber": "This entry has no set and collector number to look up.",
  "error.noOracleId": "This entry has no oracle id, so it cannot be matched to another printing.",
  // ------------------------------------------------------- deck sync statuses
  "sync.private": "private \u2014 not synced",
  "sync.notFound": "not found on Archidekt"
};

// src/shared/i18n/fr.ts
var fr = {
  // ---------------------------------------------------------------- navigation
  "nav.collection": "Collection",
  "nav.add": "Ajouter des cartes",
  "nav.picks": "Listes de pr\xE9l\xE8vement",
  "nav.decks": "Decks",
  "nav.import": "Import / export",
  "nav.stats": "Statistiques",
  "nav.settings": "Param\xE8tres",
  "app.tagline": "Gestionnaire de vrac MTG",
  // -------------------------------------------------------------- common verbs
  "common.save": "Enregistrer",
  "common.cancel": "Annuler",
  "common.remove": "Supprimer",
  "common.close": "Fermer",
  "common.clearAll": "Tout effacer",
  "common.clearSelection": "D\xE9s\xE9lectionner tout",
  "common.selectAllShown": "S\xE9lectionner tout ce qui est affich\xE9",
  "search.placeholder": "Rechercher\u2026",
  "search.clear": "Effacer la recherche",
  "columns.title": "Cartes par ligne \u2014 moins de colonnes, plus grandes cartes (Ctrl+= / Ctrl+\u2212 / Ctrl+0, ou Ctrl+molette)",
  "columns.perRow": "{count}/ligne",
  "columns.fewer": "Moins de colonnes, cartes plus grandes",
  "columns.more": "Plus de colonnes, cartes plus petites",
  "common.search": "Rechercher",
  "common.loading": "Chargement\u2026",
  "common.never": "jamais",
  "common.none": "aucun",
  "common.of": "{shown} sur {total}",
  "common.selected": "{count} s\xE9lectionn\xE9e(s)",
  "common.retry": "R\xE9essayer",
  // -------------------------------------------------------------- vocabulary
  "rarity.common": "Commune",
  "rarity.uncommon": "Peu commune",
  "rarity.rare": "Rare",
  "rarity.mythic": "Mythique",
  "rarity.special": "Sp\xE9ciale",
  "rarity.bonus": "Bonus",
  "color.W": "Blanc",
  "color.U": "Bleu",
  "color.B": "Noir",
  "color.R": "Rouge",
  "color.G": "Vert",
  "color.C": "Incolore",
  // "Foil" and "etched" are what French players say; only the plain finish
  // has a natural French word.
  "finish.nonfoil": "Normale",
  "finish.foil": "Foil",
  "finish.etched": "Etched",
  "lang.en": "Anglais",
  "lang.fr": "Fran\xE7ais",
  "lang.de": "Allemand",
  "lang.it": "Italien",
  "lang.es": "Espagnol",
  "lang.pt": "Portugais",
  "lang.ja": "Japonais",
  "lang.ko": "Cor\xE9en",
  "lang.ru": "Russe",
  "lang.zhs": "Chinois (simpl.)",
  "lang.zht": "Chinois (trad.)",
  "lang.he": "H\xE9breu",
  "lang.la": "Latin",
  "lang.grc": "Grec ancien",
  "lang.ar": "Arabe",
  "lang.sa": "Sanskrit",
  "lang.ph": "Phyrexian",
  // ------------------------------------------------------------ relative time
  "time.justNow": "\xE0 l'instant",
  "time.minutes": "il y a {count} min",
  "time.hours": "il y a {count} h",
  "time.days": "il y a {count} j",
  // ----------------------------------------------------------------- settings
  "settings.title": "Param\xE8tres",
  "settings.archidekt": "Archidekt",
  "settings.username": "Nom d'utilisateur",
  "settings.usernameHint": "Decks publics uniquement. Les decks priv\xE9s renvoient une erreur 404 \xE0 qui n\u2019est pas connect\xE9 et ne peuvent donc pas \xEAtre synchronis\xE9s \u2014 ajoutez-les par URL s\u2019ils sont non r\xE9pertori\xE9s.",
  "settings.usernamePlaceholder": "votre-nom-archidekt",
  "settings.saveUsername": "Enregistrer",
  "settings.syncNow": "Synchroniser",
  "settings.labels": "Signification de vos \xE9tiquettes de deck",
  "settings.pricesMatching": "Prix et correspondance",
  "settings.currency": "Devise",
  "settings.currencyHint": "Scryfall ne fournit pas de prix en EUR distinct pour les foils grav\xE9s : ceux-ci reprennent le prix foil normal.",
  "settings.currencySourceUsd": "Les prix en USD proviennent de TCGplayer, via Scryfall.",
  "settings.currencySourceEur": "Les prix en EUR proviennent de Cardmarket, via Scryfall.",
  "settings.exactPrinting": "Exiger l\u2019\xE9dition exacte pour les correspondances de deck",
  "settings.exactPrintingHint": "Avec cette option, poss\xE9der l\u2019\xE9dition japonaise ne compte pas comme poss\xE9der une carte que le deck liste en anglais.",
  "settings.appearance": "Apparence",
  "settings.language": "Langue",
  "settings.languageHint": "La langue de l\u2019application elle-m\xEAme. Le nom des cartes reste dans la langue de l\u2019\xE9dition que vous poss\xE9dez.",
  "settings.languageSystem": "Suivre Windows",
  "settings.reduceMotion": "R\xE9duire les animations",
  "settings.reduceMotionHint": "Immobilise les animations, y compris celles dessin\xE9es en JavaScript plut\xF4t qu\u2019en CSS.",
  "settings.data": "Donn\xE9es",
  "settings.dataHint": "Tout tient dans un seul fichier SQLite, plus un dossier d\u2019images de cartes en cache. Copiez-le o\xF9 vous voulez pour d\xE9placer ou sauvegarder votre collection.",
  "settings.savedUsername": "Nom d\u2019utilisateur Archidekt d\xE9fini sur {name}.",
  "settings.clearedUsername": "Nom d\u2019utilisateur effac\xE9.",
  "settings.enterUsernameFirst": "Saisissez d\u2019abord votre nom d\u2019utilisateur Archidekt.",
  "settings.languageChanged": "L\u2019application est maintenant en {language}.",
  // ------------------------------------------------------------------ filters
  "finishPicker.title": "Indiquer le finish que vous poss\xE9dez",
  "finishPicker.finish": "Finish",
  "finishPicker.declareAnyway": "D\xE9clarer quand m\xEAme",
  "finishPicker.fromPrinting": "(d\u2019apr\xE8s l\u2019\xE9dition)",
  "finishPicker.plainFoil": "Foil classique",
  "finishPicker.yours": "Valeur que vous avez indiqu\xE9e, pas celle de Scryfall",
  "filters.language": "Langue",
  "filters.rarity": "Raret\xE9",
  "filters.set": "\xC9dition",
  "filters.finish": "Finition",
  "filters.nothingYet": "Rien \xE0 filtrer pour l\u2019instant",
  "filters.noMatch": "Aucun r\xE9sultat pour \xAB\u202F{query}\u202F\xBB",
  "filters.treatment": "Type de foil",
  "filters.condition": "\xC9tat",
  "filters.colors": "Couleurs",
  "filters.manaValue": "Co\xFBt converti",
  "filters.unitValue": "Valeur unitaire",
  "filters.typeLine": "Ligne de type",
  "filters.typeLinePlaceholder": "Cr\xE9ature, \xC9ph\xE9m\xE8re\u2026",
  "filters.more": "Plus",
  "filters.min": "min",
  "filters.max": "max",
  "filters.searchPlaceholder": "Rechercher nom, nom localis\xE9, \xE9dition, num\xE9ro, type\u2026",
  "filters.deckLocation": "Emplacement en deck",
  "filters.anywhere": "N'importe o\xF9",
  "filters.inADeck": "Dans un deck",
  "filters.notInAnyDeck": "Dans aucun deck (vrac)",
  "filters.whereCopies": "O\xF9 sont les exemplaires",
  "filters.bulkAndDecks": "Vrac et decks",
  "filters.bulkOnly": "Vrac uniquement",
  "filters.inDecksOnly": "En deck uniquement",
  "filters.onlyReserved": "Uniquement r\xE9serv\xE9es par une liste de pr\xE9l\xE8vement",
  "filters.conditionHint": "Les exemplaires en deck proviennent des \xE9tiquettes Archidekt que vous avez marqu\xE9es comme poss\xE9d\xE9es. Ils n\u2019ont pas d\u2019\xE9tat enregistr\xE9 : un filtre sur l\u2019\xE9tat ne retient donc que les cartes saisies par vous.",
  "filters.deckPrefix": "deck : {name}",
  "filters.typePrefix": "type : {value}",
  "filters.cmcRange": "CC {min}\u2013{max}",
  "filters.valueRange": "valeur {min}\u2013{max}",
  "filters.reserved": "r\xE9serv\xE9es",
  // --------------------------------------------------------------- deck view
  "deck.ownershipAll": "Poss\xE9d\xE9es et manquantes",
  "deck.ownershipOwned": "Poss\xE9d\xE9es uniquement",
  "deck.ownershipMissing": "Manquantes uniquement",
  "deck.category": "Cat\xE9gorie",
  "deck.categoryNotInDeck": "{name} (hors deck)",
  "deck.label": "\xC9tiquette",
  "deck.noLabel": "Sans \xE9tiquette",
  "deck.searchPlaceholder": "Rechercher dans ce deck \u2014 nom, \xE9dition, num\xE9ro, type\u2026",
  "deck.sortTitle": "Trier ce deck",
  "deck.groupByCategory": "Grouper par cat\xE9gorie Archidekt",
  "deck.flatList": "Une seule liste",
  "deck.flatListHint": "Une seule liste \u2014 le commandant et les piles Cut/Maybeboard restent \xE0 part",
  "deck.selectAllHint": "S\xE9lectionner toutes les cartes affich\xE9es, pour qu\u2019une langue ne s\u2019applique qu\u2019\xE0 celles-ci",
  "deck.cardsShown": "{shown} cartes sur {total}",
  "deck.typeLinePlaceholder": "Ligne de type\u2026",
  // ------------------------------------------------------ sort and printings
  "sort.by": "Trier par",
  "sort.thenBy": "Puis par",
  "sort.ascending": "Croissant",
  "sort.descending": "D\xE9croissant",
  "sort.removeTiebreak": "Supprimer le crit\xE8re secondaire",
  "sort.collection": "Trier la collection",
  "sort.name": "Nom de la carte",
  "sort.color": "Couleur",
  "sort.cmc": "Co\xFBt converti",
  "sort.rarity": "Raret\xE9",
  "sort.set_code": "\xC9dition",
  "sort.collector_number": "Num\xE9ro de collection",
  "sort.lang": "Langue",
  "sort.finish": "Finition",
  "sort.condition": "\xC9tat",
  "sort.quantity": "Quantit\xE9",
  "sort.unit_value": "Valeur unitaire",
  "sort.total_value": "Valeur totale",
  "sort.added_at": "Ajout\xE9es r\xE9cemment",
  "sort.ownership": "Possession",
  "sort.price": "Prix",
  "printing.printings": "\xC9ditions",
  "printing.forDeck": "pour {name}",
  "printing.forYourCopy": "pour votre exemplaire",
  "printing.notListed": "Non r\xE9pertori\xE9e ?",
  "printing.declared": "{lang} d\xE9clar\xE9e",
  "printing.declaredHint": "Enregistrer une langue dont Scryfall n\u2019a aucune \xE9dition",
  "printing.showAll": "Afficher toutes les \xE9ditions et langues",
  "printing.looking": "Recherche de toutes les \xE9ditions\u2026",
  "printing.noneListed": "Scryfall ne r\xE9pertorie aucune \xE9dition sous ce nom. Si vous poss\xE9dez malgr\xE9 tout la carte, utilisez \xAB Non r\xE9pertori\xE9e ? \xBB pour enregistrer sa langue.",
  "printing.allFiltered": "Les {count} \xE9ditions sont toutes masqu\xE9es par les filtres. Effacez un filtre ci-dessus pour les revoir.",
  "printing.inUse": "C\u2019est l\u2019\xE9dition utilis\xE9e",
  "printing.usePrinting": "Utiliser l\u2019\xE9dition {set} {lang}",
  "printing.own": "{count} poss\xE9d\xE9e(s)",
  "printing.count": "{count} \xE9ditions",
  "printing.nameExample": "For\xEAt",
  "printing.localizedName": "Nom localis\xE9 (facultatif)",
  "printing.forceHint": "Pour une carte dont Scryfall n\u2019a aucune \xE9dition dans votre langue. L\u2019\xE9dition ci-dessus reste inchang\xE9e \u2014 c\u2019est de l\xE0 que viennent les prix et le texte de r\xE8gles \u2014 seuls la langue et le nom deviennent ce que vous d\xE9clarez.",
  "printing.stopDeclaring": "Ne plus d\xE9clarer de langue",
  "printing.declaredToast": "Enregistr\xE9e comme {language}. L\u2019\xE9dition sous-jacente est inchang\xE9e, les prix fonctionnent donc toujours.",
  "printing.backToArchidekt": "Retour \xE0 la description de son \xE9dition.",
  "printing.deckUses": "{deck} utilise maintenant l\u2019\xE9dition {lang}.",
  "printing.copyIsNow": "Votre exemplaire est maintenant l\u2019\xE9dition {lang}.",
  // ------------------------------------------------------------ bulk actions
  "bulk.setLanguage": "D\xE9finir la langue",
  "bulk.working": "En cours\u2026",
  "bulk.setLanguageHint": "Enregistrer la langue des exemplaires que vous poss\xE9dez r\xE9ellement",
  "bulk.setFinish": "Finish\u2026",
  "bulk.setFinishHint": "Indiquer le finish et le type de foil que vous poss\xE9dez pour ces cartes",
  "bulk.finishHint": "Archidekt indique seulement foil ou non. Ce que vous r\xE9glez ici survit \xE0 une synchro.",
  "bulk.finishFromArchidekt": "Revenir \xE0 la valeur d\u2019Archidekt",
  "bulk.finishDone": "{count} carte(s) pass\xE9e(s) en {finish}.",
  "bulk.finishCleared": "{count} carte(s) revenue(s) au finish d\u2019Archidekt.",
  "bulk.clearOverride": "Effacer le remplacement",
  "bulk.languageHint": "Une recherche par carte. Toute carte sans \xE9dition dans cette langue conserve la sienne et est signal\xE9e.",
  "bulk.converted": "{count} d\xE9finie(s) en {lang}",
  "bulk.viaSearch": "{count} trouv\xE9e(s) sous une autre \xE9dition",
  "bulk.unavailable": "{count} sans \xE9dition {lang}",
  "bulk.failed": "{count} en \xE9chec",
  "bulk.cleared": "{count} de retour \xE0 ce qu\u2019indique Archidekt",
  // ------------------------------------------------------------ booster odds
  "picks.title": "Listes de pr\xE9l\xE8vement",
  "picks.new": "Nouvelle liste",
  "picks.cardsAndValue": "{cards} cartes \xB7 {value}",
  "picks.none": "Aucune liste pour l\u2019instant. S\xE9lectionnez des cartes dans la collection et choisissez \xAB Ajouter \xE0 une liste \xBB.",
  "picks.noneSelected": "Aucune liste s\xE9lectionn\xE9e",
  "picks.noneSelectedHint": "Une liste pr\xE9pare des cartes \xE0 sortir. Votre collection reste intacte jusqu\u2019\xE0 la validation, donc annuler ne co\xFBte rien.",
  "picks.emptyTitle": "Rien de pr\xE9par\xE9",
  "picks.emptyHint": "S\xE9lectionnez des lignes dans la collection et utilisez \xAB Ajouter \xE0 une liste \xBB. Les exemplaires pr\xE9par\xE9s sont r\xE9serv\xE9s mais restent dans votre collection jusqu\u2019\xE0 la validation.",
  "picks.deckWarning_one": "{count} carte pr\xE9par\xE9e est utilis\xE9e par un deck synchronis\xE9. La sortir laissera ce deck incomplet.",
  "picks.deckWarning_other": "{count} cartes pr\xE9par\xE9es sont utilis\xE9es par des decks synchronis\xE9s. Les sortir laissera ces decks incomplets.",
  "picks.cardsInGroup": "{count} cartes",
  "picks.cancelled": "Liste annul\xE9e \u2014 toutes les r\xE9servations sont lev\xE9es, la collection est intacte.",
  "picks.deleted": "Liste supprim\xE9e.",
  "picks.exported": "{count} lignes export\xE9es.",
  "picks.statusOpen": "Ouverte \u2014 r\xE9serv\xE9e, rien n\u2019est encore retir\xE9",
  "picks.statusConfirmed": "Valid\xE9e {when} \u2014 historique",
  "picks.statusCancelled": "Annul\xE9e \u2014 rien n\u2019a \xE9t\xE9 retir\xE9",
  "picks.summary": "{cards} cartes sur {rows} lignes \xB7 {value}",
  "picks.rowView": "Vue en lignes",
  "picks.gridView": "Vue en grille",
  "picks.export": "Exporter",
  "picks.cancelPull": "Annuler la sortie",
  "picks.validatePull": "Valider la sortie",
  "picks.reopen": "R\xE9ouvrir",
  "picks.delete": "Supprimer",
  "picks.confirmedKept": "Les listes valid\xE9es sont conserv\xE9es comme historique.",
  "picks.rowGone": "(ligne plus dans la collection)",
  "picks.deckCount_one": "{count} deck",
  "picks.deckCount_other": "{count} decks",
  "picks.removeItem": "Retirer de la liste",
  "picks.picked": "{count} pris",
  "picks.confirmTitle": "Valider cette sortie",
  "picks.confirmBody_one": "Ceci retire {count} carte de votre collection en une fois. Rien n\u2019est d\xE9duit avant que vous confirmiez.",
  "picks.confirmBody_other": "Ceci retire {count} cartes de votre collection en une fois. Rien n\u2019est d\xE9duit avant que vous confirmiez.",
  "picks.inDeck_one": "{count} de ces cartes est dans un deck",
  "picks.inDeck_other": "{count} de ces cartes sont dans un deck",
  "picks.andMore": "\u2026et {count} de plus",
  "picks.emptying_one": "{count} ligne va tomber \xE0 z\xE9ro et sera retir\xE9e de la collection. Cette liste en garde sa propre trace, pour que l\u2019historique reste lisible.",
  "picks.emptying_other": "{count} lignes vont tomber \xE0 z\xE9ro et seront retir\xE9es de la collection. Cette liste en garde sa propre trace, pour que l\u2019historique reste lisible.",
  "picks.notYet": "Pas encore",
  "picks.removing": "Retrait\u2026",
  "picks.confirmAction": "Confirmer \u2014 retirer {count}",
  "picks.pulled_one": "{count} carte sortie",
  "picks.pulled_other": "{count} cartes sorties",
  "picks.pulledRows": " ; {count} ligne(s) vid\xE9e(s) et retir\xE9e(s)",
  "picks.defaultName": "Liste de pr\xE9l\xE8vement",
  "labels.dontOwn": "pas \xE0 moi",
  "labels.dontOwnHint": "Une entr\xE9e de liste de souhaits. Le deck cesse de compter comme un endroit o\xF9 vit cette carte, et elle n\u2019apporte rien \xE0 votre collection.",
  "labels.ignore": "ignorer",
  "labels.ignoreHint": "L\u2019\xE9tiquette ne veut rien dire ici. La possession vient uniquement des cartes que vous avez saisies.",
  "labels.own": "\xE0 moi",
  "labels.ownHint": "Ces exemplaires comptent dans votre collection \u2014 vos cartes physiques, sous pochette dans un deck plut\xF4t qu\u2019en vrac.",
  "labels.intro1": "Indiquez ce que signifie chaque couleur d\u2019\xE9tiquette Archidekt.",
  "labels.intro2": "traite ces entr\xE9es de deck comme une liste de souhaits \u2014 le deck cesse de compter comme un endroit o\xF9 vit la carte.",
  "labels.intro3": "les traite comme vos cartes, sous pochette dans un deck, donc elles comptent dans votre collection.",
  "labels.intro4": "laisse la possession aux cartes que vous avez saisies vous-m\xEAme.",
  "labels.emptyTitle": "Aucune \xE9tiquette trouv\xE9e pour l\u2019instant",
  "labels.emptyHint": "Synchronisez un deck qui utilise des \xE9tiquettes color\xE9es et elles appara\xEEtront ici. Vous pouvez aussi ajouter une couleur en hexad\xE9cimal ci-dessous.",
  "labels.unnamed": "(\xE9tiquette sans nom)",
  "labels.usage_one": "{cards} cartes dans {count} deck",
  "labels.usage_other": "{cards} cartes dans {count} decks",
  "labels.unused": "utilis\xE9e par aucun deck synchronis\xE9",
  "labels.addColour": "Ajouter une couleur",
  "labels.badHex": "Saisissez une couleur hexad\xE9cimale, par exemple #f47373.",
  "labels.addHint1": "Pour une couleur utilis\xE9e seulement dans un deck que vous n\u2019avez pas encore synchronis\xE9. Ajout\xE9e comme",
  "labels.addHint2": "modifiez-la ici ensuite.",
  "stats.title": "Statistiques",
  "stats.lastRefreshed": "Prix actualis\xE9s {when}",
  "stats.refreshing": "Actualisation\u2026",
  "stats.refreshPrices": "Actualiser les prix",
  "stats.refreshed": "{updated} \xE9ditions actualis\xE9es sur {requested}.",
  "stats.refreshedUnpriced": " {count} n\u2019ont pas de prix sur Scryfall \u2014 courant pour les \xE9ditions non anglaises.",
  "stats.emptyTitle": "Rien \xE0 mesurer pour l\u2019instant",
  "stats.emptyHint": "Ajoutez des cartes et cette page d\xE9taillera votre collection par raret\xE9, langue, \xE9dition et valeur.",
  "stats.totalCards": "Cartes au total",
  "stats.splitCards": "{bulk} en vrac + {deck} sous pochette dans des decks",
  "stats.distinctRows": "Lignes distinctes",
  "stats.collectionValue": "Valeur de la collection",
  "stats.splitValue": "{bulk} en vrac + {deck} dans des decks",
  "stats.looseVsDecks": "En vrac / dans des decks",
  "stats.looseVsDecksHint": "cartes dans aucun deck / cartes utilis\xE9es par un deck synchronis\xE9",
  "stats.byLanguage": "Par langue",
  "stats.byLanguageHint": "Cliquez une ligne pour filtrer la collection",
  "stats.byRarity": "Par raret\xE9",
  "stats.topSets": "Meilleures \xE9ditions par valeur",
  "stats.topCards": "Cartes les plus ch\xE8res",
  "csv.field.quantity": "Quantit\xE9",
  "csv.field.name": "Nom de la carte",
  "csv.field.set": "Code d\u2019\xE9dition",
  "csv.field.collectorNumber": "Num\xE9ro de collection",
  "csv.field.lang": "Langue",
  "csv.field.langHint": "N\xE9cessaire pour importer des \xE9ditions non anglaises",
  "csv.field.finish": "Finish / foil",
  "csv.field.condition": "\xC9tat",
  "csv.field.scryfallId": "Identifiant Scryfall",
  "csv.field.scryfallIdHint": "Le plus pr\xE9cis s\u2019il est pr\xE9sent",
  "csv.field.purchasePrice": "Prix d\u2019achat",
  "csv.title": "Import / export",
  "csv.subtitle": "Rien n\u2019est \xE9crit avant que vous examiniez l\u2019aper\xE7u et lanciez l\u2019import.",
  "csv.step1": "1 \xB7 Choisir un fichier",
  "csv.chooseFile": "Choisir un CSV",
  "csv.detected": "Format {preset} d\xE9tect\xE9 \xB7 {rows} lignes \xB7 {columns} colonnes",
  "csv.step2": "2 \xB7 Associer les colonnes",
  "csv.notMapped": "\u2014 non associ\xE9e \u2014",
  "csv.resolving": "R\xE9solution\u2026",
  "csv.previewImport": "Aper\xE7u de l\u2019import",
  "csv.resolveHint": "Les lignes avec une langue sont r\xE9solues une par une \u2014 l\u2019API group\xE9e ignore la langue, donc cela peut prendre un moment sur un gros fichier.",
  "csv.step3": "3 \xB7 V\xE9rifier, puis importer",
  "csv.matched": "Trouv\xE9es",
  "csv.ambiguous": "Ambigu\xEBs",
  "csv.unmatched": "Introuvables",
  "csv.candidates": "{count} \xE9ditions possibles \u2014 il faut une \xE9dition ou un num\xE9ro",
  "csv.showingFirst": "Affichage des 300 premi\xE8res lignes sur {count}. Toutes seront import\xE9es.",
  "csv.importing": "Import\u2026",
  "csv.importMatched": "Importer {count} lignes trouv\xE9es",
  "csv.saveUnresolved": "Enregistrer les lignes non r\xE9solues",
  "csv.unresolvedSkipped": "Les lignes non r\xE9solues sont ignor\xE9es, jamais devin\xE9es.",
  "csv.emptyTitle": "Charger une liste existante en masse",
  "csv.emptyHint": "Des pr\xE9r\xE9glages existent pour les exports ManaBox, Moxfield et Deckbox, et tout le reste peut \xEAtre associ\xE9 \xE0 la main.",
  "csv.export": "Export",
  "csv.exportHint": "Exporte ce que la vue Collection affiche actuellement, avec des colonnes qui repassent telles quelles par cet importateur.",
  "csv.exportCollection": "Exporter la collection",
  "csv.howMatched": "Comment les lignes sont associ\xE9es",
  "csv.match1": "Identifiant Scryfall \u2014 exact, sans supposition",
  "csv.match2": "\xC9dition + num\xE9ro + langue",
  "csv.match3": "Nom + \xE9dition",
  "csv.match4": "Nom seul",
  "csv.matchNote": "Un nom seul correspond souvent \xE0 beaucoup d\u2019\xE9ditions. Ces lignes sont marqu\xE9es ambigu\xEBs et laiss\xE9es de c\xF4t\xE9 plut\xF4t qu\u2019attribu\xE9es \xE0 une \xE9dition arbitraire.",
  "csv.imported": "{cards} cartes import\xE9es sur {rows} lignes",
  "csv.importedSkipped": " ; {count} non r\xE9solues ignor\xE9es.",
  "csv.wroteRejects": "{count} lignes non r\xE9solues \xE9crites dans {path}",
  "csv.exported": "{count} lignes export\xE9es vers {path}",
  "detail.card": "Carte",
  "detail.viewOnScryfall": "Voir sur Scryfall",
  "detail.notCached": "Cette carte n\u2019est pas encore en cache.",
  "detail.set": "\xC9dition",
  "detail.number": "Num\xE9ro",
  "detail.cost": "Co\xFBt",
  "detail.type": "Type",
  "detail.released": "Sortie",
  "detail.finishes": "Finishes",
  "detail.foilType": "Type de foil",
  "detail.prices": "Prix",
  "detail.normal": "Normal",
  "detail.foil": "Foil",
  "detail.etched": "Etched",
  "detail.na": "n/d",
  "detail.whereItIs": "O\xF9 elle se trouve",
  "detail.inCollection": "Dans la collection",
  "detail.totalHeld": "{total} au total",
  "detail.totalHeldReserved": "{total} au total, {held} r\xE9serv\xE9es",
  "detail.dontOwnPrinting": "Vous ne poss\xE9dez pas cette \xE9dition.",
  "detail.heldBadge": "{count} r\xE9serv\xE9es",
  "detail.reservedTooltip": "Des exemplaires sont r\xE9serv\xE9s par une liste ouverte",
  "detail.removeRow": "Retirer tous les exemplaires de cette ligne",
  "detail.stagedIn": "Pr\xE9par\xE9e dans des listes",
  "detail.notStaged": "Pas pr\xE9par\xE9e pour une sortie.",
  "detail.inDecks": "Dans des decks",
  "detail.noDecks": "Utilis\xE9e par aucun deck synchronis\xE9.",
  "detail.matchExact": "Ce deck utilise exactement cette \xE9dition, dans cette langue",
  "detail.matchOracle": "Ce deck utilise la m\xEAme carte dans une autre \xE9dition ou langue",
  "detail.exact": "exacte",
  "detail.otherPrinting": "autre \xE9dition",
  "detail.oracleNote1": "Une correspondance",
  "detail.oracleNote2": "signifie que le deck liste cette carte dans une \xE9dition ou une langue diff\xE9rente de la v\xF4tre \u2014 la carte physique de ce deck n\u2019est pas celle-ci.",
  "detail.excludedNote": "Les decks o\xF9 cette carte est marqu\xE9e comme n\u2019\xE9tant pas \xE0 vous sont exclus \u2014 une entr\xE9e de liste de souhaits n\u2019est pas un endroit o\xF9 vit une carte. Valeurs affich\xE9es en {currency}.",
  "add.title": "Ajouter des cartes",
  "add.tabSearch": "Rechercher par nom",
  "add.tabQuick": "Saisie rapide",
  "add.noPrintings": "Aucune \xE9dition trouv\xE9e pour \xAB {name} \xBB.",
  "add.added": "{quantity}\xD7 {name} ({lang}){note} ajout\xE9e(s) \u2014 vous en avez maintenant {owned}.",
  "add.addedFinishNote": " en {finish}, le seul finish disponible",
  "add.searchPlaceholder": "Nom de la carte \u2014 appuyez sur Entr\xE9e pour voir toutes les \xE9ditions",
  "add.finish": "Finish",
  "add.condition": "\xC9tat",
  "add.quantity": "Quantit\xE9",
  "add.perRow": "Par ligne",
  "add.truncated": "Cette carte a {total} \xE9ditions toutes langues confondues. Les {shown} plus r\xE9centes sont affich\xE9es \u2014 Scryfall demande que la consultation en masse passe par ses fichiers plut\xF4t que par des requ\xEAtes page par page, donc la recherche s\u2019arr\xEAte l\xE0. Affinez par \xE9dition ou par langue, ou utilisez la saisie rapide si vous connaissez l\u2019\xE9dition et le num\xE9ro.",
  "add.lookupTitle": "Chercher une carte",
  "add.lookupHint": "Tapez un nom et appuyez sur Entr\xE9e. Vous obtiendrez toutes les \xE9ditions dans toutes les langues \u2014 choisissez exactement celle que vous avez en main.",
  "add.allFilteredTitle": "Toutes les \xE9ditions sont filtr\xE9es",
  "add.allFilteredHint_one": "Cette carte a {count} \xE9dition, et les filtres ci-dessus la masquent. Retirez un filtre pour la revoir.",
  "add.allFilteredHint_other": "Cette carte a {count} \xE9ditions, et les filtres ci-dessus les masquent toutes. Retirez un filtre pour les revoir.",
  "add.onlyFinish": "{name} n\u2019existe qu\u2019en {finish} \u2014 sera ajout\xE9e en {finish}",
  "add.addCard": "Ajouter {name}",
  "add.foilIs": "Le foil de cette \xE9dition est {treatment}",
  "add.finishOnly": "{finish} uniquement",
  "add.owned": "{count} en stock",
  "add.badFormat": "Le format est : \xC9DITION NUM\xC9RO [LANGUE] [xN] \u2014 par exemple \xAB m10 146 ja x3 \xBB.",
  "add.quickIntro": "Le moyen le plus rapide de saisir un tas de cartes. Tapez le code d\u2019\xE9dition, le num\xE9ro de collection et la langue, puis appuyez sur Entr\xE9e. C\u2019est la seule voie qui atteint de fa\xE7on fiable une \xE9dition dans une langue pr\xE9cise.",
  "add.quickLabel": "\xC9dition \xB7 num\xE9ro \xB7 langue \xB7 quantit\xE9",
  "add.adding": "Ajout\u2026",
  "add.add": "Ajouter",
  "add.logEmptyTitle": "Rien de saisi pour l\u2019instant",
  "add.logEmptyHint": "Les cartes ajout\xE9es apparaissent ici, pour que vous gardiez les yeux sur le tas plut\xF4t que sur l\u2019\xE9cran.",
  "coll.title": "Collection",
  "coll.loading": "Chargement\u2026",
  "coll.summary": "{cards} cartes sur {rows} lignes \xB7 ",
  "coll.deckSplit": "({bulk} en vrac + {deck} dans des decks)",
  "coll.deckSplitHint": "Cartes sous pochette dans des decks, sous une couleur d\u2019\xE9tiquette que vous avez marqu\xE9e comme v\xF4tre",
  "coll.sortTitle": "Trier la collection",
  "coll.tableView": "Vue en tableau",
  "coll.galleryView": "Vue en galerie",
  "coll.export": "Export",
  "coll.emptyTitle": "Votre collection est vide",
  "coll.noMatchTitle": "Aucune carte ne correspond \xE0 ces filtres",
  "coll.emptyHint": "Ajoutez des cartes depuis l\u2019onglet Ajouter, ou chargez une liste existante depuis Import / export.",
  "coll.noMatchHint": "Essayez de retirer un filtre ou deux.",
  "coll.nothingToPick": "Rien de disponible \u2014 ces exemplaires sont d\xE9j\xE0 r\xE9serv\xE9s.",
  "coll.staged_one": "{count} carte pr\xE9par\xE9e",
  "coll.staged_other": "{count} cartes pr\xE9par\xE9es",
  "coll.stagedCapped": " ({count} ligne(s) limit\xE9e(s) par la disponibilit\xE9)",
  "coll.exported": "{count} lignes export\xE9es vers {path}",
  "coll.selectAll": "S\xE9lectionner toutes les lignes",
  "coll.selectRow": "S\xE9lectionner {name}",
  "coll.cardDetails": "D\xE9tails de la carte",
  "coll.youSetThis": "Valeur que vous avez indiqu\xE9e",
  "coll.inDecksHint_one": "Dans {count} deck \u2014 cliquez pour les d\xE9tails",
  "coll.inDecksHint_other": "Dans {count} decks \u2014 cliquez pour les d\xE9tails",
  "coll.sleevedIn": "Sous pochette dans {decks} \u2014 modifiez-le dans Archidekt",
  "coll.sleevedInShort": "Sous pochette dans {decks}",
  "coll.inDeckBadge": "en deck",
  "coll.inDeckCount": "Dans {count} deck(s)",
  "coll.reservedBadge": "{count} r\xE9serv\xE9e(s) par une liste ouverte",
  "coll.rowRemoved": "Ligne retir\xE9e.",
  "coll.removeRow": "Retirer la ligne",
  "coll.addToPickList": "Ajouter \xE0 une liste",
  "coll.finishPlaceholder": "Finish\u2026",
  "coll.treatmentPlaceholder": "Type de foil\u2026",
  "coll.fromThePrinting": "D\u2019apr\xE8s l\u2019\xE9dition",
  "coll.conditionPlaceholder": "\xC9tat\u2026",
  "coll.remove": "Retirer",
  "coll.setFinishDone": "{count} ligne(s) pass\xE9e(s) en {finish}.",
  "coll.setTreatmentDone": "{count} ligne(s) pass\xE9e(s) en {treatment}.",
  "coll.clearedTreatment": "Type de foil effac\xE9 sur {count} ligne(s).",
  "coll.setConditionDone": "{count} ligne(s) pass\xE9e(s) en {condition}.",
  "coll.removedRows": "{count} ligne(s) retir\xE9e(s)",
  "coll.removedSkipped": " ; {count} ignor\xE9e(s) \u2014 r\xE9serv\xE9e(s) par une liste ouverte.",
  "coll.col.card": "Carte",
  "coll.col.lang": "Lang",
  "coll.col.rarity": "Rar",
  "coll.col.set": "\xC9d.",
  "coll.col.finish": "Finish",
  "coll.col.condition": "\xC9tat",
  "coll.col.decks": "Decks",
  "coll.col.qty": "Qt\xE9",
  "coll.col.unit": "Unit\xE9",
  "coll.col.total": "Total",
  "decks.sidebarTitle": "Decks Archidekt",
  "decks.syncing": "Synchronisation\u2026",
  "decks.syncUser": "Synchroniser {username}",
  "decks.setUsernameFirst": "Renseignez d\u2019abord un pseudo",
  "decks.addUsernameHint": "Ajoutez votre pseudo Archidekt dans les r\xE9glages pour synchroniser automatiquement.",
  "decks.labelMeanings": "Sens des \xE9tiquettes",
  "decks.urlPlaceholder": "URL ou identifiant du deck",
  "decks.syncResult": "Decks : {parts}.",
  "decks.syncSynced": "{count} synchronis\xE9s",
  "decks.syncUnchanged": "{count} inchang\xE9s",
  "decks.syncUnavailable": "{count} indisponibles",
  "decks.privateWarning": "Archidekt annonce {reported} decks mais n\u2019en a partag\xE9 que {shared}. Les decks priv\xE9s ne peuvent pas \xEAtre lus sans connexion \u2014 ajoutez-les par URL s\u2019ils sont simplement non list\xE9s.",
  "decks.added": "\xAB {name} \xBB ajout\xE9.",
  "decks.cardCount": "{count} cartes",
  "decks.noneYet": "Aucun deck pour l\u2019instant. Synchronisez votre compte Archidekt, ou collez une URL de deck ci-dessus.",
  "decks.selectADeck": "Choisissez un deck",
  "decks.noneSynced": "Aucun deck synchronis\xE9",
  "decks.selectHint": "Choisissez un deck pour voir les cartes que vous avez d\xE9j\xE0 et celles qui vous manquent.",
  "decks.noneSyncedHint": "Synchroniser des decks ne change jamais votre collection \u2014 les decks sont des donn\xE9es de r\xE9f\xE9rence en lecture seule qui indiquent o\xF9 se trouve d\xE9j\xE0 une carte.",
  "decks.removedLocally": "Deck retir\xE9 localement.",
  "decks.labelsModalTitle": "Ce que signifient vos \xE9tiquettes",
  "decks.cardsCount": "{count} cartes",
  "decks.inDeckSplit": "({inDeck} dans le deck, {outside} en dehors)",
  "decks.syncedAt": "synchronis\xE9 {when}",
  "decks.rowView": "Vue en lignes",
  "decks.gridView": "Vue en grille",
  "decks.remove": "Retirer",
  "decks.syncErrorNote": "{error}. Les decks priv\xE9s renvoient 404 \xE0 toute requ\xEAte non authentifi\xE9e, donc celui-ci ne peut pas \xEAtre lu. Les decks non list\xE9s fonctionnent si vous les ajoutez par URL.",
  "decks.owned": "{count} poss\xE9d\xE9es",
  "decks.missing": "{count} manquantes",
  "decks.missingPile": "Pile manquante \u2248 ",
  "decks.entries": "{count} entr\xE9es",
  "decks.exactOnlyHint": "Avec cette option, poss\xE9der l\u2019\xE9dition japonaise ne compte pas comme poss\xE9der une carte que le deck liste en anglais.",
  "decks.exactOnly": "Exiger l\u2019\xE9dition exacte",
  "decks.nothingMatches": "Aucune correspondance",
  "decks.nothingMatchesHint": "Aucune carte de ce deck ne correspond \xE0 la recherche et aux filtres actuels.",
  "decks.notCountedHint": "Archidekt ne compte pas cette cat\xE9gorie dans le deck.",
  "decks.notInDeck": "hors deck",
  "decks.deselect": "D\xE9s\xE9lectionner {name}",
  "decks.select": "S\xE9lectionner {name}",
  "decks.langForced": "Vous avez d\xE9clar\xE9 cette langue \u2014 Scryfall n\u2019a aucune \xE9dition de cette carte dans celle-ci",
  "decks.langOverride": "Vous avez r\xE9gl\xE9 ceci sur {lang}",
  "decks.langUnavailable": "Aucune \xE9dition {lang} de cette carte n\u2019existe, elle a donc \xE9t\xE9 laiss\xE9e telle quelle",
  "decks.langUnavailableTile": "Aucune \xE9dition {lang} de cette carte n\u2019existe, elle a donc gard\xE9 la sienne.",
  "decks.have": "j\u2019en ai {held}",
  "decks.haveOf": "j\u2019en ai {held} / {needed}",
  "decks.otherPrintingHint": "Vous poss\xE9dez {count} exemplaires de cette carte, mais dans une autre \xE9dition ou langue",
  "decks.otherPrinting": "autre \xE9dition",
  "decks.labelOwnedHint": "Marqu\xE9e \xAB {label} \xBB dans Archidekt comme une carte \xE0 vous, donc ces {count} comptent dans votre collection.",
  "decks.labelOwnedShort": "\xE0 moi",
  "decks.labelLooseHint": "Marqu\xE9e \xAB {label} \xBB dans Archidekt, donc ce deck ne d\xE9tient pas vos exemplaires \u2014 vos {held} devraient \xEAtre en vrac.",
  "decks.labelLoose": "hors deck \xB7 {held} en vrac",
  "decks.labelNotOwnedHint": "Marqu\xE9e \xAB {label} \xBB dans Archidekt \u2014 une carte qui n\u2019est pas \xE0 vous, donc ce deck ne compte pas comme un endroit o\xF9 elle vit.",
  "decks.labelNotOwnedShort": "pas \xE0 moi",
  "decks.ownedInArchidekt": "Marqu\xE9e comme une carte \xE0 vous dans Archidekt \u2014 compte dans votre collection",
  "decks.notOwnedInArchidekt": "Marqu\xE9e comme une carte qui n\u2019est pas \xE0 vous dans Archidekt",
  "decks.notOwnedButHeld": " \u2014 vos {held} exemplaires sont en vrac",
  "decks.langSet": "{count} pass\xE9es en {lang}",
  "decks.langNoPrinting": "{count} n\u2019ont pas d\u2019\xE9dition {lang}",
  "decks.langFailed": "{count} en \xE9chec",
  "decks.clearedOverrides": "{count} revenues \xE0 ce que dit Archidekt.",
  "common.removeFilter": "Retirer le filtre",
  "common.decrease": "Diminuer",
  "common.increase": "Augmenter",
  "common.quantity": "Quantit\xE9",
  "common.dismiss": "Fermer",
  "settings.usernameSet": "Pseudo Archidekt r\xE9gl\xE9 sur {username}.",
  "settings.usernameCleared": "Pseudo effac\xE9.",
  "settings.usernameFirst": "Saisissez d\u2019abord votre pseudo Archidekt.",
  "settings.syncing": "Synchronisation\u2026",
  "settings.syncNote": "La synchronisation r\xE9cup\xE8re tous les decks publics et non list\xE9s du compte. Les donn\xE9es de deck sont une r\xE9f\xE9rence en lecture seule : elles indiquent o\xF9 se trouve d\xE9j\xE0 une carte et ne changent jamais ce que votre collection dit poss\xE9der.",
  "settings.privateNote": "Les decks priv\xE9s renvoient 404 \xE0 toute requ\xEAte non authentifi\xE9e, ils ne peuvent donc pas \xEAtre synchronis\xE9s. Matomeru ne stocke aucun identifiant \u2014 si un deck est non list\xE9 plut\xF4t que priv\xE9, ajoutez-le par URL depuis l\u2019onglet Decks.",
  "settings.openArchidekt": "Ouvrir Archidekt",
  "settings.labelsTitle": "Ce que signifient vos \xE9tiquettes",
  "settings.pricesTitle": "Prix & correspondance",
  "settings.exactMatch": "Exiger l\u2019\xE9dition exacte pour les correspondances de deck",
  "settings.exactMatchHint": "D\xE9sactiv\xE9 : poss\xE9der une carte dans n\u2019importe quelle langue compte. Activ\xE9 : seule l\u2019\xE9dition identique compte, donc l\u2019exemplaire japonais ne satisfait pas un deck qui liste l\u2019anglais.",
  "settings.pricesRefreshed": "Prix actualis\xE9s {when}.",
  "settings.dataTitle": "O\xF9 vivent vos donn\xE9es",
  "settings.dataNote1": "La base de la collection et le cache des images vivent dans votre dossier app-data Windows, d\xE9lib\xE9r\xE9ment hors du dossier de l\u2019application, pour qu\u2019une r\xE9installation ou une mise \xE0 jour de Matomeru ne touche jamais votre collection.",
  "settings.dataNote2": "Les donn\xE9es de carte viennent de Scryfall ; celles des decks d\u2019Archidekt. Aucun des deux n\u2019est affili\xE9 \xE0 cette application, et rien n\u2019est envoy\xE9 o\xF9 que ce soit \u2014 chaque requ\xEAte est une lecture.",
  "err.noDataDir": "R\xE9pertoire de donn\xE9es non configur\xE9 \u2014 appelez setDataDir() au d\xE9marrage.",
  "err.reserved": "Suppression impossible : des exemplaires sont r\xE9serv\xE9s par une liste ouverte.",
  "err.itemNotFound": "Ligne de collection introuvable.",
  "err.notCached": "Cette \xE9dition n\u2019est pas encore en cache \u2014 cherchez d\u2019abord la carte.",
  "err.noLangAnchor": "Cette entr\xE9e de deck n\u2019a aucune \xE9dition sur laquelle fixer une langue.",
  "err.noFinishAnchor": "Cette entr\xE9e de deck n\u2019a aucune \xE9dition sur laquelle fixer un finish.",
  "err.pickListNotFound": "Liste introuvable.",
  "err.pickListClosed": "Cette liste est d\xE9j\xE0 ferm\xE9e.",
  "err.pickItemNotFound": "Ligne de liste introuvable.",
  "err.confirmedIsHistory": "Une liste valid\xE9e fait partie de l\u2019historique et ne peut pas \xEAtre r\xE9ouverte.",
  "err.onlyAvailable": "Seulement {count} disponible(s) \xE0 pr\xE9lever.",
  "err.setUsername": "Renseignez d\u2019abord votre pseudo Archidekt dans les r\xE9glages.",
  "err.quantityAtLeastOne": "La quantit\xE9 doit \xEAtre au moins 1.",
  "err.notADeckUrl": "Cela ne ressemble pas \xE0 une URL ou un identifiant de deck Archidekt.",
  "err.noArchidektAccount": "Aucun compte Archidekt trouv\xE9 pour \xAB {username} \xBB.",
  "err.mtgjsonNoData": "MTGJSON n\u2019a pas de donn\xE9es pour {set} ({status}).",
  "err.archidektUnreachable": "Impossible de joindre Archidekt : {message}",
  "err.archidektStatus": "Archidekt a renvoy\xE9 {status}",
  "csv.reasonDeckRow": "Ignor\xE9e \u2014 cette ligne est un exemplaire de deck, d\xE9j\xE0 compt\xE9 via son \xE9tiquette.",
  "csv.reasonNoIdentity": "La ligne n\u2019a ni nom, ni identifiant, ni \xE9dition + num\xE9ro.",
  "boosters.title": "O\xF9 la trouver",
  "boosters.load": "Charger les probabilit\xE9s pour {set}",
  "boosters.loading": "T\xE9l\xE9chargement des donn\xE9es de booster {set}\u2026",
  "boosters.loadHint": "T\xE9l\xE9charge les recettes de booster de cette \xE9dition depuis MTGJSON (quelques Mo, une fois par \xE9dition) et ne conserve que les probabilit\xE9s.",
  "boosters.noData": "MTGJSON ne r\xE9pertorie aucun booster pour {set}. Les cartes des decks Commander, Secret Lair et produits similaires ne sont pas vendues en booster.",
  "boosters.notInBooster": "absente de ce booster",
  "boosters.perPack": "{percent} par booster",
  "boosters.oneIn": "environ 1 booster sur {count}",
  "boosters.expected": "{count} par booster en moyenne",
  "boosters.cardsPerPack": "{count} cartes par booster",
  "boosters.approximate": "Approximatif : cette carte figure sur une feuille \xE9quilibr\xE9e en couleurs, ce qui \xE9carte le tirage des poids bruts.",
  "boosters.products": "Dans les produits scell\xE9s",
  "boosters.productChance": "{count} boosters \u2014 {percent}",
  "boosters.notListed": "Scryfall ne r\xE9pertorie pas cette \xE9dition comme une carte de booster \u2014 mais une version showcase ou borderless de la m\xEAme carte l\u2019est souvent, donc les chances ci-dessous valent le coup d\u2019\u0153il.",
  "boosters.isInBoosters": "Cette carte existe bien en booster. Chargez {set} ci-dessous pour les chances r\xE9elles.",
  "boosters.viaEnglish": "Trouv\xE9e via l\u2019\xE9dition anglaise, la seule que les donn\xE9es de booster nomment.",
  "boosters.loadAll": "R\xE9cup\xE9rer les donn\xE9es de booster de ma collection",
  "boosters.loadAllHint": "R\xE9cup\xE8re les \xE9ditions dont vous poss\xE9dez des cartes de booster, en ignorant les pr\xE9cons",
  "boosters.loadAllRunning": "R\xE9cup\xE9ration {done} sur {total}\u2026",
  "boosters.loadAllDone": "{sets} \xE9dition(s) charg\xE9e(s) ; {skipped} en avaient d\xE9j\xE0.",
  "boosters.loadAllFailed": "{sets} \xE9dition(s) charg\xE9e(s). MTGJSON n\u2019a pas de donn\xE9es pour {failed}.",
  "boosters.loadAllNothing": "Toutes les \xE9ditions concern\xE9es ont d\xE9j\xE0 leurs donn\xE9es.",
  "boosters.notCovered": "aucune donn\xE9e pour ce booster",
  "boosters.partial": "en partie d\u2019autres \xE9ditions",
  "boosters.partialHint": "Certains emplacements de ce booster sont remplis depuis d\u2019autres \xE9ditions, que ces donn\xE9es ne peuvent pas nommer \u2014 la chance affich\xE9e est donc un minimum, pas le tableau complet.",
  "boosters.source": "Recettes de booster issues de MTGJSON. Les pourcentages correspondent \xE0 la chance d\u2019au moins un exemplaire dans un booster.",
  "boosters.refresh": "Actualiser",
  "boosters.loaded": "{boosters} types de booster, {cards} cartes calcul\xE9es pour {set}.",
  // ------------------------------------------------------------------- errors
  "error.printingNotCached": "Cette \xE9dition n\u2019est pas encore en cache \u2014 cherchez d\u2019abord la carte.",
  "error.quantityAtLeastOne": "La quantit\xE9 doit \xEAtre au moins 1.",
  "error.noPrintingFound": "Aucune \xE9dition trouv\xE9e pour {set} #{number} en \xAB {lang} \xBB.",
  "error.noArchidektAccount": "Aucun compte Archidekt trouv\xE9 pour \xAB {name} \xBB.",
  "error.deckPrivateOr404": "Archidekt a renvoy\xE9 404 \u2014 le deck est priv\xE9 ou n\u2019existe plus.",
  "error.notADeckUrl": "Cela ne ressemble pas \xE0 une URL ou un identifiant de deck Archidekt.",
  "error.setUsernameFirst": "Renseignez d\u2019abord votre nom d\u2019utilisateur Archidekt dans les param\xE8tres.",
  "error.pickListNotFound": "Liste de pr\xE9l\xE8vement introuvable.",
  "error.pickListClosed": "Cette liste de pr\xE9l\xE8vement est d\xE9j\xE0 cl\xF4tur\xE9e.",
  "error.pickListConfirmed": "Une liste de pr\xE9l\xE8vement valid\xE9e fait partie de l\u2019historique et ne peut pas \xEAtre r\xE9ouverte.",
  "error.collectionItemNotFound": "\xC9l\xE9ment de collection introuvable.",
  "error.pickItemNotFound": "\xC9l\xE9ment de la liste de pr\xE9l\xE8vement introuvable.",
  "error.onlyAvailable": "Seulement {count} disponible(s) \xE0 pr\xE9lever.",
  "error.pickListShort": "La liste demande {wanted} exemplaires mais seulement {held} sont d\xE9tenus. Actualisez puis r\xE9essayez.",
  "error.reservedQuantity": "Impossible de fixer la quantit\xE9 \xE0 {quantity} : {reserved} exemplaires sont r\xE9serv\xE9s par une liste de pr\xE9l\xE8vement ouverte.",
  "error.reservedDelete": "Suppression impossible : des exemplaires sont r\xE9serv\xE9s par une liste de pr\xE9l\xE8vement ouverte.",
  "error.reservedPrinting": "Impossible de changer l\u2019\xE9dition : des exemplaires sont r\xE9serv\xE9s par une liste de pr\xE9l\xE8vement ouverte. Annulez-la ou validez-la d\u2019abord.",
  "error.noAnchorPrinting": "Cette entr\xE9e de deck n\u2019a aucune \xE9dition sur laquelle rattacher une langue.",
  "error.archidektUnreachable": "Archidekt inaccessible : {message}",
  "error.archidektNotFound": "Introuvable sur Archidekt.",
  "error.archidektStatus": "Archidekt a renvoy\xE9 {status}",
  "error.noSetNumber": "Cette entr\xE9e n\u2019a ni \xE9dition ni num\xE9ro de collection \xE0 rechercher.",
  "error.noOracleId": "Cette entr\xE9e n\u2019a pas d\u2019identifiant oracle : impossible de la relier \xE0 une autre \xE9dition.",
  // ------------------------------------------------------- deck sync statuses
  "sync.private": "priv\xE9 \u2014 non synchronis\xE9",
  "sync.notFound": "introuvable sur Archidekt"
};

// src/shared/i18n/index.ts
var DICTIONARIES = { en, fr };
var LOCALES = ["en", "fr"];
function resolveLocale(setting, systemLocale) {
  if (setting !== "system") return setting;
  const base = systemLocale.slice(0, 2).toLowerCase();
  return LOCALES.includes(base) ? base : "en";
}
function interpolate(template, vars) {
  if (!vars) return template;
  return template.replace(
    /\{(\w+)\}/g,
    (whole, name) => name in vars ? String(vars[name]) : whole
  );
}
function t(locale, key, vars) {
  const dictionary = DICTIONARIES[locale] ?? en;
  return interpolate(dictionary[key] ?? en[key] ?? key, vars);
}

// src/shared/types.ts
var FOIL_TREATMENTS = [
  { tag: "surgefoil", label: "Surge Foil" },
  { tag: "galaxyfoil", label: "Galaxy Foil" },
  { tag: "ripplefoil", label: "Ripple Foil" },
  { tag: "halofoil", label: "Halo Foil" },
  { tag: "confettifoil", label: "Confetti Foil" },
  { tag: "dazzlefoil", label: "Dazzle Foil" },
  { tag: "fracturefoil", label: "Fracture Foil" },
  { tag: "rainbowfoil", label: "Rainbow Foil" },
  { tag: "doublerainbow", label: "Double Rainbow Foil" },
  { tag: "raisedfoil", label: "Raised Foil" },
  { tag: "firstplacefoil", label: "First-Place Foil" },
  { tag: "silverfoil", label: "Silver Foil" },
  { tag: "goldfoil", label: "Gold Foil" },
  { tag: "manafoil", label: "Mana Foil" },
  { tag: "chocobotrackfoil", label: "Chocobo Track Foil" },
  { tag: "textured", label: "Textured Foil" },
  { tag: "texturedfoil", label: "Textured Foil" },
  { tag: "oilslick", label: "Oil Slick" },
  { tag: "gilded", label: "Gilded" },
  { tag: "neonink", label: "Neon Ink" },
  { tag: "invisibleink", label: "Invisible Ink" },
  { tag: "stepandcompleat", label: "Step-and-Compleat Foil" },
  { tag: "shatteredglass", label: "Shattered Glass" },
  { tag: "magnified", label: "Magnified Foil" },
  { tag: "embossed", label: "Embossed Foil" },
  { tag: "serialized", label: "Serialized" }
];
var TREATMENT_LABELS = new Map(FOIL_TREATMENTS.map((t2) => [t2.tag, t2.label]));
var GRID_MIN_COLUMNS = 2;
var GRID_MAX_COLUMNS = 14;
var DEFAULT_GRID_COLUMNS = {
  collection: 7,
  printings: 6,
  picks: 6,
  decks: 8
};
function clampColumns(value) {
  if (value === null || value === void 0 || value === "") return null;
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return null;
  return Math.min(GRID_MAX_COLUMNS, Math.max(GRID_MIN_COLUMNS, Math.round(n)));
}
var DEFAULT_VIEW_MODES = {
  collection: "table",
  // Rows by default on both: a pick list or deck list is something you read while
  // handling cards, not something you browse as art.
  picks: "rows",
  decks: "rows"
};

// src/main/db/repos/settings.ts
function parseLocale(raw) {
  return raw === "en" || raw === "fr" || raw === "system" ? raw : "system";
}
var DEFAULTS = {
  currency: "usd",
  archidektUsername: "",
  lastPriceSync: null,
  reduceMotion: false,
  deckMatchExact: false,
  gridColumns: { ...DEFAULT_GRID_COLUMNS },
  labelPossession: {},
  viewModes: { ...DEFAULT_VIEW_MODES },
  deckGroupByCategory: true,
  locale: "system"
};
function parseGridColumns(raw) {
  const result = { ...DEFAULT_GRID_COLUMNS };
  if (!raw) return result;
  try {
    const parsed = JSON.parse(raw);
    for (const key of Object.keys(result)) {
      const clamped = clampColumns(parsed[key]);
      if (clamped !== null) result[key] = clamped;
    }
  } catch {
  }
  return result;
}
var HEX = /^#[0-9a-f]{3,8}$/;
function parseColors(raw) {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return [
      ...new Set(
        parsed.filter((v) => typeof v === "string").map((v) => v.trim().toLowerCase()).filter((v) => HEX.test(v))
      )
    ];
  } catch {
    return [];
  }
}
function parsePossession(raw, legacy) {
  const result = {};
  if (raw) {
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        for (const [key, value] of Object.entries(parsed)) {
          const color = key.trim().toLowerCase();
          if (!HEX.test(color)) continue;
          if (value === "owned" || value === "not_owned") result[color] = value;
        }
        return result;
      }
    } catch {
    }
  }
  for (const color of parseColors(legacy)) result[color] = "not_owned";
  return result;
}
var VALID_MODES = {
  collection: ["table", "gallery"],
  picks: ["rows", "grid"],
  decks: ["rows", "grid"]
};
function parseViewModes(raw) {
  let parsed = {};
  if (raw) {
    try {
      const candidate = JSON.parse(raw);
      if (candidate && typeof candidate === "object" && !Array.isArray(candidate)) {
        parsed = candidate;
      }
    } catch {
    }
  }
  const pick = (key) => {
    const value = parsed[key];
    return typeof value === "string" && VALID_MODES[key].includes(value) ? value : DEFAULT_VIEW_MODES[key];
  };
  return { collection: pick("collection"), picks: pick("picks"), decks: pick("decks") };
}
function getSettings() {
  const rows = getDb().all("SELECT key, value FROM settings");
  const map = new Map(rows.map((r) => [r.key, r.value]));
  return {
    currency: map.get("currency") ?? DEFAULTS.currency,
    archidektUsername: map.get("archidektUsername") ?? DEFAULTS.archidektUsername,
    lastPriceSync: map.get("lastPriceSync") ?? DEFAULTS.lastPriceSync,
    reduceMotion: map.get("reduceMotion") === "1",
    deckMatchExact: map.get("deckMatchExact") === "1",
    // Defaults to on, so an existing install keeps the grouping it already has.
    deckGroupByCategory: (map.get("deckGroupByCategory") ?? "1") === "1",
    locale: parseLocale(map.get("locale")),
    gridColumns: parseGridColumns(map.get("gridColumns")),
    labelPossession: parsePossession(map.get("labelPossession"), map.get("notOwnedColors")),
    viewModes: parseViewModes(map.get("viewModes"))
  };
}
function getLocale(systemLocale = "en") {
  return resolveLocale(getSettings().locale, systemLocale);
}

// src/main/services/boosterOdds.ts
function tr(key, vars) {
  return t(getLocale(), key, vars);
}
var MTGJSON = "https://mtgjson.com/api/v5";
function sheetTotal(sheet) {
  if (sheet.totalWeight && sheet.totalWeight > 0) return sheet.totalWeight;
  return Object.values(sheet.cards).reduce((sum, weight) => sum + weight, 0);
}
function oddsKey(uuid, foil) {
  return `${uuid}|${foil ? 1 : 0}`;
}
function computeBoosterOdds(booster) {
  const configs = booster.boosters ?? [];
  const totalWeight = booster.boostersTotalWeight ?? configs.reduce((sum, c) => sum + (c.weight ?? 0), 0);
  const byUuid = /* @__PURE__ */ new Map();
  let expectedPicks = 0;
  if (!configs.length || totalWeight <= 0) return { byUuid, expectedPicks };
  const totals = /* @__PURE__ */ new Map();
  for (const [name, sheet] of Object.entries(booster.sheets ?? {})) {
    totals.set(name, sheetTotal(sheet));
  }
  for (const config of configs) {
    const share = (config.weight ?? 0) / totalWeight;
    if (share <= 0) continue;
    const entries = Object.entries(config.contents ?? {});
    expectedPicks += share * entries.reduce((sum, [, picks]) => sum + picks, 0);
    const absent = /* @__PURE__ */ new Map();
    const seen = /* @__PURE__ */ new Set();
    for (const [sheetName, picks] of entries) {
      const sheet = booster.sheets?.[sheetName];
      const total = totals.get(sheetName) ?? 0;
      if (!sheet || total <= 0 || picks <= 0) continue;
      const foil = sheet.foil === true;
      for (const [uuid, weight] of Object.entries(sheet.cards)) {
        const key = oddsKey(uuid, foil);
        const chance = weight / total;
        absent.set(key, (absent.get(key) ?? 1) * Math.pow(1 - chance, picks));
        seen.add(key);
        const entry = byUuid.get(key) ?? { probability: 0, expected: 0, approximate: false };
        entry.expected += share * picks * chance;
        if (sheet.balanceColors) entry.approximate = true;
        byUuid.set(key, entry);
      }
    }
    for (const key of seen) {
      const entry = byUuid.get(key);
      entry.probability += share * (1 - (absent.get(key) ?? 1));
    }
  }
  return { byUuid, expectedPicks };
}
function summariseProducts(products) {
  const summary = [];
  for (const product of products) {
    const packs = product.contents?.pack ?? [];
    const sealed = product.contents?.sealed ?? [];
    const boosterCodes = packs.map((p) => p.code).filter((c) => !!c);
    if (!boosterCodes.length) continue;
    const count = sealed.reduce((sum, s) => sum + (s.count ?? 0), 0) || packs.length || 1;
    summary.push({
      name: product.name,
      category: product.category ?? null,
      subtype: product.subtype ?? null,
      booster: boosterCodes[0],
      boosterCount: count
    });
  }
  return summary;
}
async function loadBoosterOdds(setCode, onProgress) {
  const code = setCode.toUpperCase();
  const phase = `Booster odds for ${code}`;
  onProgress({ job: "booster-odds", phase, done: 0, total: 3 });
  const response = await fetch(`${MTGJSON}/${code}.json`, {
    headers: { "User-Agent": "Matomeru/1.0 (local MTG collection manager)" }
  });
  if (!response.ok) {
    onProgress({ job: "booster-odds", phase, done: 3, total: 3, finished: true });
    throw new Error(tr("err.mtgjsonNoData", { set: code, status: response.status }));
  }
  onProgress({ job: "booster-odds", phase, done: 1, total: 3, message: "Reading" });
  const parsed = await response.json();
  const boosters = parsed.data?.booster ?? {};
  onProgress({ job: "booster-odds", phase, done: 2, total: 3, message: "Computing" });
  const scryfallByUuid = /* @__PURE__ */ new Map();
  for (const card of parsed.data?.cards ?? []) {
    const id = card.identifiers?.scryfallId;
    if (id) scryfallByUuid.set(card.uuid, id);
  }
  const names = [];
  const rows = [];
  for (const [name, booster] of Object.entries(boosters)) {
    const { byUuid, expectedPicks } = computeBoosterOdds(booster);
    if (!byUuid.size) continue;
    let namedExpected = 0;
    for (const [key, odds] of byUuid) {
      if (scryfallByUuid.get(key.split("|")[0])) namedExpected += odds.expected;
    }
    names.push({
      code: name,
      name: booster.name ?? name,
      cardsPerPack: Math.round(expectedPicks * 10) / 10,
      coverage: expectedPicks > 0 ? namedExpected / expectedPicks : 0
    });
    for (const [key, odds] of byUuid) {
      const [uuid, foil] = key.split("|");
      const scryfallId = scryfallByUuid.get(uuid);
      if (!scryfallId) continue;
      rows.push({
        booster: name,
        scryfall_id: scryfallId,
        foil: Number(foil),
        probability: odds.probability,
        expected: odds.expected,
        approximate: odds.approximate ? 1 : 0
      });
    }
  }
  const products = summariseProducts(parsed.data?.sealedProduct ?? []);
  transaction((db2) => {
    db2.run("DELETE FROM booster_odds WHERE set_code = ?", [code]);
    db2.run("DELETE FROM booster_sets WHERE set_code = ?", [code]);
    db2.run(
      "INSERT INTO booster_sets (set_code, fetched_at, boosters, products) VALUES (?,?,?,?)",
      [code, nowIso(), JSON.stringify(names), JSON.stringify(products)]
    );
    for (const row of rows) {
      db2.run(
        `INSERT INTO booster_odds
           (set_code, booster, scryfall_id, foil, probability, expected, approximate)
         VALUES (?,?,?,?,?,?,?)
         ON CONFLICT(set_code, booster, scryfall_id, foil) DO UPDATE SET
           probability = excluded.probability,
           expected = excluded.expected,
           approximate = excluded.approximate`,
        [
          code,
          row.booster,
          row.scryfall_id,
          row.foil,
          row.probability,
          row.expected,
          row.approximate
        ]
      );
    }
  });
  onProgress({ job: "booster-odds", phase, done: 3, total: 3, finished: true });
  return { boosters: names.length, cards: rows.length };
}
function englishSiblingOf(scryfallId) {
  const row = getDb().get(
    `SELECT e.scryfall_id AS id
     FROM printings p
     JOIN printings e
       ON e.set_code = p.set_code
      AND e.collector_number = p.collector_number
      AND e.lang = 'en'
     WHERE p.scryfall_id = ? AND p.lang != 'en'
     LIMIT 1`,
    [scryfallId]
  );
  return row ? { id: row.id, substituted: true } : { id: scryfallId, substituted: false };
}
function inBoosters(scryfallId) {
  const row = getDb().get("SELECT in_boosters FROM printings WHERE scryfall_id = ?", [
    scryfallId
  ]);
  if (!row || row.in_boosters === null) return null;
  return row.in_boosters === 1;
}
function boosterSetInfo(setCode) {
  const row = getDb().get(
    "SELECT set_code, fetched_at, boosters, products FROM booster_sets WHERE set_code = ?",
    [setCode.toUpperCase()]
  );
  if (!row) return null;
  return {
    set_code: row.set_code,
    fetched_at: row.fetched_at,
    boosters: JSON.parse(row.boosters),
    products: JSON.parse(row.products)
  };
}
function boosterOddsFor(scryfallId, setCode) {
  const present = inBoosters(scryfallId);
  const info = boosterSetInfo(setCode);
  const { id: lookupId, substituted } = englishSiblingOf(scryfallId);
  if (!info) {
    return {
      fetched: false,
      in_boosters: present,
      set_code: setCode.toUpperCase(),
      boosters: [],
      products: [],
      via_english: false
    };
  }
  const rows = getDb().all(
    `SELECT booster, foil, probability, expected, approximate
     FROM booster_odds WHERE set_code = ? AND scryfall_id = ?`,
    [setCode.toUpperCase(), lookupId]
  );
  const sold = printingFinishes(scryfallId);
  const byKey = new Map(rows.map((r) => [`${r.booster}|${r.foil}`, r]));
  const chanceFor = (boosterCode, foil) => {
    if (!sold.has(foil ? "foil" : "nonfoil")) return null;
    const row = byKey.get(`${boosterCode}|${foil ? 1 : 0}`);
    return {
      probability: row ? row.probability : 0,
      expected: row ? row.expected : 0,
      approximate: row ? row.approximate === 1 : false
    };
  };
  return {
    fetched: true,
    in_boosters: present,
    set_code: info.set_code,
    products: info.products,
    // Only worth saying when it actually changed the answer.
    via_english: substituted && rows.length > 0,
    boosters: info.boosters.map((booster) => ({
      code: booster.code,
      name: booster.name,
      cardsPerPack: booster.cardsPerPack,
      // Data stored before coverage was recorded has none; treat it as complete
      // rather than annotating every row of an older cache.
      coverage: booster.coverage ?? 1,
      nonfoil: chanceFor(booster.code, false),
      foil: chanceFor(booster.code, true)
    }))
  };
}
function printingFinishes(scryfallId) {
  const row = getDb().get("SELECT finishes FROM printings WHERE scryfall_id = ?", [
    scryfallId
  ]);
  const out = /* @__PURE__ */ new Set();
  if (!row) {
    out.add("nonfoil");
    out.add("foil");
    return out;
  }
  let list = [];
  try {
    list = JSON.parse(row.finishes);
  } catch {
    list = ["nonfoil"];
  }
  for (const finish of list) out.add(finish === "nonfoil" ? "nonfoil" : "foil");
  return out;
}

// scripts/probe-thranduil.ts
var dir = process.argv[2];
if (!dir) throw new Error("usage: probe-thranduil <dataDir>");
setDataDir(dir);
var db = getDb();
async function main() {
  await loadBoosterOdds("HOB", () => void 0);
  const rows = db.all(
    `SELECT scryfall_id, collector_number, finishes FROM printings
     WHERE set_code = 'hob' AND name LIKE '%Thranduil%' AND lang = 'en'
     ORDER BY CAST(collector_number AS INTEGER)`
  );
  const pct = (n) => n === null || n === void 0 ? "   \u2014   " : `${(n * 100).toFixed(3)}%`.padStart(8);
  for (const row of rows) {
    const odds = boosterOddsFor(row.scryfall_id, "hob");
    console.log(`
#${row.collector_number}  finishes=${row.finishes}`);
    for (const booster of odds.boosters) {
      const parts = [];
      if (booster.nonfoil) parts.push(`nonfoil ${pct(booster.nonfoil.probability)}`);
      else parts.push("nonfoil  (not sold)");
      if (booster.foil) parts.push(`foil ${pct(booster.foil.probability)}`);
      else parts.push("foil  (not sold)");
      console.log(`   ${booster.name.padEnd(30)} ${parts.join("   ")}`);
    }
  }
  console.log("\n--- the invariant, summed across BOTH finishes ---");
  const set = boosterSetInfo("HOB");
  const sums = new Map(
    db.all(
      `SELECT booster, SUM(expected) AS total FROM booster_odds
         WHERE set_code = 'HOB' GROUP BY booster`
    ).map((r) => [r.booster, r.total])
  );
  for (const booster of set.boosters) {
    const summed = sums.get(booster.code) ?? 0;
    const accounted = booster.cardsPerPack * booster.coverage;
    const ok = Math.abs(summed - accounted) < 0.05;
    console.log(
      `   ${booster.code.padEnd(12)} \u03A3 expected ${summed.toFixed(4).padStart(9)} vs ${booster.cardsPerPack} picks \xD7 ${(booster.coverage * 100).toFixed(1)}% named = ${accounted.toFixed(4)}   ${ok ? "OK" : "MISMATCH"}`
    );
  }
  closeDb();
}
void main();
