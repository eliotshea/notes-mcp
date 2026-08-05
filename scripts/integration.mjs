/**
 * docs/edit-model.md Part 6, against real Notes.
 *
 * Not part of `npm test`: it drives the real Notes app, needs the bridge
 * shortcuts installed, and creates and deletes a note in the "test" folder.
 *
 *   npm run build && node scripts/integration.mjs
 */
import * as as from "../dist/applescript.js";
import * as notes from "../dist/notes.js";

const G = "[32m", R = "[31m", D = "[2m", B = "[1m", X = "[0m";
let failures = 0;
const ok = (m) => console.log(`${G}✓${X} ${m}`);
const bad = (m) => { failures++; console.log(`${R}✗${X} ${m}`); };

const NOTE = "IntegrationProbe";

async function fresh(content) {
  for (const n of await as.findNotesByName(NOTE)) await as.deleteNote(n.id);
  await notes.createNote(NOTE, content, "test");
  for (let i = 0; i < 20; i++) {
    const c = await notes.readNote(NOTE).catch(() => null);
    if (c && c.dialect.trim()) return c;
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error("note never became readable");
}

async function main() {
  console.log(`\n${B}Integration: edit model against real Notes${X}\n`);

  // ---- 1. round trip: read dialect, write it straight back, unchanged
  console.log(`${B}1. dialect round-trip${X}`);
  let c = await fresh("# Heading\n\n- [x] alpha\n- [ ] beta\n    - [ ] nested");
  const before = c.dialect;
  const r1 = await notes.writeNote(NOTE, before);
  const after = (await notes.readNote(NOTE)).dialect;
  if (after === before) ok(`unchanged round-trip (rule: ${r1.rule})`);
  else bad(`round-trip drifted:\n  before ${JSON.stringify(before)}\n  after  ${JSON.stringify(after)}`);

  // ---- 2. append never rewrites
  console.log(`\n${B}2. append is non-destructive${X}`);
  const r2 = await notes.appendContent(NOTE, "- [ ] gamma");
  if (r2.rewrote === false) ok("append reported rewrote: false");
  else bad(`append rewrote the note (rule ${r2.rule})`);
  const items2 = (await notes.readChecklist(NOTE)).items;
  if (items2.length === 4 && items2[0].checked) ok("item added, existing state intact");
  else bad(`expected 4 items with alpha checked, got ${JSON.stringify(items2)}`);

  // ---- 3. indent an existing item via depth: "+1"
  console.log(`\n${B}3. set_checklist_items depth "+1"${X}`);
  const r3 = await notes.setItems(NOTE, { text: "beta", exact: true }, { depth: "+1" });
  const items3 = (await notes.readChecklist(NOTE)).items;
  const beta = items3.find((i) => i.text === "beta");
  const alpha = items3.find((i) => i.text === "alpha");
  if (beta?.depth === 1) ok("beta indented to depth 1");
  else bad(`beta depth is ${beta?.depth}`);
  if (alpha?.checked === true) ok("alpha's checked state survived the rewrite");
  else bad("alpha lost its checked state");
  if (r3.rewrote) ok(`reported rewrote: true (rule ${r3.rule})`);

  // ---- 4. rule 4: a coloured note with no checklist keeps its colour
  console.log(`\n${B}4. colour survives when there are no checkboxes${X}`);
  await fresh("plain");
  const meta = await as.findNotesByName(NOTE);
  await as.setBodyHtml(
    meta[0].id,
    `<div><h1>${NOTE}</h1></div><div><font color="#FF0505">RED</font> <u>UNDER</u></div>`,
  );
  await new Promise((r) => setTimeout(r, 600));
  const c4 = await notes.readNote(NOTE);
  if (/\{color=#FF0505\}/.test(c4.dialect) && /\{u\}/.test(c4.dialect)) {
    ok(`read back as dialect: ${JSON.stringify(c4.dialect)}`);
  } else {
    bad(`colour/underline missing from dialect: ${JSON.stringify(c4.dialect)}`);
  }
  // Editing an existing line, not appending -- an append would (correctly) take
  // the cheaper non-destructive rule and never exercise the HTML write.
  const r4 = await notes.writeNote(NOTE, c4.dialect.replace("RED", "CRIMSON"));
  await new Promise((r) => setTimeout(r, 600));
  const html4 = await as.getBodyHtml(meta[0].id);
  if (r4.rule === "html-only" && /color="#FF0505"/i.test(html4) && /<u>/i.test(html4)) {
    ok("rewrite kept colour and underline (rule html-only)");
  } else {
    bad(`rule ${r4.rule}; html now ${html4.slice(0, 220)}`);
  }
  if (/CRIMSON/.test(html4)) ok("the edit itself landed");
  else bad("edited text missing");

  // ---- 5. rule 5: colour above a checklist -> split write keeps both
  console.log(`\n${B}5. split write: colour above, checkboxes below${X}`);
  await fresh("seed");
  const r5 = await notes.writeNote(
    NOTE,
    "[header]{color=#0000FF}\n- [x] done\n- [ ] todo",
  );
  await new Promise((r) => setTimeout(r, 800));
  const html5 = await as.getBodyHtml((await as.findNotesByName(NOTE))[0].id);
  const items5 = (await notes.readChecklist(NOTE)).items;
  if (r5.rule === "split") ok("planner chose the split write");
  else bad(`expected split, got ${r5.rule}`);
  if (/color="#0000FF"/i.test(html5)) ok("colour written via the HTML phase");
  else bad(`colour missing: ${html5.slice(0, 220)}`);
  if (items5.length === 2 && items5[0].checked && !items5[1].checked) {
    ok("real checkboxes with correct state below it");
  } else {
    bad(`checklist wrong: ${JSON.stringify(items5)}`);
  }

  // ---- 6. rule 7: colour below a checklist refuses, naming the line
  console.log(`\n${B}6. interleaved rich + checklist refuses${X}`);
  try {
    await notes.writeNote(NOTE, "- [ ] a\n[footer]{color=#FF0505}");
    bad("expected a refusal, got a successful write");
  } catch (e) {
    if (/line 2/.test(e.message)) ok(`refused, naming the line: ${D}${e.message.slice(0, 90)}…${X}`);
    else bad(`refused but unhelpfully: ${e.message}`);
  }

  // ---- 7. dry_run writes nothing
  console.log(`\n${B}7. dry_run${X}`);
  const beforeDry = (await notes.readNote(NOTE)).dialect;
  const r7 = await notes.writeNote(NOTE, "- [ ] totally different", { dryRun: true });
  const afterDry = (await notes.readNote(NOTE)).dialect;
  if (r7.dryRun && afterDry === beforeDry) ok(`reported rule ${r7.rule} and wrote nothing`);
  else bad("dry_run modified the note");

  // ---- cleanup
  for (const n of await as.findNotesByName(NOTE)) await as.deleteNote(n.id);
  console.log(`\n${D}cleaned up ${NOTE}${X}`);

  console.log(`\n${B}${failures === 0 ? `${G}all integration checks passed` : `${R}${failures} failed`}${X}\n`);
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error("integration run failed:", e); process.exit(1); });
