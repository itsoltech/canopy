import { projectTools } from "./projects.ts";
import { workerTools } from "./workers.ts";
import { providerTools } from "./providers.ts";
import { threadTools } from "./threads.ts";
import { scheduleTools } from "./schedules.ts";
import { settingsTools } from "./settings.ts";
import { createBotTool } from "./create-bot.ts";
import { routineTools } from "./routines.ts";
import { attachmentTools } from "./attachments.ts";
import { workspaceTools } from "./workspace.ts";

/** Grouped in the model's catalogue; a single allowlisted descriptor owns dispatch and status. */
export const areaTools = [
  ...attachmentTools,
  ...workspaceTools,
  ...projectTools,
  ...workerTools,
  ...providerTools,
  ...threadTools,
  ...scheduleTools,
  ...settingsTools,
  createBotTool,
  ...routineTools,
];

export const areaTool = new Map(areaTools.map((t) => [t.spec.name, t]));
