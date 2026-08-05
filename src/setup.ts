#!/usr/bin/env node
/**
 * One-time setup: generate, sign, and install the bridge shortcuts, then verify
 * everything works.
 *
 * Importing a shortcut requires a click in the Shortcuts app -- there is no CLI
 * install path -- so this walks the user through it rather than pretending it
 * can be automated.
 */
import { execFile } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import * as as from "./applescript.js";
import { duplicateShortcuts, listInstalled, missingShortcuts } from "./shortcuts.js";
import { OPTIONAL_SHORTCUTS, REQUIRED_SHORTCUTS, generateShortcuts } from "./wfbuild.js";

const execFileAsync = promisify(execFile);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const GREEN = "\u001b[32m";
const RED = "\u001b[31m";
const YELLOW = "\u001b[33m";
const DIM = "\u001b[2m";
const RESET = "\u001b[0m";

const pass = (m: string) => console.log(`${GREEN}✓${RESET} ${m}`);
const warn = (m: string) => console.log(`${YELLOW}!${RESET} ${m}`);
const failed = (m: string) => console.log(`${RED}✗${RESET} ${m}`);

async function waitForImport(timeoutMs = 180_000): Promise<string[]> {
  const deadline = Date.now() + timeoutMs;
  let remaining = await missingShortcuts();
  while (remaining.length && Date.now() < deadline) {
    await sleep(2000);
    remaining = await missingShortcuts();
  }
  return remaining;
}

