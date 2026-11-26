import { create, type JsonValue } from "@bufbuild/protobuf";
import { Code, ConnectError } from "@connectrpc/connect";
import { ui } from "@canopy/contracts";
import { resolveSpawnTarget, type AgentBusArgs, type SpawnTarget } from "@canopy/domain";
import { splitId } from "@canopy/domain/computers";
import { providerOf } from "@canopy/domain/harnesses";
import { Effect } from "effect";
import { SqlClient } from "effect/sql";
import { localAgentSender } from "../computers/agents-senders.ts";
import { AGENT_START_THREAD } from "../computers/capabilities.ts";
import { AgentBusStore, GatewayStore, type CallSource, type ThreadRow } from "../store/index.ts";
import { insertCall, queueTurn } from "../store/agent-bus-queries.ts";
import { busPermissionMode } from "../store/agent-bus-types.ts";
import { permissionModeOf } from "../store/ui-mappers.ts";
import { SANDBOX_DERIVATION_UNAVAILABLE, threadSandbox } from "../store/thread-sandbox.ts";
import { automationMode, createWorktreeRefusal } from "../worktrees/automation.ts";
import { BusRefusal } from "./agent-bus-context.ts";
import { resolveAgentThreadPlacement } from "./agent-thread-placement.ts";
import { coreState, InvalidError } from "./core-context.ts";
import { coreSpawnInstances } from "./core-models.ts";
import type { GatewayCore } from "./core.ts";
import { START_INDEPENDENT_THREAD } from "../computers/agents-context.ts";
import { createThreadWithAgentTurn } from "./create-thread.ts";
import { requireThreadModule } from "./thread-module-runtime.ts";
import { withTurnPermissionMutation } from "./turn-permission-state.ts";

type StartArgs = AgentBusArgs["start_thread"];

type Placement = Awaited<ReturnType<typeof resolveAgentThreadPlacement>>;

export async function agentStartRequest(
  core: GatewayCore,
  args: StartArgs,
  placement: Placement,
  preferred: SpawnTarget,
  permissionMode: ui.CreateThreadRequest["permissionMode"],
  callId: string,
  sameWorker = false,
) {
  const instances = await coreSpawnInstances(core, placement.worker.id);
  const available = instances?.filter((instance) => instance.available);

  const own = available?.find(
    (instance) => instance.harness === preferred.harness && instance.id === preferred.instance,
  );

  const chosen =
    own ??
    available?.find((instance) => instance.harness === preferred.harness && instance.id === "native") ??
    available?.[0];

  const defaults =
    sameWorker && (!chosen || own)
      ? preferred
      : {
          harness: chosen?.harness ?? preferred.harness,
          instance: chosen?.id ?? preferred.instance,
          model: "",
          effort: "",
        };

  const resolved = resolveSpawnTarget(args, defaults, instances);

  if (!resolved.ok) throw new BusRefusal(resolved.reason);

  return create(ui.CreateThreadRequestSchema, {
    projectId: placement.workspace.projectId,
    workspaceId: placement.workspace.id,
    title: args.title,
    initialMessage: args.prompt,
    instructions: args.instructions ?? "",
    provider: providerOf(resolved.target.harness),
    providerProfileId: resolved.target.instance,
    model: resolved.target.model,
    effort: resolved.target.effort,
    serviceTier: resolved.target.serviceTier ?? "",
    clientRequestId: `agent:${callId}`,
    workspaceMode: automationMode(args.workspace_mode ?? "default"),
    baseRef: args.base_ref ?? "",
    permissionMode,
  });
}

