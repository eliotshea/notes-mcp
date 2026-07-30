import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  MARKER_BULLET,
  MARKER_CHECKED,
  MARKER_UNCHECKED,
  hasChecklist,
  matchByIndex,
  matchByText,
  parseBody,
  parseChecklist,
  renderMarkdown,
  setChecked,
} from "../dist/checklist.js";

/**
 * Captured verbatim from real bridge output, so the tests are anchored to what
 * Apple Notes actually emits rather than to assumptions.
 *
 * Note the body does NOT contain the note's title -- Notes exposes that
 * separately as `Name`. Here the leading "E5 markdown fidelity" line is a real
 * `## heading` inside the body that happens to repeat the title.
 */
const REAL_BODY = [
  "E5 markdown fidelity",
  "",
  "\t◦\tunchecked-item-one",
  "\t✓\tchecked-item-two",
  "\t◦\tunchecked-item-three",
  "",
  "Plain bold and italic text.",
  "",
  "\t⁃\tordinary bullet",
].join("\n");

/**
 * Also captured verbatim: a note whose first line IS a list item. The leading
 * tab is stripped from the first line of the returned body.
 */
const BODY_LEADING_ITEM = "✓\tsetup-probe-item\n\t◦\tsecond-item\n";

describe("markers", () => {
  it("uses the codepoints Notes actually emits", () => {
    assert.equal(MARKER_UNCHECKED, "◦");
    assert.equal(MARKER_CHECKED, "✓");
    assert.equal(MARKER_BULLET, "⁃");
  });
});

describe("parseBody", () => {
  const lines = parseBody(REAL_BODY);

  it("treats a non-list first line as text", () => {
    assert.equal(lines[0].kind, "text");
    assert.equal(lines[0].text, "E5 markdown fidelity");
  });

  it("parses a first-line list item despite its stripped leading tab", () => {
    const l = parseBody(BODY_LEADING_ITEM);
    assert.equal(l[0].kind, "checklist");
    assert.equal(l[0].checked, true);
    assert.equal(l[0].text, "setup-probe-item");
    assert.equal(l[1].kind, "checklist");
    assert.equal(l[1].checked, false);
    assert.equal(l[1].text, "second-item");
  });

  it("does not mistake tab-containing prose for a list item", () => {
    const l = parseBody("some\tprose here");
    assert.equal(l[0].kind, "text");
  });

  it("distinguishes checked from unchecked items", () => {
    assert.equal(lines[2].kind, "checklist");
    assert.equal(lines[2].checked, false);
    assert.equal(lines[3].kind, "checklist");
    assert.equal(lines[3].checked, true);
  });

  it("does NOT treat an ordinary bullet as a checklist item", () => {
    const bullet = lines.find((l) => l.text === "ordinary bullet");
    assert.equal(bullet.kind, "bullet");
    assert.equal(bullet.itemIndex, -1);
  });

  it("numbers checklist items consecutively, ignoring bullets", () => {
    const items = lines.filter((l) => l.kind === "checklist");
    assert.deepEqual(
      items.map((i) => i.itemIndex),
      [0, 1, 2],
    );
  });

  it("preserves blank lines", () => {
    assert.equal(lines[1].kind, "blank");
  });
});

describe("parseChecklist", () => {
  it("returns only checklist items with state", () => {
    // depth is 0 until the caller overlays it from the note's HTML
    assert.deepEqual(parseChecklist(REAL_BODY), [
      { index: 0, text: "unchecked-item-one", checked: false, depth: 0 },
      { index: 1, text: "checked-item-two", checked: true, depth: 0 },
      { index: 2, text: "unchecked-item-three", checked: false, depth: 0 },
    ]);
  });

  it("returns nothing for a note with no checklist", () => {
    assert.deepEqual(parseChecklist("Title\n\nJust prose."), []);
    assert.equal(hasChecklist("Title\n\n\t⁃\tbullet only"), false);
    assert.equal(hasChecklist(REAL_BODY), true);
  });
});

