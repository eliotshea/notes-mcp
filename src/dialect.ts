/**
 * The edit dialect: one text format for reading and writing a note.
 *
 * Callers read a note as dialect text, edit the text, and write it back. The
 * dialect is Markdown wherever Markdown suffices, plus bracketed spans for the
 * three inline constructs it cannot express:
 *
 *   [text]{color=#FF0505}   text colour   -- writable via the HTML phase
 *   [text]{u}               underline     -- writable via the HTML phase
 *   [text]{link=https://…}  link          -- READ ONLY, see below
 *
 * The dialect never reaches Notes. It is parsed here into a write plan, and the
 * Markdown importer only ever sees plain Markdown -- which matters, because the
 * importer escapes anything it does not understand, so a literal `{color=…}`
 * would otherwise land in the note as visible text (spike-findings §12).
 *
 * Highlighting deliberately has no syntax. It is invisible to every surface
 * (spike-findings §14), so any syntax for it would be a promise breakable in
 * both directions.
 */
import type { NoteLine } from "./checklist.js";

/** One line of a dialect document. */
export interface DialectLine {
  kind: "checklist" | "bullet" | "ordered" | "heading" | "text" | "blank";
  /** Inline dialect markup, e.g. `**bold** and [red]{color=#FF0505}`. */
  text: string;
  checked: boolean;
  /** List nesting depth; 0 for non-list lines. */
  depth: number;
  /** The literal number of an ordered item; 0 otherwise. */
  ordinal: number;
  /** 1-3 for headings, 0 otherwise. */
  headingLevel: number;
}

/** Notes' Markdown importer nests one level per four spaces (spike-findings §11). */
const INDENT = "    ";

/**
 * Escape text that would otherwise be re-read as structure.
 *
 * A line beginning `- `, `1. ` or `#` round-trips as a list or heading rather
 * than as prose. §12 records this biting once already, when an unescaped
 * `1. first` corrupted every numbered-list note on rebuild.
 */
