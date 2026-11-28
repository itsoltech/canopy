import { mkdirSync, realpathSync } from "node:fs";
import { join } from "node:path";
import type { Command, ThreadTransferOperation, ThreadTransferSession } from "@canopy/contracts";
import { Effect } from "effect";
import { durableImportHomes } from "../import/session-homes.ts";
import { Journal } from "../journal/index.ts";
import { directCodexHome } from "../providers/codex/home.ts";
import { providersOf } from "../providers/profiles.ts";
import { transferError } from "../thread-transfer/errors.ts";
import type { ThreadTransferHost, ThreadTransfers } from "../thread-transfer/index.ts";
import type { WorkspaceCopies } from "../workspace-copy/index.ts";
import type { CommandOutput } from "./host-types.ts";
import type { HostContext } from "./host-context.ts";

/**
 * Where this worker keeps the harness sessions a thread transfer exports or adopts (docs/thread-transfers.md):
 * always the worker's own records (journal bindings, instance homes), never a path from the gateway.
 */
export function threadTransferHost(ctx: HostContext): ThreadTransferHost {
  const { state } = ctx;

  const journal = <A>(use: (j: Journal["Service"]) => Effect.Effect<A, unknown>) =>
    state.options.runtime.runPromise(Journal.use(use));

  const profileOf = (session: ThreadTransferSession, harness: "claude" | "codex") => {
    const id = session.profileId || "native";
    const profile = state.config?.profiles.find((p) => p.config.id === id && providersOf(p.config).includes(harness));

    if (!profile) throw transferError("The chosen provider instance is not available on this worker.");

    return profile.config;
  };

  const cliHome = (session: ThreadTransferSession) => {
    const config = state.config;

    return config
      ? directCodexHome(profileOf(session, "codex"), config.codex.linkDeviceLogin, state.deviceHomes.codex)
      : undefined;
  };

  return {
    dataDir: state.options.dataDir,
    locate: {
      claudeHomes: async (session) => {
        const bound = await journal((j) => j.claudeSessionHome(session.threadId));

        const imported = await journal((j) => j.claudeImportedSessionHome(session.profileId, session.providerThreadId));

        return unique([bound, imported, state.claudeHome(session.profileId)]);
      },
      codexHomes: async (session) => {
        const remembered = await journal((j) => j.codexCliHome(session.providerThreadId));
        let direct: string | undefined;

        try {
          direct = cliHome(session);
        } catch {
          direct = undefined;
        }

        return unique([remembered, direct, state.codexHome(session.profileId)]);
      },
      secretHistory: (session) => journal((j) => j.hasProjectSecretHistory(session.threadId, session.providerThreadId)),
    },
    bindCliHome: (sessionId, home) => journal((j) => j.rememberCodexCliHome(sessionId, home)),
    unbindCliHome: (sessionId, home) => journal((j) => j.forgetCodexCliHome(sessionId, home)),
    codexHistory: {
      has: (threadId, sessionId) => journal((j) => j.hasCodexSessionHistory(threadId, sessionId)),
      set: (threadId, sessionId, present) => journal((j) => j.setCodexSessionHistory(threadId, sessionId, present)),
    },
    adoptionHome: async (session) => {
      if (session.provider === "claude") {
        profileOf(session, "claude");
        const bound = await journal((j) => j.claudeSessionHome(session.threadId));

        const home =
          bound ??
          (await journal((j) =>
            Effect.sync(() =>
              durableImportHomes(j, state, true).claudeHome(session.profileId, session.providerThreadId),
            ),
          ));

        // Bound in the journal: Canopy ran this thread's session in that home.
        return {
          home,
          manifest: state.imports.copyManifest("claude", session.profileId, session.providerThreadId),
          owned: bound === home,
        };
      }

      if (session.provider === "codex") {
        const shared = cliHome(session);
        // A binding to a shared CLI home decides where resume looks: any other destination is refused before apply.
        const remembered = await journal((j) => j.codexCliHome(session.providerThreadId));

        // Canopy's private CODEX_HOME: only Canopy writes rollouts there.
        if (!shared) {
          if (remembered) throw transferError("This session already belongs to another Codex home on this worker.");

          return {
            home: state.codexHome(session.profileId),
            manifest: state.imports.copyManifest("codex", session.profileId, session.providerThreadId),
            owned: true,
          };
        }

        // A shared CLI home keeps Canopy's rollouts with the CLI's own; resume finds the moved one there.
        mkdirSync(shared, { recursive: true, mode: 0o700 });
        const home = realpathSync(shared);

        // Remembered before: Canopy ran this session in the CLI's home; otherwise a rollout there is the CLI's.
        if (remembered && remembered !== home)
          throw transferError("This session already belongs to another Codex home on this worker.");
        const owned = remembered === home;

        return {
          home,
          manifest: join(
            state.options.dataDir,
            "thread-transfers",
            "copies",
            `codex-${session.profileId || "native"}-${session.providerThreadId}.json`,
          ),
          owned,
          binding: home,
        };
      }

      throw transferError("This harness can't continue a thread in another folder.");
    },
  };
}

const unique = (homes: (string | undefined)[]) => [...new Set(homes.filter((h): h is string => Boolean(h)))];

/** Workspace copies and thread transfers move file bytes outside the provider runtimes; every other command runs there. */
export async function fileTransferOutput(
  copies: WorkspaceCopies,
  transfers: ThreadTransfers,
  ctx: HostContext,
  command: Command,
  link: Parameters<HostContext["ops"]["execute"]>[1],
): Promise<CommandOutput> {
  if (command.kind.case === "workspaceCopy") {
    const action = command.kind.value.action;

    if (action.case === "scan") ctx.ops.checkCwd(action.value.rootPath);

    return { workspaceCopy: await copies.execute(command.kind.value) };
  }

  if (command.kind.case === "threadTransfer") {
    const path = transferPath(command.kind.value);

    if (path !== undefined) ctx.ops.checkCwd(path);

    return { threadTransfer: await transfers.execute(command.kind.value) };
  }

  return ctx.ops.execute(command, link);
}

/** The directory a transfer operation reads or writes: it must be one this worker allows. */
function transferPath(operation: ThreadTransferOperation): string | undefined {
  const action = operation.action;

  switch (action.case) {
    case "inspect":
    case "export":
    case "apply":
    case "verify":
      return action.value.cwd;
    case "tips":
    case "stage":
      return action.value.repoPath;
    default:
      return undefined;
  }
}
