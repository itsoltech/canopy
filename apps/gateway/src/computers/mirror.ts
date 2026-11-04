import { create, fromBinary, fromJson, toBinary, type JsonValue, type Message } from "@bufbuild/protobuf";
import { timestampFromDate } from "@bufbuild/protobuf/wkt";
import { Code, ConnectError } from "@connectrpc/connect";
import { computerLink as link, ThreadEventSchema, ui } from "@canopy/contracts";
import { Effect } from "effect";
import { SqlClient } from "effect/sql";
import { setTimeout as delay } from "node:timers/promises";
import { methodNamed, qualify, type RemoteServe } from "./remote.ts";
import type { ComputerStore } from "./store.ts";

type Clock = { epoch: string; revision: string };

type State = { cursor: string; generation: string; overview: Uint8Array | null };

const cursorOf = (clock: Clock) => `${clock.epoch}:${clock.revision}`;
const CURSOR = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}):(\d+)$/;
const mismatch = () => new ConnectError("Thread mirror cursor mismatch; resynchronizing", Code.DataLoss);

/** A durable, read-only projection. No GatewayCore write ever reads these tables. */
export class ThreadMirror {
  constructor(readonly store: ComputerStore) {}
  async state(node: string): Promise<State | undefined> {
    return (
      await this.store.query<State>(
        "SELECT cursor,generation,overview FROM computer_mirror_state WHERE owner_user_id=$1::uuid AND origin_node_id=$2",
        [this.store.owner, node],
      )
    )[0];
  }
  async snapshot(node: string, thread: string): Promise<ui.ThreadSnapshot | undefined> {
    const rows = await this.store.query<{ snapshot: Uint8Array }>(
      `SELECT t.snapshot FROM computer_mirror_threads t JOIN computer_mirror_state s
      USING(owner_user_id,origin_node_id,generation) WHERE t.owner_user_id=$1::uuid AND t.origin_node_id=$2 AND t.thread_id=$3::uuid`,
      [this.store.owner, node, thread],
    );

    if (!rows[0]) return undefined;
    const value = fromBinary(ui.ThreadSnapshotSchema, rows[0].snapshot);
    qualify(ui.ThreadSnapshotSchema, value, node);

    return value;
  }
  async threads(node: string, request: ui.ListThreadsRequest): Promise<ui.Thread[]> {
    const rows = await this.store.query<{ snapshot: Uint8Array }>(
      `SELECT t.snapshot FROM computer_mirror_threads t JOIN computer_mirror_state s
      USING(owner_user_id,origin_node_id,generation) WHERE t.owner_user_id=$1::uuid AND t.origin_node_id=$2 ORDER BY t.thread_id`,
      [this.store.owner, node],
    );

    const threads = rows.flatMap((r) => {
      const t = fromBinary(ui.ThreadSnapshotSchema, r.snapshot).thread;

      return t ? [t] : [];
    });

    return threads
      .filter(
        (t) =>
          !t.deletedAt &&
          (!request.projectId || t.projectId === request.projectId) &&
          ((!request.sidebarOnly && request.includeArchived) ||
            (request.sidebarOnly &&
              t.kind === ui.ThreadKind.SIDE &&
              threads.some((p) => p.id === t.parentThreadId && p.status !== "archived")) ||
            t.status !== "archived"),
      )
      .map((t) => {
        qualify(ui.ThreadSchema, t, node);

        return t;
      });
  }
  async overview(node: string): Promise<ui.GetOverviewResponse> {
    const state = await this.state(node);

    const value = state?.overview
      ? fromBinary(ui.GetOverviewResponseSchema, state.overview)
      : create(ui.GetOverviewResponseSchema);

    for (const worker of value.workers) worker.online = false;
    qualify(ui.GetOverviewResponseSchema, value, node);

    return value;
  }
  async clearCursor(node: string) {
    await this.store.query(
      "UPDATE computer_mirror_state SET cursor='' WHERE owner_user_id=$1::uuid AND origin_node_id=$2",
      [this.store.owner, node],
    );
  }

