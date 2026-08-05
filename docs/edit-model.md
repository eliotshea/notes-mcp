# Plan: one editable text format, and a writer that figures out the rest

## Goal

The caller reads a note as text, edits the text, writes it back. It never learns
what a rebuild is, never chooses between `append_to_note` and
`replace_note_content`, and never passes `force` to get ordinary work done.

Two pieces make that possible:

1. **A dialect** — one text format that carries everything both read sources can
   see, including what plain Markdown cannot express.
2. **A write planner** — a rule set that compiles a target document into a
   sequence of the primitives we actually have, choosing the least destructive
   sequence available and reporting honestly when none is lossless.

This absorbs all seven refinements from the earlier review; §7 maps each one.

---

> **Status: Parts 1–6 assume the current two-primitive world. That assumption is
> now in doubt — see Part 8, which may remove the need for most of this.**

## Part 1 — What the primitives can actually do

Re-verified on macOS 15.5 during planning. Two rows are **new** and one
**corrects** `spike-findings.md` §12.

| Feature | AppleScript `setBodyHtml` | Bridge `appendMarkdown` |
|---|---|---|
| checkboxes + state | **destroys** | **yes** (only source) |
| nesting depth | yes | yes (4 spaces/level) |
| headings h1–h3 | yes | yes |
| bold / italic / strike | yes | yes |
| monostyled | yes | yes (fence) |
| ordered / dash lists | yes | yes |
| **text colour** | **yes — round-trips** | no |
| **underline** | **yes — round-trips** | no |
| links (`<a href>`) | **no — href stripped, leaves `<u>`** | no |
| block quotes | **no — collapses to `<div>`** | no |
| highlight | undetectable | undetectable |
| images / tables | not reconstructable | not reconstructable |

### The correction

`spike-findings.md` §12 concludes that *"underline, colour, highlight and Caption
are unreachable in any note containing a checklist."* That is true of a
**single-phase rebuild** (clear + append), which is the only write shape the
server currently performs. It is **not** true of the primitives in general.

Verified end-to-end on a scratch note:

```
1. setBodyHtml(title + '<font color="#FF0505">RED</font> <u>UNDER</u> …')
2. appendMarkdown('- [x] checked\n- [ ] unchecked\n    - [ ] nested')
3. read back
   → HTML still holds <font color="#FF0505"> and <u>UNDER</u>
   → bridge reports 3 real checklist items, states correct, nesting correct
```

`appendMarkdown` is **additive**: it does not rewrite what sits above it, so
everything written in phase 1 survives. Colour and underline therefore *can*
coexist with checkboxes — subject to an ordering constraint (Rule 3).

### The one structural constraint

`setBodyHtml` replaces the whole body and must therefore come **first**;
`appendMarkdown` only ever adds at the end. A document can contain **at most one
HTML→Markdown transition**. Formally, a note is losslessly writable iff

> every block needing an HTML-only feature (colour, underline) appears before
> every checklist block.

Interleaving them — coloured text *below* a checklist — is unreachable, and no
ordering of these primitives fixes it. That is the honest boundary.

### Permanently lossy, either path

Links, block quotes, highlighting, images and tables cannot be written by
*either* primitive. They are readable (except highlight) but not reproducible,
so the dialect must represent them as **opaque, non-authorable tokens** and the
planner must protect them by refusing to rewrite regions containing them.

---

## Part 2 — The dialect

Markdown with a small, closed set of extensions. Design rules:

- **Standard Markdown wherever it suffices** — no invented syntax for anything
  `#`, `**`, `- [x]` or four-space indent already covers.
- **Pandoc bracketed-span shape** for inline extensions, so it reads like a
  known standard rather than a private code.
- **The dialect never reaches Notes.** It is parsed server-side into a write
  plan; the Markdown importer only ever sees plain Markdown. This matters —
  §12 established the importer escapes anything it doesn't understand, so a
  literal `{color=…}` would otherwise land in the note as text.
- **Read and write use the same grammar.** What `read_note` emits is exactly
  what `write_note` accepts.

### Inline

| Syntax | Meaning | Writable |
|---|---|---|
| `**b**` `*i*` `~~s~~` `` `m` `` | bold, italic, strike, monostyled | yes |
| `[text]{color=#FF0505}` | text colour | yes (HTML phase) |
| `[text]{u}` | underline | yes (HTML phase) |
| `[text]{link=https://…}` | link | **no** — read-only token |

### Block

