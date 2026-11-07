import type { AgentToolCall, AgentToolResult } from "@canopy/contracts";
import { decodeAgentBusCall } from "@canopy/domain";
import { Result } from "effect";
import { AgentBusStore, GatewayStore, type CallSource } from "../store/index.ts";
import { busState, failure } from "./agent-bus-context.ts";
import type { AgentBus } from "./agent-bus.ts";

export async function busCancel(
  host: AgentBus,
  request: AgentToolCall,
  source: CallSource,
  workerId?: string,
): Promise<AgentToolResult> {
  const caller = await host[busState].host.run(GatewayStore.use((s) => s.thread(request.threadId)));

  if (workerId === undefined || caller.worker_id === workerId) {
    const decoded = decodeAgentBusCall(request.toolName, request.argumentsJson);

    if (Result.isFailure(decoded)) return failure(request.callId, "This request expired.");
    const call = decoded.success;

    if (call.tool === "wait_threads")
      await host[busState].host.run(
        AgentBusStore.use((s) =>
          s.recordCall({ source, tool: call.tool, args: call.args, ok: false, error: "This request expired." }),
        ),
      );

    const expired =
      call.tool === "ask_user" && call.args.wait
        ? await host[busState].host.run(AgentBusStore.use((s) => s.askUser(source, call.args, 0, true)))
        : call.tool === "get_answers"
          ? await host[busState].host.run(
              GatewayStore.use((s) => s.expireInteraction(call.args.question_set_id, request.threadId)),
            )
          : undefined;

    if (expired) await host[busState].host.interaction(expired);
  }

  return failure(request.callId, "This request expired.");
}