  /** One subscription per peer. Reset frames are staged; only a checkpoint changes visible data. */
  async consume(node: string, updates: AsyncIterable<Message>, notify: () => void, signal: AbortSignal) {
    await this.store.query(
      `INSERT INTO computer_mirror_state(owner_user_id,origin_node_id) VALUES($1::uuid,$2) ON CONFLICT DO NOTHING`,
      [this.store.owner, node],
    );
    let state = (await this.state(node))!;
    let generation = state.generation;
    let resetting = false;
    let overview: Uint8Array | null = null;
    let pending: ui.ThreadSnapshot | undefined;

    try {
      for await (const message of updates) {
        if (signal.aborted) return;
        const update = message as link.MirrorUpdate;

        if (update.reset) {
          if (
            resetting ||
            pending ||
            update.commit ||
            update.snapshot ||
            update.snapshotStart ||
            update.snapshotEnd ||
            update.removedThreadId ||
            update.overview
          )
            throw mismatch();
          generation = crypto.randomUUID();
          resetting = true;
          overview = null;
        }

        if (update.previousCursor !== (resetting ? "" : state.cursor)) throw mismatch();

        if (update.commit) {
          const next = CURSOR.exec(update.cursor);
          const previous = CURSOR.exec(state.cursor);

          if (
            !next ||
            (!resetting && (!previous || next[1] !== previous[1] || BigInt(next[2]!) <= BigInt(previous[2]!)))
          )
            throw mismatch();
        } else if (update.cursor) throw mismatch();

        if (update.snapshotStart) {
          if (
            pending ||
            !update.snapshot?.thread ||
            update.commit ||
            update.snapshotEnd ||
            update.removedThreadId ||
            update.overview
          )
            throw mismatch();
          pending = update.snapshot;
          continue;
        }

        if (pending) {
          if (update.reset || update.commit || update.removedThreadId || update.overview) throw mismatch();

          if (update.snapshot) {
            pending.turns.push(...update.snapshot.turns);
            pending.items.push(...update.snapshot.items);
            pending.interactions.push(...update.snapshot.interactions);
            pending.notices.push(...update.snapshot.notices);
            pending.steers.push(...update.snapshot.steers);
            pending.busDeliveries.push(...update.snapshot.busDeliveries);
          }

          if (!update.snapshotEnd) continue;
          update.snapshot = pending;
          pending = undefined;
        } else if (update.snapshotEnd) throw mismatch();

        // Do not accept secret metadata even from a malformed peer.
        if (update.snapshot) {
          update.snapshot.secrets = [];
          update.snapshot.schedules = [];
        }

        if (update.overview) overview = toBinary(ui.GetOverviewResponseSchema, safeOverview(update.overview));
        const { owner, runtime } = this.store;
        const nextOverview = overview;

        const changed = await runtime.runPromise(
          Effect.gen(function* () {
            const sql = yield* SqlClient.SqlClient;

            return yield* sql.withTransaction(
              Effect.gen(function* () {
                // Lock against unlink (FK cascade) and other instances consuming the same peer.
                const rows = yield* sql<{
                  cursor: string;
                  generation: string;
                }>`SELECT cursor,generation FROM computer_mirror_state
              WHERE owner_user_id=${owner}::uuid AND origin_node_id=${node} FOR UPDATE`;

                if (!rows[0]) return false;

                if (rows[0].cursor !== state.cursor || rows[0].generation !== state.generation) return false;

                if (update.snapshot?.thread) {
                  yield* sql`INSERT INTO computer_mirror_threads(owner_user_id,origin_node_id,generation,thread_id,snapshot)
                VALUES(${owner}::uuid,${node},${generation}::uuid,${update.snapshot.thread.id}::uuid,${toBinary(ui.ThreadSnapshotSchema, update.snapshot)})
                ON CONFLICT(owner_user_id,origin_node_id,generation,thread_id) DO UPDATE SET snapshot=excluded.snapshot`;
                }

                if (update.removedThreadId)
                  yield* sql`DELETE FROM computer_mirror_threads WHERE owner_user_id=${owner}::uuid AND origin_node_id=${node}
              AND generation=${generation}::uuid AND thread_id=${update.removedThreadId}::uuid`;

                if (update.commit) {
                  yield* sql`UPDATE computer_mirror_state SET cursor=${update.cursor},generation=${generation}::uuid,overview=coalesce(${nextOverview},overview)
                WHERE owner_user_id=${owner}::uuid AND origin_node_id=${node}`;
                  yield* sql`DELETE FROM computer_mirror_threads WHERE owner_user_id=${owner}::uuid AND origin_node_id=${node} AND generation<>${generation}::uuid`;
                }

                return true;
              }),
            );
          }),
        );

        if (!changed) throw new ConnectError("Thread mirror subscription superseded", Code.Aborted);

        if (update.commit) {
          state = { ...state, cursor: update.cursor, generation };
          resetting = false;
          overview = null;
          notify();
        }
      }
    } finally {
      if (resetting)
        await this.store.query(
          `DELETE FROM computer_mirror_threads t WHERE owner_user_id=$1::uuid AND origin_node_id=$2 AND generation=$3::uuid
        AND NOT EXISTS(SELECT 1 FROM computer_mirror_state s WHERE s.owner_user_id=t.owner_user_id AND s.origin_node_id=t.origin_node_id AND s.generation=t.generation)`,
          [this.store.owner, node, generation],
        );
    }
  }

