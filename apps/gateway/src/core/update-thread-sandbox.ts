import { toJson, type JsonValue } from "@bufbuild/protobuf";
import { PermissionMode, SandboxProfileBindingSchema, type ui } from "@canopy/contracts";
import { SANDBOX_PROFILES_CAPABILITY } from "@canopy/domain/sandbox-profiles";
import { Effect } from "effect";
import { SqlClient } from "effect/sql";
import { providerOf } from "../store/instance-config.ts";
import { threadSandbox } from "../store/thread-sandbox.ts";
import { coreRun } from "./core-broadcast.ts";
import { coreDeliver } from "./core-commands.ts";
import { coreState, InvalidError } from "./core-context.ts";
import type { GatewayCore } from "./core.ts";
import { checkSandboxPlacement, ownerSandboxBinding, SANDBOX_MODE_REQUIRED } from "./thread-sandbox.ts";
import { requireThreadModule } from "./thread-module-runtime.ts";

const UNSETTLED = "Finish this thread's active and queued work before changing its sandbox profile.";
const CLEANUP_PENDING = "Wait for the worker to finish unloading this thread, then try again.";

function lockThread(core: GatewayCore, threadId: string) {
  return core[coreState].actions
    .run(
      Effect.flatMap(
        SqlClient.SqlClient,
        (sql) =>
          sql`SELECT id FROM threads WHERE id=${threadId}::uuid AND owner_user_id=${core[coreState].options.userId}::uuid
        AND archived_at IS NULL AND deleted_at IS NULL FOR UPDATE`,
      ),
    )
    .then((rows) => {
      if (!rows.length) throw new InvalidError("thread not found");
    });
}

function requireSettled(core: GatewayCore, threadId: string) {
  return core[coreState].actions
    .run(
      Effect.flatMap(
        SqlClient.SqlClient,
        (sql) =>
          sql`SELECT t.id FROM threads t WHERE t.id=${threadId}::uuid AND t.runtime='worker' AND t.worker_id IS NOT NULL
        AND t.status NOT IN ('creating','running') AND t.preparation_fingerprint IS NULL AND t.rewind_pending_id IS NULL
        AND t.moved_to IS NULL
        AND NOT EXISTS (SELECT 1 FROM turns u WHERE u.thread_id=t.id AND u.status IN ('queued','running'))
        AND NOT EXISTS (SELECT 1 FROM worker_commands c WHERE c.thread_id=t.id AND c.status IN ('pending','delivered'))
        AND NOT EXISTS (SELECT 1 FROM turn_steers s WHERE s.thread_id=t.id AND s.status IN ('pending','accepted','dropped'))
        AND NOT EXISTS (SELECT 1 FROM goals g WHERE g.thread_id=t.id AND
          (g.status NOT IN ('achieved','cancelled') OR g.native_status='active'))
        AND NOT EXISTS (SELECT 1 FROM thread_items i WHERE i.thread_id=t.id AND i.status='in_progress')
        AND NOT EXISTS (SELECT 1 FROM interaction_requests i WHERE i.thread_id=t.id AND i.status='pending')
        AND NOT EXISTS (SELECT 1 FROM import_items i WHERE i.thread_id=t.id AND i.status IN ('pending','importing'))`,
      ),
    )
    .then((rows) => {
      if (!rows.length) throw new InvalidError(UNSETTLED);
    });
}

