import { create, fromBinary, toBinary, type Message } from "@bufbuild/protobuf";
import { computerLink as link, ui } from "@canopy/contracts";
import { Code, ConnectError } from "@connectrpc/connect";
import { setTimeout as delay } from "node:timers/promises";
import { commitMirrorUpdate, type State } from "./mirror-persistence.ts";
import { mirrorThreadSnapshot, safeOverview, snapshotFrames } from "./mirror-projection.ts";
import { linkedMessage, methodNamed, qualify, type RemoteServe } from "./remote.ts";
import type { ComputerStore } from "./store.ts";

export { commitMirrorUpdate, type State } from "./mirror-persistence.ts";

export type Clock = { epoch: string; revision: string };

export const cursorOf = (clock: Clock) => `${clock.epoch}:${clock.revision}`;
export const CURSOR = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}):(\d+)$/;
export const mismatch = () => new ConnectError("Thread mirror cursor mismatch; resynchronizing", Code.DataLoss);

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
    // A revoked relay home is re-inserted as a callback-only origin in the same catalog
    // transaction that purged its mirror. A late subscription must not recreate it.
    await this.store.query(
      `INSERT INTO computer_mirror_state(owner_user_id,origin_node_id) SELECT $1::uuid,$2
      WHERE EXISTS(SELECT 1 FROM computer_peers WHERE owner_user_id=$1::uuid AND node_id=$2
        AND (via_node_id IS NULL OR relay_role IN ('home','both')) FOR SHARE) ON CONFLICT DO NOTHING`,
      [this.store.owner, node],
    );
    const state = await this.state(node);

    if (!state) throw new ConnectError("Thread mirror subscription superseded", Code.Aborted);
    let generation = state.generation;
    let resetting = false;
    let overview: Uint8Array | null = null;
    let pending: ui.ThreadSnapshot | undefined;

    try {
      for await (const message of updates) {
        if (signal.aborted) return;
        const update = linkedMessage(link.MirrorUpdateSchema, message);

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

        const changed = await commitMirrorUpdate(runtime, owner, node, generation, state, update, nextOverview);

        if (!changed) throw new ConnectError("Thread mirror subscription superseded", Code.Aborted);

        if (update.commit) {
          Object.assign(state, { cursor: update.cursor, generation });
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
      safeOverview(
        linkedMessage(ui.GetOverviewResponseSchema, await one("GetOverview", create(ui.GetOverviewRequestSchema))),
      );

    const snapshot = (id: string) => mirrorThreadSnapshot(this, one, owner, id);

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
