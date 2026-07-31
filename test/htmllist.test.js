import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  alignBlocks,
  alignDepths,
  decodeEntities,
  parseHtmlBlocks,
  parseHtmlList,
} from "../dist/htmllist.js";
import { applyDepths, parseBody, renderMarkdown } from "../dist/checklist.js";

/**
 * Captured verbatim from Notes. Note that Notes nests lists as SIBLINGS of the
 * <li> they belong under, not as children of it.
 */
const NESTED_HTML = `<div><span style="font-size: 11px">probe</span></div>
<ul>
<li>Barbell squat</li>
<ul>
<li>Set 1: 135</li>
<li>Set 2: 225</li>
</ul>
<li>Hip thrust</li>
<ul>
<li>Set 1</li>
<ul>
<li>deep nested</li>
</ul>
</ul>
<li>plain bullet</li>
<ul class="Apple-dash-list">
<li>nested plain bullet</li>
</ul>
</ul>
`;

/** The same note as seen through the bridge -- note that ALL depth is lost. */
const NESTED_BODY =
  "◦\tBarbell squat\n\t◦\tSet 1: 135\n\t✓\tSet 2: 225\n\t✓\tHip thrust\n" +
  "\t◦\tSet 1\n\t◦\tdeep nested\n\t⁃\tplain bullet\n\t⁃\tnested plain bullet\n";

describe("parseHtmlList", () => {
  const items = parseHtmlList(NESTED_HTML);

  it("finds every list item in document order", () => {
    assert.deepEqual(
      items.map((i) => i.text),
      [
        "Barbell squat",
        "Set 1: 135",
        "Set 2: 225",
        "Hip thrust",
        "Set 1",
        "deep nested",
        "plain bullet",
        "nested plain bullet",
      ],
    );
  });

  it("recovers nesting depth, including two levels", () => {
    assert.deepEqual(
      items.map((i) => i.depth),
      [0, 1, 1, 0, 1, 2, 0, 1],
    );
  });

  it("flags dash lists (ordinary bullets)", () => {
    assert.equal(items.at(-1).dashList, true);
    assert.equal(items[0].dashList, false);
  });

  it("strips inline markup from item text", () => {
    const one = parseHtmlList("<ul><li><b>bold</b> and <i>italic</i></li></ul>");
    assert.equal(one[0].text, "bold and italic");
  });

  it("decodes entities", () => {
    assert.equal(decodeEntities("a &amp; b &lt;c&gt; &#39;d&#39; &#x27;e&#x27;"), "a & b <c> 'd' 'e'");
    const one = parseHtmlList("<ul><li>Tom &amp; Jerry</li></ul>");
    assert.equal(one[0].text, "Tom & Jerry");
  });

  it("returns nothing for HTML with no lists", () => {
    assert.deepEqual(parseHtmlList("<div>just prose</div>"), []);
  });
});

describe("alignDepths", () => {
  const html = parseHtmlList(NESTED_HTML);
  const bodyTexts = parseBody(NESTED_BODY)
    .filter((l) => l.listIndex >= 0)
    .map((l) => l.text);

  it("aligns the two sources and yields real depths", () => {
    const { depths, aligned } = alignDepths(bodyTexts, html);
    assert.equal(aligned, true);
    assert.deepEqual(depths, [0, 1, 1, 0, 1, 2, 0, 1]);
  });

  it("refuses to align when counts differ", () => {
    const { depths, aligned } = alignDepths(bodyTexts.slice(0, 3), html);
    assert.equal(aligned, false);
    assert.ok(depths.every((d) => d === 0));
  });

  it("refuses to align when text disagrees", () => {
    const mismatched = [...bodyTexts];
    mismatched[2] = "something else entirely";
    const { aligned } = alignDepths(mismatched, html);
    assert.equal(aligned, false);
  });
});

