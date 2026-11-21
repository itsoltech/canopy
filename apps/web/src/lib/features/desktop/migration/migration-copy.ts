import type { DesktopMigrationStatus } from "@canopy/ui/desktop";

export const progressTitle: Partial<Record<DesktopMigrationStatus["phase"], string>> = {
  preparing: "Running migration trial…",
  draining: "Waiting for active work to finish…",
  fenced: "Preparing the final snapshot…",
  activating: "Activating the server…",
  switching: "Connecting this computer to the server…",
};

const kindNames = new Map(
  Object.entries({
    agent: "Agent",
    agents: "Agents",
    attachments: "Attachments",
    bot: "Bot",
    bots: "Bots",
    connector_accounts: "Connector accounts",
    connector_oauth_apps: "Connector sign-in apps",
    github_accounts: "GitHub accounts",
    messenger_accounts: "Messenger accounts",
    move: "Computer move",
    project_settings: "Project settings",
    projects: "Projects",
    provider_instances: "Provider instances",
    proxies: "Proxies",
    schedule: "Schedule",
    schedules: "Schedules",
    secrets: "Secrets",
    thread: "Thread",
    threads: "Threads",
    thread_secrets: "Thread secrets",
    user_settings: "User settings",
    worker: "Worker",
    workers: "Workers",
    worker_config_secrets: "Worker secrets",
  }),
);

export function reviewKind(table: string): string {
  return kindNames.get(table) ?? "Canopy records";
}

const blockerText = new Map(
  Object.entries({
    active_work: "Active work must finish first.",
    worker_unavailable: "Reconnect or replace the assigned worker before running a new trial.",
    leased: "A scheduled run is still active.",
    unfinished_move: "Finish or cancel this computer move before running a new trial.",
    commands_pending: "Wait for this worker to finish its pending commands.",
    ambiguous_configuration_identity:
      "More than one server item matches this item. Ask the server administrator to check the matches.",
    target_row_identity_collision:
      "A different server item already uses this ID. Ask the server administrator to check it.",
  }),
);

export function reviewBlocker(reason: string): string {
  if (reason.startsWith("unmapped_reference:"))
    return "An item this record needs is missing from the import and the server.";

  if (reason.startsWith("reference_to_another_owner:"))
    return "This item refers to data owned by another Canopy account.";

  return blockerText.get(reason) ?? "This item needs attention before the import can continue.";
}
