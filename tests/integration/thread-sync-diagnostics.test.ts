import { expect, test } from "bun:test";
import { create, toBinary, toJsonString } from "@bufbuild/protobuf";
import { ui } from "@canopy/contracts";
import { dockerAvailable } from "@canopy/db/testing";
import { ComputerStore } from "../../apps/gateway/src/computers/store.ts";
import { startTestGateway } from "./support/gateway.ts";
import { ThreadRangeStore } from "../../apps/gateway/src/computers/range-store.ts";
import { groupThreadSyncDiagnostics } from "@canopy/domain/thread-sync-display";

test.skipIf(!dockerAvailable)(
  "sync diagnostics are durable, bounded, sanitized and owner scoped over gRPC",
  async () => {
    const gateway = await startTestGateway({ role: "desktop" });
    const store = new ComputerStore(gateway.runtime, gateway.userId, gateway.secretsKey);
    const node = "a".repeat(64);
    const foreign = crypto.randomUUID();

    try {
      await store.query(
        "INSERT INTO users(id,email,display_name,role) VALUES($1::uuid,'diagnostics@example.test','Other','user')",
        [foreign],
      );

      for (const owner of [gateway.userId, foreign]) {
        await store.query(
          `INSERT INTO computer_peers(owner_user_id,node_id,name,certificate,fingerprint)
        VALUES($1::uuid,$2,$3,'unused','unused')`,
          [owner, node, owner === foreign ? "FOREIGN_COMPUTER" : "Linked computer"],
        );
        await store.query("INSERT INTO computer_mirror_state(owner_user_id,origin_node_id) VALUES($1::uuid,$2)", [
          owner,
          node,
        ]);
        await store.query(
          `INSERT INTO thread_range_state(owner_user_id,origin_node_id,thread_id,epoch,visible_epoch,
        applied_seq,head_seq,visible_applied_seq,subscription_id)
        SELECT $1::uuid,$2,gen_random_uuid(),gen_random_uuid(),gen_random_uuid(),10,15,10,gen_random_uuid()
        FROM generate_series(1,102)`,
          [owner, node],
        );
      }

      const rows = await store.query<{ thread: string }>(
        `SELECT thread_id::text AS thread FROM thread_range_state
      WHERE owner_user_id=$1::uuid ORDER BY thread_id`,
        [gateway.userId],
      );

      const failed = rows[0]!.thread;
      await store.query(
        `INSERT INTO thread_range_failures(owner_user_id,origin_node_id,thread_id,reason,code,retryable,frame_bytes)
      VALUES($1::uuid,$2,$3::uuid,'size_limit',8,false,4294967295),($1::uuid,$2,$4::uuid,'PRIVATE_EXCEPTION_TEXT',13,false,0)`,
        [gateway.userId, node, failed, rows[1]!.thread],
      );
      const first = await gateway.api.getThreadSyncDiagnostics({ pageSize: 1 }, { timeoutMs: 3000 });
      expect(first.entries).toHaveLength(1);
      expect(first.remaining).toBe(510n);
      expect(first.syncingThreads).toBe(102);
      expect(first.failedThreads).toBe(2);
      expect(first.entries[0]?.remaining).toBe(5n);
      expect(first.entries[0]?.appliedSeq).toBe(10n);
      expect(first.entries[0]?.headSeq).toBe(15n);
      expect(first.entries[0]?.reason).toBe("size_limit");
      expect(first.entries[0]?.frameBytes).toBe(4294967295);
      expect(first.entries[0]?.caughtUp).toBe(false);
      expect(first.entries[0]?.observedAtMs).toBeGreaterThan(0n);

      const second = await gateway.api.getThreadSyncDiagnostics(
        { after: first.next, pageSize: 1000 },
        { timeoutMs: 3000 },
      );

      expect(second.entries).toHaveLength(100);
      expect(second.entries[0]?.reason).toBe("watch_failed");
      expect(second.entries.some((entry) => entry.threadId === first.entries[0]?.threadId)).toBe(false);
      const last = await gateway.api.getThreadSyncDiagnostics({ after: second.next }, { timeoutMs: 3000 });
      expect(last.entries).toHaveLength(1);
      expect(last.next).toBe("");

      for (const page of [first, second, last]) {
        const json = toJsonString(ui.ThreadSyncDiagnosticsSchema, page);
        expect(json).not.toContain("PRIVATE_EXCEPTION_TEXT");
        expect(json).not.toContain("FOREIGN_COMPUTER");
      }

      const reset = await gateway.api.getThreadSyncDiagnostics({ after: "invalid", pageSize: 1 }, { timeoutMs: 3000 });
      expect(reset.entries[0]?.threadId).toBe(first.entries[0]?.threadId);
      await store.query("DELETE FROM thread_range_failures WHERE owner_user_id=$1::uuid", [gateway.userId]);
      await store.query("UPDATE thread_range_state SET applied_seq=head_seq WHERE owner_user_id=$1::uuid", [
        gateway.userId,
      ]);
      const done = await gateway.api.getThreadSyncDiagnostics({});
      expect(done.remaining).toBe(0n);
      expect(done.syncingThreads).toBe(0);
      expect(done.failedThreads).toBe(0);
      expect(done.entries.every((entry) => entry.caughtUp)).toBe(true);
      expect((await gateway.api.getOverview({})).workers.length).toBeGreaterThan(0);
    } finally {
      await gateway.close();
    }
  },
  30000,
);