export async function withSandboxUpdate<A>(
  core: GatewayCore,
  request: ui.UpdateThreadRequest,
  ownerInput: boolean,
  apply: (sandboxProfile?: JsonValue) => Promise<A>,
) {
  const { sandboxProfileId: id, threadId } = request;
  const { actions, options } = core[coreState];

  if (id !== undefined && !ownerInput) throw new InvalidError("Only the owner can select a sandbox profile.");

  if (id === undefined && request.permissionMode === undefined) return apply();
  const binding = id ? await ownerSandboxBinding(core, id) : undefined;

  const runLocked = <T>(work: () => Promise<T>) =>
    actions.transaction(async () => {
      if (id !== undefined) await requireThreadModule(core);
      await lockThread(core, threadId);

      return work();
    });

  const phase = await runLocked(async () => {
    const thread = await coreRun(core, (s) => s.thread(threadId));
    const prior = threadSandbox(thread);
    const keep = id === undefined || prior?.digest === binding?.digest;

    if (
      (keep ? prior : binding) &&
      (request.permissionMode === undefined
        ? thread.settings.permissionMode !== "FULL_AUTO"
        : request.permissionMode !== PermissionMode.FULL_AUTO)
    )
      throw new InvalidError(SANDBOX_MODE_REQUIRED);

    if (keep) return { value: await apply() };

    await requireSettled(core, threadId);
    const workerId = thread.worker_id ?? "";
    const connection = core.link.connections.get(workerId);

    if (!connection?.isOpen)
      throw new InvalidError("Connect this thread's worker before changing its sandbox profile.");

    if (
      !connection.hello.capabilities.includes("thread_resource_cleanup_v1") ||
      !connection.hello.capabilities.includes(SANDBOX_PROFILES_CAPABILITY)
    )
      throw new InvalidError("Update this thread's worker before changing its sandbox profile.");

    if (binding)
      await checkSandboxPlacement(
        core,
        workerId,
        providerOf(thread.provider),
        thread.provider_profile_id ?? "",
        binding,
      );

    if (connection.hasUnpersistedEvents(threadId)) throw new InvalidError(UNSETTLED);

    const command = await coreRun(core, (s) =>
      s.enqueueCommand({
        threadId,
        workerId,
        ttlSeconds: 86400,
        command: { kind: { case: "unloadThread", value: { threadId } } },
      }),
    );

    return { command, connection, digest: prior?.digest, workerId, lastSeq: thread.last_seq };
  });

  if (!phase.command) return phase.value;
  const { command, connection, digest, workerId, lastSeq } = phase;

  // The durable unload fences dispatch during cleanup. A lost reply leaves a replayable unload and the old profile.
  await Promise.race([coreDeliver(core, workerId, command), Bun.sleep(options.commandTimeoutMs ?? 10_000)]);

  return runLocked(async () => {
    const thread = await coreRun(core, (s) => s.thread(threadId));

    if (threadSandbox(thread)?.digest !== digest || thread.worker_id !== workerId || thread.last_seq !== lastSeq)
      throw new InvalidError("The thread changed while being unloaded. Review its permissions and try again.");

    if (
      !connection.isOpen ||
      core.link.connections.get(workerId) !== connection ||
      connection.hasUnpersistedEvents(threadId)
    )
      throw new InvalidError(CLEANUP_PENDING);

    const unloaded = await actions.run(
      Effect.flatMap(
        SqlClient.SqlClient,
        (sql) =>
          sql`SELECT c.id FROM worker_commands c WHERE c.id=${command.commandId}::uuid AND c.status='completed'
          AND NOT EXISTS (SELECT 1 FROM worker_commands newer WHERE newer.thread_id=c.thread_id
            AND newer.kind IN ('createThread','startTurn','setGoal','rewindThread','steerTurn')
            AND (newer.created_at,newer.id) > (c.created_at,c.id))`,
      ),
    );

    if (!unloaded.length) throw new InvalidError(CLEANUP_PENDING);
    await requireSettled(core, threadId);

    if (binding) {
      if (
        (request.permissionMode ??
          (thread.settings.permissionMode === "FULL_AUTO" ? PermissionMode.FULL_AUTO : undefined)) !==
        PermissionMode.FULL_AUTO
      )
        throw new InvalidError(SANDBOX_MODE_REQUIRED);
      await checkSandboxPlacement(
        core,
        workerId,
        providerOf(thread.provider),
        thread.provider_profile_id ?? "",
        binding,
      );
    }

    return apply(binding ? toJson(SandboxProfileBindingSchema, binding) : null);
  });
}
