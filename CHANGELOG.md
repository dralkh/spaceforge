# Changelog

## 1.2.92

### The community-plugin review

- **Every finding from the review is fixed, at the cause.** The enum comparisons against plain numbers, the `any` leaving the Anki bridge and the progress mirror, the redundant type assertions, `globalThis`, and the three CSS declarations the review rejects (`column-gap`, `display: contents`, `:has()`) are gone — none of them silenced with a cast, a disable or a widened type.
- **`npm run lint:review` reproduces that report locally.** It runs the reviewer's own rule subset with `--max-warnings 0`, on the toolchain that makes those rules fire (TypeScript 5.9, typescript-eslint 8.72) — the repo's older pair reported nothing, which is why the findings arrived from the store instead of the gate.
- **The review bar did not move.** 157 px at 268/340/480 px and 98 px at 826 px, measured on the previous build and this one; only the shape of the narrow header's grid changed.
- **Two tests now pin what the review looks for**: the due state stays the header's own child, and no stylesheet may reintroduce those three declarations.

## 1.2.91

### Local CLI providers

- **Cursor Agent is sent the prompt.** `cursor-agent -p` takes its prompt as a positional argument and never reads stdin; the provider was invoked without one, so every Cursor turn ended with "No prompt provided for print mode". The prompt is now built into the command, with `--model` still ahead of it.
- **A failed CLI turn says when no model was chosen.** An empty model field means the CLI runs its own default, and when that default is the thing that fails the message now names the field to change instead of only repeating the CLI's complaint.
- **`npm run check:cli` checks every registered CLI**, not a hand-written list: detection, the live model list and a real turn per agent, with an absent or unsigned binary reported as skipped and a present-but-failing one as a defect.

## 1.2.9

### Review

- **The dock can sit beside the note.** A vertical split with Obsidian's own draggable divider, chosen from **Settings → Review → Where the review session lives → Beside the note**, or from the bar's menu. Ending the run closes the pane; the next run opens it beside the note again.
- **Due labels carry the clock.** A due note reads "due in 3h 20m" and an overdue one "2h 15m overdue"; days keep their leftover hours for the first week, while an eight-day-old note stays "8d overdue" so the bar keeps one line. The sidebar row's overdue tooltip uses the same label.
- **The objective chooser keeps its width in a split.** Below 480 px the "Objective" label steps aside, so the selected objective's name is no longer clipped by its own caption.

### Study

- **Objective cards no longer overlap in the rail.** They were flex children shrinking to their 32 px floor while a two-line title and its meta spilled under the next card; each card now keeps its content height and the rail scrolls.

## 1.2.8

### Review bar

- **A narrow pane gets a compact grade palette.** Four grades sit in a 2×2 grid, six in a 2×3 grid; the note, its due state and the controls share two lines instead of four. A wide pane keeps the single row.
- **Grade layout is the reader's choice.** Settings → Review → Grade layout offers *Auto (fit the pane)*, *One row*, and *Stacked*. *One row* keeps every grade name and lets the intervals step aside; long SM-2 names scroll sideways rather than being squeezed to a letter each.
- **The keyboard hint and the scheduler reference step aside in a narrow bar.** The shortcuts stay printed on the grade buttons; the scheduler facts stay on the note's hover.
- **The Study panel no longer repeats the note title.** In the sidebar the stage rail is one line ("Step 4 of 8 · Recall check") instead of eight pills over two rows.
- **One charting notice, not two.** The sidebar list's chart line is hidden while the Study panel reports the same run with a progress bar.

## 1.2.7

### Study workspace

- **One surface per note.** Learn, Visualize, Mind map and Summary are tabs in the same panel; the note header, objective chooser and answer field stay in place while the material scrolls.
- **Per-objective conversations.** Each objective keeps its own transcript, pending question and draft. Switching objectives, or reopening the note, restores the exact conversation, and a reload never resends a question.
- **Preparation is visible and retryable.** Material and questions are prepared in the background, their state is saved with the plan, and a failed step stays retryable without repeating the step that succeeded. Turning off one step no longer cancels the other.
- **The last report comes back.** Reopening a finished note shows the session report instead of dropping to the briefing.

