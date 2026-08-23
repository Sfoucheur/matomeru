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
var TREATMENT_LABELS = new Map(FOIL_TREATMENTS.map((t) => [t.tag, t.label]));
function foilTreatmentLabel(tag) {
  const known = TREATMENT_LABELS.get(tag);
  if (known) return known;
  const spaced = tag.replace(/foil$/, " foil").replace(/[-_]/g, " ").trim();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}
function foilTreatmentOf(printing, finish) {
  if (finish === "nonfoil") return null;
  for (const { tag } of FOIL_TREATMENTS) {
    if (printing.promo_types.includes(tag)) return tag;
  }
  return null;
}
var DEFAULT_FILTERS = {
  search: "",
  langs: [],
  rarities: [],
  sets: [],
  finishes: [],
  treatments: [],
  conditions: [],
  colors: [],
  typeLine: "",
  cmcMin: null,
  cmcMax: null,
  valueMin: null,
  valueMax: null,
  deckScope: null,
  source: null,
  onlyReserved: false,
  sort: "added_at",
  dir: "desc",
  sort2: null,
  dir2: "asc"
};

// src/main/db/repos/printings.ts
function parseJson(raw, fallback) {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}
function rowToPrinting(row) {
  return {
    scryfall_id: row.scryfall_id,
    oracle_id: row.oracle_id,
    name: row.name,
    printed_name: row.printed_name,
    lang: row.lang,
    set_code: row.set_code,
    set_name: row.set_name,
    collector_number: row.collector_number,
    rarity: row.rarity,
    mana_cost: row.mana_cost,
    cmc: row.cmc,
    type_line: row.type_line,
    printed_type_line: row.printed_type_line,
    oracle_text: row.oracle_text,
    printed_text: row.printed_text,
    colors: parseJson(row.colors, []),
    color_identity: parseJson(row.color_identity, []),
    layout: row.layout,
    finishes: parseJson(row.finishes, ["nonfoil"]),
    promo_types: parseJson(row.promo_types, []),
    // null for a printing cached before migration 8 whose raw_json lacked the
    // field; the UI treats that as "unknown" rather than as "not in boosters".
    in_boosters: row.in_boosters === null ? null : row.in_boosters === 1,
    image_uri_normal: row.image_uri_normal,
    image_uri_small: row.image_uri_small,
    released_at: row.released_at,
    prices: parseJson(row.prices_json, null),
    price_updated_at: row.price_updated_at
  };
}
var PRINTING_COLUMNS = `
  p.scryfall_id, p.oracle_id, p.name, p.printed_name, p.lang, p.set_code, p.set_name,
  p.collector_number, p.rarity, p.mana_cost, p.cmc, p.type_line, p.printed_type_line,
  p.oracle_text, p.printed_text, p.colors, p.color_identity, p.layout, p.finishes,
  p.promo_types, p.in_boosters, p.image_uri_normal, p.image_uri_small, p.released_at, p.prices_json, p.price_updated_at
`;
function ownPrice(currency, finishColumn, table = "p") {
  if (currency === "eur") {
    return `CAST(CASE ${finishColumn}
      WHEN 'foil'   THEN json_extract(${table}.prices_json, '$.eur_foil')
      WHEN 'etched' THEN json_extract(${table}.prices_json, '$.eur_foil')
      ELSE json_extract(${table}.prices_json, '$.eur')
    END AS REAL)`;
  }
  return `CAST(CASE ${finishColumn}
    WHEN 'foil'   THEN json_extract(${table}.prices_json, '$.usd_foil')
    WHEN 'etched' THEN json_extract(${table}.prices_json, '$.usd_etched')
    ELSE json_extract(${table}.prices_json, '$.usd')
  END AS REAL)`;
}
function siblingPrice(currency, finishColumn) {
  return `(SELECT ${ownPrice(currency, finishColumn, "s")}
           FROM printings s
           WHERE s.oracle_id IS NOT NULL
             AND s.oracle_id = p.oracle_id
             AND s.scryfall_id != p.scryfall_id
             AND ${ownPrice(currency, finishColumn, "s")} IS NOT NULL
           ORDER BY (s.set_code = p.set_code) DESC,
                    (s.lang = 'en') DESC,
                    s.released_at DESC
           LIMIT 1)`;
}
function priceExpr(currency, finishColumn = "ci.finish") {
  return `COALESCE(${ownPrice(currency, finishColumn)}, ${siblingPrice(currency, finishColumn)})`;
}
function priceIsProxyExpr(currency, finishColumn = "ci.finish") {
  return `(CASE
    WHEN ${ownPrice(currency, finishColumn)} IS NOT NULL THEN 0
    WHEN ${siblingPrice(currency, finishColumn)} IS NOT NULL THEN 1
    ELSE 0
  END)`;
}

// src/main/archidekt/client.ts
var chain = Promise.resolve();

