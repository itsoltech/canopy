import { Provider, type ui } from "@canopy/contracts";
import { isUuid } from "@canopy/domain/humanize";
import { coreState, InvalidError, UnavailableError } from "./core-context.ts";
import { coreRun } from "./core-broadcast.ts";
import { coreInstance } from "./core-providers.ts";
import type { GatewayCore } from "./core.ts";

/** No linked routing and no platform-wide workers: every auth mutation changes a computer's CLI store. */
export async function providerAuthTarget(
  core: GatewayCore,
  request: ui.StartProviderLoginRequest | ui.CompleteProviderLoginRequest | ui.LogoutProviderRequest,
  extended = false,
) {
  const userId = core[coreState].options.userId;

  if (!isUuid(request.workerId) || !(await coreRun(core, (s) => s.ownsWorker(request.workerId, userId))))
    throw new InvalidError("worker not found");
  const instance = await coreInstance(core, request.harness, request.id);

  if (!instance.workers.some((w) => w.workerId === request.workerId && w.enabled))
    throw new InvalidError("Choose an instance enabled on this computer.");
  const connection = core.link.connections.get(request.workerId);

  if (!connection?.isOpen) throw new UnavailableError("The worker is offline. Reconnect, then retry.");

  const capability =
    extended || request.harness !== Provider.CODEX
      ? "provider_cli_auth_v1"
      : instance.runtime?.ownLogin
        ? "codex_device_login"
        : "codex_device_login_linked";

  if (!connection.hello.capabilities.includes(capability))
    throw new InvalidError("This worker cannot manage this login from the app. Update the worker.");

  return { connection, userId };
}
