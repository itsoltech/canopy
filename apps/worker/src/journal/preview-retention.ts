import type { Database } from "bun:sqlite";
import { fromBinary } from "@bufbuild/protobuf";
import { ThreadEventSchema } from "@canopy/contracts";
import { previewRefs } from "@canopy/domain";

/** Read all unacknowledged events, including held delivery, without loading their entire payloads into memory. */
export function pendingPreviewHashes(db: Database): ReadonlySet<string> {
  const hashes = new Set<string>();

  for (const { payload } of db.query<{ payload: Uint8Array }, []>("SELECT payload FROM events").iterate()) {
    const { body } = fromBinary(ThreadEventSchema, payload);
    const item = body.case === "itemStarted" || body.case === "itemCompleted" ? body.value.item : undefined;

    if (item) for (const ref of previewRefs(item)) hashes.add(ref.sha256);
  }

  return hashes;
}
