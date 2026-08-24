# Matomeru (まとめる)

A Windows app for handling a Magic: The Gathering collection in bulk — the sort of thing
you want when a box of cards lands on the table and needs to become a list.

Store cards with their language, set, finish and condition. Filter across all of it.
Sync your Archidekt decks and find out where a card already is. Stage the ones you are
pulling out before they leave the collection. Work out what a booster is likely to give
you.

**Everything stays on your machine.** The database and the card images live in
`%APPDATA%\matomeru`, outside the app folder, so reinstalling or updating never touches
them. The only things sent anywhere are the card lookups the app makes on your behalf —
and a backup, if you ask for one.

## Getting it

Download from the [latest release](https://github.com/Sfoucheur/matomeru/releases):

- **`Matomeru-Setup-x.y.z.exe`** — the installer. Choose this one: it can update itself.
- **`Matomeru x.y.z.exe`** — portable, if you would rather not install anything. It runs
  from wherever you put it and tells you when an update exists, but cannot replace
  itself.

Windows will warn you about an unrecognised app, because the build is not code-signed.
That warning is accurate: it means nobody has paid a certificate authority to vouch for
it, not that anything is wrong with the download.

## What it does

**Your collection**, as a table or a gallery of card images. Localised names lead, with
the English name alongside when they differ. Two-level sorting, and card grids you can
resize with `Ctrl+scroll` or the stepper in the header.

**Adding cards** by name, showing every printing in every language, or in bulk by set
and collector number. When Scryfall has no printing in the language you are holding, you
can say so and the card keeps the right language anyway.

**Card details** on one surface: a large image, the set, the rarity, the prices, every
other printing, where the card sits in your decks, and the chance of pulling that exact
printing from each booster the set comes in.

**Decks from Archidekt** — sync them and the app answers *"where is this card?"*. Deck
label colours get a meaning you choose, so the app knows which sleeved cards count as
yours.

**Moving cards between a deck and the collection**, in both directions, with the app
keeping track of what has left a deck before Archidekt has caught up.

**Pull lists** for cards on their way out — sold, traded, or going into a deck. An open
list *reserves* rather than removes, so nothing disappears from your collection until
you confirm it has actually gone. Confirmed lists can be reverted if you change your
mind.

**CSV in and out**, with presets for ManaBox, Moxfield and Deckbox.

**Prices and totals** from Scryfall, in USD or EUR, broken down by set, rarity and
language.

**English or French**, following your Windows language by default, and twelve colour
themes in light or dark.

## Keyboard shortcuts

| | |
|---|---|
| `Ctrl+S` | back up to Google Drive (asks first — nothing is sent by the keystroke) |
| `Ctrl+Z` / `Ctrl+Y` | undo and redo, for every local edit you make |
| `Alt+1` … `Alt+7` | jump between screens |
| `Ctrl+=` / `Ctrl+-` / `Ctrl+0` | bigger cards, smaller cards, reset |
| `Ctrl+scroll` | the same, over any card grid |

Inside a text box these are left alone — `Ctrl+Z` there undoes your typing, as it should.

## Backing up to Google Drive

Optional, and off until you turn it on. Settings → Backup → **Connect with Google
Drive**: your browser opens Google's own consent page, you approve, and that is the whole
setup. Your Google password is typed on Google's site and never reaches this app.

Then `Ctrl+S` offers to send a copy of your collection to a folder in your Drive, and the
same dialog can read it back to restore. You choose the folder's name; the app creates it
at the top of your Drive if it is not there yet.

A few things worth knowing:

- **The app can only see files it created.** That is enforced by Google, not promised by
  us — the permission requested (`drive.file`) does not allow it to look at anything else
  in your Drive.
- **The backup is your database, compressed** — about 4 MB for a 30 MB collection. Card
  images are not included; they re-download on their own.
- **Restoring replaces everything on this machine**, and keeps a copy of what was there
  first, in case that was not what you wanted.
- **You can withdraw access** at any time, from Settings or from
  [your Google account](https://myaccount.google.com/permissions).

Full detail of what is stored and what is sent where: the [privacy
policy](https://sfoucheur.github.io/matomeru/privacy.html).

## Updates

The installed version looks for a new release shortly after it starts, and says nothing
unless there is one. When there is, Settings → Updates offers to download it and install
on restart. You can also check whenever you like, or turn the startup check off.

The portable version cannot replace itself, so it opens the release page instead.

## Building it yourself

```bash
npm install
npm run dev
```

Everything else — architecture, the reasoning behind the awkward parts, how it is
verified, and how releases are cut — is in [docs/DEVELOPING.md](docs/DEVELOPING.md).

---

Matomeru is unofficial Fan Content. Not affiliated with or endorsed by Wizards of the
Coast, Scryfall or Archidekt. Card data and images come from
[Scryfall](https://scryfall.com), set and booster data from
[MTGJSON](https://mtgjson.com), and decklists from [Archidekt](https://archidekt.com).
