import type { Command } from "@canopy/contracts";
import { Effect } from "effect";
import { adoptImportedSession, removeImportedCopy } from "../import/adopt.ts";
import { durableImportHomes } from "../import/session-homes.ts";
import { Journal } from "../journal/index.ts";
import type { HostContext } from "./host-context.ts";
import type { CommandOutput } from "./host-types.ts";

export function importedCopyCommand(
  ctx: HostContext,
  kind: Extract<Command["kind"], { case: "adoptImportedSession" | "removeImportedCopy" }>,
): Promise<CommandOutput> {
  return ctx.state.options.runtime.runPromise(
    Journal.use((journal) =>
      Effect.sync(() => {
        const homes = durableImportHomes(journal, ctx.state, kind.case === "adoptImportedSession");

        if (kind.case === "adoptImportedSession")
          return { importedSessionId: adoptImportedSession(ctx.state.imports, homes, kind.value) };
        removeImportedCopy(ctx.state.imports, homes, kind.value);

        return {};
      }),
    ),
  );
}
