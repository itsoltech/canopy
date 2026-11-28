import type { AgentPreviewLogin } from "@canopy/contracts";
import { retireOrphanedSession, sessionLogins } from "../agent-tools/browser-logins.ts";
import {
  attachActiveTab,
  browserCommand,
  browserEndpoint,
  browserSessionQueue,
} from "../agent-tools/browser-session.ts";
import { serializeAgentTool } from "../agent-tools/queue.ts";
import type { PreviewRuntime } from "./runtime.ts";

/** The session's own agent-browser commands: they outlive this preview, as the login protection does. */
function sessionCommand(runtime: PreviewRuntime) {
  return browserCommand(runtime.executable, runtime.env, runtime.scope.session);
}

/** A browser that held login values before this worker started closes before Preview shows it. */
export async function retireOrphanedPreview(runtime: PreviewRuntime, signal: AbortSignal): Promise<void> {
  const session = runtime.scope.session;

  await serializeAgentTool(browserSessionQueue(session), () =>
    retireOrphanedSession(session, sessionCommand(runtime), signal),
  );
}

/**
 * The owner fills a login field in Browser Preview. Canopy writes it into the focused field itself, only when
 * Chrome reports that field's frame on one of the login's websites, and keeps the value masked and guarded.
 */
export async function previewLoginText(
  login: AgentPreviewLogin,
  runtime: PreviewRuntime,
  signal: AbortSignal,
): Promise<void> {
  const command = sessionCommand(runtime);
  const session = runtime.scope.session;

  // A capture of the agent's must not see the field between its masking and its screenshot. The session state
  // is read in the queue: a close and reopen queued earlier replace it.
  await serializeAgentTool(browserSessionQueue(session), () =>
    sessionLogins(session, (endpointSignal) => browserEndpoint(command, endpointSignal)).previewFill(
      (pageSignal) => attachActiveTab(command, pageSignal),
      login,
      signal,
    ),
  );
}
