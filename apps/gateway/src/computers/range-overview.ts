import type { RangeSourceStore } from "./range-source.ts";
import { create } from "@bufbuild/protobuf";
import { computerLink as link, ui } from "@canopy/contracts";
import { Code, ConnectError } from "@connectrpc/connect";
import { linkedMessage, methodNamed, type RemoteServe } from "./remote.ts";
import { safeOverview } from "./mirror-projection.ts";
import type { PublicationFailureRow } from "./range-publication-failure.ts";

export type RangeOverviewClock = { revision: string; epoch: string };

export type RangeThreadHead = PublicationFailureRow & {
  id: string;
  epoch: string | null;
  head: string | null;
  version: string | null;
};

export function rangeThreadHeads(store: RangeSourceStore) {
  return store.query<RangeThreadHead>(
    `SELECT t.id,c.epoch,c.head_seq::text AS head,c.change_version::text AS version,
      f.signature AS failure_signature,f.payload AS failure_payload,f.attempts AS failure_attempts,
      f.retry_at::text AS failure_next,f.failed_at::text AS failure_at
    FROM threads t LEFT JOIN thread_replication_clock c ON c.thread_id=t.id
    LEFT JOIN thread_publication_failures f ON f.thread_id=t.id
    WHERE t.owner_user_id=$1::uuid AND t.deleted_at IS NULL ORDER BY t.id`,
    [store.owner],
    "mirrors.read",
  );
}

export async function rangeOverviewUpdate(serve: RemoteServe, signal: AbortSignal) {
  for await (const message of serve(methodNamed("GetOverview")!, create(ui.GetOverviewRequestSchema), signal))
    return create(link.MirrorUpdateSchema, {
      overview: safeOverview(linkedMessage(ui.GetOverviewResponseSchema, message)),
    });
  throw new ConnectError("Missing computer overview", Code.Internal);
}

/** Transcript edits do not invalidate the worker/project picker metadata. */
export async function rangeOverview(store: RangeSourceStore, previous?: RangeOverviewClock) {
  const clock = (
    await store.query<RangeOverviewClock>(
      "SELECT revision::text,epoch FROM computer_thread_clock WHERE owner_user_id=$1::uuid",
      [store.owner],
      "mirrors.read",
    )
  )[0] ?? { revision: "0", epoch: "" };

  if (!previous || clock.epoch !== previous.epoch) return { clock, changed: true };

  if (clock.revision === previous.revision) return { clock, changed: false };

  const changes = (
    await store.query<{ count: string; metadata: boolean }>(
      `SELECT count(*)::text AS count,coalesce(bool_or(thread_id IS NULL),false) AS metadata
      FROM computer_thread_changes WHERE owner_user_id=$1::uuid AND revision>$2::bigint AND revision<=$3::bigint`,
      [store.owner, previous.revision, clock.revision],
      "mirrors.read",
    )
  )[0]!;

  // A retained range must be contiguous; otherwise refresh conservatively.
  return {
    clock,
    changed: changes.metadata || BigInt(changes.count) !== BigInt(clock.revision) - BigInt(previous.revision),
  };
}
