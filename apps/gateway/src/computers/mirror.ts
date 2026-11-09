import { create, fromBinary, toBinary, type Message } from "@bufbuild/protobuf";
import { computerLink as link, ui } from "@canopy/contracts";
import { Code, ConnectError } from "@connectrpc/connect";
import { setTimeout as delay } from "node:timers/promises";
import { commitMirrorUpdate, registerMirrorGeneration, type State } from "./mirror-persistence.ts";
import { mirrorJournal } from "./mirror-journal.ts";
import { deltaFrames, mirrorThreadSnapshot, safeOverview, snapshotFrames } from "./mirror-projection.ts";
import { linkedMessage, methodNamed, qualify, type RemoteServe } from "./remote.ts";
import type { ComputerStore } from "./store.ts";
import { MirrorFrames } from "./mirror-frames.ts";
import { PEER_WATCH_HEARTBEAT_MS } from "./timing.ts";

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
        "SELECT cursor,generation,overview,subscription_id FROM computer_mirror_state WHERE owner_user_id=$1::uuid AND origin_node_id=$2",
        [this.store.owner, node],
      )
    )[0];
  }
  async snapshot(node: string, thread: string): Promise<ui.ThreadSnapshot | undefined> {
    return (await this.read(node, thread))?.snapshot;
  }
  /** Header reads and lists never load the complete timeline. */
  async thread(node: string, thread: string): Promise<ui.Thread | undefined> {
    const rows = await this.store.query<{ metadata: Uint8Array }>(
      `SELECT t.thread_metadata AS metadata FROM computer_mirror_threads t JOIN computer_mirror_state s
      USING(owner_user_id,origin_node_id,generation) WHERE t.owner_user_id=$1::uuid AND t.origin_node_id=$2 AND t.thread_id=$3::uuid`,
      [this.store.owner, node, thread],
    );

    if (!rows[0]) return undefined;
    const value = fromBinary(ui.ThreadSchema, rows[0].metadata);
    qualify(ui.ThreadSchema, value, node);

    return value;
  }
  /** Snapshot and cursor must come from the same committed generation/read. */
  async read(node: string, thread: string): Promise<{ snapshot: ui.ThreadSnapshot; cursor: string } | undefined> {
    const rows = await this.store.query<{ snapshot: Uint8Array; cursor: string }>(
      `SELECT t.snapshot,s.cursor FROM computer_mirror_threads t JOIN computer_mirror_state s
      USING(owner_user_id,origin_node_id,generation) WHERE t.owner_user_id=$1::uuid AND t.origin_node_id=$2 AND t.thread_id=$3::uuid`,
      [this.store.owner, node, thread],
    );

    if (!rows[0]) return undefined;
    const value = fromBinary(ui.ThreadSnapshotSchema, rows[0].snapshot);
    qualify(ui.ThreadSnapshotSchema, value, node);

    return { snapshot: value, cursor: rows[0].cursor };
  }
  async threads(node: string, request: ui.ListThreadsRequest): Promise<ui.Thread[]> {
    const started = performance.now();

    const rows = await this.store.query<{ metadata: Uint8Array }>(
      `SELECT t.thread_metadata AS metadata FROM computer_mirror_threads t JOIN computer_mirror_state s
      USING(owner_user_id,origin_node_id,generation) WHERE t.owner_user_id=$1::uuid AND t.origin_node_id=$2 ORDER BY t.thread_id`,
      [this.store.owner, node],
    );

    const threads = rows.map((r) => fromBinary(ui.ThreadSchema, r.metadata));
    const activeParents = new Set(threads.filter((t) => t.status !== "archived").map((t) => t.id));

    if (performance.now() - started >= 250)
      console.warn("Slow mirror thread list", {
        peer: node,
        durationMs: Math.round(performance.now() - started),
        threads: rows.length,
        bytes: rows.reduce((total, row) => total + row.metadata.byteLength, 0),
      });

    return threads
      .filter(
        (t) =>
          !t.deletedAt &&
          (!request.projectId || t.projectId === request.projectId) &&
          ((!request.sidebarOnly && request.includeArchived) ||
            (request.sidebarOnly && t.kind === ui.ThreadKind.SIDE && activeParents.has(t.parentThreadId)) ||
            t.status !== "archived"),
      )
      .map((t) => {
        qualify(ui.ThreadSchema, t, node);

        return t;
      });
  }
  async overview(node: string, reachable = false): Promise<ui.GetOverviewResponse> {
    const state = await this.state(node);

    const value = state?.overview
      ? fromBinary(ui.GetOverviewResponseSchema, state.overview)
      : create(ui.GetOverviewResponseSchema);

    if (!reachable) for (const worker of value.workers) worker.online = false;
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
  async consume(
    node: string,
    updates: AsyncIterable<Message>,
    notify: () => void,
    signal: AbortSignal,
    confirmed: () => void = () => {},
  ) {
    // A revoked relay home is re-inserted as a callback-only origin in the same catalog
    // transaction that purged its mirror. A late subscription must not recreate it.
    await this.store.query(
      `INSERT INTO computer_mirror_state(owner_user_id,origin_node_id) SELECT $1::uuid,$2
      WHERE EXISTS(SELECT 1 FROM computer_peers WHERE owner_user_id=$1::uuid AND node_id=$2
        AND (via_node_id IS NULL OR relay_role IN ('home','both')) FOR SHARE) ON CONFLICT DO NOTHING`,
      [this.store.owner, node],
    );

    // A new consumer fences an older stream even before either reaches a checkpoint.
    const state = (
      await this.store.query<State>(
        `UPDATE computer_mirror_state SET subscription_id=gen_random_uuid()
      WHERE owner_user_id=$1::uuid AND origin_node_id=$2 RETURNING cursor,generation,overview,subscription_id`,
        [this.store.owner, node],
      )
    )[0];

    if (!state) throw new ConnectError("Thread mirror subscription superseded", Code.Aborted);
    let generation = state.generation;
    let resetting = false;
    let overview: Uint8Array | null = null;
    const frames = new MirrorFrames();

    try {
      for await (const message of updates) {
        if (signal.aborted) return;
        let update = linkedMessage(link.MirrorUpdateSchema, message);

        if (update.heartbeat) {
          if (
            resetting ||
            frames.pending ||
            update.cursor !== state.cursor ||
            update.previousCursor !== state.cursor ||
            update.reset ||
            update.commit ||
            update.snapshot ||
            update.delta ||
            update.overview ||
            update.snapshotStart ||
            update.snapshotEnd ||
            update.deltaStart ||
            update.deltaEnd ||
            update.removedThreadId
          )
            throw mismatch();
          confirmed();
          continue;
        }

        if (update.reset) {
          if (
            resetting ||
            frames.pending ||
            update.commit ||
            update.snapshot ||
            update.snapshotStart ||
            update.snapshotEnd ||
            update.removedThreadId ||
            update.overview ||
            update.delta ||
            update.deltaStart ||
            update.deltaEnd
          )
            throw mismatch();
          generation = crypto.randomUUID();

          if (
            !(await this.store.runtime.runPromise(registerMirrorGeneration(this.store.owner, node, generation, state)))
          )
            throw new ConnectError("Thread mirror subscription superseded", Code.Aborted);
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

        if (update.deltaStart && (resetting || update.delta?.baseCursor !== state.cursor)) throw mismatch();
        const projection = frames.accept(update);

        if (!projection) continue;
        update = projection;

        // Do not accept secret metadata even from a malformed peer.
        if (update.snapshot) {
          update.snapshot.secrets = [];
          update.snapshot.schedules = [];
        }

        if (update.delta?.snapshot) {
          update.delta.snapshot.secrets = [];
          update.delta.snapshot.schedules = [];
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
          `UPDATE computer_mirror_generations SET lease_until=now() WHERE owner_user_id=$1::uuid AND origin_node_id=$2
          AND generation=$3::uuid AND subscription_id=$4::uuid`,
          [this.store.owner, node, generation, state.subscription_id],
        );
    }
  }

  /** Changes name thread projections, not raw DB rows, command payloads or secret tables. */
  async *publish(
    request: link.MirrorRequest,
    serve: RemoteServe,
    signal: AbortSignal,
    heartbeatMs = PEER_WATCH_HEARTBEAT_MS,
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

    const snapshot = (id: string, cursor = "") => mirrorThreadSnapshot(this, one, owner, id, cursor);

    let cursor = request.cursor;
    let lastHeartbeat = 0;

    while (!signal.aborted) {
      const head = await clock();
      const match = CURSOR.exec(cursor);
      const seq = match ? BigInt(match[2]!) : -1n;

      const changes =
        match?.[1] === head.epoch && seq <= BigInt(head.revision)
          ? await mirrorJournal(this.store, seq.toString(), head.revision)
          : undefined;

      const contiguous = changes && BigInt(changes.count) === BigInt(head.revision) - seq;

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

          if (value?.case === "snapshot") yield* snapshotFrames(value.value);
        }

        cursor = cursorOf(head);
        yield create(link.MirrorUpdateSchema, { cursor, commit: true });
      } else {
        // Coalesce repeated invalidations (e.g. streaming deltas) into one projection per poll.
        // Forks inherit source items/turns: reconciliation of the source also invalidates descendants.
        const ids = changes!.threads.length
          ? await this.store.query<{ id: string }>(
              `WITH RECURSIVE affected(id) AS (
          SELECT id FROM threads WHERE owner_user_id=$1::uuid AND id=ANY($2::uuid[])
          UNION SELECT t.id FROM threads t JOIN affected a ON t.fork_source_thread_id=a.id WHERE t.owner_user_id=$1::uuid
        ) SELECT id FROM affected`,
              [owner, changes!.threads.filter((id) => id !== null)],
            )
          : [];

        const threadIds = new Set([...changes!.threads, ...ids.map((t) => t.id)]);

        for (const threadId of threadIds) {
          if (signal.aborted) return;

          if (threadId) {
            const value = await snapshot(threadId, request.incremental ? cursor : "");

            if (value?.case === "snapshot") yield* snapshotFrames(value.value, cursor);
            else if (value?.case === "delta") yield* deltaFrames(value.value, cursor);
            else yield create(link.MirrorUpdateSchema, { previousCursor: cursor, removedThreadId: threadId });
          } else yield create(link.MirrorUpdateSchema, { previousCursor: cursor, overview: await overview() });
        }

        if (BigInt(changes!.count) > 0n) {
          yield create(link.MirrorUpdateSchema, { previousCursor: cursor, cursor: cursorOf(head), commit: true });
          cursor = cursorOf(head);
        }
      }

      if (request.heartbeat && Date.now() - lastHeartbeat >= heartbeatMs) {
        yield create(link.MirrorUpdateSchema, { heartbeat: true, previousCursor: cursor, cursor });
        lastHeartbeat = Date.now();
      }

      // The commit trigger bounds journal retention; an idle subscriber need not DELETE every 250 ms.

      try {
        await delay(250, undefined, { signal });
      } catch {
        return;
      }
    }
  }
}
