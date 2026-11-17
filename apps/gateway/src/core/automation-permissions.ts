import { createHash } from "node:crypto";
import { create } from "@bufbuild/protobuf";
import { timestampDate } from "@bufbuild/protobuf/wkt";
import {
  AgentTool,
  AgentToolResultSchema,
  InteractionKind,
  InteractionRequestSchema,
  type AgentToolCall,
  type AgentToolResult,
  ui,
} from "@canopy/contracts";
import { Schema } from "effect";
import { coreRun } from "./core-broadcast.ts";
import { corePublishInteraction } from "./core-interactions.ts";
import { coreState } from "./core-context.ts";
import { AGENT_WORKER_ID } from "./agent-tools-validation.ts";
import type { WorkerConnection } from "../worker-link/index.ts";
import type { GatewayCore } from "./core.ts";
import { automationActivity } from "./automation-activity.ts";
import { readTurnPermissions } from "./turn-permission-state.ts";
import { allowFullAccessPermission } from "./live-turn-permissions.ts";

const Arguments = Schema.fromJsonString(
  Schema.Struct({ tool: Schema.Number, name: Schema.String, arguments: Schema.String }),
);

const inputOf = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.JsonObject));

const TOOLS = new Map([
  [AgentTool.BROWSER, "agent-browser"],
  [AgentTool.DESKTOP, "agent-desktop"],
  [AgentTool.DEVICE, "agent-device"],
]);

interface Authorization {
  readonly signature: string;
  readonly expires: number;
  readonly connection: WorkerConnection;
  cancelled: boolean;
  finished: boolean;
  permissionId?: string;
}

// Leases are live connection state, never durable permissions or replayable agent-bus results.
const leases = new WeakMap<WorkerConnection, Map<string, Authorization>>();

const refusal = (callId: string) =>
  create(AgentToolResultSchema, {
    callId,
    isError: true,
    content:
      "Automation action refused. Check the worker grant, active turn, permission mode and approval. Do not retry a declined action.",
  });

function ensureLive(core: GatewayCore, lease: Authorization): void {
  if (
    lease.cancelled ||
    lease.expires <= Date.now() ||
    !lease.connection.isOpen ||
    core.link.connections.get(lease.connection.workerId) !== lease.connection
  )
    throw new Error("Automation authorization is no longer live");
}

async function active(core: GatewayCore, request: AgentToolCall, lease: Authorization) {
  return readTurnPermissions(core[coreState].options.runtime, request.threadId, request.turnId, () =>
    activeMode(core, request, lease),
  );
}

async function activeMode(core: GatewayCore, request: AgentToolCall, lease: Authorization) {
  ensureLive(core, lease);
  const thread = await coreRun(core, (store) => store.thread(request.threadId));
  const turn = await coreRun(core, (store) => store.runningTurn(request.threadId));

  if (
    thread.owner_user_id !== core[coreState].options.userId ||
    thread.worker_id !== lease.connection.workerId ||
    thread.archived_at ||
    thread.rewind_pending_id ||
    !turn ||
    turn.id !== request.turnId ||
    turn.rewind_id
  )
    throw new Error("Automation requires the worker's active owned turn");

  return turn.permission_mode || thread.settings.permissionMode || "ASK";
}

async function expirePermission(core: GatewayCore, request: AgentToolCall, lease: Authorization): Promise<void> {
  const permissionId = lease.permissionId;

  if (!permissionId) return;
  const expired = await coreRun(core, (store) => store.expireInteraction(permissionId, request.threadId));

  if (expired) await corePublishInteraction(core, expired);
}