| Syntax | Meaning | Writable |
|---|---|---|
| `#` `##` `###` | heading levels (clamped to 3) | yes |
| `- [ ]` / `- [x]` | checklist item + state | yes |
| `-` / `1.` | dash list / ordered list | yes |
| four spaces | one nesting level | yes |
| `> quoted` | block quote | **no** — read-only token |
| `::: caption` … `:::` | Caption paragraph style | **no** — read-only token |

### Opaque objects

```
[[image]]           an attachment that cannot be recreated
[[table 3x4]]       a table that cannot be recreated
```

These are **fences, not content**. A write whose target still contains a token
in its original position is a promise to preserve it — which the planner honours
by refusing any plan that would rewrite that region (Rule 6). Deleting the token
from the text is the explicit, deliberate way to say "yes, drop it."

### What is deliberately absent

Highlighting gets no syntax. It is invisible to every surface
(`spike-findings.md` §14), so a syntax for it would be a promise we cannot keep
in either direction. It stays a one-line note in the response `lost` array.

---

## Part 3 — The write planner

Input: target document (parsed dialect) + current note state.
Output: an ordered list of primitive calls, plus `{rewrote, preserved, lost}`.

Let `R` = blocks needing an HTML-only feature (colour, underline), `C` =
checklist blocks, `O` = blocks holding opaque tokens.

| Rule | Condition | Plan | Cost |
|---|---|---|---|
| 1 · No-op | target ≡ current | none | free |
| 2 · Pure append | target = current + new suffix, suffix ∩ R = ∅ | `appendMarkdown(suffix)` | **non-destructive** |
| 3 · Markdown-only | R = ∅ | `clearBody` + `appendMarkdown(all)` | rebuild |
| 4 · HTML-only | C = ∅ | `setBodyHtml(title + html)` | rewrite, **keeps colour + underline** |
| 5 · Split | R ≠ ∅, C ≠ ∅, last(R) < first(C) | `setBodyHtml(prefix)` then `appendMarkdown(suffix)` | rewrite, **lossless** |
| 6 · Guarded | O ≠ ∅ and plan would rewrite those blocks | refuse | — |
| 7 · Conflict | R ≠ ∅, C ≠ ∅, interleaved | refuse, name the blocks | — |

Rules 2, 4 and 5 are all new capability, not reorganisation:

- **Rule 2** means adding an item to a note containing an image no longer
  refuses. Today every checked-state change is a rebuild; most edits in practice
  are pure appends and need not be.
- **Rule 4** means a note with coloured text and no checkboxes becomes fully
  editable. Today it is refused outright.
- **Rule 5** is the two-phase write verified above.

Rules 6 and 7 are the only refusals, and both are *specific*: they name the
offending block and line rather than reporting a generic rich-content failure.

### Response shape

Every mutating tool returns the same envelope, which is what makes the
rebuild/append distinction invisible without hiding its consequences:

```json
{
  "note": { "...": "meta" },
  "rewrote": true,
  "preserved": ["checklist state", "nesting", "bold", "colour"],
  "lost": ["highlighting (undetectable)"]
}
```

`dry_run: true` returns exactly this envelope with no writes, so a caller can
check the cost of an edit before committing to it.

---

## Part 4 — Tool surface

**Reading**

- `read_note(note, format?)` — `format: "dialect" | "plain"`, default dialect.
  Emits the exact text `write_note` accepts. The `◦ / ✓ / ⁃` string demotes to
  `format: "plain"`, documented as a debug view.
- `read_checklist(note)` — unchanged.

**Writing** — text in, text out, no mode selection

- `write_note(note, content, on_conflict?, dry_run?)` — replaces
  `replace_note_content`. Planner picks the sequence.
- `append_to_note(note, content)` — kept; it is Rule 2 stated directly, and
  saying "append" is clearer than making the planner infer a suffix.
- `create_note(title, content, folder?)` — dialect-aware.

**Checklists** — keep their own tools, per your call; each hides its own rebuild

- `set_checklist_items(note, {indices|text}, {checked?, depth?, text?})` —
  gains `depth` and `text`, which is refinement 2. `depth` accepts absolute
  (`1`) or relative (`"+1"` / `"-1"`).
- `clear_checklist(note)` / `check_all_items(note)` — kept as named shortcuts.

**Unchanged**: `list_notes`, `list_folders`, `search_notes`, `create_folder`,
`move_note`, `delete_note`, `check_setup`.

`force` disappears from every signature. Where a caller genuinely must accept
loss, it is `on_conflict: "keep_checklists" | "keep_formatting" | "accept_loss"`
— which says what will happen rather than daring the caller to override.

---

