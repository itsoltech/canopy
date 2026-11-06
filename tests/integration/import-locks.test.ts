import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { inspect } from "node:util";
import { create } from "@bufbuild/protobuf";
import { ImportPageSchema } from "@canopy/contracts";
import { dockerAvailable } from "@canopy/db/testing";
import { tempDir } from "@canopy/testing";
import { ThreadContinued } from "../../apps/gateway/src/imports/append.ts";
import { ingestPage } from "../../apps/gateway/src/imports/ingest.ts";
import { createRun, type ItemRow, type NewItem } from "../../apps/gateway/src/imports/store.ts";
import {
  cancelRun,
  failItem,
  finishItem,
  releaseDeleted,
  resumeRun,
  runnerRunStatus,
  undoRun,
} from "../../apps/gateway/src/imports/transitions.ts";
import { eventually } from "./support/gateway.ts";
import { importFixture } from "./support/imports.ts";

/**
 * Lock order of the CLI import (docs/import.md, "Blokady"), on PostgreSQL: append creation, undo, cancel, resume,
 * page writes, failures and the release of deleted threads run against the same threads at once, many rounds. None
 * of them may deadlock (40P01), and every thread keeps exactly one import that owns it.
 */
/** What the transactions below return; only failures matter here. */
type Outcome =
  | boolean
  | number
  | readonly string[]
  | void
  | { readonly undone: boolean }
  | { readonly failed: boolean };

