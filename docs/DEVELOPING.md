# Developing Matomeru

How the app is put together, and why it is put together that way. Most of this exists
because something subtle went wrong once and a check now stops it happening again — the
reasoning is the point, not the description.

For what the app *does*, see the [README](../README.md).

## Running it

```bash
npm install
npm run dev        # dev, with hot reload
npm run build      # typecheck both sides + bundle
npm run package    # NSIS installer + portable exe into dist/
npm run verify     # end-to-end checks against a scratch DB and the live APIs
```

> **`electron-builder` is pinned to 26.13.0, exactly — do not widen it to a caret.**
> From 26.14.0 on, `app-builder-lib`'s blockmap step does
> `require("@noble/hashes/blake2.js")` from CommonJS while asking for `^2.2.0`, and every
> `@noble/hashes` 2.x is ESM-only with no CJS entry point. So `npm run package` dies with
> `ERR_REQUIRE_ESM` after the bundle is written but before any installer is produced. The
> `require` sits at module top level, so `differentialPackage: false` does *not* avoid it —
> the import throws whether or not a blockmap is ever built. Checked up to 26.15.7, still
> broken; 26.13.0 predates the file entirely. `^26.13.0` would resolve straight back into it.

> **Node version.** Electron 43's install script needs Node **≥ 22.12** (it does
> `require()` on an ES module). On Node 24.19 `npm install` leaves the Electron binary
> missing and `electron .` fails with _"Electron failed to install correctly"_. Either
> upgrade Node, or finish the install manually:
>
> ```bash
> cd node_modules/electron && NODE_OPTIONS=--experimental-require-module node install.js
> ```
>
> `electron-builder` needs the same flag on 22.11: `NODE_OPTIONS=--experimental-require-module npx electron-builder --win`.

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

### Tokens, and the number printed on a card

A Cat Warrior token reads `C17 008/011`. Typing `c17 8` added **Teferi's Protection**,
with no error, because C17 #8 genuinely is Teferi's Protection — a token sheet is its own
Scryfall set (`tc17`), and the code printed on a token card is the *parent's*.

The card carries the disambiguator: the denominator. C17 has 309 cards and TC17 has 11, so
`008/011` can only be the sheet. That is reliable rather than lucky — of **212** token
sets, **zero** share their parent's `card_count`, and for 14/14 sampled the count equals
the highest collector number, so the printed denominator matches what the `sets` cache
already holds. `parent_set_code` makes the lookup exact instead of a guess at `"t" + code`.

The denominator may only ever *narrow* the choice, never veto it: for most sets the printed
number is not `card_count` at all (Bloomburrow prints `/261` and counts 398), and
`printed_size` — the number actually on the cards — exists for only 169 of 1048 sets. So
`chooseSets` always ends with the set that was typed.

Three more API facts worth not rediscovering:

- **Leading zeros are rejected.** `blb/008` is a 404 and `blb/8` is the card, so the number
  printed on a modern card cannot be typed verbatim without stripping them.
- **Collector numbers are case-sensitive, in both directions.** `unf/200a` exists and
  `unf/200A` does not; `plst/TDFT-14` exists and `plst/tdft-14` does not. Lowercase
  suffixes and uppercase prefixes are both normal, so nothing can be normalised — the
  typed form is tried first and the other cases only on the way to a failure.
- **Extras are excluded by default**, and a token is an extra. `!"Cat Warrior"` was a 404
  until `include_extras=true`; autocomplete offered "Cat Warriors" and "Mirri, Cat Warrior"
  but not the token in your hand; and a token row's printing picker fell back to
  `searchCards`, which returned 175 printings for "Fish" and not one token. The flag costs
  little — `!"Lightning Bolt"` goes from 158 printings to 170 — and `holdable` in the
  mappers drops the one addition that cannot be in a paper binder, Alchemy.

**Double-faced cards.** Scryfall puts a `Cat // Dragon` token's images *only* on
`card_faces`, and the app stored one image per printing, always face 0. The detail modal
had a flip control already — it turned the rules text over while the picture stayed put.
`matomeru://image/{id}?size=…&face=1` fixes that, and the back's URL was already in the
database: `raw_json` is stored whole, so reading `$.card_faces[1]` needs no re-sync and no
request. Face 0 keeps its old filename and an absent `face` still means the front, or
every already-cached image would be orphaned and silently re-downloaded.

Which layouts have a picture per face is not what the names suggest, so it was measured:
`transform`, `modal_dfc`, `double_faced_token`, `reversible_card` and `art_series` do.
Split, flip, adventure and meld cards are also named "A // B" and have exactly one image,
and a battle is filed under `transform`. Hence `TWO_IMAGE_LAYOUTS` rather than a test on
the name.

### One physical card, two different tokens — removed, and why

A Commander 2017 token card is a Cat Warrior on the front (`C17 008/011`) and a Rat on the
back (`C17 003/011`), and Scryfall files those as two independent single-faced tokens.
Each carries `all_parts`, but it links to the *spells that create the token* — `Hungry
Lynx`, `Jedit Ojanen` — never to the other side of the physical card. So nothing in the
data can derive it: the app had to be told.

For a while it could be. `printing_pairs` (migration 17) held the claim, a fast-entry line
`c17 008/011 // 003` and a "One card, two sides" action made it, and `filedUnder` in the
collection repo made a copy of either side land on whichever row already existed.

**It is gone** (migration 20), and the reason is worth keeping. A claim the app cannot
check has to be defended everywhere, and every defence was another rule:

- It could be told nonsense. A real collection ended up with a Cat Warrior token joined to
  Teferi's Protection — unexplainable after the fact. Migration 19 added a guard.
- It outlived the cards. Remove the copies and the claim stayed, so a search for a plain
  Rat kept returning "Cat Warrior // Rat" with no way to take it apart: the row the
  Separate action needed was the row that had been deleted. Migration 19 added a trigger.
- It reached where it did not belong. Attached to search results it renamed cards in the
  catalogue that had nothing to do with anyone's collection.

What remains is the two-sided card Scryfall publishes — `transform`, `modal_dfc`,
`double_faced_token`, `reversible_card`, `art_series` — which stacks in every gallery and
turns over in the detail dialog, needs nobody to maintain it, and cannot be wrong. The
collection keeps the copies either side ever held; only the claim that they were one card
is gone. `scripts/verify.ts` has a tripwire that fails if any source file outside the
migration history mentions `printing_pairs` again.

