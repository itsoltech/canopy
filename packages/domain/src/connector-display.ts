import { enabledModules, type ModuleId } from "./modules.ts";

/** Compact account labels shared by settings on web and mobile. */
export function connectorStatus(status: string): string {
  return (
    new Map([
      ["connected", "Connected"],
      ["needs_reconnect", "Needs reconnect"],
      ["error", "Error"],
      ["disconnected", "Disconnected"],
    ]).get(status) ?? status
  );
}

export function connectorAccessSummary(
  account: {
    allProjects?: boolean | undefined;
    projectIds: readonly string[];
    allBots: boolean;
    botIds: readonly string[];
  },
  modules: readonly ModuleId[] = enabledModules(),
): string {
  const projects = account.allProjects
    ? "All projects"
    : `${account.projectIds.length} ${account.projectIds.length === 1 ? "project" : "projects"}`;

  const bots = account.allBots
    ? "All bots"
    : `${account.botIds.length} ${account.botIds.length === 1 ? "bot" : "bots"}`;

  return modules
    .flatMap((id) => {
      if (id === "bots") return [bots];

      return account.allProjects === undefined ? [] : [projects];
    })
    .join(" · ");
}
