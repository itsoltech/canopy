import type { Command } from "@canopy/contracts";
import { Effect } from "effect";
import { adoptImportedSession, removeImportedCopy } from "../import/adopt.ts";
import { durableImportHomes } from "../import/session-homes.ts";
import { Journal } from "../journal/index.ts";
import type { HostContext } from "./host-context.ts";
import { CommandError, type CommandOutput } from "./host-types.ts";
import { providersOf } from "../providers/profiles.ts";
import { directCodexHome } from "../providers/codex/home.ts";

export function importedCopyCommand(
  ctx: HostContext,
  kind: Extract<Command["kind"], { case: "adoptImportedSession" | "removeImportedCopy" }>,
): Promise<CommandOutput> {
  return ctx.state.options.runtime.runPromise(
    Journal.use((journal) =>
      Effect.sync(() => {
        const homes = durableImportHomes(journal, ctx.state, kind.case === "adoptImportedSession");

        if (kind.case === "adoptImportedSession") {
          const profile = ctx.state.config?.profiles.find(
            (p) => p.config.id === (kind.value.profileId || "native") && providersOf(p.config).includes("codex"),
          );

          if (
            profile &&
            ctx.state.config &&
            directCodexHome(profile.config, ctx.state.config.codex.linkDeviceLogin, ctx.state.deviceHomes.codex) &&
            ctx.state.imports.agentCliOf(kind.value.sourceKey) === "codex"
          ) {
            // The CLI home can contain an unmasked original with this session ID. Use the importer's history flow.
            throw new CommandError("IMPORT_COPY", "Select Isolated to resume an imported Codex copy natively.", false);
          }

          return { importedSessionId: adoptImportedSession(ctx.state.imports, homes, kind.value) };
        }

        removeImportedCopy(ctx.state.imports, homes, kind.value);

        return {};
      }),
    ),
  );
}