## Part 5 — Work breakdown

**Phase 0 · Fixes and spikes** *(small, independent, ship first)*

- `folderId` staleness in `notes.ts:233-236` and `index.ts:204-208` — both
  spread pre-move metadata and patch only `folder`. Re-resolve after the move.
- Spike: does `setBodyHtml` preserve an `<img>`/`<table>` if the original HTML
  subtree is spliced back **verbatim** rather than regenerated? If yes, Rule 6
  softens from "refuse" to "preserve untouched regions" and images stop being a
  hard wall. Needs a note with a real attachment.
- Spike: which Markdown produces Notes' *Bulleted* list vs *Dashed*? `-` gives
  dashed; the round-bullet style has no known input.

**Phase 1 · Dialect** — `src/dialect.ts`

- `renderDialect(lines): string` — extend `renderMarkdown` (`checklist.ts:180`),
  which already emits most of the grammar.
- `parseDialect(text): Block[]` — the new half.
- Property test: `parseDialect(renderDialect(x)) ≡ x` over generated documents
  covering every row of the Part 2 tables. This is the spec.
- Extend `htmllist.ts` to surface colour, underline, link and quote spans, which
  `describeInlineLoss` already detects but discards.

**Phase 2 · Planner** — `src/plan.ts`

- `planWrite(current, target): {ops, rewrote, preserved, lost}` — pure function
  over parsed documents, no I/O, so the whole rule table is unit-testable
  without touching Notes.
- Executor applies `ops`, keeping the existing capture-and-restore failure
  handling from `rebuild` (`notes.ts:244`).

**Phase 3 · Surface** — `src/index.ts`, `src/notes.ts`

- New signatures, response envelope, `dry_run`.
- Rewrite `AmbiguousNoteError` and friends to drop bridge mechanics; keep the
  actionable half ("pass a note id").
- `HIGHLIGHT_WARNING` shrinks to a `lost` entry; the archaeology moves to the
  README.

**Phase 4 · Docs**

- `docs/dialect.md` — the grammar, normative.
- Update `spike-findings.md` §12 with the two-phase result and the link/quote
  findings.

Phases 1 and 2 are independently testable without Notes; the integration risk
sits almost entirely in Phase 3.

---

## Part 6 — Verification

- **Unit**: dialect round-trip property tests; planner rule table with
  hand-built documents, one case per rule, including both refusals.
- **Integration**, against real Notes:
  - append to a note containing an image → Rule 2, `rewrote: false`, image intact
  - edit a coloured note with no checkboxes → Rule 4, colour intact
  - the two-phase note from Part 1 → Rule 5, colour + underline + checkboxes
  - coloured text *below* a checklist → Rule 7, refuses, names the block
  - indent one item via `set_checklist_items(depth: "+1")` → other items' state
    unchanged
- **Regression**: the existing 32-item fixture from `spike-findings.md` §12 must
  still rebuild byte-identically.

## Part 7 — Refinement mapping

| # | Refinement | Lands in |
|---|---|---|
| 1 | Expose the Markdown round-trip | Phase 1 — dialect is the round-trip, widened |
| 2 | Item-level structure ops | Phase 3 — `set_checklist_items` gains `depth`/`text` |
| 3 | Make rewrites visible in responses | Phase 2 — envelope + `dry_run` |
| 4 | Trim the highlight warning | Phase 3 — becomes a `lost` entry |
| 5 | Stop leaking bridge mechanics in errors | Phase 3 — error rewrite |
| 6 | Specify the input dialect | Phase 4 — `docs/dialect.md`, normative |
| 7 | Stale `folderId` bug | Phase 0 |

---

## Part 8 — The rebuild may not be necessary at all

Everything above is built on `spike-findings.md` §10: *"Per-item toggling is
still not directly available (no checklist-item Find action), so state changes
are applied by rebuild."* Every loss in this document descends from that one
sentence.

**That premise appears to be false on macOS 15.5.** Enumerating Notes' App
Intents metadata directly:

```
/System/Applications/Notes.app/Contents/Resources/Metadata.appintents/extract.actionsdata
```

turns up 45 `LinkAction` intents, of which the bridge uses exactly two
(`AppendMarkdownToNoteLinkAction`, `CreateNoteFromMarkdownLinkAction`). Among
the unused:

