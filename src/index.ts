#!/usr/bin/env node
/**
 * MCP server for Apple Notes.
 *
 * Transport is stdio, so nothing may be written to stdout except protocol
 * traffic — diagnostics go to stderr.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import * as as from "./applescript.js";
import * as notes from "./notes.js";
import { missingShortcuts } from "./shortcuts.js";

const server = new McpServer({ name: "notes-mcp", version: "0.1.0" });

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
  "Read a note's full content. Checklist items appear as ◦ (unchecked), ✓ (checked), " +
    "and ⁃ marks an ordinary bullet. Each checklist item also reports its nesting " +
    "depth. This is the only way to observe checked state.",
  { note: noteRef },
  wrap(async ({ note }) => {
    const c = await notes.readNote(note);
    return {
      note: c.note,
      content: c.raw,
      checklist: c.checklist,
      nestingResolved: c.nestingResolved,
      ...(c.nestingResolved
        ? {}
        : {
            warning:
              "List nesting could not be recovered; depths are reported as 0 and " +
              "rewriting this note would flatten indented items.",
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
  "Create a note. Markdown is converted by Notes itself, so '- [ ] item' becomes a " +
    "real checklist item and '- [x] item' a checked one.",
  {
    title: z.string().describe("Note title; must not collide with an existing note"),
    markdown: z.string().optional().describe("Body content in Markdown"),
    folder: z.string().optional().describe("Target folder; defaults to the default folder"),
  },
  wrap(({ title, markdown, folder }) => notes.createNote(title, markdown, folder)),
);

server.tool(
  "append_to_note",
  "Append Markdown to the end of a note, leaving existing content untouched. " +
    "'- [ ] item' becomes a real checklist item.",
  { note: noteRef, markdown: z.string().describe("Markdown to append") },
  wrap(({ note, markdown }) => notes.appendToNote(note, markdown)),
);

server.tool(
  "replace_note_content",
  "Replace a note's entire body with new Markdown, keeping its id, folder and " +
    "creation date. Refuses if the note has attachments or tables unless force is set.",
  {
    note: noteRef,
    markdown: z.string().describe("New body content in Markdown"),
    force: z.boolean().optional().describe("Proceed even if rich content would be lost"),
  },
  wrap(({ note, markdown, force }) => notes.replaceContent(note, markdown, force ?? false)),
);

// ---------------------------------------------------------------- checklists

server.tool(
  "clear_checklist",
  "Uncheck every checklist item in a note, leaving the items themselves in place. " +
    "Use this to reset a recurring checklist, e.g. after a workout.",
  {
    note: noteRef,
    force: z.boolean().optional().describe("Proceed even if rich content would be lost"),
  },
  wrap(({ note, force }) => notes.clearChecklist(note, force ?? false)),
);

server.tool(
  "check_all_items",
  "Check every checklist item in a note.",
  {
    note: noteRef,
    force: z.boolean().optional(),
  },
  wrap(({ note, force }) => notes.checkAll(note, force ?? false)),
);

server.tool(
  "set_checklist_items",
  "Check, uncheck, or toggle specific checklist items, selected either by index " +
    "(from read_checklist) or by matching their text.",
  {
    note: noteRef,
    indices: z.array(z.number().int().nonnegative()).optional().describe("Item indices"),
    text: z.string().optional().describe("Match items containing this text"),
    exact: z.boolean().optional().describe("Require an exact text match"),
    state: z.enum(["checked", "unchecked", "toggle"]).describe("State to apply"),
    force: z.boolean().optional(),
  },
  wrap(({ note, indices, text, exact, state, force }) =>
    notes.setItems(
      note,
      { indices, text, exact },
      state === "toggle" ? "toggle" : state === "checked",
      force ?? false,
    ),
  ),
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
    return { ...meta, folder };
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
    return {
      automation: access,
      missingShortcuts: missing,
      ready: access.ok && missing.length === 0,
      ...(missing.length
        ? { hint: "Run 'npx notes-mcp-setup' and approve the import prompts." }
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
