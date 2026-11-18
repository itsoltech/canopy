import { Schema } from "effect";
import type { BotSteerDelivery } from "../bots/types.ts";
import type { GatewayCore } from "./core.ts";

const steerResult = Schema.decodeUnknownSync(
  Schema.Struct({ status: Schema.Literals(["delivered", "queued", "unsupported"]) }),
);

/** Acceptance of this transient command still requires confirmation from the worker journal. */
export async function deliverBotSteer(core: GatewayCore, { workerId, ...input }: BotSteerDelivery): Promise<boolean> {
  const connection = core.link.connections.get(workerId);

  if (!connection?.isOpen || !connection.hello.capabilities.includes("bot_steer_v1")) return false;
  const result = await connection.sendCommand({ case: "steerBotTurn", value: input }, 10_000, input.inputId);

  return result.ok && (!result.dataJson || steerResult(JSON.parse(result.dataJson)).status !== "unsupported");
}
