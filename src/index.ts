#!/usr/bin/env node
/**
 * MCP server for Apple Notes.
 *
 * Transport is stdio, so nothing may be written to stdout except protocol
 * traffic — diagnostics go to stderr.
 *
 * The tool surface deliberately hides how Notes is written. A caller reads a
 * note as dialect text, edits the text, and writes it back; whether that costs
 * a rewrite, and which of the two write primitives run, is decided by the
 * planner. What a write *costs* is still visible, in the `rewrote`, `preserved`
 * and `lost` fields every mutating tool returns. See docs/edit-model.md.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import * as as from "./applescript.js";
import * as notes from "./notes.js";
import { missingShortcuts } from "./shortcuts.js";
import { OPTIONAL_SHORTCUTS } from "./wfbuild.js";
import { listInstalled } from "./shortcuts.js";

const server = new McpServer({ name: "notes-mcp", version: "0.2.0" });

type ToolResult = { content: Array<{ type: "text"; text: string }>; isError?: boolean };

const ok = (data: unknown): ToolResult => ({
  content: [{ type: "text", text: typeof data === "string" ? data : JSON.stringify(data, null, 2) }],
});

const fail = (e: unknown): ToolResult => ({
  content: [{ type: "text", text: e instanceof Error ? e.message : String(e) }],
  isError: true,
});

const wrap =
  <A>(fn: (args: A) => Promise<unknown>) =>
  async (args: A): Promise<ToolResult> => {
    try {
      return ok(await fn(args));
    } catch (e) {
      return fail(e);
    }
  };

const noteRef = z
  .string()
  .describe("Note name (exact) or note id. Names must be unique.");

const onConflict = z
  .enum(["refuse", "keep-checklists", "keep-formatting"])
  .optional()
  .describe(
    "What to do when colour or underline sits below a checklist item, which " +
      "no write can express. Default refuses and names the line.",
  );

// ---------------------------------------------------------------- discovery

server.tool(
  "list_notes",
  "List all notes with their folder and timestamps. Fast; does not read note content. " +
    "Recently Deleted is excluded by default.",
  {
    folder: z.string().optional().describe("Only notes in this folder"),
    include_deleted: z.boolean().optional().describe("Include Recently Deleted"),
  },
  wrap(async ({ folder, include_deleted }) => {
    const all = await as.listNotes({ includeDeleted: include_deleted });
    return folder ? all.filter((n) => n.folder === folder) : all;
  }),
);

server.tool(
  "list_folders",
  "List all Notes folders with note counts. Recently Deleted is excluded by default.",
  { include_deleted: z.boolean().optional().describe("Include Recently Deleted") },
  wrap(({ include_deleted }) => as.listFolders({ includeDeleted: include_deleted })),
);

server.tool(
  "search_notes",
  "Full-text search across note titles and body text. Returns metadata, not content.",
  {
    query: z.string().describe("Text to search for (case-insensitive)"),
    titles_only: z.boolean().optional().describe("Search titles only (faster)"),
    limit: z.number().int().positive().max(200).optional(),
  },
  wrap(({ query, titles_only, limit }) =>
    as.searchNotes(query, { includeBody: !titles_only, limit }),
  ),
);

// ------------------------------------------------------------------ reading

server.tool(
  "read_note",
  "Read a note as editable text. The default 'dialect' format is exactly what " +
    "write_note accepts back, so editing a note is read -> change the text -> write. " +
    "It is Markdown plus [text]{color=#RRGGBB}, [text]{u} and [text]{link=...} for " +
    "what Markdown cannot express. Use format 'plain' for the raw ◦/✓/⁃ marker view.",
  {
    note: noteRef,
    format: z
      .enum(["dialect", "plain"])
      .optional()
      .describe("'dialect' (default, editable) or 'plain' (debug view)"),
  },
  wrap(async ({ note, format }) => {
    const c = await notes.readNote(note);
    return {
      note: c.note,
      ...(format === "plain" ? { content: c.raw } : { content: c.dialect }),
      checklist: c.checklist,
      ...(c.opaque.length ? { contains: c.opaque } : {}),
      ...(c.nestingResolved
        ? {}
        : {
            warning:
              "List nesting could not be recovered, so every item is reported at " +
              "depth 0 and this note cannot be rewritten without flattening it.",
          }),
    };
  }),
);

server.tool(
  "read_checklist",
  "Read just the checklist items of a note, with checked state, indices, and " +
    "nesting depth (0 = top level).",
  { note: noteRef },
  wrap(({ note }) => notes.readChecklist(note)),
);

// ------------------------------------------------------------------ writing

server.tool(
  "create_note",
  "Create a note from dialect text (see read_note). '- [ ] item' becomes a real " +
    "checklist item and '- [x] item' a checked one.",
  {
    title: z.string().describe("Note title; must not collide with an existing note"),
    content: z.string().optional().describe("Body content in the edit dialect"),
    folder: z.string().optional().describe("Target folder; defaults to the default folder"),
  },
  wrap(({ title, content, folder }) => notes.createNote(title, content, folder)),
);

server.tool(
  "write_note",
  "Replace a note's content with new text, in the same dialect read_note emits. " +
    "Returns what the write cost: 'rewrote' says whether existing content was " +
    "replaced, with 'preserved' and 'lost' naming what survived. Use dry_run to " +
    "see that report without writing.",
  {
    note: noteRef,
    content: z.string().describe("New content in the edit dialect"),
    on_conflict: onConflict,
    dry_run: z.boolean().optional().describe("Report what would happen; write nothing"),
  },
  wrap(({ note, content, on_conflict, dry_run }) =>
    notes.writeNote(note, content, { onConflict: on_conflict, dryRun: dry_run }),
  ),
);

server.tool(
  "append_to_note",
  "Append text to the end of a note. Never rewrites what is already there, so " +
    "it is safe on notes holding images, tables or highlighting.",
  { note: noteRef, content: z.string().describe("Content to append, in the edit dialect") },
  wrap(({ note, content }) => notes.appendContent(note, content)),
);

// ---------------------------------------------------------------- checklists

server.tool(
  "set_checklist_items",
  "Change checklist items selected by index or by matching text. Can set checked " +
    "state, change nesting depth (absolute, or relative like '+1' to indent), and " +
    "rewrite item text.",
  {
    note: noteRef,
    indices: z.array(z.number().int().nonnegative()).optional().describe("Item indices"),
    text: z.string().optional().describe("Match items containing this text"),
    exact: z.boolean().optional().describe("Require an exact text match"),
    state: z
      .enum(["checked", "unchecked", "toggle"])
      .optional()
      .describe("Checked state to apply"),
    depth: z
      .union([z.number().int().nonnegative(), z.string()])
      .optional()
      .describe("New nesting depth: a number, or '+1' / '-1' to indent or outdent"),
    new_text: z.string().optional().describe("Replace the matched items' text"),
    on_conflict: onConflict,
  },
  wrap(({ note, indices, text, exact, state, depth, new_text, on_conflict }) =>
    notes.setItems(
      note,
      { indices, text, exact },
      {
        checked:
          state === undefined ? undefined : state === "toggle" ? "toggle" : state === "checked",
        depth,
        text: new_text,
      },
      on_conflict,
    ),
  ),
);

server.tool(
  "clear_checklist",
  "Uncheck every checklist item in a note, leaving the items themselves in place. " +
    "Use this to reset a recurring checklist, e.g. after a workout.",
  { note: noteRef, on_conflict: onConflict },
  wrap(({ note, on_conflict }) => notes.clearChecklist(note, on_conflict)),
);

server.tool(
  "check_all_items",
  "Check every checklist item in a note.",
  { note: noteRef, on_conflict: onConflict },
  wrap(({ note, on_conflict }) => notes.checkAll(note, on_conflict)),
);

// ------------------------------------------------------------- organization

server.tool(
  "create_folder",
  "Create a new folder.",
  { name: z.string(), account: z.string().optional() },
  wrap(({ name, account }) => as.createFolder(name, account)),
);

server.tool(
  "move_note",
  "Move a note to a different folder.",
  { note: noteRef, folder: z.string().describe("Destination folder name") },
  wrap(async ({ note, folder }) => {
    const meta = await notes.resolveNote(note);
    await as.moveNote(meta.id, folder);
    // Re-resolve so `folderId` matches `folder`; see notes.createNote.
    return notes.resolveNote(meta.id);
  }),
);

server.tool(
  "delete_note",
  "Delete a note. It goes to Recently Deleted and can be restored. " +
    "Requires confirm: true so it cannot fire accidentally.",
  {
    note: noteRef,
    confirm: z.literal(true).describe("Must be true to proceed"),
  },
  wrap(async ({ note }) => {
    const meta = await notes.resolveNote(note);
    await as.deleteNote(meta.id);
    return { deleted: meta, recoverable: "Recently Deleted" };
  }),
);

// ------------------------------------------------------------------ health

server.tool(
  "check_setup",
  "Verify Notes automation access and that the bridge shortcuts are installed.",
  {},
  wrap(async () => {
    const access = await as.checkAccess();
    const missing = await missingShortcuts();
    const installed = new Set(await listInstalled());
    const missingOptional = OPTIONAL_SHORTCUTS.filter((n) => !installed.has(n));
    return {
      automation: access,
      missingShortcuts: missing,
      ready: access.ok && missing.length === 0,
      ...(missing.length
        ? { hint: "Run 'npx notes-mcp-setup' and approve the import prompts." }
        : {}),
      ...(missingOptional.length
        ? {
            optional: {
              missing: missingOptional,
              effect:
                "Appended checklist items go through a Markdown append instead of " +
                "the per-item intent. Items are still created correctly; text that " +
                "looks like Markdown is re-parsed rather than kept literal.",
            },
          }
        : {}),
    };
  }),
);

async function main() {
  const missing = await missingShortcuts().catch(() => [] as string[]);
  if (missing.length) {
    console.error(
      `notes-mcp: bridge shortcuts not installed (${missing.join(", ")}). ` +
        `Checklist and content tools will fail until you run "npx notes-mcp-setup".`,
    );
  }
  await server.connect(new StdioServerTransport());
}

main().catch((e) => {
  console.error("notes-mcp failed to start:", e);
  process.exit(1);
});
