/**
 * Compiling a target document into note-writing primitives.
 *
 * There are two ways to put content into a note, and each is blind to what the
 * other can write (docs/edit-model.md Part 1):
 *
 *   setBodyHtml     full-body replace. Writes colour and underline.
 *                   DESTROYS checkboxes -- a bare <ul> comes back a bullet list.
 *   appendMarkdown  additive. Writes checkboxes. Cannot express colour.
 *
 * Because the HTML write replaces everything and the Markdown write only ever
 * adds at the end, a document permits at most ONE html->markdown transition.
 * That single constraint generates the whole rule table below.
 *
 * This module is pure: it decides, it does not write. That keeps the rules
 * testable without touching Notes.
 */
import { type DialectLine, needsHtmlPhase, unwritableSpans } from "./dialect.js";

export type Op =
  | { kind: "append-markdown"; lines: DialectLine[] }
  | { kind: "append-checklist-items"; lines: DialectLine[] }
  | { kind: "set-html"; lines: DialectLine[] }
  | { kind: "clear-body" };

export type Rule =
  | "no-op"
  | "pure-append"
  | "markdown-only"
  | "html-only"
  | "split"
  | "guarded"
  | "conflict";

export interface WritePlan {
  rule: Rule;
  ops: Op[];
  /** False when the note's existing content is left in place. */
  rewrote: boolean;
  preserved: string[];
  lost: string[];
  /** Set when the plan cannot run; `ops` is empty and the caller must decide. */
  refusal?: string;
}

export interface CurrentState {
  lines: DialectLine[];
  /** Content a rewrite cannot reconstruct, e.g. "images", "tables". */
  opaque: string[];
  /** False when nesting could not be recovered, so a rewrite would flatten. */
  nestingResolved: boolean;
}

export type OnConflict = "refuse" | "keep-checklists" | "keep-formatting";

const sameLine = (a: DialectLine, b: DialectLine): boolean =>
  a.kind === b.kind &&
  a.text === b.text &&
  a.checked === b.checked &&
  a.depth === b.depth &&
  a.ordinal === b.ordinal &&
  a.headingLevel === b.headingLevel;

/** True when `target` is `current` with lines added only at the end. */
function appendedSuffix(current: DialectLine[], target: DialectLine[]): DialectLine[] | null {
  if (target.length < current.length) return null;
  for (let i = 0; i < current.length; i++) {
    if (!sameLine(current[i], target[i])) return null;
  }
  return target.slice(current.length);
}

/**
 * A suffix of only checklist items can go through the per-item intent instead
 * of a Markdown append.
 *
 * Worth distinguishing because the intent takes item text as a parameter rather
 * than re-parsing it as Markdown, so an item reading `1. buy milk` stays
 * literal instead of becoming a numbered list (docs/edit-model.md Part 8).
 */
function allPlainChecklistItems(lines: DialectLine[]): boolean {
  return (
    lines.length > 0 &&
    lines.every((l) => l.kind === "checklist" && l.depth === 0 && !needsHtmlPhase(l))
  );
}

const HIGHLIGHT_LOSS = "highlighting (undetectable, so never preserved by a rewrite)";

function lossesFor(lines: DialectLine[]): string[] {
  const out = new Set<string>();
  for (const line of lines) for (const l of unwritableSpans(line)) out.add(l);
  return [...out];
}

/**
 * Decide how to turn `current` into `target`.
 *
 * Ordering of the rules matters: the cheapest non-destructive plans are tried
 * first, so an edit that merely appends never pays for a rewrite it does not
 * need -- which is what lets a note holding an image accept a new checklist
 * item at all.
 */