function escapeLeader(text: string): string {
  return text.replace(/^(\s*)([-*+#>]|\d+\.)(\s)/, "$1\\$2$3");
}

function unescapeLeader(text: string): string {
  return text.replace(/^(\s*)\\([-*+#>]|\d+\.)(\s)/, "$1$2$3");
}

/** Render parsed note lines as dialect text. */
export function renderDialect(lines: NoteLine[]): string {
  const out: string[] = [];

  for (const line of lines) {
    const indent = INDENT.repeat(Math.max(0, line.depth));
    // Prefer the dialect form, which carries colour and underline; fall back to
    // the Markdown form, then to plain text, as each source becomes available.
    // Escaping happens after the choice, not inside the fallback: a recovered
    // dialect body can begin "- " just as readily as a plain one, and only the
    // prose case can be re-read as structure.
    const chosen = line.dialect || line.markdown || line.text;
    const body = line.kind === "text" ? escapeLeader(chosen) : chosen;

    switch (line.kind) {
      case "checklist":
        out.push(`${indent}- [${line.checked ? "x" : " "}] ${body}`);
        break;
      case "bullet":
        out.push(`${indent}- ${body}`);
        break;
      case "ordered":
        out.push(`${indent}${line.ordinal || 1}. ${body}`);
        break;
      case "blank":
        out.push("");
        break;
      case "text":
        out.push(line.headingLevel > 0 ? `${"#".repeat(line.headingLevel)} ${body}` : body);
        break;
    }
  }
  while (out.length && out[out.length - 1] === "") out.pop();
  return out.join("\n");
}

const CHECKLIST_RE = /^(\s*)-\s\[([ xX])\]\s?([\s\S]*)$/;
const BULLET_RE = /^(\s*)[-*+]\s(?!\[[ xX]\]\s)([\s\S]*)$/;
const ORDERED_RE = /^(\s*)(\d+)\.\s([\s\S]*)$/;
const HEADING_RE = /^(#{1,6})\s+([\s\S]*)$/;

/**
 * Depth from leading whitespace.
 *
 * The renderer emits four spaces per level, but callers hand-editing dialect
 * text reasonably write two, or a tab. Accept any of them rather than silently
 * flattening an indent the caller clearly intended -- the round-trip property
 * only requires that four spaces survive.
 */
function depthOf(indent: string): number {
  const spaces = indent.replace(/\t/g, INDENT).length;
  // Rounding rather than flooring is what lets a hand-written two-space indent
  // mean one level while four spaces still round-trips exactly.
  return Math.round(spaces / INDENT.length);
}

/** Parse dialect text into lines. */
export function parseDialect(text: string): DialectLine[] {
  const out: DialectLine[] = [];

  for (const raw of text.split("\n")) {
    const base = { checked: false, depth: 0, ordinal: 0, headingLevel: 0 };

    const check = raw.match(CHECKLIST_RE);
    if (check) {
      out.push({
        ...base,
        kind: "checklist",
        text: check[3],
        checked: check[2].toLowerCase() === "x",
        depth: depthOf(check[1]),
      });
      continue;
    }
    const ordered = raw.match(ORDERED_RE);
    if (ordered) {
      out.push({
        ...base,
        kind: "ordered",
        text: ordered[3],
        ordinal: Number(ordered[2]),
        depth: depthOf(ordered[1]),
      });
      continue;
    }
    const bullet = raw.match(BULLET_RE);
    if (bullet) {
      out.push({ ...base, kind: "bullet", text: bullet[2], depth: depthOf(bullet[1]) });
      continue;
    }
    const heading = raw.match(HEADING_RE);
    if (heading) {
      out.push({
        ...base,
        kind: "heading",
        text: heading[2],
        // Notes has three heading levels and clamps deeper ones (§12).
        headingLevel: Math.min(3, heading[1].length),
      });
      continue;
    }
    out.push({
      ...base,
      kind: raw.trim() === "" ? "blank" : "text",
      text: raw.trim() === "" ? "" : unescapeLeader(raw),
    });
  }

  while (out.length && out[out.length - 1].kind === "blank") out.pop();
  return out;
}

const SPAN_RE = /\[([^\]]*)\]\{(color=#[0-9A-Fa-f]{3,8}|u|link=[^}]*)\}/g;

/** True when a line uses an inline construct only the HTML phase can write. */
export function needsHtmlPhase(line: DialectLine): boolean {
  SPAN_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = SPAN_RE.exec(line.text)) !== null) {
    if (m[2] === "u" || m[2].startsWith("color=")) return true;
  }
  return false;
}

/** Inline constructs in a line that no write path can reproduce. */
export function unwritableSpans(line: DialectLine): string[] {
  const out: string[] = [];
  SPAN_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = SPAN_RE.exec(line.text)) !== null) {
    if (m[2].startsWith("link=")) out.push("links");
  }
  return out;
}

/**
 * Reduce dialect inline markup to what the Markdown importer accepts.
 *
 * Colour, underline and links have no Markdown form, so their spans collapse to
 * the text they wrap. Bold, italic and strike pass through untouched.
 */
export function dialectToMarkdown(text: string): string {
  return text.replace(SPAN_RE, (_m, inner: string) => inner);
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * Convert dialect inline markup to HTML for the AppleScript write phase.
 *
 * Links become plain text rather than `<a href>`: Notes strips the href on
 * write and leaves a bare underline, so emitting an anchor would silently
 * turn a link into meaningless underlined text.
 */
export function dialectToHtml(text: string): string {
  let s = escapeHtml(text);

  s = s.replace(
    /\[([^\]]*)\]\{(color=#[0-9A-Fa-f]{3,8}|u|link=[^}]*)\}/g,
    (_m, inner: string, spec: string) => {
      if (spec === "u") return `<u>${inner}</u>`;
      if (spec.startsWith("color=")) return `<font color="${spec.slice(6)}">${inner}</font>`;
      return inner;
    },
  );

  s = s
    .replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>")
    .replace(/~~([^~]+)~~/g, "<strike>$1</strike>")
    .replace(/(^|[^*])\*([^*]+)\*/g, "$1<i>$2</i>");

  return s;
}

/** Render dialect lines as the HTML body fragment for one block. */
export function lineToHtml(line: DialectLine): string {
  const body = dialectToHtml(line.text);
  switch (line.kind) {
    case "heading":
      return `<div><h${line.headingLevel}>${body}</h${line.headingLevel}></div>`;
    case "blank":
      return `<div><br></div>`;
    case "bullet":
    case "checklist":
      // Checklists cannot be written as HTML at all -- a bare <ul> comes back a
      // plain bullet list. The planner never routes one here; this exists so a
      // mis-planned document degrades to a bullet rather than vanishing.
      return `<ul class="Apple-dash-list"><li>${body}</li></ul>`;
    case "ordered":
      return `<ol><li>${body}</li></ol>`;
    default:
      return `<div>${body}</div>`;
  }
}

/** Render dialect lines as Markdown for the bridge's append. */
export function linesToMarkdown(lines: DialectLine[]): string {
  const out: string[] = [];
  for (const line of lines) {
    const indent = INDENT.repeat(Math.max(0, line.depth));
    const body = dialectToMarkdown(line.text);
    switch (line.kind) {
      case "checklist":
        out.push(`${indent}- [${line.checked ? "x" : " "}] ${body}`);
        break;
      case "bullet":
        out.push(`${indent}- ${body}`);
        break;
      case "ordered":
        out.push(`${indent}${line.ordinal || 1}. ${body}`);
        break;
      case "heading":
        out.push(`${"#".repeat(line.headingLevel)} ${body}`);
        break;
      case "blank":
        out.push("");
        break;
      default:
        out.push(escapeLeader(body));
    }
  }
  while (out.length && out[out.length - 1] === "") out.pop();
  return out.join("\n");
}
