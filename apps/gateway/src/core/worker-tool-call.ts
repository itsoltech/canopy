import { isMemoryTool } from "@canopy/domain/memory-tools";
import { threadMemoryCall } from "./thread-memory.ts";
import type { AgentToolCall } from "@canopy/contracts";
import type { WorkerConnection } from "../worker-link/index.ts";
import { authorizeLocalAutomation } from "./automation-permissions.ts";
import { coreLog } from "./core-broadcast.ts";
import { coreState, describeError } from "./core-context.ts";
import type { GatewayCore } from "./core.ts";

async function callTool(core: GatewayCore, connection: WorkerConnection, call: AgentToolCall) {
  const { workerId } = connection;

  if (call.botId) return core.bots.harnessTools.handle(call, workerId);

  if (isMemoryTool(call.toolName)) return threadMemoryCall(core, call, connection);

  if (call.toolName === "authorize_local_automation") return authorizeLocalAutomation(core, call, connection);

  if (!call.cancelled && call.connectorAccountId) return core.connectors.handle(call, workerId);

  return core.bus.handle(call, workerId, connection);
}

/** Run tool calls concurrently with ingest and track them even when a worker reconnects. */
export async function handleWorkerToolCall(core: GatewayCore, connection: WorkerConnection, call: AgentToolCall) {
  const state = core[coreState];
  state.workerToolCalls++;

  try {
    const result = await callTool(core, connection, call);

    try {
      connection.send({ case: "agentToolResult", value: result });
    } catch {
      // A worker whose link closed re-sends the call and gets the stored result.
    }
  } catch (cause) {
    coreLog(core, `agent bus call ${call.toolName} failed: ${describeError(cause)}`);
  } finally {
    state.workerToolCalls--;
  }
}
