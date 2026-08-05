/**
 * Invoking the bridge Shortcuts.
 *
 * `shortcuts run <name> -i in -o out` is the only way to reach Notes' App
 * Intents from a CLI. Arguments go in as a JSON file and results come back as
 * plain text. Warm dispatch measured ~0.4s; the first call after a while pays
 * a few seconds of cold start.
 */
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import {
  REQUIRED_SHORTCUTS,
  SHORTCUT_APPEND,
  SHORTCUT_CREATE,
  SHORTCUT_READ,
} from "./wfbuild.js";

const execFileAsync = promisify(execFile);

export class ShortcutMissingError extends Error {
  constructor(name: string) {
    super(
      `Bridge shortcut "${name}" is not installed. ` +
        `Run "npx notes-mcp-setup" and approve the import prompts.`,
    );
    this.name = "ShortcutMissingError";
  }
}

export class ShortcutRunError extends Error {
  constructor(name: string, detail: string) {
    super(`Shortcut "${name}" failed: ${detail}`);
    this.name = "ShortcutRunError";
  }
}

/** Names of all shortcuts currently in the user's library. */
export async function listInstalled(): Promise<string[]> {
  const { stdout } = await execFileAsync("shortcuts", ["list"]);
  return stdout.split("\n").map((l) => l.trim()).filter(Boolean);
}

/** Which of the required bridge shortcuts are missing. */
export async function missingShortcuts(): Promise<string[]> {
  const installed = new Set(await listInstalled());
  return REQUIRED_SHORTCUTS.filter((n) => !installed.has(n));
}

/**
 * Bridge shortcuts installed more than once.
 *
 * Shortcuts allows duplicate names, and `shortcuts run` then fails with
 * "Couldn't find shortcut" because it cannot pick between them. The user has
 * to delete the extras by hand -- the CLI has no delete command.
 */
export async function duplicateShortcuts(): Promise<string[]> {
  const counts = new Map<string, number>();
  for (const name of await listInstalled()) {
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  return REQUIRED_SHORTCUTS.filter((n) => (counts.get(n) ?? 0) > 1);
}

/**
 * Run a bridge shortcut with a JSON argument, returning its text output.
 *
 * A shortcut that cannot resolve a parameter falls back to an interactive
 * picker; headless that surfaces as "Running was cancelled", which almost
 * always means the note name did not match anything.
 */
export async function runShortcut(name: string, args: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "notes-mcp-run-"));
  const inPath = join(dir, "in.json");
  const outPath = join(dir, "out.txt");
  try {
    await writeFile(inPath, JSON.stringify(args), "utf8");
    try {
      await execFileAsync(
        "shortcuts",
        ["run", name, "-i", inPath, "-o", outPath, "--output-type", "public.plain-text"],
        { maxBuffer: 64 * 1024 * 1024 },
      );
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (/could not be found/i.test(msg)) throw new ShortcutMissingError(name);
      if (/cancelled/i.test(msg)) {
        throw new ShortcutRunError(
          name,
          "the shortcut prompted for input, which usually means no note matched " +
            `the name ${JSON.stringify(args.note ?? "")}`,
        );
      }
      throw new ShortcutRunError(name, msg);
    }
    try {
      return await readFile(outPath, "utf8");
    } catch {
      return "";
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/**
 * Read a note's body as plain text, preserving checklist state.
 * This is the ONLY way to observe checked/unchecked state.
 */
export async function readBody(noteName: string): Promise<string> {
  return runShortcut(SHORTCUT_READ, { note: noteName });
}

/** Append Markdown to a note; `- [ ]` / `- [x]` become real checklist items. */
export async function appendMarkdown(noteName: string, markdown: string): Promise<void> {
  await runShortcut(SHORTCUT_APPEND, { note: noteName, markdown });
}

/**
 * Create a note from Markdown via App Intents.
 *
 * Notes created this way are immediately addressable by later bridge calls,
 * which is why creation does not go through AppleScript.
 */
export async function createNoteFromMarkdown(name: string, markdown: string): Promise<void> {
  await runShortcut(SHORTCUT_CREATE, { name, markdown });
}
