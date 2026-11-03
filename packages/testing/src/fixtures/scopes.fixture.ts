/**
 * Run by temp.test.ts in its own process (with a private TMPDIR): directories made at every level, a teardown that
 * still uses its directory, a skipped describe, a failing test and one interrupted by a signal. Afterwards nothing
 * may be left.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tempDir, tempDirs } from "../index.ts";

const fileLevel = tempDir("canopy-scope-file-");
const tmp = tempDirs();
let fromHook = "";

beforeAll(() => {
  fromHook = tmp("canopy-scope-hook-");
});

// Registered after the directory was made: it still finds it (the directory goes after the scope's other hooks).
afterAll(() => {
  console.log(`teardown sees file dir: ${existsSync(fileLevel)}, hook dir: ${existsSync(fromHook)}`);
  writeFileSync(join(fileLevel, "written-at-teardown"), "x");
});

describe("a describe", () => {
  const inDescribe = tempDir("canopy-scope-describe-");
  afterAll(() => console.log(`describe teardown sees its dir: ${existsSync(inDescribe)}`));

  test("a hook's directory lives through the tests", () => {
    expect(existsSync(fromHook)).toBe(true);
    writeFileSync(join(tmp("canopy-scope-test-"), "f"), "x");
  });
});

// bun runs a skipped describe's body (the directory is made) but not its afterAll: the run's end removes it.
describe.skipIf(true)("a skipped describe", () => {
  tempDir("canopy-scope-skipped-");
  test("never runs", () => {});
});

test("an interrupted run leaves nothing behind either", async () => {
  if (process.env["CANOPY_SCOPE_HANG"] !== "1") return;
  console.log(`hanging with ${tmp("canopy-scope-hanging-")}`);
  await Bun.sleep(60_000);
}, 70_000);

test("a failing test still leaves nothing behind", () => {
  tmp("canopy-scope-failing-");
  expect(process.env["CANOPY_SCOPE_FAIL"]).toBeUndefined();
});
