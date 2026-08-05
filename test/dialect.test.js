import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  dialectToHtml,
  dialectToMarkdown,
  linesToMarkdown,
  needsHtmlPhase,
  parseDialect,
  renderDialect,
  unwritableSpans,
} from "../dist/dialect.js";

/** Build a NoteLine as the readers produce them. */
const line = (over = {}) => ({
  kind: "text",
  text: "",
  checked: false,
  itemIndex: -1,
  depth: 0,
  listIndex: -1,
  ordinal: 0,
  headingLevel: 0,
  markdown: "",
  dialect: "",
  ...over,
});

describe("renderDialect", () => {
  it("emits checklist state and four-space nesting", () => {
    const out = renderDialect([
      line({ kind: "checklist", text: "Otter", checked: true }),
      line({ kind: "checklist", text: "Heron", checked: false }),
      line({ kind: "checklist", text: "Axolotl", checked: false, depth: 1 }),
    ]);
    assert.equal(out, "- [x] Otter\n- [ ] Heron\n    - [ ] Axolotl");
  });

  it("prefers the dialect form over markdown and plain text", () => {
    const out = renderDialect([
      line({ text: "plain", markdown: "**md**", dialect: "[rich]{color=#FF0505}" }),
    ]);
    assert.equal(out, "[rich]{color=#FF0505}");
  });

  it("falls back to markdown when no dialect was recovered", () => {
    assert.equal(renderDialect([line({ text: "plain", markdown: "**md**" })]), "**md**");
  });

  it("escapes a leader that would otherwise re-read as structure", () => {
    assert.equal(renderDialect([line({ text: "1. not a list" })]), "\\1. not a list");
  });

  it("renders headings, ordered items and bullets", () => {
    const out = renderDialect([
      line({ kind: "text", text: "Title", headingLevel: 2 }),
      line({ kind: "ordered", text: "first", ordinal: 1 }),
      line({ kind: "bullet", text: "loose" }),
    ]);
    assert.equal(out, "## Title\n1. first\n- loose");
  });
});

describe("parseDialect", () => {
  it("reads checklist state and depth", () => {
    const [a, b] = parseDialect("- [x] done\n    - [ ] nested");
    assert.equal(a.kind, "checklist");
    assert.equal(a.checked, true);
    assert.equal(b.depth, 1);
    assert.equal(b.checked, false);
  });

  it("accepts a hand-written two-space indent as one level", () => {
    const [, b] = parseDialect("- [ ] a\n  - [ ] b");
    assert.equal(b.depth, 1);
  });

  it("does not mistake a checklist item for a bullet", () => {
    assert.equal(parseDialect("- [ ] x")[0].kind, "checklist");
    assert.equal(parseDialect("- x")[0].kind, "bullet");
  });

  it("clamps heading depth to Notes' three levels", () => {
    assert.equal(parseDialect("##### deep")[0].headingLevel, 3);
  });

  it("unescapes a leader on the way back", () => {
    assert.equal(parseDialect("\\1. not a list")[0].text, "1. not a list");
  });
});

describe("round trip", () => {
  const documents = [
    "- [x] Otter\n- [ ] Heron\n    - [ ] Axolotl",
    "# Title\n\n- [ ] a\n    - [x] b\n- [ ] c",
    "## Snack Cats\n- [x] **Mochi**\n- [ ] Biscuit\n    - [x] Noodle",
    "1. first\n2. second\n    1. nested",
    "- plain bullet\n- another",
    "[red]{color=#FF0505} and [under]{u} and [link](x)",
    "text with **bold** and *italic* and ~~strike~~",
    "\\- not a bullet",
    "## a\n\n## b\n\n- [ ] c",
  ];

  for (const doc of documents) {
    it(`survives parse -> render: ${JSON.stringify(doc.slice(0, 40))}`, () => {
      const once = parseDialect(doc);
      const rendered = renderDialect(
        once.map((l) => ({
          ...line(),
          kind: l.kind === "heading" ? "text" : l.kind,
          text: l.text,
          dialect: l.text,
          checked: l.checked,
          depth: l.depth,
          ordinal: l.ordinal,
          headingLevel: l.headingLevel,
        })),
      );
      assert.deepEqual(parseDialect(rendered), once);
    });
  }
});

describe("needsHtmlPhase", () => {
  it("is true for colour and underline", () => {
    assert.equal(needsHtmlPhase(parseDialect("[x]{color=#FF0505}")[0]), true);
    assert.equal(needsHtmlPhase(parseDialect("[x]{u}")[0]), true);
  });

  it("is false for links, which no path can write", () => {
    assert.equal(needsHtmlPhase(parseDialect("[x]{link=https://e.com}")[0]), false);
  });

  it("is false for markdown-expressible styling", () => {
    assert.equal(needsHtmlPhase(parseDialect("**bold** ~~s~~")[0]), false);
  });
});

describe("unwritableSpans", () => {
  it("names links and nothing else", () => {
    assert.deepEqual(unwritableSpans(parseDialect("[x]{link=https://e.com}")[0]), ["links"]);
    assert.deepEqual(unwritableSpans(parseDialect("[x]{color=#FF0505}")[0]), []);
  });
});

describe("dialectToMarkdown", () => {
  it("collapses spans Markdown cannot express, keeping their text", () => {
    assert.equal(dialectToMarkdown("a [red]{color=#FF0505} b"), "a red b");
    assert.equal(dialectToMarkdown("a [u]{u} b"), "a u b");
  });

  it("leaves bold and strike alone", () => {
    assert.equal(dialectToMarkdown("**b** ~~s~~"), "**b** ~~s~~");
  });
});

describe("dialectToHtml", () => {
  it("writes colour and underline as tags Notes round-trips", () => {
    assert.equal(dialectToHtml("[x]{color=#FF0505}"), '<font color="#FF0505">x</font>');
    assert.equal(dialectToHtml("[x]{u}"), "<u>x</u>");
  });

  it("degrades a link to plain text rather than a bare underline", () => {
    assert.equal(dialectToHtml("[x]{link=https://e.com}"), "x");
  });

  it("converts markdown emphasis", () => {
    assert.equal(dialectToHtml("**b**"), "<b>b</b>");
    assert.equal(dialectToHtml("~~s~~"), "<strike>s</strike>");
  });

  it("escapes markup in the source text", () => {
    assert.equal(dialectToHtml("a < b & c"), "a &lt; b &amp; c");
  });
});

describe("linesToMarkdown", () => {
  it("drops unwritable spans and keeps structure", () => {
    const md = linesToMarkdown(parseDialect("- [x] [red]{color=#FF0505}\n    - [ ] b"));
    assert.equal(md, "- [x] red\n    - [ ] b");
  });
});
