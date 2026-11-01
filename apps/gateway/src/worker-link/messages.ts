import { create, type MessageInitShape } from "@bufbuild/protobuf";
import { timestampNow } from "@bufbuild/protobuf/wkt";
import { GatewayMessageSchema, type GatewayMessage } from "@open-agents/contracts";

type PayloadInit = NonNullable<MessageInitShape<typeof GatewayMessageSchema>["payload"]>;
export type GatewayPayloadInit = Exclude<PayloadInit, { case: undefined }>;

export function gatewayMessage(payload: GatewayPayloadInit): GatewayMessage {
  return create(GatewayMessageSchema, {
    messageId: Bun.randomUUIDv7(),
    sentAt: timestampNow(),
    payload,
  });
}
