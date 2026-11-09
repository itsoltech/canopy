import { EnvironmentState } from "#lib/features/agent-environment/environment-state.svelte.ts";

/**
 * Workers and worker details share the tab's environment read: the library changes and worker reports that
 * change its status invalidate it once (AppShell), not every worker broadcast.
 */
export function workerEnvironment(): EnvironmentState {
  return new EnvironmentState();
}