describe.skipIf(!dockerAvailable)("CLI import: concurrent transactions", () => {
  const dir = tempDir("canopy-import-locks-");
  let f: Awaited<ReturnType<typeof importFixture>>;
  let threads: string[] = [];

  beforeAll(async () => {
    f = await importFixture(dir, { clis: ["claude"] });
    const { scanId } = await f.gw.api.scanImport({ workerId: f.workerId });
    const run = await f.gw.api.startImport({ scanId, selection: { allMatching: true }, mode: "history" });

    const done = await eventually(
      () => f.gw.api.getImportRun({ runId: run.id, items: true }),
      (r) => r.status === "completed",
      20_000,
    );

    threads = done.items.map((i) => i.threadId);
    // The runner stays out: only the transactions below touch these runs.
    f.disconnect();
  }, 120_000);

  afterAll(async () => {
    await f?.close();
  });

  const owning = (threadId: string) =>
    f.sql(
      (sql) => sql<ItemRow>`
        SELECT * FROM import_items WHERE thread_id = ${threadId}::uuid AND status = 'done' ORDER BY id DESC LIMIT 1`,
    );

  /** Append items continuing each thread from the item that owns it now. */
  async function planAppend(): Promise<NewItem[]> {
    const items: NewItem[] = [];

    for (const threadId of threads) {
      const owner = (await owning(threadId))[0];

      if (owner)
        items.push({
          agentCli: owner.agent_cli,
          rootId: owner.root_id,
          nativeId: owner.native_id,
          sourceKey: owner.source_key,
          title: owner.title,
          cwd: owner.cwd,
          snapshot: owner.snapshot,
          target: owner.target,
          bytes: BigInt(owner.bytes_total),
          continues: { itemId: owner.id, threadId, cursor: owner.cursor, bytesDone: owner.bytes_done },
        });
    }

    return items;
  }

  const startAppend = (id: string, items: readonly NewItem[]) =>
    f.sql((sql) =>
      createRun(sql, { id, ownerId: f.gw.userId, workerId: f.workerId, mode: "history", alreadyImported: 0, items }),
    );

  /** An append run, finished like the runner finishes it. */
  async function appendRun(): Promise<string | undefined> {
    const items = await planAppend();

    if (items.length === 0) return undefined;
    const id = Bun.randomUUIDv7();
    await startAppend(id, items);
    await finish(id);

    return id;
  }

  async function finish(runId: string): Promise<void> {
    for (const item of await runItems(runId)) await f.sql((sql) => finishItem(sql, item.id));
    await f.sql((sql) => runnerRunStatus(sql, runId, "completed"));
  }

  /** Starts after a random moment, so each round interleaves differently. */
  const jittered = async (run: () => Promise<Outcome>): Promise<void> => {
    await Bun.sleep(Math.random() * 4);
    await run();
  };

  const runItems = (runId: string) =>
    f.sql((sql) => sql<ItemRow>`SELECT * FROM import_items WHERE run_id = ${runId}::uuid ORDER BY id`);

  const deadlocked = (results: readonly PromiseSettledResult<unknown>[]) =>
    results.filter((r) => r.status === "rejected" && /40P01|deadlock/i.test(inspect(r.reason, { depth: 8 })));

  test("append creation, undo, cancel, resume and page writes never deadlock", async () => {
    let current = await appendRun();
    let deadlocks = 0;

    for (let round = 0; round < 40 && current; round++) {
      const runId = current;
      const items = await runItems(runId);

      const page = (item: ItemRow) =>
        create(ImportPageSchema, { nextCursor: item.cursor, bytesRead: BigInt(item.bytes_done) });

      // The next append continues this run's items, exactly what Undo gives back meanwhile.
      const next = await planAppend();

      const results = await Promise.allSettled(
        [
          () => f.sql((sql) => undoRun(sql, f.gw.userId, runId)),
          () => startAppend(Bun.randomUUIDv7(), next),
          () => f.sql((sql) => cancelRun(sql, f.gw.userId, runId)),
          () => f.sql((sql) => resumeRun(sql, f.gw.userId, runId)),
          ...items.flatMap((item) => [
            () => f.sql((sql) => ingestPage(sql, item, item.thread_id ?? "", page(item))),
            () => f.sql((sql) => failItem(sql, item.id, "the source changed")),
            () => f.sql((sql) => finishItem(sql, item.id)),
          ]),
          () => f.sql((sql) => releaseDeleted(sql, f.gw.userId, f.workerId)),
        ].map(jittered),
      );

      deadlocks += deadlocked(results).length;

      // Whatever won, settle it the way the runner and the owner would, and go on from what owns the threads now.
      const open = await f.sql(
        (sql) => sql<{ id: string }>`
          SELECT id FROM import_runs WHERE worker_id = ${f.workerId}::uuid AND status IN ('running', 'paused')`,
      );

      for (const { id } of open) {
        if (round % 3 === 0) await f.sql((sql) => cancelRun(sql, f.gw.userId, id));
        else await finish(id);
      }

      current = await appendRun();
    }

    expect(deadlocks).toBe(0);

    // Each thread is owned by exactly one live import, and its timeline ends where the thread says.
    for (const threadId of threads) {
      const live = await f.sql(
        (sql) => sql<{ n: number }>`
          SELECT count(*)::int AS n FROM import_items
           WHERE thread_id = ${threadId}::uuid AND status IN ('pending', 'importing', 'done', 'failed')`,
      );

      expect(live[0]!.n).toBe(1);

      const seq = await f.sql(
        (sql) => sql<{ last: string; max: string }>`
          SELECT t.last_seq::text AS last, coalesce((SELECT max(seq) FROM thread_events WHERE thread_id = t.id), 0)::text AS max
            FROM threads t WHERE t.id = ${threadId}::uuid`,
      );

      expect(seq[0]!.last).toBe(seq[0]!.max);
    }
  }, 120_000);

  test("undo of a run that a later import continued is refused and changes nothing", async () => {
    const earlier = (await appendRun())!;
    const later = (await appendRun())!;
    const before = await runItems(earlier);

    await expect(f.sql((sql) => undoRun(sql, f.gw.userId, earlier))).rejects.toBeInstanceOf(ThreadContinued);
    expect((await runItems(earlier)).map((i) => i.status)).toEqual(before.map((i) => i.status));
    expect((await f.sql((sql) => undoRun(sql, f.gw.userId, later))).undone).toBe(true);
  });
});
