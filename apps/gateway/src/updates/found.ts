import type { GatewayCore } from "../core/core.ts";
import type { FoundRelease } from "../desktop-updates/control.ts";
import { versionAhead } from "./versions.ts";

const nudged = new WeakMap<GatewayCore, string>();

/**
 * The gateway or one desktop app found a newer Canopy release: every other one on that channel checks its own
 * feed now, once per release, instead of at its next timer. Each still verifies and downloads its own build.
 */
export function releaseFound(core: GatewayCore, release: FoundRelease): void {
  void core.desktopControl.check(release).catch(() => {});
  void checkGateway(core, release).catch(() => {});
}

/** A bundled gateway updates with its app; a standalone one on the same channel checks once unless it knows it. */
async function checkGateway(core: GatewayCore, release: FoundRelease) {
  if (core.role === "desktop" || nudged.get(core) === release.version) return;
  const { channel, gatewayVersion, availableVersion } = await core.updates.snapshot();

  if (channel !== release.channel || !versionAhead(release.version, availableVersion || gatewayVersion)) return;
  nudged.set(core, release.version);
  await core.updates.check();
}