  /** Changes name thread projections, not raw DB rows, command payloads or secret tables. */
  async *publish(
    request: link.MirrorRequest,
    serve: RemoteServe,
    signal: AbortSignal,
  ): AsyncGenerator<link.MirrorUpdate> {
    const { owner } = this.store;
    await this.store.query("INSERT INTO computer_thread_clock(owner_user_id) VALUES($1::uuid) ON CONFLICT DO NOTHING", [
      owner,
    ]);

    const clock = async () =>
      (
        await this.store.query<Clock>(
          "SELECT epoch,revision::text FROM computer_thread_clock WHERE owner_user_id=$1::uuid",
          [owner],
        )
      )[0]!;

    const one = async (name: string, request: Message) => {
      const abort = new AbortController();

      try {
        for await (const value of serve(methodNamed(name)!, request, AbortSignal.any([signal, abort.signal])))
          return value;
      } finally {
        abort.abort();
      }

      throw new ConnectError("Missing mirror projection", Code.Internal);
    };

    const overview = async () =>
      safeOverview((await one("GetOverview", create(ui.GetOverviewRequestSchema))) as ui.GetOverviewResponse);

    const snapshot = async (id: string) => {
      try {
        const value = (
          (await one("WatchThread", create(ui.WatchThreadRequestSchema, { threadId: id }))) as ui.ThreadUpdate
        ).change;

        if (value.case !== "snapshot") throw new ConnectError("Missing thread snapshot", Code.Internal);

        if (value.value.thread?.deletedAt) return undefined;
        value.value.secrets = [];
        value.value.schedules = [];

        // Live UI snapshots cap diagnostics at 200; durable mirrors retain the whole timeline.
        const notices = await this.store.query<{
          seq: string;
          turn_id: string | null;
          payload: JsonValue;
          occurred_at: Date;
        }>(
          `SELECT seq::text,turn_id,payload,occurred_at
          FROM thread_events e JOIN threads t ON t.id=e.thread_id WHERE e.thread_id=$1::uuid AND t.owner_user_id=$2::uuid
          AND e.kind='notice' ORDER BY e.seq`,
          [id, owner],
        );

        value.value.notices = notices.flatMap((row) => {
          const event = fromJson(ThreadEventSchema, row.payload);

          return event.body.case === "notice"
            ? [
                create(ui.ThreadNoticeSchema, {
                  seq: BigInt(row.seq),
                  turnId: row.turn_id ?? "",
                  notice: event.body.value,
                  occurredAt: timestampFromDate(new Date(row.occurred_at)),
                }),
              ]
            : [];
        });

        return value.value;
      } catch (error) {
        if (error instanceof ConnectError && error.code === Code.NotFound) return undefined;
        throw error;
      }
    };

    let cursor = request.cursor;

    while (!signal.aborted) {
      const head = await clock();
      const match = CURSOR.exec(cursor);
      const seq = match ? BigInt(match[2]!) : -1n;

      const changes =
        match?.[1] === head.epoch && seq <= BigInt(head.revision)
          ? await this.store.query<{ revision: string; thread_id: string | null }>(
              `SELECT revision::text,thread_id FROM computer_thread_changes
          WHERE owner_user_id=$1::uuid AND revision>$2::bigint AND revision<=$3::bigint ORDER BY computer_thread_changes.revision`,
              [owner, seq.toString(), head.revision],
            )
          : undefined;

      const contiguous =
        changes &&
        BigInt(changes.length) === BigInt(head.revision) - seq &&
        changes.every((c, i) => BigInt(c.revision) === seq + BigInt(i) + 1n);

      if (!contiguous) {
        // Capture the cursor BEFORE reading projections: concurrent changes are replayed afterwards.
        yield create(link.MirrorUpdateSchema, { reset: true });
        yield create(link.MirrorUpdateSchema, { overview: await overview() });

        const ids = await this.store.query<{ id: string }>(
          "SELECT id FROM threads WHERE owner_user_id=$1::uuid AND deleted_at IS NULL ORDER BY id",
          [owner],
        );

        for (const { id } of ids) {
          if (signal.aborted) return;
          const value = await snapshot(id);

          if (value) yield* snapshotFrames(value);
        }

        cursor = cursorOf(head);
        yield create(link.MirrorUpdateSchema, { cursor, commit: true });
      } else {
        // Coalesce repeated invalidations (e.g. streaming deltas) into one projection per poll.
        // Forks inherit source items/turns: reconciliation of the source also invalidates descendants.
        const ids = changes!.length
          ? await this.store.query<{ id: string }>(
              `WITH RECURSIVE affected(id) AS (
          SELECT id FROM threads WHERE owner_user_id=$1::uuid AND id=ANY($2::uuid[])
          UNION SELECT t.id FROM threads t JOIN affected a ON t.fork_source_thread_id=a.id WHERE t.owner_user_id=$1::uuid
        ) SELECT id FROM affected`,
              [owner, [...new Set(changes!.flatMap((c) => (c.thread_id ? [c.thread_id] : [])))]],
            )
          : [];

        const threadIds = new Set([...changes!.map((c) => c.thread_id), ...ids.map((t) => t.id)]);

        for (const threadId of threadIds) {
          if (signal.aborted) return;

          if (threadId) {
            const value = await snapshot(threadId);

            if (value) yield* snapshotFrames(value, cursor);
            else yield create(link.MirrorUpdateSchema, { previousCursor: cursor, removedThreadId: threadId });
          } else yield create(link.MirrorUpdateSchema, { previousCursor: cursor, overview: await overview() });
        }

        if (changes!.length) {
          yield create(link.MirrorUpdateSchema, { previousCursor: cursor, cursor: cursorOf(head), commit: true });
          cursor = cursorOf(head);
        }
      }

      // Retain 10,000 invalidations, independently of full timeline retention in mirrors.
      await this.store.query(
        "DELETE FROM computer_thread_changes WHERE owner_user_id=$1::uuid AND revision<=$2::bigint-10000",
        [owner, head.revision],
      );

      try {
        await delay(250, undefined, { signal });
      } catch {
        return;
      }
    }
  }
}

