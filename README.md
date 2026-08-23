# Matomeru (まとめる)

A local Windows app for handling MTG cards in bulk: store them, filter them across the
attributes that matter when sorting a pile (**language**, name, rarity, set, finish,
condition), stage pulls before they leave the collection, and see which of your Archidekt
decks a card is already sitting in.

Everything is local. The collection database and card image cache live in
`%APPDATA%\matomeru`, deliberately outside the app directory, so reinstalling or updating
never touches your data. Nothing is ever uploaded — every network call is a read.

## Running it

```bash
npm install
npm run dev        # dev, with hot reload
npm run build      # typecheck both sides + bundle
npm run package    # NSIS installer + portable exe into dist/
npm run verify     # end-to-end checks against a scratch DB and the live APIs
```

> **Node version.** Electron 43's install script needs Node **≥ 22.12** (it does
> `require()` on an ES module). On Node 22.11 `npm install` leaves the Electron binary
> missing and `electron .` fails with _"Electron failed to install correctly"_. Either
> upgrade Node, or finish the install manually:
>
> ```bash
> cd node_modules/electron && NODE_OPTIONS=--experimental-require-module node install.js
> ```
>
> `electron-builder` needs the same flag on 22.11: `NODE_OPTIONS=--experimental-require-module npx electron-builder --win`.

## What it does

**Collection** — virtualized table or gallery. Localized names lead, with the English name
beneath when they differ, so the Japanese and English Lightning Bolts are visibly the same
card. Filter by language, rarity, set, finish, condition, colour, type, mana value and
price; sort any column; multi-select for bulk edits.

**Sorting** — a two-level sort control in the Collection header, in both list and grid mode:
pick a field and an optional tie-breaker. Colour sorts in binder order — WUBRG, then
multicolour, then colourless and lands — and choosing it pre-fills mana value as the second
level, since a colour sort with no tie-breaker leaves each colour jumbled. Table column
headers still work and drive the primary level.

**Resizable card grids** — every image grid (Collection, Add cards, Pick lists, Decks) has a
`- N/row +` control. Fewer columns means bigger cards. `Ctrl+=` zooms in (fewer columns),
`Ctrl+-` out, `Ctrl+0` resets, and `Ctrl+scroll` over the grid does the same. Each grid
remembers its own count. Tiles shed detail as they shrink, keyed on their measured width
rather than the column count, so twelve columns on a wide monitor still shows the full overlay.

**Card detail view** — click any card anywhere to get one rich surface: a large image, set,
number, rarity, language, mana cost, printed type line, **localized rules text**, the full
nonfoil/foil/etched x USD/EUR price matrix, and where the card is (loose copies, pick-list
reservations, decks). Two-faced cards get a flip button. In a grid, plain click opens this;
selection is the hover checkbox, `Ctrl+click` to toggle, `Shift+click` for a range.

**Add cards** — type a name for a picker showing _every_ printing in _every_ language, or
use fast entry (`m10 146 ja x3`) when working through a physical pile. Every printing you
touch is cached locally, so the card stays browsable offline afterwards.

**Pick lists** — the pull workflow. An open pick list **reserves** rather than removes:
collection rows show `available = quantity − reserved` while the underlying quantity stays
put. Cancelling therefore costs nothing, and quantities move exactly once, in a single
transaction, when you validate. Confirmed lists are kept as history and stay readable even
for rows that have since been emptied and deleted.

**What your deck labels mean** — Archidekt label colours get a three-way meaning, set either
in Settings or from **Label meanings** on the Decks screen. Every colour found across your
synced decks is listed with its name and usage counts, and each gets `don't own · ignore · own`:

- **don't own** — a wishlist entry. The deck stops counting as a place the card lives, so it
  shows under _not in any deck_, its deck badge drops, and the pick-list guard stops warning
  about it. If your collection does have copies, the deck reads _not in this deck — your N are
  in your bulk_, turning the disagreement into a reconciliation list.
