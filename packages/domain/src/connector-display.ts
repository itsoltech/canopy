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
    allWorkers: boolean;
    workerIds: readonly string[];
    allBots: boolean;
    botIds: readonly string[];
  },
  modules: readonly ModuleId[] = enabledModules(),
): string {
  const workers = account.allWorkers
    ? "All workers"
    : `${account.workerIds.length} ${account.workerIds.length === 1 ? "worker" : "workers"}`;

  const bots = account.allBots
    ? "All bots"
    : `${account.botIds.length} ${account.botIds.length === 1 ? "bot" : "bots"}`;

  return modules.map((id) => (id === "threads" ? workers : bots)).join(" · ");
}
