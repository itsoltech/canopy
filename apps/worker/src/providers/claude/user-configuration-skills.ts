import type { Options } from "@anthropic-ai/claude-agent-sdk";
import { Schema } from "effect";
import { isUtf8 } from "node:buffer";
import {
  constants,
  createWriteStream,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  realpathSync,
  type Stats,
} from "node:fs";
import { open, writeFile, type FileHandle } from "node:fs/promises";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";

export const CLAUDE_USER_PLUGIN_NAME = "canopy-user";

// This budget covers the entire personal library, including all supporting assets.
const MAX_ENTRIES = 100_000;
const MAX_DEPTH = 32;
const MIB = 1024 * 1024;
const MAX_DEFINITION_MIB = 10;
const MAX_ASSET_MIB = 64;
const MAX_TOTAL_MIB = 256;

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
export async function claudeUserSkillSnapshots(
  sourceHome: string,
  privateDirectory: () => string,
): Promise<NonNullable<Options["plugins"]>> {
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
    await writeFile(
      join(plugin, ".claude-plugin", "plugin.json"),
      JSON.stringify({ name: CLAUDE_USER_PLUGIN_NAME, version: "1.0.0" }),
      { mode: 0o600, flag: "wx" },
    );

    for (const name of directories)
      await copyDirectory(join(source, name), join(plugin, name), budget, 0, new Set(), name === "commands");

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

async function copyDirectory(
  source: string,
  destination: string,
  budget: SnapshotBudget,
  depth: number,
  ancestors: ReadonlySet<string>,
  commands: boolean,
): Promise<void> {
  const canonical = realpathSync(source);

  if (depth > MAX_DEPTH) throw new SkillSnapshotError("Directories exceed 32 nesting levels.");

  if (ancestors.has(canonical)) throw new SkillSnapshotError("A directory link creates a cycle.");
  sourceDirectory(canonical);
  const visited = new Set(ancestors).add(canonical);

  mkdirSync(destination, { mode: 0o700 });

  for (const name of readdirSync(canonical)) {
    // Claude can load a skill at .trash/SKILL.md, but does not discover archived skills inside it.
    if (depth === 0 && !commands && name === ".trash" && !existsSync(join(canonical, name, "SKILL.md"))) continue;

    budget.entries += 1;

    if (budget.entries > MAX_ENTRIES)
      throw new SkillSnapshotError(`The source exceeds ${MAX_ENTRIES} files and directories.`);
    const path = realpathSync(join(canonical, name));
    const target = join(destination, name);
    const stat = lstatSync(path);

    if (stat.isDirectory()) {
      await copyDirectory(path, target, budget, depth + 1, visited, commands);
      continue;
    }

    if (!stat.isFile()) throw new SkillSnapshotError("The source contains a file that is not a regular file.");
    // Only definitions control runtime behavior; reference documents are opaque skill assets.
    const definition = /^SKILL\.md$/i.test(name) || (commands && /\.(md|markdown)$/i.test(name));

    await copyFile(path, target, stat, budget, definition);
  }
}

async function copyFile(
  path: string,
  target: string,
  expected: Stats,
  budget: SnapshotBudget,
  definition: boolean,
): Promise<void> {
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));

  try {
    const stat = await handle.stat();

    if (!stat.isFile() || stat.ino !== expected.ino || stat.dev !== expected.dev)
      throw new SkillSnapshotError("A source file changed while reading.");
    checkSize(stat.size, budget.input + stat.size, definition);
    const mode = 0o600 | (stat.mode & 0o100);
    let outputSize = stat.size;

    if (definition) {
      const snapshot = sanitizeMarkdown(await readDefinition(handle, stat.size));

      outputSize = snapshot.length;
      checkSize(outputSize, budget.output + outputSize, true);
      await writeFile(target, snapshot, { mode, flag: "wx" });
    } else {
      checkSize(outputSize, budget.output + outputSize, false);
      await copyAsset(handle, target, stat.size, mode);
    }

    const after = await handle.stat();

    if (after.size !== stat.size || after.mtimeMs !== stat.mtimeMs || after.ctimeMs !== stat.ctimeMs)
      throw new SkillSnapshotError("A source file changed while reading.");
    budget.input += stat.size;
    budget.output += outputSize;
  } finally {
    await handle.close();
  }
}

async function readDefinition(handle: FileHandle, size: number): Promise<Buffer> {
  const buffer = Buffer.alloc(size + 1);
  let length = 0;

  while (length < buffer.length) {
    const { bytesRead } = await handle.read(buffer, length, buffer.length - length, null);

    if (!bytesRead) break;
    length += bytesRead;
  }

  if (length !== size) throw new SkillSnapshotError("A source file changed while reading.");

  return buffer.subarray(0, size);
}

async function copyAsset(handle: FileHandle, target: string, size: number, mode: number): Promise<void> {
  if (size === 0) {
    await writeFile(target, "", { mode, flag: "wx" });

    return;
  }

  // Bound the stream to the validated size even if the source grows during the copy.
  const input = handle.createReadStream({ start: 0, end: size - 1, autoClose: false });

  await pipeline(input, createWriteStream(target, { mode, flags: "wx" }));

  if (input.bytesRead !== size) throw new SkillSnapshotError("A source file changed while reading.");
}

function checkSize(file: number, total: number, definition: boolean): void {
  const limit = definition ? MAX_DEFINITION_MIB : MAX_ASSET_MIB;

  if (file > limit * MIB) {
    const kind = definition ? "skill or command definition" : "supporting file";

    throw new SkillSnapshotError(`Use at most ${limit} MiB per ${kind}.`);
  }

  if (total > MAX_TOTAL_MIB * MIB) throw new SkillSnapshotError(`Use at most ${MAX_TOTAL_MIB} MiB in total.`);
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
