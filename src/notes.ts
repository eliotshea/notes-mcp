/**
 * Domain operations, composing the AppleScript and Shortcuts layers.
 *
 * The central constraint: there is no action to enumerate or toggle individual
 * checklist items. Any change to checked state is therefore applied by REBUILD:
 *
 *   1. read the body through the bridge (the only source of checked state)
 *   2. clear the body via AppleScript, leaving the title
 *   3. re-append every line as Markdown with the desired state
 *
 * The note keeps its id, folder, and creation date. What a rebuild cannot
 * reconstruct is rich content (images, tables, styling), so callers are warned
 * before one runs.
 */
import * as as from "./applescript.js";
import * as bridge from "./shortcuts.js";
import {
  type ChecklistItem,
  type NoteLine,
  applyStructure,
  matchByIndex,
  matchByText,
  parseBody,
  renderMarkdown,
  setChecked,
} from "./checklist.js";
import { alignBlocks, parseHtmlBlocks } from "./htmllist.js";

export class NoteNotFoundError extends Error {
  constructor(ref: string) {
    super(`No note found matching ${JSON.stringify(ref)}`);
    this.name = "NoteNotFoundError";
  }
}

export class AmbiguousNoteError extends Error {
  constructor(name: string, count: number) {
    super(
      `${count} notes are named ${JSON.stringify(name)}. ` +
        `The Notes bridge addresses notes by name, so rename one or pass a note id.`,
    );
    this.name = "AmbiguousNoteError";
  }
}

export class NestingUnresolvedError extends Error {
  constructor(name: string) {
    super(
      `Could not recover list nesting for ${JSON.stringify(name)}, so rewriting it ` +
        `would flatten indented items. This happens when the note's HTML and its ` +
        `App Intents text disagree. Pass force: true to rebuild it flat anyway.`,
    );
    this.name = "NestingUnresolvedError";
  }
}

/**
 * A rebuild failed after the note's body had already been cleared.
 *
 * `restored` says whether the original content was put back. Even when it was,
 * the restore goes through AppleScript HTML, which cannot express checkboxes --
 * so any checklist items come back as plain bullets and the caller needs to
 * know that rather than assume the note is untouched.
 */
export class RebuildFailedError extends Error {
  constructor(name: string, cause: unknown, restored: boolean) {
    const why = cause instanceof Error ? cause.message : String(cause);
    super(
      restored
        ? `Rebuilding ${JSON.stringify(name)} failed (${why}). The original content ` +
            `was restored, but any checklist items in it are now plain bullets, ` +
            `because the restore path cannot write checkboxes.`
        : `Rebuilding ${JSON.stringify(name)} failed (${why}) AND the content could ` +
            `not be restored. The note may currently hold only its title. ` +
            `Check Notes and recover from a version history if needed.`,
    );
    this.name = "RebuildFailedError";
  }
}

export class RichContentError extends Error {
  constructor(name: string) {
    super(
      `Note ${JSON.stringify(name)} contains attachments or tables, which a ` +
        `checklist rebuild cannot reconstruct. Pass force: true to proceed anyway.`,
    );
    this.name = "RichContentError";
  }
}

/**
 * Resolve a note reference (id or exact name) to its metadata.
 *
 * Names must be unique because the bridge can only address notes by name; an
 * ambiguous name is reported rather than silently resolved to the first match.
 */
export async function resolveNote(ref: string): Promise<as.NoteMeta> {
  if (ref.startsWith("x-coredata://")) {
    const all = await as.listNotes();
    const hit = all.find((n) => n.id === ref);
    if (!hit) throw new NoteNotFoundError(ref);
    return hit;
  }
  const matches = await as.findNotesByName(ref);
  if (matches.length === 0) throw new NoteNotFoundError(ref);
  if (matches.length > 1) throw new AmbiguousNoteError(ref, matches.length);
  return matches[0];
}

export interface NoteContent {
  note: as.NoteMeta;
  /** Plain text with ◦ / ✓ / ⁃ markers, exactly as the bridge returned it. */
  raw: string;
  lines: NoteLine[];
  checklist: ChecklistItem[];
  /**
   * False when list nesting could not be recovered, in which case every item is
   * reported at depth 0 and a rebuild would flatten the note.
   */
  nestingResolved: boolean;
}

/**
 * Read a note's content including checklist state and list nesting.
 *
 * Neither source is sufficient alone: the bridge body carries checked state but
 * flattens nesting (every item gets one tab regardless of depth), while the
 * AppleScript HTML preserves nesting but has no state. They enumerate list
 * items in the same order, so depths are zipped onto the parsed lines by
 * position, with a text comparison guarding against misalignment.
 */
export async function readNote(ref: string): Promise<NoteContent> {
  const note = await resolveNote(ref);
  const raw = await bridge.readBody(note.name);
  let lines = parseBody(raw);

  // The bridge body flattens nesting AND strips heading levels, so both are
  // recovered from the note's HTML and overlaid by position.
  const html = await as.getBodyHtml(note.id);
  const { structure, aligned } = alignBlocks(
    lines.map((l) => ({ text: l.text, isList: l.listIndex >= 0 })),
    parseHtmlBlocks(html),
  );
  const nestingResolved = aligned;
  if (aligned) lines = applyStructure(lines, structure);

  const checklist = lines
    .filter((l) => l.kind === "checklist")
    .map((l) => ({
      index: l.itemIndex,
      text: l.text,
      checked: l.checked,
      depth: l.depth,
    }));

  return { note, raw, lines, checklist, nestingResolved };
}

/** Read just the checklist items of a note. */
export async function readChecklist(ref: string): Promise<{
  note: as.NoteMeta;
  items: ChecklistItem[];
  nestingResolved: boolean;
}> {
  const { note, checklist, nestingResolved } = await readNote(ref);
  return { note, items: checklist, nestingResolved };
}