export function planWrite(
  current: CurrentState,
  target: DialectLine[],
  onConflict: OnConflict = "refuse",
): WritePlan {
  // Rule 1 -- nothing to do.
  if (
    current.lines.length === target.length &&
    current.lines.every((l, i) => sameLine(l, target[i]))
  ) {
    return { rule: "no-op", ops: [], rewrote: false, preserved: ["everything"], lost: [] };
  }

  // Rule 2 -- pure append. Nothing existing is touched, so opaque content,
  // highlighting and unresolved nesting are all irrelevant here.
  const suffix = appendedSuffix(current.lines, target);
  if (suffix && suffix.length && !suffix.some(needsHtmlPhase)) {
    return {
      rule: "pure-append",
      ops: [
        allPlainChecklistItems(suffix)
          ? { kind: "append-checklist-items", lines: suffix }
          : { kind: "append-markdown", lines: suffix },
      ],
      rewrote: false,
      preserved: ["all existing content"],
      lost: lossesFor(suffix),
    };
  }

  // Everything below rewrites the note, so guard what a rewrite would destroy.

  // Rule 6 -- opaque content cannot be reconstructed, and the caller left it in
  // place, which is a request to keep it.
  if (current.opaque.length) {
    return {
      rule: "guarded",
      ops: [],
      rewrote: false,
      preserved: [],
      lost: [],
      refusal:
        `this note contains ${current.opaque.join(" and ")}, which no write path can ` +
        `recreate, and the edit needs to rewrite the note. Remove ${
          current.opaque.length > 1 ? "those markers" : "that marker"
        } from the text to say the loss is intended.`,
    };
  }

  // A rewrite re-emits every line from parsed structure, so unrecoverable
  // nesting would silently flatten the note.
  if (!current.nestingResolved) {
    return {
      rule: "guarded",
      ops: [],
      rewrote: false,
      preserved: [],
      lost: [],
      refusal:
        "this note's list nesting could not be recovered from its HTML, so " +
        "rewriting it would flatten every indented item.",
    };
  }

  const rich = target.map(needsHtmlPhase);
  const checklist = target.map((l) => l.kind === "checklist");
  const lastRich = rich.lastIndexOf(true);
  const firstCheck = checklist.indexOf(true);

  const baseLost = [HIGHLIGHT_LOSS, ...lossesFor(target)];

  // Rule 3 -- no HTML-only inline anywhere, so one Markdown pass does it.
  if (lastRich === -1) {
    return {
      rule: "markdown-only",
      ops: [{ kind: "clear-body" }, { kind: "append-markdown", lines: target }],
      rewrote: true,
      preserved: ["checklist state", "nesting", "headings", "bold/italic/strike"],
      lost: baseLost,
    };
  }

  // Rule 4 -- no checklists, so the HTML write is free to keep colour and
  // underline. This is content the old rebuild refused outright.
  if (firstCheck === -1) {
    return {
      rule: "html-only",
      ops: [{ kind: "set-html", lines: target }],
      rewrote: true,
      preserved: ["colour", "underline", "nesting", "headings", "bold/italic/strike"],
      lost: baseLost,
    };
  }

  // Rule 5 -- one transition: rich prefix as HTML, checklist suffix appended.
  if (lastRich < firstCheck) {
    return {
      rule: "split",
      ops: [
        { kind: "set-html", lines: target.slice(0, firstCheck) },
        { kind: "append-markdown", lines: target.slice(firstCheck) },
      ],
      rewrote: true,
      preserved: [
        "colour",
        "underline",
        "checklist state",
        "nesting",
        "headings",
        "bold/italic/strike",
      ],
      lost: baseLost,
    };
  }

  // Rule 7 -- interleaved. No ordering of the two primitives can do this.
  const offender = rich.lastIndexOf(true) + 1;
  const conflict =
    `line ${offender} needs colour or underline but sits after a checklist item. ` +
    `The HTML write that produces colour must come first and replaces the whole ` +
    `body, so it would destroy the checkboxes above it.`;

  if (onConflict === "keep-checklists") {
    const stripped = target.map((l) =>
      needsHtmlPhase(l)
        ? { ...l, text: l.text.replace(/\[([^\]]*)\]\{(color=[^}]*|u)\}/g, "$1") }
        : l,
    );
    return {
      rule: "markdown-only",
      ops: [{ kind: "clear-body" }, { kind: "append-markdown", lines: stripped }],
      rewrote: true,
      preserved: ["checklist state", "nesting", "headings", "bold/italic/strike"],
      lost: [...baseLost, "colour", "underline"],
    };
  }

  if (onConflict === "keep-formatting") {
    return {
      rule: "html-only",
      ops: [{ kind: "set-html", lines: target }],
      rewrote: true,
      preserved: ["colour", "underline", "nesting", "headings", "bold/italic/strike"],
      lost: [...baseLost, "checklist items become plain bullets"],
    };
  }

  return {
    rule: "conflict",
    ops: [],
    rewrote: false,
    preserved: [],
    lost: [],
    refusal:
      `${conflict} Pass on_conflict "keep-checklists" to drop the colour, or ` +
      `"keep-formatting" to let the checklist items become plain bullets.`,
  };
}
