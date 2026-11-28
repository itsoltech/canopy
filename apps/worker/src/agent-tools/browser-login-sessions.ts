import { join } from "node:path";
import {
  configureLoginAccess,
  configureLoginMarkers,
  forgetSessionLogins,
  hasSessionState,
  markedSessions,
  sessionMarked,
  type BrowserLoginAccess,
} from "./browser-logins.ts";
import { browserSessionQueue } from "./browser-session.ts";
import { serializeAgentTool } from "./queue.ts";
import { agentToolSession } from "./scope.ts";

/** Worker memory of project login leases (runtime/thread-secrets.ts). */
export interface ProjectLoginStore {
  readProjectLogin(threadId: string, turnId: string, requestId: string): string | undefined;
  rememberBrowserValues(threadId: string, values: readonly string[]): void;
  forgetBrowserValues(threadId: string): void;
}

/** The thread's leased logins and output masking, for its browser session. */
export function loginAccess(
  store: (() => ProjectLoginStore) | undefined,
  threadId: string,
): BrowserLoginAccess | undefined {
  if (!store || agentToolSession(threadId) !== threadId) return undefined;

  return {
    read: (turnId, requestId) => store().readProjectLogin(threadId, turnId, requestId),
    remember: (values) => store().rememberBrowserValues(threadId, values),
    forget: () => store().forgetBrowserValues(threadId),
  };
}

export function configureBrowserLogins(dataDir: string, store: (() => ProjectLoginStore) | undefined): void {
  configureLoginMarkers(join(dataDir, "browser-logins"));
  // A thread's browser session is named after the thread.
  configureLoginAccess((session) => loginAccess(store, session));
}

/**
 * Close browsers that may hold login values while their guard still runs: at shutdown every one, at startup
 * those a crashed worker left (this process holds no state for them).
 */
export async function closeLoginBrowsers(
  close: (session: string) => Promise<void>,
  orphanedOnly: boolean,
): Promise<void> {
  const failures: Error[] = [];

  // Each session on its own: one that cannot be confirmed closed keeps its marker for the next attempt.
  for (const session of markedSessions()) {
    try {
      // The session's own queue orders this with the agent's calls, which retire or reopen it themselves.
      await serializeAgentTool(browserSessionQueue(session), async () => {
        if (!sessionMarked(session) || (orphanedOnly && hasSessionState(session))) return;
        await close(session);
        forgetSessionLogins(session);
      });
    } catch (error) {
      failures.push(error instanceof Error ? error : new Error("A browser holding login values did not close"));
    }
  }

  if (failures.length) throw new AggregateError(failures, "Some browsers holding login values did not close");
}
