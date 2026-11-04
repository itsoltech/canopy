import { expect, test } from "bun:test";
import { join } from "node:path";

async function notarization(scenario: string) {
  const child = Bun.spawn([process.execPath, join(import.meta.dir, "notarization.fixture.ts"), scenario], {
    stdout: "pipe",
    stderr: "pipe",
  });

  const [output, errors, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);

  expect({ code, errors }).toEqual({ code: 0, errors: "" });

  // SAFETY: The repository-owned fixture emits exactly these fields after running notarize.
  return JSON.parse(output) as { error: string; commands: string[]; delays: number[] };
}

test("notarization retries transient staple and validation failures before accepting the artifact", async () => {
  for (const scenario of ["transient", "validation"]) {
    const result = await notarization(scenario);
    expect(result.error).toBe("");
    expect(result.commands.filter((command) => command === "notarytool submit")).toHaveLength(1);
    expect(result.commands.filter((command) => command === "stapler staple")).toHaveLength(2);
    expect(result.commands.at(-1)).toBe("stapler validate");
    expect(result.delays).toEqual([15_000]);
  }
});

test("notarization fails after bounded backoff and never staples a rejected submission", async () => {
  const exhausted = await notarization("exhausted");
  expect(exhausted.error).toContain("Failed to staple your application with code: 68");
  expect(exhausted.commands.filter((command) => command === "notarytool submit")).toHaveLength(1);
  expect(exhausted.commands.filter((command) => command === "stapler staple")).toHaveLength(5);
  expect(exhausted.delays).toEqual([15_000, 30_000, 60_000, 60_000]);
  const rejected = await notarization("rejected");
  expect(rejected.error).toContain("Failed to notarize via notarytool");
  expect(rejected.commands.some((command) => command.startsWith("stapler"))).toBe(false);
  expect(rejected.delays).toEqual([]);
});
