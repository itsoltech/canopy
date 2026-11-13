import { isMessage, type Message } from "@bufbuild/protobuf";
import { computerLink, ui, WorkerMessageSchema, GatewayMessageSchema } from "@canopy/contracts";

/** Closed numeric classes. Reads discriminants only, never user text or encoded copies. */
export function messageKind(message: Message): number {
  if (isMessage(message, ui.ThreadUpdateSchema)) {
    if (message.watchCursor && !message.change.case) return 2;

    if (message.change.case === "snapshot") return 0;

    if (message.change.case === "delta" || message.change.case === "event") return 1;
  }

  if (isMessage(message, computerLink.MirrorUpdateSchema)) {
    if (message.heartbeat) return 2;

    if (message.snapshot || message.snapshotStart || message.snapshotEnd) return 0;

    if (message.delta || message.deltaStart || message.deltaEnd) return 1;
  }

  if (
    isMessage(message, ui.OverviewUpdateSchema) &&
    ["mobileSnapshot", "computerSnapshot"].includes(message.change.case ?? "")
  )
    return 0;

  if (isMessage(message, WorkerMessageSchema) && message.payload.case === "heartbeat") return 2;

  if (isMessage(message, GatewayMessageSchema) && message.payload.case === "heartbeatEcho") return 2;

  if (
    isMessage(message, computerLink.LinkFrameSchema) &&
    ["heartbeat", "heartbeatEcho"].includes(message.body.case ?? "")
  )
    return 2;

  return 3;
}