async function execute(core: GatewayCore, request: AgentToolCall, lease: Authorization): Promise<AgentToolResult> {
  let allowed = false;

  try {
    const args = Schema.decodeUnknownSync(Arguments)(request.argumentsJson);
    const label = TOOLS.get(args.tool);

    if (!label || !/^[a-zA-Z0-9_-]{1,200}$/.test(args.name) || args.arguments.length > 80_000)
      throw new Error("Invalid automation arguments");
    const input = inputOf(args.arguments);
    const workerId = lease.connection.workerId;
    await core.agentTools.authorizePreview(workerId, args.tool);
    const mode = await active(core, request, lease);

    if (mode === "READ_ONLY") throw new Error("Read-only threads cannot control automation tools");

    if (mode !== "FULL_AUTO" && mode !== "FULL_ACCESS") {
      // Independent IDs ensure a retried call can never inherit an old interaction's decision.
      const permissionId = Bun.randomUUIDv7();
      lease.permissionId = permissionId;

      const interaction = await coreRun(core, (store) =>
        store.recordInteraction(
          create(InteractionRequestSchema, {
            requestId: permissionId,
            threadId: request.threadId,
            turnId: request.turnId,
            itemId: request.itemId,
            kind: InteractionKind.PERMISSION,
            toolName: `${label} · ${args.name}`,
            requestJson: JSON.stringify({ description: "Allow this automation action?", input }),
            expiresAt: request.expiresAt,
          }),
        ),
      );

      ensureLive(core, lease);
      await corePublishInteraction(core, interaction);
      await allowFullAccessPermission(core, interaction, true);
      await core.bus.onInteraction(interaction);

      for (;;) {
        await active(core, request, lease);
        await core.agentTools.authorizePreview(workerId, args.tool);
        await allowFullAccessPermission(core, interaction, true);
        const answer = await coreRun(core, (store) => store.interactionAnswer(interaction.requestId));

        if (answer) {
          if (!answer.answer.allow || answer.answer.cancelled) throw new Error("The automation action was declined");
          break;
        }

        await Bun.sleep(100);
      }
    }

    if ((await active(core, request, lease)) === "READ_ONLY")
      throw new Error("Read-only threads cannot control automation tools");
    await core.agentTools.authorizePreview(workerId, args.tool);
    ensureLive(core, lease);
    allowed = true;
    const activity = automationActivity(request, workerId, args.tool, args.name, input);

    if (activity)
      core.hub.publishThread(
        request.threadId,
        create(ui.ThreadUpdateSchema, { change: { case: "automationActivity", value: activity } }),
      );

    return create(AgentToolResultSchema, { callId: request.callId, content: "allowed" });
  } catch {
    return refusal(request.callId);
  } finally {
    try {
      if (!allowed) await expirePermission(core, request, lease);
    } finally {
      lease.finished = true;
    }
  }
}

/** Internal bridge authorization: current grants and one live call, never listed as a model tool. */
export async function authorizeLocalAutomation(
  core: GatewayCore,
  request: AgentToolCall,
  connection: WorkerConnection,
): Promise<AgentToolResult> {
  try {
    const now = Date.now();
    const expires = request.expiresAt ? timestampDate(request.expiresAt).getTime() : 0;

    if (
      request.botId ||
      request.connectorAccountId ||
      request.argumentsJson.length > 100_000 ||
      ![request.callId, request.threadId, request.turnId].every((id) => AGENT_WORKER_ID.test(id)) ||
      !Number.isFinite(expires) ||
      expires <= now ||
      expires > now + 310_000
    )
      return refusal(request.callId);
    const workerId = connection.workerId;

    if (!connection.isOpen || core.link.connections.get(workerId) !== connection) return refusal(request.callId);
    const current = leases.get(connection) ?? new Map<string, Authorization>();
    leases.set(connection, current);

    for (const [id, lease] of current) if (lease.finished && lease.expires <= now) current.delete(id);

    const signature = createHash("sha256")
      .update(
        JSON.stringify([workerId, request.threadId, request.turnId, request.itemId, request.argumentsJson, expires]),
      )
      .digest("hex");

    const known = current.get(request.callId);

    if (known) {
      if (known.signature !== signature || known.connection !== connection) return refusal(request.callId);

      if (request.cancelled) {
        known.cancelled = true;
        await expirePermission(core, request, known);

        return refusal(request.callId);
      }

      return refusal(request.callId);
    }

    if (request.cancelled || current.size >= 1024) return refusal(request.callId);
    const lease: Authorization = { signature, expires, connection, cancelled: false, finished: false };
    current.set(request.callId, lease);

    return execute(core, request, lease).catch(() => refusal(request.callId));
  } catch {
    return refusal(request.callId);
  }
}
