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
  parseBody,
} from "./checklist.js";
import { alignBlocks, parseHtmlBlocks } from "./htmllist.js";
import {
  type DialectLine,
  dialectToMarkdown,
  lineToHtml,
  linesToMarkdown,
  parseDialect,
  renderDialect,
} from "./dialect.js";
import { type OnConflict, type WritePlan, planWrite } from "./plan.js";

export class NoteNotFoundError extends Error {
  constructor(ref: string) {
    super(`No note found matching ${JSON.stringify(ref)}`);
    this.name = "NoteNotFoundError";
  }
}

export class AmbiguousNoteError extends Error {
  constructor(name: string, count: number) {
    super(
      `${count} notes are named ${JSON.stringify(name)}. Pass a note id instead, ` +
        `or rename one of them.`,
    );
    this.name = "AmbiguousNoteError";
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

/**
 * Content that no write path can reconstruct, so a rewrite must be refused
 * rather than merely warned about.
 *
 * Distinct from `describeLoss`: colour and underline appear there but not here,
 * because the HTML write phase CAN reproduce them (docs/edit-model.md Part 1).
 */
function describeOpaque(html: string): string[] {
  const opaque: string[] = [];
  if (/<img\b/i.test(html)) opaque.push("images");
  if (/<table\b/i.test(html)) opaque.push("tables");
  return opaque;
}

/**
 * Wait until the bridge can see the note again.
 *
 * App Intents indexes a note slightly after AppleScript writes its body, and a
 * bridge call that lands in that window falls back to an interactive picker
 * (spike-findings §13). Every plan that writes HTML and then appends Markdown
 * crosses exactly that boundary.
 */
async function settle(noteName: string): Promise<void> {
  for (let i = 0; i < 12; i++) {
    try {
      await bridge.readBody(noteName);
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 250));
    }
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
  /** The note as editable dialect text; what `writeNote` accepts back. */
  dialect: string;
  lines: NoteLine[];
  checklist: ChecklistItem[];
  /**
   * False when list nesting could not be recovered, in which case every item is
   * reported at depth 0 and a rebuild would flatten the note.
   */
  nestingResolved: boolean;
  /** Content a rewrite cannot recreate, e.g. "images". */
  opaque: string[];
  /** The note's HTML, kept so a write can restore it after a failed rebuild. */
  html: string;
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

  return {
    note,
    raw,
    dialect: renderDialect(lines),
    lines,
    checklist,
    nestingResolved,
    opaque: describeOpaque(html),
    html,
  };
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
    // Re-resolve rather than patching `folder` onto stale metadata: `folderId`
    // would keep pointing at the folder the note was created in, so the same
    // note reported a different folder from create_note than from list_notes.
    return resolveNote(note.id);
  }
  return note;
}

export interface WriteResult {
  note: as.NoteMeta;
  /** Which rule the planner picked; useful for debugging, not for callers. */
  rule: string;
  /** False when the note's existing content was left in place. */
  rewrote: boolean;
  preserved: string[];
  lost: string[];
  /** Present only for a dry run. */
  dryRun?: true;
}

export class WriteRefusedError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "WriteRefusedError";
  }
}

/**
 * Run a write plan against a note.
 *
 * Any step that clears or replaces the body is recoverable: the original HTML
 * is captured first and put back if a later step fails. The restore cannot
 * recreate checkboxes, so the error says so rather than implying the note is
 * untouched.
 */
async function executePlan(
  note: as.NoteMeta,
  plan: WritePlan,
  html: string,
): Promise<void> {
  const titleHtml = as.extractTitleHtml(html) ?? `<div>${note.name}</div>`;
  let destructive = false;

  try {
    for (const op of plan.ops) {
      switch (op.kind) {
        case "clear-body":
          destructive = true;
          await as.clearBody(note.id, note.name, titleHtml);
          await settle(note.name);
          break;

        case "set-html": {
          destructive = true;
          const body = op.lines.map(lineToHtml).join("\n");
          await as.setBodyHtml(note.id, `${titleHtml}\n${body}`);
          await settle(note.name);
          break;
        }

        case "append-markdown": {
          const md = linesToMarkdown(op.lines);
          if (md.trim()) await bridge.appendMarkdown(note.name, md);
          break;
        }

        case "append-checklist-items":
          for (const l of op.lines) {
            const done = await bridge.addChecklistItem(
              note.name,
              dialectToMarkdown(l.text),
              l.checked,
            );
            // The per-item intent is optional. Without it a Markdown append
            // produces the same item; only the escaping guarantee is weaker.
            if (!done) await bridge.appendMarkdown(note.name, linesToMarkdown([l]));
          }
          break;
      }
    }
  } catch (e) {
    if (!destructive) throw e;
    try {
      await as.setBodyHtml(note.id, html);
    } catch {
      throw new RebuildFailedError(note.name, e, false);
    }
    throw new RebuildFailedError(note.name, e, true);
  }
}

/**
 * Replace a note's content with new dialect text.
 *
 * The caller supplies text and nothing else: which primitives run, and whether
 * anything is rewritten at all, is the planner's decision. A `dry_run` returns
 * the same report without writing, so the cost of an edit can be inspected
 * before committing to it.
 */
export async function writeNote(
  ref: string,
  content: string,
  opts: { onConflict?: OnConflict; dryRun?: boolean } = {},
): Promise<WriteResult> {
  const current = await readNote(ref);
  const target = parseDialect(content);

  const plan = planWrite(
    {
      lines: parseDialect(current.dialect),
      opaque: current.opaque,
      nestingResolved: current.nestingResolved,
    },
    target,
    opts.onConflict ?? "refuse",
  );

  if (plan.refusal) throw new WriteRefusedError(plan.refusal);

  const report: WriteResult = {
    note: current.note,
    rule: plan.rule,
    rewrote: plan.rewrote,
    preserved: plan.preserved,
    lost: plan.lost,
  };
  if (opts.dryRun) return { ...report, dryRun: true };

  await executePlan(current.note, plan, current.html);
  return report;
}

