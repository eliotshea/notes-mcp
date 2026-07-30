# Spike findings: automating Apple Notes from an MCP server

Environment: macOS 26.5.2 (build 25F84), Notes.app bundle `com.apple.Notes`,
library of 177 notes / 6 folders on an iCloud account.

## Summary

AppleScript cannot see or write checklists at all. Apple Notes' **App Intents**
API can, and it is reachable from the CLI by generating, signing, and installing
Shortcuts that wrap those intents. All of that is proven working end to end.

## 1. AppleScript is unusable for checklists

| Test | Result |
|---|---|
| Scan all 177 notes' `body` for `checklist｜checkbox｜checked` | **0 matches** |
| A note that renders as checkboxes in the UI | arrives as plain `<ul>/<li>` |
| Only non-ASCII byte in that note | `U+2019` (an apostrophe) |
| Write `<ul class="checklist"><li class="checked">` via `set body` | **stripped** — renders as plain bullets (E1) |

Checkbox and bullet lists are byte-identical over the scripting bridge, so an
agent reading through AppleScript cannot tell them apart. Worse, any `set body`
write silently converts existing checklists to permanent plain bullets.

**One useful signal survives:** Notes tags *ordinary* dash bullets as
`<ul class="Apple-dash-list">` while checklists come through as a bare `<ul>`.
So checklist regions are still *detectable* in AppleScript output, even though
their state is not.

AppleScript remains excellent for bulk metadata: all 177 notes' `id`+`name` in
**0.17s**, full `plaintext` in **0.66s**, via parallel-list access
(`n.notes.id()`, `n.notes.name()`) — roughly 40× faster than per-note loops.

## 2. Notes ships a full App Intents API

Catalog lives at
`/System/Applications/Notes.app/Contents/Resources/Metadata.appintents/extract.actionsdata`
(plain JSON).

Relevant actions (identifier → type):

| Identifier | Type | Purpose |
|---|---|---|
| `SetChecklistItemCheckedLinkActionv2` | `Notes.SetChecklistItemsCheckedIntent` | check / uncheck / **toggle** |
| `CreateChecklistItemLinkAction` | `Notes.CreateChecklistItemIntent` | append checklist item |
| `DeleteChecklistItemsLinkAction` | `Notes.DeleteChecklistItemsIntent` | delete checklist items |
| `CreateNoteFromMarkdownLinkAction` | `Notes.CreateNoteFromMarkdownIntent` | create note from Markdown |
| `AppendMarkdownToNoteLinkAction` | `Notes.AppendMarkdownToNoteIntent` | append Markdown |
| `CreateNoteLinkAction` | `Notes.CreateNoteIntent` | create note |

`ChecklistItemEntity` exposes **`Text`, `Checked` (bool), `Note`** — checked
state is both readable and writable here.

`SetChecklistItemsCheckedIntent` parameters:
- `changeOperation` — enum `CheckedChangeOperationType`, default `toggle`, **required**
- `entities` — `[ChecklistItemEntity]`, **required**
- `note` — `NoteEntity`, optional

## 3. Markdown round-trips checklists perfectly (E5)

`CreateNoteFromMarkdownLinkAction` converts `- [ ]` / `- [x]` into **real
checklist items with correct checked state** (visually confirmed). Apple does
the conversion, so the server never needs to generate Notes-flavored HTML.

## 4. The Shortcuts bridge works (E2)

`shortcuts` CLI: `run` / `list` / `view` / `sign`. No `add` or `delete`.

Proven loop: **generate plist → `shortcuts sign --mode anyone` → install → `shortcuts run`.**

Required `.shortcut` structure for an App Intents action:

```jsonc
{ "WFWorkflowActionIdentifier": "com.apple.Notes.<Identifier>",
  "WFWorkflowActionParameters": {
    "AppIntentDescriptor": {
      "TeamIdentifier": "0000000000",
      "BundleIdentifier": "com.apple.Notes",
      "Name": "Notes",
      "AppIntentIdentifier": "<Identifier>" },
    "UUID": "<uppercase uuid4>",
    /* ...parameters... */ } }
```

Entity-valued parameters use:

```jsonc
{ "identifier": "applenotes:note/<uuid>",
  "title":    { "key": "<display name>" },
  "subtitle": { "key": "<display name>" } }
```

Omitting `AppIntentDescriptor` makes Shortcuts fall back to an **interactive
picker**, which cannot run headless (fails with `Running was cancelled`).

### Entity identifier formats

- Note: `applenotes:note/<UUID>` — a UUID **unrelated** to AppleScript's
  `x-coredata://…/ICNote/p277`.
- Checklist item: `applenotes:checklistitem/<double-url-encoded x-coredata note id>/<item UUID>`

Substituting an x-coredata id into `applenotes:note/` was tested **raw,
single-encoded, and double-encoded — all three failed** (fell back to picker).
There is currently no known way to derive a note's App Intents UUID from
AppleScript.

