import { create } from "@bufbuild/protobuf";
import { CommandResultSchema, type Command, type CommandResult } from "@canopy/contracts";
import { commandThreadSpec } from "./thread-sandbox.ts";
import { SERVICE_TIERS_CAPABILITY } from "@canopy/domain/release/protocol";

export const SERVICE_TIERS_UNSUPPORTED = "Update this worker to use speed settings, or choose another worker.";

/** Explicit Standard also needs support: an older worker may restore an accelerated session. */
export function supportsServiceTier(capabilities: readonly string[], serviceTier: string): boolean {
  return !serviceTier || capabilities.includes(SERVICE_TIERS_CAPABILITY);
}

/** Check the durable payload on every delivery, including reconnects to an older worker. */
export function serviceTierRefusal(capabilities: readonly string[], command: Command): CommandResult | undefined {
  const serviceTier = commandServiceTier(command);

  if (supportsServiceTier(capabilities, serviceTier)) return undefined;

  return create(CommandResultSchema, {
    commandId: command.commandId,
    errorCode: "SERVICE_TIERS_UNSUPPORTED",
    errorMessage: SERVICE_TIERS_UNSUPPORTED,
  });
}

function commandServiceTier(command: Command): string {
  switch (command.kind.case) {
    case "runBotTurn":
    case "steerTurn":
      return command.kind.value.serviceTier;
    case "startTurn":
      return command.kind.value.serviceTier || commandThreadSpec(command)?.serviceTier || "";
    default:
      return "";
  }
}
