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
  /** True when the item sits in a `Apple-dash-list`, i.e. an ordinary bullet. */
  dashList: boolean;
}

const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};

export function decodeEntities(s: string): string {
  return s.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (whole, body: string) => {
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

/**
 * Walk a note's HTML and return every list item with its nesting depth, in
 * document order -- the same order the bridge returns them in.
 */
export function parseHtmlList(html: string): HtmlListItem[] {
  const items: HtmlListItem[] = [];
  // Track the stack of open <ul>s so depth is just its height.
  const stack: { dashList: boolean }[] = [];

  const token = /<ul\b([^>]*)>|<\/ul\s*>|<li\b[^>]*>([\s\S]*?)<\/li\s*>/gi;
  let m: RegExpExecArray | null;

  while ((m = token.exec(html)) !== null) {
    const [whole, ulAttrs, liInner] = m;
    if (whole.toLowerCase().startsWith("<ul")) {
      stack.push({ dashList: /Apple-dash-list/i.test(ulAttrs ?? "") });
    } else if (whole.toLowerCase().startsWith("</ul")) {
      stack.pop();
    } else {
      const depth = Math.max(0, stack.length - 1);
      items.push({
        text: textOf(liInner ?? ""),
        depth,
        dashList: stack[stack.length - 1]?.dashList ?? false,
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
