import { projectTools } from "./projects.ts";
import { workerTools } from "./workers.ts";
import { providerTools } from "./providers.ts";
import { threadTools } from "./threads.ts";
import { scheduleTools } from "./schedules.ts";
import { settingsTools } from "./settings.ts";
import { botTools } from "./bots.ts";

/** Grouped in the model's catalogue; a single allowlisted descriptor owns dispatch and status. */
export const areaTools = [...projectTools, ...workerTools, ...providerTools, ...threadTools, ...scheduleTools, ...settingsTools, ...botTools];
export const areaTool = new Map(areaTools.map((t) => [t.spec.name, t]));
