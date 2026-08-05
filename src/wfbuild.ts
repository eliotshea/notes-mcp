/**
 * Generation and signing of the bridge Shortcuts.
 *
 * The encoding below was recovered by decoding shortcuts built in the Shortcuts
 * editor (see scripts/unshortcut.py and docs/spike-findings.md §4, §7, §9).
 * Several details are load-bearing and non-obvious:
 *
 *  - Every App Intents action needs an `AppIntentDescriptor`. Without it,
 *    Shortcuts falls back to an interactive picker that cannot run headless.
 *  - A Find action must NOT carry `WFContentItemInputParameter`. The editor
 *    adds it automatically, which makes the filter search the shortcut input
 *    instead of the Notes library.
 *  - `getvalueforkey` coerces JSON text to a dictionary on its own; inserting
 *    a `detect.dictionary` step ahead of it fails.
 */
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import plist from "plist";

const execFileAsync = promisify(execFile);

export const BUNDLE = "com.apple.Notes";
/** The object-replacement character Shortcuts uses as a variable placeholder. */
const PLACEHOLDER = "￼";

export type Json = Record<string, unknown>;

export const newUuid = () => randomUUID().toUpperCase();

export const descriptor = (intent: string, requiresApp = false): Json => ({
  TeamIdentifier: "0000000000",
  BundleIdentifier: BUNDLE,
  Name: "Notes",
  AppIntentIdentifier: intent,
  ...(requiresApp ? { ActionRequiresAppInstallation: true } : {}),
});

/** A whole text field consisting of the shortcut's input. */
export const shortcutInputText = (): Json => ({
  Value: { string: PLACEHOLDER, attachmentsByRange: { "{0, 1}": { Type: "ExtensionInput" } } },
  WFSerializationType: "WFTextTokenString",
});

/** The shortcut's input as a non-text parameter. */
export const shortcutInputAttachment = (): Json => ({
  Value: { Type: "ExtensionInput" },
  WFSerializationType: "WFTextTokenAttachment",
});

/** Reference a previous action's output as a non-text parameter. */
export const outputAttachment = (uuid: string, name: string, property?: string): Json => ({
  Value: {
    OutputUUID: uuid,
    Type: "ActionOutput",
    OutputName: name,
    ...(property
      ? { Aggrandizements: [{ Type: "WFPropertyVariableAggrandizement", PropertyName: property }] }
      : {}),
  },
  WFSerializationType: "WFTextTokenAttachment",
});

/** Reference a previous action's output inside a text field. */
export const outputText = (uuid: string, name: string, property?: string): Json => ({
  Value: {
    string: PLACEHOLDER,
    attachmentsByRange: {
      "{0, 1}": {
        OutputUUID: uuid,
        Type: "ActionOutput",
        OutputName: name,
        ...(property
          ? {
              Aggrandizements: [
                { Type: "WFPropertyVariableAggrandizement", PropertyName: property },
              ],
            }
          : {}),
      },
    },
  },
  WFSerializationType: "WFTextTokenString",
});

export const getValueForKey = (uuid: string, key: string): Json => ({
  WFWorkflowActionIdentifier: "is.workflow.actions.getvalueforkey",
  WFWorkflowActionParameters: {
    WFInput: shortcutInputAttachment(),
    WFDictionaryKey: key,
    WFGetDictionaryValueType: "Value",
    UUID: uuid,
  },
});

/** Find a note by exact name. `nameValue` is a serialized text field. */
export const findNoteByName = (uuid: string, nameValue: Json): Json => ({
  WFWorkflowActionIdentifier: "is.workflow.actions.filter.notes",
  WFWorkflowActionParameters: {
    AppIntentDescriptor: descriptor("NoteEntity", true),
    UUID: uuid,
    WFContentItemLimitEnabled: true,
    WFContentItemLimitNumber: 1.0,
    WFContentItemFilter: {
      WFSerializationType: "WFContentPredicateTableTemplate",
      Value: {
        WFContentPredicateBoundedDate: false,
        WFActionParameterFilterPrefix: 1,
        WFActionParameterFilterTemplates: [
          {
            Operator: 99, // "is"
            Property: "Name",
            Removable: true,
            Values: { Unit: 4, String: nameValue },
          },
        ],
      },
    },
    // deliberately no WFContentItemInputParameter -- see file header
  },
});

export const getText = (uuid: string, value: Json): Json => ({
  WFWorkflowActionIdentifier: "is.workflow.actions.gettext",
  WFWorkflowActionParameters: { WFTextActionText: value, UUID: uuid },
});

export const notesAction = (uuid: string, intent: string, params: Json): Json => ({
  WFWorkflowActionIdentifier: `${BUNDLE}.${intent}`,
  WFWorkflowActionParameters: { AppIntentDescriptor: descriptor(intent), UUID: uuid, ...params },
});