async function seedComputer(store: ComputerStore, owner: string, node: string, foreign = false) {
  await store.query(
    `INSERT INTO computer_peers(owner_user_id,node_id,name,display_name,certificate,fingerprint)
    VALUES($1::uuid,$2,'workstation.local',$3,'unused','unused')`,
    [owner, node, foreign ? "FOREIGN_COMPUTER" : "Workstation"],
  );
  await store.query("INSERT INTO computer_mirror_state(owner_user_id,origin_node_id) VALUES($1::uuid,$2)", [
    owner,
    node,
  ]);
  await store.query(
    `INSERT INTO thread_range_state(owner_user_id,origin_node_id,thread_id,epoch,visible_epoch,
    applied_seq,head_seq,visible_applied_seq,subscription_id,last_synced_at)
    SELECT $1::uuid,$2,md5(n::text)::uuid,gen_random_uuid(),gen_random_uuid(),10,
      CASE WHEN n<=3 THEN 15 ELSE 10 END,10,gen_random_uuid(),'2026-10-01T12:00:00Z'
    FROM generate_series(1,42) n`,
    [owner, node],
  );

  const thread = (
    await store.query<{ thread: string; epoch: string }>(
      `SELECT thread_id::text AS thread,epoch::text
    FROM thread_range_state WHERE owner_user_id=$1::uuid AND origin_node_id=$2 AND head_seq>applied_seq
    ORDER BY thread_id LIMIT 1`,
      [owner, node],
    )
  )[0]!;

  const metadata = toBinary(
    ui.ThreadSchema,
    create(ui.ThreadSchema, {
      id: thread.thread,
      title: foreign ? "FOREIGN_TITLE" : "Fix the thread sync display",
    }),
  );

  await store.query(
    `INSERT INTO computer_mirror_threads(owner_user_id,origin_node_id,generation,thread_id,snapshot,thread_metadata)
    SELECT $1::uuid,$2,generation,$3::uuid,$4,$5 FROM computer_mirror_state
    WHERE owner_user_id=$1::uuid AND origin_node_id=$2`,
    [owner, node, thread.thread, Buffer.from("PRIVATE_MESSAGE_BODY"), metadata],
  );
  await store.query(
    `INSERT INTO thread_range_failures(owner_user_id,origin_node_id,thread_id,reason,code,retryable)
    VALUES($1::uuid,$2,$3::uuid,'size_limit',8,false)`,
    [owner, node, thread.thread],
  );

  return thread;
}

