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
> `require()` on an ES module). On Node 22.11 `npm install` leaves the Electron binary
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
