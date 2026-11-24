import { statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { ProviderConfigurationMode } from "@canopy/contracts";
import { instanceShadowHome } from "../../config/homes.ts";
import { providerHomeProblem } from "../home-paths.ts";
import type { ProfileRuntimeConfig, ProfileUserConfiguration } from "../profiles.ts";

const ISOLATED: ProfileUserConfiguration = {
  mode: ProviderConfigurationMode.ISOLATED,
  sourcePath: "",
  instructions: false,
  skills: false,
  hooks: false,
};

export function claudeUserConfiguration(runtime: ProfileRuntimeConfig | undefined): ProfileUserConfiguration {
  const policy = runtime?.userConfiguration;

  return policy
    ? {
        ...policy,
        mode: policy.mode === ProviderConfigurationMode.UNSPECIFIED ? ProviderConfigurationMode.ISOLATED : policy.mode,
      }
    : { ...ISOLATED };
}

/** Expansion belongs to the worker; named users and other relative paths are not supported. */
export function providerConfigurationPath(path: string, userHome = homedir()): string {
  const trimmed = path.trim();

  if (!trimmed || trimmed.length > 1024 || /[\0\r\n]/.test(trimmed))
    throw new Error("Choose a valid provider configuration directory.");

  if (trimmed === "~") return resolve(userHome);

  if (trimmed.startsWith("~/") || trimmed.startsWith("~\\"))
    return resolve(userHome, ...trimmed.slice(2).split(/[\\/]/));

  if (!isAbsolute(trimmed)) throw new Error("Choose an absolute provider directory or a path starting with ~/.");

  return resolve(trimmed);
}

export function userConfigurationProblem(harness: string, runtime: ProfileRuntimeConfig | undefined) {
  const policy = claudeUserConfiguration(runtime);

  if (
    ![ProviderConfigurationMode.ISOLATED, ProviderConfigurationMode.LOCAL, ProviderConfigurationMode.SHARED].includes(
      policy.mode,
    )
  )
    return "Choose an isolated, local, or shared user configuration.";

  if (
    harness === "antigravity" &&
    (policy.mode !== ProviderConfigurationMode.ISOLATED ||
      policy.sourcePath ||
      policy.instructions ||
      policy.skills ||
      policy.hooks)
  )
    return "Antigravity requires isolated configuration. Clear the local CLI configuration options.";

  if (harness === "codex" && policy.mode === ProviderConfigurationMode.SHARED) {
    if (policy.sourcePath || policy.instructions || policy.skills || policy.hooks)
      return "Codex uses the CLI home path. Clear the Claude configuration options.";

    return undefined;
  }

  if (harness !== "claude" && policy.mode !== ProviderConfigurationMode.ISOLATED)
    return harness === "codex"
      ? "Choose Isolated or Use CLI home for Codex."
      : "Choose isolated configuration for Grok.";

  try {
    if (policy.sourcePath) providerConfigurationPath(policy.sourcePath);
  } catch (error) {
    return error instanceof Error ? error.message : "Choose a valid user configuration directory.";
  }

  return undefined;
}

/** Shared sessions use the source directly; preparation and managed files always use a private home. */
export function claudeConfigurationHomes(
  dataDir: string,
  id: string,
  runtime: ProfileRuntimeConfig | undefined,
  deviceHome: string,
  userHome = homedir(),
) {
  const userConfiguration = claudeUserConfiguration(runtime);

  const sourceHome = userConfiguration.sourcePath
    ? providerConfigurationPath(userConfiguration.sourcePath, userHome)
    : resolve(deviceHome);

  const privatePath = instanceShadowHome(dataDir, "claude", id, runtime) ?? join(dataDir, "claude-home");
  const platformHome = resolve(privatePath);

  return {
    userConfiguration,
    sourceHome,
    platformHome,
    home: userConfiguration.mode === ProviderConfigurationMode.SHARED ? sourceHome : platformHome,
  };
}

/** Missing source directories may be created by the CLI when it first stores state. */
export function claudeConfigurationHomeProblem(
  homes: ReturnType<typeof claudeConfigurationHomes>,
  loginSource: string,
  deviceHome: string,
) {
  const loginProblem = providerHomeProblem(homes.platformHome, loginSource, deviceHome);

  if (loginProblem) return loginProblem;

  if (homes.userConfiguration.mode === ProviderConfigurationMode.ISOLATED) return undefined;
  const overlap = providerHomeProblem(homes.platformHome, homes.sourceHome);

  if (overlap)
    return "Cannot use this user configuration directory with the private home. Check their paths and permissions.";

  try {
    if (!statSync(homes.sourceHome).isDirectory())
      return "The user configuration source is not a directory. Choose another directory.";
  } catch (error) {
    if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT")
      return "Cannot read the user configuration directory. Check its path and permissions.";
  }

  return undefined;
}
