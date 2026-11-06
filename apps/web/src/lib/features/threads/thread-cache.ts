import { ThreadCache } from "@canopy/domain/thread-cache";

/** One SPA and gateway session; never persisted or shared by the BFF between owners. */
export const threadCache = new ThreadCache();
