/**
 * AppleScript (JXA) access to Notes.
 *
 * Used for everything that does NOT involve checklist structure: listing,
 * search, metadata, folders, creation, move, delete, and clearing a body.
 *
 * IMPORTANT: AppleScript cannot see or write checklists. Reading a note's
 * `body` returns checklist items as plain `<li>` with no state, and writing
 * `body` converts existing checklists into permanent plain bullets. Anything
 * touching checklists must go through the Shortcuts bridge instead.
 * See docs/spike-findings.md §1.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface NoteMeta {
  id: string;
  name: string;
  folder: string;
  folderId: string;
  modified: string;
  created: string;
}

/**
 * Notes exposes "Recently Deleted" as an ordinary folder, so deleted notes keep
 * showing up in listings and lookups unless they are filtered out.
 *
 * There is no `isTrash` property to test, so two signals are combined: the
 * folder's CoreData position (the trash is consistently `ICFolder/p2`, created
 * before any user folder) and its localized display name. Either match counts,
 * which keeps this working on non-English systems and on stores where the
 * position differs.
 */
const TRASH_FOLDER_ID_SUFFIX = "/ICFolder/p2";

const TRASH_FOLDER_NAMES = new Set([
  "Recently Deleted",
  "Recently deleted",
  "Suppressions récentes",
  "Zuletzt gelöscht",
  "Eliminados recientemente",
  "Eliminati di recente",
  "Recentemente eliminadas",
  "Onlangs verwijderd",
  "Nyligen raderade",
  "Senest slettet",
  "最近削除した項目",
  "最近删除",
  "最近刪除",
  "최근 삭제된 항목",
  "Недавно удаленные",
  "Son Silinenler",
  "Ostatnio usunięte",
]);

export function isTrashFolder(name: string, id: string): boolean {
  return id.endsWith(TRASH_FOLDER_ID_SUFFIX) || TRASH_FOLDER_NAMES.has(name);
}

const dropTrash = <T extends { folder: string; folderId: string }>(rows: T[]): T[] =>
  rows.filter((r) => !isTrashFolder(r.folder, r.folderId));

export interface FolderMeta {
  id: string;
  name: string;
  account: string;
  noteCount: number;
}

/**
 * Run a JXA script. The script receives its argument as a JSON string in
 * `argv[0]`, so no user data is ever interpolated into source code.
 */
async function runJxa<T>(script: string, arg: unknown = null): Promise<T> {
  const source = `function run(argv) {
    const ARG = argv.length ? JSON.parse(argv[0]) : null;
    const Notes = Application("Notes");
    ${script}
  }`;
  const { stdout } = await execFileAsync(
    "osascript",
    ["-l", "JavaScript", "-e", source, JSON.stringify(arg)],
    { maxBuffer: 64 * 1024 * 1024 },
  );
  const text = stdout.trim();
  return (text ? JSON.parse(text) : null) as T;
}

/**
 * List every note's metadata.
 *
 * Uses parallel-list access (`notes.id()`, `notes.name()`, ...) which issues
 * one Apple Event per property rather than one per note — measured at 0.17s
 * for 177 notes versus ~1s for 25 notes with a per-note loop.
 */
export async function listNotes(opts: { includeDeleted?: boolean } = {}): Promise<NoteMeta[]> {
  const rows = await runJxa<NoteMeta[]>(`
    const out = [];
    for (const f of Notes.folders()) {
      const ids = f.notes.id(), names = f.notes.name();
      const mod = f.notes.modificationDate(), made = f.notes.creationDate();
      const folder = f.name(), folderId = f.id();
      for (let i = 0; i < ids.length; i++) {
        out.push({ id: ids[i], name: names[i], folder, folderId,
                   modified: String(mod[i]), created: String(made[i]) });
      }
    }
    return JSON.stringify(out);
  `);
  return opts.includeDeleted ? rows : dropTrash(rows);
}

