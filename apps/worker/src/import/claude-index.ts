import { join } from "node:path";
import { jsonString } from "../providers/json.ts";
import { claudeTitle, promptText } from "./claude-entries.ts";
import { directoryEntries, lines, parseLine, readSourceText, sourceExists, type SourceFile } from "./read.ts";

/**
 * The conversation a Claude session ends with (docs/import.md, "Gałęzie"). A session file is a tree: entries point to
 * their parent (`parentUuid`; after compaction `logicalParentUuid`), rewinds and edits leave branches behind. The
 * import follows the active branch: from the leaf the CLI recorded last (`last-prompt.leafUuid`, else the newest
 * entry), down to its newest descendant, then up to the root. Sidechains (subagents) are read from their own files.
 */
export interface ClaudeIndex {
  readonly active: ReadonlySet<string>;
  /** Fork points left on other branches (not imported). */
  readonly branches: number;
  /** Subagent entries inline in the session file (an older format), not imported. */
  readonly inlineSidechains: number;
  readonly title: string;
  /** Subagent transcripts by the tool call that started them (`<session>/subagents/agent-*.jsonl`). */
  readonly subagents: ReadonlyMap<string, SourceFile>;
  readonly skipped: number;
}

/** A session whose entries cannot be read as a tree (an entry that is its own ancestor). */
export class MalformedSessionError extends Error {}

export function indexClaude(file: SourceFile, end: number): ClaudeIndex {
  const parents = new Map<string, string>();
  const children = new Map<string, string[]>();
  const order: string[] = [];
  const prompts = new Set<string>();
  let leaf = "";
  let title: { title: string; user: boolean } | undefined;
  let inlineSidechains = 0;
  let skipped = 0;

  for (const line of lines(file, 0, end)) {
    const entry = parseLine(line.text);

    if (!entry) {
      if (line.text.trim()) skipped += 1;
      continue;
    }

    const named = claudeTitle(entry);

    if (named && (!title || named.user || !title.user)) title = named;

    if (entry["type"] === "last-prompt") leaf = jsonString(entry["leafUuid"]) || leaf;
    const uuid = jsonString(entry["uuid"]);

    // Every record with a uuid is a node (attachments, too): prompts and answers hang below them.
    if (!uuid) continue;

    if (entry["isSidechain"] === true) {
      inlineSidechains += 1;
      continue;
    }

    const parent = jsonString(entry["parentUuid"]) || jsonString(entry["logicalParentUuid"]);

    if (parent === uuid) throw new MalformedSessionError("an entry of the session is its own parent");
    parents.set(uuid, parent);
    order.push(uuid);

    if (promptText(entry) !== undefined) prompts.add(uuid);

    if (parent) children.set(parent, [...(children.get(parent) ?? []), uuid]);
  }

  let current = parents.has(leaf) ? leaf : (order.at(-1) ?? "");

  // The recorded leaf may be the prompt: its answer follows as the newest child.
  const descended = new Set<string>([current]);

  for (let next = children.get(current)?.at(-1); next; next = children.get(current)?.at(-1)) {
    if (descended.has(next))
      throw new MalformedSessionError("the entries of the session point to each other in a loop");
    descended.add(next);
    current = next;
  }

  const active = new Set<string>();

  for (let at = current; at; at = parents.get(at) ?? "") {
    if (active.has(at)) throw new MalformedSessionError("the entries of the session point to each other in a loop");
    active.add(at);
  }

  const { kept, branches } = sideBranches(order, parents, active, prompts);

  for (const uuid of kept) active.add(uuid);

  return {
    active,
    branches,
    inlineSidechains,
    title: title?.title ?? "",
    subagents: subagentFiles(file),
    skipped,
  };
}

interface SideBranches {
  /** Entries beside the chain that belong to the conversation. */
  readonly kept: string[];
  readonly branches: number;
}

/**
 * Entries beside the chain: parallel tool results and progress hang off it as dead ends and belong to the
 * conversation; a side branch that holds a prompt is an edit or rewind the user left behind (not imported).
 */
function sideBranches(
  order: readonly string[],
  parents: ReadonlyMap<string, string>,
  active: ReadonlySet<string>,
  prompts: ReadonlySet<string>,
): SideBranches {
  const roots = new Map<string, string>();
  const abandoned = new Set<string>();

  // Iterative, with a visited set: a loop off the chain ends at the entry where it closes.
  const rootOf = (uuid: string): string => {
    const path: string[] = [];
    const seen = new Set<string>();
    let at = uuid;
    let root = roots.get(at);

    while (root === undefined) {
      const parent = parents.get(at) ?? "";

      if (!parent || active.has(parent) || !parents.has(parent) || seen.has(parent)) root = at;
      else {
        seen.add(at);
        path.push(at);
        at = parent;
        root = roots.get(at);
      }
    }

    for (const visited of [...path, at]) roots.set(visited, root);

    return root;
  };

  const off = order.filter((uuid) => !active.has(uuid));

  for (const uuid of off) if (prompts.has(uuid)) abandoned.add(rootOf(uuid));

  return { kept: off.filter((uuid) => !abandoned.has(rootOf(uuid))), branches: abandoned.size };
}

/**
 * `<session>/subagents/agent-<id>.jsonl` with `<id>.meta.json` naming the tool call: regular files inside the CLI
 * home only (a linked sidecar directory or file reads nothing).
 */
function subagentFiles(session: SourceFile): Map<string, SourceFile> {
  const dir = join(session.path.slice(0, -".jsonl".length), "subagents");
  const files = new Map<string, SourceFile>();

  for (const entry of directoryEntries({ root: session.root, path: dir })) {
    if (!entry.isFile() || !entry.name.endsWith(".meta.json")) continue;
    const meta = readSourceText({ root: session.root, path: join(dir, entry.name) }, 64 * 1024);
    const transcript = { root: session.root, path: join(dir, entry.name.replace(/\.meta\.json$/, ".jsonl")) };

    if (meta === undefined || !sourceExists(transcript)) continue;
    const tool = jsonString(parseLine(meta)?.["toolUseId"]);

    if (tool) files.set(tool, transcript);
  }

  return files;
}
