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

export function normalizeUserConfiguration(value: StoredUserConfiguration): StoredUserConfiguration {
  return {
    mode: value.mode === ProviderConfigurationMode.UNSPECIFIED ? ProviderConfigurationMode.ISOLATED : value.mode,
    sourcePath: value.sourcePath.trim(),
    instructions: value.instructions,
    skills: value.skills,
    hooks: value.hooks,
  };
}

export function userConfigurationProblem(harness: string, value: StoredUserConfiguration): string | undefined {
  const normalized = normalizeUserConfiguration(value);

  if (
    normalized.mode !== ProviderConfigurationMode.ISOLATED &&
    normalized.mode !== ProviderConfigurationMode.LOCAL &&
    normalized.mode !== ProviderConfigurationMode.SHARED
  )
    return "Choose an isolated, local, or shared user configuration.";

  if (harness !== "claude" && normalized.mode !== ProviderConfigurationMode.ISOLATED)
    return "Local and shared user configuration are available only for Claude. Choose isolated configuration.";
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

export const userConfigurationMessage = (value: StoredUserConfiguration | undefined) =>
  value ? create(ProviderUserConfigurationSchema, value) : undefined;

export const userConfigurationJson = (value: StoredUserConfiguration) =>
  toJson(ProviderUserConfigurationSchema, create(ProviderUserConfigurationSchema, value));