/** List folders with note counts. Excludes Recently Deleted unless asked. */
export async function listFolders(
  opts: { includeDeleted?: boolean } = {},
): Promise<FolderMeta[]> {
  const rows = await runJxa<FolderMeta[]>(`
    const out = [];
    for (const a of Notes.accounts()) {
      const acct = a.name();
      for (const f of a.folders()) {
        out.push({ id: f.id(), name: f.name(), account: acct,
                   noteCount: f.notes.length });
      }
    }
    return JSON.stringify(out);
  `);
  return opts.includeDeleted ? rows : rows.filter((f) => !isTrashFolder(f.name, f.id));
}

/**
 * Full-text search over note names and plaintext.
 *
 * Bulk `plaintext()` for the whole library measured 0.66s, so filtering in
 * process is cheaper than an AppleScript `whose` clause.
 */
export async function searchNotes(
  query: string,
  opts: { includeBody?: boolean; limit?: number } = {},
): Promise<NoteMeta[]> {
  const { includeBody = true, limit = 50 } = opts;
  const rows = await runJxa<NoteMeta[]>(
    `
    const q = ARG.query.toLowerCase();
    const out = [];
    for (const f of Notes.folders()) {
      const ids = f.notes.id(), names = f.notes.name();
      const mod = f.notes.modificationDate(), made = f.notes.creationDate();
      const texts = ARG.includeBody ? f.notes.plaintext() : null;
      const folder = f.name(), folderId = f.id();
      for (let i = 0; i < ids.length; i++) {
        const inName = (names[i] || "").toLowerCase().indexOf(q) !== -1;
        const inBody = texts ? (texts[i] || "").toLowerCase().indexOf(q) !== -1 : false;
        if (inName || inBody) {
          out.push({ id: ids[i], name: names[i], folder, folderId,
                     modified: String(mod[i]), created: String(made[i]) });
        }
      }
    }
    out.sort((a, b) => new Date(b.modified) - new Date(a.modified));
    return JSON.stringify(out);
  `,
    { query, includeBody },
  );
  return dropTrash(rows).slice(0, limit);
}

/** Look up notes by exact name. Returns all matches so callers can detect ambiguity. */
export async function findNotesByName(name: string): Promise<NoteMeta[]> {
  const rows = await runJxa<NoteMeta[]>(
    `
    const out = [];
    for (const f of Notes.folders()) {
      const ids = f.notes.id(), names = f.notes.name();
      const mod = f.notes.modificationDate(), made = f.notes.creationDate();
      const folder = f.name(), folderId = f.id();
      for (let i = 0; i < ids.length; i++) {
        if (names[i] === ARG.name) {
          out.push({ id: ids[i], name: names[i], folder, folderId,
                     modified: String(mod[i]), created: String(made[i]) });
        }
      }
    }
    return JSON.stringify(out);
  `,
    { name },
  );
  return dropTrash(rows);
}

/**
 * Raw HTML body of a note.
 *
 * Checklists appear here as a bare `<ul>` with no state, while ordinary
 * bullets carry `class="Apple-dash-list"`. Useful for detecting that a note
 * has checklist regions, never for reading their state.
 */
export async function getBodyHtml(noteId: string): Promise<string> {
  return runJxa<string>(
    `
    for (const f of Notes.folders()) {
      const ids = f.notes.id();
      const i = ids.indexOf(ARG.id);
      if (i !== -1) return JSON.stringify(f.notes.body()[i]);
    }
    throw new Error("note not found: " + ARG.id);
  `,
    { id: noteId },
  );
}

/** True when the HTML contains a checklist region (bare `<ul>`). */
export function htmlHasChecklist(html: string): boolean {
  return /<ul(?![^>]*class=)/i.test(html);
}

/** True when the note contains attachments or tables that a rebuild would lose. */
export function htmlHasRichContent(html: string): boolean {
  return /<(img|table|object|embed)\b/i.test(html);
}

/**
 * Extract a note's title line -- the first top-level `<div>…</div>` of its HTML.
 *
 * Returns the markup verbatim, including any `<h1>`, because Notes rewrites
 * whatever it is given and the styling depends entirely on that markup:
 *
 *   <div>Leg day</div>            -> font-size 11px   (body text, looks tiny)
 *   <div><h1>Leg day</h1></div>   -> font-size 21px bold (title)
 *
 * Synthesising the title from its plain text therefore silently demoted every
 * `<h1>` title to body size.
 */
