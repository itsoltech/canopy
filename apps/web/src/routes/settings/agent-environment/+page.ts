import { ui } from "@canopy/contracts";
import { loadShared } from "#lib/shared/load-json.ts";
import type { PageLoad } from "./$types";

export const load: PageLoad = async ({ fetch }) => ({
  environment: await loadShared(
    fetch,
    "GetAgentEnvironment",
    ui.AgentEnvironmentSnapshotSchema,
    "/api/agent-environment",
  ),
});
