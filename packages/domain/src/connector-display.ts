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
    connectorType?: string;
    allProjects?: boolean | undefined;
    projectIds: readonly string[];
    noProject?: boolean | undefined;
    allBots: boolean;
    botIds: readonly string[];
  },
  modules: readonly ModuleId[] = enabledModules(),
): string {
  const projects = account.allProjects
    ? "All projects"
    : `${account.projectIds.length} ${account.projectIds.length === 1 ? "project" : "projects"}`;

  const bot = account.connectorType === "slack" ? "Canopy bot" : "bot";

  const bots = account.allBots
    ? `All ${bot}s`
    : `${account.botIds.length} ${account.botIds.length === 1 ? bot : `${bot}s`}`;

  const threads: string[] = [];

  if (account.noProject) threads.push("No project");

  if (account.allProjects !== undefined && (!account.noProject || account.allProjects || account.projectIds.length))
    threads.push(projects);

  return modules.flatMap((id) => (id === "bots" ? [bots] : threads)).join(" · ");
}