| Intent | Would replace |
|---|---|
| `SetChecklistItemsCheckedIntent` | **the entire rebuild path** |
| `CreateChecklistItemLinkAction` | rebuild-to-add-an-item |
| `DeleteChecklistItemsLinkAction` | rebuild-to-remove-an-item |
| `AppendToNoteLinkAction` | Markdown-only append — may carry rich text |
| `ApplyFormattingLinkAction` | colour/underline writes |
| `SetParagraphStyleLinkAction` | Caption, Subheading, Monostyled |
| `CreateTableLinkAction`, `AddFileAttachmentLinkAction` | table/attachment loss |

And decisively, `ChecklistItemEntity` exists as a first-class entity **with a
query**: `VisibleChecklistItemsQuery`. §10's "no checklist-item Find action" is
exactly what that query would provide.

If `SetChecklistItemsCheckedIntent` is drivable from a Shortcut headlessly, then
checking an item stops being a whole-note rewrite. Nothing is cleared, nothing
is re-appended, and therefore **nothing is lost** — colour, underline, links,
quotes, highlighting, images and tables all survive because they are never
touched. Rules 3–7, the conflict refusals, the `on_conflict` parameter and most
of the `lost` array all become dead code.

### Spike result — run, and the answer is split

`src/spike.ts` built and ran four candidate shortcuts. The outcome divides
cleanly between adding an item and changing its state.

**`CreateChecklistItemLinkAction` works headlessly.** It takes only `name` and
`noteEntity`, so the proven `filter.notes` action supplies everything it needs.
Verified: an item was added to a seeded note and read back through the bridge,
with no clear, no re-append, and nothing rewritten. **Adding a checklist item
does not require a rebuild.**

**`SetChecklistItemCheckedLinkActionv2` is not reachable headlessly.** Its
`entities` parameter needs `ChecklistItemEntity` values, and there is no way to
produce them without the UI:

- Two Find-action identifiers were tried; both failed with *"an action could not
  be found"*, i.e. no such action is registered.
- Passing `entities` as plain text, with and without a `note` to scope it, made
  Shortcuts fall back to **an interactive "choose a checklist item" picker** —
  the documented dead end from `wfbuild.ts`'s header.

The query metadata explains why. `VisibleChecklistItemsQuery` has
`capabilities: 70`; `VisibleNotesQuery`, which backs the working note filter,
has `78`. The missing bit is set on exactly the entities that support property
filtering — Note, Attachment, Table — and clear on those that do not:
ChecklistItem, Account, Folder, Tag. **`ChecklistItemEntity` cannot be
property-queried, so no filter action exists to reference and no string
resolution is offered.** Only an interactive picker can produce one.

### Consequence

`spike-findings.md` §10 **stands for checked state**: changing it still requires
a rebuild, and Parts 1–7 of this document remain the plan.

§10 is **wrong about adding items**. It generalises "no per-item toggling" into
"state changes go through rebuild", and `CreateChecklistItemLinkAction` shows
the append case never needed one. Fold this into Rule 2: appending checklist
items becomes a genuine per-item intent rather than a Markdown append, which
also removes the list-merging quirk where an appended item joins a preceding
dash list.

### The setter does work — but only on items it just created

Tested: feeding `CreateChecklistItemLinkAction`'s output straight into
`SetChecklistItemCheckedLinkActionv2` appends an **already-checked** item, with
no rebuild and no picker. So the setter is not UI-bound. The blocker was never
the intent; it is obtaining a `ChecklistItemEntity` for an item that already
exists.

And that is now closed. Exactly two actions in the whole bundle output a
`ChecklistItemEntity`:

| Action | Produces |
|---|---|
| `CreateChecklistItemLinkAction` | a **newly created** item |
| `SetChecklistItemCheckedLinkActionv2` | the items it just set — circular |

There is no read path. Combined with the query having no property-filter
capability and text resolution falling back to a picker, **every route to a
pre-existing checklist item is exhausted.** `spike-findings.md` §10 is now
*proven* for checked state rather than merely assumed, and the rebuild stays.

### What this actually buys — less than it first appears

Appending a checked item was *already* free: `appendMarkdown` accepts `- [x]`
and does not rewrite what sits above it. So the intent path adds no
rebuild-avoidance for appends.

Its real advantage is **escaping**. Markdown append re-parses item text, so an
item reading `1. buy milk`, `# groceries` or `**urgent**` is reinterpreted as a
numbered list, a heading or bold. §12 already records this class of bug biting
once: `escapeMarkdown` turned `1. first` into `\1. first` and corrupted every
numbered-list note on rebuild. `CreateChecklistItemLinkAction` takes the text as
a **parameter**, never as markup, which removes the entire class.

So: use the intent for appending items — for correctness, not for performance —
and keep the rebuild for changing state on items that already exist.
