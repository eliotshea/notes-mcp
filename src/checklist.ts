/**
 * Parsing and rendering of Apple Notes list content.
 *
 * The Notes App Intents `Body` property renders a note as plain text where each
 * list line is `\t<marker>\t<text>`. The marker distinguishes a checklist item
 * from an ordinary bullet, and carries the checked state:
 *
 *   ◦  U+25E6 WHITE BULLET   unchecked checklist item
 *   ✓  U+2713 CHECK MARK     checked checklist item
 *   ⁃  U+2043 HYPHEN BULLET  ordinary bullet (NOT a checklist)
 *
 * This is the only supported way to observe checked state — AppleScript strips
 * it entirely. See docs/spike-findings.md §9.
 */

export const MARKER_UNCHECKED = "◦"; // ◦
export const MARKER_CHECKED = "✓"; // ✓
export const MARKER_BULLET = "⁃"; // ⁃

export type LineKind = "checklist" | "bullet" | "ordered" | "text" | "blank";

export interface NoteLine {
  kind: LineKind;
  text: string;
  /** Only meaningful when kind === "checklist". */
  checked: boolean;
  /** Zero-based index among checklist items only; -1 for other kinds. */
  itemIndex: number;
  /**
   * Nesting depth for list lines; 0 for other kinds.
   *
   * The bridge body cannot express depth -- every item arrives with one tab
   * regardless of indentation -- so this is filled in from the note's HTML by
   * `applyDepths`. It stays 0 until that happens.
   */
  depth: number;
  /** Zero-based index among ALL list lines (checklist, bullet and ordered). */
  listIndex: number;
  /** The literal number of an ordered item, e.g. 2 for `2.`; 0 otherwise. */
  ordinal: number;
  /**
   * 1-3 for a heading (Title / Heading / Subheading), 0 otherwise.
   *
   * The bridge body strips heading levels entirely, so this is recovered from
   * the note's HTML by `applyStructure` and stays 0 until then.
   */
  headingLevel: number;
  /**
   * The line's text with bold/italic/strike expressed as Markdown.
   *
   * Recovered from the note's HTML, which is the only source that carries
   * inline styling. Empty when unavailable, in which case `text` is used and
   * the styling is lost -- so this is what makes bold survive a rebuild.
   */
  markdown: string;
}

export interface ChecklistItem {
  index: number;
  text: string;
  checked: boolean;
  depth: number;
}

/**
 * A list line is `\t<marker>\t<text>`. The marker is one of the three bullet
 * glyphs, or `N.` for an ordered item -- ordered lists are why this cannot be a
 * single-character match.
 */
const MARKERS = `${MARKER_UNCHECKED}${MARKER_CHECKED}${MARKER_BULLET}`;
const LIST_LINE = new RegExp(`^\\t([${MARKERS}]|\\d+\\.)\\t([\\s\\S]*)$`);

/**
 * The very first line of the returned body has its leading tab stripped, so a
 * list item at the top of a note arrives as `✓\ttext` rather than `\t✓\ttext`.
 */
const LIST_LINE_NO_INDENT = new RegExp(`^([${MARKERS}]|\\d+\\.)\\t([\\s\\S]*)$`);

const ORDERED_MARKER = /^(\d+)\.$/;

/**
 * Parse the plain-text body returned by the read bridge into structured lines.
 *
 * Note: the body does NOT include the note's title -- Notes exposes that
 * separately as `Name`. Every line here is real content.
 */
export function parseBody(body: string): NoteLine[] {
  const lines = body.split("\n");
  const out: NoteLine[] = [];
  let itemIndex = 0;
  let listIndex = 0;

  for (const raw of lines) {
    const m = raw.match(LIST_LINE) ?? raw.match(LIST_LINE_NO_INDENT);
    if (m) {
      const [, marker, text] = m;
      const base = { text, depth: 0, listIndex: listIndex++ };

      if (marker === MARKER_CHECKED || marker === MARKER_UNCHECKED) {
        out.push({
          ...base,
          kind: "checklist",
          checked: marker === MARKER_CHECKED,
          itemIndex: itemIndex++,
          ordinal: 0,
          headingLevel: 0,
          markdown: "",
        });
        continue;
      }

      const ord = marker.match(ORDERED_MARKER);
      out.push({
        ...base,
        kind: ord ? "ordered" : "bullet",
        checked: false,
        itemIndex: -1,
        ordinal: ord ? Number(ord[1]) : 0,
        headingLevel: 0,
        markdown: "",
      });
      continue;
    }
    out.push({
      kind: raw.trim() === "" ? "blank" : "text",
      text: raw,
      checked: false,
      itemIndex: -1,
      depth: 0,
      listIndex: -1,
      ordinal: 0,
      headingLevel: 0,
      markdown: "",
    });
  }
  return out;
}

