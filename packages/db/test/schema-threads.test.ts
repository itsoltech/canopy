import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { dockerAvailable } from "../src/testing.ts";
import {
  completedTurn,
  failure,
  id,
  insertItemEvent,
  insertSide,
  itemsView,
  mainThread,
  query,
  sideThread,
  startSchemaDb,
  stopSchemaDb,
  timeline,
  world,
} from "./support/schema.ts";

describe.skipIf(!dockerAvailable)("schema on PostgreSQL 17: threads, turns and transcript", () => {
  beforeAll(async () => {
    await startSchemaDb();
  }, 60_000);

  afterAll(stopSchemaDb);

  describe("threads: placement", () => {
    test("worker threads need worker, workspace and cwd; gateway threads must not have them", async () => {
      const w = await world();
      expect(
        await failure(
          `INSERT INTO threads (id, project_id, owner_user_id, kind, root_thread_id, runtime, provider)
           VALUES ($1, $2, $3, 'main', $1, 'worker', 'claude')`,
          [id(), w.project, w.user],
        ),
      ).toContain("threads_runtime_placement");
      expect(
        await failure(
          `INSERT INTO threads (id, project_id, owner_user_id, kind, root_thread_id, runtime, provider, cwd)
           VALUES ($1, $2, $3, 'main', $1, 'gateway', 'anthropic', '/repo')`,
          [id(), w.project, w.user],
        ),
      ).toContain("threads_runtime_placement");
      // Chat thread on the gateway: no worker, no directory.
      await query(
        `INSERT INTO threads (id, project_id, owner_user_id, kind, root_thread_id, runtime, provider)
         VALUES ($1, $2, $3, 'main', $1, 'gateway', 'anthropic')`,
        [id(), w.project, w.user],
      );
    });

    test("the workspace must belong to the thread's project and worker", async () => {
      const w = await world();
      const other = await world();
      expect(
        await failure(
          `INSERT INTO threads (id, project_id, owner_user_id, kind, root_thread_id, runtime, provider, worker_id, workspace_id, cwd)
           VALUES ($1, $2, $3, 'main', $1, 'worker', 'codex', $4, $5, '/repo')`,
          [id(), w.project, w.user, w.worker, other.workspace],
        ),
      ).toContain("foreign key");
    });

    test("placement and lineage are immutable; provider_thread_id is set once, replaceable only before the first turn", async () => {
      const w = await world();
      const thread = await mainThread(w);
      expect(await failure(`UPDATE threads SET cwd = '/elsewhere' WHERE id = $1`, [thread])).toContain("immutable");
      expect(await failure(`UPDATE threads SET provider = 'codex' WHERE id = $1`, [thread])).toContain("immutable");
      await query(`UPDATE threads SET provider_thread_id = 'sess-1', status = 'running' WHERE id = $1`, [thread]);
      // No history yet (e.g. a Codex thread without a rollout, started again after a worker restart).
      await query(`UPDATE threads SET provider_thread_id = 'sess-2' WHERE id = $1`, [thread]);
      expect(await failure(`UPDATE threads SET provider_thread_id = NULL WHERE id = $1`, [thread])).toContain(
        "set once",
      );
      await query(
        `INSERT INTO turns (id, thread_id, ordinal, status, trigger, input, started_at) VALUES ($1, $2, 1, 'running', 'provider', '{}', now())`,
        [id(), thread],
      );
      expect(await failure(`UPDATE threads SET provider_thread_id = 'sess-3' WHERE id = $1`, [thread])).toContain(
        "set once",
      );
    });
  });

  describe("threads: side threads", () => {
    test("share the parent workspace and reject arbitrary directory placement", async () => {
      const w = await world();
      const main = await mainThread(w);
      await sideThread(w, { parent: main, root: main });

      const otherCwd = insertSide(w, { parent: main, root: main, cwd: "/repo/sub" });
      expect(await failure(otherCwd.sql, otherCwd.params)).toContain("inherit placement or use the workspace checkout");
      const otherWorker = insertSide(w, { parent: main, root: main, worker: w.otherWorker });
      // Fails on the workspace FK (workspace is on worker 1) or on the trigger; either way it is rejected.
      expect(await failure(otherWorker.sql, otherWorker.params)).toMatch(/foreign key|same worker/);
    });

    test("tree bookkeeping: root and depth must match the parent; two levels only", async () => {
      const w = await world();
      const main = await mainThread(w);
      // The lineage trigger runs before CHECK constraints: a depth that does not match the parent is caught there.
      const wrongDepth = insertSide(w, { parent: main, root: main, depth: 2 });
      expect(await failure(wrongDepth.sql, wrongDepth.params)).toContain("share project, owner and tree");

      // A side thread (level 1) cannot have side threads of its own.
      const side = await sideThread(w, { parent: main, root: main });
      const nested = insertSide(w, { parent: side, root: main, depth: 2 });
      expect(await failure(nested.sql, nested.params)).toContain("threads_max_depth");
      const lying = insertSide(w, { parent: side, root: main, depth: 1 });
      expect(await failure(lying.sql, lying.params)).toContain("share project, owner and tree");
    });

    test("interaction routing to the parent agent exists only for side threads", async () => {
      const w = await world();
      expect(
        await failure(
          `INSERT INTO threads (id, project_id, owner_user_id, kind, root_thread_id, runtime, provider, worker_id, workspace_id, cwd, interaction_route)
           VALUES ($1, $2, $3, 'main', $1, 'worker', 'claude', $4, $5, '/repo', 'parent')`,
          [id(), w.project, w.user, w.worker, w.workspace],
        ),
      ).toContain("threads_parent_route");
    });

    test("a side thread without fork may use another provider (e.g. Codex reviewer on a Claude thread)", async () => {
      const w = await world();
      const main = await mainThread(w, "claude");
      await sideThread(w, { parent: main, root: main, provider: "codex" });
    });
  });

  describe("threads: forks", () => {
    test("fork keeps the provider and needs a completed turn", async () => {
      const w = await world();
      const main = await mainThread(w, "claude");

      const noTurn = insertSide(w, { parent: main, root: main, forkSource: main });
      expect(await failure(noTurn.sql, noTurn.params)).toContain("no completed turn");

      await completedTurn(w, main, ["a"]);
      const crossProvider = insertSide(w, { parent: main, root: main, provider: "codex", forkSource: main });
      expect(await failure(crossProvider.sql, crossProvider.params)).toContain("keep the provider");
    });

    test("fork point is pinned at insert to the latest completed turn", async () => {
      const w = await world();
      const main = await mainThread(w);
      await completedTurn(w, main, ["a"]);
      const second = await completedTurn(w, main, ["b"]);
      const fork = await sideThread(w, { parent: main, root: main, forkSource: main });

      const [row] = await query<{ fork_after_turn_id: string }>(
        `SELECT fork_after_turn_id FROM threads WHERE id = $1`,
        [fork],
      );

      expect(row?.fork_after_turn_id).toBe(second);
    });

    test("fork point must be a completed turn of the source thread", async () => {
      const w = await world();
      const main = await mainThread(w);
      const other = await mainThread(w);
      const foreignTurn = await completedTurn(w, other, ["x"]);
      await completedTurn(w, main, ["a"]);
      const bad = insertSide(w, { parent: main, root: main, forkSource: main, forkAfterTurn: foreignTurn });
      expect(await failure(bad.sql, bad.params)).toMatch(/ended turn of the source|foreign key/);
    });

    test("fork from a turn: a main thread in its own tree, at any ended turn, never a running one", async () => {
      const w = await world();
      const main = await mainThread(w);
      const t1 = await completedTurn(w, main, ["m1"]);
      const t2 = await completedTurn(w, main, ["m2"]);
      await completedTurn(w, main, ["m3"]);
      await query(`UPDATE turns SET status = 'failed' WHERE id = $1`, [t2]);

      const insertMainFork = (afterTurn: string, worker = w.worker) => {
        const thread = id();

        return {
          thread,
          sql: `INSERT INTO threads (id, project_id, owner_user_id, kind, root_thread_id, runtime, provider, worker_id, workspace_id, cwd,
                                     fork_source_thread_id, fork_after_turn_id, status)
                VALUES ($1, $2, $3, 'main', $1, 'worker', 'claude', $4, $5, '/repo', $6, $7, 'idle')`,
          params: [thread, w.project, w.user, worker, w.workspace, main, afterTurn],
        };
      };

      const atFailed = insertMainFork(t2);
      await query(atFailed.sql, atFailed.params);
      expect(await timeline(atFailed.thread)).toEqual(["^m1", "^m2"]);

      const running = id();
      await query(
        `INSERT INTO turns (id, thread_id, ordinal, status, trigger, author_user_id, input) VALUES ($1, $2, 4, 'running', 'user', $3, '{}')`,
        [running, main, w.user],
      );
      const atRunning = insertMainFork(running);
      expect(await failure(atRunning.sql, atRunning.params)).toContain("ended turn of the source");

      const elsewhere = insertMainFork(t1, w.otherWorker);
      expect(await failure(elsewhere.sql, elsewhere.params)).toMatch(/share project, owner and worker|workspace/);
    });

    test("thread_timeline: inherited prefix (recursively) + own events, unaffected by later source events", async () => {
      const w = await world();
      const main = await mainThread(w);
      const t1 = await completedTurn(w, main, ["m1", "m2"]);
      await completedTurn(w, main, ["m3"]);

      const side = await sideThread(w, { parent: main, root: main, forkSource: main, forkAfterTurn: t1 });
      await completedTurn(w, side, ["s1"]);
      // The main thread keeps going; the side thread must not see it.
      await completedTurn(w, main, ["m4"]);

      // Fork of a fork: a sibling (still level 1) that inherits the side thread's history.
      const nested = await sideThread(w, { parent: main, root: main, forkSource: side });
      await completedTurn(w, nested, ["n1"]);

      expect(await timeline(main)).toEqual(["m1", "m2", "m3", "m4"]);
      expect(await timeline(side)).toEqual(["^m1", "^m2", "s1"]);
      expect(await timeline(nested)).toEqual(["^m1", "^m2", "^s1", "n1"]);
    });
  });

  describe("turns", () => {
    test("at most one running turn per thread", async () => {
      const w = await world();
      const thread = await mainThread(w);

      const insert = `INSERT INTO turns (id, thread_id, ordinal, status, trigger, author_user_id, input)
                      VALUES ($1, $2, $3, 'running', 'user', $4, '{}')`;

      await query(insert, [id(), thread, 1, w.user]);
      expect(await failure(insert, [id(), thread, 2, w.user])).toContain("turns_one_running");
    });

    test("client_request_id deduplicates retried user input", async () => {
      const w = await world();
      const thread = await mainThread(w);

      const insert = `INSERT INTO turns (id, thread_id, ordinal, trigger, author_user_id, client_request_id, input)
                      VALUES ($1, $2, $3, 'user', $4, 'req-1', '{}') ON CONFLICT DO NOTHING RETURNING id`;

      expect(await query(insert, [id(), thread, 1, w.user])).toHaveLength(1);
      expect(await query(insert, [id(), thread, 2, w.user])).toHaveLength(0);
    });

    test("provider-started turns: never queued, no user; recovery points at the interrupted turn of the same thread", async () => {
      const w = await world();
      const thread = await mainThread(w);
      const other = await mainThread(w);

      const insert = `INSERT INTO turns (id, thread_id, ordinal, status, trigger, author_user_id, resumes_turn_id, input)
                      VALUES ($1, $2, $3, $4, $5, $6, $7, '{}')`;

      // Wake-up after a background task: started by the provider, reported by the worker.
      await query(insert, [id(), thread, 1, "interrupted", "provider", null, null]);
      expect(await failure(insert, [id(), thread, 2, "queued", "provider", null, null])).toContain(
        "turns_provider_not_queued",
      );
      expect(await failure(insert, [id(), thread, 2, "running", "provider", w.user, null])).toContain(
        "turns_user_author",
      );

      const interrupted = id();
      await query(insert, [interrupted, thread, 2, "interrupted", "user", w.user, null]);
      await query(insert, [id(), thread, 3, "running", "recovery", null, interrupted]);
      expect(await failure(insert, [id(), thread, 4, "failed", "recovery", null, null])).toContain(
        "turns_recovery_link",
      );
      const foreign = id();
      await query(insert, [foreign, other, 1, "interrupted", "user", w.user, null]);
      expect(await failure(insert, [id(), thread, 4, "failed", "recovery", null, foreign])).toContain("foreign key");
    });

    test("interactions: outcome must fit the kind; pending has no answer time", async () => {
      const w = await world();
      const thread = await mainThread(w);

      const insert = `INSERT INTO interaction_requests (id, thread_id, kind, request, status, answered_at, routed_to, answered_by)
                      VALUES ($1, $2, $3, '{}', $4, $5, 'human', CASE WHEN $4 IN ('allowed', 'declined', 'answered') THEN $6::uuid END)`;

      // A background task may ask after the turn ended: no turn_id.
      await query(insert, [id(), thread, "permission", "pending", null, w.user]);
      await query(insert, [id(), thread, "question", "answered", new Date(), w.user]);
      expect(await failure(insert, [id(), thread, "question", "allowed", new Date(), w.user])).toContain(
        "interaction_requests_decision_is_permission",
      );
      expect(await failure(insert, [id(), thread, "permission", "answered", new Date(), w.user])).toContain(
        "interaction_requests_permission_not_answered",
      );
      expect(await failure(insert, [id(), thread, "permission", "pending", new Date(), w.user])).toContain(
        "interaction_requests_answer_time",
      );
    });

    test("interactions answered by the parent agent: routed to parent, exactly one author", async () => {
      const w = await world();
      const main = await mainThread(w);
      const side = await sideThread(w, { parent: main, root: main });

      const insert = `INSERT INTO interaction_requests (id, thread_id, kind, request, status, answered_at, routed_to, answered_by, answered_by_thread_id)
                      VALUES ($1, $2, 'permission', '{}', $3, now(), $4, $5, $6)`;

      await query(insert, [id(), side, "allowed", "parent", null, main]); // the parent agent decided
      await query(insert, [id(), side, "declined", "parent", w.user, null]); // the user stepped in
      await query(insert, [id(), side, "expired", "parent", null, null]); // nobody answered in time
      expect(await failure(insert, [id(), side, "allowed", "parent", null, null])).toContain(
        "interaction_requests_answered_by",
      );
      expect(await failure(insert, [id(), side, "allowed", "parent", w.user, main])).toContain(
        "interaction_requests_answered_by",
      );
      expect(await failure(insert, [id(), side, "allowed", "human", null, main])).toContain(
        "interaction_requests_agent_answer_routed",
      );
    });

    test("events must reference a turn of the same thread", async () => {
      const w = await world();
      const a = await mainThread(w);
      const b = await mainThread(w);
      const turnOfB = await completedTurn(w, b, ["x"]);
      expect(
        await failure(
          `INSERT INTO thread_events (thread_id, seq, event_id, origin, turn_id, kind, payload, occurred_at)
           VALUES ($1, 1, $2, 'worker', $3, 'notice', '{}', now())`,
          [a, id(), turnOfB],
        ),
      ).toContain("foreign key");
    });
  });

  describe("transcript", () => {
    const insertEvent = `INSERT INTO thread_events (thread_id, seq, event_id, origin, turn_id, kind, item_id, payload, occurred_at)
                         VALUES ($1, $2, $3, $4, NULL, $5, $6, '{}', now()) ON CONFLICT (thread_id, event_id) DO NOTHING RETURNING seq`;

    test("events between turns are recorded (turn_id NULL), from both worker and gateway", async () => {
      const w = await world();
      const thread = await mainThread(w);
      await completedTurn(w, thread, ["a"]);
      expect(await query(insertEvent, [thread, 2, id(), "worker", "item_started", "bg-task-1"])).toHaveLength(1);
      expect(await query(insertEvent, [thread, 3, id(), "gateway", "notice", null])).toHaveLength(1);

      const kinds = await query<{ kind: string; turn_id: string | null }>(
        `SELECT kind, turn_id FROM thread_timeline($1)`,
        [thread],
      );

      expect(kinds.map((k) => [k.kind, k.turn_id === null])).toEqual([
        ["item_completed", false],
        ["item_started", true],
        ["notice", true],
      ]);
    });

    test("a resent event (same event_id) is ignored", async () => {
      const w = await world();
      const thread = await mainThread(w);
      const eventId = id();
      expect(await query(insertEvent, [thread, 1, eventId, "worker", "notice", null])).toHaveLength(1);
      expect(await query(insertEvent, [thread, 2, eventId, "worker", "notice", null])).toHaveLength(0);
    });

    test("item events carry item_id, other events do not", async () => {
      const w = await world();
      const thread = await mainThread(w);
      expect(await failure(insertEvent, [thread, 1, id(), "worker", "item_delta", null])).toContain(
        "thread_events_item_id",
      );
      expect(await failure(insertEvent, [thread, 1, id(), "worker", "notice", "x"])).toContain("thread_events_item_id");
    });

    test("thread_items_view: inherited items up to the fork point, flags items that changed later", async () => {
      const w = await world();
      const main = await mainThread(w);
      await completedTurn(w, main, ["m1"]);
      // A background task starts in turn 2 and keeps running after the fork point.
      const t2 = await completedTurn(w, main, ["m2"]);
      await insertItemEvent(main, 3, null, "bg", "started");
      await query(`UPDATE turns SET last_seq = 3 WHERE id = $1`, [t2]);
      await query(`UPDATE threads SET last_seq = 3 WHERE id = $1`, [main]);

      const side = await sideThread(w, { parent: main, root: main, forkSource: main });
      await completedTurn(w, side, ["s1"]);
      await insertItemEvent(main, 4, null, "bg", "finished");
      await query(`UPDATE threads SET last_seq = 4 WHERE id = $1`, [main]);
      await completedTurn(w, main, ["m3"]);

      expect(await itemsView(side)).toEqual(["^item-m1", "^item-m2", "^bg*", "item-s1"]);
      expect(await itemsView(main)).toEqual(["item-m1", "item-m2", "bg", "item-m3"]);
    });

    test("blobs are content-addressed and stored inline or externally, not both", async () => {
      const insert = `INSERT INTO blobs (sha256, size_bytes, data, storage_url) VALUES ($1, 3, $2, $3)`;
      const sha = "a".repeat(64);
      await query(insert, [sha, new Uint8Array([1, 2, 3]), null]);
      expect(await failure(insert, ["b".repeat(64), null, null])).toContain("blobs_one_location");
      expect(await failure(insert, ["not-a-hash", new Uint8Array([1]), null])).toContain("blobs_sha256_check");
    });

    test("attachments: a blob owned by a user, a safe name, bound to a thread and turn together", async () => {
      const w = await world();
      const sha = "c".repeat(64);
      await query(`INSERT INTO blobs (sha256, size_bytes, data) VALUES ($1, 1, $2)`, [sha, new Uint8Array([1])]);

      const insert = `INSERT INTO attachments (id, owner_user_id, sha256, name, mime_type, kind, size_bytes, thread_id, turn_id)
                      VALUES ($1, $2, $3, $4, 'text/plain', $5, 1, $6, $7)`;

      await query(insert, [id(), w.user, sha, "notes.txt", "file", null, null]);
      expect(await failure(insert, [id(), w.user, "d".repeat(64), "x.txt", "file", null, null])).toContain(
        "attachments_sha256_fkey",
      );
      expect(await failure(insert, [id(), w.user, sha, "../x.txt", "file", null, null])).toContain(
        "attachments_name_check",
      );
      expect(await failure(insert, [id(), w.user, sha, "a\\b", "file", null, null])).toContain(
        "attachments_name_check",
      );
      expect(await failure(insert, [id(), w.user, sha, "..", "file", null, null])).toContain("attachments_name_check");
      expect(await failure(insert, [id(), w.user, sha, "x.exe", "program", null, null])).toContain(
        "attachments_kind_check",
      );
      const main = await mainThread(w);
      expect(await failure(insert, [id(), w.user, sha, "x.txt", "file", main, null])).toContain(
        "attachments_bound_together",
      );
      expect(await failure(`INSERT INTO thread_blobs (thread_id, sha256) VALUES ($1, 'nope')`, [main])).toContain(
        "thread_blobs_sha256_check",
      );
    });
  });
});