test.skipIf(!dockerAvailable)(
  "computer summaries and attention pages preserve owner scope and committed sync times",
  async () => {
    const gateway = await startTestGateway({ role: "desktop" });
    const store = new ComputerStore(gateway.runtime, gateway.userId, gateway.secretsKey);
    const foreign = crypto.randomUUID();
    const node = "a".repeat(64);
    const other = "b".repeat(64);

    try {
      await store.query(
        "INSERT INTO users(id,email,display_name,role) VALUES($1::uuid,'other-sync@example.test','Other','user')",
        [foreign],
      );
      const thread = await seedComputer(store, gateway.userId, node);
      await seedComputer(store, foreign, node, true);
      await store.query(
        `INSERT INTO computer_peers(owner_user_id,node_id,name,certificate,fingerprint)
      VALUES($1::uuid,$2,'Laptop','unused','unused')`,
        [gateway.userId, other],
      );
      await store.query("INSERT INTO computer_mirror_state(owner_user_id,origin_node_id) VALUES($1::uuid,$2)", [
        gateway.userId,
        other,
      ]);
      await store.query(
        `INSERT INTO thread_range_failures(owner_user_id,origin_node_id,thread_id,reason,code,retryable)
      VALUES($1::uuid,$2,gen_random_uuid(),'timeout',4,true)`,
        [gateway.userId, other],
      );
      const summary = await gateway.api.getThreadSyncDiagnostics({ summaryOnly: true, pageSize: 1 });
      expect(summary.entries).toHaveLength(0);
      expect(summary.computers).toHaveLength(2);
      expect(summary.computers[0]).toMatchObject({
        nodeId: node,
        name: "Workstation",
        hostname: "workstation.local",
        threads: 42,
        syncingThreads: 2,
        pausedThreads: 1,
        upToDateThreads: 39,
        remaining: 15n,
        reachable: false,
        lastSyncedAtMs: BigInt(Date.parse("2026-10-01T12:00:00Z")),
      });
      expect(summary.computers[1]).toMatchObject({ threads: 1, pausedThreads: 1, remaining: 0n, lastSyncedAtMs: 0n });
      expect(summary.remaining).toBe(15n);
      expect(summary.failedThreads).toBe(2);
      const grouped = groupThreadSyncDiagnostics(summary);
      expect(grouped.allCaughtUp).toBe(false);
      expect(grouped.computers[0]?.status.label).toBe("Unreachable");
      expect(grouped.computers[0]?.summary).toBe("2 of 42 catching up · 1 paused · 15 records to go");

      const page = await gateway.api.getThreadSyncDiagnostics({
        computerNodeId: node,
        attentionOnly: true,
        pageSize: 1,
      });

      expect(page.entries).toHaveLength(1);
      expect(page.entries[0]).toMatchObject({
        computerNodeId: node,
        threadTitle: "Fix the thread sync display",
        reason: "size_limit",
      });

      const next = await gateway.api.getThreadSyncDiagnostics({
        computerNodeId: node,
        attentionOnly: true,
        after: page.next,
      });

      expect(next.entries).toHaveLength(2);
      expect(next.entries.every((entry) => entry.computerNodeId === node && !entry.caughtUp)).toBe(true);
      expect(next.next).toBe("");

      for (const data of [summary, page, next]) {
        const json = toJsonString(ui.ThreadSyncDiagnosticsSchema, data);
        expect(json).not.toContain("FOREIGN_COMPUTER");
        expect(json).not.toContain("FOREIGN_TITLE");
        expect(json).not.toContain("PRIVATE_MESSAGE_BODY");
      }

      const ranges = new ThreadRangeStore(store);
      const subscription = await ranges.begin(node);

      const batch = create(ui.ThreadSyncBatchSchema, {
        threadId: thread.thread,
        epoch: thread.epoch,
        baseSeq: 10n,
        appliedSeq: 11n,
        headSeq: 15n,
        remaining: 4n,
        records: [
          {
            seq: 11n,
            key: "thread",
            value: {
              case: "thread",
              value: create(ui.ThreadSchema, {
                id: thread.thread,
                title: "Fix the thread sync display",
              }),
            },
          },
        ],
      });

      await ranges.apply(node, subscription, batch);
      const synced = await gateway.api.getThreadSyncDiagnostics({ summaryOnly: true });
      expect(synced.computers[0]!.lastSyncedAtMs).toBeGreaterThan(summary.computers[0]!.lastSyncedAtMs);
      await ranges.apply(node, subscription, batch);
      const duplicate = await gateway.api.getThreadSyncDiagnostics({ summaryOnly: true });
      expect(duplicate.computers[0]!.lastSyncedAtMs).toBe(synced.computers[0]!.lastSyncedAtMs);
      await store.query("DELETE FROM thread_range_failures WHERE owner_user_id=$1::uuid", [gateway.userId]);
      await store.query("UPDATE thread_range_state SET applied_seq=head_seq WHERE owner_user_id=$1::uuid", [
        gateway.userId,
      ]);
      const done = await gateway.api.getThreadSyncDiagnostics({ summaryOnly: true });
      expect(done.computers).toHaveLength(1);
      // A saved zero backlog cannot claim live sync while the computer is unreachable.
      expect(groupThreadSyncDiagnostics(done).allCaughtUp).toBe(false);

      const connected = create(ui.ThreadSyncDiagnosticsSchema, {
        computers: done.computers.map((computer) => ({ ...computer, reachable: true })),
      });

      expect(groupThreadSyncDiagnostics(connected).allCaughtUp).toBe(true);
    } finally {
      await gateway.close();
    }
  },
  30000,
);