**One thing that work left behind, which was worth keeping.** The undo property test
fingerprints the database before and after an action to catch a scope that is too narrow —
but its table list was hand-written, so a newly added table was invisible to it and a scope
missing that table passed. The list is now derived from `sqlite_master` minus an explicit
set of caches, which inverts the failure: a table added tomorrow is compared without anyone
remembering to say so.

### A card with no Archidekt label counts as owned

Four Commander 2017 precons in a real collection reported cards their owner held as
missing, and mapping every label colour to "I own it" changed nothing. The reason, measured
from the stored raw API response rather than reasoned about:

```
Dino Pants        label: ",#656565"    <- the unnamed grey default, all 103 entries
Arcane Wizardry   label: ""            <- empty string, all 83 entries
```

**Archidekt sends an empty string for a deck nobody has marked up.** Not the default grey —
nothing. `recomputeLabelPossession` matches `label LIKE '%' || colour`, which an empty
string cannot satisfy, so `label_possession` stayed NULL and the deck fell back to counting
loose collection copies. There was no colour to map.

So an unlabelled card is now `owned`, in one statement after the colour passes. It is
additive by construction: the colour passes filter on `label IS NOT NULL AND label != ''`,
so **a colour still decides wherever there is one**, including one that means "I do not own
this". The clear step's exemption for locally-moved copies needs no counterpart, because a
card you carried in yourself has no label either and this rule lands it on `owned` anyway.

The cost, which is real and was accepted deliberately: a decklist imported to price up what
you would need to buy reads as fully owned until you label it.

Two fixtures in `verify.ts` had to be given labels rather than relaxed — the "I own this"
and "I do not own this" sections both built deck cards with no label to mean "nothing
tagged", which under this rule would have made them measure the new default instead of the
thing they were written for.

### In the deck, in your collection, or missing

The Decks screen had one number per card, `held`, and it added two different facts together:
what the deck holds (an "owned" label, or a proxy) and what your bulk holds. `groupCards`
bucketed on that sum, so a card the deck holds **none** of, sitting loose in your collection,
counted as owned, read "have 4", turned green and left the missing pile.

Three states now. `allocateCopies` in `@shared/types` is the one definition:

```ts
const inDeck = Math.min(card.in_deck, card.quantity)
const fromCollection = Math.min(Math.max(0, card.quantity - inDeck), card.in_collection)
const missing = Math.max(0, card.quantity - inDeck - fromCollection)
```

Allocated in that order, so the three always add up to what the entry asks for. It is
**shared because the sum is worked out twice** — once in the breakdown, and again in
`deckGroups.ts` when a filter changes which cards a group contains. Those were two copies of
the same arithmetic, which is two chances to disagree about whether a deck is finished.

Three things worth knowing before touching it:

- **`held` is unchanged**, and still `in_deck + in_collection`. The move guards, the
  pick-list paths, `deckSourcesFor` and the collection's derived rows all read it and none
  of them cares where a copy is. Only the Decks screen splits.
- **`missingCards` and `missingValue` are unchanged too.** The old `missing` was
  `quantity − held` and `held` already counted loose copies, so a card in your bulk was
  never money you had to spend. What split is the owned side. Measured on a real
  collection: adding one loose copy of a card a deck was missing moved it from
  missing 12 → 11 and in-collection 0 → 1, and the pile went €143.66 → €142.00.
- **The new bucket only fills for a card the deck does not vouch for** — an unmapped label
  or one that means "I do not own this". With every colour mapped to "I own it" and
  unlabelled counting as owned, it reads 0 everywhere, which is correct and can look like
  the feature is missing.

Four existing checks had to move, and each was re-read rather than relaxed: three pinned
`ownedCards + missingCards === cards` and one asserted `ownedCards === 8` for a fixture whose
eight copies are *loose*. That last one is the behaviour being changed, so it became the
check that proves it — those eight are `inCollectionCards`, and the same entry with an
"owned" label moves them back. One caution learned there: `recomputeLabelPossession` is
global, so calling it inside a shared fixture marks every unlabelled row in it as owned and
breaks unrelated checks downstream; set `label_possession` on the row under test instead.

### Re-fetching one deck

The all-decks sync skips any deck whose stored `external_updated_at` matches what the
profile reports (`deckSync.ts`), so a deck you re-labelled in Archidekt and nothing else is
skipped indefinitely. `decks:syncOne` goes straight at one deck and never consults that
check, which is the point of a button.

It calls **`addDeckByUrl`, not `syncOneDeck`**. `syncOneDeck` leaves `cacheDeckPrintings`
and `recomputeLabelPossession` to its callers, and skipping the first leaves deck cards with
no printing row — no images, no prices. `addDeckByUrl` is already that whole sequence, and
`upsertDeck` conflicts on `(source, external_id)` so it refreshes rather than duplicating;
reusing it means a fourth step added tomorrow reaches this path too. A failure is written to
the deck with `recordDeckError`, so a private or deleted deck keeps its lock icon instead of
a toast that disappears.

The sidebar row had to stop being one full-width `<button>` — a button cannot contain a
button — so it is a positioned wrapper holding the selection button and the sync icon as
siblings. The icon is quiet until hovered **except on a deck that failed**, which is the one
you most want to retry. `npm run probe:decksync` checks the control; the round trip is in
the suite, against recordings, because a real re-fetch needs the account whose decks they
are.

### The details dialog follows its content, and never moves while you use it

Two requirements that pull against each other. It must follow its content — a short card in
a window-height dialog is a lot of empty space — and it must not resize while you are using
it, because turning a card over swaps the rules text.

- **A ceiling, not a height.** `Modal` takes `maxHeight` for this; `height` still means
  "exactly this tall". Only one of the two makes sense per caller, so `height` wins when
  both are given. (`max-h-[85vh]` used to be hardcoded *alongside* a stated height, and
  `max-h` beats `h` — the dialog asked for 88vh and was drawn at 85 for weeks with nothing
  to say so.)
- **Both faces in one grid cell**, one faded out, rather than mounting only the side being
  read. The taller side sets the height and the flip cannot change it. This replaced an
  `AnimatePresence` swap, which would have made the height follow whichever face was
  showing.
- **The artwork asks for no height of its own.** Its box is `flex-1 min-h-0` and the button
  inside it is absolutely positioned, so the details column alone decides the row. An
  earlier attempt used `h-full` on the image, which resolves to `auto` against an
  indefinite height — so the picture's intrinsic 936px set the row and every card came out
  at the ceiling.
