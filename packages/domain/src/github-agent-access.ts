import type { bots, ui } from "@canopy/contracts";
import { qualifyId, splitId } from "./computers.ts";

interface Option {
  id: string;
  name: string;
}

/** Keep every saved recipient selectable for revocation, even after its catalogue entry disappears. */
function options(available: Option[], granted: readonly string[], removeOnly: boolean): Option[] {
  const names = new Map(available.map((option) => [option.id, option.name]));
  const ids = removeOnly ? granted : new Set([...names.keys(), ...granted]);

  return Array.from(ids, (id) => ({ id, name: names.get(id) ?? splitId(id).id }));
}

export function agentProjectOptions(
  accountId: string,
  projects: readonly ui.Project[],
  granted: readonly string[],
  removeOnly: boolean,
): Option[] {
  const home = splitId(accountId).node;

  const available = projects.flatMap((project) => {
    if (project.kind === "scratch") return [];
    // A shared project can appear once under its local ID, with workspaces on several homes.
    const shared = home && !project.nodeId && project.workspaces.some((w) => splitId(w.workerId).node === home);

    if (!shared && splitId(project.id).node !== home) return [];
    const id = shared ? qualifyId(project.id, home) : project.id;

    return project.archivedAt && !granted.includes(id) ? [] : [{ id, name: project.name }];
  });

  return options(available, granted, removeOnly);
}

export function agentBotOptions(
  accountId: string,
  list: readonly bots.Bot[],
  granted: readonly string[],
  removeOnly: boolean,
): Option[] {
  const home = splitId(accountId).node;

  const available = list.flatMap((bot) =>
    splitId(bot.id).node === home && (!bot.archived || granted.includes(bot.id))
      ? [{ id: bot.id, name: bot.configuration?.name || "Bot" }]
      : [],
  );

  return options(available, granted, removeOnly);
}
