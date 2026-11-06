import { PermissionMode, type bots } from "@canopy/contracts";
import { Invalid } from "../store/store.ts";

const modes = {
  read_only: PermissionMode.READ_ONLY,
  ask: PermissionMode.ASK,
  accept_edits: PermissionMode.ACCEPT_EDITS,
  full_auto: PermissionMode.FULL_AUTO,
};

const rank = [PermissionMode.READ_ONLY, PermissionMode.ASK, PermissionMode.ACCEPT_EDITS, PermissionMode.FULL_AUTO];

/** Explicit model requests can narrow, never raise, the owner's selected mode. */
export function requestedThreadPermission(
  config: bots.BotConfiguration,
  requested = "",
  userDefault = PermissionMode.ASK,
) {
  const cap = botThreadPermission(config, userDefault);

  if (!requested) return cap;
  const mode = Object.entries(modes).find(([name]) => name === requested)?.[1];

  if (!mode) throw new Invalid("Unknown thread permission. Choose a supported permission mode.");

  return rank.indexOf(mode) > rank.indexOf(cap) ? cap : mode;
}

/** Owner-selected default. Models cannot edit this setting or select Full access. */
export function botThreadPermission(config: bots.BotConfiguration, userDefault = PermissionMode.ASK): PermissionMode {
  switch (config.threadPermission) {
    case "user_default":
      return userDefault === PermissionMode.FULL_ACCESS ? PermissionMode.FULL_AUTO : userDefault || PermissionMode.ASK;
    case "read_only":
      return PermissionMode.READ_ONLY;
    case "accept_edits":
      return PermissionMode.ACCEPT_EDITS;
    case "full_auto":
      return PermissionMode.FULL_AUTO;
    case "ask":
      return PermissionMode.ASK;
    default:
      return config.approvalPolicy === "full_auto" ? PermissionMode.FULL_AUTO : PermissionMode.ASK;
  }
}
