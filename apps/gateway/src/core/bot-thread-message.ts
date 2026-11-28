import { createHash } from "node:crypto";
import type { AgentBusArgs } from "@canopy/domain";
import { BotStore } from "../bots/store.ts";
import { Invalid, type CallSource, type ThreadRow } from "../store/index.ts";
import { coreState } from "./core-context.ts";
import type { GatewayCore } from "./core.ts";
import { transferThreadFiles, type ThreadFileTransfer } from "./thread-file-transfer.ts";

export async function sendThreadMessageToBot(
  core: GatewayCore,
  source: CallSource,
  caller: ThreadRow,
  args: AgentBusArgs["message_delegating_bot"],
) {
  const { runtime, userId, attachmentLimits } = core[coreState].options;

  const send = (transfer?: ThreadFileTransfer) =>
    runtime.runPromise(BotStore.use((s) => s.messageDelegatingBot(userId, source, args, attachmentLimits, transfer)));

  const paths = args.attachment_paths ?? [];

  if (!paths.length) return send();

  if (new Set(paths).size !== paths.length) throw new Invalid("Attach each file once.");
  await core.bots.run((s) => s.checkThreadFileRecipient(userId, source));
  const hash = createHash("sha256").update(JSON.stringify(args)).digest("hex");

  return transferThreadFiles(core, source, caller, { media: "file", paths, hash }, send);
}
