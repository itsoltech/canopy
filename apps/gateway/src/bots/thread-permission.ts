import { PermissionMode, type bots } from "@canopy/contracts";

/** Only the owner configures access. Missing or old inherited settings use the owner's thread default. */
export function botThreadPermission(config: bots.BotConfiguration, userDefault = PermissionMode.ASK): PermissionMode {
  switch (config.threadPermission) {
    case "read_only":
      return PermissionMode.READ_ONLY;
    case "accept_edits":
      return PermissionMode.ACCEPT_EDITS;
    case "full_auto":
      return PermissionMode.FULL_AUTO;
    case "full_access":
      return PermissionMode.FULL_ACCESS;
    case "ask":
      return PermissionMode.ASK;
    default:
      return userDefault || PermissionMode.ASK;
  }
}