## 5. Performance (E4)

| Operation | Cold | Warm |
|---|---|---|
| Trivial shortcut (`gettext`) | 3.6s → 1.9s | **0.15–0.17s** |
| Notes intent (create from Markdown) | 2.7s | **0.36–0.40s** |
| Find Notes (`filter.notes`) | 10.8s | — |

Warm dispatch is on par with AppleScript, so a pure App Intents design is viable
for writes. Bulk *reads* are still far cheaper through AppleScript.

## 6. Reading shortcuts back

Signed `.shortcut` files are **AEA1** (Apple Encrypted Archive), profile 0 =
`hkdf_sha256_hmac__none__ecdsa_p256` — signed, not encrypted. They can be
decoded without any private key:

1. Parse the header bplist at offset 12 (length is a `<u32` at offset 8) to get
   `SigningCertificateChain`.
2. Extract the leaf cert's public key (`openssl x509 -inform DER -pubkey -noout`).
3. `aea decrypt -i in.shortcut -o raw.bin -sign-pub pub.pem`
4. The result is an AppleArchive; the workflow plist starts at the first
   `bplist00` marker.

Implemented in `scripts/unshortcut.py`. This is how the formats above were
recovered, and it is the general technique for learning any action's encoding.

## 7. The Find action

Auto-generated entity queries are **per-app WF actions**, not per-entity, and
carry the entity type in `AppIntentIdentifier`:

```jsonc
{ "WFWorkflowActionIdentifier": "is.workflow.actions.filter.notes",
  "WFWorkflowActionParameters": {
    "AppIntentDescriptor": {
      "TeamIdentifier": "0000000000",
      "BundleIdentifier": "com.apple.Notes",
      "Name": "Notes",
      "AppIntentIdentifier": "NoteEntity",
      "ActionRequiresAppInstallation": true },
    "UUID": "<uuid>" } }
```

Reusing `filter.notes` with `AppIntentIdentifier: "ChecklistItemEntity"` fails
with *"an action could not be found"* — and **no Find action for checklist items
exists in the Shortcuts action library at all** (confirmed by inspection).
Checklist items therefore cannot be enumerated through App Intents.

Guessed identifiers are cheap to test: an unregistered action fails in **~0.3s**
with *"The shortcut could not be run because an action could not be found."*
Note that **import success is not a validity signal** — Shortcuts imports
anything; only runtime distinguishes.

## 8. Runtime parameters (the key to a shippable design)

Installing a shortcut **requires a user click**, so the server cannot generate
shortcuts per call. It must ship a fixed set, installed once, and pass arguments
at run time. That works:

- `shortcuts run <name> -i file` delivers the file's **text content** as
  Shortcut Input (verified: input `E5 markdown fidelity` echoed back exactly).
- `shortcuts run <name> -o out --output-type public.plain-text` returns results.
- The workflow must set `WFWorkflowHasShortcutInputVariables: True`.

Shortcut Input is referenced inside any text field as:

```jsonc
{"Value": {"string": "￼",
           "attachmentsByRange": {"{0, 1}": {"Type": "ExtensionInput"}}},
 "WFSerializationType": "WFTextTokenString"}
```

**Critical gotcha:** the Shortcuts editor auto-wires the first action's
`WFContentItemInputParameter` to `ExtensionInput`, which makes a Find action
filter *the input string* instead of querying Notes. Generated shortcuts must
**omit `WFContentItemInputParameter` entirely**. This single key was the
difference between failure and success.

Action outputs chain via:

```jsonc
{"Value": {"OutputUUID": "<uuid of producing action>",
           "Type": "ActionOutput", "OutputName": "Note"},
 "WFSerializationType": "WFTextTokenAttachment"}
```

### Verified end-to-end pattern

Find a note **by name supplied at run time**, then act on it — no picker, no
UUID mapping, no Full Disk Access, ~5s cold:

```
[0] is.workflow.actions.filter.notes
      AppIntentDescriptor{AppIntentIdentifier: "NoteEntity", ...}
      WFContentItemLimitEnabled: true, WFContentItemLimitNumber: 1
      WFContentItemFilter: Name is <ShortcutInput token>
      (NO WFContentItemInputParameter)
[1] com.apple.Notes.AppendMarkdownToNoteLinkAction
      entity: ActionOutput of [0]
      markdownText: "- [ ] ..."
```

## 9. Reading a note's body — **including checklist state**

Entity properties are not separate actions; they are **variable
aggrandizements**. Embedding a previous action's output in a text field with a
`WFPropertyVariableAggrandizement` yields that property:

```jsonc
{"Value": {"string": "￼",
           "attachmentsByRange": {"{0, 1}": {
             "OutputUUID": "<find action uuid>",
             "Type": "ActionOutput",
             "OutputName": "Note",
             "Aggrandizements": [
               {"Type": "WFPropertyVariableAggrandizement",
                "PropertyName": "Body"}]}}},
 "WFSerializationType": "WFTextTokenString"}
```

Piping that into `is.workflow.actions.gettext` and returning it via
`shortcuts run -o out --output-type public.plain-text` produces the **full note
body with checklist state preserved**:

```
E5 markdown fidelity

\t◦\tunchecked-item-one
\t✓\tchecked-item-two
\t◦\tunchecked-item-three

Plain bold and italic text.

\t⁃\tordinary bullet
```

Each list line is `\t<marker>\t<text>`:

| Marker | Codepoint | Meaning |
|---|---|---|
| `◦` | U+25E6 WHITE BULLET | unchecked checklist item |
| `✓` | U+2713 CHECK MARK | checked checklist item |
| `⁃` | U+2043 HYPHEN BULLET | ordinary bullet, not a checklist |

**This removes the need for Full Disk Access and SQLite/protobuf parsing
entirely.** Checked state is readable through the supported API.

Note the plain-text rendering drops inline formatting (`**bold**` arrives as
`bold`), so it is a faithful source for *structure and state*, not for styling.
Use AppleScript's `body` when raw HTML is wanted.

## 9b. Passing multiple arguments

`shortcuts run` accepts a single input, but `is.workflow.actions.getvalueforkey`
**coerces JSON text to a dictionary directly** — no `detect.dictionary` step
(adding one causes `Foundation._GenericObjCError`):

```jsonc
{"WFWorkflowActionIdentifier": "is.workflow.actions.getvalueforkey",
 "WFWorkflowActionParameters": {
   "WFInput": {"Value": {"Type": "ExtensionInput"},
               "WFSerializationType": "WFTextTokenAttachment"},
   "WFDictionaryKey": "note",
   "WFGetDictionaryValueType": "Value",
   "UUID": "<uuid>"}}
```

So the bridge is a clean `{json in} -> {text out}` interface. Each extracted
value is referenced downstream as an `ActionOutput` named `Dictionary Value`.

## 10. Architectural consequence

Bridge shortcuts are **self-contained operations parameterized by plain
strings**, resolving entities internally via Find rather than accepting entity
IDs from outside. This sidesteps identifier mapping entirely.

Full round trip, with no Full Disk Access:

```
read:   Find Notes(Name = input) -> Body property -> stdout
        parse \t<marker>\t<text> into [{text, checked}]
write:  rebuild the note from the desired item states
```

Per-item toggling is still not directly available (no checklist-item Find
action), so state changes are applied by **rebuild**:

```
1. Shortcut: read Body, parse items + state
2. AppleScript: set body to the title line only
3. App Intents: AppendMarkdownToNote with "- [ ] " / "- [x] " per item
```

Markdown append recreates genuine checklist items with correct state (§3), and
the note keeps its identity, folder, and creation date.

## 11. Nesting is split across the two sources

Neither source describes a note's lists completely:

| | checked state | nesting depth |
|---|---|---|
| App Intents `Body` | **yes** | **no** — every item gets exactly one tab |
| AppleScript `body` HTML | no | **yes** — nested `<ul>` elements |

Real output for a three-level list, showing the flattening:

```
◦\tBarbell squat        <- depth 0
\t◦\tSet 1: 135         <- depth 1   all identical
\t◦\tdeep nested        <- depth 2
```

So structure is taken from the HTML and state from the bridge, zipped by
document position (both enumerate items in the same order). Item text is
compared as a guard; on any mismatch the depths are discarded and the note is
reported as `nestingResolved: false` rather than rebuilt flat.

Notes writes nested lists as **siblings** of the `<li>` they belong under, not
as children:

```html
<ul>
  <li>parent</li>
  <ul><li>child</li></ul>   <!-- sibling, not nested inside the <li> -->
</ul>
```

On the way back, Notes' Markdown importer creates one nesting level per **four
spaces** of indent, and this round-trips exactly: rebuilding a two-level note
reproduces byte-identical HTML.

## Remaining limitations

1. No checklist-item enumeration action → state changes go through rebuild
   rather than surgical per-item toggles.
2. Rebuild reconstructs from plain text, so inline styling, attachments, and
   tables in the same note are not preserved. Best suited to checklist-centric
   notes; the server should refuse or warn when a note contains attachments.
3. Shortcut installation requires one user confirmation per shortcut (setup only).
4. Notes are addressed **by name**; duplicate names resolve to the first match.

## Operational notes

- Installing a shortcut **requires user confirmation** (no CLI install path).
  Batch installs queue behind prompts; results are not observable until accepted.
- Running a shortcut that edits a note prompts for permission the first time.
- The `shortcuts` CLI cannot delete; cleanup of test shortcuts is manual.