- **The frame is card-shaped, and the height comes from the width.** `object-contain` keeps
  the *picture's* proportions and says nothing about the ring and the rounded corners around
  it: with `inset-0` those wrapped the whole box and the card sat in a letterbox, measured
  at 224×716 against the 0.718 a card is. Deriving the width from `h-full` does not fix it
  either — an explicit height wins against `aspect-ratio`, so a clamped `max-width` just
  breaks the ratio. So it is `w-full` plus `aspect-[488/680]`, with `max-h-full` as the
  guard for a row short enough to bind.
- **The column states its own width** (`sm:w-[32rem] sm:max-w-[30vw]`). It was `w-auto`
  between a min and a max, which worked while the picture was in flow and wanted width —
  once the picture left the flow nothing in that column asked for any, so it collapsed to
  its floor and the card came out at 224px, smaller than before the dialog was ever made to
  grow. That regression is invisible to a ratio check, which is why `probe-flip` also
  asserts the card fills its column and is at least 320px wide on a wide window.

Measured: 839px for a short card against 878px for a wordy one in a 1500px window, both
under the 1380px ceiling, and identical before and after a flip. `probe-flip.cjs` widens the
viewport through CDP to check this, because on a default window every card's details exceed
the ceiling and three cards would agree by coincidence.

### Selecting cards, and acting on more than you can see

**One dispatcher, three screens.** `useRangeSelection` owns Ctrl (toggle), Shift (range
from the last thing clicked) and a plain click (`only` — this one and nothing else). There
were two copies of this, the collection's and the Decks screen's, and they had drifted: one
had a plain-click mode the other did not, and the collection's was never handed to the
table at all, so Ctrl-click and Shift-click did nothing in list mode. Ranges walk the
ordered array, never the DOM — both lists are virtualized, so most rows in a range are not
mounted and a DOM walk would silently select a fraction.

The two galleries keep plain click = open the card, because that is the only way to open one
from a tile. Both *lists* select on a plain click, since their card name is a link that
opens it. A modified click that lands on the name or the deck chip is handed back to the row
rather than opening a dialog over it.

**Select-all reaches the whole filtered set, not the page.** The list draws at most
`PAGE_SIZE` (200) rows of a set that can be much larger, so `matchingRowKeys` answers from
the same `buildWhere` and `FROM_ROWS` the page query uses — one definition of "what
matches", because two would select the wrong cards silently. It returns `{ key, id }`, and
the id is the load-bearing part: a row the list has not loaded has no `CollectionRow` in the
renderer, so the id travels with the key or an edit would apply to the 200 rows that happen
to be drawn. `truncated` says the cap was hit rather than implying the selection is
complete.

Two consequences to keep in mind:

- The selection now **survives a refetch** and is cleared only when the filters change.
  Editing does not change which rows match, which is what makes "set the finish, then the
  condition, then stage them" work. Sort is excluded from that comparison: reordering the
  same rows is not a new question.
- Staging and moving are **not offered** past the loaded page (`beyondLoaded`). Both need a
  whole row — a quantity, what is available — which is not knowable for a row nobody has
  loaded. Saying so beats applying them to a fraction.

**A language across many rows.** A collection row *is* a printing, so setting a language is
a repoint: `setItemsLanguage` asks Scryfall for the printing in that language, one row at a
time (sequential on purpose — the client's queue paces the requests anyway, and firing them
together would only queue behind itself while making progress meaningless). Four outcomes,
and three are not failures: `converted`, `unavailable` (Scryfall has no printing in that
language — the escape hatch is the per-row `forceLanguage`), `gone` (the selection named a
row the collection no longer holds, which a long-lived selection makes reachable), and
`failed`.

Two things about the undo, both of which were wrong before this:

- It has to be `undoableAsync`. `undoable` snapshots the after-image the moment the
  function returns, and an async function returns a promise before it has written anything
  — so the two images matched and **redo did nothing**.
- The scope has to be `withPickItems(wholeTable('collection_items'))`. The printings these
  rows land on come back from Scryfall and are not knowable from the arguments, so a scope
  built from the ids in hand covers where the rows started and not where they end up. The
  same reason `moveScopes` does it. Narrow it and the fingerprint check fails by losing a
  row on redo, which is what it is there for.

`npm run probe:select` drives the gestures and both controls in the running app.

### Fast entry is four fields, not a line

It was one text box and a parser: `m10 146 ja x3`, with `c17 008/011` reading the printed
fraction. Sorting a pile from one set meant retyping the set and the language for every
card in it, so it is now Set / Number / Language / Quantity, and a checkbox — on by
default — that clears only the number after each card.

`parseCollectorNumber` in `src/shared/quickEntry.ts` is what survived the line, and it is
the part that mattered: it strips leading zeros because Scryfall 404s on `blb/008`, and it
reads the printed fraction, which is the only thing that tells a Cat Warrior token from
Teferi's Protection at `c17 8`. `chooseSets` still decides which sheet a denominator names.

`npm run probe:tokens` drives all of this in the running app — including the regression
that `c17 8` is still Teferi's Protection, because trading one silent wrong card for
another would be no fix.

## Moving cards between decks and the collection

A card sitting in an Archidekt deck under a label colour you have mapped to "owned"
is a physical card of yours, just sleeved. It can be moved into the collection, and
a card in the collection can be moved into a deck — in either direction, at once,
from the Decks screen or the Collection. Moving into a deck asks which deck and how
many; a deck need not already list the card, so you can put anything you own into
one.

A move **relocates**: the card is yours before and after, so your card count and
your total value do not change. That is what makes it a different act from a pick
list, which is for cards **leaving your possession** — which is why validating one
removes them. A deck card can still go on a pick list, and then it carries a
destination, because pulling a card out to keep and pulling it out to sell are
different errands: *to the collection* keeps it, *out of the collection* does not.

Archidekt is read-only reference data, so the app cannot change a decklist there.
Instead `deck_card_moves` records the local divergence — negative for copies taken
out, positive for copies put in — and the deck screen tags it: **Out** or **Added**,
each listing its moves with an undo. Each sync compares its baseline against what
Archidekt now says: caught up in full, the marker goes; in part, it shrinks and
rebases; not at all, it stands. One rule, both directions.

Two design points worth knowing:

- **Moves are written into `deck_cards`, not applied when reading it.** The deck
  rows *are* what the deck physically holds. An earlier version adjusted quantities
  at read time, which meant threading the adjustment through the 27 queries that
  read a deck — two of which never got it, and Stats ended up reporting a card and
  $485 more than the Collection. Materialising deletes that whole class of bug
  rather than guarding against it. The cost is that `applyDeckMoves` is not
  idempotent, so it runs in exactly one place: inside `replaceDeckCards`, where the
  rows are known to be pristine.