describe("setChecked", () => {
  const lines = parseBody(REAL_BODY);

  it("unchecks everything (the workout-reset case)", () => {
    const out = setChecked(lines, () => true, false);
    assert.equal(out.filter((l) => l.kind === "checklist" && l.checked).length, 0);
  });

  it("toggles rather than assigns when asked", () => {
    const out = setChecked(lines, () => true, "toggle");
    assert.deepEqual(
      out.filter((l) => l.kind === "checklist").map((l) => l.checked),
      [true, false, true],
    );
  });

  it("never converts an ordinary bullet into a checklist item", () => {
    const out = setChecked(lines, () => true, true);
    const bullet = out.find((l) => l.text === "ordinary bullet");
    assert.equal(bullet.kind, "bullet");
  });

  it("selects by index", () => {
    const out = setChecked(lines, matchByIndex([0, 2]), true);
    assert.deepEqual(
      out.filter((l) => l.kind === "checklist").map((l) => l.checked),
      [true, true, true],
    );
  });

  it("selects by case-insensitive substring", () => {
    const out = setChecked(lines, matchByText("ITEM-ONE"), true);
    assert.equal(out[2].checked, true);
    assert.equal(out[4].checked, false);
  });

  it("honours exact matching", () => {
    const out = setChecked(lines, matchByText("unchecked-item", true), true);
    assert.equal(out.filter((l) => l.kind === "checklist" && l.checked).length, 1);
  });
});

describe("renderMarkdown", () => {
  it("round-trips structure and state, losing no lines", () => {
    const md = renderMarkdown(parseBody(REAL_BODY));
    assert.equal(
      md,
      [
        "E5 markdown fidelity",
        "",
        "- [ ] unchecked-item-one",
        "- [x] checked-item-two",
        "- [ ] unchecked-item-three",
        "",
        "Plain bold and italic text.",
        "",
        "- ordinary bullet",
      ].join("\n"),
    );
  });

  it("renders a first-line item that arrived without its leading tab", () => {
    assert.equal(
      renderMarkdown(parseBody(BODY_LEADING_ITEM)),
      "- [x] setup-probe-item\n- [ ] second-item",
    );
  });

  it("can drop a leading heading that repeats the title", () => {
    const md = renderMarkdown(parseBody(REAL_BODY), { skipFirstText: true });
    assert.ok(!md.startsWith("E5 markdown fidelity"));
  });

  it("escapes text that would otherwise become a list item", () => {
    const lines = parseBody("Title\n\n\t◦\t- [x] literal text");
    const md = renderMarkdown(lines);
    assert.ok(md.includes("\\-"), `expected escaping, got: ${md}`);
    // re-parsing must not see a nested checklist
    assert.equal(md.split("\n").filter((l) => l.startsWith("- [")).length, 1);
  });

  it("survives a full parse -> render -> parse cycle", () => {
    const once = renderMarkdown(parseBody(REAL_BODY));
    // simulate Notes converting the markdown back into marker form
    const asBody = [...once.split("\n")]
      .map((l) =>
        l.startsWith("- [x] ")
          ? `\t✓\t${l.slice(6)}`
          : l.startsWith("- [ ] ")
            ? `\t◦\t${l.slice(6)}`
            : l.startsWith("- ")
              ? `\t⁃\t${l.slice(2)}`
              : l,
      )
      .join("\n");
    assert.deepEqual(parseChecklist(asBody), parseChecklist(REAL_BODY));
  });
});

describe("edge cases", () => {
  it("handles an empty body", () => {
    assert.deepEqual(parseChecklist(""), []);
    assert.equal(renderMarkdown(parseBody("")), "");
  });

  it("handles items containing tabs in their text", () => {
    const items = parseChecklist("T\n\t◦\ta\tb");
    assert.equal(items.length, 1);
    assert.equal(items[0].text, "a\tb");
  });

  it("treats an unknown marker as an ordinary bullet", () => {
    const lines = parseBody("T\n\t•\tmystery");
    assert.equal(lines[1].kind, "bullet");
  });
});
