import type { github } from "@canopy/contracts";

export const contextDraft = $state<{ pending?: { threadId: string; context: github.PullRequestContextResponse } }>({});
