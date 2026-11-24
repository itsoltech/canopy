import { posix, win32 } from "node:path";
import { create, toJson } from "@bufbuild/protobuf";
import {
  ProviderConfigurationMode,
  ProviderUserConfigurationSchema,
  type ProviderUserConfiguration,
} from "@canopy/contracts";

/** Runtime JSON uses numeric enums; worker_configs uses protobuf JSON enum names. */
export type StoredUserConfiguration = Pick<
  ProviderUserConfiguration,
  "mode" | "sourcePath" | "instructions" | "skills" | "hooks"
>;

function normalizeUserConfiguration(value: StoredUserConfiguration): StoredUserConfiguration {
  return {
    mode: value.mode || ProviderConfigurationMode.ISOLATED,
    sourcePath: value.sourcePath?.trim() ?? "",
    instructions: value.instructions ?? false,
    skills: value.skills ?? false,
    hooks: value.hooks ?? false,
  };
}

export function userConfigurationProblem(harness: string, value: StoredUserConfiguration): string | undefined {
  const normalized = normalizeUserConfiguration(value);

  if (harness === "antigravity") {
    if (
      normalized.mode !== ProviderConfigurationMode.ISOLATED ||
      normalized.sourcePath ||
      normalized.instructions ||
      normalized.skills ||
      normalized.hooks
    )
      return "Antigravity does not support importing CLI configuration.";

    return undefined;
  }

  if (harness === "codex") {
    if (normalized.mode !== ProviderConfigurationMode.ISOLATED && normalized.mode !== ProviderConfigurationMode.SHARED)
      return "Choose Isolated or Use CLI home for Codex.";

    if (normalized.sourcePath || normalized.instructions || normalized.skills || normalized.hooks)
      return "Codex uses the CLI home path. Clear the Claude configuration options.";

    return undefined;
  }

  if (
    normalized.mode !== ProviderConfigurationMode.ISOLATED &&
    normalized.mode !== ProviderConfigurationMode.LOCAL &&
    normalized.mode !== ProviderConfigurationMode.SHARED
  )
    return "Choose an isolated, local, or shared user configuration.";

  if (harness !== "claude" && normalized.mode !== ProviderConfigurationMode.ISOLATED)
    return "Choose isolated configuration for Grok.";
  const path = normalized.sourcePath;
  const fromHome = path === "~" || path.startsWith("~/") || path.startsWith("~\\");

  if (
    path.length > 1024 ||
    /[\0\r\n]/.test(path) ||
    (path && !posix.isAbsolute(path) && !win32.isAbsolute(path) && !fromHome)
  )
    return "Use an absolute directory path, “~”, or a path starting with “~/” or “~\\”. Leave it empty to use the device CLI directory.";

  return undefined;
}

/** Missing Codex policy inherits. Older gateways also stored unused Claude fields on isolated Codex instances. */
export function storedUserConfiguration(
  harness: string,
  value: StoredUserConfiguration | undefined,
): StoredUserConfiguration | undefined {
  if (!value || (harness === "codex" && !value.mode)) return undefined;

  if (harness === "codex" && value.mode === ProviderConfigurationMode.ISOLATED) {
    return { mode: value.mode, sourcePath: "", instructions: false, skills: false, hooks: false };
  }

  return normalizeUserConfiguration(value);
}

export function userConfigurationMessage(harness: string, value: StoredUserConfiguration | undefined) {
  const stored = storedUserConfiguration(harness, value);

  return stored && create(ProviderUserConfigurationSchema, stored);
}

export const userConfigurationJson = (value: StoredUserConfiguration) =>
  toJson(ProviderUserConfigurationSchema, create(ProviderUserConfigurationSchema, value));