describe("depth round trip", () => {
  it("renders nesting Notes will import back at the same depths", () => {
    const { depths } = alignDepths(
      parseBody(NESTED_BODY).filter((l) => l.listIndex >= 0).map((l) => l.text),
      parseHtmlList(NESTED_HTML),
    );
    const lines = applyDepths(parseBody(NESTED_BODY), depths);
    assert.equal(
      renderMarkdown(lines),
      [
        "- [ ] Barbell squat",
        "    - [ ] Set 1: 135",
        "    - [x] Set 2: 225",
        "- [x] Hip thrust",
        "    - [ ] Set 1",
        "        - [ ] deep nested",
        "- plain bullet",
        "    - nested plain bullet",
      ].join("\n"),
    );
  });

  it("stays flat when depths could not be recovered", () => {
    const lines = applyDepths(parseBody(NESTED_BODY), []);
    const md = renderMarkdown(lines);
    assert.ok(!md.includes("    "), "expected no indentation");
  });
});

describe("decodeEntities (malformed, no semicolon)", () => {
  it("decodes entities Notes writes without a trailing semicolon", () => {
    // Notes stores `&amp&amp` for `&&` and escapes markup as `&ltu&gt`.
    // Requiring the semicolon left these undecoded, which broke alignment.
    assert.equal(decodeEntities("Sheets &amp&amp Blankets"), "Sheets && Blankets");
    assert.equal(decodeEntities("&ltu&gtx&lt/u&gt"), "<u>x</u>");
  });

  it("still decodes well-formed entities", () => {
    assert.equal(decodeEntities("a &amp; b"), "a & b");
  });
});

describe("parseHtmlBlocks", () => {
  const HTML = [
    "<div>The Title</div>",
    "<div><b><h1>Big</h1></b></div>",
    "<div><br></div>",
    "<div>prose</div>",
    "<div><h2>Medium</h2></div>",
    "<ol>",
    "<li>one</li>",
    "<li>two</li>",
    "</ol>",
    "<ul>",
    "<li>todo</li>",
    "<ul><li>nested</li></ul>",
    "</ul>",
  ].join("\n");
  const blocks = parseHtmlBlocks(HTML);

  it("returns blocks in document order, title first", () => {
    assert.equal(blocks[0].text, "The Title");
    assert.deepEqual(
      blocks.map((b) => b.kind),
      ["text", "heading", "blank", "text", "heading", "item", "item", "item", "item"],
    );
  });

  it("captures heading levels", () => {
    assert.equal(blocks[1].level, 1);
    assert.equal(blocks[4].level, 2);
    assert.equal(blocks[3].level, 0);
  });

  it("marks ordered items and records list depth", () => {
    const items = blocks.filter((b) => b.kind === "item");
    assert.deepEqual(items.map((i) => i.ordered), [true, true, false, false]);
    assert.deepEqual(items.map((i) => i.depth), [0, 0, 0, 1]);
  });
});

describe("alignBlocks", () => {
  const HTML = [
    "<div>Title</div>",
    "<div><h1>Head</h1></div>",
    "<div><br></div>",
    "<ul><li>a</li><ul><li>b</li></ul></ul>",
  ].join("\n");
  const lines = [
    { text: "Head", isList: false },
    { text: "", isList: false },
    { text: "a", isList: true },
    { text: "b", isList: true },
  ];

  it("recovers heading level and nesting depth together", () => {
    const { structure, aligned } = alignBlocks(lines, parseHtmlBlocks(HTML));
    assert.equal(aligned, true);
    assert.deepEqual(structure.map((s) => s.headingLevel), [1, 0, 0, 0]);
    assert.deepEqual(structure.map((s) => s.depth), [0, 0, 0, 1]);
  });

  it("tolerates the trailing blank line the bridge always emits", () => {
    const withTrailing = [...lines, { text: "", isList: false }];
    assert.equal(alignBlocks(withTrailing, parseHtmlBlocks(HTML)).aligned, true);
  });

  it("refuses when a line is a list item but its block is not", () => {
    const swapped = [...lines];
    swapped[0] = { text: "Head", isList: true };
    assert.equal(alignBlocks(swapped, parseHtmlBlocks(HTML)).aligned, false);
  });

  it("refuses when text disagrees", () => {
    const changed = [...lines];
    changed[2] = { text: "different", isList: true };
    const { structure, aligned } = alignBlocks(changed, parseHtmlBlocks(HTML));
    assert.equal(aligned, false);
    assert.ok(structure.every((s) => s.depth === 0 && s.headingLevel === 0));
  });
});
