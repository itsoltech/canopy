import type { Options } from "@anthropic-ai/claude-agent-sdk";
import { SKILL_FILE_BYTES, SKILL_TOTAL_BYTES } from "@canopy/domain/skill-artifact";
import { Schema } from "effect";
import { isUtf8 } from "node:buffer";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  readdirSync,
  realpathSync,
  writeFileSync,
  type Stats,
} from "node:fs";
import { join } from "node:path";

export const CLAUDE_USER_PLUGIN_NAME = "canopy-user";

const MAX_ENTRIES = 2048;
const MAX_DEPTH = 32;

const Metadata = Schema.Struct({
  name: Schema.optionalKey(Schema.String),
  description: Schema.optionalKey(Schema.String),
  "argument-hint": Schema.optionalKey(Schema.String),
  "user-invocable": Schema.optionalKey(Schema.Boolean),
  "disable-model-invocation": Schema.optionalKey(Schema.Boolean),
});

interface SnapshotBudget {
  input: number;
  output: number;
  entries: number;
}

/** A private snapshot prevents source edits from adding runtime metadata after validation. */
export function claudeUserSkillSnapshots(
  sourceHome: string,
  privateDirectory: () => string,
): NonNullable<Options["plugins"]> {
  let source: string;

  try {
    source = realpathSync(sourceHome);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return [];

    throw new Error("Cannot inspect the selected Claude configuration directory.");
  }

  try {
    const directories = ["skills", "commands"].filter((name) => sourceDirectory(join(source, name)));

    if (directories.length === 0) return [];
    const plugin = join(privateDirectory(), "plugin");
    const budget: SnapshotBudget = { input: 0, output: 0, entries: 0 };

    mkdirSync(join(plugin, ".claude-plugin"), { recursive: true, mode: 0o700 });
    writeFileSync(
      join(plugin, ".claude-plugin", "plugin.json"),
      JSON.stringify({ name: CLAUDE_USER_PLUGIN_NAME, version: "1.0.0" }),
      { mode: 0o600, flag: "wx" },
    );

    for (const name of directories) copyDirectory(join(source, name), join(plugin, name), budget, 0, new Set());

    return [{ type: "local", path: plugin, skipMcpDiscovery: true }];
  } catch {
    throw new Error(
      "Cannot import Claude skills and commands. Use regular files, acyclic directories, valid Markdown frontmatter, and at most 1 MiB per file and 25 MiB in total.",
    );
  }
}

function sourceDirectory(path: string): boolean {
  try {
    lstatSync(path);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
    throw error;
  }

  if (!lstatSync(realpathSync(path)).isDirectory()) throw new Error("Invalid directory.");

  return true;
}

function copyDirectory(
  source: string,
  destination: string,
  budget: SnapshotBudget,
  depth: number,
  ancestors: ReadonlySet<string>,
): void {
  const canonical = realpathSync(source);

  if (depth > MAX_DEPTH || ancestors.has(canonical) || !sourceDirectory(canonical))
    throw new Error("Invalid directory.");
  const visited = new Set(ancestors).add(canonical);

  mkdirSync(destination, { mode: 0o700 });

  for (const name of readdirSync(canonical)) {
    budget.entries += 1;

    if (budget.entries > MAX_ENTRIES) throw new Error("Too many entries.");
    const path = realpathSync(join(canonical, name));
    const target = join(destination, name);
    const stat = lstatSync(path);

    if (stat.isDirectory()) {
      copyDirectory(path, target, budget, depth + 1, visited);
      continue;
    }

    if (!stat.isFile()) throw new Error("Invalid entry.");
    const bytes = readFile(path, stat, budget);
    const snapshot = /\.(md|markdown)$/i.test(name) ? sanitizeMarkdown(bytes) : bytes;

    budget.output += snapshot.length;

    if (snapshot.length > SKILL_FILE_BYTES || budget.output > SKILL_TOTAL_BYTES) throw new Error("Snapshot too large.");
    writeFileSync(target, snapshot, { mode: 0o600 | (stat.mode & 0o100), flag: "wx" });
  }
}

function readFile(path: string, expected: Stats, budget: SnapshotBudget): Buffer {
  const descriptor = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));

  try {
    const stat = fstatSync(descriptor);

    if (
      !stat.isFile() ||
      stat.ino !== expected.ino ||
      stat.dev !== expected.dev ||
      stat.size > SKILL_FILE_BYTES ||
      stat.size > SKILL_TOTAL_BYTES - budget.input
    )
      throw new Error("Invalid file.");
    const buffer = Buffer.alloc(stat.size + 1);
    let length = 0;

    while (length < buffer.length) {
      const read = readSync(descriptor, buffer, length, buffer.length - length, null);

      if (!read) break;
      length += read;
    }

    const after = fstatSync(descriptor);

    if (
      length !== stat.size ||
      after.size !== stat.size ||
      after.mtimeMs !== stat.mtimeMs ||
      after.ctimeMs !== stat.ctimeMs
    )
      throw new Error("The file changed while reading.");
    budget.input += length;

    return buffer.subarray(0, length);
  } finally {
    closeSync(descriptor);
  }
}

function sanitizeMarkdown(bytes: Buffer): Buffer {
  if (!isUtf8(bytes)) throw new Error("Invalid Markdown encoding.");
  const text = bytes.toString("utf8");
  const opening = /^(?:\uFEFF)?\s*---[ \t]*\r?\n/.exec(text);

  if (!opening) return bytes;
  const remaining = text.slice(opening[0].length);
  const closing = /^(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/m.exec(remaining);

  if (!closing) throw new Error("Invalid Markdown frontmatter.");
  const metadata = Schema.decodeUnknownSync(Metadata)(Bun.YAML.parse(remaining.slice(0, closing.index)) ?? {});
  const body = remaining.slice(closing.index + closing[0].length);

  return Buffer.from(`---\n${Bun.YAML.stringify(metadata)}\n---\n${body}`);
}