- **An emptied slot keeps its row, at quantity 0.** Deleting it looked tidier and
  hid the one fact worth reporting: moving the last copy out left the deck screen
  with nothing to hang the tag on, so a deck missing a card looked complete and
  there was nothing to click to undo. Rows at 0 are excluded from the derived
  collection rows, so an empty slot is never mistaken for a holding.

A card you moved into a deck has no Archidekt label, and the sync's possession
recompute derives every flag from those labels — so it exempts rows the ledger says
you put there yourself. Reading that from the ledger rather than a column on the row
is deliberate: a flag had to be written and unwritten, and the version that did so
marked a row as locally-added while *undoing* a move out, for copies that were
Archidekt's all along.

Two moves out are refused, both to stop one inventing a card: an entry not labelled
as owned is a wishlist line rather than a card you hold, and a slot filled by a
proxy cannot become a collection row without dragging real copies of the same
printing into being proxies too — `collection_items` is UNIQUE on
(scryfall_id, finish, condition), which does not include `proxied`.

### A local move belongs to one entry, not to one card

A deck can hold two printings of the same card, and for a long time everything about a
local move was keyed by **oracle id**. So a fact about one copy was applied to both. Three
symptoms, all reported from one afternoon's use, all the same cause:

- **The wrong artwork.** Remove print A from a deck, add print B, and the emptied entry
  showed B's art and B's PROXY badge. `moveToDeck` wrote a `deck_card_overrides` row to
  carry the proxy flag — and an override *redirects the printing* of every entry of that
  card. The badge was the visible half; the redirect was the damage.
- **No "out" tag.** `moved` summed the ledger per card, so a −1 for A and a +1 for B
  cancelled and neither entry admitted the deck had drifted from the decklist.
- **An entry stuck at 0.** Move a card the decklist never mentioned in, then out. The
  cleanup asked `COUNT(*)` of remaining moves — two, a +1 and a −1 — when the question is
  whether they *net* to anything.

Two more fell out of reading the code, and one of those was already reachable: taking
copies out picked the entry with `LIMIT 1` and read its proxy flag from the card, so with a
proxy of print B in the deck, **taking the real print A out was refused** as "that slot is
filled by a proxy" — about a slot holding no proxy at all. And `moveToCollection` was
handed only an oracle id although the deck screen had always selected a *row*, so removing
one printing could empty the other.

**One meaning per table.** `deck_card_overrides` was doing two jobs. Its documented one is
*which printing you own for this deck entry*, keyed on oracle so it survives Archidekt
re-pointing the entry (migration 4). The other, bolted on when moves learned to carry a
proxy, is *these copies are proxies / are surge foil* — which belongs to the copies, and
therefore to a printing. Migration 18 splits the second into `deck_entry_traits`, keyed
`(deck, oracle, printing)`, the same argument `deck_card_lang_requests` already made.

Every reader goes through three shared constants — `DECK_TRAITS_JOIN`, `DECK_PROXIED`,
`DECK_TREATMENT` in `decks.ts` — because five files read that flag, and a check sweeps the
main process to prove none of them reads it off the override table again.

**The ledger records what left and where from.** `deck_card_moves.scryfall_id` stays the
*copies* — a revert looks the collection row up by it — so `entry_scryfall_id` says which
entry they came out of. Those differ only in the case the override exists for (Archidekt
lists the English card, you own the French), and null reads as "the same", which is right
for every entry that was never overridden.

**An empty entry is kept or dropped per entry, never per card.** This one only became clear
against real data: one deck held two empty entries of the same card for opposite reasons —
an Archidekt entry whose copy had been taken out, which must keep its slot because that is
where the tag hangs and what you click to undo, and beside it an entry a move had invented
and cancelled. Summed across the card those net to zero, so a per-card rule would have
deleted the decklist entry along with the phantom. `pruneEmptyEntries` asks about the entry,
and runs from all three paths that can empty one — a move out, a revert, and the replay
after a sync, without which a phantom returns on the next sync.

Migration 18 also does two one-off repairs, because the state is already out there: it
retires overrides that carry nothing but a flag *and* name a printing one of the entries
already has (so the redirect was a no-op for that entry and wrong for the others), and it
clears entries already sitting at zero whose own moves cancel.

## Undo and redo

Ctrl+Z and Ctrl+Y cover every local edit in the Collection, Decks and Pick lists —
around twenty actions, including validating and reverting a pull. Syncs and price
refreshes are deliberately outside it: they refetch from the network and can be
run again, and a sync *clears* the history because it rewrites whole tables and
could move rows out from under a pending step.

The mechanism is a row-level before/after journal rather than hand-written inverse
SQL, so insert, update and delete are one case — "make these rows look like this
again" — and there is no per-action inverse to keep in step. The history is
session-only, held in the main process, capped at 50 steps.

Restoring a snapshot passes through intermediate states that violate foreign keys
on their own — a pick list item references a collection row that has not been put
back yet — so the restore runs with `PRAGMA defer_foreign_keys = ON` and the
constraints are checked once, against the finished image. Ordering parents before
children fixes the common case and the scopes are ordered that way, but it cannot
fix every case: `setPrinting` legitimately passes two scopes over the same table,
and one can remove a row the other is about to restore. Without the deferral,
every undo of a validated pick list failed with *"FOREIGN KEY constraint failed"*.

What that design costs is that each action must declare **which rows it can
touch**, on a key a new row already satisfies. `collection_items` is scoped on its
UNIQUE key rather than an id, because an add has no id yet and because changing a
copy's finish moves it across that key and can merge it into a sibling row. Inside
a text field Ctrl+Z is left to the browser: there it means "undo my typing", and
stealing it to roll back a database write while you fixed a typo would be both
surprising and destructive. `Ctrl+S` follows the same rule for the same reason.

## Backing up to Google Drive

`Ctrl+S` opens a dialog; nothing is sent by the keystroke alone. It shows what is on
this machine beside what is on Drive, and confirming uploads a snapshot of the
database. Restore is offered from the same dialog and from Settings.

**No desktop sync client, and one click to connect.** Settings offers "Connect with
Google Drive"; the browser opens Google's consent page, you approve, and that is the
whole flow. The OAuth client is compiled in from a gitignored `.env` — see
`.env.example` for the one-time Google Cloud setup — so there is nothing to paste and
nothing to configure. A build made without a `.env` says so rather than offering a
button that cannot work.

The consent page cannot exist without a `client_id`: it is a required parameter of that
page's URL, and there is no anonymous way to ask Google for access. So the credential
does not disappear, it moves — registered once at build time instead of typed in on
every install. A packaged asar is extractable, so the bundled secret is readable by
anyone with the installer; that is the documented shape of Google's installed-app
flow, and PKCE is what actually protects the exchange.

