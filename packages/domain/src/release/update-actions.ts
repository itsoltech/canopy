import { CliInstallMethod, type ui } from "@canopy/contracts";

/** Bulk updates leave installed CLIs owned by package managers to those managers. */
export const cliManagedExternally = (item: ui.WorkerCliTool): boolean =>
  !!item.tool &&
  ![CliInstallMethod.NATIVE, CliInstallMethod.NOT_INSTALLED, CliInstallMethod.UNSPECIFIED].includes(item.tool.method);

export const cliUpdateActionable = (item: ui.WorkerCliTool): boolean =>
  item.tool?.method === CliInstallMethod.NATIVE &&
  item.tool.installable &&
  item.action === "update" &&
  !item.blockedReason.includes("owner");