async function main() {
  const doctorOnly = process.argv.includes("--check");

  console.log("notes-mcp setup\n");

  // 1. Automation permission
  const access = await as.checkAccess();
  if (access.ok) {
    pass(`Notes automation works (${access.noteCount} notes)`);
  } else {
    failed("Cannot control Notes via AppleScript.");
    console.log(
      `\n  Grant permission under System Settings > Privacy & Security >\n` +
        `  Automation, then re-run. Original error:\n  ${DIM}${access.error}${RESET}\n`,
    );
    process.exit(1);
  }

  // 2. Shortcuts CLI
  try {
    await execFileAsync("shortcuts", ["list"]);
    pass("Shortcuts CLI available");
  } catch {
    failed("The `shortcuts` command is unavailable. macOS 12+ is required.");
    process.exit(1);
  }

  // 3. Duplicates break `shortcuts run`, so check before anything else
  const dupes = await duplicateShortcuts();
  if (dupes.length) {
    failed(`These bridge shortcuts are installed more than once: ${dupes.join(", ")}`);
    console.log(
      `\n  Shortcuts allows duplicate names, but running one then fails with\n` +
        `  "Couldn't find shortcut". Open Shortcuts.app, delete the extra\n` +
        `  copies so exactly one of each remains, then re-run.\n`,
    );
    process.exit(1);
  }

  // 4. Bridge shortcuts
  let missing = await missingShortcuts();
  if (missing.length === 0) {
    pass(`Bridge shortcuts installed (${REQUIRED_SHORTCUTS.join(", ")})`);
  } else if (doctorOnly) {
    failed(`Missing bridge shortcuts: ${missing.join(", ")}`);
    console.log(`\n  Run ${DIM}npx notes-mcp-setup${RESET} to install them.\n`);
    process.exit(1);
  } else {
    warn(`Missing bridge shortcuts: ${missing.join(", ")}`);
    console.log("\n  Generating and signing them...\n");

    const paths = await generateShortcuts(missing);
    for (const p of paths) pass(`built ${p.split("/").pop()}`);

    console.log(
      `\n  ${YELLOW}Opening ${paths.length} import prompts.${RESET}\n` +
        `  Click ${DIM}Add Shortcut${RESET} on each one -- there is no way to\n` +
        `  install a shortcut without confirmation.\n`,
    );
    for (const p of paths) {
      await execFileAsync("open", [p]);
      await sleep(1200);
    }

    console.log("  Waiting for the imports to complete...\n");
    missing = await waitForImport();
    if (missing.length) {
      failed(`Still missing: ${missing.join(", ")}`);
      console.log(
        `\n  If no prompt appeared, open these files manually:\n` +
          paths.map((p) => `    ${p}`).join("\n") +
          "\n",
      );
      process.exit(1);
    }
    pass("Bridge shortcuts installed");
  }

  // 4b. Optional shortcuts. These only make appended checklist items
  // escaping-safe, so a missing one degrades to a Markdown append rather than
  // failing -- which is why they are offered rather than required.
  const installedNames = new Set(await listInstalled());
  const missingOptional = OPTIONAL_SHORTCUTS.filter((n) => !installedNames.has(n));
  if (missingOptional.length === 0) {
    pass(`Optional shortcuts installed (${OPTIONAL_SHORTCUTS.join(", ")})`);
  } else if (doctorOnly) {
    warn(`Optional shortcuts not installed: ${missingOptional.join(", ")}`);
    console.log(
      `  ${DIM}Appended checklist items will go through a Markdown append.${RESET}\n`,
    );
  } else if (process.argv.includes("--with-optional")) {
    const paths = await generateShortcuts(missingOptional);
    console.log(
      `\n  ${YELLOW}Opening ${paths.length} more import prompts.${RESET}\n`,
    );
    for (const p of paths) {
      await execFileAsync("open", [p]);
      await sleep(1200);
    }
    console.log("  Waiting for the imports to complete...\n");
    const deadline = Date.now() + 180_000;
    let left = missingOptional;
    while (left.length && Date.now() < deadline) {
      await sleep(2000);
      const now = new Set(await listInstalled());
      left = missingOptional.filter((n) => !now.has(n));
    }
    if (left.length) warn(`Still missing: ${left.join(", ")}`);
    else pass("Optional shortcuts installed");
  } else {
    warn(`Optional shortcuts not installed: ${missingOptional.join(", ")}`);
    console.log(
      `  ${DIM}Everything works without them; appended checklist items just go\n` +
        `  through a Markdown append, so text that looks like Markdown is\n` +
        `  re-parsed rather than kept literal. Install with:${RESET}\n` +
        `    npx notes-mcp-setup --with-optional\n`,
    );
  }

  // 5. End-to-end verification
  console.log("\n  Verifying the bridge end to end...\n");
  const probeTitle = `notes-mcp setup check ${Date.now()}`;
  try {
    const { createNote, readChecklist, clearChecklist } = await import("./notes.js");
    await createNote(probeTitle, "- [x] setup-probe-item\n- [ ] second-item");
    pass("created a note with checklist items");

    const { items } = await readChecklist(probeTitle);
    const checkedCount = items.filter((i) => i.checked).length;
    if (items.length !== 2 || checkedCount !== 1) {
      throw new Error(
        `expected 2 items with 1 checked, got ${items.length} with ${checkedCount}`,
      );
    }
    pass("read the checklist back with correct state");

    const res = await clearChecklist(probeTitle);
    if (res.after.some((i) => i.checked)) throw new Error("items remained checked");
    pass("cleared the checklist");
  } catch (e) {
    failed(`Verification failed: ${e instanceof Error ? e.message : String(e)}`);
    console.log(`\n  The probe note "${probeTitle}" may need deleting manually.\n`);
    process.exit(1);
  }

  // best-effort cleanup of the probe note
  try {
    const { resolveNote } = await import("./notes.js");
    const meta = await resolveNote(probeTitle);
    await as.deleteNote(meta.id);
    pass("cleaned up the probe note");
  } catch {
    warn(`Could not delete the probe note "${probeTitle}"; remove it manually.`);
  }

  const installed = await listInstalled();
  const entry = join(dirname(fileURLToPath(import.meta.url)), "index.js");
  console.log(
    `\n${GREEN}Setup complete.${RESET} ${installed.length} shortcuts in your library.\n\n` +
      `Add to your MCP client config:\n\n` +
      `  ${DIM}"notes": { "command": "node", "args": ["${entry}"] }${RESET}\n`,
  );
}

main().catch((e) => {
  console.error("setup failed:", e);
  process.exit(1);
});