- **own** — your cards, sleeved in a deck rather than loose in bulk. They **count towards your
  collection**: the totals gain them, Stats splits _in bulk_ from _sleeved in decks_, and they
  appear in the Collection list as read-only rows badged _in deck_ — no quantity stepper, not
  selectable, not stageable, since there is no loose card to edit or pull. The deck breakdown
  counts them as owned. Counting is **additive**: a loose copy plus a deck copy is two.
- **ignore** (the default) — the label means nothing; ownership comes purely from what you entered.

Matching is on colour alone, because Archidekt label names are usually empty. Changing a state
re-derives the flag locally, so it applies instantly with no re-sync — and **never writes to
your collection**. A _Where the copies are_ filter (bulk / in decks / both) is in the filter bar.

**Decks** — syncs your Archidekt decks and answers _"where is this card?"_. Matches are
tagged **exact** (that deck holds this very printing) or **other printing** (it holds the
same card in another printing or language, so the physical card in there is not the one you
are looking for). Deck data is a **read-only overlay** — syncing never changes what the app
thinks you own. Staging a card a deck is using raises a warning before you pull it.

A deck is laid out **the way Archidekt lays it out**: the commander pinned first, then the
categories that count towards the deck, then the piles that do not (Maybeboard, Cut). The
commander comes from Archidekt's premier category, read out of the stored deck JSON — so it
resolves on decks synced before the feature existed, with no re-sync. Every card is counted
under **exactly one** group, its other categories shown as chips, which is what keeps the
group counts summing to the deck total.

Archidekt's categories are **optional as the grouping**. Switch them off and the commander stays
pinned, every in-deck category collapses into one `Deck` section in your chosen sort order, and
the excluded piles stay separate below — so the deck proper is still visibly distinct from cards
you cut. It is a persisted display preference applied in the renderer, so toggling it is instant
and costs no query.

