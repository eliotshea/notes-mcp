/**
 * Extracting list nesting depth from a note's HTML.
 *
 * The App Intents `Body` property is the only source of checklist *state*, but
 * it flattens nesting: every list item comes back with exactly one leading tab
 * no matter how deeply it is indented. AppleScript's `body` HTML is the mirror
 * image -- it preserves nesting but carries no checked state.
 *
 * So structure comes from here and state comes from the bridge, zipped by
 * position. See docs/spike-findings.md §11.
 *
 * Notes nests lists as siblings rather than children, which is not how HTML is
 * normally written:
 *
 *   <ul>
 *     <li>parent</li>
 *     <ul><li>child</li></ul>   <-- sibling of the <li>, not inside it
 *   </ul>
 */

export interface HtmlListItem {
  text: string;
  /** 0 for a top-level item, 1 for one level of indent, and so on. */
  depth: number;
  /**
   * True when the item sits in an `Apple-dash-list`.
   *
   * Only a hint: AppleScript stamps one class on the whole `<ul>`, so a list
   * mixing bullets and checklist items reports the FIRST item's type for all of
   * them. The bridge is authoritative for list type; this is not.
   */
  dashList: boolean;
  /** True when the item sits in an `<ol>`. */
  ordered: boolean;
}

const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};

/**
 * Decode HTML entities, with or without the trailing semicolon.
 *
 * Notes emits malformed entities: `&amp&amp` renders as `&&`, and escaped
 * markup arrives as `&ltu&gt`. Requiring the semicolon left these undecoded,
 * so the text comparison in `alignDepths` failed and affected notes -- such as
 * `Cleaning Schedule` -- were refused rather than rebuilt.
 */
// Without a trailing semicolon a greedy `[a-z]+` over-consumes -- `&ltu&gt`
// would match the name "ltu" and decode nothing. Match known names explicitly,
// longest first, so `&lt` is recognised even when `u` follows it.
const ENTITY_NAMES = Object.keys(ENTITIES)
  .sort((a, b) => b.length - a.length)
  .join("|");
const ENTITY_RE = new RegExp(`&(#x[0-9a-f]+|#\\d+|${ENTITY_NAMES});?`, "gi");