// src/main/archidekt/mappers.ts
function parseLabel(raw) {
  const value = (raw ?? "").trim();
  if (!value) return { name: null, color: null };
  const match = value.match(/^(.*),(#[0-9a-fA-F]{3,8})$/);
  if (match) {
    const name = match[1].trim();
    return { name: name || null, color: match[2].toLowerCase() };
  }
  return { name: value, color: null };
}

// src/main/db/repos/decks.ts
var DECK_OVERRIDE_JOIN = `
  LEFT JOIN deck_card_overrides o
         ON o.deck_id = dc.deck_id AND o.oracle_id = dc.oracle_id`;
var DECK_PRINTING = "COALESCE(o.scryfall_id, dc.scryfall_id)";
var DECK_FINISH = "COALESCE(o.finish, dc.finish)";
function getDeck(deckId) {
  const row = getDb().get(
    `SELECT d.id, d.source, d.external_id, d.name, d.format, d.owner_username, d.url,
            d.external_updated_at, d.last_synced_at, d.is_private, d.is_unlisted, d.sync_error,
            d.default_lang,
            (SELECT COALESCE(SUM(dc.quantity), 0) FROM deck_cards dc WHERE dc.deck_id = d.id) AS cardCount
     FROM decks d WHERE d.id = ?`,
    [deckId]
  );
  return row ? { ...row, is_private: !!row.is_private, is_unlisted: !!row.is_unlisted } : null;
}
function deckCategoryMeta(deckId) {
  const meta = { premier: /* @__PURE__ */ new Set(), categoryInDeck: /* @__PURE__ */ new Map() };
  const row = getDb().get("SELECT raw_json FROM decks WHERE id = ?", [deckId]);
  if (!row?.raw_json) return meta;
  try {
    const parsed = JSON.parse(row.raw_json);
    for (const category of parsed.categories ?? []) {
      if (typeof category?.name !== "string") continue;
      if (category.isPremier) meta.premier.add(category.name);
      meta.categoryInDeck.set(category.name, category.includedInDeck !== false);
    }
  } catch {
  }
  return meta;
}
function deckBreakdown(deckId, currency, exactOnly) {
  const deck2 = getDeck(deckId);
  if (!deck2) return null;
  const db2 = getDb();
  const price = priceExpr(currency, DECK_FINISH);
  const proxy = priceIsProxyExpr(currency, DECK_FINISH);
  const { premier, categoryInDeck } = deckCategoryMeta(deckId);
  const rows = db2.all(
    `SELECT dc.id, dc.deck_id, dc.quantity,
            ${DECK_FINISH} AS finish,
            o.finish AS override_finish,
            o.foil_treatment AS override_treatment,
            p.promo_types AS promo_types,
            dc.categories, dc.in_maindeck, dc.set_code,
            dc.collector_number, dc.image_uri_small, dc.label, dc.label_possession,
            dc.oracle_id,
            -- An override replaces the printing entirely: Archidekt can only ever
            -- report the English one, so this is how a French copy is recorded.
            COALESCE(o.scryfall_id, dc.scryfall_id) AS scryfall_id,
            o.lang AS override_lang,
            o.forced_lang AS forced_lang,
            -- A language you asked for that has no printing. Recorded per card,
            -- so a card nobody asked about is never flagged.
            lr.requested_lang AS language_unavailable,
            COALESCE(o.forced_name, p.printed_name, p.name, dc.name) AS name,
            COALESCE(o.forced_lang, p.lang, dc.lang) AS lang,
            COALESCE(p.rarity, dc.rarity) AS rarity,
            p.cmc AS cmc,
            p.color_identity AS color_identity,
            COALESCE(p.printed_type_line, p.type_line) AS type_line,
            ${price} AS unit_value,
            ${proxy} AS price_is_proxy,
            COALESCE((SELECT SUM(ci.quantity) FROM collection_items ci
                      WHERE ci.scryfall_id = COALESCE(o.scryfall_id, dc.scryfall_id)), 0) AS owned_exact,
            COALESCE((SELECT SUM(ci.quantity) FROM collection_items ci
                      JOIN printings p2 ON p2.scryfall_id = ci.scryfall_id
                      WHERE dc.oracle_id IS NOT NULL AND p2.oracle_id = dc.oracle_id), 0) AS owned_any
     FROM deck_cards dc
     LEFT JOIN deck_card_overrides o
            ON o.deck_id = dc.deck_id AND o.oracle_id = dc.oracle_id
     LEFT JOIN deck_card_lang_requests lr
            ON lr.deck_id = dc.deck_id AND lr.oracle_id = dc.oracle_id
     LEFT JOIN printings p ON p.scryfall_id = COALESCE(o.scryfall_id, dc.scryfall_id)
     WHERE dc.deck_id = ?
     ORDER BY dc.name COLLATE NOCASE`,
    [deckId]
  );
  const cards = rows.map((row) => {
    const label = parseLabel(row.label);
    const categories = JSON.parse(row.categories);
    const commanderCategory = categories.find((c) => premier.has(c));
    const group = commanderCategory ?? categories.find((c) => categoryInDeck.get(c) !== false) ?? categories[0] ?? "Uncategorized";
    return {
      ...row,
      categories,
      in_maindeck: !!row.in_maindeck,
      finish: row.finish,
      rarity: row.rarity,
      label_name: label.name,
      label_color: label.color,
      is_commander: !!commanderCategory,
      group,
      price_is_proxy: !!row.price_is_proxy,
      language_forced: !!row.forced_lang,
      finish_forced: row.override_finish !== null,
      // The printing's tags say which foil this is; a stored value is your
      // correction, and gets marked as such.
      foil_treatment: row.override_treatment ?? foilTreatmentOf(
        { promo_types: row.promo_types ? JSON.parse(row.promo_types) : [] },
        row.finish
      ),
      treatment_forced: row.override_treatment !== null,
      // The single source of truth for "how many do I have for this entry".
      // A card under an "owned" label is held by definition — that is the whole
      // point of the label — added to what the collection holds, matching the
      // additive rule: a loose copy plus one sleeved in a deck is two.
      held: (row.label_possession === "owned" ? row.quantity : 0) + (exactOnly ? row.owned_exact : Math.max(row.owned_exact, row.owned_any))
    };
  });
  const priceOf = new Map(rows.map((r) => [r.id, r.unit_value]));
  return { deck: deck2, ...groupCards(cards, categoryInDeck, premier, priceOf) };
}
function groupCards(cards, categoryInDeck, premier, priceOf) {
  const byGroup = /* @__PURE__ */ new Map();
  for (const card of cards) {
    const bucket = byGroup.get(card.group);
    if (bucket) bucket.push(card);
    else byGroup.set(card.group, [card]);
  }
  const groups = [...byGroup.entries()].map(([name, groupCardList]) => {
    let cardCount = 0;
    let ownedCards = 0;
    let missingCards = 0;
    let missingValue = 0;
    let missingValueIsProxy = false;
    for (const card of groupCardList) {
      const owned2 = Math.min(card.held, card.quantity);
      const missing = Math.max(0, card.quantity - card.held);
      cardCount += card.quantity;
      ownedCards += owned2;
      missingCards += missing;
      const unit = priceOf.get(card.id);
      if (unit) {
        missingValue += unit * missing;
        if (missing > 0 && card.price_is_proxy) missingValueIsProxy = true;
      }
    }
    return {
      name,
      inDeck: categoryInDeck.get(name) !== false,
      isPremier: premier.has(name),
      cards: groupCardList,
      cardCount,
      ownedCards,
      missingCards,
      missingValue,
      missingValueIsProxy
    };
  });
  groups.sort((a, b) => {
    if (a.isPremier !== b.isPremier) return a.isPremier ? -1 : 1;
    if (a.inDeck !== b.inDeck) return a.inDeck ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  const totals = {
    cards: groups.reduce((sum, g) => sum + g.cardCount, 0),
    entries: cards.length,
    inDeckCards: groups.filter((g) => g.inDeck).reduce((sum, g) => sum + g.cardCount, 0),
    excludedCards: groups.filter((g) => !g.inDeck).reduce((sum, g) => sum + g.cardCount, 0),
    ownedCards: groups.reduce((sum, g) => sum + g.ownedCards, 0),
    missingCards: groups.reduce((sum, g) => sum + g.missingCards, 0),
    missingValue: groups.reduce((sum, g) => sum + g.missingValue, 0),
    missingValueIsProxy: groups.some((g) => g.missingValueIsProxy)
  };
  const categories = groups.map((g) => ({
    name: g.name,
    inDeck: g.inDeck,
    cardCount: g.cardCount
  }));
  const labelMap = /* @__PURE__ */ new Map();
  for (const card of cards) {
    if (!card.label_color && !card.label_name) continue;
    const key = card.label_color ?? card.label_name ?? "";
    const existing = labelMap.get(key);
    if (existing) existing.cardCount += card.quantity;
    else
      labelMap.set(key, {
        name: card.label_name,
        color: card.label_color,
        cardCount: card.quantity
      });
  }
  const languageMap = /* @__PURE__ */ new Map();
  for (const card of cards) {
    languageMap.set(card.lang, (languageMap.get(card.lang) ?? 0) + card.quantity);
  }
  return {
    groups,
    categories,
    labels: [...labelMap.values()].sort((a, b) => b.cardCount - a.cardCount),
    languages: [...languageMap.entries()].map(([lang, cardCount]) => ({ lang, cardCount })).sort((a, b) => b.cardCount - a.cardCount),
    totals
  };
}
function setCardFinish(deckId, oracleId, finish, treatment) {
  const db2 = getDb();
  const current = db2.get(
    `SELECT COALESCE(o.scryfall_id, dc.scryfall_id) AS scryfall_id,
            COALESCE(o.lang, dc.lang) AS lang
     FROM deck_cards dc
     LEFT JOIN deck_card_overrides o ON o.deck_id = dc.deck_id AND o.oracle_id = dc.oracle_id
     WHERE dc.deck_id = ? AND dc.oracle_id = ? AND dc.scryfall_id IS NOT NULL
     LIMIT 1`,
    [deckId, oracleId]
  );
  if (!current) throw new Error("That deck entry has no printing to anchor a finish to.");
  const nextTreatment = treatment === void 0 ? null : finish === "nonfoil" || finish === null ? null : treatment;
  db2.run(
    `INSERT INTO deck_card_overrides
       (deck_id, oracle_id, scryfall_id, lang, finish, foil_treatment, created_at)
     VALUES (?,?,?,?,?,?,?)
     ON CONFLICT(deck_id, oracle_id) DO UPDATE SET
       finish = excluded.finish,
       foil_treatment = excluded.foil_treatment`,
    [deckId, oracleId, current.scryfall_id, current.lang, finish, nextTreatment, nowIso()]
  );
}

// src/main/db/repos/collection.ts
var ROW_SOURCES = `
  SELECT
    'collection' AS source,
    ci.id        AS item_id,
    ci.scryfall_id, ci.finish, ci.condition, ci.quantity,
    ci.purchase_price, ci.notes, ci.added_at, ci.updated_at,
    ci.forced_lang, ci.forced_name, ci.foil_treatment,
    NULL AS deck_names,
    (SELECT COALESCE(SUM(pli.quantity), 0)
     FROM pick_list_items pli
     JOIN pick_lists pl ON pl.id = pli.pick_list_id
     WHERE pli.collection_item_id = ci.id AND pl.status = 'open') AS reserved
  FROM collection_items ci
  WHERE ci.quantity > 0

  UNION ALL

  SELECT
    'deck', NULL,
    ${DECK_PRINTING}, ${DECK_FINISH},
    NULL,                                  -- Archidekt does not record condition
    SUM(dc.quantity),
    NULL, NULL, NULL, NULL,
    MAX(o.forced_lang), MAX(o.forced_name), MAX(o.foil_treatment),
    GROUP_CONCAT(DISTINCT d.name),
    0                                      -- a card inside a deck cannot be staged
  FROM deck_cards dc
  JOIN decks d ON d.id = dc.deck_id
  ${DECK_OVERRIDE_JOIN}
  WHERE dc.label_possession = 'owned' AND ${DECK_PRINTING} IS NOT NULL
  GROUP BY ${DECK_PRINTING}, ${DECK_FINISH}
`;
var EFFECTIVE_LANG = "COALESCE(r.forced_lang, p.lang)";
var EFFECTIVE_TREATMENT = [
  "CASE",
  "  WHEN r.foil_treatment IS NOT NULL THEN r.foil_treatment",
  "  WHEN r.finish = 'nonfoil' THEN NULL",
  ...FOIL_TREATMENTS.map(
    (t) => `  WHEN EXISTS (SELECT 1 FROM json_each(COALESCE(p.promo_types, '[]')) WHERE value = '${t.tag}') THEN '${t.tag}'`
  ),
  "  ELSE NULL",
  "END"
].join("\n");
var DECK_COUNT_EXPR = `(
  SELECT COUNT(DISTINCT dc.deck_id)
  FROM deck_cards dc
  ${DECK_OVERRIDE_JOIN}
  WHERE dc.label_possession IS NOT 'not_owned'
    AND (${DECK_PRINTING} = r.scryfall_id
         OR (p.oracle_id IS NOT NULL AND dc.oracle_id = p.oracle_id))
)`;
var COLOR_ORDER = `CASE
  WHEN json_array_length(p.color_identity) = 0 THEN 7
  WHEN json_array_length(p.color_identity) > 1 THEN 6
  WHEN EXISTS (SELECT 1 FROM json_each(p.color_identity) WHERE value = 'W') THEN 1
  WHEN EXISTS (SELECT 1 FROM json_each(p.color_identity) WHERE value = 'U') THEN 2
  WHEN EXISTS (SELECT 1 FROM json_each(p.color_identity) WHERE value = 'B') THEN 3
  WHEN EXISTS (SELECT 1 FROM json_each(p.color_identity) WHERE value = 'R') THEN 4
  ELSE 5
END`;
var SORT_COLUMNS = {
  name: "COALESCE(p.printed_name, p.name)",
  color: COLOR_ORDER,
  lang: EFFECTIVE_LANG,
  rarity: `CASE p.rarity WHEN 'common' THEN 0 WHEN 'uncommon' THEN 1 WHEN 'rare' THEN 2
           WHEN 'mythic' THEN 3 ELSE 4 END`,
  set_code: "p.set_code",
  collector_number: "CAST(p.collector_number AS INTEGER), p.collector_number",
  finish: "r.finish",
  condition: "r.condition",
  quantity: "r.quantity",
  unit_value: "unit_value",
  total_value: "total_value",
  added_at: "r.added_at",
  cmc: "p.cmc"
};
var NULLABLE_SORTS = /* @__PURE__ */ new Set(["unit_value", "total_value", "added_at", "condition"]);
function orderTerm(field, dir2) {
  const column = SORT_COLUMNS[field] ?? SORT_COLUMNS.added_at;
  const direction = dir2 === "asc" ? "ASC" : "DESC";
  return NULLABLE_SORTS.has(field) ? `${column} IS NULL, ${column} ${direction}` : `${column} ${direction}`;
}
function buildOrderBy(filters) {
  const terms = [orderTerm(filters.sort, filters.dir)];
  if (filters.sort2 && filters.sort2 !== filters.sort) {
    terms.push(orderTerm(filters.sort2, filters.dir2));
  }
  terms.push("r.source", "r.item_id DESC", "r.scryfall_id");
  return terms.join(", ");
}
function buildWhere(filters, currency) {
  const clauses = [];
  const params = [];
  if (filters.source) {
    clauses.push("r.source = ?");
    params.push(filters.source);
  }
  if (filters.search.trim()) {
    const term = `%${filters.search.trim()}%`;
    clauses.push(`(
      p.name LIKE ? COLLATE NOCASE
      OR p.printed_name LIKE ? COLLATE NOCASE
      OR p.set_code LIKE ? COLLATE NOCASE
      OR p.collector_number LIKE ?
      OR p.type_line LIKE ? COLLATE NOCASE
      OR p.printed_type_line LIKE ? COLLATE NOCASE
    )`);
    params.push(term, term, term, term, term, term);
  }
  const inList = (column, values) => {
    if (!values.length) return;
    clauses.push(`${column} IN (${values.map(() => "?").join(",")})`);
    params.push(...values);
  };
  inList(EFFECTIVE_LANG, filters.langs);
  inList("p.rarity", filters.rarities);
  inList("p.set_code", filters.sets);
  inList("r.finish", filters.finishes);
  inList(EFFECTIVE_TREATMENT, filters.treatments);
  inList("r.condition", filters.conditions);
  if (filters.colors.length) {
    const parts = [];
    for (const color of filters.colors) {
      if (color === "C") {
        parts.push(`json_array_length(p.color_identity) = 0`);
      } else {
        parts.push(`EXISTS (SELECT 1 FROM json_each(p.color_identity) WHERE value = ?)`);
        params.push(color);
      }
    }
    clauses.push(`(${parts.join(" OR ")})`);
  }
  if (filters.typeLine.trim()) {
    clauses.push("(p.type_line LIKE ? COLLATE NOCASE OR p.printed_type_line LIKE ? COLLATE NOCASE)");
    const term = `%${filters.typeLine.trim()}%`;
    params.push(term, term);
  }
  if (filters.cmcMin !== null) {
    clauses.push("p.cmc >= ?");
    params.push(filters.cmcMin);
  }
  if (filters.cmcMax !== null) {
    clauses.push("p.cmc <= ?");
    params.push(filters.cmcMax);
  }
  const price = priceExpr(currency);
  if (filters.valueMin !== null) {
    clauses.push(`COALESCE(${price}, 0) >= ?`);
    params.push(filters.valueMin);
  }
  if (filters.valueMax !== null) {
    clauses.push(`COALESCE(${price}, 0) <= ?`);
    params.push(filters.valueMax);
  }
  if (filters.deckScope === "in") {
    clauses.push(`${DECK_COUNT_EXPR} > 0`);
  } else if (filters.deckScope === "out") {
    clauses.push(`${DECK_COUNT_EXPR} = 0`);
  } else if (typeof filters.deckScope === "number") {
    clauses.push(`EXISTS (
      SELECT 1 FROM deck_cards dc
      WHERE dc.deck_id = ? AND dc.label_possession IS NOT 'not_owned'
        AND (dc.scryfall_id = r.scryfall_id
             OR (p.oracle_id IS NOT NULL AND dc.oracle_id = p.oracle_id))
    )`);
    params.push(filters.deckScope);
  }
  if (filters.onlyReserved) {
    clauses.push("r.reserved > 0");
  }
  return { sql: clauses.length ? clauses.join(" AND ") : "1 = 1", params };
}
function toCollectionRow(row) {
  const source = row.source === "deck" ? "deck" : "collection";
  const row_printing = rowToPrinting(row);
  return {
    // Derived rows have no id, so identity is the source plus what makes the
    // grouping unique. The UI keys selection and React children off this.
    key: source === "collection" ? `collection:${row.item_id}` : `deck:${row.row_scryfall_id}:${row.finish}`,
    source,
    id: row.item_id,
    scryfall_id: row.row_scryfall_id,
    price_is_proxy: !!row.price_is_proxy,
    language_forced: !!row.forced_lang,
    finish: row.finish,
    // Normally the printing says which foil this is; a stored value is a
    // correction you made, and the UI marks it as yours.
    foil_treatment: row.foil_treatment ?? foilTreatmentOf(row_printing, row.finish),
    treatment_forced: !!row.foil_treatment,
    condition: row.condition ?? null,
    quantity: row.quantity,
    purchase_price: row.purchase_price,
    notes: row.notes,
    added_at: row.added_at,
    updated_at: row.updated_at,
    // A forced language and name override what the printing says, because the
    // printing is a stand-in for one Scryfall does not carry.
    printing: {
      ...row_printing,
      ...row.forced_lang ? { lang: row.forced_lang } : {},
      ...row.forced_name ? { printed_name: row.forced_name } : {}
    },
    reserved: row.reserved,
    // A card sleeved in a deck is not available to pull from bulk.
    available: source === "deck" ? 0 : row.quantity - row.reserved,
    deck_count: row.deck_count,
    deck_names: row.deck_names ? row.deck_names.split(",").filter(Boolean) : [],
    unit_value: row.unit_value,
    total_value: row.total_value
  };
}
var FROM_ROWS = `FROM (${ROW_SOURCES}) r JOIN printings p ON p.scryfall_id = r.scryfall_id`;
function queryCollection(filters, currency, limit, offset) {
  const db2 = getDb();
  const where = buildWhere(filters, currency);
  const price = priceExpr(currency, "r.finish");
  const proxy = priceIsProxyExpr(currency, "r.finish");
  const orderBy = buildOrderBy(filters);
  const rows = db2.all(
    `SELECT
       r.source, r.item_id, r.scryfall_id AS row_scryfall_id, r.finish, r.condition,
       r.quantity, r.purchase_price, r.notes, r.added_at, r.updated_at,
       r.deck_names, r.reserved, r.forced_lang, r.forced_name, r.foil_treatment,
       ${PRINTING_COLUMNS},
       ${DECK_COUNT_EXPR} AS deck_count,
       ${price} AS unit_value,
       ${proxy} AS price_is_proxy,
       ${price} * r.quantity AS total_value
     ${FROM_ROWS}
     WHERE ${where.sql}
     ORDER BY ${orderBy}
     LIMIT ? OFFSET ?`,
    [...where.params, limit, offset]
  );
  const totals = db2.get(
    `SELECT
       COUNT(*) AS total,
       COALESCE(SUM(r.quantity), 0) AS total_quantity,
       COALESCE(SUM(${price} * r.quantity), 0) AS total_value,
       COALESCE(SUM(CASE WHEN r.source = 'collection' THEN r.quantity ELSE 0 END), 0) AS bulk_quantity,
       COALESCE(SUM(CASE WHEN r.source = 'collection' THEN ${price} * r.quantity ELSE 0 END), 0) AS bulk_value,
       COALESCE(SUM(CASE WHEN r.source = 'deck' THEN r.quantity ELSE 0 END), 0) AS deck_quantity,
       COALESCE(SUM(CASE WHEN r.source = 'deck' THEN ${price} * r.quantity ELSE 0 END), 0) AS deck_value
     ${FROM_ROWS}
     WHERE ${where.sql}`,
    where.params
  );
  return {
    rows: rows.map(toCollectionRow),
    total: totals.total,
    totalQuantity: totals.total_quantity,
    totalValue: totals.total_value,
    bulkQuantity: totals.bulk_quantity,
    bulkValue: totals.bulk_value,
    deckQuantity: totals.deck_quantity,
    deckValue: totals.deck_value
  };
}
function queryFacets(filters, currency) {
  const db2 = getDb();
  const countBy = (column, omit) => {
    const scoped = { ...filters, [omit]: [] };
    const where = buildWhere(scoped, currency);
    return db2.all(
      `SELECT ${column} AS value, COALESCE(SUM(r.quantity), 0) AS count
       ${FROM_ROWS}
       WHERE ${where.sql} AND ${column} IS NOT NULL
       GROUP BY ${column}
       ORDER BY count DESC`,
      where.params
    );
  };
  const setsScoped = { ...filters, sets: [] };
  const setsWhere = buildWhere(setsScoped, currency);
  const sets = db2.all(
    `SELECT p.set_code AS value, p.set_name AS label, COALESCE(SUM(r.quantity), 0) AS count
     ${FROM_ROWS}
     WHERE ${setsWhere.sql}
     GROUP BY p.set_code, p.set_name
     ORDER BY count DESC`,
    setsWhere.params
  );
  return {
    langs: countBy(EFFECTIVE_LANG, "langs"),
    rarities: countBy("p.rarity", "rarities"),
    sets,
    finishes: countBy("r.finish", "finishes"),
    treatments: countBy(EFFECTIVE_TREATMENT, "treatments"),
    conditions: countBy("r.condition", "conditions")
  };
}
function updateItem(itemId, patch) {
  const sets = [];
  const params = [];
  for (const [key, value] of Object.entries(patch)) {
    if (value === void 0) continue;
    sets.push(`${key} = ?`);
    params.push(value);
  }
  if (!sets.length) return;
  sets.push("updated_at = ?");
  params.push(nowIso(), itemId);
  try {
    getDb().run(`UPDATE collection_items SET ${sets.join(", ")} WHERE id = ?`, params);
  } catch (err) {
    if (!String(err.message).includes("UNIQUE")) throw err;
    mergeIntoExisting(itemId, patch);
  }
}
function mergeIntoExisting(itemId, patch) {
  transaction((db2) => {
    const item = db2.get("SELECT * FROM collection_items WHERE id = ?", [itemId]);
    if (!item) return;
    const finish = patch.finish ?? item.finish;
    const condition = patch.condition ?? item.condition;
    const target = db2.get(
      "SELECT id FROM collection_items WHERE scryfall_id = ? AND finish = ? AND condition = ? AND id != ?",
      [item.scryfall_id, finish, condition, itemId]
    );
    if (!target) return;
    db2.run("UPDATE collection_items SET quantity = quantity + ?, updated_at = ? WHERE id = ?", [
      item.quantity,
      nowIso(),
      target.id
    ]);
    if (patch.foil_treatment !== void 0) {
      db2.run("UPDATE collection_items SET foil_treatment = ? WHERE id = ?", [
        patch.foil_treatment,
        target.id
      ]);
    }
    db2.run("DELETE FROM collection_items WHERE id = ?", [itemId]);
  });
}

// scripts/probe-foil.ts
var dir = process.argv[2];
if (!dir) throw new Error("usage: probe-foil <dataDir>");
setDataDir(dir);
var db = getDb();
var one = (sql) => db.get(sql);
console.log("--- migration 8 backfill ---");
var cols = db.all("SELECT name FROM pragma_table_info('printings')").map(
  (c) => c.name
);
console.log("  promo_types column:", cols.includes("promo_types"));
console.log("  in_boosters column:", cols.includes("in_boosters"));
var back = one(
  `SELECT (SELECT COUNT(*) FROM printings WHERE json_extract(raw_json,'$.promo_types') IS NOT NULL) AS raw,
          (SELECT COUNT(*) FROM printings WHERE promo_types IS NOT NULL) AS col`
);
console.log(`  promo_types backfilled: ${back.col} of ${back.raw} in raw_json`, back.col === back.raw ? "OK" : "MISMATCH");
var boost = one(
  `SELECT (SELECT COUNT(*) FROM printings WHERE json_extract(raw_json,'$.booster') IS NOT NULL) AS raw,
          (SELECT COUNT(*) FROM printings WHERE in_boosters = 1) AS yes,
          (SELECT COUNT(*) FROM printings WHERE in_boosters = 0) AS no`
);
console.log(
  `  in_boosters: ${boost.yes} yes / ${boost.no} no, ${boost.raw} present in raw_json`,
  boost.yes + boost.no === boost.raw ? "OK" : "MISMATCH"
);
console.log("\n--- derivation, on every tagged printing ---");
var tagged = db.all(
  `SELECT scryfall_id, name, set_code, promo_types, finishes FROM printings
   WHERE promo_types IS NOT NULL AND promo_types != '[]'`
);
var derived = 0;
var nonfoilNull = 0;
for (const p of tagged) {
  const promo = { promo_types: JSON.parse(p.promo_types) };
  if (foilTreatmentOf(promo, "nonfoil") === null) nonfoilNull++;
  if (foilTreatmentOf(promo, "foil") !== null) derived++;
}
console.log(`  ${tagged.length} tagged printings; ${derived} yield a treatment when foil`);
console.log(`  nonfoil always null: ${nonfoilNull === tagged.length ? "OK" : "FAILED"}`);
console.log("\n--- SQL and TS agree on the treatment ---");
var sqlSide = db.all(
  `SELECT p.scryfall_id, p.promo_types,
          CASE
            WHEN EXISTS (SELECT 1 FROM json_each(COALESCE(p.promo_types,'[]')) WHERE value='surgefoil') THEN 'surgefoil'
            ELSE NULL END AS quick
   FROM printings p WHERE p.promo_types IS NOT NULL AND p.promo_types != '[]'`
);
var agree = 0;
var disagree = [];
for (const r of sqlSide) {
  const ts = foilTreatmentOf({ promo_types: JSON.parse(r.promo_types) }, "foil");
  const surge = r.quick === "surgefoil";
  if (surge && ts !== "surgefoil") disagree.push(r.scryfall_id);
  else agree++;
}
console.log(`  surgefoil subset: ${agree} agree, ${disagree.length} disagree`, disagree.length ? "FAILED" : "OK");
console.log("\n--- treatment facet, through the real query ---");
var facets = queryFacets(DEFAULT_FILTERS, "eur");
console.log("  treatments offered:", facets.treatments.map((t) => `${foilTreatmentLabel(t.value)}=${t.count}`).join(", ") || "(none)");
console.log("  finishes offered  :", facets.finishes.map((f) => `${f.value}=${f.count}`).join(", "));
console.log("\n--- filtering by a treatment keeps exactly those rows ---");
for (const t of facets.treatments) {
  const page = queryCollection({ ...DEFAULT_FILTERS, treatments: [t.value] }, "eur", 500, 0);
  const wrong = page.rows.filter((r) => r.foil_treatment !== t.value);
  console.log(
    `  ${t.value}: ${page.rows.length} rows, ${page.totalQuantity} copies, ${wrong.length} wrong`,
    wrong.length ? "FAILED" : "OK"
  );
}
console.log("\n--- pick_list_items carries the treatment ---");
var pliCols = db.all("SELECT name FROM pragma_table_info('pick_list_items')").map(
  (c) => c.name
);
console.log("  foil_treatment column:", pliCols.includes("foil_treatment") ? "OK" : "MISSING");
console.log("\n--- a real collection row, treated by hand ---");
var owned = one(
  "SELECT id, scryfall_id, finish FROM collection_items WHERE quantity > 0 LIMIT 1"
);
if (owned) {
  const valueOf = (id) => queryCollection(DEFAULT_FILTERS, "eur", 500, 0).rows.find((r) => r.id === id)?.unit_value ?? null;
  updateItem(owned.id, { finish: "foil" });
  const priceBefore = valueOf(owned.id);
  updateItem(owned.id, { foil_treatment: "surgefoil" });
  const facets2 = queryFacets(DEFAULT_FILTERS, "eur");
  const offered = facets2.treatments.find((t) => t.value === "surgefoil");
  console.log("  facet now offers Surge Foil:", offered ? `OK (${offered.count})` : "FAILED");
  const page = queryCollection({ ...DEFAULT_FILTERS, treatments: ["surgefoil"] }, "eur", 500, 0);
  const wrong = page.rows.filter((r) => r.foil_treatment !== "surgefoil");
  console.log(`  filter keeps ${page.rows.length} row(s), ${wrong.length} wrong`, wrong.length ? "FAILED" : "OK");
  console.log("  marked as yours:", page.rows.find((r) => r.id === owned.id)?.treatment_forced ? "OK" : "FAILED");
  const priceAfter = valueOf(owned.id);
  console.log(
    "  price unchanged by the treatment:",
    priceBefore === priceAfter ? "OK" : `FAILED (${priceBefore} vs ${priceAfter})`
  );
  updateItem(owned.id, { foil_treatment: null });
  const cleared = queryCollection(DEFAULT_FILTERS, "eur", 500, 0).rows.find((r) => r.id === owned.id);
  console.log("  cleared:", cleared && !cleared.foil_treatment && !cleared.treatment_forced ? "OK" : "FAILED");
  updateItem(owned.id, { finish: owned.finish });
} else {
  console.log("  no owned rows to test");
}
console.log("\n--- a deck finish override, end to end ---");
var deck = one("SELECT id, name FROM decks LIMIT 1");
if (deck) {
  const allCards = (id) => (deckBreakdown(id, "eur", false)?.groups ?? []).flatMap((g) => g.cards);
  const before = allCards(deck.id);
  const target = before.find((c) => c.oracle_id && c.finish === "nonfoil");
  if (target) {
    console.log(`  ${target.name} in ${deck.name}: finish=${target.finish} value=${target.unit_value}`);
    setCardFinish(deck.id, target.oracle_id, "foil", "surgefoil");
    const after = allCards(deck.id).find((c) => c.id === target.id);
    console.log(`  after override: finish=${after.finish} forced=${after.finish_forced} treatment=${after.foil_treatment} value=${after.unit_value}`);
    console.log("  finish changed:", after.finish === "foil" ? "OK" : "FAILED");
    console.log("  marked as yours:", after.finish_forced ? "OK" : "FAILED");
    console.log("  treatment stored:", after.foil_treatment === "surgefoil" ? "OK" : "FAILED");
    const priced = after.unit_value !== target.unit_value;
    console.log(`  price followed the finish: ${priced ? "yes" : "no (printing may have no foil price)"}`);
    const rows = queryCollection({ ...DEFAULT_FILTERS, treatments: ["surgefoil"] }, "eur", 500, 0);
    const seen = rows.rows.some((r) => r.printing.scryfall_id === after.scryfall_id);
    console.log("  reaches the collection rows:", seen ? "OK" : "not owned-labelled, so not expected");
    setCardFinish(deck.id, target.oracle_id, null, null);
    const cleared = allCards(deck.id).find((c) => c.id === target.id);
    console.log("  cleared back to Archidekt:", cleared.finish === target.finish && !cleared.finish_forced ? "OK" : "FAILED");
  } else {
    console.log("  no nonfoil deck card with an oracle id to test");
  }
} else {
  console.log("  no decks in this database");
}
closeDb();
