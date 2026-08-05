#!/usr/bin/env node
/**
 * Spike: are Notes' per-item checklist App Intents reachable headlessly?
 *
 * docs/spike-findings.md §10 concluded that per-item toggling is unavailable,
 * and the whole rebuild architecture follows from that. But Notes' App Intents
 * metadata lists 45 intents where the bridge uses 2, including:
 *
 *   CreateChecklistItemLinkAction        name?, noteEntity?
 *   SetChecklistItemCheckedLinkActionv2  changeOperation, entities, note?
 *   ChecklistItemEntity                  Text, Checked, Note
 *   VisibleChecklistItemsQuery           defaultQueryForEntity: true
 *
 * If these run without a foreground window, checking an item stops being a
 * whole-note rewrite and nothing is lost. This script builds candidate
 * shortcuts and reports which, if any, work.
 *
 * Two things are known, two are guesses:
 *   known  - CreateChecklistItemLinkAction needs only a note, which the proven
 *            `filter.notes` action already supplies. Zero unknowns.
 *   guess  - the Find action identifier for ChecklistItemEntity. There is no
 *            `is.workflow.actions.filter.checklistitems` in WorkflowKit's
 *            legacy list, so App Intents entities must use something else.
 *   guess  - that Find action's output name.
 *
 * Run: npm run build && node dist/spike.js
 */
import { execFile } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import plist from "plist";
import * as as from "./applescript.js";
import { listInstalled, runShortcut } from "./shortcuts.js";
import {
  type Json,
  descriptor,
  findNoteByName,
  getValueForKey,
  newUuid,
  notesAction,
  outputAttachment,
  outputText,
  workflow,
} from "./wfbuild.js";

const execFileAsync = promisify(execFile);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const GREEN = "[32m";
const RED = "[31m";
const YELLOW = "[33m";
const DIM = "[2m";
const BOLD = "[1m";
const RESET = "[0m";

const pass = (m: string) => console.log(`${GREEN}✓${RESET} ${m}`);
const fail = (m: string) => console.log(`${RED}✗${RESET} ${m}`);
const warn = (m: string) => console.log(`${YELLOW}!${RESET} ${m}`);

const NOTE = "SpikeChecklistIntents";

export const SPIKE_ADD = "notes-mcp-spike-add-item";
export const SPIKE_SET_A = "notes-mcp-spike-set-checked-a";
export const SPIKE_SET_B = "notes-mcp-spike-set-checked-b";

/**
 * Add a checklist item to a note, with no rebuild.
 *
 * Zero unknowns: `CreateChecklistItemLinkAction` takes only `name` and
 * `noteEntity`, and the note comes from the same `filter.notes` action the
 * shipping bridge already uses. If this fails, the intent family is not
 * reachable headlessly at all and the rest of the spike is moot.
 *
 * Input: {"note": "<exact name>", "text": "<item text>"}
 */
function buildAddItem(): Json {
  const noteKey = newUuid();
  const textKey = newUuid();
  const find = newUuid();
  return workflow([
    getValueForKey(noteKey, "note"),
    getValueForKey(textKey, "text"),
    findNoteByName(find, outputText(noteKey, "Dictionary Value")),
    notesAction(newUuid(), "CreateChecklistItemLinkAction", {
      name: outputText(textKey, "Dictionary Value"),
      noteEntity: outputAttachment(find, "Note"),
    }),
  ]);
}

/**
 * Find checklist items whose text matches, scoped to a note.
 *
 * `actionId` is the guess under test. `Operator: 99` is "is", matching the
 * proven note filter; `Property` uses the entity's display title ("Text"),
 * which is how the note filter addresses "Name".
 */
const findChecklistItems = (uuid: string, actionId: string, textValue: Json): Json => ({
  WFWorkflowActionIdentifier: actionId,
  WFWorkflowActionParameters: {
    AppIntentDescriptor: descriptor("ChecklistItemEntity", true),
    UUID: uuid,
    WFContentItemFilter: {
      WFSerializationType: "WFContentPredicateTableTemplate",
      Value: {
        WFContentPredicateBoundedDate: false,
        WFActionParameterFilterPrefix: 1,
        WFActionParameterFilterTemplates: [
          {
            Operator: 99,
            Property: "Text",
            Removable: true,
            Values: { Unit: 4, String: textValue },
          },
        ],
      },
    },
  },
});

/**
 * Check a checklist item by its text, without rewriting the note.
 *
 * The payoff case. `changeOperation` is the `CheckedChangeOperationType` case
 * identifier -- the enum also offers "uncheck" and "toggle", so a working
 * version of this replaces clear_checklist, check_all_items and
 * set_checklist_items in one action.
 *
 * Input: {"note": "<exact name>", "text": "<item text>"}
 */