export async function startAgentThread(
  core: GatewayCore,
  source: CallSource,
  caller: ThreadRow,
  args: StartArgs,
  hops: number,
  preferred: SpawnTarget,
): Promise<JsonValue> {
  const { actions, options } = core[coreState];

  if (threadSandbox(caller)) throw new BusRefusal(SANDBOX_DERIVATION_UNAVAILABLE);
  const placement = await resolveAgentThreadPlacement(core, caller, args);
  const peer = splitId(placement.workspace.id).node;

  const access = () =>
    actions.run(
      AgentBusStore.use((s) =>
        s.spawnPermission(source, caller, args.permission_mode, peer ? null : placement.worker.id),
      ),
    );

  const replay = async () => {
    const saved = await actions.run(AgentBusStore.use((s) => s.storedCall(source.callId)));

    if (!saved) return undefined;

    if (saved.source_thread_id === caller.id && saved.tool === "start_thread" && saved.status === "completed")
      return saved.result ?? {};
    throw new BusRefusal("This tool call has already ended.");
  };

  try {
    return await withTurnPermissionMutation(options.runtime, caller.id, async () => {
      if (peer) {
        const previous = await replay();

        return (
          previous ??
          (await startLinkedAgentThread(core, source, caller, args, hops, placement, (await access()).permissionMode))
        );
      }

      return actions.transaction(async () => {
        await requireThreadModule(core);
        const permission = await access(); // Locks and re-reads the source turn's permission.
        const previous = await replay();

        if (previous !== undefined) return previous;
        const current = await actions.run(GatewayStore.use((store) => store.thread(caller.id)));

        if (current.memory_audience || current.remote_parent_ref || current.depth)
          throw new BusRefusal("Only a main thread can start an independent thread.");

        if (threadSandbox(current)) throw new BusRefusal(SANDBOX_DERIVATION_UNAVAILABLE);

        const request = await agentStartRequest(
          core,
          args,
          placement,
          preferred,
          permissionModeOf(permission.permissionMode),
          source.callId,
          placement.worker.id === caller.worker_id,
        );

        await createThreadWithAgentTurn(core, request, permission, async (row) => {
          await actions.run(recordAgentStart(source, caller, args, hops, row));
        });
        const result = await replay();

        if (result === undefined) throw new BusRefusal("This request already belongs to another thread.");

        return result;
      });
    });
  } catch (cause) {
    const detail = createWorktreeRefusal(cause);

    if (detail) throw new BusRefusal(detail);

    if (cause instanceof InvalidError) throw new BusRefusal(cause.message);

    if (cause instanceof ConnectError && cause.code !== Code.Internal && cause.code !== Code.Unknown)
      throw new BusRefusal(cause.rawMessage);
    throw cause;
  }
}

function recordAgentStart(source: CallSource, caller: ThreadRow, args: StartArgs, hops: number, row: ThreadRow) {
  return Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const notify = args.notify ?? true;

    yield* insertCall(sql, { source, tool: "start_thread", args, status: "completed", hops, notify });

    const note = `[canopy] Task from the thread "${caller.title}" (thread_id: ${caller.id}).`;

    const turn = yield* queueTurn(sql, {
      threadId: row.id,
      input: { note, message: args.prompt },
      trigger: "agent_bus",
      callId: source.callId,
      hops,
    });

    const result = {
      thread_id: row.id,
      turn_id: turn.id,
      project_id: row.project_id,
      workspace_id: row.workspace_id ?? "",
      worker_id: row.worker_id ?? "",
      provider: `${row.provider}/${row.provider_profile_id ?? "native"}`,
      model: row.settings.model ?? "",
      permission_mode: busPermissionMode(row.settings.permissionMode),
      note: notify ? "You will receive a report when the first turn finishes." : "Follow the thread with get_thread.",
    };

    yield* sql`UPDATE agent_bus_calls SET target_thread_id = ${row.id}::uuid, target_turn_id = ${turn.id}::uuid,
      result = ${JSON.stringify(result)}::jsonb WHERE id = ${source.callId}::uuid`;
  });
}

async function startLinkedAgentThread(
  core: GatewayCore,
  source: CallSource,
  caller: ThreadRow,
  args: StartArgs,
  hops: number,
  placement: Placement,
  permissionMode: string,
) {
  const host = core.linkedAgents;
  const computers = core.computers;
  const node = await host.peer(placement.workspace.id);

  if (!computers) throw new BusRefusal("That computer is no longer linked.");

  if (!computers.reachable().includes(node)) throw await computers.unavailable(node);

  if (!computers.capabilities(node).includes(AGENT_START_THREAD))
    throw new BusRefusal(`${await host.machine(node)} needs an update to start an independent thread.`);
  const actor = { id: caller.id, kind: "thread" as const, hops, name: caller.title };
  const sender = await localAgentSender(host, actor);
  const { project: _project, ...options } = args;

  const result = await host.send(node, START_INDEPENDENT_THREAD, { ...actor, sender }, source.callId, {
    ...options,
    workspace: splitId(placement.workspace.id).id,
    worker: splitId(placement.worker.id).id,
    permission_mode: busPermissionMode(permissionMode),
  });

  await core[coreState].actions.run(
    AgentBusStore.use((s) => s.recordCall({ source, tool: "start_thread", args, ok: true, result })),
  );

  return result;
}
