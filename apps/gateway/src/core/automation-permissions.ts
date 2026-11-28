import { ownerModuleEnabled, moduleDisabledMessage } from "../store/module-access.ts";
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
import { LOCAL_AUTOMATION_COMPLETION_CAPABILITY } from "@canopy/domain/release/protocol";
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

type JsonObject = ReturnType<typeof inputOf>;

// Browser tools that enter a project login named by their `login` argument.
const LOGIN_TOOLS = new Set([
  "agent_browser_fill_login",
  "agent_browser_fill_one_time_code",
  "agent_browser_open_with_basic_auth",
]);

const MAX_LEASE_MS = 310_000;

const TOOLS = new Map([
  [AgentTool.BROWSER, "agent-browser"],
  [AgentTool.DESKTOP, "agent-desktop"],
  [AgentTool.DEVICE, "agent-device"],
]);

interface Authorization {
  readonly signature: string;
  readonly expires: number;
  readonly connection: WorkerConnection;
  readonly threadId: string;
  readonly turnId: string;
  cancelled: boolean;
  finished: boolean;
  /** The admitted Agent Browser call that may lease project logins (see loginAuthorized). */
  admitted?: { tool: AgentTool; name: string; input: JsonObject };
  permissionId?: string;
  activity?: { threadId: string; value: ui.ThreadAutomationActivity; expires: number };
}

// Leases are live connection state, never durable permissions or replayable agent-bus results.
const leases = new WeakMap<WorkerConnection, Map<string, Authorization>>();

function releaseLeases(core: GatewayCore, current: Map<string, Authorization>, expiredAt?: number): void {
  for (const [id, lease] of current) {
    if (expiredAt !== undefined && (!lease.finished || (lease.activity?.expires ?? lease.expires) > expiredAt))
      continue;
    current.delete(id);

    if (lease.activity) resetActivity(core, lease.activity.threadId, id);
  }
}

export function expireLocalAutomationLeases(core: GatewayCore, connection: WorkerConnection, now: number): void {
  const current = leases.get(connection);

  if (current) releaseLeases(core, current, now);
}

function resetActivity(core: GatewayCore, threadId: string, callId: string): void {
  core.hub.publishThread(
    threadId,
    create(ui.ThreadUpdateSchema, { change: { case: "automationActivityReset", value: callId } }),
  );
}

function connectionLeases(core: GatewayCore, connection: WorkerConnection) {
  const existing = leases.get(connection);

  if (existing) return existing;
  const current = new Map<string, Authorization>();
  leases.set(connection, current);
  void connection.closed.then(() => {
    leases.delete(connection);
    // A replaced link can remain online in overview. Its in-flight calls can no longer report a finish.
    releaseLeases(core, current);
  });

  return current;
}

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
  const { runtime, userId } = core[coreState].options;

  if (!(await runtime.runPromise(ownerModuleEnabled(userId, "threads"))))
    throw new Error(moduleDisabledMessage("threads"));
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
    lease.admitted = { tool: args.tool, name: args.name, input };
    const activity = automationActivity(request, workerId, args.tool, args.name, input);

    if (activity) {
      activity.reportsCompletion = lease.connection.hello.capabilities.includes(LOCAL_AUTOMATION_COMPLETION_CAPABILITY);

      // Keep only the scope for a full MCP request timeout after admission. Its completion may arrive
      // after the approval deadline, especially when the worker times out and cancels the call.
      if (activity.reportsCompletion)
        lease.activity = { threadId: request.threadId, value: activity, expires: Date.now() + MAX_LEASE_MS };
      core.hub.publishThread(
        request.threadId,
        create(ui.ThreadUpdateSchema, { change: { case: "automationActivity", value: activity } }),
      );
    }

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

/** A finish can retire only the activity admitted on this live connection. */
export function finishLocalAutomation(core: GatewayCore, connection: WorkerConnection, callId: string): void {
  const lease = leases.get(connection)?.get(callId);

  // A completed call can no longer lease a login.
  if (lease) delete lease.admitted;

  if (!lease?.activity || !connection.isOpen || core.link.connections.get(connection.workerId) !== connection) return;
  const { threadId, value, expires } = lease.activity;
  delete lease.activity;

  if (expires <= Date.now()) return resetActivity(core, threadId, callId);

  core.hub.publishThread(
    threadId,
    create(ui.ThreadUpdateSchema, { change: { case: "automationActivityFinished", value } }),
  );
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
      (!request.cancelled && expires <= now) ||
      expires > now + MAX_LEASE_MS
    )
      return refusal(request.callId);
    const workerId = connection.workerId;

    if (!connection.isOpen || core.link.connections.get(workerId) !== connection) return refusal(request.callId);
    const current = connectionLeases(core, connection);

    releaseLeases(core, current, now);

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
        // Authorization may already have published its start while the grant was traveling to the worker.
        finishLocalAutomation(core, connection, request.callId);
        await expirePermission(core, request, known);

        return refusal(request.callId);
      }

      return refusal(request.callId);
    }

    if (request.cancelled || current.size >= 1024) return refusal(request.callId);

    const lease: Authorization = {
      signature,
      expires,
      connection,
      threadId: request.threadId,
      turnId: request.turnId,
      cancelled: false,
      finished: false,
    };

    current.set(request.callId, lease);

    return execute(core, request, lease).catch(() => refusal(request.callId));
  } catch {
    return refusal(request.callId);
  }
}

/**
 * A login lease needs the live, admitted Agent Browser call on this connection that names the login. The
 * worker cannot lease a login outside a browser action the owner's permissions allowed.
 */
export function loginAuthorized(
  core: GatewayCore,
  connection: WorkerConnection,
  request: { threadId: string; turnId: string },
  authorization: string,
  login: string,
): boolean {
  const lease = leases.get(connection)?.get(authorization);

  if (!lease?.admitted || lease.connection !== connection) return false;

  try {
    ensureLive(core, lease);
  } catch {
    return false;
  }

  return (
    lease.threadId === request.threadId &&
    lease.turnId === request.turnId &&
    lease.admitted.tool === AgentTool.BROWSER &&
    LOGIN_TOOLS.has(lease.admitted.name) &&
    lease.admitted.input["login"] === login
  );
}
