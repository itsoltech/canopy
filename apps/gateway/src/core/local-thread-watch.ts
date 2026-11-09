import { create } from "@bufbuild/protobuf";
import { ui } from "@canopy/contracts";
import { MIRROR_CURSOR } from "@canopy/domain/thread-mirror";
import { Code, ConnectError } from "@connectrpc/connect";
import { Effect } from "effect";
import { SqlClient } from "effect/sql";
import { coreState } from "./core-context.ts";
import type { GatewayCore } from "./core.ts";
import { threadWatchRevision } from "../store/thread-watch-revision.ts";

/** Local UI watches validate durable revisions independently of in-process Hub delivery. */
export async function* watchLocalThread(core: GatewayCore, input: ui.WatchThreadRequest, signal: AbortSignal) {
  let checkpoint = input.cursor || input.mirrorCursor;
  let fromTurnId = input.fromTurnId;
  let historyVersion = input.historyVersion;
  const interval = core[coreState].options.watchProbeMs ?? 5000;

  while (!signal.aborted) {
    const stop = new AbortController();
    const combined = AbortSignal.any([signal, stop.signal]);
    let seeded = false;
    let probing = false;
    let failure: unknown;
    let lastSeq: bigint | undefined;
    let previousProbe = Date.now();
    let reason = "revision";

    const probe = async () => {
      if (!seeded || probing || combined.aborted) return;
      probing = true;

      try {
        const now = Date.now();
        const stalled = now - previousProbe > Math.max(interval * 3, 15_000);
        previousProbe = now;

        const base = MIRROR_CURSOR.exec(checkpoint);

        const rows = await core[coreState].actions.run(
          Effect.gen(function* () {
            const sql = yield* SqlClient.SqlClient;

            return yield* sql.unsafe<{ epoch: string; revision: string }>(threadWatchRevision, [
              core[coreState].options.userId,
              input.threadId,
              base?.[1] ?? null,
              base?.[2] ?? null,
            ]);
          }),
        );

        const clock = rows[0];
        const cursor = clock ? `${clock.epoch}:${clock.revision}` : undefined;

        if (combined.aborted || !cursor) return;
        const next = MIRROR_CURSOR.exec(cursor);

        if (stalled || !base || !next || base[1] !== next[1] || BigInt(next[2]!) > BigInt(base[2]!)) {
          reason = stalled ? "event_loop_stall" : "revision";

          if (stalled) console.warn("Local thread watch stalled", { threadId: input.threadId });
          stop.abort();
        }
      } catch (error) {
        failure = error;
        console.warn("Local thread watch probe failed", { threadId: input.threadId });
        stop.abort();
      } finally {
        probing = false;
      }
    };

    const timer = setInterval(() => {
      void probe();
    }, interval);

    timer.unref();

    try {
      const updates = core.watchThread(
        input.threadId,
        combined,
        input.incremental ? checkpoint : input.mirrorCursor,
        true,
        { ...input, fromTurnId, historyVersion },
      );

      for await (const update of updates) {
        if (combined.aborted) break;
        const change = update.change;

        if (change.case === "snapshot" || change.case === "delta") {
          const snapshot = change.case === "snapshot" ? change.value : change.value.snapshot;

          if (!snapshot) throw new ConnectError("Missing thread snapshot", Code.DataLoss);
          checkpoint = snapshot.cursor;
          fromTurnId ||= snapshot.historyBeforeTurnId;
          historyVersion = snapshot.historyVersion;
          lastSeq = snapshot.lastSeq;
          seeded = true;
        } else if (change.case === "event") {
          if (lastSeq !== undefined && change.value.seq > lastSeq + 1n) {
            checkpoint = "";
            reason = "event_gap";
            console.warn("Local thread watch sequence gap", { threadId: input.threadId });
            stop.abort();
            break;
          }

          if (lastSeq !== undefined && change.value.seq <= lastSeq) continue;
          lastSeq = change.value.seq;
        }

        yield update;
      }

      if (failure) throw failure;

      if (!combined.aborted) throw new ConnectError("Local thread watch ended", Code.Unavailable);
    } finally {
      clearInterval(timer);
      stop.abort();
    }

    if (!signal.aborted) {
      console.debug("Local thread watch resubscribing", { threadId: input.threadId, reason });
      yield create(ui.ThreadUpdateSchema, { syncing: true });
    }
  }
}