The one scope requested is `drive.file`, which Google restricts to files the app
created **or the user explicitly picked**: the rest of your Drive stays invisible,
enforced on Google's side rather than promised on ours. Set the consent screen's
publishing status to **In production**, or refresh tokens expire every seven days and
the connection dies weekly.

**The folder is named, not browsed to.** Settings holds a text field — `Matomeru` by
default — and the app creates or reuses a folder of that name at the top of your
Drive. That is a deliberate limit rather than a shortcut: `drive.file` lets the app
create and reuse its own folders but not *list* yours, and the two ways to browse both
cost more than they are worth. Google's Picker needs a second credential and a window
of its own; a folder tree of ours would need the full `drive` scope, which is
*restricted* — publishing it requires Google verification, and not publishing means
re-authorising weekly. So the scope that keeps the rest of your Drive invisible is the
same scope that cannot show it to you, and a name is the honest interface to that.

Renaming points future backups elsewhere and leaves existing ones where they are; the
cached folder id is dropped on rename, so the next backup resolves the new name rather
than writing into the old folder by id. A folder that has been deleted or trashed is
recreated rather than failing every save.

**The snapshot travels gzipped** — 30 MB of database becomes about 4 MB, since a card
collection is mostly repetitive text. `zlib` is built into Node, so this costs no
dependency. The manifest's sha256 covers the *compressed* bytes, so it still proves a
download arrived intact, and `integrity_check` runs after decompressing, so it still
proves those bytes are a database: two checks, two jobs. A backup written before
compression existed has no `.gz` suffix and is restored directly, so it never becomes
unreadable.

The refresh token is sealed with Electron's `safeStorage` (DPAPI on Windows) and
stored under a `backup.*` key that is deliberately **not** part of `AppSettings` —
that type is handed to the renderer wholesale, and a credential has no business
crossing into a window. What the renderer gets is a derived `BackupStatus`, and a
check asserts it carries those fields and nothing else. Migration 15 deletes the rows
from when the client could be pasted in, the refresh token among them: a token issued
to a different client cannot be refreshed with this one, so keeping it would only
produce an error nobody could act on.

The snapshot is `VACUUM INTO`, not a file copy: copying is only safe when nothing is
mid-write, and nothing can promise that while a price refresh might be running.
SQLite builds the copy, so it is the committed state by construction.

**"Nothing changed" is decided by the file's mtime, not by a hash**, and that is not
laziness. `VACUUM INTO` writes a different file every run — three consecutive
snapshots of one untouched database produce three different digests, because the
header advances each generation. A hash comparison would report "changed" almost
always and the skip would never fire. mtime answers the question actually asked, and
when it is wrong it costs one needless upload rather than a missed one. The
manifest's sha256 keeps its real job: proving a *download* is the bytes that were
uploaded.

Restore is ordered so that everything which can refuse runs **before** the local
file is touched — schema version, then download, then checksum, then SQLite's own
`integrity_check`, and only then is the live database moved aside, into a
`before-restore-*.db` kept next to it. Then the app relaunches rather than
hot-swapping: `invalidate()` refreshes only the visible view, and a restore also
replaces settings, theme, locale, the first-paint theme hint in `localStorage` and
every piece of session state. Restarting resets all of it provably.

The remote is injected as a four-method `RemoteStore`, so `npm run verify` drives the
whole save/restore path — including a corrupt payload, a valid database with a wrong
checksum, and a snapshot claiming a newer schema — against an in-memory fake, with
no credentials and no network. Sabotaging the order so the file is replaced before it
is verified is reported by name, as `UNREADABLE: file is not a database`.

## Updating

`electron-builder` already emitted `latest.yml` with a sha512 of the installer — that
file *is* electron-updater's feed format — so GitHub releases were already an update
feed waiting to be read. Settings has an Updates panel: current version, a check
button, and whichever single action applies.

Three behaviours, from one `updateMode()`:

| Mode | When | What it does |
|---|---|---|
| `auto` | installed (NSIS) | check, download on request, install on restart |
| `notify` | portable | check the releases API, offer to open the release page |
| `disabled` | running from source | nothing, and says why |

`disabled` and `notify` are not politeness. `autoUpdater` reads `app-update.yml` when
it initialises and throws outside a packaged app, which is why the import is dynamic
and only happens in `auto`. And the portable build is the trap: `app-update.yml` is
written into the *shared* resources directory, so the portable exe contains one too and
electron-updater will cheerfully check and download before failing at the install —
the worst possible moment to discover it. The portable stub sets
`PORTABLE_EXECUTABLE_DIR` (`app-builder-lib/templates/nsis/portable.nsi`), which is the
signal to take the other road.

`autoDownload` is off. 96 MB should not start moving because the app launched; the
launch check only looks, and it looks **silently** — an unreachable GitHub or a
repository with no releases leaves no trace, because nobody asked and there is nothing
to do about it. The manual check reports everything. That distinction lives in a
module-level `quiet` flag rather than a closure, because electron-updater reports
failure through an event and an event can outlive the promise it belongs to.

`win.verifyUpdateCodeSignature: false` is set, and deserves saying out loud rather
than hiding in a diff: the app is unsigned, and electron-updater's Windows check
compares the downloaded installer's signature to the running app's publisher. With no
signature at either end that check fails and the update simply never installs.
Integrity then rests on the sha512 in `latest.yml` over HTTPS from GitHub — weaker
than code signing, and the same trust already placed in the download link.

**Publishing:** `electron-builder --publish always` uploads the installer, `latest.yml`
and the portable exe, and needs `GH_TOKEN` in the environment at publish time only,
never in the app. The tag must match `package.json` (`v0.1.1` for `0.1.1`) or the feed
and the app disagree about what is newer.

**On `npm audit`:** adding `electron-updater` raises a high advisory against
`builder-util-runtime` (credential leak on cross-origin redirect). It does not apply to
what ships here: `electron-updater` carries its own nested `builder-util-runtime@9.7.0`,
which is the patched version, and the vulnerable 9.6.3 sits only under
`electron-builder` — a devDependency that never reaches the package. `npm audit fix`
would "fix" it by moving electron-builder to 26.15.x, which is exactly the version
range the pin exists to avoid.

### What the first real update taught

0.1.3 → 0.2.0 installed successfully and was still wrong in six ways. Every one of them
was invisible in development, because every one of them lives on a path only a packaged
install reaches. The log of that run is the reason they are all findable, which is why
keeping the log of the next one is worth the trouble.

