import { expect, test } from "bun:test";
import { HighlightPool } from "./highlight-pool.ts";

test("closing queued syntax work cancels only its thread and leaves the shared executor usable", async () => {
  const pool = new HighlightPool();

  const task = (threadId: string) => ({
    threadId,
    key: threadId,
    path: "file.ts",
    source: "const value = 42;",
    start: 1,
    count: 1,
  });

  const cancelled = pool.run(task("archived"));
  const survivor = pool.run(task("survivor"));
  const checked = cancelled.catch((cause: Error) => cause);

  try {
    pool.closeThread("archived");
    expect(await checked).toMatchObject({ message: "Highlighting was cancelled." });
    const result = await survivor;
    expect(result.lines).toHaveLength(1);
    pool.closeThread("survivor");
    expect((await pool.run(task("fresh"))).lines).toHaveLength(1);
  } finally {
    pool.close();
    await Promise.allSettled([cancelled, survivor]);
  }
});

test("closing an executing highlighter terminates its worker and queued work for another thread completes", async () => {
  const pool = new HighlightPool();

  const task = (threadId: string) => ({
    threadId,
    key: threadId,
    path: "file.ts",
    source: "const value = 42;",
    start: 1,
    count: 1,
  });

  const active = pool.run(task("archived")).catch((cause: Error) => cause);
  await Promise.resolve();
  const survivor = pool.run(task("survivor"));

  try {
    pool.closeThread("archived");
    expect(await active).toMatchObject({ message: "Highlighting was cancelled." });
    expect((await survivor).lines).toHaveLength(1);
  } finally {
    pool.close();
    await survivor.catch(() => {});
  }
});
