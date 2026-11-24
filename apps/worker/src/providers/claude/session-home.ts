import { mkdirSync, statSync } from "node:fs";
import { resolve } from "node:path";
import type { ThreadSpec } from "@canopy/contracts";
import { Effect } from "effect";
import type { Journal } from "../../journal/index.ts";

export function requireClaudeSessionHome(home: string): void {
  let available = false;

  try {
    available = statSync(home).isDirectory();
  } catch {
    // A missing or unreadable bound directory must never become a different, empty session home.
  }

  if (!available)
    throw new Error(`The Claude session home is unavailable: ${home}. Restore this directory to resume its history.`);
}

/** Current policy selects a home only once; existing threads and imported copies retain their location. */
export function claudeSessionHomes(journal: Journal["Service"]) {
  const lookup = (threadId: string) => Effect.runPromise(journal.claudeSessionHome(threadId));

  const bind = async (threadId: string, proposed: string, spec?: ThreadSpec): Promise<string> => {
    const existing = await lookup(threadId);

    const imported =
      !existing && spec?.providerThreadId
        ? await Effect.runPromise(journal.claudeImportedSessionHome(spec.providerProfileId, spec.providerThreadId))
        : undefined;

    const retained = existing ?? imported;

    if (retained) requireClaudeSessionHome(retained);
    else {
      const destination = resolve(proposed);

      if (await Effect.runPromise(journal.hasStartedClaudeThread(threadId))) requireClaudeSessionHome(destination);
      else mkdirSync(destination, { recursive: true, mode: 0o700 });
    }

    const home = await Effect.runPromise(journal.bindClaudeSessionHome(threadId, resolve(imported || proposed)));

    // Another admission may already have bound this thread while the lookup was awaiting the journal.
    if (home !== resolve(imported || proposed)) requireClaudeSessionHome(home);

    return home;
  };

  const resume = async (
    spec: ThreadSpec,
    home: string,
    exists: (sessionId: string, home: string) => Promise<boolean>,
  ): Promise<boolean> => {
    const sessionId = spec.providerThreadId || spec.threadId;
    const found = await exists(sessionId, home);

    if (found) {
      await Effect.runPromise(journal.rememberClaudeSession(spec.threadId, sessionId));
    } else {
      const history = await Effect.runPromise(journal.hasClaudeSessionHistory(spec.threadId, sessionId));
      const legacy = history === undefined && (await Effect.runPromise(journal.hasStartedClaudeThread(spec.threadId)));
      const imported = await Effect.runPromise(journal.claudeImportedSessionHome(spec.providerProfileId, sessionId));

      if (history || legacy || imported)
        throw new Error(
          "The Claude session history is unavailable in its bound home. Restore its transcript to resume.",
        );
    }

    return found;
  };

  return { lookup, bind, resume };
}
