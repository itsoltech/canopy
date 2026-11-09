import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { dockerAvailable } from "@canopy/db/testing";
import { Effect } from "effect";
import { SqlClient } from "effect/sql";
import {
  createRun,
  items,
  itemSummaries,
  runs,
  type NewItem,
  setRunStatus,
} from "../../apps/gateway/src/imports/store.ts";
import { libraryItems, type NewLibraryItem } from "../../apps/gateway/src/imports/library-store.ts";
import { startTestGateway, type TestGateway } from "./support/gateway.ts";

describe.skipIf(!dockerAvailable)("bulk import admission durability", () => {
  let gateway: TestGateway;
  beforeAll(async () => {
    gateway = await startTestGateway();
  }, 60_000);
  afterAll(async () => {
    await gateway?.close();
  });

  const newItems = (prefix: string): NewItem[] =>
    Array.from({ length: 300 }, (_, n) => ({
      agentCli: "codex",
      rootId: "synthetic",
      nativeId: `${prefix}-${n}`,
      sourceKey: `source-${n}`,
      title: `Import ${n}`,
      cwd: "/repo",
      snapshot: { size: "9007199254740993", modifiedMs: "0", prefixSha256: "" },
      target: { projectId: "", workspaceId: "", cwd: "/repo", mode: "history" },
      bytes: 9007199254740993n,
    }));

  const library = (prefix: string): NewLibraryItem[] =>
    Array.from({ length: 300 }, (_, n) => ({
      agentCli: "codex",
      rootId: "synthetic",
      kind: "setting",
      name: `${prefix}-${n}`,
      digest: `digest-${n}`,
      sourceKey: `source-${n}`,
      value: `value-${n}`,
      label: `Setting ${n}`,
      action: "import",
    }));

  const admit = (id: string, entries: readonly NewItem[], configuration: readonly NewLibraryItem[]) =>
    gateway.runtime.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* createRun(sql, {
          id,
          ownerId: gateway.userId,
          workerId: gateway.workerId,
          mode: "history",
          alreadyImported: 0,
          items: entries,
          library: configuration,
        });
      }),
    );

  test("several batches preserve order, owner, JSON and bigint byte counts across restart", async () => {
    const id = Bun.randomUUIDv7();
    await admit(id, newItems(id), library(id));
    await gateway.runtime.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* setRunStatus(sql, id, "paused");
      }),
    );

    const storage = {
      pg: gateway.pg,
      secretsKey: gateway.secretsKey,
      workerId: gateway.workerId,
      workerCredential: gateway.workerCredential,
    };

    await gateway.close(true);
    gateway = await startTestGateway({ storage });

    const saved = await gateway.runtime.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;

        return { entries: yield* items(sql, id), configuration: yield* libraryItems(sql, id) };
      }),
    );

    expect(saved.entries).toHaveLength(300);
    expect(saved.configuration).toHaveLength(300);

    for (const [position, item] of saved.entries.entries()) {
      expect(item).toMatchObject({
        position,
        owner_user_id: gateway.userId,
        worker_id: gateway.workerId,
        native_id: `${id}-${position}`,
        status: "pending",
        target: { mode: "history" },
        snapshot: { size: "9007199254740993" },
      });
      expect(BigInt(item.bytes_total)).toBe(9007199254740993n);
      expect(saved.configuration[position]).toMatchObject({
        position,
        name: `${id}-${position}`,
        owner_user_id: gateway.userId,
      });
    }

    await gateway.core.linkedAgents.query(`UPDATE import_runs SET status='cancelled' WHERE id=$1::uuid`, [id]);
  }, 30_000);

  test("a conflict in a later batch rolls back the run, earlier batches and library rows", async () => {
    const id = Bun.randomUUIDv7();
    const entries = newItems(id);
    entries[299] = { ...entries[299]!, nativeId: entries[0]!.nativeId };
    await expect(admit(id, entries, library(id))).rejects.toThrow();

    const rows = await gateway.core.linkedAgents.query(
      `SELECT
      (SELECT count(*)::int FROM import_runs WHERE id=$1::uuid) AS runs,
      (SELECT count(*)::int FROM import_items WHERE run_id=$1::uuid) AS items,
      (SELECT count(*)::int FROM import_library_items WHERE run_id=$1::uuid) AS library`,
      [id],
    );

    expect(rows).toEqual([{ runs: 0, items: 0, library: 0 }]);
  });

  test("progress preserves mixed statuses, exact bytes, first importing title and owner scope", async () => {
    const id = Bun.randomUUIDv7();
    await admit(id, newItems(id).slice(0, 7), library(id).slice(0, 3));
    await gateway.core.linkedAgents.query(
      `UPDATE import_items SET status =
      (ARRAY['done','failed','cancelled','importing','superseded','undone','importing'])[position+1],
      bytes_done=17, base=jsonb_build_object('large',repeat('x',100000)) WHERE run_id=$1::uuid`,
      [id],
    );
    await gateway.core.linkedAgents.query(
      `UPDATE import_library_items SET status =
      (ARRAY['done','failed','cancelled'])[position+1] WHERE run_id=$1::uuid`,
      [id],
    );

    const result = await gateway.runtime.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;

        return {
          progress: (yield* runs(sql, gateway.userId, id))[0]!,
          summaries: yield* itemSummaries(sql, id),
          foreign: yield* runs(sql, Bun.randomUUIDv7(), id),
        };
      }),
    );

    expect(result.progress).toMatchObject({
      total: 7,
      done: 1,
      failed: 1,
      cancelled: 1,
      library_done: 1,
      library_failed: 1,
      current: "Import 3",
      bytes_total: String(6n * 9007199254740993n),
      bytes_done: String(9007199254740993n + 6n * 17n),
    });
    expect(result.foreign).toEqual([]);
    expect(result.summaries.map((row) => row.title)).toEqual(
      newItems(id)
        .slice(0, 7)
        .map((row) => row.title),
    );
    expect(result.summaries[0]).toMatchObject({ target: { mode: "history" } });
    expect(result.summaries[0]).not.toHaveProperty("base");
    expect(result.summaries[0]).not.toHaveProperty("snapshot");
  });
});