Counts are **cards, not rows**: an entry of `Forest ×8` counts as eight. Owned and missing
always sum to the deck's card total, so the summary can no longer disagree with the header.
There are no Owned/Missing tabs — ownership is one filter alongside search, category (built
from that deck's own categories), colour, rarity, type line and Archidekt label, plus the same
two-level sort as the Collection screen. Filtering happens locally: a deck is a few hundred
already-fetched rows, so there is no round trip per keystroke. Group counts recompute from the
filtered set, so every number on screen describes what is on screen.

**Where to get it** — the card detail view shows the chance of pulling that printing from each of
its set's boosters, computed from MTGJSON's actual booster recipes: named booster types, each a
weighted list of pack configurations drawing picks from card-to-weight sheets. Per-set data is
fetched on demand (2–4MB), distilled into an odds table and discarded. A card on a colour-balanced
sheet is marked `≈`, because that sheet deliberately skews the draw. Sealed products follow from the
pack: `1 − (1 − p)^packs`.

The arithmetic is self-checking: summed over every card, expected copies must equal the pack's pick
count, since each pick yields exactly one card. Any error in a weight or denominator fails that
assertion immediately.

"Never fetched" and "fetched, and this card is in no booster" are deliberately different — most of a
Commander-precon collection is genuinely in no booster, and 0% is the honest answer rather than a
missing measurement.

**App language** — English or French, in Settings → Appearance, defaulting to your Windows language.
`fr.ts` is typed as `Record<TranslationKey, string>`, so a string without a translation fails the
build rather than silently falling back. Numbers, money and dates go through `Intl`, so French gets
`1 234,56 €` and `il y a 2 h`.

**Filtering printings** — the Add-cards picker and the card-detail picker share one filter bar:
language, set, rarity and finish, all multi-select, with every option and count derived from the
results so nothing is offered that would return nothing. Filters hold for the session and across both
screens — set the language once when entering a French collection. The finish axis asks _does it come
in this_, so a card sold both ways appears under either.

Search results are **capped at three pages**, because a common card is brutal without one: `Forest`
has **3,890** printings across all languages, which is 23 requests for one keystroke — the traffic
Scryfall's own docs tell you to use their bulk downloads for. The newest 525 are fetched and the UI
says so rather than implying the list is complete. Caching them is one transaction and one grouped
owned-count query, not one of each per printing.

**Choosing a printing** — the card detail view lists every printing of a card in every language
(the all-printings search, which is where translations published under another set code turn up) and
lets you point a deck entry or a collection row straight at one. A collection row _is_ a printing, so
that is a repoint: if you already hold the target printing the quantities merge, and a row with copies
reserved by an open pick list refuses to move.

**Declaring a language** — when Scryfall has no printing of a card in the language you hold, say so
anyway. The row keeps a real printing underneath, which is where prices, rules text and mana cost
come from; only the language and, if you type one, the localized name become your assertion. Marked
with a ★ so a declared language is never mistaken for a confirmed one, and choosing a real printing
later retires it.

**Deck card languages** — Archidekt has no language field, so every printing it reports is the
English one. Select the cards you mean — hover checkbox, Ctrl-click to toggle, Shift-click for a
range across sections, or **Select all shown** — and set the language on **exactly those**. There
is deliberately no whole-deck button: converting 148 cards because you wanted three is not
something worth making easy. The override records the real printing, so a French copy in your
collection finally satisfies an entry Archidekt could only record as English, even with _require
the exact printing_ on.

Cards with **no printing in that language keep the one they had** and are flagged (`!FR`). That
flag is per card, recorded against the card you actually asked about — it lives in its own
`deck_card_lang_requests` table rather than as a column on the overrides, because that table's
`scryfall_id` is `NOT NULL`: a failure row would have to name some printing, and naming the
card's current one would pin it there, letting a lookup that _failed_ outrank Archidekt the next
time it moved the entry. A later successful override clears the flag as part of the same write.
Overrides themselves are keyed on the card's oracle id and live in their own table, so they
survive both a re-sync (which deletes and reinserts every deck row) and Archidekt switching an
entry to a different printing — with the documented consequence that a deck listing one card as
several printings shares one override.

**Import / export** — CSV in and out, with presets for ManaBox, Moxfield and Deckbox plus a
manual column mapper. Always previews first: matched, ambiguous and unmatched counts, and
nothing is written until you commit. Unresolved rows can be exported, fixed, and re-imported.

**Screen state** — each screen keeps what you left there: the selected deck or pick list,
Add-cards results, an in-progress CSV import, and scroll position. Views are mounted once and
kept alive rather than remounted, so nothing is discarded on navigation. List/grid choice per
screen is a display preference and persists across restarts.

**Prices & stats** — cached Scryfall prices, collection value in USD or EUR, and breakdowns
by rarity, language and set. Where deck copies count towards the collection, every figure
splits into _in bulk_ and _sleeved in decks_ so the combined number never hides its origin.

## How it is put together

```
src/main/       Electron main process — owns the DB, all network calls, the filesystem
  db/           schema + migrations, one repo per aggregate
  scryfall/     throttled client + card→row mappers
  archidekt/    throttled client + deck→row mappers
  services/     add cards, deck sync, price sync, CSV, image cache
  ipc/          typed channels
src/preload/    contextBridge — the renderer's only door to the main process
src/renderer/   React 19 + Tailwind v4 + motion
src/shared/     types and helpers used by both sides
scripts/        verify.ts (checks), seed-demo.ts (sample data for eyeballing the UI)
```

**Floating panels must be portalled.** Dropdowns render into `document.body` via
`components/Popover.tsx`, not as absolutely-positioned children. An in-tree panel is at the
mercy of its ancestors: the filter bar's `backdrop-filter` creates a stacking context that
traps any z-index inside it, and the collapsible "More" panel's `overflow-hidden` clips its
children outright. No z-index escapes either. The layer scale lives in one place, documented
at the top of `index.css`.

The renderer has no Node access (`contextIsolation: true`, `nodeIntegration: false`) and
runs under a strict CSP. Card images are served from the local cache over a custom
`matomeru://` protocol rather than `file://`, so the filesystem is never exposed to the page.

SQLite is **`node-sqlite3-wasm`**, not `better-sqlite3`. That is deliberate: this machine
has no MSVC toolchain and `better-sqlite3` v13 ships no Windows prebuilt binaries, so it
would try to compile from source and fail — and Electron would additionally need an ABI
rebuild. The WASM build needs neither. `electron-builder.yml` unpacks it from the asar,
since it loads its `.wasm` from disk at runtime.

## API notes worth keeping

These were established by probing the live services, and several contradict what the docs
imply. They are the reason parts of the code look the way they do.

**Scryfall**

- `GET /cards/{set}/{number}/{lang}` is the **only** reliable way to reach a specific
  language printing.
- `POST /cards/collection` **silently ignores** a `lang` identifier and returns the English
  card. So CSV rows carrying a language must be resolved one request at a time. Batching by
  `id` _does_ preserve language, which is what price refresh uses.
- `GET /cards/named?...&lang=xx` ignores `lang` too.
- `include_multilingual=true` is required on `/cards/search` or you only get English.
- Non-English printings frequently have **entirely null prices**. Card-level values render
  as `—`, never `0`.
- A descriptive `User-Agent` and explicit `Accept` are mandatory; generic agents get a 403.
  All traffic is funnelled through one queue at 1 request / 100 ms.

**Archidekt** (no public API — reverse-engineered)

- Working: `GET /api/users/username/{username}/`, `GET /api/users/{userId}/decks/`,
  `GET /api/decks/{deckId}/`.
- `GET /api/decks/v3/?owner={username}` returns 200 and looks right but **ignores `owner`**,
  handing back a global feed of recent decks from every user. Do not use it.
- Dead ends: `/api/decks/?owner=`, `/api/decks/cards/?owner=`, `/api/search/decks/`,
  `/api/users/{username}/`, `/api/folders/user/{id}/`.
- Private decks return **404** to unauthenticated requests, and the username endpoint omits
  them — so `deckCount` can exceed the number of decks listed. The app reports that gap
  rather than hiding it.
- Each deck card carries both `card.uid` (the Scryfall printing id) and
  `card.oracleCard.uid` (the oracle id). That pair is what powers the exact/other-printing
  distinction.
- A card's `label` is one string of the form `"name,#color"` — e.g. `"Don't Have,#F47373"`.
  **The name is frequently empty** (`",#656565"`), which is why the "don't own" feature keys
  off the colour. There is **no deck-level registry of labels**, so the only way to know
  which exist is to scan the cards of decks already synced. Unlabelled cards come back as
  `""`, not null.
- Throttled to 1 request / 500 ms, and decks whose `updatedAt` is unchanged are skipped.

## Verification

`npm run verify` runs 279 checks against a throwaway database and the live APIs, covering
the things most likely to break quietly:

- language round-trips (JA/FR/EN are distinct rows; localized names are searchable)
- the UNIQUE merge (re-adding bumps quantity; a different condition is a new row)
- pick list reservations — that an open list leaves the database untouched, that
  over-picking is capped, that cancel is a no-op and confirm moves quantities exactly once,
  and that history survives the row being deleted
- the two-tier deck match, and that a deck sync never alters collection quantities or value
- null-price safety and persistence across a close/reopen
- migration 2 backfilling `printed_text` from `raw_json` on an existing database
- label parsing, including an empty name, a name containing a comma, and no colour at all
- that marking a colour "don't own" removes the deck from `cardLocations`, from the deck
  badge count and from the _in a deck_ filter — and that unmarking restores all three with
  no re-sync and no change to any collection quantity
- that grid column counts round-trip, and that a corrupt or out-of-range stored value clamps
  or falls back rather than reaching the renderer
- **the safety property behind the deck-copy union**: with no colour set to `own`, every
  total, filter and row matches a plain `collection_items` query exactly
- marking a colour `own` raises the total by exactly the deck quantity, adds a derived row
  with no id and nothing available to pull, keeps the bulk figure unchanged, and moves the
  card to the deck's Owned tab
- additive double counting, and that a card owned in two decks is **one** row of the summed
  quantity naming both decks — grouped on printing _and_ finish, so a foil and a nonfoil copy
  stay separate
- **the deck counting arithmetic**: owned + missing equals the card total, in-deck plus
  excluded equals the card total, an entry of quantity 8 that you fully own contributes 8, and
  the group counts sum to the deck total — the assertion that catches a multi-category card
  being counted twice
- commanders resolving from the stored deck JSON with no re-sync, a deck with two commanders
  reporting both, and a deck with no premier category producing no premier group
- **that a language override survives a deck re-sync** (which deletes and reinserts every deck
  row), changes which printing the entry matches, and leaves `collection_items` untouched
- that a whole-deck language flags what it could not convert instead of relabelling it
- the renderer's deck filtering and sorting: ownership partitions the deck, the category filter
  matches any of a card's categories rather than only its owning group, unlabelled cards stay
  reachable, and the colour order stays monotonic
- **language scoping**: setting a language for one card changes that card and leaves every other
  one unflagged; a deck-wide default no longer implies every card was asked about
- a failed request is recorded against that card alone, leaves its printing untouched rather than
  pinning it, and clears itself when a later override succeeds
- **grouping off** collapses the in-deck categories into one section whose counts equal the sum of
  the categories it replaced, with the commander and the excluded piles still separate
- **tile chunking at 1, 3 and 8 columns**: every card appears exactly once and no tile row ever
  straddles two sections — the assertion behind a grid that is honest about its headings
- progress coalescing: a 52-event burst reaches the renderer as fewer than 10 messages, with the
  first never delayed and the last still carrying the true final counts
- **a language override reaches every answer**: the derived collection rows, the stats totals and the
  location answers all resolve through it, not through the printing Archidekt reported
- **a stand-in price is marked**: an unpriced printing borrows the same-set sibling's figure and
  reports `price_is_proxy`, a printing with its own price does not, and a card with no priced printing
  anywhere still reports null rather than 0
- **a foil-only printing can be added**, recorded as foil rather than refused or filed as nonfoil
- **printing filters**: facets offer exactly the values present and their counts add up to the list,
  a language filter keeps only that language, axes combine as AND, an empty filter set preserves the
  list and its order, and a foil-only printing matches `foil` but not `nonfoil`
- **repointing a collection row** at another printing, including the merge when you already hold the
  target, and the refusal when copies are reserved by an open pick list
- **a declared language** wins over the printing it sits on, for both a collection row and a deck
  entry, without touching the printing underneath — so prices and rules text keep working — and the
  language filter finds the row under the language you declared, not the printing's
- choosing a real printing afterwards retires the declaration
- the deck language facet offers exactly the languages present, counts cards not rows, and filters on
  the effective language so an override counts
- **every tile row declares the same track count its height was computed from** — laying a short
  final chunk over fewer, wider tracks made it taller than its slot, and the overflow painted behind
  the rows below as duplicate giant cards

`npm run check:geometry` covers what those checks structurally cannot: it measures a **running** app
over the debug protocol and compares every virtualized row's declared height against the height its
content actually occupies, at 2/5/8/14 columns, with grouping on and off, and in both view modes.
Node counts and a clean console all passed while short rows overflowed by up to 1100px — a negative
delta is the only thing that catches it. Expect `overlappingRows: 0` and a positive `+gap` on tile
rows.

- that a condition filter excludes derived rows (a deck copy has no recorded condition)
- that changing any label state never writes to `collection_items`
- that the pre-tristate `notOwnedColors` setting migrates to the possession map on read
- colour sorts in WUBRG → multicolour → colourless order, that a secondary sort breaks ties,
  and that reversing only the tie-breaker leaves the primary order alone
- **every collection row has a unique non-empty `key`** — a null key once made React reuse
  DOM nodes and paint one card's name across other rows
- `DeckCardRow.held` counts an `own` label, and the Owned/Missing split can never disagree
  with the number printed beside it
- `viewModes` round-trips, and an invalid mode falls back per screen without losing the others

`scripts/seed-demo.ts` fills a database with a multilingual sample. Point it and the app at
the same throwaway directory to inspect the UI without touching a real collection:

```bash
node .seed.cjs /tmp/demo          # after: npm run verify (which builds the bundler output)
npx electron . --user-data-dir=/tmp/demo
```

## Not built

- Pasting an Archidekt text export. It is the only no-login route to a **private** deck;
  public and unlisted decks are covered by username sync and add-by-URL.
- No Archidekt login, and no credentials are stored anywhere.
- No app icon yet — the packaged exe uses the default Electron one. Drop a 256×256
  `resources/icon.ico` in and rebuild to change that.