function buildSetChecked(findActionId: string, findOutputName: string): () => Json {
  return () => {
    const noteKey = newUuid();
    const textKey = newUuid();
    const findNote = newUuid();
    const findItems = newUuid();
    return workflow([
      getValueForKey(noteKey, "note"),
      getValueForKey(textKey, "text"),
      findNoteByName(findNote, outputText(noteKey, "Dictionary Value")),
      findChecklistItems(findItems, findActionId, outputText(textKey, "Dictionary Value")),
      notesAction(newUuid(), "SetChecklistItemCheckedLinkActionv2", {
        changeOperation: "check",
        entities: outputAttachment(findItems, findOutputName),
        note: outputAttachment(findNote, "Note"),
      }),
    ]);
  };
}

/**
 * Set checked state by naming the item as plain text.
 *
 * Both Find-action guesses failed with "an action could not be found", and the
 * query metadata says why: VisibleChecklistItemsQuery has capabilities 70 while
 * VisibleNotesQuery -- the one behind the working note filter -- has 78. The
 * missing bit is set on exactly the entities that support property filtering
 * (Note, Attachment, Table) and clear on those that do not (ChecklistItem,
 * Account, Folder, Tag). So no "Find Checklist Items where Text is X" action
 * exists to reference.
 *
 * That leaves App Intents' own string resolution: hand `entities` a text value
 * and let the intent resolve it through the query, scoped by `note`.
 *
 * Input: {"note": "<exact name>", "text": "<item text>"}
 */
function buildSetCheckedByText(scopeToNote: boolean): () => Json {
  return () => {
    const noteKey = newUuid();
    const textKey = newUuid();
    const findNote = newUuid();
    return workflow([
      getValueForKey(noteKey, "note"),
      getValueForKey(textKey, "text"),
      findNoteByName(findNote, outputText(noteKey, "Dictionary Value")),
      notesAction(newUuid(), "SetChecklistItemCheckedLinkActionv2", {
        changeOperation: "check",
        entities: outputText(textKey, "Dictionary Value"),
        ...(scopeToNote ? { note: outputAttachment(findNote, "Note") } : {}),
      }),
    ]);
  };
}

export const SPIKE_SET_C = "notes-mcp-spike-set-checked-c";
export const SPIKE_SET_D = "notes-mcp-spike-set-checked-d";

const SPIKE_BUILDERS: Record<string, () => Json> = {
  [SPIKE_ADD]: buildAddItem,
  // Guess A: App Intents entities addressed the way notesAction addresses
  // intents -- com.apple.Notes.<TypeName>.
  [SPIKE_SET_A]: buildSetChecked(`com.apple.Notes.ChecklistItemEntity`, "Checklist Item"),
  // Guess B: the legacy filter naming convention, extended to a type that has
  // no legacy filter action.
  [SPIKE_SET_B]: buildSetChecked(
    "is.workflow.actions.filter.checklistitems",
    "Checklist Items",
  ),
  // C and D drop the Find action entirely and let the intent resolve the item
  // from text, with and without a note to scope the search.
  [SPIKE_SET_C]: buildSetCheckedByText(true),
  [SPIKE_SET_D]: buildSetCheckedByText(false),
};