export function decodeEntities(s: string): string {
  return s.replace(ENTITY_RE, (whole, body: string) => {
    if (body[0] === "#") {
      const code =
        body[1] === "x" || body[1] === "X"
          ? Number.parseInt(body.slice(2), 16)
          : Number.parseInt(body.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : whole;
    }
    return ENTITIES[body.toLowerCase()] ?? whole;
  });
}

/** Strip inline markup (`<span>`, `<b>`, ...) and decode entities. */
function textOf(html: string): string {
  return decodeEntities(html.replace(/<[^>]*>/g, "")).replace(/ /g, " ").trim();
}

/** Apply a Markdown delimiter, keeping surrounding spaces outside it. */
function wrapInline(inner: string, delim: string): string {
  const text = inner.replace(/<[^>]*>/g, "");
  const m = text.match(/^(\s*)([\s\S]*?)(\s*)$/);
  if (!m || !m[2]) return text;
  return `${m[1]}${delim}${m[2]}${delim}${m[3]}`;
}

/**
 * Convert a block's inline markup to Markdown.
 *
 * AppleScript's HTML carries `<b>`, `<i>` and `<strike>`, and Notes' Markdown
 * importer round-trips all three -- they were lost on rebuild only because the
 * renderer emitted plain text.
 *
 * Text colour (`<font color>`) is deliberately NOT emitted: Markdown cannot
 * express it and the importer escapes raw HTML, so there is no way to write it
 * back. `describeInlineLoss` reports it instead of pretending otherwise.
 */
export function inlineMarkdown(html: string): string {
  let s = html
    .replace(/<\/?(span|font|div|p)\b[^>]*>/gi, "")
    .replace(/<br\s*\/?>/gi, "");

  s = s
    .replace(/<(b|strong)\b[^>]*>([\s\S]*?)<\/\1\s*>/gi, (_m, _t, inner) => wrapInline(inner, "**"))
    .replace(/<(i|em)\b[^>]*>([\s\S]*?)<\/\1\s*>/gi, (_m, _t, inner) => wrapInline(inner, "*"))
    .replace(/<(s|strike|del)\b[^>]*>([\s\S]*?)<\/\1\s*>/gi, (_m, _t, inner) =>
      wrapInline(inner, "~~"),
    );

  return textOf(s);
}

/**
 * Convert a block's inline markup to the edit dialect.
 *
 * Where `inlineMarkdown` drops everything Markdown cannot express, this keeps
 * it, using bracketed spans for the three constructs Markdown has no syntax
 * for. See docs/dialect.md.
 *
 *   <font color="#FF0505">x</font>  ->  [x]{color=#FF0505}
 *   <u>x</u>                        ->  [x]{u}
 *   <a href="u">x</a>               ->  [x]{link=u}
 *
 * Colour and underline are writable through the AppleScript HTML phase; links
 * are not writable at all and round-trip only as a read-only token.
 */
export function inlineDialect(html: string): string {
  let s = html
    .replace(/<\/?(span|div|p)\b[^>]*>/gi, "")
    .replace(/<br\s*\/?>/gi, "");

  // Anchors first: Notes renders them with an underline, so an <a> nested in a
  // <u> would otherwise be reported twice.
  s = s.replace(
    /<a\b[^>]*href=["']([^"']*)["'][^>]*>([\s\S]*?)<\/a\s*>/gi,
    (_m, href: string, inner: string) => `[${textOf(inner)}]{link=${decodeEntities(href)}}`,
  );

  s = s.replace(
    /<font\b[^>]*color=["']?(#[0-9a-f]{3,8})["']?[^>]*>([\s\S]*?)<\/font\s*>/gi,
    (_m, colour: string, inner: string) => {
      const body = inlineDialect(inner);
      return body.trim() ? `[${body.trim()}]{color=${colour.toUpperCase()}}` : body;
    },
  );
  s = s.replace(/<\/?font\b[^>]*>/gi, "");

  s = s.replace(/<u\b[^>]*>([\s\S]*?)<\/u\s*>/gi, (_m, inner: string) => {
    const body = inlineDialect(inner);
    return body.trim() ? `[${body.trim()}]{u}` : body;
  });

  s = s
    .replace(/<(b|strong)\b[^>]*>([\s\S]*?)<\/\1\s*>/gi, (_m, _t, inner) => wrapInline(inner, "**"))
    .replace(/<(i|em)\b[^>]*>([\s\S]*?)<\/\1\s*>/gi, (_m, _t, inner) => wrapInline(inner, "*"))
    .replace(/<(s|strike|del)\b[^>]*>([\s\S]*?)<\/\1\s*>/gi, (_m, _t, inner) =>
      wrapInline(inner, "~~"),
    );

  return textOf(s);
}

/** Inline constructs in a note's HTML that a rebuild cannot write back. */
export function describeInlineLoss(html: string): string[] {
  const lost: string[] = [];
  const colours = html.match(/<font[^>]*color=/gi) ?? [];
  if (colours.length) lost.push(`${colours.length} coloured text run(s)`);
  if (/<u\b/i.test(html)) lost.push("underlined text");
  if (/<a\b/i.test(html)) lost.push("links");
  if (/<blockquote\b/i.test(html)) lost.push("block quotes");
  return lost;
}


/**
 * A top-level block of a note's HTML, in document order.
 *
 * Notes lays a note out as a flat sequence of `<div>` paragraphs and
 * `<ul>`/`<ol>` lists; only lists nest. Each block corresponds to exactly one
 * line of the bridge body, which is what makes them alignable.
 */
export interface HtmlBlock {
  kind: "heading" | "text" | "blank" | "item";
  /** 1-3 for headings (Title / Heading / Subheading), 0 otherwise. */
  level: number;
  text: string;
  /** List nesting depth; 0 for non-items. */
  depth: number;
  ordered: boolean;
  dashList: boolean;
  /** The block's text with bold/italic/strike expressed as Markdown. */
  markdown: string;
  /** The block's text in the edit dialect, keeping colour, underline, links. */
  dialect: string;
}

/**
 * Parse a note's HTML into ordered blocks.
 *
 * The first block is the note's title, which the bridge body omits -- callers
 * aligning against the bridge must drop it.
 */
export function parseHtmlBlocks(html: string): HtmlBlock[] {
  const blocks: HtmlBlock[] = [];
  const stack: { dashList: boolean; ordered: boolean }[] = [];

  const token =
    /<(ul|ol)\b([^>]*)>|<\/(?:ul|ol)\s*>|<li\b[^>]*>([\s\S]*?)<\/li\s*>|<div\b[^>]*>([\s\S]*?)<\/div\s*>/gi;
  let m: RegExpExecArray | null;

  while ((m = token.exec(html)) !== null) {
    const [whole, openTag, attrs, liInner, divInner] = m;

    if (openTag) {
      stack.push({
        dashList: /Apple-dash-list/i.test(attrs ?? ""),
        ordered: openTag.toLowerCase() === "ol",
      });
      continue;
    }
    if (whole.toLowerCase().startsWith("</")) {
      stack.pop();
      continue;
    }
    if (liInner !== undefined) {
      const top = stack[stack.length - 1];
      blocks.push({
        kind: "item",
        level: 0,
        text: textOf(liInner),
        markdown: inlineMarkdown(liInner),
        dialect: inlineDialect(liInner),
        depth: Math.max(0, stack.length - 1),
        ordered: top?.ordered ?? false,
        dashList: top?.dashList ?? false,
      });
      continue;
    }
    if (divInner !== undefined) {
      // A div inside a list is layout noise, not a paragraph.
      if (stack.length) continue;
      const heading = divInner.match(/<h([1-3])\b/i);
      const text = textOf(divInner);
      blocks.push({
        kind: text === "" ? "blank" : heading ? "heading" : "text",
        level: heading ? Number(heading[1]) : 0,
        text,
        markdown: inlineMarkdown(divInner),
        dialect: inlineDialect(divInner),
        depth: 0,
        ordered: false,
        dashList: false,
      });
    }
  }
  return blocks;
}

/**
 * Walk a note's HTML and return every list item with its nesting depth, in
 * document order -- the same order the bridge returns them in.
 */
export function parseHtmlList(html: string): HtmlListItem[] {
  const items: HtmlListItem[] = [];
  // Track the stack of open lists so depth is just its height.
  const stack: { dashList: boolean; ordered: boolean }[] = [];

  // <ol> must be matched too: ordered items appear in the bridge as `\tN.\t`,
  // and omitting them here made the item counts disagree, which failed
  // alignment and blocked every numbered-list note.
  const token = /<(ul|ol)\b([^>]*)>|<\/(?:ul|ol)\s*>|<li\b[^>]*>([\s\S]*?)<\/li\s*>/gi;
  let m: RegExpExecArray | null;

  while ((m = token.exec(html)) !== null) {
    const [whole, openTag, attrs, liInner] = m;
    const lower = whole.toLowerCase();
    if (openTag) {
      stack.push({
        dashList: /Apple-dash-list/i.test(attrs ?? ""),
        ordered: openTag.toLowerCase() === "ol",
      });
    } else if (lower.startsWith("</")) {
      stack.pop();
    } else {
      const top = stack[stack.length - 1];
      items.push({
        text: textOf(liInner ?? ""),
        depth: Math.max(0, stack.length - 1),
        dashList: top?.dashList ?? false,
        ordered: top?.ordered ?? false,
      });
    }
  }
  return items;
}

/**
 * Align bridge-derived items with HTML-derived depths.
 *
 * Both enumerate list items in document order, so position is normally enough.
 * Text is compared as a safety check: if the two sources disagree, depth
 * information is discarded rather than applied to the wrong items, since a
 * wrong indent silently restructures the user's note.
 */
/** Structure recovered from HTML for one bridge line. */
export interface LineStructure {
  depth: number;
  /** 1-3 for headings, 0 otherwise. */
  headingLevel: number;
  /** Text with bold/italic/strike as Markdown, or "" when unavailable. */
  markdown: string;
  /** Text in the edit dialect, or "" when unavailable. */
  dialect: string;
}

/**
 * Align every bridge line with its HTML block, recovering both nesting depth
 * and heading level.
 *
 * The bridge body flattens nesting AND strips heading levels -- `<h1>`, `<h2>`
 * and `<h3>` all arrive as ordinary prose -- so neither survives without this.
 * Blocks and lines correspond one-to-one once the title block is dropped.
 *
 * Text is compared as a guard. On any disagreement the caller is told alignment
 * failed and nothing is overlaid, because applying structure to the wrong lines
 * would silently restructure the note.
 */
export function alignBlocks(
  bridgeLines: { text: string; isList: boolean }[],
  blocks: HtmlBlock[],
): { structure: LineStructure[]; aligned: boolean } {
  const flat = bridgeLines.map(() => ({ depth: 0, headingLevel: 0, markdown: "", dialect: "" }));
  // The first block is the title, which the bridge omits.
  const body = blocks.length && blocks[0].kind !== "item" ? blocks.slice(1) : blocks;

  // The bridge body ends with a newline, producing a trailing blank line that
  // has no HTML block behind it. Ignore trailing blanks on both sides.
  const isBlank = (l: { text: string; isList: boolean }) => !l.isList && l.text.trim() === "";
  let n = bridgeLines.length;
  while (n > 0 && isBlank(bridgeLines[n - 1])) n--;
  let bn = body.length;
  while (bn > 0 && body[bn - 1].kind === "blank") bn--;

  if (bn !== n) return { structure: flat, aligned: false };

  const norm = (s: string) => s.replace(/\s+/g, " ").trim();
  for (let i = 0; i < n; i++) {
    if (bridgeLines[i].isList !== (body[i].kind === "item")) {
      return { structure: flat, aligned: false };
    }
    if (norm(bridgeLines[i].text) !== norm(body[i].text)) {
      return { structure: flat, aligned: false };
    }
  }

  const structure = flat.map((f, i) =>
    i < n
      ? {
          depth: body[i].depth,
          headingLevel: body[i].level,
          markdown: body[i].markdown,
          dialect: body[i].dialect,
        }
      : f,
  );
  return { structure, aligned: true };
}

export function alignDepths(
  bridgeTexts: string[],
  htmlItems: HtmlListItem[],
): { depths: number[]; aligned: boolean } {
  const flat = new Array(bridgeTexts.length).fill(0);
  if (htmlItems.length !== bridgeTexts.length) {
    return { depths: flat, aligned: false };
  }
  const norm = (s: string) => s.replace(/\s+/g, " ").trim();
  for (let i = 0; i < bridgeTexts.length; i++) {
    if (norm(bridgeTexts[i]) !== norm(htmlItems[i].text)) {
      return { depths: flat, aligned: false };
    }
  }
  return { depths: htmlItems.map((h) => h.depth), aligned: true };
}
