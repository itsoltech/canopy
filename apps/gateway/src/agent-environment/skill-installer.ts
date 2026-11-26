import { Code, ConnectError } from "@connectrpc/connect";
import type { ui } from "@canopy/contracts";
import { isUuid } from "@canopy/domain/humanize";
import { SKILL_INSTALLER_CAPABILITY } from "@canopy/domain/release/protocol";
import { validateSkillFiles } from "@canopy/domain/skill-artifact";
import { coreRun } from "../core/core-broadcast.ts";
import type { GatewayCore } from "../core/core.ts";

const actions = new Set(["start", "read", "write", "cancel", "collect", "close"]);

/** Owner-only terminal traffic stays on this gateway's live worker link. */
export async function runSkillInstaller(core: GatewayCore, request: ui.RunSkillInstallerRequest) {
  const { workerId, installer } = request;
  const owner = core.environment.options.userId;

  if (!isUuid(workerId) || !(await coreRun(core, (store) => store.ownsWorker(workerId, owner))))
    throw new ConnectError("Computer not found. Choose one of your computers.", Code.NotFound);

  if (!installer || !isUuid(installer.sessionId) || !actions.has(installer.action))
    throw new ConnectError("Invalid installer session. Open a new terminal.", Code.InvalidArgument);

  if (installer.action === "start" && (!installer.command.trim() || installer.command.includes("\0")))
    throw new ConnectError("Enter a valid installer command.", Code.InvalidArgument);

  if (installer.command.length > 4096 || installer.skillPath.length > 4096 || installer.input.length > 64 * 1024)
    throw new ConnectError("Installer request is too large. Shorten it and try again.", Code.InvalidArgument);

  const connection = core.link.connections.get(workerId);

  if (!connection?.isOpen) throw new ConnectError("The computer is offline. Reconnect and retry.", Code.Unavailable);

  if (!connection.hello.capabilities.includes(SKILL_INSTALLER_CAPABILITY))
    throw new ConnectError("This computer does not support the installer terminal.", Code.FailedPrecondition);

  const result = await connection.sendCommand({ case: "skillInstaller", value: installer }, 12_000);

  if (!result.ok)
    throw new ConnectError(result.errorMessage || "The installer request failed. Try again.", Code.FailedPrecondition);

  const terminal = result.skillInstaller;

  if (!terminal || terminal.sessionId !== installer.sessionId)
    throw new ConnectError("The computer returned an invalid installer session.", Code.FailedPrecondition);

  if (terminal.artifact) {
    try {
      terminal.artifact = validateSkillFiles(terminal.artifact.files);
    } catch {
      throw new ConnectError("The installed folder is not a valid skill. Check its files.", Code.FailedPrecondition);
    }
  }

  return terminal;
}
