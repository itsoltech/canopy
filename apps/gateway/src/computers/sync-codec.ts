import { fromBinary, toBinary, type DescMessage, type MessageShape } from "@bufbuild/protobuf";
import { computerLink as link, ui } from "@canopy/contracts";
import { syncMetrics, syncCpu, syncCpuMicros } from "@canopy/transport";
import { linkedMessage } from "./remote-policy.ts";
import { threadUpdateBytes } from "../core/thread-update-bytes.ts";

function kind(schema: DescMessage, message: MessageShape<DescMessage>) {
  if (schema.typeName === ui.ThreadUpdateSchema.typeName && message.$typeName === ui.ThreadUpdateSchema.typeName) {
    const update = linkedMessage(ui.ThreadUpdateSchema, message);

    if (update.change.case === "event" && update.change.value.event?.body.case === "itemDelta")
      return update.change.value.firstSeq ? "batch" : "text";

    return update.watchCursor ? "heartbeat" : update.change.case;
  }

  if (schema.typeName === link.MirrorUpdateSchema.typeName && message.$typeName === link.MirrorUpdateSchema.typeName) {
    const update = linkedMessage(link.MirrorUpdateSchema, message);

    return update.heartbeat ? "heartbeat" : update.snapshotStart ? "snapshot" : update.deltaStart ? "delta" : "";
  }

  return "";
}

export function syncEncode<D extends DescMessage>(schema: D, message: MessageShape<D>, channel: string) {
  const start = syncMetrics ? syncCpu() : undefined;

  const bytes =
    schema.typeName === ui.ThreadUpdateSchema.typeName
      ? threadUpdateBytes(linkedMessage(ui.ThreadUpdateSchema, message))
      : toBinary(schema, message);

  if (syncMetrics && start)
    syncMetrics.record(`${channel}.encode`, bytes.length, syncCpuMicros(start), kind(schema, message));

  return bytes;
}

export function syncDecode<D extends DescMessage>(schema: D, bytes: Uint8Array, channel: string) {
  if (!syncMetrics) return fromBinary(schema, bytes);
  const start = syncCpu();
  const message = fromBinary(schema, bytes);
  syncMetrics.record(`${channel}.decode`, bytes.length, syncCpuMicros(start), kind(schema, message));

  return message;
}