| What happened | Why |
|---|---|
| `ERROR … Cannot download ".../Matomeru-Setup-0.2.0.exe.blockmap", status 404` | `nsis.differentialPackage: false` means no blockmap is built, but electron-updater still went looking. `disableDifferentialDownload = true` now says so. |
| `WARN disableWebInstaller is set to false` | The log asking us to mean what we say. `disableWebInstaller = true`. |
| The release notes appeared as raw HTML | electron-updater's GitHub provider reads the **releases feed**, whose content is HTML — not the Markdown body the API returns. `notesToText` converts it: `<li>` to a bullet, blocks to line breaks, entities decoded. Rendering that HTML would mean injecting a release body into the page, and a Markdown parser would be a dependency for decoration. |
| Clicking Download looked inert | `downloadUpdate` raised `state.downloading` and **never announced it** before awaiting a 96 MB transfer, so the button kept reading "Download update". It announces before the await now, and the dialog closes on the click — the progress bar is the report, and a modal on top of it adds nothing. |
| "Later", then quit, installed it anyway | `autoInstallOnAppQuit` was `true`: `INFO Auto install update on quit`, 14 seconds after the choice. A prompt offering *install or not* has to be able to mean not. It is `false`, and the dialog comes back as **Ready to install** when the file lands. |
| Nothing prompted until Settings was opened | The launch check pushed its result to whoever was listening, and a renderer that mounted afterwards — a reload, a second window, a slow first paint — heard nothing. It now also asks once, on mount, and skips that answer if a push beat it. |

Two smaller things fell out of looking: the check logs its own outcome at INFO on every
route (`up to date`, `X available`, `check failed`), because a log holding *Checking for
update* with no answer under it is a log you have to guess at. And a two-item list came
out double-spaced — `</li>` ends a line and `<li>` starts one — which no check that
counts bullets would have noticed.

**Rehearsing it: `--fake-update=<version>`.** The reason all six of those shipped is
that nothing could exercise the flow. `updateMode` reports `disabled` from source, the
dialog reads that and greys out its own Download button, and electron-updater refuses to
fetch without an installer to replace. So the flag fabricates the whole thing: the
notice (as HTML, then converted, because plain-text fake notes would have looked perfect
throughout the very bug they were meant to show), `auto` mode, a transfer that takes two
seconds, and an install that stops short of restarting.

```
npm run build
npx electron . --user-data-dir=/tmp/probe --remote-debugging-port=9334 --fake-update=9.9.9
npm run probe:update
```

That drives the real dialog and checks fifteen things about it, including the two that
only exist mid-transfer: the dialog gets out of the way on the click, and does **not**
reopen on top of its own progress. `parseFakeUpdate` refuses in a packaged build, and
`verify` asserts both that and that every rehearsed path is gated on one variable with a
single source. What none of it settles is the real transfer and the real restart — only
a release does that.

## A card with two sides looks like two cards

Outside the detail dialog a two-sided card used to show only its front. Every card tile now
draws the pair: the back offset behind the front, and hovering brings the back forward and
names the side that has just gone behind.

Two different things are two-sided and **nothing that draws a card distinguishes them**:

| | the two sides are | the second picture is |
|---|---|---|
| Kefka, and every `transform` / `modal_dfc` / `double_faced_token` / `reversible_card` / `art_series` card | two faces of one printing | `face=1` of the same id |
| a Commander token with a Cat Warrior on the front and a Rat on the back | two printings | the other printing's own image |

`twoSides(printing, paired)` in `src/shared/types.ts` answers which, and returns the same
shape either way — `{ scryfallId, face, title }` per side. `bothSidesTitle` is the name,
`A // B`, which is what Scryfall already calls a two-faced card and what a paired token now
gets composed for it. That composition is also the bug it was written for: the collection's
**gallery tile is a different component from its table row**, so a merged Cat Warrior // Rat
read as "Cat Warrior" in the one view a card is usually looked at in.

`StackedArt` in `primitives.tsx` draws it, and four surfaces go through it — the collection
gallery, the Add-cards results, and the deck and pick-list galleries. Five things about it
are load-bearing, and three of them are the fixes for how it looked when it first shipped:

- **With no back it renders exactly the `CardImage` it used to.** That is what keeps every
  ordinary card — almost all of them — byte-identical, and a check asserts the
  short-circuit is still there.
- **Both cards are drawn at 88% in opposite corners.** 88% + 12% = 100%, so the pair fits
  the tile's own box: a grid cannot overflow into its neighbours.
- **`StackedArt` positions its own wrappers, never the cards.** Handing `absolute` to
  `CardImage` does not work and *fails silently*: its wrapper hardcodes `relative`, both
  land on one element with equal specificity, and Tailwind emits `.relative` after
  `.absolute` — so the later rule wins however the classes are ordered in the attribute.
  The cards then laid out in normal flow and the tile grew to twice its neighbours' height.
- **`isolate` on the container.** The tile paints its name, footer and badges as later
  siblings with no `z-index`, so the stack's `z-10`/`z-20` competed with them and won — the
  artwork covered the card's own information. A stacking context confines those numbers to
  ordering the two cards against each other.
- **The tile is still.** It briefly turned the card over on hover, through two invisible
  shields pinned to the cards' resting positions so that only the exposed sliver reacted.
  That came out: the detail dialog flips the card properly, so a grid that turned cards over
  as the pointer crossed it was movement for its own sake. A tile's job here is to say
  "this card has two sides"; the turning belongs where it can be done well. A check asserts
  the component carries no hover variant at all, because this is the kind of thing that
  creeps back.

`CardTile` takes the back as three primitives — `backScryfallId`, `backFace`, `hiddenTitle`
— and not as an object. It is memoized, and a freshly-built object each render defeats that
as surely as inline JSX does, which that file's own comment already warns about.

The deck and pick-list queries returned no `layout` at all, so those galleries could not
tell a two-sided card from any other; both select it now, which is all a tile needs — a
two-sided card is one printing with two faces, so `twoSides(printing)` answers from the
layout and the id alone.

**Which layouts have two pictures was measured, not reasoned about**, and the distinction is
not the one the names suggest: a split, flip, adventure or meld card is *also* named `A // B`
and has exactly one image, while a battle is filed under `transform`. Hence
`TWO_IMAGE_LAYOUTS` rather than a test on the name — a stack drawn from the name alone shows
the same art twice and calls it a flip.

