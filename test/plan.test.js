import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseDialect } from "../dist/dialect.js";
import { planWrite } from "../dist/plan.js";

const state = (text, over = {}) => ({
  lines: parseDialect(text),
  opaque: [],
  nestingResolved: true,
  ...over,
});

const kinds = (plan) => plan.ops.map((o) => o.kind);

describe("planWrite", () => {
  it("rule 1: identical documents do nothing", () => {
    const doc = "- [x] a\n- [ ] b";
    const plan = planWrite(state(doc), parseDialect(doc));
    assert.equal(plan.rule, "no-op");
    assert.deepEqual(plan.ops, []);
    assert.equal(plan.rewrote, false);
  });

  it("rule 2: appending never rewrites the note", () => {
    const plan = planWrite(state("- [x] a"), parseDialect("- [x] a\n- [ ] b"));
    assert.equal(plan.rule, "pure-append");
    assert.equal(plan.rewrote, false);
    assert.deepEqual(plan.preserved, ["all existing content"]);
  });

  it("rule 2: an appended checklist goes through the per-item intent", () => {
    const plan = planWrite(state("# notes"), parseDialect("# notes\n- [ ] milk"));
    assert.deepEqual(kinds(plan), ["append-checklist-items"]);
  });

  it("rule 2: mixed appended content falls back to a markdown append", () => {
    const plan = planWrite(state("# notes"), parseDialect("# notes\n## more\n- [ ] milk"));
    assert.deepEqual(kinds(plan), ["append-markdown"]);
  });

  it("rule 2 beats the guards: appending to a note holding an image is allowed", () => {
    const plan = planWrite(
      state("- [ ] a", { opaque: ["images"] }),
      parseDialect("- [ ] a\n- [ ] b"),
    );
    assert.equal(plan.rule, "pure-append");
    assert.equal(plan.rewrote, false);
  });

  it("rule 3: no rich inline means one markdown pass", () => {
    const plan = planWrite(state("- [x] a\n- [ ] b"), parseDialect("- [ ] a\n- [ ] b"));
    assert.equal(plan.rule, "markdown-only");
    assert.deepEqual(kinds(plan), ["clear-body", "append-markdown"]);
    assert.equal(plan.rewrote, true);
  });

  it("rule 4: a note without checklists keeps colour and underline", () => {
    const plan = planWrite(state("hello"), parseDialect("[hello]{color=#FF0505}"));
    assert.equal(plan.rule, "html-only");
    assert.deepEqual(kinds(plan), ["set-html"]);
    assert.ok(plan.preserved.includes("colour"));
  });

  it("rule 5: rich content before checklists splits into two writes", () => {
    const plan = planWrite(
      state("x"),
      parseDialect("[header]{color=#FF0505}\n- [ ] a\n- [x] b"),
    );
    assert.equal(plan.rule, "split");
    assert.deepEqual(kinds(plan), ["set-html", "append-markdown"]);
    assert.ok(plan.preserved.includes("colour"));
    assert.ok(plan.preserved.includes("checklist state"));
    // the boundary must fall exactly at the first checklist item
    assert.equal(plan.ops[0].lines.length, 1);
    assert.equal(plan.ops[1].lines.length, 2);
  });

  it("rule 6: refuses to rewrite a note holding content it cannot recreate", () => {
    const plan = planWrite(
      state("- [x] a", { opaque: ["images"] }),
      parseDialect("- [ ] a"),
    );
    assert.equal(plan.rule, "guarded");
    assert.deepEqual(plan.ops, []);
    assert.match(plan.refusal, /images/);
  });

  it("rule 6: refuses when nesting could not be recovered", () => {
    const plan = planWrite(
      state("- [x] a", { nestingResolved: false }),
      parseDialect("- [ ] a"),
    );
    assert.equal(plan.rule, "guarded");
    assert.match(plan.refusal, /flatten/);
  });

  it("rule 7: colour below a checklist is unreachable and says which line", () => {
    const plan = planWrite(
      state("x"),
      parseDialect("- [ ] a\n[footer]{color=#FF0505}"),
    );
    assert.equal(plan.rule, "conflict");
    assert.deepEqual(plan.ops, []);
    assert.match(plan.refusal, /line 2/);
  });

  it("rule 7: keep-checklists drops the colour and writes markdown", () => {
    const plan = planWrite(
      state("x"),
      parseDialect("- [ ] a\n[footer]{color=#FF0505}"),
      "keep-checklists",
    );
    assert.equal(plan.rule, "markdown-only");
    assert.ok(plan.lost.includes("colour"));
    assert.equal(plan.ops[1].lines[1].text, "footer");
  });

  it("rule 7: keep-formatting writes html and says the boxes are gone", () => {
    const plan = planWrite(
      state("x"),
      parseDialect("- [ ] a\n[footer]{color=#FF0505}"),
      "keep-formatting",
    );
    assert.equal(plan.rule, "html-only");
    assert.ok(plan.lost.some((l) => /plain bullets/.test(l)));
  });

  it("every rewrite reports highlighting as lost, and no append does", () => {
    const rewrite = planWrite(state("- [x] a"), parseDialect("- [ ] a"));
    assert.ok(rewrite.lost.some((l) => /highlighting/.test(l)));
    const append = planWrite(state("- [x] a"), parseDialect("- [x] a\n- [ ] b"));
    assert.ok(!append.lost.some((l) => /highlighting/.test(l)));
  });

  it("reports links as lost when the target still carries one", () => {
    const plan = planWrite(state("x"), parseDialect("[a]{link=https://e.com}"));
    assert.ok(plan.lost.includes("links"));
  });
});
