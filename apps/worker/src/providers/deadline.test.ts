import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { withDeadline } from "./deadline.ts";

describe("withDeadline", () => {
  test("the work's result, or the timeout's answer or error", async () => {
    expect(await withDeadline(Promise.resolve(1), 1_000, () => "late")).toBe(1);
    expect(await withDeadline(new Promise(() => {}), 10, () => "late")).toBe("late");
    expect(
      await withDeadline(new Promise(() => {}), 10, () => {
        throw new Error("too slow");
      }).catch((e: Error) => e.message),
    ).toBe("too slow");
    expect(await withDeadline(Promise.reject(new Error("failed")), 1_000, () => "late").catch((e: Error) => e.message)).toBe("failed");
  });

  test("a settled race does not keep the process alive until the deadline (a stopped worker exits at once)", async () => {
    const script = `import { withDeadline } from ${JSON.stringify(join(import.meta.dir, "deadline.ts"))};\nawait withDeadline(Promise.resolve(1), 60_000, () => 0);`;
    const started = Date.now();
    const proc = Bun.spawn(["bun", "-e", script], { stdout: "ignore", stderr: "pipe" });
    expect(await proc.exited).toBe(0);
    expect(Date.now() - started).toBeLessThan(10_000);
  });
});