export function workflow(actions: Json[]): Json {
  return {
    WFWorkflowClientVersion: "4610",
    WFWorkflowMinimumClientVersion: 900,
    WFWorkflowMinimumClientVersionString: "900",
    WFWorkflowIcon: { WFWorkflowIconStartColor: 2071128575, WFWorkflowIconGlyphNumber: 61440 },
    WFWorkflowImportQuestions: [],
    WFWorkflowTypes: ["WFWorkflowTypeShowInSearch"],
    WFWorkflowInputContentItemClasses: ["WFStringContentItem"],
    WFWorkflowOutputContentItemClasses: ["WFStringContentItem"],
    WFWorkflowHasOutputFallback: true,
    WFWorkflowHasShortcutInputVariables: true,
    WFQuickActionSurfaces: [],
    WFWorkflowActions: actions,
  };
}

export const SHORTCUT_READ = "notes-mcp-read-body";
export const SHORTCUT_APPEND = "notes-mcp-append-markdown";
export const SHORTCUT_CREATE = "notes-mcp-create-note";
export const REQUIRED_SHORTCUTS = [SHORTCUT_READ, SHORTCUT_APPEND, SHORTCUT_CREATE] as const;

/**
 * Read a note's body, including checklist state.
 * Input:  {"note": "<exact note name>"}
 * Output: the note body as plain text with ◦ / ✓ / ⁃ markers.
 */
function buildReadBody(): Json {
  const key = newUuid();
  const find = newUuid();
  return workflow([
    getValueForKey(key, "note"),
    findNoteByName(find, outputText(key, "Dictionary Value")),
    getText(newUuid(), outputText(find, "Note", "Body")),
  ]);
}

/**
 * Append Markdown to a note. `- [ ]` / `- [x]` become real checklist items.
 * Input: {"note": "<exact note name>", "markdown": "..."}
 */
function buildAppendMarkdown(): Json {
  const noteKey = newUuid();
  const mdKey = newUuid();
  const find = newUuid();
  return workflow([
    getValueForKey(noteKey, "note"),
    getValueForKey(mdKey, "markdown"),
    findNoteByName(find, outputText(noteKey, "Dictionary Value")),
    notesAction(newUuid(), "AppendMarkdownToNoteLinkAction", {
      entity: outputAttachment(find, "Note"),
      markdownText: outputText(mdKey, "Dictionary Value"),
    }),
  ]);
}

/**
 * Create a note from Markdown.
 *
 * Creation must go through App Intents rather than AppleScript: a note created
 * by AppleScript is not immediately visible to App Intents, so a follow-up
 * bridge call finds nothing and falls back to an interactive picker.
 *
 * Input: {"name": "<title>", "markdown": "..."}
 */
function buildCreateNote(): Json {
  const nameKey = newUuid();
  const mdKey = newUuid();
  return workflow([
    getValueForKey(nameKey, "name"),
    getValueForKey(mdKey, "markdown"),
    notesAction(newUuid(), "CreateNoteFromMarkdownLinkAction", {
      name: outputText(nameKey, "Dictionary Value"),
      markdownContents: outputText(mdKey, "Dictionary Value"),
    }),
  ]);
}

export const BUILDERS: Record<string, () => Json> = {
  [SHORTCUT_READ]: buildReadBody,
  [SHORTCUT_APPEND]: buildAppendMarkdown,
  [SHORTCUT_CREATE]: buildCreateNote,
};

/**
 * Generate and sign bridge shortcuts into a directory.
 *
 * Only the named shortcuts are built. Importing one that already exists
 * creates a duplicate rather than replacing it, and duplicate names make
 * `shortcuts run` fail with "Couldn't find shortcut" -- so callers must pass
 * only the shortcuts that are genuinely missing.
 */
export async function generateShortcuts(
  names: readonly string[] = REQUIRED_SHORTCUTS,
  outDir?: string,
): Promise<string[]> {
  const dir = outDir ?? (await mkdtemp(join(tmpdir(), "notes-mcp-")));
  const paths: string[] = [];

  const selected = Object.entries(BUILDERS).filter(([name]) => names.includes(name));
  for (const [name, build] of selected) {
    const unsigned = join(dir, `${name}-unsigned.shortcut`);
    const signed = join(dir, `${name}.shortcut`);
    await writeFile(unsigned, plist.build(build() as never), "utf8");
    await execFileAsync("shortcuts", [
      "sign",
      "--mode",
      "anyone",
      "-i",
      unsigned,
      "-o",
      signed,
    ]);
    paths.push(signed);
  }
  return paths;
}
