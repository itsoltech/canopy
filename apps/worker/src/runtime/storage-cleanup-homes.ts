import { Provider } from "@canopy/contracts";
import { Effect } from "effect";
import { isAbsolute, resolve } from "node:path";
import { Journal, type StorageCleanupGrant } from "../journal/index.ts";
import { antigravitySessionRoot } from "../providers/antigravity/home.ts";
import { providersOf } from "../providers/profiles.ts";
import type { HostContext } from "./host-context.ts";

type CleanupScope = Omit<StorageCleanupGrant, "homePath">;

/** A thread's pinned store is authoritative even after its profile changed or disappeared. */
export async function cleanupHome(ctx: HostContext, scope: CleanupScope): Promise<string> {
  const state = ctx.state;

  if (scope.provider === Provider.ANTIGRAVITY)
    return antigravitySessionRoot(state.options.dataDir, scope.providerProfileId);

  if (scope.provider === Provider.CLAUDE)
    return state.options.runtime.runPromise(
      Journal.use((journal) =>
        Effect.gen(function* () {
          const bound = yield* journal.claudeSessionHome(scope.threadId);
          const imported = new Set<string>();

          for (const id of scope.providerThreadIds) {
            const home = yield* journal.claudeImportedSessionHome(scope.providerProfileId, id);

            if (home) {
              if (!isAbsolute(home)) return "";
              imported.add(resolve(home));
            }
          }

          if (bound && isAbsolute(bound) && [...imported].every((home) => home === resolve(bound)))
            return resolve(bound);

          if (!bound && imported.size === 1) return imported.values().next().value ?? "";

          return "";
        }),
      ),
    );

  const name = scope.provider === Provider.CODEX ? "codex" : "grok";

  if (
    !state.config?.profiles.some(
      (profile) => profile.config.id === scope.providerProfileId && providersOf(profile.config).includes(name),
    )
  )
    return "";

  return scope.provider === Provider.CODEX
    ? state.codexHome(scope.providerProfileId)
    : state.grokSessions(scope.providerProfileId);
}

/** Old grants may predate the binding. Never let their current-profile snapshot choose another Claude store. */
export async function validatedCleanupHome(ctx: HostContext, grant: StorageCleanupGrant): Promise<string> {
  if (grant.provider !== Provider.CLAUDE) return grant.homePath;
  const bound = await cleanupHome(ctx, grant);

  return bound && isAbsolute(grant.homePath) && resolve(grant.homePath) === bound ? bound : "";
}
