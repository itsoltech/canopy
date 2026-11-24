import { create } from "@bufbuild/protobuf";
import {
  CommandResultSchema,
  PermissionMode,
  type Command,
  type Provider,
  type SandboxProfileBinding,
} from "@canopy/contracts";
import { THREAD_WORKTREE_SWITCH_CAPABILITY } from "@canopy/domain/release/protocol";
import { SANDBOX_PROFILES_CAPABILITY, sandboxBinding, sandboxSupportProblem } from "@canopy/domain/sandbox-profiles";
import { Effect } from "effect";
import { SqlClient } from "effect/sql";
import { providerOf } from "../store/instance-config.ts";
import type { ThreadRow } from "../store/rows.ts";
import { DRAFT_SANDBOX_RESELECT, threadSandbox } from "../store/thread-sandbox.ts";
import type { WorkerConnection } from "../worker-link/index.ts";

import { coreState, InvalidError } from "./core-context.ts";
import { coreSettings } from "./core-settings.ts";
import type { GatewayCore } from "./core.ts";

export const SANDBOX_MODE_REQUIRED = "Choose Sandbox to use a custom sandbox profile.";
export const SANDBOX_SHELL_UNAVAILABLE = "Composer shell commands are unavailable with a sandbox profile.";
export const SANDBOX_STEER_UNAVAILABLE = "Messages for a thread with a sandbox profile run in its next turn.";
export const sandboxGoalText = (text: string) => /^\s*\/goal(?:\s|$)/u.test(text);
export const SANDBOX_GOAL_UNAVAILABLE = "Harness goals are unavailable with a sandbox profile.";
const WORKER_OFFLINE = "Connect this thread's worker to use its sandbox profile.";
const CONFIG_PENDING = "Wait for this worker to report sandbox support, then try again.";
const INSTANCE_UNAVAILABLE = "This provider instance is unavailable on this worker.";

function configuredWorkerVersion(core: GatewayCore, workerId: string, owner: string) {
  return core[coreState].actions.run(
    Effect.flatMap(SqlClient.SqlClient, (sql) =>
      sql<{ version: bigint }>`SELECT c.version FROM worker_configs c JOIN workers w ON w.id=c.worker_id
        WHERE w.id=${workerId}::uuid AND (w.owner_user_id IS NULL OR w.owner_user_id=${owner}::uuid)
          AND w.archived_at IS NULL AND w.revoked_at IS NULL`.pipe(
        Effect.map((rows) => rows[0] && BigInt(rows[0].version)),
      ),
    ),
  );
}

function supportProblem(
  connection: WorkerConnection,
  version: bigint | undefined,
  provider: Provider,
  profileId: string,
  binding: SandboxProfileBinding,
) {
  if (!connection.hello.capabilities.includes(SANDBOX_PROFILES_CAPABILITY))
    return "This worker requires an update to use sandbox profiles.";
  const report = connection.sandboxConfigReport;

  if (version === undefined) return INSTANCE_UNAVAILABLE;

  if (!report || report.version !== version) return CONFIG_PENDING;

  if (!report.applied || !report.providers.some((p) => p.provider === provider && p.available))
    return INSTANCE_UNAVAILABLE;
  const instance = report.profiles.find((p) => p.id === (profileId || "native") && p.providers.includes(provider));

  return instance?.available ? sandboxSupportProblem(instance.sandboxSupport, binding) : INSTANCE_UNAVAILABLE;
}

export async function checkSandboxPlacement(
  core: GatewayCore,
  workerId: string,
  provider: Provider,
  profileId: string,
  binding: SandboxProfileBinding,
) {
  const connection = core.link.connections.get(workerId);

  if (!connection?.isOpen) throw new InvalidError(WORKER_OFFLINE);
  const version = await configuredWorkerVersion(core, workerId, core[coreState].options.userId);

  if (core.link.connections.get(workerId) !== connection || !connection.isOpen) throw new InvalidError(WORKER_OFFLINE);

  if (version === undefined) throw new InvalidError(INSTANCE_UNAVAILABLE);
  const problem = supportProblem(connection, version, provider, profileId, binding);

  if (problem) throw new InvalidError(problem);

  return version;
}

export async function ownerSandboxBinding(core: GatewayCore, id: string, digest = ""): Promise<SandboxProfileBinding> {
  const catalog = await coreSettings(core, (s) => s.user(core[coreState].options.userId));
  const profile = catalog.sandboxProfiles?.profiles.find((candidate) => candidate.id === id);

  if (!profile) throw new InvalidError(digest ? DRAFT_SANDBOX_RESELECT : "Choose an available sandbox profile.");
  const binding = sandboxBinding(profile);

  if (digest && binding.digest !== digest) throw new InvalidError(DRAFT_SANDBOX_RESELECT);

  return binding;
}

export function commandThreadSpec(command: Command) {
  if (command.kind.case !== "createThread" && command.kind.case !== "startTurn") return undefined;
  const value = command.kind.value;

  return value.profiledThread?.thread ?? value.thread;
}

