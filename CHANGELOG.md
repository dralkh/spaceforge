# Changelog

## 1.2.1

### Fixes

- **Picking a date in the calendar now takes you to that day's list.** The click asked the
  workspace for the sidebar; after a plugin reload that lookup answers null, so the mode changed
  and nothing was redrawn — with a notice claiming the sidebar would update. The calendar now
  answers through the panel that drew it.
- **The List tab always responds.** Pressing the tab that already named the current mode did
  nothing, which is exactly the state a date pick left behind.
- **A month no longer reads every note.** Each cell's time estimate read the note's text, so a
  vault with hundreds of scheduled notes spent seconds before drawing; the estimate now comes
  from the file's size. Measured: 400 scheduled notes, 2 ms to draw the month.
- The sidebar finds its live view after a plugin reload (it asked for the class, which is a
  different class object after a reload, and got null — so file events and the minute tick had
  quietly stopped refreshing the panel).

## 1.2.0

### Decks and Anki

- **Anki packages round-trip properly.** Note values are padded to the model's field
  width, templates are aligned by template ordinal, and a note whose cards carry an
  implausible spread of ordinals is capped and reported instead of producing a model
  Anki refuses. Cell Biology decks, cloze decks and multi-template decks import into
  Anki as they left.
- **A running Anki stays in step.** With the AnkiConnect add-on, *Sync with Anki in the
  background* pulls each deck, merges it card by card, and pushes it back: content,
  due date and ease factor. The push is skipped when the deck has not changed, and a
  large deck goes over in slices because Anki's importer fails on a single huge
  package.
- **Two devices reviewing one deck keep both sets of answers.** Every answer is
  appended to a per-device log under `spaceforge/sync/decks/`, so a file sync has
  nothing to conflict on and a re-import merges per card instead of per file.
- Deck cards can be browsed by deck and by question, and a sitting can start on a
  named card.

### Progress across devices

- **Carry progress with the vault** (off by default): a projection of review progress
  and shared preferences is written to `spaceforge/state/progress.json`, inside the
  vault, and merged on load. This is for readers who sync their notes but not the
  Obsidian configuration folder — the plugin's own data file still lives there.
- Merging is per record: reviews made on either device are kept, the newest review of
  a note wins, logs are unioned and counters never move backwards. Device state (a
  sitting in progress, the pomodoro clock) and anything that names the machine or
  holds a credential never leave the device.
- A device with no data file adopts the vault copy, so a reinstall or a fresh phone
  recovers instead of starting empty. Conflicted copies from Dropbox, Syncthing,
  iCloud and Obsidian are merged and set aside under `spaceforge/state/.merged/`.

### Fixes

- Data-file writes stay atomic, and a write interrupted by a reload no longer leaves a
  truncated file behind.
- The Anki bridge reports what it could not do — a due date its add-on will not
  write, a package Anki refused — instead of claiming success.

## 1.1.3

- Resolved the community-plugin review warnings.

## 1.1.2

- Statistics dashboard, CLI providers, and release checks.

## 1.1.1

- Release fixes.

## 1.1.0

- First public release.