const SNAPSHOT_LISTS = ["turns", "items", "interactions", "notices", "steers", "busDeliveries"] as const;

/** Whole timelines have no retention/size cap; each transport message is bounded independently. */
function* snapshotFrames(snapshot: ui.ThreadSnapshot, previousCursor = ""): Generator<link.MirrorUpdate> {
  yield create(link.MirrorUpdateSchema, {
    previousCursor,
    snapshotStart: true,
    snapshot: {
      thread: snapshot.thread,
      lastSeq: snapshot.lastSeq,
      goal: snapshot.goal,
    },
  });

  for (const field of SNAPSHOT_LISTS)
    for (const value of snapshot[field]) {
      yield create(link.MirrorUpdateSchema, {
        previousCursor,
        snapshot: create(ui.ThreadSnapshotSchema, { [field]: [value] }),
      });
    }

  yield create(link.MirrorUpdateSchema, { previousCursor, snapshotEnd: true });
}

function safeOverview(value: ui.GetOverviewResponse): ui.GetOverviewResponse {
  // Explicit allowlist: settings, provider config and credentials never enter mirror storage.
  return create(ui.GetOverviewResponseSchema, {
    workers: value.workers.map((w) => ({
      id: w.id,
      name: w.name,
      hostname: w.hostname,
      os: w.os,
      version: w.version,
      online: w.online,
      lastSeenAt: w.lastSeenAt,
      revokedAt: w.revokedAt,
    })),
    projects: value.projects,
  });
}