/** false means this connection has yet to report its current configuration. */
export async function threadCommandCheck(core: GatewayCore, connection: WorkerConnection, command: Command) {
  const { kind } = command;

  if (
    kind.case !== "createThread" &&
    kind.case !== "startTurn" &&
    kind.case !== "steerTurn" &&
    kind.case !== "setGoal" &&
    kind.case !== "rewindThread"
  )
    return;
  const spec = commandThreadSpec(command);

  const threadId =
    kind.case === "createThread" || kind.case === "startTurn"
      ? spec?.threadId
      : kind.case === "rewindThread"
        ? kind.value.thread?.threadId
        : kind.value.threadId;

  if (!threadId) return;

  const placement = spec ?? (kind.case === "rewindThread" || kind.case === "setGoal" ? kind.value.thread : undefined);
  const compatible = connection.hello.capabilities.includes(THREAD_WORKTREE_SWITCH_CAPABILITY);

  const row = await core[coreState].actions.run(
    Effect.flatMap(SqlClient.SqlClient, (sql) =>
      sql<
        Pick<ThreadRow, "settings" | "owner_user_id" | "worker_id" | "provider" | "provider_profile_id" | "cwd"> & {
          switched: boolean;
          startedInSource: boolean;
        }
      >`
        SELECT settings,owner_user_id,worker_id,provider,provider_profile_id,cwd,
          CASE WHEN ${!compatible} OR cwd IS DISTINCT FROM coalesce(${placement?.cwd ?? null}::text,cwd)
            THEN EXISTS (SELECT 1 FROM turns WHERE thread_id=${threadId}::uuid AND worktree_switch_source_cwd IS NOT NULL)
            ELSE false END AS switched,
          ${
            kind.case === "startTurn" && placement
              ? sql`CASE WHEN cwd <> ${placement.cwd} THEN EXISTS (
            SELECT 1 FROM turns WHERE thread_id=${threadId}::uuid AND id=${kind.value.turnId}::uuid
              AND worktree_switch_source_cwd=${placement.cwd}) ELSE false END`
              : sql`false`
          } AS "startedInSource"
        FROM threads WHERE id=${threadId}::uuid`.pipe(Effect.map((rows) => rows[0])),
    ),
  );

  if (!row) return false;
  const binding = threadSandbox(row);
  const profiled = kind.case === "createThread" || kind.case === "startTurn" ? kind.value.profiledThread : undefined;

  const refusal = (message: string, errorCode = "SANDBOX_PROFILE_UNAVAILABLE") =>
    create(CommandResultSchema, { commandId: command.commandId, errorCode, errorMessage: message });

  if (row.switched && placement && placement.cwd !== row.cwd) {
    // A switch proves creation and the original StartTurn already ran, even if their ACK got lost.
    if (kind.case === "createThread" || row.startedInSource)
      return create(CommandResultSchema, { commandId: command.commandId, ok: true });

    return refusal("The thread switched worktrees before this command ran.", "WORKTREE_CHANGED");
  }

  if (row.switched && !compatible)
    return refusal("Update this worker to resume the thread in its current worktree.", "WORKTREE_SWITCH_UNSUPPORTED");

  if (!binding) return profiled && refusal("This command's sandbox profile no longer matches the saved thread.");

  if (kind.case === "steerTurn")
    return kind.value.input?.shellCommand !== undefined
      ? refusal(SANDBOX_SHELL_UNAVAILABLE, "SHELL_SANDBOX_UNSUPPORTED")
      : refusal(SANDBOX_STEER_UNAVAILABLE, "SANDBOX_STEER_UNSUPPORTED");

  if (
    !spec ||
    !profiled?.binding ||
    profiled.binding.digest !== binding.digest ||
    row.worker_id !== connection.workerId ||
    spec.provider !== providerOf(row.provider) ||
    (spec.providerProfileId || "native") !== (row.provider_profile_id || "native")
  )
    return refusal("This command cannot enforce the thread's saved sandbox profile.");

  if (
    spec.permissionMode !== PermissionMode.FULL_AUTO ||
    (kind.case === "startTurn" && kind.value.permissionMode !== PermissionMode.FULL_AUTO)
  )
    return refusal(SANDBOX_MODE_REQUIRED);

  if (kind.case === "startTurn" && kind.value.input?.shellCommand !== undefined)
    return refusal(SANDBOX_SHELL_UNAVAILABLE, "SHELL_SANDBOX_UNSUPPORTED");

  const version = await configuredWorkerVersion(core, connection.workerId, row.owner_user_id);
  const problem = supportProblem(connection, version, spec.provider, spec.providerProfileId, binding);

  if (problem === CONFIG_PENDING || !connection.isOpen || core.link.connections.get(connection.workerId) !== connection)
    return false;

  return problem ? refusal(problem) : undefined;
}
