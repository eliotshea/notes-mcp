# notes-mcp

An MCP server for Apple Notes that can **read and write checklist state** — so an
agent can do things like *"reset my workout checklist"* or *"tell me what I didn't
finish today"*.

That sounds simple. It isn't: **AppleScript cannot see checklists at all.** A note
full of checkboxes arrives over the scripting bridge as plain bullets with no state,
and writing back through AppleScript silently converts every checklist into
permanent plain bullets. Most Apple Notes automations quietly have this bug.

This server routes around it using Notes' **App Intents** API, reached through
generated Shortcuts. Full reverse-engineering notes are in
[`docs/spike-findings.md`](docs/spike-findings.md).

## Requirements

- macOS 13 or later (developed on macOS 26)
- Node.js 20+
- Permission for your terminal to control Notes (macOS prompts on first use)

No Full Disk Access, no Accessibility, no SQLite parsing.

## Install

```bash
git clone https://github.com/eliotshea/notes-mcp.git
cd notes-mcp
npm install
npm run build
npm run setup
```

`setup` generates, signs, and installs three helper shortcuts, then verifies the
whole pipeline end to end by creating a scratch note, reading its checklist state
back, clearing it, and deleting it.

> **You will get three "Add Shortcut" prompts.** Approve each one. macOS has no
> command-line path to install a shortcut, so this step cannot be automated.
> It only happens once.

Then register the server with your MCP client:

```json
{
  "mcpServers": {
    "notes": { "command": "node", "args": ["/absolute/path/to/notes-mcp/dist/index.js"] }
  }
}
```

Verify at any time with `npm run setup -- --check`, or by calling the
`check_setup` tool.

## Tools

**Discovery** — fast, AppleScript-backed, never touches note content.

| Tool | Purpose |
|---|---|
| `list_notes` | All notes with folder and timestamps |
| `list_folders` | Folders with note counts |
| `search_notes` | Full-text search across titles and bodies |

**Content** — routed through App Intents so checklist state is accurate.

| Tool | Purpose |
|---|---|
| `read_note` | Full content, with checklist state |
| `read_checklist` | Just the checklist items: `[{index, text, checked}]` |
| `create_note` | Create from Markdown |
| `append_to_note` | Append Markdown, leaving existing content alone |
| `replace_note_content` | Replace the body, keeping the note's identity |

**Checklists**

| Tool | Purpose |
|---|---|
| `clear_checklist` | Uncheck everything, keeping the items |
| `check_all_items` | Check everything |
| `set_checklist_items` | Check/uncheck/toggle items by index or text match |

**Organization** — `create_folder`, `move_note`, `delete_note` (needs
`confirm: true`; goes to Recently Deleted and is recoverable).

**Health** — `check_setup`.

## Markdown

Notes does the Markdown conversion itself, so it round-trips cleanly:

```markdown
- [ ] Barbell squat     →  ○ Barbell squat     (unchecked checklist item)
- [x] Hip thrust        →  ◉ Hip thrust        (checked checklist item)
- Warm up first         →  • Warm up first     (ordinary bullet)
```

Reading a note back yields tab-delimited markers — `◦` unchecked, `✓` checked,
`⁃` ordinary bullet — which the server parses into structured items for you.

## Example

```
> Reset my Leg day checklist for tomorrow

  read_checklist  { note: "Leg day" }
    → [{0,"Barbell squat",true}, {1,"Hip thrust",true}, {2,"Hamstring curl",false}]
  clear_checklist { note: "Leg day" }
    → 2 items changed, all now unchecked
```

## How it works

```
discovery / metadata ──→ AppleScript (JXA)      ~0.17s for 177 notes
content + checklists ──→ Shortcuts → App Intents ~0.4s warm
```

AppleScript is used only where it is fast and truthful — listing, search,
folders, moving, deleting, and clearing a body. Anything involving checklist
structure goes through the bridge, because AppleScript's view of a checklist is
actively misleading rather than merely incomplete.

Three shortcuts are installed: `notes-mcp-read-body`,
`notes-mcp-append-markdown`, and `notes-mcp-create-note`. They take JSON on
stdin and return text, so all arguments are passed at run time and nothing is
regenerated per call.

Changing checked state works by **rebuild**: read the note, clear its body, and
re-append every line as Markdown with the desired state. There is no per-item
toggle action in Notes' API, so this is the only route. The note keeps its id,
folder, and creation date.

## Limitations

- **Notes are addressed by name**, so names must be unique. Duplicates raise an
  error rather than guessing.
- **Rebuild is lossy for rich content.** Images, tables, and inline styling in the
  same note are not reconstructed. Tools that rebuild refuse when they detect
  attachments or tables; pass `force: true` to override.
- **Password-protected notes** are unreadable.
- **Setup needs manual clicks** — three, once.
- **Bridge dispatch is ~0.4s warm**, a few seconds cold. Discovery tools are much
  faster because they skip the bridge.

## Development

```bash
npm run build      # compile
npm test           # build + run the parser test suite
npm run setup -- --check   # verify the installation
```

The parsing and rendering logic in `src/checklist.ts` is pure and covered by
tests using fixtures captured verbatim from real Notes output.

## License

MIT
