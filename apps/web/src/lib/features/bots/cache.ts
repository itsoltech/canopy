import { BotViewCache } from "@canopy/domain/bot-cache";

/** Browser-only SPA lifetime; never persisted or shared by the BFF between owners. */
export const botCache = new BotViewCache();