async function generate(dir: string, only: string[]): Promise<string[]> {
  const paths: string[] = [];
  for (const [name, build] of Object.entries(SPIKE_BUILDERS).filter(([n]) =>
    only.includes(n),
  )) {
    const unsigned = join(dir, `${name}-unsigned.shortcut`);
    const signed = join(dir, `${name}.shortcut`);
    await writeFile(unsigned, plist.build(build() as never), "utf8");
    try {
      await execFileAsync("shortcuts", ["sign", "--mode", "anyone", "-i", unsigned, "-o", signed]);
      paths.push(signed);
    } catch (e) {
      fail(`could not sign ${name}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return paths;
}

async function installed(): Promise<Set<string>> {
  return new Set(await listInstalled());
}

/** Read the note's checklist through the shipping bridge -- the only state source. */
async function readItems(): Promise<{ text: string; checked: boolean }[]> {
  const body = await runShortcut("notes-mcp-read-body", { note: NOTE });
  return body
    .split("\n")
    .map((l) => l.replace(/^\t/, ""))
    .filter((l) => /^[◦✓]\t/.test(l))
    .map((l) => ({ text: l.slice(2).trim(), checked: l.startsWith("✓") }));
}

async function resetNote(): Promise<void> {
  const existing = await as.findNotesByName(NOTE);
  for (const n of existing) await as.deleteNote(n.id);
  await runShortcut("notes-mcp-create-note", {
    name: NOTE,
    markdown: "- [ ] alpha\n- [ ] beta\n",
  });
  for (let i = 0; i < 15; i++) {
    if ((await readItems()).length >= 2) return;
    await sleep(300);
  }
}

async function main() {
  console.log(`\n${BOLD}Spike: per-item checklist intents${RESET}\n`);

  const before = await installed();
  const missing = Object.keys(SPIKE_BUILDERS).filter((n) => !before.has(n));

  if (missing.length) {
    const dir = await mkdtemp(join(tmpdir(), "notes-mcp-spike-"));
    const paths = await generate(dir, missing);
    console.log(
      `Built ${paths.length} shortcut(s). Shortcuts will now open an import\n` +
        `prompt for each one -- click ${BOLD}Add Shortcut${RESET} on all of them.\n` +
        `${DIM}These are throwaway probes; delete them from Shortcuts afterwards.${RESET}\n`,
    );
    for (const p of paths) await execFileAsync("open", [p]);

    const deadline = Date.now() + 180_000;
    let remaining = missing;
    while (remaining.length && Date.now() < deadline) {
      await sleep(2000);
      const now = await installed();
      remaining = missing.filter((n) => !now.has(n));
    }
    if (remaining.length) {
      fail(`not imported in time: ${remaining.join(", ")}`);
      console.log(`\nRe-run once the import prompts are accepted.\n`);
      process.exit(1);
    }
  }
  pass("all spike shortcuts installed");

  // ---------------------------------------------------------------- test 1
  console.log(`\n${BOLD}1. CreateChecklistItemLinkAction${RESET} ${DIM}(zero unknowns)${RESET}`);
  await resetNote();
  const start = await readItems();
  console.log(`   note seeded with ${start.length} items: ${start.map((i) => i.text).join(", ")}`);

  let addWorks = false;
  try {
    await runShortcut(SPIKE_ADD, { note: NOTE, text: "gamma" });
    await sleep(600);
    const after = await readItems();
    addWorks = after.some((i) => i.text === "gamma");
    if (addWorks) {
      pass(`item added without a rebuild -- note now has ${after.length} items`);
    } else {
      fail(`ran without error but no item appeared (${after.map((i) => i.text).join(", ")})`);
    }
  } catch (e) {
    fail(`failed: ${e instanceof Error ? e.message : String(e)}`);
  }

  // ---------------------------------------------------------------- test 2
  console.log(`\n${BOLD}2. SetChecklistItemCheckedLinkActionv2${RESET} ${DIM}(the payoff)${RESET}`);
  const results: Record<string, string> = {};
  for (const [label, name] of [
    ["guess A  find via com.apple.Notes.ChecklistItemEntity", SPIKE_SET_A],
    ["guess B  find via is.workflow.actions.filter.checklistitems", SPIKE_SET_B],
    ["guess C  entities as text, scoped to note", SPIKE_SET_C],
    ["guess D  entities as text, unscoped", SPIKE_SET_D],
  ] as const) {
    await resetNote();
    try {
      await runShortcut(name, { note: NOTE, text: "alpha" });
      await sleep(600);
      const after = await readItems();
      const alpha = after.find((i) => i.text === "alpha");
      if (alpha?.checked) {
        pass(`${label} -- CHECKED IT`);
        results[name] = "works";
      } else {
        fail(`${label} -- ran, but alpha is still unchecked`);
        results[name] = "silent no-op";
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      fail(`${label} -- ${msg.split("\n")[0]}`);
      results[name] = "error";
    }
  }

  // ---------------------------------------------------------------- verdict
  console.log(`\n${BOLD}Verdict${RESET}`);
  const setWorks = Object.values(results).includes("works");
  if (setWorks) {
    console.log(
      `  ${GREEN}The rebuild is unnecessary for checked-state changes.${RESET}\n` +
        `  Rewrite docs/edit-model.md around per-item intents: nothing is\n` +
        `  cleared, so colour, underline, images, tables and highlighting all\n` +
        `  survive a check/uncheck untouched.`,
    );
  } else if (addWorks) {
    console.log(
      `  ${YELLOW}Partial.${RESET} The intent family IS reachable headlessly --\n` +
        `  adding an item needs no rebuild -- but neither Find-action guess\n` +
        `  resolved ChecklistItemEntity. The blocker is the Find action's\n` +
        `  identifier, not the intents. Next: build a Find Checklist Items\n` +
        `  action in the Shortcuts editor by hand and decode it with\n` +
        `  scripts/unshortcut.py to read the real identifier off it.`,
    );
  } else {
    console.log(
      `  ${RED}No per-item intent ran headlessly.${RESET} spike-findings §10 stands,\n` +
        `  and docs/edit-model.md Parts 1-6 remain the plan.`,
    );
  }

  console.log(`\n${DIM}Cleaning up test note.${RESET}`);
  for (const n of await as.findNotesByName(NOTE)) await as.deleteNote(n.id);
  warn(`Delete the notes-mcp-spike-* shortcuts from Shortcuts.app by hand --`);
  console.log(`  ${DIM}the shortcuts CLI has no delete command.${RESET}\n`);
}

main().catch((e) => {
  console.error("spike failed:", e);
  process.exit(1);
});