/** Append Markdown to a note without disturbing existing content. */
export async function appendToNote(ref: string, markdown: string): Promise<as.NoteMeta> {
  const note = await resolveNote(ref);
  await bridge.appendMarkdown(note.name, markdown);
  return note;
}

/**
 * Create a note and populate it with Markdown.
 *
 * Creation goes through App Intents, not AppleScript. A note created by
 * AppleScript is not immediately visible to App Intents, so the follow-up
 * append would find nothing and raise an interactive picker. Placing the note
 * in a specific folder is done afterwards via AppleScript, which has no such
 * visibility lag.
 */
export async function createNote(
  title: string,
  markdown?: string,
  folder?: string,
): Promise<as.NoteMeta> {
  const existing = await as.findNotesByName(title);
  if (existing.length > 0) {
    throw new AmbiguousNoteError(title, existing.length + 1);
  }

  await bridge.createNoteFromMarkdown(title, markdown ?? "");

  const matches = await as.findNotesByName(title);
  if (matches.length === 0) {
    throw new Error(
      `Created note ${JSON.stringify(title)} but could not find it afterwards. ` +
        `Notes may have altered the title.`,
    );
  }
  const note = matches[0];

  // App Intents indexes a new note slightly after it exists, so an immediate
  // read comes back empty. Wait until the content is visible, otherwise a
  // create-then-read sequence silently reports an empty note.
  if ((markdown ?? "").trim()) {
    for (let i = 0; i < 10; i++) {
      const body = await bridge.readBody(title).catch(() => "");
      if (body.trim()) break;
      await new Promise((r) => setTimeout(r, 300));
    }
  }

  if (folder && note.folder !== folder) {
    await as.moveNote(note.id, folder);
    return { ...note, folder };
  }
  return note;
}

/**
 * Rewrite a note from parsed lines, preserving its identity.
 * This is the shared mechanism behind every checked-state change.
 */
async function rebuild(
  note: as.NoteMeta,
  lines: NoteLine[],
  force: boolean,
): Promise<void> {
  const html = await as.getBodyHtml(note.id);
  if (!force && as.htmlHasRichContent(html)) throw new RichContentError(note.name);

  const markdown = renderMarkdown(lines);
  if (!markdown.trim()) return; // nothing to write; leave the note alone

  // Keep the title's original markup: Notes styles a written body purely from
  // its markup, so synthesising <div>{title}</div> demotes an <h1> title to
  // body size and it renders tiny.
  await as.clearBody(note.id, note.name, as.extractTitleHtml(html));

  try {
    await bridge.appendMarkdown(note.name, markdown);
  } catch (e) {
    // The body is currently empty. Put the original content back rather than
    // leaving the note holding only its title.
    try {
      await as.setBodyHtml(note.id, html);
    } catch {
      throw new RebuildFailedError(note.name, e, false);
    }
    throw new RebuildFailedError(note.name, e, true);
  }
}

export interface ChecklistChange {
  note: as.NoteMeta;
  before: ChecklistItem[];
  after: ChecklistItem[];
  changed: number;
}

async function applyChecklistChange(
  ref: string,
  predicate: (line: NoteLine) => boolean,
  value: boolean | "toggle",
  force: boolean,
): Promise<ChecklistChange> {
  const { note, lines, checklist, nestingResolved } = await readNote(ref);

  // A rebuild rewrites the whole note, so unrecoverable nesting would silently
  // flatten it. Refuse rather than damage the note's structure.
  if (!nestingResolved && !force) throw new NestingUnresolvedError(note.name);

  const updated = setChecked(lines, predicate, value);

  const after = updated
    .filter((l) => l.kind === "checklist")
    .map((l) => ({ index: l.itemIndex, text: l.text, checked: l.checked, depth: l.depth }));
  const changed = after.filter((a, i) => a.checked !== checklist[i]?.checked).length;

  if (changed > 0) await rebuild(note, updated, force);
  return { note, before: checklist, after, changed };
}

/** Uncheck every checklist item in a note. The workout-reset case. */
export function clearChecklist(ref: string, force = false): Promise<ChecklistChange> {
  return applyChecklistChange(ref, () => true, false, force);
}

/** Check every checklist item in a note. */
export function checkAll(ref: string, force = false): Promise<ChecklistChange> {
  return applyChecklistChange(ref, () => true, true, force);
}

/** Set specific items, addressed by index or by text match. */
export function setItems(
  ref: string,
  target: { indices?: number[]; text?: string; exact?: boolean },
  value: boolean | "toggle",
  force = false,
): Promise<ChecklistChange> {
  const predicate =
    target.indices !== undefined
      ? matchByIndex(target.indices)
      : target.text !== undefined
        ? matchByText(target.text, target.exact ?? false)
        : () => true;
  return applyChecklistChange(ref, predicate, value, force);
}

/** Replace a note's entire content with new Markdown. */
export async function replaceContent(
  ref: string,
  markdown: string,
  force = false,
): Promise<as.NoteMeta> {
  const note = await resolveNote(ref);
  const html = await as.getBodyHtml(note.id);
  if (!force && as.htmlHasRichContent(html)) throw new RichContentError(note.name);

  await as.clearBody(note.id, note.name, as.extractTitleHtml(html));
  if (markdown.trim()) {
    try {
      await bridge.appendMarkdown(note.name, markdown);
    } catch (e) {
      try {
        await as.setBodyHtml(note.id, html);
      } catch {
        throw new RebuildFailedError(note.name, e, false);
      }
      throw new RebuildFailedError(note.name, e, true);
    }
  }
  return note;
}
