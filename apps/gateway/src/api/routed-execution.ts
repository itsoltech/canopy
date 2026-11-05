import type { DescMethod, Message } from "@bufbuild/protobuf";
import { bots, ui } from "@canopy/contracts";
import { REMOTE_THREADS } from "@canopy/domain/computers";
import { Code, ConnectError } from "@connectrpc/connect";
import { Match } from "effect";
import { linkedMessage } from "../computers/remote.ts";
import type { GatewayCore } from "../core/core.ts";
import { harnessOf } from "../store/instance-config.ts";
import { refuseMissingInstance } from "./routed-config.ts";
import { PLAIN } from "./routed-context.ts";

/** Execution stays at one home, independently of configuration sharing. No deferred remote work. */
export async function receiveHomeAction(core: GatewayCore, method: DescMethod, request: Message, peer: string) {
  if (method.name !== "CreateBot" && method.name !== "CreateSchedule") return;
  const computers = core.computers;
  const link = await computers?.store.computer(peer);

  if (!computers || !link || !computers.capabilities(peer).includes(REMOTE_THREADS))
    throw new ConnectError("Update both computers to use this linked action.", Code.FailedPrecondition);

  if (method.name === "CreateBot") {
    const config = linkedMessage(bots.CreateBotRequestSchema, request).configuration;
    const worker = config?.workerId ?? "";

    if (
      !PLAIN.test(worker) ||
      !(
        await computers.store.query(
          "SELECT 1 FROM workers WHERE id=$1::uuid AND owner_user_id=$2::uuid AND archived_at IS NULL",
          [worker, computers.store.owner],
        )
      ).length
    )
      throw new ConnectError("Choose a worker on this computer.", Code.PermissionDenied);
    await refuseMissingInstance(core, harnessOf(config!.provider) ?? "", config!.providerInstance);
  } else {
    const config = linkedMessage(ui.CreateScheduleRequestSchema, request);

    if (config.target === "new_thread" && config.newThread) {
      if (config.newThread.placement !== "specific" || !config.newThread.workspaceId)
        throw new ConnectError("Choose a worker for the new thread.", Code.InvalidArgument);
      await refuseMissingInstance(core, harnessOf(config.newThread.provider) ?? "", config.newThread.providerProfileId);
    }
    // The domain handler validates the target thread/workspace and its owner before inserting anything.
  }
}

/** Only ids and method names enter the audit; configuration and credentials never do. */
export async function auditHomeAction(
  core: GatewayCore,
  direction: "sent" | "received",
  method: DescMethod,
  response: Message,
  node: string,
) {
  const store = core.computers?.store;

  if (!store) return;

  const id = Match.value(method.name).pipe(
    Match.when("CreateBot", () => linkedMessage(bots.GetBotResponseSchema, response).bot?.id),
    Match.when("CreateSchedule", () => linkedMessage(ui.CreateScheduleResponseSchema, response).schedule?.id),
    Match.orElse(() => undefined),
  );

  if (!id) return;
  await store.query(
    "INSERT INTO audit_log(id,actor_user_id,action,target_type,target_id,details) VALUES($1::uuid,$2::uuid,$3,$4,$5::uuid,$6::jsonb)",
    [
      crypto.randomUUID(),
      store.owner,
      `computer.execution.${direction}`,
      method.name === "CreateBot" ? "bot" : "schedule",
      id.split("~")[0],
      JSON.stringify({ method: method.name, node }),
    ],
  );
}
