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
  matchByIndex,
  matchByText,
  parseBody,
  parseChecklist,
  renderMarkdown,
  setChecked,
} from "./checklist.js";

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
}

/** Read a note's content including checklist state. */
export async function readNote(ref: string): Promise<NoteContent> {
  const note = await resolveNote(ref);
  const raw = await bridge.readBody(note.name);
  return { note, raw, lines: parseBody(raw), checklist: parseChecklist(raw) };
}

/** Read just the checklist items of a note. */
export async function readChecklist(ref: string): Promise<{
  note: as.NoteMeta;
  items: ChecklistItem[];
}> {
  const { note, checklist } = await readNote(ref);
  return { note, items: checklist };
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
  if (!force) {
    const html = await as.getBodyHtml(note.id);
    if (as.htmlHasRichContent(html)) throw new RichContentError(note.name);
  }
  const markdown = renderMarkdown(lines);
  await as.clearBody(note.id, note.name);
  if (markdown.trim()) {
    await bridge.appendMarkdown(note.name, markdown);
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
  const { note, lines, checklist } = await readNote(ref);
  const updated = setChecked(lines, predicate, value);

  const after = updated
    .filter((l) => l.kind === "checklist")
    .map((l) => ({ index: l.itemIndex, text: l.text, checked: l.checked }));
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
  if (!force) {
    const html = await as.getBodyHtml(note.id);
    if (as.htmlHasRichContent(html)) throw new RichContentError(note.name);
  }
  await as.clearBody(note.id, note.name);
  if (markdown.trim()) await bridge.appendMarkdown(note.name, markdown);
  return note;
}
