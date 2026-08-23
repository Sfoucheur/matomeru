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
function closeDb() {
  if (handle) {
    handle.close();
    handle = null;
    facade = null;
  }
}

// src/main/services/boosterOdds.ts
function collectionBoosterSets() {
  return getDb().all(
    `WITH owned AS (
       SELECT ci.scryfall_id FROM collection_items ci WHERE ci.quantity > 0
       UNION
       SELECT COALESCE(o.scryfall_id, dc.scryfall_id)
       FROM deck_cards dc
       LEFT JOIN deck_card_overrides o
              ON o.deck_id = dc.deck_id AND o.oracle_id = dc.oracle_id
       WHERE COALESCE(o.scryfall_id, dc.scryfall_id) IS NOT NULL
     )
     SELECT UPPER(p.set_code) AS set_code,
            COUNT(*) AS cards,
            EXISTS (SELECT 1 FROM booster_sets bs WHERE bs.set_code = UPPER(p.set_code)) AS fetched
     FROM owned
     JOIN printings p ON p.scryfall_id = owned.scryfall_id
     WHERE p.in_boosters = 1
     GROUP BY UPPER(p.set_code)
     ORDER BY cards DESC`
  );
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
    `SELECT booster, probability, expected, approximate
     FROM booster_odds WHERE set_code = ? AND scryfall_id = ?`,
    [setCode.toUpperCase(), lookupId]
  );
  const byCode = new Map(rows.map((r) => [r.booster, r]));
  return {
    fetched: true,
    in_boosters: present,
    set_code: info.set_code,
    products: info.products,
    // Only worth saying when it actually changed the answer.
    via_english: substituted && rows.length > 0,
    boosters: info.boosters.map((booster) => {
      const row = byCode.get(booster.code);
      return {
        code: booster.code,
        name: booster.name,
        cardsPerPack: booster.cardsPerPack,
        // No row means the card is on none of this booster's sheets. That is a
        // real answer — "not in this booster" — but only when Scryfall agrees the
        // card is in boosters at all; otherwise the honest reading is that this
        // set's data has nothing to say about it.
        probability: row ? row.probability : 0,
        expected: row ? row.expected : 0,
        approximate: row ? row.approximate === 1 : false
      };
    })
  };
}

// scripts/probe-boosters.ts
var dir = process.argv[2];
if (!dir) throw new Error("usage: probe-boosters <dataDir>");
setDataDir(dir);
var db = getDb();
console.log("--- the false negatives, before and after ---");
var broken = db.all(
  `SELECT p.scryfall_id, p.name, p.set_code, p.collector_number, p.lang
   FROM printings p
   JOIN booster_sets bs ON bs.set_code = UPPER(p.set_code)
   WHERE p.in_boosters = 1
     AND NOT EXISTS (SELECT 1 FROM booster_odds bo WHERE bo.scryfall_id = p.scryfall_id)`
);
console.log(`  ${broken.length} printings have no odds row of their own`);
var repaired = 0;
var stillNothing = [];
for (const p of broken) {
  const odds = boosterOddsFor(p.scryfall_id, p.set_code);
  const any = odds.boosters.some((b) => b.probability > 0);
  if (any) repaired += 1;
  else stillNothing.push(`${p.name} (${p.set_code} #${p.collector_number} ${p.lang})`);
}
console.log(`  ${repaired} now report real odds via the English sibling`);
console.log(`  ${stillNothing.length} still report none:`);
for (const s of stillNothing.slice(0, 6)) console.log("     ", s);
console.log("\n--- a French card matches its English sibling exactly ---");
var pair = db.get(
  `SELECT f.scryfall_id AS fr, e.scryfall_id AS en, f.name, f.set_code
   FROM printings f
   JOIN printings e ON e.set_code = f.set_code
                   AND e.collector_number = f.collector_number
                   AND e.lang = 'en'
   JOIN booster_odds bo ON bo.scryfall_id = e.scryfall_id
   JOIN booster_sets bs ON bs.set_code = UPPER(f.set_code)
   WHERE f.lang = 'fr' AND bo.probability > 0
   LIMIT 1`
);
if (pair) {
  const frOdds = boosterOddsFor(pair.fr, pair.set_code);
  const enOdds = boosterOddsFor(pair.en, pair.set_code);
  const same = JSON.stringify(frOdds.boosters.map((b) => [b.code, b.probability])) === JSON.stringify(enOdds.boosters.map((b) => [b.code, b.probability]));
  console.log(`  ${pair.name} (${pair.set_code}):`, same ? "identical OK" : "DIFFERENT \u2014 FAILED");
  console.log("  marked as matched via English:", frOdds.via_english ? "OK" : "FAILED");
  console.log("  the English one is not marked:", enOdds.via_english ? "FAILED" : "OK");
  const best = frOdds.boosters.filter((b) => b.probability > 0);
  for (const b of best.slice(0, 3)) {
    console.log(`     ${b.name}: ${(b.probability * 100).toFixed(2)}%`);
  }
} else {
  console.log("  no French card with a priced English sibling in a fetched set");
}
console.log("\n--- the three states are exclusive ---");
var sample = db.all(
  `SELECT scryfall_id, name, set_code, in_boosters FROM printings
   WHERE in_boosters IS NOT NULL ORDER BY in_boosters LIMIT 400`
);
var notListed = 0;
var pending = 0;
var known = 0;
var withOddsAnyway = 0;
for (const p of sample) {
  const o = boosterOddsFor(p.scryfall_id, p.set_code);
  if (o.fetched) known += 1;
  else if (o.in_boosters === true) pending += 1;
  else notListed += 1;
  if (o.in_boosters === false) {
    if (o.boosters.some((b) => b.probability > 0)) withOddsAnyway += 1;
  }
}
console.log(
  `  computed: ${known}, flagged in-boosters awaiting a fetch: ${pending}, not listed as booster cards: ${notListed}`
);
console.log(`  flagged "not a booster card" yet carrying real odds: ${withOddsAnyway}`);
console.log("    (these keep their odds rather than being hidden \u2014 the whole point of the fix)");
console.log("\n--- which sets a collection-wide fetch would touch ---");
var sets = collectionBoosterSets();
console.log(`  ${sets.length} sets hold booster cards you own; ${sets.filter((s) => s.fetched).length} already fetched`);
for (const s of sets.slice(0, 12)) {
  console.log(`     ${s.set_code.padEnd(5)} ${String(s.cards).padStart(4)} cards  ${s.fetched ? "fetched" : "\u2014"}`);
}
var allSets = db.get("SELECT COUNT(DISTINCT set_code) AS n FROM printings").n;
console.log(`  (out of ${allSets} sets cached; the precon-only ones are deliberately skipped)`);
closeDb();
