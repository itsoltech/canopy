import { create, fromJson, type JsonValue, type Message } from "@bufbuild/protobuf";

import { timestampFromDate } from "@bufbuild/protobuf/wkt";

import { Code, ConnectError } from "@connectrpc/connect";

import { computerLink as link, ThreadEventSchema, ui } from "@canopy/contracts";

import { linkedMessage } from "./remote.ts";

import { ThreadMirror } from "./mirror.ts";

export const SNAPSHOT_LISTS = ["turns", "items", "interactions", "notices", "steers", "busDeliveries"] as const;

/** Whole timelines have no retention/size cap; each transport message is bounded independently. */
export function* snapshotFrames(snapshot: ui.ThreadSnapshot, previousCursor = ""): Generator<link.MirrorUpdate> {
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

export function safeOverview(value: ui.GetOverviewResponse): ui.GetOverviewResponse {
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

export async function mirrorThreadSnapshot(
  hostContext: ThreadMirror,
  one: (name: string, request: Message) => Promise<Message>,
  owner: string,
  id: string,
): Promise<ui.ThreadSnapshot | undefined> {
  try {
    const value = linkedMessage(
      ui.ThreadUpdateSchema,
      await one("WatchThread", create(ui.WatchThreadRequestSchema, { threadId: id })),
    ).change;

    if (value.case !== "snapshot") throw new ConnectError("Missing thread snapshot", Code.Internal);

    if (value.value.thread?.deletedAt) return undefined;
    value.value.secrets = [];
    value.value.schedules = [];

    // Live UI snapshots cap diagnostics at 200; durable mirrors retain the whole timeline.
    const notices = await hostContext.store.query<{
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
}
