import { create } from "@bufbuild/protobuf";
import {
  PermissionMode,
  Provider,
  SandboxSupportSchema,
  type Command,
  type ProfiledThread,
  type ThreadSpec,
} from "@canopy/contracts";
import { sandboxBinding, sandboxSupportProblem } from "@canopy/domain/sandbox-profiles";
import { CommandError, type CommandResultInit } from "./host-types.ts";
import { sandboxSupport } from "../providers/sandbox-support.ts";
import { providersOf, type ProfileStatus } from "../providers/profiles.ts";

function profiledSpec(envelope: ProfiledThread, legacy: ThreadSpec | undefined): ThreadSpec {
  const { thread, binding } = envelope;

  if (legacy || !thread || thread.sandboxProfile || !binding?.profile)
    throw new CommandError("SANDBOX_PROFILE_INVALID", "The thread has an invalid sandbox profile binding.", true);

  if (thread.permissionMode !== PermissionMode.FULL_AUTO)
    throw new CommandError("SANDBOX_PROFILE_INVALID", "Choose Sandbox to use a custom sandbox profile.", true);

  if (thread.provider !== Provider.CLAUDE && thread.provider !== Provider.CODEX)
    throw new CommandError(
      "SANDBOX_PROFILE_UNAVAILABLE",
      "This harness does not support custom sandbox profiles.",
      true,
    );

  const canonical = sandboxBinding(binding.profile);

  if (canonical.digest !== binding.digest)
    throw new CommandError("SANDBOX_PROFILE_INVALID", "The sandbox profile snapshot could not be verified.", true);

  return { ...thread, sandboxProfile: canonical };
}

function decodeSandboxCommand(command: Command): Command {
  const kind = command.kind;

  if (kind.case !== "createThread" && kind.case !== "startTurn") return command;

  if (!kind.value.profiledThread) {
    if (kind.value.thread?.sandboxProfile)
      throw new CommandError("SANDBOX_PROFILE_INVALID", "The sandbox profile was sent in an unsupported format.", true);

    return command;
  }

  const thread = profiledSpec(kind.value.profiledThread, kind.value.thread);

  if (kind.case === "createThread") return { ...command, kind: { case: kind.case, value: { ...kind.value, thread } } };

  const { input, permissionMode } = kind.value;

  if ((permissionMode && permissionMode !== PermissionMode.FULL_AUTO) || input?.shellCommand !== undefined)
    throw new CommandError(
      "SANDBOX_PROFILE_INVALID",
      "A turn with a custom sandbox profile must use Sandbox and cannot run a direct composer shell command.",
      true,
    );

  return { ...command, kind: { case: kind.case, value: { ...kind.value, thread } } };
}

/** Only the fail-closed wire envelope may introduce a custom policy at the worker. */
export function normalizeSandboxCommand(command: Command): { command: Command } | { failure: CommandResultInit } {
  try {
    return { command: decodeSandboxCommand(command) };
  } catch (error) {
    return {
      failure: {
        commandId: command.commandId,
        ok: false,
        errorCode: error instanceof CommandError ? error.code : "SANDBOX_PROFILE_INVALID",
        errorMessage: error instanceof CommandError ? error.message : "The sandbox profile could not be verified.",
      },
    };
  }
}

export function requireSandboxSupport(command: Command, profiles: readonly ProfileStatus[] | undefined) {
  const kind = command.kind;

  if (kind.case !== "createThread" && kind.case !== "startTurn") return;
  const spec = kind.value.thread;

  if (!spec?.sandboxProfile) return;
  const harness = spec.provider === Provider.CLAUDE ? "claude" : "codex";

  const status = profiles?.find(
    (profile) =>
      profile.config.id === (spec.providerProfileId || "native") && providersOf(profile.config).includes(harness),
  );

  const support = status && create(SandboxSupportSchema, sandboxSupport(spec.provider, status));
  const problem = sandboxSupportProblem(support, spec.sandboxProfile);

  if (problem) throw new CommandError("SANDBOX_PROFILE_UNAVAILABLE", problem, true);
}
