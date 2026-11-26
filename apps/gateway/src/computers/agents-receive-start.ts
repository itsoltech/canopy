import { toJson } from "@bufbuild/protobuf";
import { ui, type computerLink } from "@canopy/contracts";
import { decodeAgentBusCall } from "@canopy/domain";
import { harnessOf } from "@canopy/domain/harnesses";
import { qualifyId } from "@canopy/domain/computers";
import { Result } from "effect";
import { BusRefusal } from "../core/agent-bus-context.ts";
import { agentStartRequest } from "../core/agent-thread-start.ts";
import { createThreadWithAgentTurn } from "../core/create-thread.ts";
import { permissionModeOf } from "../store/ui-mappers.ts";
import { createWorktreeRefusal } from "../worktrees/automation.ts";
import { ownWorkspace } from "../worktrees/core-worktrees.ts";
import { fail, requireLinkedChainCapacity, uuid, type Arguments } from "./agents-context.ts";
import { receivedAgentSender } from "./agents-senders.ts";
import type { LinkedAgents } from "./agents.ts";

export async function receiveAgentThreadStart(
  host: LinkedAgents,
  node: string,
  call: computerLink.LinkedAgentCall,
  args: Arguments,
) {
  if (call.actorKind !== "thread" || call.hops < 1) return fail("Invalid thread start request");
  const { sender_name: _name, ...options } = args;
  const decoded = decodeAgentBusCall("start_thread", JSON.stringify(options));

  if (Result.isFailure(decoded) || decoded.success.tool !== "start_thread") return fail("Invalid thread start options");

  const selection = decoded.success.args;

  if (
    !selection.workspace ||
    !uuid(selection.workspace) ||
    !selection.worker ||
    !uuid(selection.worker) ||
    selection.project ||
    !selection.permission_mode
  )
    return fail("Choose a configured workspace on this computer.");
  requireLinkedChainCapacity(call.hops, selection.notify ?? true);

  try {
    const placement = await ownWorkspace(host.core, selection.workspace);

    if (placement.worker.id !== selection.worker) return fail("The workspace does not belong to the chosen worker.");

    if (!placement.worker.online) return fail("The target worker is offline; no work was queued.");
    const sender = await receivedAgentSender(host, node, call);
    const home = host.core.computers!.hello().nodeId;

    const request = await agentStartRequest(
      host.core,
      selection,
      placement,
      {
        harness: harnessOf(sender.provider) ?? "codex",
        instance: sender.providerProfileId || "native",
        model: "",
        effort: "",
      },
      permissionModeOf(selection.permission_mode.toUpperCase()),
      call.callId,
    );

    request.clientRequestId = `agent:${qualifyId(call.callId, node)}`;
    let turn = "";

    const thread = await createThreadWithAgentTurn(host.core, request, {}, async (row) => {
      turn = Bun.randomUUIDv7();
      const note = `[canopy] Task from the thread "${sender.title}" (thread_id: ${sender.threadId}).`;
      await host.query(
        `INSERT INTO turns (id,thread_id,ordinal,trigger,linked_call_id,hops,input)
         VALUES ($1::uuid,$2::uuid,1,'linked_agent',$3::uuid,$4,$5::jsonb)`,
        [
          turn,
          row.id,
          call.callId,
          call.hops,
          JSON.stringify({
            text: `${note}\n\n${selection.prompt}`,
            note,
            message: selection.prompt,
            sourceKind: "task",
            sender: toJson(ui.AgentSenderSchema, sender),
          }),
        ],
      );
    });

    return {
      target: thread.id,
      turn,
      placement: {
        project_id: qualifyId(thread.projectId, home),
        workspace_id: qualifyId(thread.workspaceId, home),
        worker_id: qualifyId(thread.workerId, home),
      },
    };
  } catch (cause) {
    const detail = cause instanceof BusRefusal ? cause.message : createWorktreeRefusal(cause);

    if (detail) return fail(detail);
    throw cause;
  }
}
