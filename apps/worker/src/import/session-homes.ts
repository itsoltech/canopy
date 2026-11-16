import { Effect } from "effect";
import { mkdirSync } from "node:fs";
import type { Journal } from "../journal/index.ts";
import { requireClaudeSessionHome } from "../providers/claude/session-home.ts";
import type { ImportHomesForProfiles } from "./adopt.ts";

/** Resolve copies by their recorded destination, including before a Canopy thread exists. */
export function durableImportHomes(journal: Journal["Service"], homes: ImportHomesForProfiles, adopting: boolean) {
  return {
    codexHome: (profileId: string) => homes.codexHome(profileId),
    grokSessions: (profileId: string) => homes.grokSessions(profileId),
    claudeHome: (profileId: string, sessionId?: string) => {
      if (!sessionId) return homes.claudeHome(profileId);
      const existing = Effect.runSync(journal.claudeImportedSessionHome(profileId, sessionId));

      if (existing) {
        if (adopting) requireClaudeSessionHome(existing);

        return existing;
      }

      const current = homes.claudeHome(profileId);

      if (adopting) mkdirSync(current, { recursive: true, mode: 0o700 });

      return adopting ? Effect.runSync(journal.bindClaudeImportedSessionHome(profileId, sessionId, current)) : current;
    },
  };
}
