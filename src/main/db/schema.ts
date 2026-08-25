/**
 * Schema migrations, applied in order. Each entry runs once and is recorded in
 * `schema_version`, so adding a new one is always append-only — never edit an
 * existing migration once it has shipped.
 */
export interface Migration {
  version: number
  name: string
  sql: string
}

export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: 'initial',
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
    name: 'printed_text_and_deck_labels',
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
    name: 'label_possession_tristate',
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
    name: 'deck_language_overrides',
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
    name: 'deck_card_lang_requests',
    sql: `
      -- A language you asked for that Scryfall has no printing in.
      --
      -- Deliberately its own table rather than a nullable column on
      -- deck_card_overrides: that table's scryfall_id is NOT NULL, so a failure
      -- row would have to name some printing, and naming the card's current one
      -- would pin it there — the next time Archidekt moved the entry to another
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
    name: 'forced_language_and_name',
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
    name: 'booster_odds',
    sql: `
      -- Which sets we have distilled booster data for, and when.
      --
      -- MTGJSON publishes the actual booster recipes: named booster types, each a
      -- weighted list of configurations, each configuration drawing a number of
      -- picks from named sheets, each sheet a card-to-weight map. That is enough
      -- to compute a real probability rather than a guess. A set file is a few MB
      -- of JSON but arrives brotli-compressed (~1.3MB on the wire); it is distilled
      -- into the table below and then thrown away — none of the raw file is kept.
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
    name: 'foil_treatment_and_booster_presence',
    sql: `
      -- Which kind of foil a printing's foil version is, and whether the card is
      -- sold in boosters at all. Both come straight out of the Scryfall object we
      -- already store, so this backfills from disk with no re-fetch — the same
      -- trick migration 2 used for printed_text.
      --
      -- promo_types is Scryfall's tag list: surgefoil, ripplefoil, galaxyfoil and
      -- friends. It describes THE FOIL VERSION of a printing, not the printing as
      -- a whole: a surge-foil card is sold as ["nonfoil","foil"], and only the foil
      -- one is a surge foil. That is why a treatment is only ever shown for a foil
      -- copy, and why it is derived rather than stored per copy.
      ALTER TABLE printings ADD COLUMN promo_types TEXT;
      -- Scryfall's own answer to "does this card come in booster packs". Present
      -- for every printing, which means "not sold in boosters" — most of a
      -- Commander-precon collection — can be answered offline, with no MTGJSON
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
      -- splitting one — and changing that constraint would mean rebuilding a table
      -- that pick_list_items references.
      ALTER TABLE collection_items ADD COLUMN foil_treatment TEXT;

      -- Deck cards had no settable finish at all: deck_cards.finish comes from
      -- Archidekt's modifier and replaceDeckCards deletes and reinserts every row
      -- on each sync, so anything set there would be lost. These two live in the
      -- override table for the same reason forced_lang does — it survives a sync.
      ALTER TABLE deck_card_overrides ADD COLUMN finish         TEXT;
      ALTER TABLE deck_card_overrides ADD COLUMN foil_treatment TEXT;

      -- Snapshotted like every other column on this table, so a confirmed list
      -- still reads correctly after the collection row it came from is gone.
      ALTER TABLE pick_list_items ADD COLUMN foil_treatment TEXT;
    `
  },
  {
    version: 9,
    name: 'booster_odds_by_finish',
    sql: `
      -- Booster odds have to be per finish, because MTGJSON's sheets are.
      --
      -- A play booster draws from \`common\`, \`wildcard\` and \`rareMythic\` (all
      -- nonfoil) *and* from \`foil\` and \`foilLand\` (foil) — each sheet carries an
      -- explicit \`foil\` flag. The first version of this table ignored it and
      -- blended both into one number per card, which overstated a foil copy
      -- badly: Thranduil #167 in a HOB play booster is 1.75% nonfoil but only
      -- 0.125% foil, and the blended figure reported 1.867% for both — 15x too
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
  },
  {
    version: 10,
    name: 'sets',
    sql: `
      -- Scryfall's set list, for the icons the set filters show.
      --
      -- One request to /sets returns all ~1050 sets with their symbol URLs, so
      -- this is a single fetch rather than a lookup per set. Kept as its own
      -- table rather than derived from the printings table, because the icon belongs
      -- to the set, not to any card, and a set filter has to draw a symbol even for
      -- a set the collection holds a single card from.
      CREATE TABLE sets (
        code         TEXT PRIMARY KEY,
        name         TEXT NOT NULL,
        set_type     TEXT,
        released_at  TEXT,
        card_count   INTEGER,
        -- The SVG symbol. Cached to disk on first use and served over matomeru://,
        -- the same route card images take, so the renderer makes no outside
        -- requests of its own.
        icon_svg_uri TEXT,
        fetched_at   TEXT NOT NULL
      );
    `
  },
  {
    version: 11,
    name: 'proxied',
    sql: `
      -- Which copies are proxies — cards you printed rather than bought.
      --
      -- Named "proxied" and not "proxy" on purpose: across this codebase "proxy"
      -- already means a stand-in *price* borrowed from another printing
      -- (price_is_proxy, PROXY_PRICE_HINT, missingValueIsProxy), and two
      -- unrelated senses of the same word would make every one of those reads
      -- ambiguous.
      --
      -- A proxied copy is worth nothing: it contributes 0 to collection value and
      -- to every stats total, while the row still shows the printing's real market
      -- price as a reference. It does fill a deck slot, because it is playable —
      -- so a deck reads complete and the card leaves the Missing pile.
      ALTER TABLE collection_items ADD COLUMN proxied INTEGER NOT NULL DEFAULT 0;

      -- On the deck side it lives in the override table, for the same reason
      -- finish does: replaceDeckCards deletes and reinserts every deck_cards row
      -- on each sync, so anything stored there would not survive one.
      ALTER TABLE deck_card_overrides ADD COLUMN proxied INTEGER;

      -- Snapshotted with the rest of the row, so a confirmed pick list still
      -- reports honestly after the collection row it came from is gone.
      ALTER TABLE pick_list_items ADD COLUMN proxied INTEGER;
    `
  },
  {
    version: 12,
    name: 'deck_pulls',
    sql: `
      -- Where a staged copy came from, when it was not a collection row.
      --
      -- A card sitting in a deck under an "owned" label is a physical card of
      -- yours, just sleeved. Until now it could not be staged at all: the whole
      -- pick list path keyed on collection_items.id, and such a card has no row
      -- there. These two columns are that key for the other case, and
      -- collection_item_id simply stays NULL -- it was already nullable, and
      -- confirmPickList already skipped NULL rows, so old lists are unaffected.
      ALTER TABLE pick_list_items ADD COLUMN source_deck_id INTEGER
        REFERENCES decks(id) ON DELETE SET NULL;
      ALTER TABLE pick_list_items ADD COLUMN source_oracle_id TEXT;

      -- A card that has physically left a deck while Archidekt still lists it.
      --
      -- Its own table rather than a column on deck_card_overrides, for the reason
      -- migration 5 already wrote down: one meaning per table. An override says
      -- which printing you own; a pull says a slot is empty. Overloading the
      -- override row would also tie a pull to a printing, and the pull is about
      -- the card leaving, not about which version it was.
      --
      -- One row per pull event, not per card, so the provenance survives (which
      -- list, when) and a revert can undo a single pull rather than every pull of
      -- that card at once.
      --
      -- deck_quantity_at_pull is what makes a resync decidable. On each sync we
      -- compare it against the new incoming quantity for the same oracle: if the
      -- deck has shrunk by at least as much as was pulled, Archidekt has caught
      -- up and the marker is dropped; if it shrank partly, the marker shrinks
      -- with it; if it is unchanged, the card stays tagged.
      --
      -- pick_list_id is ON DELETE SET NULL on purpose. Deleting the paperwork
      -- must not put the card back in the deck -- it really is out of it -- so the
      -- marker outlives the list that produced it.
      CREATE TABLE deck_card_pulls (
        id                    INTEGER PRIMARY KEY AUTOINCREMENT,
        deck_id               INTEGER NOT NULL REFERENCES decks(id) ON DELETE CASCADE,
        oracle_id             TEXT    NOT NULL,
        scryfall_id           TEXT    NOT NULL,
        finish                TEXT    NOT NULL,
        condition             TEXT    NOT NULL,
        quantity              INTEGER NOT NULL CHECK (quantity > 0),
        deck_quantity_at_pull INTEGER NOT NULL,
        pick_list_id          INTEGER REFERENCES pick_lists(id) ON DELETE SET NULL,
        created_at            TEXT    NOT NULL
      );
      CREATE INDEX idx_pulls_deck_oracle ON deck_card_pulls(deck_id, oracle_id);
      CREATE INDEX idx_pulls_list ON deck_card_pulls(pick_list_id);
    `
  },
  {
    version: 13,
    name: 'deck_card_moves',
    sql: `
      -- Cards moved between a deck and the collection, in either direction.
      --
      -- Replaces deck_card_pulls, which only recorded the out direction because
      -- taking a card out of a deck was routed through a pick list. That was the
      -- wrong shape for the act: a pick list means cards leaving your possession,
      -- and a card coming out of a deck has not left anything -- it moved. So the
      -- move is direct now, it goes both ways, and this table is the ledger.
      --
      -- quantity is signed: negative took copies out of the deck, positive put
      -- them in. That is what makes reconciliation one rule instead of two. On
      -- each sync we compare Archidekt's new quantity for the oracle against
      -- deck_quantity_at_move; if the deck has moved toward the marker by at
      -- least its size, Archidekt has caught up and the marker goes; if it moved
      -- part of the way the marker shrinks and rebases; if not, it stands.
      --
      -- No pick_list_id: a move does not come from a list any more.
      CREATE TABLE deck_card_moves (
        id                    INTEGER PRIMARY KEY AUTOINCREMENT,
        deck_id               INTEGER NOT NULL REFERENCES decks(id) ON DELETE CASCADE,
        oracle_id             TEXT    NOT NULL,
        scryfall_id           TEXT    NOT NULL,
        finish                TEXT    NOT NULL,
        condition             TEXT    NOT NULL,
        quantity              INTEGER NOT NULL CHECK (quantity != 0),
        deck_quantity_at_move INTEGER NOT NULL,
        created_at            TEXT    NOT NULL
      );
      CREATE INDEX idx_moves_deck_oracle ON deck_card_moves(deck_id, oracle_id);

      -- Existing pulls carry over as negatives: a pull is the out direction.
      INSERT INTO deck_card_moves
        (deck_id, oracle_id, scryfall_id, finish, condition, quantity,
         deck_quantity_at_move, created_at)
      SELECT deck_id, oracle_id, scryfall_id, finish, condition, -quantity,
             deck_quantity_at_pull, created_at
      FROM deck_card_pulls;

      /*
        The old model subtracted a pull when *reading* a deck, so deck_cards still
        holds Archidekt's full quantity. The new model materialises moves into
        deck_cards instead -- that is what lets every query that reads a deck stop
        caring about moves at all -- so the rows have to be brought down to what
        the decks physically hold, once, here.

        Every sibling row of an oracle is reduced by the same amount, which would
        over-subtract for a deck that lists one card under two printings. That is
        not worth more SQL: applyDeckMoves does the distribution properly and runs
        on the next sync, which rebuilds these rows from scratch anyway. This only
        has to be right for the ordinary one-row-per-card case until then.
      */
      UPDATE deck_cards SET quantity = MAX(0, quantity - COALESCE((
        SELECT SUM(-m.quantity) FROM deck_card_moves m
        WHERE m.deck_id = deck_cards.deck_id
          AND m.oracle_id = deck_cards.oracle_id
          AND m.quantity < 0
      ), 0));
      DELETE FROM deck_cards WHERE quantity <= 0;

      DROP TABLE deck_card_pulls;

      /*
        What validating a staged deck card should do with it.

        A collection row has only one answer — it leaves your possession, which is
        what a pick list is for. A deck card has two: pull it out to your box, or
        pull it out to sell. Both take it out of the deck; only one keeps it. NULL
        for a collection-sourced row, where the question does not arise.
      */
      ALTER TABLE pick_list_items ADD COLUMN destination TEXT;

      -- Rows already staged from a deck were validated under the old behaviour,
      -- which always kept the card, so that is what they meant.
      UPDATE pick_list_items SET destination = 'collection' WHERE source_deck_id IS NOT NULL;

    `
  },
  {
    version: 14,
    name: 'move_foil_treatment',
    sql: `
      -- The foil type the copies carried when they moved.
      --
      -- A move has to be able to put a card back exactly as it was, and the
      -- treatment is the one thing about a copy that neither side can re-derive: a
      -- treatment you *corrected* by hand is precisely the case where the printing's
      -- own tags do not imply it. Without this, moving a card out and back lost the
      -- correction silently.
      --
      -- Its own migration rather than an edit to 13, because 13 has already run.
      ALTER TABLE deck_card_moves ADD COLUMN foil_treatment TEXT;
    `
  },
  {
    version: 15,
    name: 'drop_user_oauth_client',
    sql: `
      -- The app used to let you paste your own Google OAuth client into Settings.
      -- It carries one of its own now, so those rows are orphans, and a client secret
      -- outliving the feature that used it is worth deleting rather than keeping.
      --
      -- The refresh token goes too, but only if one of those rows was actually there.
      -- A token issued to the user's own client cannot be refreshed with a different
      -- client's credentials -- Google answers invalid_grant -- so it has to go with
      -- the client it belonged to. A token issued to the compiled-in client is still
      -- perfectly good, and dropping it would sign the user out for nothing. Hence the
      -- EXISTS, and hence it runs before the row it tests is deleted.
      DELETE FROM settings
      WHERE key = 'backup.refreshToken'
        AND EXISTS (SELECT 1 FROM settings WHERE key = 'backup.clientId');

      DELETE FROM settings WHERE key IN ('backup.clientId', 'backup.clientSecret');
    `
  },
  {
    version: 16,
    name: 'set_parent_and_printed_size',
    sql: `
      -- What a token sheet belongs to, and what its cards say they are numbered out of.
      --
      -- Both exist to answer one question: which set is "c17 008/011"? C17 #8 is
      -- Teferi's Protection and TC17 #8 is a Cat Warrior token, so a number alone
      -- cannot say, and typing the code printed on a token card reaches the wrong
      -- card with no error at all. The denominator can say: C17 has 309 cards and
      -- its token sheet has 11.
      --
      -- parent_set_code is what makes the lookup exact rather than a guess at
      -- "t" + code -- Scryfall states the relationship, and 206 of 212 token sets
      -- carry it.
      --
      -- printed_size is the number actually printed on the cards, which for most
      -- sets is NOT card_count: Bloomburrow prints /261 and counts 398. Scryfall
      -- publishes it for only 169 of 1048 sets, so it is a refinement where
      -- available, never a requirement.
      ALTER TABLE sets ADD COLUMN parent_set_code TEXT;
      ALTER TABLE sets ADD COLUMN printed_size INTEGER;
      CREATE INDEX idx_sets_parent ON sets(parent_set_code);

      -- Every row predates both columns, so the cache has to be refetched before it
      -- can answer. One request for all 1050 sets, taken the next time anything asks.
      UPDATE sets SET fetched_at = '1970-01-01T00:00:00.000Z';
    `
  },
  {
    version: 17,
    name: 'printing_pairs',
    sql: `
      -- Two printings that are the two sides of one physical card.
      --
      -- A Commander 2017 token card has a Cat Warrior on the front and a Rat on the
      -- back, and Scryfall files those as two independent single-faced tokens. Its
      -- \`all_parts\` does link each one outwards, but to the *spells that create the
      -- token* -- Hungry Lynx, Jedit Ojanen -- never to the other side of the card.
      -- So nothing in the data can derive this and it has to be told once.
      --
      -- Told once, and not once per copy: the sheet is printed one way, so every C17
      -- Cat Warrior has the same Rat behind it. That makes this a fact about a pair
      -- of printings rather than about anything in a binder. Per language as well --
      -- the French Cat Warrior has the French Rat behind it, and those are different
      -- ids, which the primary key covers without a special case.
      --
      -- Both directions are stored. It doubles eleven rows and saves every query
      -- from having to know which side of a card it happens to be holding.
      --
      -- The primary key is the real constraint: a card has exactly one back.
      CREATE TABLE printing_pairs (
        scryfall_id        TEXT PRIMARY KEY
                                REFERENCES printings(scryfall_id) ON DELETE CASCADE,
        paired_scryfall_id TEXT NOT NULL
                                REFERENCES printings(scryfall_id) ON DELETE CASCADE,
        created_at         TEXT NOT NULL,
        -- A card is not its own back. Cheap to state, and the alternative is a row
        -- that makes every join return the card twice.
        CHECK (scryfall_id != paired_scryfall_id)
      );
      CREATE INDEX idx_printing_pairs_paired ON printing_pairs(paired_scryfall_id);
    `
  },
  {
    version: 18,
    name: 'deck_entry_traits',
    sql: `
      -- What the copies in one deck entry are, as opposed to which printing the entry
      -- names.
      --
      -- deck_card_overrides was doing both jobs and they are not the same shape. Its
      -- documented one is "which printing you own for this deck entry", keyed on oracle
      -- so that it survives Archidekt re-pointing the entry. The other, bolted on when
      -- moves learned to carry a proxy, is "these particular copies are proxies / are
      -- surge foil" -- which belongs to the copies, and therefore to a printing.
      --
      -- Keyed on oracle, that second meaning applied to every printing of the card in
      -- the deck. Take print A out of a deck, put print B in, and the emptied entry
      -- showed B's artwork and B's proxy badge; worse, taking the real print A out was
      -- then refused because "that slot is filled by a proxy" -- about a slot holding no
      -- proxy at all.
      --
      -- One meaning per table, the same argument deck_card_lang_requests already made.
      CREATE TABLE deck_entry_traits (
        deck_id        INTEGER NOT NULL REFERENCES decks(id) ON DELETE CASCADE,
        oracle_id      TEXT    NOT NULL,
        scryfall_id    TEXT    NOT NULL,
        proxied        INTEGER NOT NULL DEFAULT 0,
        foil_treatment TEXT,
        created_at     TEXT    NOT NULL,
        PRIMARY KEY (deck_id, oracle_id, scryfall_id)
      );
      CREATE INDEX idx_deck_traits_deck ON deck_entry_traits(deck_id, oracle_id);

      -- Carried across, keyed on the printing of the *deck entry* rather than the
      -- printing the override names. Those differ by design in the case the override
      -- exists for -- Archidekt says English, you own the French -- and it is the entry
      -- on screen that has to keep its badge.
      --
      -- A card already in the broken state has two entries and one flag. The override
      -- names a printing, though, and a move wrote that name when it recorded the flag --
      -- so where an entry has exactly that printing, it is the one that earned it and the
      -- other is left clean. That is the reported case: an Archidekt entry emptied of real
      -- copies, beside a proxy moved in, both wearing one badge.
      --
      -- Only when no entry has that printing does every entry keep the flag. That is the
      -- case the override exists for -- Archidekt lists the English card, you own the
      -- French -- and there the flag really is about the card as listed, so preserving it
      -- everywhere preserves what was on screen.
      INSERT OR IGNORE INTO deck_entry_traits
        (deck_id, oracle_id, scryfall_id, proxied, foil_treatment, created_at)
      SELECT DISTINCT dc.deck_id, dc.oracle_id, dc.scryfall_id,
             COALESCE(o.proxied, 0), o.foil_treatment, o.created_at
      FROM deck_card_overrides o
      JOIN deck_cards dc
        ON dc.deck_id = o.deck_id AND dc.oracle_id = o.oracle_id
      WHERE dc.scryfall_id IS NOT NULL
        AND (COALESCE(o.proxied, 0) = 1 OR o.foil_treatment IS NOT NULL)
        AND (
          dc.scryfall_id = o.scryfall_id
          OR NOT EXISTS (
               SELECT 1 FROM deck_cards d2
                WHERE d2.deck_id = o.deck_id
                  AND d2.oracle_id = o.oracle_id
                  AND d2.scryfall_id = o.scryfall_id)
        );

      -- The two columns stay on deck_card_overrides, unread. Dropping them would mean
      -- rebuilding a table for no gain; a check asserts nothing reads them again.

      -- And the rows that existed only to hold them go.
      --
      -- Moving a proxy into a deck used to create an override for no other reason than to
      -- record the flag, and an override *redirects the printing* of every entry of that
      -- card. That is what showed one artwork on two entries: not the flag, the redirect
      -- it came attached to.
      --
      -- Deleted only when the row has no other job -- no corrected finish, no declared
      -- language -- and when its printing is already one of the entries, which makes the
      -- redirect a no-op for that entry and wrong for the others. An override naming a
      -- printing the deck does not list is the case the table exists for (Archidekt lists
      -- the English card, you own the French) and is left alone.
      DELETE FROM deck_card_overrides
      WHERE finish IS NULL
        AND forced_lang IS NULL
        AND forced_name IS NULL
        AND EXISTS (
              SELECT 1 FROM deck_cards dc
               WHERE dc.deck_id = deck_card_overrides.deck_id
                 AND dc.oracle_id = deck_card_overrides.oracle_id
                 AND dc.scryfall_id = deck_card_overrides.scryfall_id);

      -- Entries a move invented and then cancelled, cleared once.
      --
      -- Moving a card the decklist never mentioned into a deck and back out left an entry
      -- at quantity 0 for ever: the cleanup counted ledger rows, and a +1 with a -1 is two
      -- rows. It is a net question, and it is a question about the entry -- an Archidekt
      -- entry emptied by a move keeps its slot, because that empty slot is the fact the
      -- deck screen exists to show. Doing it here as well as in the code means the rows
      -- already sitting there go without waiting for the next sync.
      DELETE FROM deck_cards
      WHERE quantity = 0
        AND COALESCE((
              SELECT SUM(m.quantity) FROM deck_card_moves m
               WHERE m.deck_id = deck_cards.deck_id
                 AND m.oracle_id = deck_cards.oracle_id
                 AND m.scryfall_id = deck_cards.scryfall_id
            ), 0) = 0;

      -- Which deck entry the copies came out of, as opposed to what the copies are.
      --
      -- Those are usually the same printing and differ in exactly the case
      -- deck_card_overrides exists for: Archidekt lists the English card, you own the
      -- French one, so the entry is English and the copies are French. \`scryfall_id\` has
      -- to stay the copies -- a revert looks up the collection row by it -- so the entry
      -- needs saying separately, or a move cannot be attributed to the entry it came
      -- from and the "out" tag lands nowhere.
      --
      -- Null on every row written before this, which reads as "the same as the copies".
      -- That is exactly right for every entry that was never overridden, which is all of
      -- them bar the deliberate exceptions.
      ALTER TABLE deck_card_moves ADD COLUMN entry_scryfall_id TEXT;
    `
  }
]