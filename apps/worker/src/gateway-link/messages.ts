import { create, type MessageInitShape } from "@bufbuild/protobuf";
import { timestampNow } from "@bufbuild/protobuf/wkt";
import { WorkerMessageSchema, type WorkerMessage } from "@canopy/contracts";

type PayloadInit = NonNullable<MessageInitShape<typeof WorkerMessageSchema>["payload"]>;
export type WorkerPayloadInit = Exclude<PayloadInit, { case: undefined }>;

export function workerMessage(payload: WorkerPayloadInit): WorkerMessage {
  return create(WorkerMessageSchema, {
    messageId: Bun.randomUUIDv7(),
    sentAt: timestampNow(),
    payload,
  });
}