export function extractTitleHtml(html: string): string | null {
  const m = html.match(/^\s*<div\b[^>]*>[\s\S]*?<\/div\s*>/i);
  return m ? m[0] : null;
}

/**
 * Replace a note's entire body with just its title line.
 *
 * This is destructive by design — it is step 2 of the checklist rebuild, where
 * the items are immediately re-appended as Markdown. Never call it on a note
 * whose content has not already been read.
 *
 * Pass `titleHtml` (from `extractTitleHtml`) to preserve the original title
 * styling. Falling back to the plain title renders it at body size.
 */
export async function clearBody(
  noteId: string,
  title: string,
  titleHtml?: string | null,
): Promise<void> {
  return setBodyHtml(noteId, titleHtml ?? `<div>${escapeHtml(title)}</div>`);
}

/**
 * Overwrite a note's body with raw HTML.
 *
 * Note this DESTROYS any checklist in the note -- items become plain bullets --
 * so it is only safe when the checklists are about to be re-appended as
 * Markdown, or when restoring a note after a failed rebuild.
 */
export async function setBodyHtml(noteId: string, html: string): Promise<void> {
  await runJxa(
    `
    for (const f of Notes.folders()) {
      const ids = f.notes.id();
      const i = ids.indexOf(ARG.id);
      if (i !== -1) {
        f.notes.byId(ARG.id).body = ARG.html;
        return JSON.stringify(true);
      }
    }
    throw new Error("note not found: " + ARG.id);
  `,
    { id: noteId, html },
  );
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/** Create an empty note (title only) in a folder; content is appended separately. */
export async function createNote(title: string, folder?: string): Promise<NoteMeta> {
  return runJxa<NoteMeta>(
    `
    const target = ARG.folder
      ? Notes.folders.byName(ARG.folder)
      : Notes.defaultAccount().defaultFolder();
    const note = Notes.make({ new: "note", at: target,
      withProperties: { body: "<div>" + ARG.title + "</div>" } });
    return JSON.stringify({ id: note.id(), name: note.name(),
      folder: target.name(), folderId: target.id(),
      modified: String(note.modificationDate()),
      created: String(note.creationDate()) });
  `,
    { title: escapeHtml(title), folder },
  );
}

export async function createFolder(name: string, account?: string): Promise<FolderMeta> {
  return runJxa<FolderMeta>(
    `
    const acct = ARG.account ? Notes.accounts.byName(ARG.account) : Notes.defaultAccount();
    const f = Notes.make({ new: "folder", at: acct, withProperties: { name: ARG.name } });
    return JSON.stringify({ id: f.id(), name: f.name(), account: acct.name(),
                            noteCount: f.notes.length });
  `,
    { name, account },
  );
}

export async function moveNote(noteId: string, folder: string): Promise<void> {
  await runJxa(
    `
    const dest = Notes.folders.byName(ARG.folder);
    for (const f of Notes.folders()) {
      const ids = f.notes.id();
      if (ids.indexOf(ARG.id) !== -1) {
        Notes.move(f.notes.byId(ARG.id), { to: dest });
        return JSON.stringify(true);
      }
    }
    throw new Error("note not found: " + ARG.id);
  `,
    { id: noteId, folder },
  );
}

/** Delete a note. Notes moves it to Recently Deleted, so this is recoverable. */
export async function deleteNote(noteId: string): Promise<void> {
  await runJxa(
    `
    for (const f of Notes.folders()) {
      const ids = f.notes.id();
      if (ids.indexOf(ARG.id) !== -1) {
        Notes.delete(f.notes.byId(ARG.id));
        return JSON.stringify(true);
      }
    }
    throw new Error("note not found: " + ARG.id);
  `,
    { id: noteId },
  );
}

/** Verify Notes is scriptable and automation permission has been granted. */
export async function checkAccess(): Promise<{ ok: boolean; noteCount?: number; error?: string }> {
  try {
    const count = await runJxa<number>(`return JSON.stringify(Notes.notes.length);`);
    return { ok: true, noteCount: count };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