/** Extract just the checklist items, in document order. */
export function parseChecklist(body: string): ChecklistItem[] {
  return parseBody(body)
    .filter((l) => l.kind === "checklist")
    .map((l) => ({ index: l.itemIndex, text: l.text, checked: l.checked, depth: l.depth }));
}

/** True when the note contains at least one checklist item. */
export function hasChecklist(body: string): boolean {
  return parseBody(body).some((l) => l.kind === "checklist");
}

function escapeMarkdown(text: string): string {
  // A leading "- ", "* ", "#", or "[ ]" would be re-interpreted by Notes'
  // Markdown importer and silently change the line's structure.
  return text.replace(/^(\s*)([-*+#>]|\d+\.)(\s)/, "$1\\$2$3");
}

/**
 * Render lines back to Markdown for Notes' Markdown importer.
 *
 * `- [ ]` / `- [x]` become real checklist items with the right state, and
 * `- ` becomes an ordinary bullet. Verified in docs/spike-findings.md §3.
 *
 * The title is NOT part of `lines` (Notes exposes it separately as `Name`), so
 * every line is emitted. `skipFirstText` exists only for bodies that genuinely
 * repeat the title as a heading.
 */
export function renderMarkdown(
  lines: NoteLine[],
  opts: { skipFirstText?: boolean } = {},
): string {
  const { skipFirstText = false } = opts;
  const out: string[] = [];
  let skipped = false;

  for (const line of lines) {
    if (skipFirstText && !skipped && line.kind === "text") {
      skipped = true;
      continue;
    }

    // Notes' Markdown importer nests a list item per four spaces of indent.
    const indent = "    ".repeat(Math.max(0, line.depth));
    // Prefer the styled form so bold/italic/strike survive; fall back to plain
    // text when no HTML was available to derive it from.
    const body = line.markdown || escapeMarkdown(line.text);

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
        out.push(
          line.headingLevel > 0 ? `${"#".repeat(line.headingLevel)} ${body}` : body,
        );
        break;
    }
  }
  // Collapse trailing blanks; Notes adds its own spacing on append.
  while (out.length && out[out.length - 1] === "") out.pop();
  return out.join("\n");
}

/** Apply a checked-state change to specific checklist items. */
export function setChecked(
  lines: NoteLine[],
  predicate: (item: NoteLine) => boolean,
  value: boolean | "toggle",
): NoteLine[] {
  return lines.map((line) => {
    if (line.kind !== "checklist" || !predicate(line)) return line;
    return { ...line, checked: value === "toggle" ? !line.checked : value };
  });
}

/** Match checklist items by exact text, or by case-insensitive substring. */
export function matchByText(needle: string, exact = false) {
  const lowered = needle.toLowerCase();
  return (line: NoteLine) =>
    exact ? line.text === needle : line.text.toLowerCase().includes(lowered);
}

/** Match checklist items by their zero-based index. */
export function matchByIndex(indices: number[]) {
  const set = new Set(indices);
  return (line: NoteLine) => set.has(line.itemIndex);
}

/**
 * Overlay nesting depths (derived from the note's HTML) onto parsed lines.
 *
 * `depths` is indexed by `listIndex`, i.e. position among all list lines. When
 * the two sources disagree the caller passes an empty array and everything
 * stays flat -- guessing here would silently restructure the note.
 */
export function applyDepths(lines: NoteLine[], depths: number[]): NoteLine[] {
  if (depths.length === 0) return lines;
  return lines.map((line) =>
    line.listIndex >= 0 && line.listIndex < depths.length
      ? { ...line, depth: depths[line.listIndex] }
      : line,
  );
}

/**
 * Overlay per-line structure recovered from the note's HTML.
 *
 * `structure` is parallel to `lines`. An empty array leaves everything flat,
 * which is what happens when alignment could not be trusted.
 */
export function applyStructure(
  lines: NoteLine[],
  structure: { depth: number; headingLevel: number; markdown?: string }[],
): NoteLine[] {
  if (structure.length !== lines.length) return lines;
  return lines.map((line, i) => ({
    ...line,
    depth: line.listIndex >= 0 ? structure[i].depth : 0,
    headingLevel: line.kind === "text" ? structure[i].headingLevel : 0,
    markdown: structure[i].markdown ?? "",
  }));
}