/** Append dialect text to a note, leaving everything above it untouched. */
export async function appendContent(ref: string, content: string): Promise<WriteResult> {
  const current = await readNote(ref);
  const existing = parseDialect(current.dialect);
  const target = [...existing, ...parseDialect(content)];
  return writeNote(ref, renderDialectLines(target));
}

/** Render already-parsed dialect lines back to text. */
function renderDialectLines(lines: DialectLine[]): string {
  return renderDialect(
    lines.map((l) => ({
      kind: l.kind === "heading" ? ("text" as const) : l.kind,
      text: l.text,
      checked: l.checked,
      itemIndex: -1,
      depth: l.depth,
      listIndex: -1,
      ordinal: l.ordinal,
      headingLevel: l.headingLevel,
      markdown: "",
      dialect: l.text,
    })),
  );
}

/**
 * Highlighting (Notes' background-colour feature) is invisible to every API
 * available here. AppleScript's HTML silently drops `background-color`, `mark`
 * and the `background` shorthand -- verified by writing all three and reading
 * back nothing -- and the App Intents body is plain text.
 *
 * Text colour, by contrast, round-trips through AppleScript fine.
 *
 * Because highlighting cannot even be DETECTED, no write can refuse for it
 * specifically, so every rewrite reports it in `lost`. The full account of what
 * was tested lives in the README rather than in every response payload.
 */
export const HIGHLIGHT_LOSS = "highlighting (undetectable, so never preserved by a rewrite)";

export interface ChecklistChange {
  note: as.NoteMeta;
  before: ChecklistItem[];
  after: ChecklistItem[];
  changed: number;
  rewrote: boolean;
  preserved: string[];
  lost: string[];
}

/** What to change about the matched checklist items. */
export interface ChecklistUpdate {
  checked?: boolean | "toggle";
  /** Absolute depth, or a relative `"+1"` / `"-1"`. */
  depth?: number | string;
  text?: string;
}

function resolveDepth(current: number, spec: number | string | undefined): number {
  if (spec === undefined) return current;
  if (typeof spec === "number") return Math.max(0, spec);
  const m = spec.match(/^([+-])(\d+)$/);
  if (!m) {
    const n = Number(spec);
    return Number.isFinite(n) ? Math.max(0, n) : current;
  }
  const delta = Number(m[2]) * (m[1] === "-" ? -1 : 1);
  return Math.max(0, current + delta);
}

/**
 * Apply an update to the checklist items a predicate selects.
 *
 * Everything routes through `writeNote`, so these tools inherit the planner's
 * behaviour: notes holding an image are refused with a reason rather than
 * silently flattened, and the caller never learns which primitives ran.
 */
async function applyChecklistChange(
  ref: string,
  predicate: (index: number, text: string) => boolean,
  update: ChecklistUpdate,
  onConflict: OnConflict,
): Promise<ChecklistChange> {
  const current = await readNote(ref);
  const lines = parseDialect(current.dialect);

  let itemIndex = 0;
  const updated = lines.map((line) => {
    if (line.kind !== "checklist") return line;
    const i = itemIndex++;
    if (!predicate(i, line.text)) return line;
    return {
      ...line,
      checked:
        update.checked === undefined
          ? line.checked
          : update.checked === "toggle"
            ? !line.checked
            : update.checked,
      depth: resolveDepth(line.depth, update.depth),
      text: update.text ?? line.text,
    };
  });

  const toItems = (ls: DialectLine[]): ChecklistItem[] => {
    let n = 0;
    return ls
      .filter((l) => l.kind === "checklist")
      .map((l) => ({ index: n++, text: l.text, checked: l.checked, depth: l.depth }));
  };

  const before = toItems(lines);
  const after = toItems(updated);
  const changed = after.filter(
    (a, i) =>
      a.checked !== before[i]?.checked ||
      a.depth !== before[i]?.depth ||
      a.text !== before[i]?.text,
  ).length;

  if (changed === 0) {
    return {
      note: current.note,
      before,
      after,
      changed: 0,
      rewrote: false,
      preserved: ["everything"],
      lost: [],
    };
  }

  const result = await writeNote(ref, renderDialectLines(updated), { onConflict });
  return {
    note: result.note,
    before,
    after,
    changed,
    rewrote: result.rewrote,
    preserved: result.preserved,
    lost: result.lost,
  };
}

/** Uncheck every checklist item in a note. The workout-reset case. */
export function clearChecklist(ref: string, onConflict: OnConflict = "refuse") {
  return applyChecklistChange(ref, () => true, { checked: false }, onConflict);
}

/** Check every checklist item in a note. */
export function checkAll(ref: string, onConflict: OnConflict = "refuse") {
  return applyChecklistChange(ref, () => true, { checked: true }, onConflict);
}

/** Update specific items, addressed by index or by text match. */
export function setItems(
  ref: string,
  target: { indices?: number[]; text?: string; exact?: boolean },
  update: ChecklistUpdate,
  onConflict: OnConflict = "refuse",
): Promise<ChecklistChange> {
  const predicate =
    target.indices !== undefined
      ? (i: number) => target.indices!.includes(i)
      : target.text !== undefined
        ? (_i: number, text: string) =>
            target.exact
              ? text === target.text
              : text.toLowerCase().includes(target.text!.toLowerCase())
        : () => true;
  return applyChecklistChange(ref, predicate, update, onConflict);
}
