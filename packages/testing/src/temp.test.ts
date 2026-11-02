import { describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const FIXTURE = join(import.meta.dir, "fixtures", "scopes.fixture.ts");
const PRELOAD = join(import.meta.dir, "preload.ts");

/** Runs the fixture in its own process with a private TMPDIR; returns its output and what is left there. */
async function run(env: Record<string, string>, interrupt?: (proc: Bun.Subprocess, output: () => string) => Promise<void>) {
  // The private TMPDIR itself is made by hand: the helper under test is not used to test itself.
  const tmp = mkdtempSync(join(tmpdir(), "oa-temp-test-"));
  try {
    const proc = Bun.spawn(["bun", "test", "--preload", PRELOAD, FIXTURE], { cwd: import.meta.dir, env: { ...process.env, ...env, TMPDIR: tmp }, stdout: "pipe", stderr: "pipe" });
    let output = "";
    const read = async (stream: ReadableStream<Uint8Array>) => {
      for await (const chunk of stream) output += new TextDecoder().decode(chunk);
    };
    const reading = Promise.all([read(proc.stdout), read(proc.stderr)]);
    if (interrupt) await interrupt(proc, () => output);
    const code = await proc.exited;
    await reading;
    return { code, output, left: readdirSync(tmp) };
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

describe("tempDir / tempDirs", () => {
  test("every directory is gone after the run; teardowns still see theirs", async () => {
    const { code, output, left } = await run({});
    expect(code).toBe(0);
    expect(output).toContain("teardown sees file dir: true, hook dir: true");
    expect(output).toContain("describe teardown sees its dir: true");
    expect(left).toEqual([]);
  });

  test("a failing test leaves nothing behind", async () => {
    const { code, left } = await run({ OA_SCOPE_FAIL: "1" });
    expect(code).not.toBe(0);
    expect(left).toEqual([]);
  });

  test("a run stopped by a signal leaves nothing behind", async () => {
    const { left, output } = await run({ OA_SCOPE_HANG: "1" }, async (proc, out) => {
      for (let i = 0; i < 200 && !out().includes("hanging with"); i++) await Bun.sleep(50);
      proc.kill("SIGTERM");
    });
    expect(output).toContain("hanging with");
    expect(left).toEqual([]);
  }, 30_000);
});