### Fixes

- **A note created where an earlier note was renamed away can be charted again.** Rename receipts no longer block a live file; the chart and its progress are stored instead of silently discarded.
- **Typing an answer no longer rewrites the data file on every keystroke.** Drafts are saved once per burst, and immediately on suspend, finish or answer.
- **View state no longer stores whole visual packs as keys.** A short key and one entry replace a multi-KB duplicate per pack.
- **One save policy.** A failed save is reported in place and never becomes an unhandled rejection; the session refuses to send an answer it could not store.
- **A steering command after a failed answer sends the command**, not the previous answer.
- **One sitting counts one session**, however many objectives it visits.
- **Study transcripts are capped at 400 records** per sitting, newest kept.

### Internal

- Stable objective identities keep mastery attached to the objective, not its position, across re-charts and two devices.
- Chats, drafts and the workspace stay device-local; transcripts are not copied into the portable vault progress file.

## 1.2.6

### Fixes

- **The matrix's name column no longer collapses to one letter per line.** The corner header was
  `width: 1%` under automatic table layout, so the column shrank to its narrowest possible cell — one
  character — and "Acute pericarditis" rendered as a vertical stack of letters while every row grew to
  match. The table now lays out from its header (`table-layout: fixed`), gives the name column 22%, and
  breaks names between words rather than within them.
- A narrow pane scrolls the table sideways (minimum width 640 px) instead of squeezing the columns.
- Three tests read the stylesheet and fail if the corner returns to a tiny percentage or the fixed
  layout is dropped.

## 1.2.5

### Fixes

- **Calendar estimates come from the note's words.** The estimate is the real word count — markdown and
  code blocks stripped — divided by your reading speed. File size is no longer consulted anywhere: two
  notes of identical size now get the time their text implies.
- **No ceiling.** A long note reports its own reading time; a 12,000-word note is an hour, because it is.
- **Still instant.** Each note is counted once and kept against its modification stamp, so the month
  draws from memory (2 ms for 400 scheduled notes) and recounts a note only after it changes. Day
  totals now equal the sum of the rows they are made of.
- Every estimate in the plugin — calendar, list totals, rows, pomodoro — reads from that one count.

## 1.2.3

### Fixes

- **Calendar estimates are minutes again, not days.** 1.2.1 stopped reading every note to draw a
  month and estimated from file size instead — but that size branch divided bytes by 38.5 and called
  the quotient *minutes*, i.e. about seven words a minute. Nine notes showed as 53 hours. The size
  estimate now converts bytes to words (5.5 bytes a word) and words to time at your reading speed,
  and a single note is capped at 20 minutes. Nine average notes read as about 15 minutes.
- The size estimate and the text estimate (what a note row shows) now agree within 10% for the same
  note, so a day's total matches the rows it is made of.

## 1.2.2

### Fixes

- **No more sync errors about `data.json.tmp`.** Every save wrote a temporary file and renamed it
  into place. That is atomic, and it is precisely what a sync client cannot cope with: Nextcloud,
  iCloud, Dropbox and OneDrive start uploading the file the moment it appears, lose it to the rename,
  and report an error — on every save. Saves now write `data.json.previous` (the state being
  replaced) and then `data.json`, both under names that stay put, so nothing a sync client sees ever
  appears and vanishes. The same change applies to the progress projection
  (`spaceforge/state/progress.json`). A temp file left by an older version is cleaned up on the next
  save.
- The safety net is unchanged in effect: if a write is interrupted, `data.json` may be partial but
  `data.json.previous` holds the last complete state, and the loader prefers it. Verified by
  truncating a 400-note vault's data file to 120 bytes: 400 schedules and 1600 reviews came back.

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
