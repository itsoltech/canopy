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

class SkillSnapshotError extends Error {}

const DescriptiveValue = Schema.Union([Schema.String, Schema.Number, Schema.Boolean, Schema.Null]);

const Metadata = Schema.Struct({
  name: Schema.optionalKey(DescriptiveValue),
  description: Schema.optionalKey(DescriptiveValue),
  "argument-hint": Schema.optionalKey(DescriptiveValue),
  "user-invocable": Schema.optionalKey(Schema.NullOr(Schema.Boolean)),
  "disable-model-invocation": Schema.optionalKey(Schema.NullOr(Schema.Boolean)),
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

    for (const name of directories)
      copyDirectory(join(source, name), join(plugin, name), budget, 0, new Set(), name === "commands");

    return [{ type: "local", path: plugin, skipMcpDiscovery: true }];
  } catch (error) {
    const reason = error instanceof SkillSnapshotError ? error.message : "Cannot read or copy the selected files.";

    throw new Error(
      `Cannot import Claude skills and commands. ${reason} Check the source or turn off Personal skills in Settings → Providers.`,
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

  if (!lstatSync(realpathSync(path)).isDirectory())
    throw new SkillSnapshotError("The source must contain directories.");

  return true;
}

function copyDirectory(
  source: string,
  destination: string,
  budget: SnapshotBudget,
  depth: number,
  ancestors: ReadonlySet<string>,
  commands: boolean,
): void {
  const canonical = realpathSync(source);

  if (depth > MAX_DEPTH) throw new SkillSnapshotError("Directories exceed 32 nesting levels.");

  if (ancestors.has(canonical)) throw new SkillSnapshotError("A directory link creates a cycle.");
  sourceDirectory(canonical);
  const visited = new Set(ancestors).add(canonical);

  mkdirSync(destination, { mode: 0o700 });

  for (const name of readdirSync(canonical)) {
    budget.entries += 1;

    if (budget.entries > MAX_ENTRIES) throw new SkillSnapshotError("The source exceeds 2048 files and directories.");
    const path = realpathSync(join(canonical, name));
    const target = join(destination, name);
    const stat = lstatSync(path);

    if (stat.isDirectory()) {
      copyDirectory(path, target, budget, depth + 1, visited, commands);
      continue;
    }

    if (!stat.isFile()) throw new SkillSnapshotError("The source contains a file that is not a regular file.");
    const bytes = readFile(path, stat, budget);
    // Only definitions control runtime behavior; reference documents are opaque skill assets.
    const definition = /^SKILL\.md$/i.test(name) || (commands && /\.(md|markdown)$/i.test(name));
    const snapshot = definition ? sanitizeMarkdown(bytes) : bytes;

    budget.output += snapshot.length;

    checkSize(snapshot.length, budget.output);
    writeFileSync(target, snapshot, { mode: 0o600 | (stat.mode & 0o100), flag: "wx" });
  }
}

function readFile(path: string, expected: Stats, budget: SnapshotBudget): Buffer {
  const descriptor = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));

  try {
    const stat = fstatSync(descriptor);

    if (!stat.isFile() || stat.ino !== expected.ino || stat.dev !== expected.dev)
      throw new SkillSnapshotError("A source file changed while reading.");
    checkSize(stat.size, budget.input + stat.size);
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
      throw new SkillSnapshotError("A source file changed while reading.");
    budget.input += length;

    return buffer.subarray(0, length);
  } finally {
    closeSync(descriptor);
  }
}

function checkSize(file: number, total: number): void {
  if (file > SKILL_FILE_BYTES) throw new SkillSnapshotError("Use at most 1 MiB per file.");

  if (total > SKILL_TOTAL_BYTES) throw new SkillSnapshotError("Use at most 25 MiB in total.");
}

function sanitizeMarkdown(bytes: Buffer): Buffer {
  if (!isUtf8(bytes)) throw new SkillSnapshotError("A skill or command definition is not valid UTF-8.");
  const text = bytes.toString("utf8");
  const opening = /^(?:\uFEFF)?\s*---[ \t]*\r?\n/.exec(text);

  if (!opening) return bytes;
  const remaining = text.slice(opening[0].length);
  const closing = /^(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/m.exec(remaining);

  if (!closing) throw new SkillSnapshotError("A skill or command definition has unclosed YAML frontmatter.");
  const body = remaining.slice(closing.index + closing[0].length);

  try {
    const metadata = Schema.decodeUnknownSync(Metadata)(Bun.YAML.parse(remaining.slice(0, closing.index)) ?? {});

    return Buffer.from(`---\n${Bun.YAML.stringify(metadata)}\n---\n${body}`);
  } catch {
    throw new SkillSnapshotError("A skill or command definition has invalid YAML metadata.");
  }
}
