import { projectTools } from "./projects.ts";
import { workerTools } from "./workers.ts";
import { providerTools } from "./providers.ts";
import { threadTools } from "./threads.ts";
import { scheduleTools } from "./schedules.ts";
import { settingsTools } from "./settings.ts";
import { createBotTool } from "./create-bot.ts";
import { reactToMessage } from "./reactions.ts";
import { routineTools } from "./routines.ts";
import { attachmentTools } from "./attachments.ts";
import { workspaceTools } from "./workspace.ts";
import { outgoingFileTools } from "./outgoing-files.ts";
import { messengerTools } from "./messengers.ts";
import { canopyReleaseVersions } from "./release-notes.ts";
import { accountPreferenceTools } from "./account-preferences.ts";
import { canopySettingsGuide } from "./settings-guide.ts";

/** Grouped in the model's catalogue; a single allowlisted descriptor owns dispatch and status. */
export const areaTools = [
  ...attachmentTools,
  ...workspaceTools,
  ...outgoingFileTools,
  ...projectTools,
  ...workerTools,
  ...providerTools,
  ...threadTools,
  canopyReleaseVersions,
  canopySettingsGuide,
  ...accountPreferenceTools,
  ...scheduleTools,
  ...settingsTools,
  createBotTool,
  reactToMessage,
  ...routineTools,
  ...messengerTools,
];

export const areaTool = new Map(areaTools.map((t) => [t.spec.name, t]));
