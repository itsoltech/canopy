import { join, resolve } from "node:path";
import { ProviderConfigurationMode } from "@canopy/contracts";
import {
  claudeConfigurationHomes,
  claudeConfigurationHomeProblem,
  userConfigurationProblem,
} from "../providers/claude/configuration-homes.ts";
import { providerHomeProblem } from "../providers/home-paths.ts";
import type { ProfileStatus } from "../providers/profiles.ts";
import { instanceShadowHome } from "./homes.ts";
import type { DeviceHomes } from "./remote.ts";

function unavailable(status: ProfileStatus, problem: string): ProfileStatus {
  const { resolved: _, ...rest } = status;

  return { ...rest, problem, authenticated: false };
}

/** A bad configuration directory disables only this instance; probing never changes filesystem state. */
export function inspectProfilePaths(
  status: ProfileStatus,
  harness: "claude" | "codex" | "grok",
  homes: DeviceHomes | undefined,
  linkDeviceLogin: boolean,
): ProfileStatus {
  const runtime = status.config.runtime;
  const policyProblem = userConfigurationProblem(harness, runtime);

  if (policyProblem) return unavailable(status, policyProblem);

  if (!homes || harness === "grok") return status;

  try {
    const privateHome = resolve(
      instanceShadowHome(homes.dataDir, harness, status.config.id, runtime) ?? join(homes.dataDir, `${harness}-home`),
    );

    const loginSource = runtime?.homePath || homes[harness];
    const loginHomePath = runtime?.ownLogin || !linkDeviceLogin ? privateHome : resolve(loginSource);

    if (harness === "claude") {
      const selected = claudeConfigurationHomes(homes.dataDir, status.config.id, runtime, homes.claude);
      const problem = claudeConfigurationHomeProblem(selected, loginSource, homes.claude);

      if (problem) return unavailable(status, problem);

      return {
        ...status,
        loginHomePath,
        configurationHomePath:
          selected.userConfiguration.mode === ProviderConfigurationMode.ISOLATED
            ? selected.platformHome
            : selected.sourceHome,
        sessionHomePath: selected.home,
        privateHomePath: selected.platformHome,
      };
    }

    const problem = providerHomeProblem(privateHome, loginSource, homes.codex);

    if (problem) return unavailable(status, problem);

    return {
      ...status,
      loginHomePath,
      configurationHomePath: privateHome,
      sessionHomePath: privateHome,
      privateHomePath: privateHome,
    };
  } catch {
    return unavailable(status, "Cannot inspect the provider directories. Check their paths and permissions.");
  }
}