`npm run probe:stack` drives it in the running app, and it has to be a probe rather than a
unit test for a reason worth keeping in mind: every unit check here verifies *which
pictures* a tile asks for, and those were right the whole time. Both bugs that reached the
screen were about where things ended up.

- **The layering is a hit test.** `document.elementFromPoint` over the tile's name has to
  come back as the name, not as an `<img>`.
- **The geometry is measured.** A two-sided tile has to be the same size as a one-sided one,
  which is how the double-height bug reads as a number: 154×378 against 154×215.

## The card dialog turns the card over, and holds its size

Two things it was getting wrong. It swapped one picture for another, so a card that
physically turns over read as a cut. And `Modal` is `flex max-h-[85vh] flex-col` with a
content-driven height, so the dialog was as tall as whatever was in it — which meant
flipping a card, and therefore swapping its rules text, resized the dialog under the
pointer, and every card opened at a different size.

**The flip.** Both faces are rendered at once inside a 3D container and the card rotates
`rotateY` 0 → 180, each face hiding its own back so the far side appears exactly as the
rotation passes edge-on. Two details are load-bearing:

- `preserve-3d` must not sit on an element with `overflow` other than `visible` — that
  flattens the whole thing — so the rounding and clipping stay on the button *outside* the
  perspective wrapper.
- The words follow the picture. The info panel is driven by a second state that updates when
  the rotation passes 90°, from `motion`'s `onUpdate`, so the rules text changes while the
  card is edge-on rather than before it has moved. Reduce-motion needs nothing anywhere
  here: `App.tsx` wraps the tree in a `MotionConfig` that stills the rotation, `onUpdate`
  fires once at the end, and the swap is simply instant.

The dialog also stopped working the two sides out for itself and now asks `twoSides` — the
same helper every card tile uses — so the grid and the dialog cannot disagree about what the
back of a card is.

**The size.** `Modal` gained an optional `height` and a `scrollBody` flag; the card dialog
passes `h-[min(85vh,36rem)]` and `scrollBody={false}`, and its details column owns the
scrolling so the artwork stays put. Only from `sm:` up, though — below that the two columns
collapse into one, stack past the fixed height, and the body keeps its own scroll so nothing
becomes unreachable.

`npm run probe:flip` measures both: the dialog's box is identical before and after a flip
and identical across a transform card, a paired token and a one-sided card (896×576 in a
default window), and the flip is caught mid-rotation — `matrix3d(-0.16, 0, -0.99, …)` at
about 99° — which is the only way to tell a rotation from a cut.

## Floating surfaces

Popovers, dialogs and toasts use `.panel-floating`, not `.panel`. The two want
opposite things: sitting *on* the page, a 4% lightness step groups content without
shouting; floating *over* it, the same step means no discernible edge. Measured,
the old popover was 1.04 contrast against the page with a 1.21 border — opaque, but
reading as though you could see through it. The edge carries the separation rather
than the fill, because a fill bright enough to reach 3:1 against a dark page is no
longer a dark theme.

The tone colours (`good`, `warn`, `bad`) are overridden for a light shell, so each
stays legible as text on the surface it lands on. Because they invert with the
shell, a solid chip of one pairs correctly with `text-ink-950`, which inverts the
other way: near-black on light amber in dark mode, white on dark amber in light. A
fixed label colour would read 8:1 in one mode and 2.4:1 in the other. A tinted chip
is fine on a panel — its text contrasts with the panel — but a chip over card
artwork must be solid, since nothing controls what is behind it.

## Logging and debug mode

`src/main/services/log.ts`, no dependency. Errors and a few key events are always
written to `<userData>/logs/main.log`; `logDebug` only writes under `--verbose`. One
megabyte then a single rollover to `main.log.old`, so two files is the entire footprint.

Wired into the three places that used to swallow everything:

- **`handle()`** logs every IPC failure with its channel. That wrapper already saw every
  error the UI would ever show; until it wrote them down, a message could reach the
  screen and leave nothing behind.
- **`autoUpdater.logger`** was `null`. That cost real time: when the updater failed on a
  CJS/ESM interop problem, electron-updater's own account went nowhere and all that
  surfaced was a `TypeError` in a toast.
- **The renderer** had no `onerror` and no `unhandledrejection`, so an uncaught render
  error was a blank window and silence. Both now report through `logs:record`.

**Redaction is part of the writer**, not a rule to remember per call site: sealed
settings values, `GOCSPX-` secrets, bearer tokens and Google's token shapes are stripped
before a line is written, because the whole point of the file is that it gets shared. A
check feeds all of those through and asserts none survives while the message still does.

**The flag is `--verbose`, and that was learned the hard way.** `--debug` was the obvious
name and it makes the app refuse to launch: Node intercepts it before any of this code
runs and Electron exits with `[DEP0062]: node --debug and node --debug-brk are invalid`.
Nothing in a unit test can see that — only starting the app can — so `RESERVED_FLAGS` in
`log.ts` pins the names to avoid, and a check asserts our flag is not among them.

`--verbose` also opens DevTools, and `Ctrl+Shift+I` is bound explicitly rather than
relying on Electron's default menu, which sits behind `autoHideMenuBar`.

## Verification

### Importing a CommonJS dependency from the ESM main process

The built main process is ESM. A dependency left external — `electron-updater`, and any
future one — is therefore loaded by Node's ESM loader, which has to guess which *named*
exports a CommonJS module offers. It guesses with `cjs-module-lexer`, and the guess can
fail silently.

It did. `const { autoUpdater } = await import('electron-updater')` gave `undefined` in a
packaged build, because the package exports through an arrow-function getter:

```js
Object.defineProperty(exports, "autoUpdater", {
  enumerable: true,
  get: () => { return _autoUpdater || doLoadAutoUpdater(); },
})
```

The lexer understands the `get: function () { return x }` form tsc emits, not that one.
What *is* guaranteed for any CJS module is that its `default` is `module.exports`, so
`pickAutoUpdater` in `updateCheck.ts` reads the named export first and falls back to
`default`. A `verify` check imports a fixture module with that exact shape from a real
ESM child process and asserts both halves, so if a future Node closes the gap the check
says so rather than leaving a workaround nobody dares remove.

Worth remembering the *reason* it shipped: the import only runs in `auto` mode, and a
development run is always `disabled`, so the failing path could not execute locally. When
a code path is unreachable in development, that is the one to write a check for.

### The suite never uses the network

Two sections used to call Scryfall and Archidekt for real. That worked on one machine
and nowhere else: the first CI run was refused by Archidekt with a 403, which is what a
shared cloud IP gets when it asks for a deck. Deleting them was not an option — one
seeds the printings every later section builds on, and the other is thirty checks of
mapping and matching.

