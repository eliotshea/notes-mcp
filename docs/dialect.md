# The edit dialect

The text format `read_note` emits and `write_note` accepts. It is Markdown
wherever Markdown suffices, plus a small closed set of extensions for what
Markdown cannot express.

Editing a note is: read it, change the text, write it back.

**The dialect never reaches Notes.** It is parsed into a write plan, and Notes'
Markdown importer only ever sees plain Markdown. This matters because the
importer escapes anything it does not understand (`spike-findings.md` §12), so a
literal `{color=…}` handed to it would land in the note as visible text.

## Block syntax

| Syntax | Meaning | Writable |
|---|---|---|
| `- [ ] item` | unchecked checklist item | yes |
| `- [x] item` | checked checklist item | yes |
| `- item` | dash bullet | yes |
| `1. item` | ordered item | yes |
| four spaces | one nesting level | yes |
| `#` `##` `###` | heading levels 1–3 | yes |
| `####`+ | clamped to `###` — Notes has three levels | yes |
| blank line | paragraph break | yes |
| anything else | body text | yes |

Indentation is **four spaces per level** on output. On input, two spaces or a
tab are also accepted as one level, so hand-written text does the obvious thing.

A prose line that would otherwise read as structure is escaped with a
backslash: `\1. not a list`. This is not cosmetic — an unescaped `1. first`
once corrupted every numbered-list note on rebuild (`spike-findings.md` §12).

## Inline syntax

| Syntax | Meaning | Writable |
|---|---|---|
| `**bold**` | bold | yes |
| `*italic*` | italic | yes |
| `~~strike~~` | strikethrough | yes |
| `` `mono` `` | monostyled | yes |
| `[text]{color=#FF0505}` | text colour | yes, HTML phase only |
| `[text]{u}` | underline | yes, HTML phase only |
| `[text]{link=https://…}` | link | **no** — read-only |

Colour and underline are writable, but only through the AppleScript HTML write,
which cannot produce checkboxes. That is the one structural constraint in the
whole format:

> A note can carry both colour/underline **and** checklist items only when every
> coloured or underlined line appears **before** every checklist item.

Interleaving them is unreachable and `write_note` refuses, naming the line. Pass
`on_conflict` to choose which side to sacrifice.

## Not in the dialect

**Highlighting** has no syntax, deliberately. It is invisible to every surface
Notes exposes — AppleScript HTML, the App Intents body, RTF, HTML, and even a
rendered PDF (`spike-findings.md` §14) — so it can be neither detected nor
written. A syntax for it would be a promise breakable in both directions.
Instead, every rewrite reports it in `lost`.

**Links and block quotes** are readable but not writable. A `<blockquote>`
collapses to a plain paragraph and an `<a href>` is stripped to a bare
underline, through *both* write paths. Links round-trip as a read-only token so
their target is at least visible; block quotes read as ordinary text.

**Images and tables** cannot be reconstructed at all. `read_note` reports them
in a `contains` field, and any edit that would rewrite the note is refused
rather than silently destroying them.

## What a write costs

Every mutating tool returns the same three fields:

```json
{
  "rewrote": false,
  "preserved": ["all existing content"],
  "lost": []
}
```

`rewrote: false` means the note's existing content was not touched — appends
are always in this class, which is why appending to a note holding an image is
allowed while editing one is not. `rewrote: true` means the body was replaced
from parsed structure, and `lost` names what could not survive that.

`dry_run: true` returns exactly this report without writing.

## Round-trip guarantee

`parseDialect(renderDialect(x))` is `x` for every construct in the tables above.
This is enforced by property tests in `test/dialect.test.js`, which are the
normative statement of the format — if the tables and the tests ever disagree,
the tests are right.

The one thing that does not survive is trailing whitespace on a line: Notes
trims it on write, so `"Dishes "` comes back `"Dishes"`.
