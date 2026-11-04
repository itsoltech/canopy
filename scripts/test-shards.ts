/** Deterministic, duration-balanced file lists; each shard goes through the same temp-directory gate. */
import { resolve } from "node:path";
import { readFileSync, readdirSync } from "node:fs";
import recorded from "./test-timings.json";
import type { JsonObject, JsonValue } from "@canopy/domain";

const root = resolve(import.meta.dir, "..");
export const shardCount = 4;

function testFiles(): string[] {
  const tracked = Bun.spawnSync(["git", "ls-files", "-z", "--cached", "--others", "--exclude-standard"], { cwd: root });

  if (tracked.exitCode !== 0) throw new Error("Could not discover test files");

  return [...new Set(tracked.stdout.toString().split("\0"))]
    .filter((file) => /[._](test|spec)\.[cm]?[jt]sx?$/.test(file))
    .sort();
}

function partition(files: string[]) {
  const timings = new Map<string, number>(Object.entries(recorded.files));
  const shards: { files: string[]; ms: number }[] = Array.from({ length: shardCount }, () => ({ files: [], ms: 0 }));

  // Longest first, lexical ties, then the least loaded shard (index breaks ties).
  for (const file of files.toSorted(
    (a, b) => (timings.get(b) ?? 1000) - (timings.get(a) ?? 1000) || a.localeCompare(b),
  )) {
    const target = shards.toSorted((a, b) => a.ms - b.ms)[0]!;
    target.files.push(file);
    target.ms += timings.get(file) ?? 1000;
  }

  return shards;
}

export function checkedShards() {
  const files = testFiles();
  const shards = partition(files);
  const assigned = shards.flatMap((shard) => shard.files).sort();

  if (files.length === 0 || shards.some((shard) => shard.files.length === 0)) throw new Error("Empty test shard");

  if (assigned.length !== files.length || assigned.some((file, index) => file !== files[index]))
    throw new Error("Test shards must cover every discovered test file exactly once");

  return shards;
}

/** Compare reports from actual runs too, so a missing shard or ignored file cannot turn the gate green. */
function verifyReports(directory: string) {
  const reports = readdirSync(directory).filter((file) => /^timings-\d+\.json$/.test(file));

  if (reports.length !== shardCount) throw new Error(`Expected ${shardCount} timing reports, got ${reports.length}`);

  const executed: string[] = [];

  for (const report of reports) {
    const data: JsonValue = JSON.parse(readFileSync(resolve(directory, report), "utf8"));

    if (!jsonObject(data) || data["version"] !== 1 || !jsonObject(data["files"]))
      throw new Error(`Invalid report ${report}`);

    executed.push(...Object.keys(data["files"]));
  }

  const expected = testFiles();
  executed.sort();

  if (executed.length !== expected.length || executed.some((file, index) => file !== expected[index]))
    throw new Error("Shard reports must contain every test file exactly once");

  console.log(`Verified ${expected.length} test files executed exactly once across ${reports.length} shards`);
}

function jsonObject(value: JsonValue | undefined): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

if (import.meta.main) {
  const shards = checkedShards();
  const selection = process.argv[2];

  for (const [index, shard] of shards.entries())
    console.log(
      `Shard ${index + 1}/${shardCount}: ${shard.files.length} files, recorded ${(shard.ms / 1000).toFixed(1)}s`,
    );

  if (selection === "--verify-reports") {
    const directory = process.argv[3];

    if (!directory) throw new Error("--verify-reports requires a directory");

    verifyReports(directory);
  } else if (selection !== "--check") {
    const shard = shards[Number(selection) - 1];

    if (!shard || !/^[1-4]$/.test(selection ?? ""))
      throw new Error("Usage: bun scripts/test-shards.ts <1..4|--check> [bun test arguments]");

    console.log(shard.files.join("\n"));

    const child = Bun.spawn(
      [process.execPath, "run", "check:tmp", ...shard.files.map((file) => `./${file}`), ...process.argv.slice(3)],
      { cwd: root, stdio: ["inherit", "inherit", "inherit"] },
    );

    for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => child.kill(signal));

    process.exit(await child.exited);
  }
}