So the socket was replaced and everything else kept. Both clients call the global
`fetch`, so `scripts/verify.ts` installs its own before anything runs and replays
`scripts/fixtures/http.json.gz` — thirteen recorded responses, 664 KB gzipped from
3.6 MB of JSON. The real clients still parse, the real mappers still map, the caching
still writes rows.

Two properties make this trustworthy rather than merely tidy:

- **An unrecorded URL is a hard failure**, naming the URL and the fix. The rule stays
  true when someone adds a call later, because their call fails loudly instead of
  quietly dialling out.
- **Loopback is passed straight through and never recorded.** The loopback checks start
  a server in-process on an ephemeral port; recording those would capture a port number
  that never comes round again.

Proven, not assumed: with the underlying `fetch` replaced by one that throws on any
non-loopback host, the suite still reports 475 passed — so nothing escapes.

`npm run verify:record` re-runs against the real APIs and rewrites the fixture. That is
the one command here that uses the network, and it is run deliberately: when an API
changes, or when a new call is added. The diff on the fixture is then the record of what
moved.

**The trade, stated plainly:** a recording cannot notice that Scryfall changed its
response shape yesterday. That is the price of a suite that runs anywhere, and
re-recording is how you go and look.



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

Moves are checked as a **conservation property** rather than field by field: move,
resync, revert, and assert the card count and the money are unchanged at every
step, because a move only relocates. That is what caught the bugs worth recording —
a read-time subtraction applied to *every* `deck_cards` row sharing an oracle, so
one copy taken out emptied two slots when a deck listed the same card in two
printings; and a check that asserted `held` survived a sync passed while the
mechanism was broken, because `held` also counts the loose copy the fixture had left
in the collection. The second is the more instructive: assert the mechanism, not a
number that something else can satisfy.

Undo is checked as a **generic property over every action**: do it, undo it, and a
fingerprint of the whole database must equal what it was; redo it, and it must
equal what it was after. One loop covers all of them, and it is what catches a
scope too narrow to cover its action — the one way a before/after journal fails
silently. The suite includes a deliberately under-scoped step that must fail the
round trip, so the property cannot pass by measuring nothing.

`npm run check:themes` measures every colour scheme in a running app. The ramps are built with
`color-mix()` and `oklch(from ...)` over a few per-theme seeds, so nothing about a theme can be
confirmed by reading the stylesheet: Lightning CSS emits a static srgb fallback beside each mixed
token with the *default* seeds inlined, and if that branch ever won, all twelve themes would collapse
to the default palette while the CSS still looked right. So it resolves each token through a probe
element, converts it through a canvas — the same pipeline that paints the window — and checks the
contrast of every accent against the surface it actually sits on. That is not a formality: measuring
found Yotsuba's accent at **2.63:1** as a border and Tidal Wave's at **3.25:1** under text, which is
why the accent stops clamp lightness per mode instead of applying one fixed lighten to seeds that
range from `#ae3200` to `#f2f2f2`. It also asserts what a theme must *not* touch — mana and rarity
colours are identical across all twelve.

Run it on a freshly launched app, and not in the same session as `check:features`: both drive the real
UI, and `check:features` is deliberately not idempotent.

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

## Releasing

Two workflows, in `.github/workflows`.

**`ci.yml`** runs on every branch and every pull request: `npm ci`, `npm run typecheck`,
`npm run verify`, `npm run build`. No packaging, no secrets. `verify` seeds its own
printings into a scratch database, which is the only reason it can run on a runner at
all. The live suites are deliberately absent — `check:features` drives a real Electron
window over the DevTools protocol against a populated collection, and `check:themes`
needs a launch of its own. Neither exists in CI, and a check that cannot run is worse
than one that is honestly missing.

**`release.yml`** is manual (`workflow_dispatch`, with a patch/minor/major choice) and
refuses to run from anything but `main` — the Actions UI will happily launch a dispatch
from any branch, so that guard is real rather than decorative. It then:

1. runs the same checks, because a release that cannot pass them has no business
   existing;
2. bumps the version, writes `CHANGELOG.md`, commits and tags `v<version>`;
3. writes `.env` from the repository secrets;
4. builds and uploads the installer, the portable exe and `latest.yml` to a **draft**
   release;
5. sets the release notes from the top section of the changelog.

Then it stops, and you press **Publish**.

The draft is doing two jobs at once, which is why it is the right shape for the gate:
electron-updater cannot see a draft release, so nothing is offered to anyone until you
publish. "Not yet reviewed" and "not yet offered" are the same state rather than two
things to keep in step. `releaseType: draft` is stated in `electron-builder.yml` rather
than left to the default.

**CI owns the version bump on purpose.** The updater compares the app's own version to
the feed, so a tag that disagrees with `package.json` breaks updates silently, with no
error anywhere. Letting one job do both removes the chance.

### What has to be configured

Two repository secrets, under Settings → Secrets and variables → Actions:

| Secret | Why |
|---|---|
| `MAIN_VITE_GOOGLE_CLIENT_ID` | inlined at build time; without it every released copy reports that it has no Google client and Drive backup cannot work at all |
| `MAIN_VITE_GOOGLE_CLIENT_SECRET` | the same. Not confidential in the usual sense — see the note above on the installed-app flow |

The release job fails loudly if either is missing, rather than shipping something
quietly broken.

**No token to create.** electron-builder reads `GH_TOKEN`, and the workflow maps it to
the `GITHUB_TOKEN` Actions provides. Nothing to rotate.

**One repository setting:** Settings → Actions → General → Workflow permissions →
**Read and write permissions**. The job commits the bump and creates the release, and a
workflow cannot grant itself more than the repository allows — so `permissions:
contents: write` in the YAML is not sufficient on its own.

### Changelog

`npm run changelog` regenerates `CHANGELOG.md` with `conventional-changelog` (angular
preset), and note the `-r 0`: it rebuilds every section from the tags rather than
prepending the newest one. That is deliberate. Prepending is the usual invocation and it
duplicated the entire file the second time it ran — with no tags in the repository the
"latest release" range is the whole history, so it wrote the same section again on top of
itself. A derived file is better regenerated wholesale, and running it twice is then a
no-op rather than a mess to clean up.

It reports only commits matching the convention: as of writing, four of the
nine commits in this repository are a bare `oauth` and do not appear. That is the
convention working as specified, not a bug — `feat:` / `fix:` / `perf:` / `docs:` is
what makes a commit visible in a release. If that becomes a nuisance, `auto-changelog`
keeps everything and is close to a one-line swap.
